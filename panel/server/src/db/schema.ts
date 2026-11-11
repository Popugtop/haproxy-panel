import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  uniqueIndex,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ───────── администраторы и сессии ─────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  /** TOTP-секрет зашифрован ключом APP_SECRET (AES-256-GCM). */
  totpSecretEnc: text('totp_secret_enc'),
  totpPendingEnc: text('totp_pending_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  /** Номер 30-секундного шага последнего принятого кода — защита от повторного использования. */
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 от значения cookie; сам токен в БД не хранится. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mfaOk: boolean('mfa_ok').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ───────── ноды ─────────

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ip: text('ip'),
  /** Домен моста — только для отображения. */
  domain: text('domain'),
  hoster: text('hoster'),
  notes: text('notes'),
  /** Нода создана демо-режимом (DEMO=1). При запуске без DEMO такие ноды удаляются. */
  isDemo: boolean('is_demo').notNull().default(false),
  /** Квота трафика хостера, ТБ (десятичные). null — не задана. */
  quotaTb: numeric('quota_tb', { precision: 10, scale: 2 }),
  /** День месяца, с которого начинается биллинговый период (1–31). */
  billingDay: smallint('billing_day').notNull().default(1),
  /** Что хостер считает в квоту: 'tx' или 'txrx'. */
  quotaCounts: text('quota_counts').notNull().default('tx'),
  /** Лимит скорости на клиентский IP по умолчанию, Мбит/с. null — без лимита. */
  defaultIpLimitMbit: integer('default_ip_limit_mbit'),
  createdAt: ts('created_at').notNull().defaultNow(),

  // агент
  /** Применённая сейчас версия конфига (config_versions.id). null — панель конфиг ещё не применяла. */
  appliedVersionId: uuid('applied_version_id'),
  /** Маршрут, на который идёт SNI, которого нет в карте. null — reject. */
  defaultRouteId: uuid('default_route_id'),
  /** Свои директивы: дописываются в конец конфига как есть. */
  extraConfig: text('extra_config'),
  /** SHA-256 haproxy.cfg на ноде по данным агента (hello и ответы apply/get_config). */
  configSha256: text('config_sha256'),
  /** Ручной конфиг ноды уже разобран (импорт подтверждён или отклонён): предложение больше не показываем. */
  importDone: boolean('import_done').notNull().default(false),

  keyHash: text('key_hash').unique(),
  keyCreatedAt: ts('key_created_at'),
  keyRevokedAt: ts('key_revoked_at'),
  enrollTokenHash: text('enroll_token_hash').unique(),
  enrollExpiresAt: ts('enroll_expires_at'),
  agentVersion: text('agent_version'),
  protocol: integer('protocol'),
  haproxyVersion: text('haproxy_version'),
  haproxyInstalled: boolean('haproxy_installed'),
  hostname: text('hostname'),
  os: text('os'),
  arch: text('arch'),
  /** На ноде закреплён ключ подписи, обновление по кнопке возможно. */
  updateReady: boolean('update_ready').notNull().default(false),
  ops: jsonb('ops').$type<string[]>(),
  addrs: jsonb('addrs').$type<string[]>(),
  lastRemoteIp: text('last_remote_ip'),
  lastSeenAt: ts('last_seen_at'),
  lastConnectedAt: ts('last_connected_at'),
  lastDisconnectedAt: ts('last_disconnected_at'),
});

/** Последний снимок ноды + накопительные счётчики для расчёта дельт (переживает рестарт панели). */
export const nodeLive = pgTable('node_live', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  ts: ts('ts').notNull(),
  data: jsonb('data').$type<LiveData>().notNull(),
  counters: jsonb('counters').$type<Counters>().notNull(),
});

export interface Counters {
  ts: number;
  rx: number;
  tx: number;
  backends: Record<string, { bin: number; bout: number }>;
}

export interface LiveBackend {
  name: string;
  status: string;
  scur: number;
  stot: number;
  inBps: number;
  outBps: number;
  servers: { name: string; status: string; check: string | null; checkMs: number | null }[];
}

export interface LiveData {
  ts: number;
  sys: {
    cpuPct: number | null;
    load1: number;
    load5: number;
    load15: number;
    memTotal: number;
    memAvail: number;
    uptimeSec: number;
    rxBps: number;
    txBps: number;
    ifaces: { name: string; rx: number; tx: number }[];
  };
  haproxy: { ok: boolean; error: string | null; version: string | null; uptimeSec: number | null };
  backends: LiveBackend[];
  sessions: number;
  clients: {
    tracked: number;
    active: number;
    flowing?: number;
    top: {
      ip: string;
      connCur: number;
      connCnt: number;
      bytesIn: number;
      bytesOut: number;
      rateIn: number;
      rateOut: number;
    }[];
  } | null;
  clientsError: string | null;
}

