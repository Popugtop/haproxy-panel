import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  /** Ключ шифрования секретов в БД (TOTP, позже токены Telegram/Remnawave). Не менять после запуска. */
  APP_SECRET: z.string().min(32, 'APP_SECRET должен быть не короче 32 символов (openssl rand -hex 32)'),
  /** Публичный адрес панели. Подставляется в install.sh, поэтому берётся из конфига, а не из заголовка Host. */
  PUBLIC_URL: z.string().url().optional(),
  /** Панель стоит за Caddy: доверять X-Forwarded-For. Если порт открыт наружу напрямую, выключите. */
  TRUST_PROXY: bool.default(true),
  AGENT_DIST: z.string().default('./agent-dist'),
  WEB_DIST: z.string().default('../web/dist'),
  /** Демо-режим: сид из 3 нод и фейковый агент. Запрещён в production. */
  DEMO: bool.default(false),
  /** Разрешить скачивание логотипа с закрытых адресов. Только для локальной разработки (например, за прокси с подменой DNS). */
  LOGO_ALLOW_PRIVATE: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const PANEL_VERSION = process.env.PANEL_VERSION || process.env.npm_package_version || '0.1.0';

export type Config = z.infer<typeof Env> & { publicUrl: string; secureCookies: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Неверная конфигурация окружения:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && !c.PUBLIC_URL) {
    throw new Error('PUBLIC_URL обязателен в production (адрес панели, как его видят мосты, https://…)');
  }
  if (c.DEMO && c.NODE_ENV === 'production') {
    throw new Error('DEMO=1 запрещён при NODE_ENV=production: демо-данные не должны попадать в прод');
  }
  const publicUrl = (c.PUBLIC_URL ?? `http://localhost:${c.PORT}`).replace(/\/+$/, '');
  return { ...c, publicUrl, secureCookies: publicUrl.startsWith('https://') };
}
