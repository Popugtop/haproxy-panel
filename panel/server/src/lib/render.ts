/**
 * Рендер полного haproxy.cfg ноды из маршрутов. Чистая функция: один вход — один выход,
 * без времени и случайности, поэтому результат можно сравнивать с golden-файлами и сравнивать с тем, что на ноде.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const SNI_MAP_PATH = '/etc/haproxy/maps/sni.map';

export interface RenderExit {
  host: string;
  port: number;
}

export interface RenderRoute {
  slug: string;
  name: string;
  snis: string[];
  proxyProtocol: boolean;
  healthCheck: boolean;
  enabled: boolean;
  exits: RenderExit[];
  /** Общий потолок скорости маршрута, Мбит/с (только при bwlim). */
  limitMbit?: number | null;
  /** Лимит на каждый IP внутри маршрута вместо лимита ноды по умолчанию, Мбит/с (только при bwlim). */
  ipLimitMbit?: number | null;
}

export interface RenderBwlim {
  /** Лимит на каждый IP по умолчанию, Мбит/с; null — без общего лимита. */
  defaultMbit: number | null;
  /** Персональные лимиты. */
  limits: { ip: string; mbit: number }[];
}

/** Больше персональных лимитов на ноду не рендерим: IP перечисляются прямо в конфиге. */
export const MAX_IP_LIMITS = 300;
/** Мбит/с → байт/с (десятичные, как у хостеров). */
export const mbitToBytes = (mbit: number): number => Math.round((mbit * 1_000_000) / 8);

export interface RenderInput {
  routes: RenderRoute[];
  /** Лимиты скорости на IP. null/undefined или пустой набор — секции bwlim в конфиге нет (и для HAProxy < 2.7). */
  bwlim?: RenderBwlim | null;
  /** slug маршрута для неизвестного SNI; null или отсутствует среди включённых — reject. */
  defaultSlug?: string | null;
  /** Свои директивы: дописываются в конец конфига как есть. */
  extraConfig?: string | null;
}

export interface Rendered {
  cfg: string;
  sniMap: string;
  sha256: string;
}

export const SLUG_RE = /^[a-z0-9_]{1,24}$/;
export const SNI_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HOST_RE = SNI_RE;

export const isValidHost = (h: string): boolean => isIP(h) !== 0 || HOST_RE.test(h.toLowerCase());
export const backendName = (slug: string): string => `be_${slug}`;
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Комментарий в одну строку: переводы строк в названии не должны ломать конфиг. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

const GLOBAL = `global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats socket /run/haproxy/admin.sock mode 660 level admin
    stats timeout 30s
    user haproxy
    group haproxy
    daemon
`;

const DEFAULTS = `defaults
    log global
    mode tcp
    option tcplog
    option dontlognull
    timeout connect 5s
    timeout client 1h
    timeout server 1h
`;