// ───────── временные ряды ─────────
// res — размер корзины в секундах: 15 (сырые), 60, 3600. Байты в корзине — сумма дельт.

export const nodeMetrics = pgTable(
  'node_metrics',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    res: smallint('res').notNull(),
    ts: ts('ts').notNull(),
    /** Сколько секунд покрывают суммы байт (для расчёта скорости при пропусках). */
    dt: real('dt').notNull(),
    n: integer('n').notNull().default(1),
    rxBytes: bigint('rx_bytes', { mode: 'number' }).notNull(),
    txBytes: bigint('tx_bytes', { mode: 'number' }).notNull(),
    cpuAvg: real('cpu_avg'),
    cpuMax: real('cpu_max'),
    memTotal: bigint('mem_total', { mode: 'number' }),
    memAvailAvg: doublePrecision('mem_avail_avg'),
    load1Avg: real('load1_avg'),
    sessionsAvg: real('sessions_avg').notNull().default(0),
    sessionsMax: integer('sessions_max').notNull().default(0),
    clientsAvg: real('clients_avg'),
    clientsMax: integer('clients_max'),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.res, t.ts] })],
);

export const backendMetrics = pgTable(
  'backend_metrics',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    backend: text('backend').notNull(),
    res: smallint('res').notNull(),
    ts: ts('ts').notNull(),
    dt: real('dt').notNull(),
    n: integer('n').notNull().default(1),
    binBytes: bigint('bin_bytes', { mode: 'number' }).notNull(),
    boutBytes: bigint('bout_bytes', { mode: 'number' }).notNull(),
    scurAvg: real('scur_avg').notNull().default(0),
    scurMax: integer('scur_max').notNull().default(0),
    /** Минимум живых серверов в корзине / всего серверов. */
    serversUpMin: smallint('servers_up_min').notNull().default(0),
    serversTotal: smallint('servers_total').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.backend, t.res, t.ts] })],
);

/** Суточный трафик (UTC) — для биллинговых периодов и квоты. */
export const nodeDaily = pgTable(
  'node_daily',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    rxBytes: bigint('rx_bytes', { mode: 'number' }).notNull().default(0),
    txBytes: bigint('tx_bytes', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.day] })],
);

export const backendDaily = pgTable(
  'backend_daily',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    backend: text('backend').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    binBytes: bigint('bin_bytes', { mode: 'number' }).notNull().default(0),
    boutBytes: bigint('bout_bytes', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.backend, t.day] })],
);

// ───────── аудит ─────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: ts('at').notNull().defaultNow(),
    actorId: uuid('actor_id'),
    /** Логин на момент действия (пользователя могут удалить). */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** До/после или параметры. Секретов здесь быть не должно. */
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    ip: text('ip'),
  },
  (t) => [index('audit_at_idx').on(t.at)],
);

// ───────── маршруты ─────────

/** Зарубежная нода, на которую мост прокидывает соединение. */
export const exits = pgTable(
  'exits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Код страны ISO 3166-1 alpha-2 для флага, например DE. */
    country: text('country'),
    host: text('host').notNull(),
    port: integer('port').notNull().default(443),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('exits_addr_uq').on(t.host, t.port)],
);

export const routes = pgTable('routes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Отображаемое имя, например «Германия (🇷🇺 → 🇩🇪)». */
  name: text('name').notNull(),
  /** Идентификатор для HAProxy (backend be_<slug>); латиница, цифры, подчёркивание. Общий для всех нод маршрута. */
  slug: text('slug').notNull().unique(),
  snis: text('snis').array().notNull().default(sql`'{}'::text[]`),
  proxyProtocol: boolean('proxy_protocol').notNull().default(false),
  healthCheck: boolean('health_check').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  /** Общий потолок скорости всех клиентов маршрута на одной ноде, Мбит/с (bwlim, HAProxy ≥ 2.7). null — без потолка. */
  limitMbit: integer('limit_mbit'),
  /** Лимит на каждый IP внутри маршрута вместо лимита ноды по умолчанию, Мбит/с. null — действует лимит ноды. */
  ipLimitMbit: integer('ip_limit_mbit'),
  isDemo: boolean('is_demo').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const routeExits = pgTable(
  'route_exits',
  {
    routeId: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    exitId: uuid('exit_id').notNull().references(() => exits.id, { onDelete: 'restrict' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.routeId, t.exitId] })],
);

/** Маршрут раскатывается на любое число нод с одинаковым конфигом. */
export const routeNodes = pgTable(
  'route_nodes',
  {
    routeId: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.routeId, t.nodeId] }), index('route_nodes_node_idx').on(t.nodeId)],
);

