import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { actorOf, audit } from '../lib/audit.js';
import { HttpError, parse, requireAuth } from '../lib/http.js';
import { RemnaClient, RemnaError } from '../lib/remnawave.js';
import { BAN_LIMITS, encryptHeaders, loadRemna, loadTelegram, parseAllowEntry, putSetting, remnaCreds, remnaPublic, type RemnaSettings, type TelegramSettings } from '../lib/settings.js';
import { encryptSecret } from '../lib/crypto.js';
import { sendTelegram, TG_CHAT_RE, TG_TOKEN_RE } from '../lib/telegram.js';

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['authorization', 'host', 'content-length', 'content-type', 'accept', 'user-agent', 'connection', 'transfer-encoding']);

const RemnaBody = z.object({
  enabled: z.boolean(),
  url: z.string().trim().max(300),
  /** Новый токен. Не передан или пуст — прежний остаётся. */
  token: z.string().trim().max(4096).optional(),
  clearToken: z.boolean().optional(),
  /** Заголовки целиком: не передан — прежние остаются, {} — удалить. */
  headers: z.record(z.string(), z.string().max(1000)).optional(),
  observeOnly: z.boolean(),
  banMode: z.enum(['report', 'fixed']),
  fixedBanSec: z.number().int(),
  maxBanSec: z.number().int(),
  pollIntervalSec: z.number().int().min(5, 'Интервал опроса: не чаще раза в 5 секунд').max(3600),
  allowlist: z.array(z.string().trim().max(60)).max(200),
});

function validateUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'validation', 'Адрес Remnawave: нужна ссылка вида https://remnawave.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'validation', 'Адрес Remnawave должен начинаться с https:// (или http:// внутри закрытой сети)');
  if (u.username || u.password) throw new HttpError(400, 'validation', 'Адрес Remnawave не должен содержать логин и пароль: токен вводится отдельно');
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

const secs = (v: number, what: string) => {
  if (v < BAN_LIMITS.min || v > BAN_LIMITS.max) throw new HttpError(400, 'validation', `${what}: от минуты до года`);
};

const TgBody = z.object({
  enabled: z.boolean(),
  token: z.string().trim().max(200).optional(),
  clearToken: z.boolean().optional(),
  chatId: z.string().trim().max(64),
});

