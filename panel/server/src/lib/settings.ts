import { eq } from 'drizzle-orm';
import { BlockList, isIP } from 'node:net';
import { type DB, schema } from '../db/index.js';
import { MAX_BAN_SEC } from './bans.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/** Настройки панели «ключ → JSON». Секреты внутри лежат только зашифрованными (APP_SECRET), наружу не отдаются никогда. */
export async function getSetting<T>(db: DB, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  // Всегда копия: вызывающий меняет объект, а значения по умолчанию должны оставаться прежними.
  return { ...structuredClone(fallback), ...((row?.value as object | undefined) ?? {}) } as T;
}

export async function putSetting(db: DB, key: string, value: unknown): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

// ───────── Remnawave / торрент-блокер ─────────

export interface RemnaSettings {
  enabled: boolean;
  url: string;
  tokenEnc: string | null;
  /** Дополнительные заголовки (панель Remnawave за Caddy с секретом): имена открыты, значения зашифрованы целиком. */
  headersEnc: string | null;
  /** Режим наблюдения: решения записываются, но баны не ставятся. По умолчанию включён: боевой режим включают сознательно. */
  observeOnly: boolean;
  /** report — срок из отчёта Remnawave (blockDuration), fixed — всегда свой срок. */
  banMode: 'report' | 'fixed';
  /** Где банить: route — только на мостах, у которых есть маршрут на выход этой ноды Remnawave; all — на всех мостах. */
  scope: 'route' | 'all';
  fixedBanSec: number;
  /** Предохранитель: дольше этого не банить, даже если в отчёте больше. */
  maxBanSec: number;
  pollIntervalSec: number;
  /** IP и подсети, которые не банятся никогда (дополнительно к адресам своих нод и выходов). */
  allowlist: string[];
}

export const REMNA_DEFAULTS: RemnaSettings = {
  enabled: false,
  url: '',
  tokenEnc: null,
  headersEnc: null,
  observeOnly: true,
  banMode: 'report',
  scope: 'route',
  fixedBanSec: 3600,
  maxBanSec: 86400,
  pollIntervalSec: 15,
  allowlist: [],
};

export const loadRemna = (db: DB): Promise<RemnaSettings> => getSetting(db, 'remnawave', REMNA_DEFAULTS);

export interface RemnaCreds {
  url: string;
  token: string;
  headers: Record<string, string>;
}

export function remnaCreds(s: RemnaSettings, appSecret: string): RemnaCreds | null {
  if (!s.url || !s.tokenEnc) return null;
  const headers = s.headersEnc ? (JSON.parse(decryptSecret(s.headersEnc, appSecret)) as Record<string, string>) : {};
  return { url: s.url, token: decryptSecret(s.tokenEnc, appSecret), headers };
}

export const encryptHeaders = (h: Record<string, string>, appSecret: string): string | null => (Object.keys(h).length ? encryptSecret(JSON.stringify(h), appSecret) : null);

/** Что можно показывать в интерфейсе. */
export function remnaPublic(s: RemnaSettings, appSecret: string) {
  let headerNames: string[] = [];
  if (s.headersEnc) {
    try {
      headerNames = Object.keys(JSON.parse(decryptSecret(s.headersEnc, appSecret)) as object);
    } catch {
      headerNames = [];
    }
  }
  return {
    enabled: s.enabled,
    url: s.url,
    hasToken: !!s.tokenEnc,
    headerNames,
    observeOnly: s.observeOnly,
    banMode: s.banMode,
    scope: s.scope,
    fixedBanSec: s.fixedBanSec,
    maxBanSec: s.maxBanSec,
    pollIntervalSec: s.pollIntervalSec,
    allowlist: s.allowlist,
  };
}

export const BAN_LIMITS = { min: 60, max: MAX_BAN_SEC };

/** IP или подсеть: «203.0.113.7», «10.0.0.0/8», «2001:db8::/32». */
export function parseAllowEntry(raw: string): { net: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const s = raw.trim();
  const [addr, len] = s.split('/');
  const fam = isIP(addr ?? '');
  if (!fam) return null;
  const max = fam === 4 ? 32 : 128;
  const prefix = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (prefix < 0 || prefix > max) return null;
  return { net: addr!, prefix, family: fam === 4 ? 'ipv4' : 'ipv6' };
}

export function allowlistMatcher(entries: string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const e of entries) {
    const p = parseAllowEntry(e);
    if (p) list.addSubnet(p.net, p.prefix, p.family);
  }
  return (ip) => {
    const fam = isIP(ip);
    return fam ? list.check(ip, fam === 4 ? 'ipv4' : 'ipv6') : false;
  };
}

// ───────── Telegram ─────────

export interface TelegramSettings {
  enabled: boolean;
  tokenEnc: string | null;
  chatId: string;
}

export const TELEGRAM_DEFAULTS: TelegramSettings = { enabled: false, tokenEnc: null, chatId: '' };
export const loadTelegram = (db: DB): Promise<TelegramSettings> => getSetting(db, 'telegram', TELEGRAM_DEFAULTS);

// ───────── Панель ─────────

/** Домен для подсказки SNI при создании маршрута: новый маршрут de → de.<домен>. */
export interface PanelSettings {
  sniDomain: string;
}

export const PANEL_DEFAULTS: PanelSettings = { sniDomain: 'popug.cloud' };
export const loadPanelSettings = (db: DB): Promise<PanelSettings> => getSetting(db, 'panel', PANEL_DEFAULTS);

/** Домен из одних меток латиницей: de.popug.cloud, без схемы, порта и слэшей. */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
