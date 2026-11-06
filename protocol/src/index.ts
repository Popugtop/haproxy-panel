/**
 * Протокол агент ↔ панель. ЕДИНСТВЕННЫЙ источник правды.
 *
 * Транспорт: WebSocket (wss), текстовые JSON-кадры, соединение инициирует агент.
 * Авторизация: заголовок `Authorization: Bearer <node key>` при апгрейде.
 * Описание и правила совместимости: protocol/PROTOCOL.md.
 * Go-типы агента (agent/internal/proto) повторяют эти схемы; соответствие
 * проверяется общими фикстурами protocol/fixtures/*.json в тестах обеих сторон.
 */
import { z } from 'zod';

/** Версия протокола, которую говорит эта сборка. Растёт только при несовместимых изменениях. */
export const PROTOCOL_VERSION = 1;
/** Минимальная версия агента, которую панель ещё принимает. */
export const MIN_PROTOCOL_VERSION = 1;

/** Коды закрытия WebSocket (4000–4999 — прикладные). */
export const CloseCode = {
  ProtocolMismatch: 4000,
  Unauthorized: 4001,
  KeyRevoked: 4003,
  Superseded: 4004,
  BadFrame: 4005,
} as const;

/** Фиксированный набор операций, которые панель может попросить агента выполнить. */
export const OPS = ['ping', 'get_config', 'apply_config', 'run_checks', 'apply_bans', 'get_clients', 'update_agent'] as const;
export type Op = (typeof OPS)[number];

const int = z.number().int();
const bytes = z.number().int().nonnegative();
const nonneg = z.number().nonnegative();

// ───────── агент → панель ─────────

export const HelloSchema = z.object({
  t: z.literal('hello'),
  protocol: int,
  agentVersion: z.string().max(64),
  hostname: z.string().max(255),
  os: z.string().max(128),
  arch: z.string().max(32),
  haproxy: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    version: z.string().max(64).nullable(),
  }),
  /** Какие операции агент умеет. Панель не шлёт то, чего нет в списке. */
  ops: z.array(z.string().max(64)).max(32),
  /** Публичные IP-адреса интерфейсов (без loopback/private), для подсказки в панели. */
  addrs: z.array(z.string().max(64)).max(16).default([]),
  /** SHA-256 текущего haproxy.cfg на ноде (null, если файла нет): панель замечает правки вне панели. */
  configSha256: z.string().length(64).nullable().default(null),
  /** На ноде закреплён ключ подписи: обновление по кнопке из панели возможно. */
  updateReady: z.boolean().default(false),
});
export type Hello = z.infer<typeof HelloSchema>;

export const ServerStatSchema = z.object({
  name: z.string().max(128),
  /** UP / DOWN / NOLB / MAINT / "no check" — как отдаёт HAProxy. */
  status: z.string().max(32),
  /** Результат последней проверки (L4OK, L4TOUT, …) либо null. */
  check: z.string().max(32).nullable(),
  /** Время последней проверки, мс. */
  checkMs: nonneg.nullable(),
});

export const BackendStatSchema = z.object({
  name: z.string().max(128),
  status: z.string().max(32),
  /** Накопительные счётчики с момента старта процесса HAProxy. */
  bin: bytes,
  bout: bytes,
  stot: bytes,
  scur: bytes,
  servers: z.array(ServerStatSchema).max(256),
});
export type BackendStat = z.infer<typeof BackendStatSchema>;

export const FrontendStatSchema = z.object({
  name: z.string().max(128),
  scur: bytes,
  bin: bytes,
  bout: bytes,
  stot: bytes,
});

export const ClientRowSchema = z.object({
  ip: z.string().max(64),
  connCur: bytes,
  connCnt: bytes,
  /** От клиента к HAProxy (аплоад клиента), накопительно, байт. */
  bytesIn: bytes,
  /** От HAProxy к клиенту (скачивание клиента), накопительно, байт. */
  bytesOut: bytes,
  /** Средняя скорость за окно таблицы (1 мин), байт/с. */
  rateIn: nonneg,
  rateOut: nonneg,
});
export type ClientRow = z.infer<typeof ClientRowSchema>;