export function integrationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const auth = { preHandler: requireAuth };
  const limit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }; // вызовы наружу
  const save = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }; // сохранение настроек

  // ───── Remnawave / торрент-блокер ─────
  app.get('/api/settings/remnawave', auth, async () => remnaPublic(await loadRemna(db), config.APP_SECRET));

  app.put('/api/settings/remnawave', { ...auth, ...save }, async (req) => {
    const b = parse(RemnaBody, req.body);
    const cur = await loadRemna(db);
    const next: RemnaSettings = { ...cur };
    delete (next as { demo?: boolean }).demo; // сохранённые настройки больше не демо-заготовка
    next.url = b.url ? validateUrl(b.url) : '';
    if (b.clearToken) next.tokenEnc = null;
    else if (b.token) next.tokenEnc = encryptSecret(b.token, config.APP_SECRET);
    if (b.headers) {
      for (const [k, v] of Object.entries(b.headers)) {
        if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new HttpError(400, 'validation', `Заголовок «${k}» недопустим: Authorization и служебные заголовки задавать нельзя`);
        if (/[\r\n\0]/.test(v)) throw new HttpError(400, 'validation', `Значение заголовка «${k}» содержит недопустимые символы`);
      }
      next.headersEnc = encryptHeaders(b.headers, config.APP_SECRET);
    }
    next.observeOnly = b.observeOnly;
    next.banMode = b.banMode;
    secs(b.fixedBanSec, 'Фиксированный срок бана');
    secs(b.maxBanSec, 'Максимальный срок бана');
    next.fixedBanSec = b.fixedBanSec;
    next.maxBanSec = b.maxBanSec;
    next.pollIntervalSec = b.pollIntervalSec;
    const bad = b.allowlist.find((e) => !parseAllowEntry(e));
    if (bad !== undefined) throw new HttpError(400, 'validation', `«${bad}» — не IP и не подсеть. Примеры: 203.0.113.7, 10.0.0.0/8`);
    next.allowlist = [...new Set(b.allowlist.filter(Boolean))];
    next.enabled = b.enabled;
    if (next.enabled && (!next.url || !next.tokenEnc)) throw new HttpError(400, 'validation', 'Чтобы включить опрос, укажите адрес Remnawave и токен');
    await putSetting(db, 'remnawave', next);
    // Секреты в аудит не попадают: только факт смены.
    await audit(
      db,
      actorOf(req),
      'settings.remnawave',
      undefined,
      { enabled: next.enabled, url: next.url, tokenChanged: !!b.token || !!b.clearToken, headersChanged: b.headers !== undefined, observeOnly: next.observeOnly, banMode: next.banMode, fixedBanSec: next.fixedBanSec, maxBanSec: next.maxBanSec, pollIntervalSec: next.pollIntervalSec, allowlist: next.allowlist },
      req.ip,
    );
    return remnaPublic(next, config.APP_SECRET);
  });

  /** Проверка связи: читаем один отчёт и список нод. Можно проверить ещё не сохранённые значения. */
  app.post('/api/settings/remnawave/test', { ...auth, ...limit }, async (req) => {
    const b = parse(z.object({ url: z.string().trim().max(300).optional(), token: z.string().trim().max(4096).optional(), headers: z.record(z.string(), z.string().max(1000)).optional() }), req.body);
    const saved = remnaCreds(await loadRemna(db), config.APP_SECRET);
    const url = b.url ? validateUrl(b.url) : saved?.url;
    const token = b.token || saved?.token;
    if (!url || !token) throw new HttpError(400, 'validation', 'Укажите адрес Remnawave и токен');
    const client = new RemnaClient({ url, token, headers: b.headers ?? saved?.headers ?? {} }, ctx.http);
    const out: { reports: { ok: boolean; total?: number; error?: string }; nodes: { ok: boolean; count?: number; error?: string } } = { reports: { ok: false }, nodes: { ok: false } };
    try {
      out.reports = { ok: true, total: (await client.page(0, 1)).total };
    } catch (e) {
      out.reports = { ok: false, error: (e as Error).message };
    }
    try {
      out.nodes = { ok: true, count: (await client.nodes()).length };
    } catch (e) {
      out.nodes = { ok: false, error: e instanceof RemnaError ? e.message : (e as Error).message };
    }
    return out;
  });

  // ───── Telegram ─────
  const tgPublic = (s: TelegramSettings) => ({ enabled: s.enabled, hasToken: !!s.tokenEnc, chatId: s.chatId });
  app.get('/api/settings/telegram', auth, async () => tgPublic(await loadTelegram(db)));

  app.put('/api/settings/telegram', { ...auth, ...save }, async (req) => {
    const b = parse(TgBody, req.body);
    const cur = await loadTelegram(db);
    const next: TelegramSettings = { ...cur, enabled: b.enabled, chatId: b.chatId };
    if (b.chatId && !TG_CHAT_RE.test(b.chatId)) throw new HttpError(400, 'validation', 'chat_id: число (для групп оно отрицательное, например -1001234567890) или @имя_канала');
    if (b.clearToken) next.tokenEnc = null;
    else if (b.token) {
      if (!TG_TOKEN_RE.test(b.token)) throw new HttpError(400, 'validation', 'Токен бота выглядит как 123456789:AAE… (его выдаёт @BotFather)');
      next.tokenEnc = encryptSecret(b.token, config.APP_SECRET);
    }
    if (next.enabled && (!next.tokenEnc || !next.chatId)) throw new HttpError(400, 'validation', 'Чтобы включить уведомления, укажите токен бота и chat_id');
    await putSetting(db, 'telegram', next);
    await audit(db, actorOf(req), 'settings.telegram', undefined, { enabled: next.enabled, chatId: next.chatId, tokenChanged: !!b.token || !!b.clearToken }, req.ip);
    return tgPublic(next);
  });

  /** Тестовое сообщение. Можно проверить ещё не сохранённые значения. */
  app.post('/api/settings/telegram/test', { ...auth, ...limit }, async (req) => {
    const b = parse(z.object({ token: z.string().trim().max(200).optional(), chatId: z.string().trim().max(64).optional() }), req.body);
    const saved = await loadTelegram(db);
    let tokenEnc = saved.tokenEnc;
    if (b.token) {
      if (!TG_TOKEN_RE.test(b.token)) throw new HttpError(400, 'validation', 'Токен бота выглядит как 123456789:AAE… (его выдаёт @BotFather)');
      tokenEnc = encryptSecret(b.token, config.APP_SECRET);
    }
    const chatId = b.chatId || saved.chatId;
    if (chatId && !TG_CHAT_RE.test(chatId)) throw new HttpError(400, 'validation', 'chat_id: число (для групп оно отрицательное) или @имя_канала');
    const r = await sendTelegram({ enabled: true, tokenEnc, chatId }, config.APP_SECRET, '✅ <b>Popug Bridges</b>\nТестовое сообщение: уведомления настроены верно.', ctx.http);
    await audit(db, actorOf(req), 'settings.telegram_test', undefined, { ok: r.ok }, req.ip);
    return r;
  });
}
