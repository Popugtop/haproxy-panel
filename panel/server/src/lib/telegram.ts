import { decryptSecret } from './crypto.js';
import type { Http } from './remnawave.js';
import type { TelegramSettings } from './settings.js';

export interface SendResult {
  ok: boolean;
  error: string | null;
}

export const TG_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
export const TG_CHAT_RE = /^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Токен не должен попасть ни в сообщение об ошибке, ни в логи. */
const scrub = (msg: string, token: string): string => msg.split(token).join('[токен]');

export async function sendTelegram(s: TelegramSettings, appSecret: string, text: string, http: Http = fetch): Promise<SendResult> {
  if (!s.tokenEnc || !s.chatId) return { ok: false, error: 'Telegram не настроен: нужны токен бота и chat_id' };
  const token = decryptSecret(s.tokenEnc, appSecret);
  let res: Response;
  try {
    res = await http(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: s.chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch (e) {
    return { ok: false, error: scrub(`Не удалось связаться с Telegram: ${(e as Error).message}`, token) };
  }
  if (res.ok) return { ok: true, error: null };
  let desc = '';
  try {
    desc = ((await res.json()) as { description?: string }).description ?? '';
  } catch {
    /* без описания */
  }
  const hint =
    res.status === 401
      ? 'неверный токен бота'
      : res.status === 400 && /chat not found/i.test(desc)
        ? 'чат не найден: напишите боту /start или добавьте его в группу и проверьте chat_id'
        : res.status === 403
          ? 'бот не может писать в этот чат (заблокирован или удалён из группы)'
          : res.status === 429
            ? 'Telegram просит подождать (лимит сообщений)'
            : desc || `HTTP ${res.status}`;
  return { ok: false, error: scrub(`Telegram: ${hint}`, token) };
}