export const MetricsSchema = z.object({
  t: z.literal('metrics'),
  /** Время снятия на агенте, мс unix. */
  ts: int,
  seq: int.nonnegative(),
  sys: z.object({
    cpuPct: z.number().min(0).max(100).nullable(),
    load1: nonneg,
    load5: nonneg,
    load15: nonneg,
    memTotal: bytes,
    memAvail: bytes,
    uptimeSec: bytes,
    net: z.object({
      /** Сумма по физическим интерфейсам, накопительно, байт. */
      rxBytes: bytes,
      txBytes: bytes,
      ifaces: z.array(z.object({ name: z.string().max(32), rx: bytes, tx: bytes })).max(32),
    }),
  }),
  haproxy: z.object({
    ok: z.boolean(),
    error: z.string().max(512).nullable(),
    version: z.string().max(64).nullable(),
    uptimeSec: bytes.nullable(),
    backends: z.array(BackendStatSchema).max(512),
    frontends: z.array(FrontendStatSchema).max(64),
  }),
  /** null — таблица st_clients недоступна (причина в clientsError). */
  clients: z
    .object({
      tracked: bytes,
      active: bytes,
      top: z.array(ClientRowSchema).max(200),
    })
    .nullable(),
  clientsError: z.string().max(512).nullable(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const ResultSchema = z.object({
  t: z.literal('result'),
  id: z.string().max(64),
  ok: z.boolean(),
  error: z.string().max(2000).nullable().default(null),
  data: z.unknown().optional(),
});
export type Result = z.infer<typeof ResultSchema>;

/** Результат одной проверки «агент → выход»: TCP-коннект и TLS ClientHello с SNI маршрута. */
export const CheckResultSchema = z.object({
  routeId: z.string().max(64),
  exitId: z.string().max(64),
  ok: z.boolean(),
  /** Полное время рукопожатия, мс. null при ошибке до его завершения. */
  ms: nonneg.nullable(),
  error: z.string().max(300).nullable(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ChecksSchema = z.object({
  t: z.literal('checks'),
  ts: int,
  results: z.array(CheckResultSchema).max(1000),
});
export type Checks = z.infer<typeof ChecksSchema>;

export const AgentMessageSchema = z.discriminatedUnion('t', [HelloSchema, MetricsSchema, ResultSchema, ChecksSchema]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ───────── панель → агент ─────────

export const WelcomeSchema = z.object({
  t: z.literal('welcome'),
  protocol: int,
  serverTime: int,
  nodeId: z.string().max(64),
  metricsIntervalSec: int.min(5).max(120),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

/** Файлы, которые агент кладёт на ноду при apply_config. Пути фиксированы на стороне агента, в команде их нет. */
export const ApplyArgsSchema = z.object({
  /** Номер ConfigVersion в панели: эхом возвращается в ответе. */
  version: int.nonnegative(),
  cfg: z.string().max(1_000_000),
  sniMap: z.string().max(1_000_000),
  /** true — только проверить конфиг (haproxy -c), ничего не менять. */
  validateOnly: z.boolean().default(false),
});
export type ApplyArgs = z.infer<typeof ApplyArgsSchema>;

// ───────── баны (nftables) ─────────

/** Баны: агент держит nft-таблицу с таймаутами. full — заменить набор целиком, иначе применить разницу. */
export const BansArgsSchema = z.object({
  full: z.boolean(),
  ban: z.array(z.object({ ip: z.string().max(45), ttlSec: int.min(1).max(366 * 86400) })).max(20000),
  unban: z.array(z.string().max(45)).max(20000),
});
export type BansArgs = z.infer<typeof BansArgsSchema>;
export const BansResultSchema = z.object({ active: int.nonnegative(), rejected: z.array(z.object({ ip: z.string(), reason: z.string() })).default([]) });
export type BansResult = z.infer<typeof BansResultSchema>;

/** Живая таблица клиентов (get_clients): то же, что в metrics.clients, но глубже и по запросу. */
export const ClientsDataSchema = z.object({
  tracked: bytes,
  active: bytes,
  top: z.array(ClientRowSchema).max(1000),
});
export type ClientsData = z.infer<typeof ClientsDataSchema>;

// ───────── обновление агента ─────────

/**
 * Агент скачивает бинарник САМ с адреса панели из своего локального конфига, сверяет SHA-256 из команды
 * и подпись ed25519 ключом, закреплённым при установке. Подменить бинарник через панель нельзя: приватный ключ релизов у вас.
 */
export const UpdateArgsSchema = z.object({ version: z.string().max(64), sha256: z.string().length(64) });
export type UpdateArgs = z.infer<typeof UpdateArgsSchema>;
export const UpdateResultSchema = z.object({ from: z.string(), to: z.string(), restarting: z.boolean() });

/** Что проверять агенту по расписанию. Панель шлёт при подключении и при каждом изменении маршрутов. */
export const ChecksConfigSchema = z.object({
  t: z.literal('checks_config'),
  intervalSec: int.min(10).max(600),
  targets: z
    .array(
      z.object({
        routeId: z.string().max(64),
        exitId: z.string().max(64),
        host: z.string().max(255),
        port: int.min(1).max(65535),
        sni: z.string().max(255),
        /** Выход ждёт PROXY protocol v2: агент шлёт заголовок LOCAL перед ClientHello. */
        proxy: z.boolean(),
      }),
    )
    .max(500),
});
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;


export const CmdSchema = z.discriminatedUnion('op', [
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('ping') }),
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('get_config') }),
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('apply_config'), args: ApplyArgsSchema }),
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('run_checks') }),
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('apply_bans'), args: BansArgsSchema }),
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('get_clients') }),
  z.object({ t: z.literal('cmd'), id: z.string().max(64), op: z.literal('update_agent'), args: UpdateArgsSchema }),
]);
export type Cmd = z.infer<typeof CmdSchema>;
export const PanelMessageSchema = z.union([WelcomeSchema, CmdSchema, ChecksConfigSchema]);
export type PanelMessage = z.infer<typeof PanelMessageSchema>;

