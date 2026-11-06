/**
 * Разбор «ручного» haproxy.cfg: достаёт SNI-маршруты (`use_backend … if { req_ssl_sni -i … }`, в том числе через
 * именованные acl, и через map-файл: `use_backend %[req.ssl_sni,lower,map(/etc/haproxy/sni.map)]`) и server-строки бэкендов.
 * Ничего не меняет на ноде — результат показывается как предпросмотр.
 */
import { isIP } from 'node:net';
import { isCountryCode } from '@popug/protocol/countries';

export interface ImportedExit {
  serverName: string;
  host: string;
  port: number;
}

export interface ImportedRoute {
  backend: string;
  slug: string;
  /** Страна, угаданная по имени (be_de → DE); пустая, если угадать нельзя. */
  country: string;
  snis: string[];
  exits: ImportedExit[];
  proxyProtocol: boolean;
  healthCheck: boolean;
}

export interface ImportPreview {
  routes: ImportedRoute[];
  /** backend из default_backend, если он среди маршрутов. */
  defaultBackend: string | null;
  warnings: string[];
  /** Секции, которых в панели не будет: исчезнут из конфига при применении. */
  ignoredSections: { kind: string; name: string; note: string }[];
}

interface Section {
  kind: string;
  name: string;
  lines: string[];
}

const SECTION_KINDS = new Set(['global', 'defaults', 'frontend', 'backend', 'listen', 'userlist', 'resolvers', 'peers', 'cache', 'program', 'mailers', 'http-errors', 'ring', 'fcgi-app']);

function splitSections(cfg: string): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [first, ...rest] = line.split(/\s+/);
    if (first && SECTION_KINDS.has(first) && !/^\s/.test(raw)) {
      cur = { kind: first, name: rest[0] ?? '', lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return sections;
}

const SNI_FETCH = /^(req_ssl_sni|req\.ssl_sni|ssl_fc_sni)$/;

/** Разбирает «<fetch> [-i] [-m flag] v1 v2 …» → значения и флаг сопоставления. */
function parseAclValues(tokens: string[]): { values: string[]; match: string } | null {
  if (!tokens[0] || !SNI_FETCH.test(tokens[0])) return null;
  const values: string[] = [];
  let match = 'str';
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '-i') continue;
    if (t === '-m') {
      match = tokens[++i] ?? 'str';
      continue;
    }
    if (t.startsWith('-')) continue;
    values.push(t.toLowerCase());
  }
  return { values, match };
}

const slugify = (backend: string): string => backend.replace(/^(be|backend|b)[_-]/i, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'route';

function parseServer(tokens: string[]): { exit: ImportedExit; check: boolean; proxy: 'v2' | 'v1' | null } | null {
  // server NAME HOST:PORT opts…
  const [, name, addr, ...opts] = tokens;
  if (!name || !addr) return null;
  const m = addr.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/);
  if (!m) return null;
  const host = (m[1] ?? m[2])!;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  const proxy = opts.includes('send-proxy-v2') || opts.includes('send-proxy-v2-ssl') ? 'v2' : opts.includes('send-proxy') ? 'v1' : null;
  return { exit: { serverName: name, host, port }, check: opts.includes('check'), proxy };
}

export interface ConfigMapFile {
  path: string;
  content: string;
}

/** Содержимое map-файла: «ключ значение» построчно, комментарии с «#». Ключи приводятся к нижнему регистру. */
export function parseMapFile(content: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [key, value] = line.split(/\s+/);
    if (key && value) out.push([key.toLowerCase(), value]);
  }
  return out;
}

/** use_backend %[req.ssl_sni,lower,map(путь[,значение_по_умолчанию])] [if …]. */
const DYNAMIC_USE_BACKEND = /^use_backend\s+%\[\s*(?:req\.ssl_sni|req_ssl_sni|ssl_fc_sni)\s*(?:,\s*lower\s*)?,\s*(map(?:_[a-z]+)?)\(\s*([^),\s]+)\s*(?:,\s*([^)\s]+))?\s*\)\s*\](?:\s+(if|unless)\s+(.+))?$/;

