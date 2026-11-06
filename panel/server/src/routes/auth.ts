import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { audit } from '../lib/audit.js';
import {
  burnPasswordCheck, createSession, destroySession, destroyUserSessions, hashPassword, LOCK_MS, MAX_FAILED, newTotpSecret,
  SESSION_COOKIE, totpQrSvg, totpUri, validatePasswordStrength, verifyPassword, verifyTotp,
} from '../lib/auth.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';

const LoginBody = z.object({
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  code: z.string().trim().max(10).optional(),
});

const ChangePasswordBody = z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) });

export function authRoutes(app: FastifyInstance, { db, config }: Ctx): void {
  const setCookie = (reply: import('fastify').FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const login = body.login.toLowerCase();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.login, login)).limit(1);

    const fail = async (why: string): Promise<never> => {
      await audit(db, { id: user?.id ?? null, login }, 'auth.login_failed', undefined, { reason: why }, req.ip);
      throw new HttpError(401, 'invalid_credentials', 'Неверный логин, пароль или код');
    };

    if (!user || user.disabled) {
      await burnPasswordCheck(body.password);
      return fail('unknown_user');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpError(429, 'locked', 'Слишком много неудачных попыток. Подождите 15 минут.');
    }

    const bump = async () => {
      const failed = user.failedLogins + 1;
      await db
        .update(schema.users)
        .set({ failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null })
        .where(eq(schema.users.id, user.id));
    };

    if (!(await verifyPassword(user.passwordHash, body.password))) {
      await bump();
      return fail('bad_password');
    }

    let step: number | null = null;
    if (user.totpEnabled) {
      if (!body.code) return reply.send({ status: 'totp_required' });
      step = verifyTotp(decryptSecret(user.totpSecretEnc!, config.APP_SECRET), user.login, body.code, user.totpLastStep);
      if (step === null) {
        await bump();
        return fail('bad_totp');
      }
    }

    await db
      .update(schema.users)
      .set({ failedLogins: 0, lockedUntil: null, ...(step !== null ? { totpLastStep: step } : {}) })
      .where(eq(schema.users.id, user.id));
    const { token, expiresAt } = await createSession(db, user.id, user.totpEnabled, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, token, expiresAt);
    await audit(db, { id: user.id, login: user.login }, 'auth.login', undefined, { totp: user.totpEnabled }, req.ip);
    return { status: user.totpEnabled ? 'ok' : 'totp_setup' };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) {
      await destroySession(db, req.session.id);
      await audit(db, { id: req.session.user.id, login: req.session.user.login }, 'auth.logout', undefined, undefined, req.ip);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.session) throw new HttpError(401, 'unauthorized', 'Требуется вход');
    const { user, mfaOk } = req.session;
    return { status: mfaOk ? 'ok' : 'totp_setup', user: { id: user.id, login: user.login, role: user.role } };
  });

  // Настройка TOTP: сессия создана по паролю, mfaOk=false.
  app.get('/api/auth/totp/setup', async (req) => {
    const s = req.session;
    if (!s) throw new HttpError(401, 'unauthorized', 'Требуется вход');
    if (s.user.totpEnabled) throw new HttpError(409, 'already_enabled', 'TOTP уже включён');
    const secret = newTotpSecret();
    await db.update(schema.users).set({ totpPendingEnc: encryptSecret(secret, config.APP_SECRET) }).where(eq(schema.users.id, s.user.id));
    const uri = totpUri(secret, s.user.login);
    const svg = await totpQrSvg(uri);
    return { secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  });

  app.post('/api/auth/totp/enable', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const s = req.session;
    if (!s) throw new HttpError(401, 'unauthorized', 'Требуется вход');
    const { code } = parse(z.object({ code: z.string().trim().max(10) }), req.body);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id));
    if (!user?.totpPendingEnc || user.totpEnabled) throw new HttpError(409, 'no_setup', 'Сначала запросите QR-код');
    const secret = decryptSecret(user.totpPendingEnc, config.APP_SECRET);
    const step = verifyTotp(secret, user.login, code, null);
    if (step === null) throw new HttpError(400, 'bad_code', 'Код не подошёл. Проверьте время на телефоне и попробуйте ещё раз.');
    await db
      .update(schema.users)
      .set({ totpSecretEnc: user.totpPendingEnc, totpPendingEnc: null, totpEnabled: true, totpLastStep: step })
      .where(eq(schema.users.id, user.id));
    await db.update(schema.sessions).set({ mfaOk: true }).where(eq(schema.sessions.id, s.id));
    await audit(db, { id: user.id, login: user.login }, 'auth.totp_enabled', undefined, undefined, req.ip);
    return { status: 'ok' };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const s = req.session;
    if (!s?.mfaOk) throw new HttpError(401, 'unauthorized', 'Требуется вход');
    const body = parse(ChangePasswordBody, req.body);
    const weak = validatePasswordStrength(body.next);
    if (weak) throw new HttpError(400, 'weak_password', weak);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id));
    if (!user || !(await verifyPassword(user.passwordHash, body.current))) throw new HttpError(400, 'bad_password', 'Текущий пароль неверен');
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.next) }).where(eq(schema.users.id, user.id));
    await destroyUserSessions(db, user.id); // все сессии, включая эту, завершаются
    const { token, expiresAt } = await createSession(db, user.id, true, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, token, expiresAt);
    await audit(db, { id: user.id, login: user.login }, 'auth.password_changed', undefined, undefined, req.ip);
    return { ok: true };
  });
}