/** Ответ на get_config. */
export const ConfigDataSchema = z.object({
  path: z.string(),
  content: z.string().max(2_000_000),
  sha256: z.string().length(64),
});
export type ConfigData = z.infer<typeof ConfigDataSchema>;

/** Данные ответа на apply_config (в Result.data; при ошибке тоже, чтобы показать вывод HAProxy). */
export const ApplyResultSchema = z.object({
  version: int.nonnegative(),
  /** Конфиг применён и HAProxy поднялся на нём. */
  applied: z.boolean(),
  /** Не получилось и прежний конфиг возвращён. */
  rolledBack: z.boolean(),
  /** Откат тоже не удался: нода в неизвестном состоянии, нужно вмешательство. */
  rollbackFailed: z.boolean().default(false),
  /** SHA-256 конфига, который сейчас лежит на ноде. */
  sha256: z.string().length(64).nullable(),
  /** Вывод haproxy -c / systemctl (обрезан). */
  output: z.string().max(8000),
  durationMs: z.number().nonnegative(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

/** Данные ответа на run_checks. */
export const RunChecksDataSchema = z.object({ results: z.array(CheckResultSchema).max(1000) });

// ───────── HTTP: регистрация агента ─────────

export const EnrollRequestSchema = z.object({
  token: z.string().min(16).max(256),
  protocol: int,
  agentVersion: z.string().max(64),
  hostname: z.string().max(255),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.object({
  nodeId: z.string(),
  /** Постоянный ключ ноды. Показывается один раз, в панели хранится только хэш. */
  key: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;