export function renderConfig(input: RenderInput): Rendered {
  const routes = input.routes.filter((r) => r.enabled && r.exits.length > 0).sort((a, b) => a.slug.localeCompare(b.slug));

  const seen = new Map<string, string>();
  const mapLines: string[] = [];
  for (const r of routes) {
    if (!SLUG_RE.test(r.slug)) throw new Error(`некорректный идентификатор маршрута «${r.slug}»`);
    for (const raw of r.snis) {
      const sni = raw.trim().toLowerCase();
      if (!SNI_RE.test(sni)) throw new Error(`некорректный SNI «${raw}» в маршруте ${r.slug}`);
      const other = seen.get(sni);
      if (other && other !== r.slug) throw new Error(`SNI ${sni} указан сразу в маршрутах ${other} и ${r.slug}`);
      if (!other) {
        seen.set(sni, r.slug);
        mapLines.push(`${sni} ${backendName(r.slug)}`);
      }
    }
  }
  mapLines.sort();
  const sniMap = mapLines.length ? mapLines.join('\n') + '\n' : '';

  const bwOn = !!input.bwlim;
  const bw = input.bwlim && (input.bwlim.defaultMbit || input.bwlim.limits.length > 0) ? input.bwlim : null;
  if (bw && bw.limits.length > MAX_IP_LIMITS) throw new Error(`персональных лимитов не больше ${MAX_IP_LIMITS} на ноду`);
  const checkMbit = (mbit: number, what: string) => {
    if (!Number.isInteger(mbit) || mbit < 1 || mbit > 100_000) throw new Error(`некорректный лимит ${mbit} (${what})`);
  };
  // Лимиты группируются по значению: на каждый уровень — своя пара фильтров, IP перечисляются в условии.
  const tiers = new Map<number, string[]>();
  for (const l of bw?.limits ?? []) {
    if (isIP(l.ip) === 0) throw new Error(`некорректный IP лимита «${l.ip}»`);
    checkMbit(l.mbit, l.ip);
    tiers.set(l.mbit, [...(tiers.get(l.mbit) ?? []), l.ip]);
  }
  const personalIps = [...tiers.values()].flat().sort();
  // Лимиты маршрутов. SNI-условие берётся из той же карты, по которой выбирается бэкенд.
  const sniBackend = `req.ssl_sni,lower,map(${SNI_MAP_PATH})`;
  const byBackends = (be: string[]) => `{ ${sniBackend} -m str ${be.join(' ')} }`;
  const routeIpTiers = new Map<number, string[]>();
  const routeCaps: { slug: string; mbit: number }[] = [];
  if (bwOn) {
    for (const r of routes) {
      if (r.ipLimitMbit) {
        checkMbit(r.ipLimitMbit, `маршрут ${r.slug}`);
        routeIpTiers.set(r.ipLimitMbit, [...(routeIpTiers.get(r.ipLimitMbit) ?? []), backendName(r.slug)]);
      }
      if (r.limitMbit) {
        checkMbit(r.limitMbit, `маршрут ${r.slug}`);
        routeCaps.push({ slug: r.slug, mbit: r.limitMbit });
      }
    }
  }
  const perIp = !!bw || routeIpTiers.size > 0;
  const bwLines: string[] = [];
  const f = (dir: 'out' | 'in', name: string, mbit: number) => `    filter bwlim-${dir} ${name} limit ${mbitToBytes(mbit)} key src table st_bwlim`;
  if (perIp) {
    const defaultMbit = bw?.defaultMbit ?? null;
    const overridden = [...routeIpTiers.values()].flat().sort();
    if (defaultMbit) bwLines.push(f('out', 'dl_default', defaultMbit), f('in', 'ul_default', defaultMbit));
    for (const mbit of [...tiers.keys()].sort((a, b) => a - b)) bwLines.push(f('out', `dl_${mbit}m`, mbit), f('in', `ul_${mbit}m`, mbit));
    for (const mbit of [...routeIpTiers.keys()].sort((a, b) => a - b)) bwLines.push(f('out', `dl_r${mbit}m`, mbit), f('in', `ul_r${mbit}m`, mbit));
    for (const mbit of [...tiers.keys()].sort((a, b) => a - b)) {
      const cond = `if { src ${tiers.get(mbit)!.sort().join(' ')} }`;
      bwLines.push(`    tcp-request content set-bandwidth-limit dl_${mbit}m ${cond}`, `    tcp-request content set-bandwidth-limit ul_${mbit}m ${cond}`);
    }
    // Персональный лимит сильнее лимита маршрута, а тот сильнее лимита ноды по умолчанию.
    const notPersonal = personalIps.length ? ` !{ src ${personalIps.join(' ')} }` : '';
    for (const mbit of [...routeIpTiers.keys()].sort((a, b) => a - b)) {
      const cond = `if ${byBackends(routeIpTiers.get(mbit)!.sort())}${notPersonal}`;
      bwLines.push(`    tcp-request content set-bandwidth-limit dl_r${mbit}m ${cond}`, `    tcp-request content set-bandwidth-limit ul_r${mbit}m ${cond}`);
    }
    if (defaultMbit) {
      const cond = overridden.length ? ` if !${byBackends(overridden)}${notPersonal}` : personalIps.length ? ` unless { src ${personalIps.join(' ')} }` : '';
      bwLines.push(`    tcp-request content set-bandwidth-limit dl_default${cond}`, `    tcp-request content set-bandwidth-limit ul_default${cond}`);
    }
  }
  // Общий потолок маршрута: ключ — имя бэкенда, поэтому лимит делят все клиенты маршрута.
  for (const c of routeCaps) {
    bwLines.push(
      `    filter bwlim-out route_dl_${c.slug} limit ${mbitToBytes(c.mbit)} key str(${backendName(c.slug)}) table st_route_bw`,
      `    filter bwlim-in route_ul_${c.slug} limit ${mbitToBytes(c.mbit)} key str(${backendName(c.slug)}) table st_route_bw`,
    );
  }
  for (const c of routeCaps) {
    const cond = `if ${byBackends([backendName(c.slug)])}`;
    bwLines.push(`    tcp-request content set-bandwidth-limit route_dl_${c.slug} ${cond}`, `    tcp-request content set-bandwidth-limit route_ul_${c.slug} ${cond}`);
  }

  const def = input.defaultSlug && routes.some((r) => r.slug === input.defaultSlug) ? backendName(input.defaultSlug) : 'be_reject';

  const out: string[] = [
    '# Сгенерировано popug-bridges. Правки руками будут перезаписаны при следующем применении:',
    '# маршруты меняются в панели, свои директивы — в настройках ноды.',
    '',
    GLOBAL,
    DEFAULTS,
    '# Статистика клиентов по IP (панель читает её через stats-сокет).',
    'backend st_clients',
    '    stick-table type ipv6 size 200k expire 24h store conn_cur,conn_cnt,bytes_in_cnt,bytes_out_cnt,bytes_in_rate(1m),bytes_out_rate(1m)',
    '',
    ...(perIp
      ? [
          '# Лимиты скорости на клиентский IP (bwlim, HAProxy 2.7+). За одним IP бывает много людей (CGNAT у мобильных): лимит они делят.',
          'backend st_bwlim',
          '    stick-table type ipv6 size 200k expire 10m store bytes_in_rate(1s),bytes_out_rate(1s)',
          '',
        ]
      : []),
    ...(routeCaps.length
      ? [
          '# Общий потолок скорости маршрута: ключ — имя бэкенда, лимит делят все клиенты маршрута на этой ноде.',
          'backend st_route_bw',
          '    stick-table type string len 32 size 1k expire 10m store bytes_in_rate(1s),bytes_out_rate(1s)',
          '',
        ]
      : []),
    '# TLS не терминируем: читаем SNI из ClientHello и по карте отправляем на нужный выход.',
    'frontend fe_sni',
    '    bind :443',
    '    tcp-request inspect-delay 5s',
    '    tcp-request connection track-sc2 src table st_clients',
    ...bwLines,
    '    tcp-request content accept if { req.ssl_hello_type 1 }',
    `    use_backend %[req.ssl_sni,lower,map(${SNI_MAP_PATH})]`,
    `    default_backend ${def}`,
    '',
    '# Неизвестный SNI и не-TLS трафик: закрываем соединение.',
    'backend be_reject',
    '    tcp-request content reject',
  ];

  for (const r of routes) {
    out.push('', `# ${oneLine(r.name)}`, `backend ${backendName(r.slug)}`);
    r.exits.forEach((e, i) => {
      if (!isValidHost(e.host) || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error(`некорректный выход ${e.host}:${e.port} в маршруте ${r.slug}`);
      const host = isIP(e.host) === 6 ? `[${e.host}]` : e.host;
      const opts = [
        r.healthCheck ? 'check inter 10s fall 3 rise 2' : '',
        r.proxyProtocol ? 'send-proxy-v2' : '',
        isIP(e.host) === 0 ? 'init-addr last,libc,none' : '', // имя не должно ломать проверку конфига, если DNS недоступен
      ].filter(Boolean);
      out.push(`    server ${r.slug}${i + 1} ${host}:${e.port}${opts.length ? ' ' + opts.join(' ') : ''}`);
    });
  }

  const extra = input.extraConfig?.replace(/\r\n/g, '\n').trim();
  if (extra) out.push('', '# Свои директивы (настройки ноды)', extra);

  const cfg = out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  return { cfg, sniMap, sha256: stateHash(cfg, sniMap) };
}

/** Версия состояния ноды: конфиг и карта вместе (меняется любая из них — меняется хеш). */
export const stateHash = (cfg: string, sniMap: string): string => sha256(cfg + '\0' + sniMap);

/**
 * Директивы HAProxy, дающие выполнение чужого кода. Список и логика зеркалят agent/internal/apply (Forbidden);
 * расхождение ловит общий файл protocol/fixtures/config_policy.json в тестах обеих сторон.
 */
const FORBIDDEN: Record<string, string> = {
  program: 'секция program запускает внешние процессы',
  'external-check': 'external-check запускает внешние программы',
  'lua-load': 'lua-load загружает произвольный код',
  'lua-load-per-thread': 'lua-load-per-thread загружает произвольный код',
  'lua-prepend-path': 'lua-prepend-path меняет пути загрузки кода',
  'ssl-engine': 'ssl-engine загружает внешние модули',
  setenv: 'setenv меняет окружение процесса',
  presetenv: 'presetenv меняет окружение процесса',
  resetenv: 'resetenv меняет окружение процесса',
};

export function forbiddenDirectives(cfg: string): string[] {
  const out: string[] = [];
  cfg.split('\n').forEach((line, i) => {
    if (line.includes('\0')) return void out.push(`строка ${i + 1}: нулевой байт`);
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const word = t.match(/^([A-Za-z0-9_.-]+)/)?.[1]?.toLowerCase();
    const why = word ? FORBIDDEN[word] : undefined;
    if (why) out.push(`строка ${i + 1}: ${why}`);
  });
  return out;
}