export function parseHandConfig(cfg: string, maps: ConfigMapFile[] = []): ImportPreview {
  const sections = splitSections(cfg);
  const warnings: string[] = [];
  const preview: ImportPreview = { routes: [], defaultBackend: null, warnings, ignoredSections: [] };

  // backend → server-строки
  const backends = new Map<string, { exits: ImportedExit[]; check: boolean; proxy: boolean; v1: boolean }>();
  for (const s of sections.filter((x) => x.kind === 'backend')) {
    const info = { exits: [] as ImportedExit[], check: false, proxy: false, v1: false };
    for (const l of s.lines) {
      const t = l.split(/\s+/);
      if (t[0] !== 'server') continue;
      const p = parseServer(t);
      if (!p) {
        warnings.push(`backend ${s.name}: не удалось разобрать строку «${l.slice(0, 80)}»`);
        continue;
      }
      info.exits.push(p.exit);
      info.check ||= p.check;
      info.proxy ||= p.proxy !== null;
      info.v1 ||= p.proxy === 'v1';
    }
    backends.set(s.name, info);
  }

  // SNI → backend из frontend/listen
  const bySni = new Map<string, Set<string>>(); // backend → snis
  const referenced = new Set<string>();
  for (const s of sections.filter((x) => x.kind === 'frontend' || x.kind === 'listen')) {
    const acls = new Map<string, string[]>();
    for (const l of s.lines) {
      const t = l.split(/\s+/);
      if (t[0] === 'acl' && t[1]) {
        const parsed = parseAclValues(t.slice(2));
        if (!parsed) continue;
        if (parsed.match !== 'str' && parsed.match !== 'exact') warnings.push(`acl ${t[1]}: сопоставление -m ${parsed.match} — в панели только точное совпадение SNI, значения импортированы как точные`);
        acls.set(t[1], [...(acls.get(t[1]) ?? []), ...parsed.values]);
      }
    }
    for (const l of s.lines) {
      const t = l.split(/\s+/);
      if (t[0] === 'default_backend' && t[1]) {
        preview.defaultBackend = t[1];
        referenced.add(t[1]);
      }
      if (t[0] !== 'use_backend' || !t[1]) continue;
      const target = t[1];
      if (target.startsWith('%[')) {
        const dyn = l.match(DYNAMIC_USE_BACKEND);
        if (!dyn) {
          warnings.push(`${s.name}: use_backend с динамическим именем (${target.slice(0, 60)}…) разобрать не удалось — задайте SNI маршрутов вручную`);
          continue;
        }
        const [, fn, mapPath, mapDefault, , condText] = dyn;
        const file = maps.find((m) => m.path === mapPath);
        if (!file) {
          warnings.push(`${s.name}: SNI лежат в карте ${mapPath}, но агент её не прислал (агент устарел — обновите его командой установки без токена, либо файл не .map или лежит вне каталога конфига) — задайте SNI маршрутов вручную`);
          continue;
        }
        if (fn !== 'map' && fn !== 'map_str') warnings.push(`${s.name}: ${fn}(${mapPath}) — в панели только точное совпадение SNI, значения карты импортированы как точные`);
        if (condText) warnings.push(`${s.name}: у use_backend по карте ${mapPath} есть условие «${condText.slice(0, 60)}» — оно не учтено, проверьте маршруты`);
        const entries = parseMapFile(file.content);
        if (entries.length === 0) warnings.push(`карта ${mapPath} пуста или не разобрана`);
        for (const [sni, backend] of entries) {
          referenced.add(backend);
          const set = bySni.get(backend) ?? new Set<string>();
          set.add(sni);
          bySni.set(backend, set);
        }
        if (mapDefault && !preview.defaultBackend) {
          preview.defaultBackend = mapDefault;
          referenced.add(mapDefault);
        }
        continue;
      }
      referenced.add(target);
      const cond = t.slice(2);
      if (cond[0] !== 'if') {
        warnings.push(`use_backend ${target}: условие «${cond.join(' ').slice(0, 60)}» не разобрано`);
        continue;
      }
      const rest = l.slice(l.indexOf(' if ') + 4).trim();
      const snis: string[] = [];
      // inline { req_ssl_sni -i a b } (возможны несколько через ||)
      let simple = true;
      for (const part of rest.split(/\s*(?:\|\||\bor\b)\s*/)) {
        const inline = part.match(/^\{\s*(.+?)\s*\}$/);
        if (inline) {
          const parsed = parseAclValues(inline[1]!.split(/\s+/));
          if (parsed) {
            if (parsed.match !== 'str' && parsed.match !== 'exact') warnings.push(`use_backend ${target}: -m ${parsed.match} импортирован как точное совпадение`);
            snis.push(...parsed.values);
          } else simple = false;
        } else if (/^[\w.-]+$/.test(part) && acls.has(part)) {
          snis.push(...acls.get(part)!);
        } else simple = false;
      }
      if (!simple) warnings.push(`use_backend ${target}: сложное условие «${rest.slice(0, 80)}» разобрано не полностью — проверьте SNI маршрута`);
      const set = bySni.get(target) ?? new Set<string>();
      snis.forEach((x) => set.add(x));
      bySni.set(target, set);
    }
  }

  const usedSlugs = new Set<string>();
  for (const [backend, snis] of bySni) {
    const info = backends.get(backend);
    if (!info) {
      warnings.push(`use_backend ссылается на backend ${backend}, которого нет в конфиге — маршрут пропущен`);
      continue;
    }
    if (info.exits.length === 0) {
      warnings.push(`backend ${backend} без server-строк — маршрут пропущен`);
      continue;
    }
    if (info.v1) warnings.push(`backend ${backend}: send-proxy (v1) — панель использует PROXY protocol v2, при применении станет v2`);
    let slug = slugify(backend);
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${slug.slice(0, 21)}_${n}`;
    usedSlugs.add(slug);
    const guess = /^[a-z]{2}$/.test(slug) && isCountryCode(slug.toUpperCase()) ? slug.toUpperCase() : '';
    for (const e of info.exits) {
      if (isIP(e.host) === 0) warnings.push(`backend ${backend}: выход задан именем ${e.host} — оно будет резолвиться на ноде при старте HAProxy`);
    }
    preview.routes.push({ backend, slug, country: guess, snis: [...snis].sort(), exits: info.exits, proxyProtocol: info.proxy, healthCheck: info.check });
    if (snis.size === 0) warnings.push(`backend ${backend}: не нашлось ни одного SNI — маршрут будет без SNI`);
  }
  preview.routes.sort((a, b) => a.slug.localeCompare(b.slug));
  if (preview.defaultBackend && !preview.routes.some((r) => r.backend === preview.defaultBackend)) preview.defaultBackend = null;

  const routeBackends = new Set(preview.routes.map((r) => r.backend));
  for (const s of sections) {
    if (s.kind === 'backend' && routeBackends.has(s.name)) continue;
    if (['global', 'defaults'].includes(s.kind)) continue;
    if (s.kind === 'backend' && s.name === 'st_clients') continue; // панель создаёт свою
    if (s.kind === 'frontend' && s.lines.some((l) => /^use_backend\b/.test(l)) && s.lines.some((l) => /^bind\b.*:443\b/.test(l))) continue; // SNI-фронтенд: заменяется своим
    const note = s.kind === 'backend' && !referenced.has(s.name) ? 'не участвует в SNI-маршрутизации' : s.kind === 'backend' ? 'не импортирован' : 'панель такого не создаёт';
    preview.ignoredSections.push({ kind: s.kind, name: s.name, note });
  }
  return preview;
}