export const configVersions = pgTable(
  'config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    cfg: text('cfg').notNull(),
    sniMap: text('sni_map').notNull().default(''),
    sha256: text('sha256').notNull(),
    /** panel — сгенерирован панелью; import — снимок ручного конфига, найденного на ноде. */
    source: text('source').notNull().default('panel'),
    /** applying | applied | failed | rolled_back | rollback_failed | imported */
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    finishedAt: ts('finished_at'),
    output: text('output'),
    durationMs: real('duration_ms'),
  },
  (t) => [uniqueIndex('config_versions_node_number_uq').on(t.nodeId, t.number)],
);

export const checkResults = pgTable(
  'check_results',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    /** Выход, до которого шла проверка агента. null у сквозной проверки панели. */
    exitId: uuid('exit_id'),
    /** agent — мост → выход; panel — панель → мост:443 с SNI маршрута (мост жив и доходит до выхода). */
    source: text('source').notNull(),
    ts: ts('ts').notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    ms: real('ms'),
    error: text('error'),
  },
  (t) => [index('check_results_route_idx').on(t.routeId, t.nodeId, t.ts), index('check_results_ts_idx').on(t.ts)],
);

// ───────── клиенты: баны и персональные лимиты ─────────

/** Баны по IP: по строке на ноду. Агент держит их в nft-таблице с таймаутом, панель — источник правды. */
export const bans = pgTable(
  'bans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ip: text('ip').notNull(),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    /** manual — поставил админ; torrent — от торрент-блокера (этап 3). */
    reason: text('reason').notNull().default('manual'),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('bans_ip_node_uq').on(t.ip, t.nodeId), index('bans_node_idx').on(t.nodeId, t.expiresAt)],
);

/** Персональный лимит скорости клиента: попадает в конфиг HAProxy (bwlim, нужен HAProxy ≥ 2.7) и применяется как обычная версия конфига. */
export const ipLimits = pgTable(
  'ip_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ip: text('ip').notNull(),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    mbit: integer('mbit').notNull(),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ip_limits_ip_node_uq').on(t.ip, t.nodeId)],
);

/** Настройки панели «ключ → JSON» (персонализация и далее Telegram/Remnawave). Секреты в открытом виде не храним. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ───────── торрент-блокер ─────────

/** Что панель решила по каждому отчёту Remnawave: забанила, только отметила (режим наблюдения) или пропустила и почему. */
export const torrentEvents = pgTable(
  'torrent_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: ts('at').notNull().defaultNow(),
    /** ID отчёта в Remnawave. После очистки отчётов там нумерация может начаться заново, поэтому не уникален. */
    reportId: bigint('report_id', { mode: 'number' }).notNull(),
    username: text('username').notNull().default(''),
    remnaNode: text('remna_node').notNull().default(''),
    ip: text('ip').notNull(),
    /** ban | observe | skip | already_banned | error */
    action: text('action').notNull(),
    reason: text('reason'),
    durationSec: integer('duration_sec'),
    nodesCount: integer('nodes_count').notNull().default(0),
    isDemo: boolean('is_demo').notNull().default(false),
  },
  (t) => [index('torrent_events_at_idx').on(t.at), index('torrent_events_ip_idx').on(t.ip)],
);

// ───────── алерты ─────────

/** Настройки правил: по одному на вид события. Строки создаются при запуске панели со значениями по умолчанию. */
export const alertRules = pgTable('alert_rules', {
  kind: text('kind').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  /** Порог (проценты, Мбит/с…) — смысл зависит от вида правила. */
  threshold: real('threshold'),
  /** Второй, более серьёзный порог (у квоты: 80% — предупреждение, 95% — авария). */
  threshold2: real('threshold2'),
  /** Сколько минут условие должно держаться, прежде чем сработает алерт. */
  forMin: integer('for_min').notNull().default(0),
  /** Повторять напоминание, пока проблема не решена, раз в N часов. 0 — не повторять. */
  repeatHours: integer('repeat_hours').notNull().default(6),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Инцидент: от появления условия до его исчезновения. На один (вид, объект) одновременно открыт не больше одного. */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** Ключ объекта: id ноды, «маршрут:нода», IP. */
    subject: text('subject').notNull(),
    subjectLabel: text('subject_label').notNull(),
    /** pending — условие есть, но ещё не продержалось нужное время; firing — алерт сработал; resolved — условие исчезло. */
    status: text('status').notNull().default('pending'),
    severity: text('severity').notNull().default('warn'),
    message: text('message').notNull().default(''),
    value: real('value'),
    pendingSince: ts('pending_since').notNull().defaultNow(),
    firedAt: ts('fired_at'),
    resolvedAt: ts('resolved_at'),
    lastNotifiedAt: ts('last_notified_at'),
    notifyCount: integer('notify_count').notNull().default(0),
    lastNotifyError: text('last_notify_error'),
    isDemo: boolean('is_demo').notNull().default(false),
  },
  (t) => [
    uniqueIndex('alerts_open_uq').on(t.kind, t.subject).where(sql`${t.status} <> 'resolved'`),
    index('alerts_status_idx').on(t.status, t.firedAt),
  ],
);
