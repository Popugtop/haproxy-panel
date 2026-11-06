import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { actorOf, audit } from '../lib/audit.js';
import { destroyUserSessions, verifyPassword, verifyTotp } from '../lib/auth.js';
import { decryptSecret } from '../lib/crypto.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';

const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function accountRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const auth = { preHandler: requireAuth };

  const me = async (req: { session?: { user: { id: string } } }) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, req.session!.user.id));
    if (!u) throw notFound('Пользователь не найден');
    return u;
  };

  app.get('/api/account', auth, async (req) => {
    const u = await me(req);
    return { login: u.login, role: u.role, totpEnabled: u.totpEnabled, createdAt: u.createdAt };
  });

  /** Смена логина: требует текущий пароль. Сессии остаются. */
  app.patch('/api/account', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ login: z.string().trim().toLowerCase(), password: z.string().min(1).max(256) }), req.body);
    if (!LOGIN_RE.test(b.login)) throw new HttpError(400, 'validation', 'Логин: 2–32 символа, латиница, цифры, точка, дефис, подчёркивание');
    const u = await me(req);
    if (!(await verifyPassword(u.passwordHash, b.password))) throw new HttpError(400, 'bad_password', 'Пароль неверен');
    if (b.login === u.login) return { login: u.login };
    const [dupe] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.login, b.login), ne(schema.users.id, u.id)));
    if (dupe) throw new HttpError(409, 'login_taken', 'Этот логин занят');
    await db.update(schema.users).set({ login: b.login }).where(eq(schema.users.id, u.id));
    await audit(db, { id: u.id, login: b.login }, 'account.login_changed', { type: 'user', id: u.id }, { from: u.login, to: b.login }, req.ip);
    return { login: b.login };
  });

  /** Перенастройка TOTP: пароль и действующий код. Остальные сессии завершаются, а эта возвращается на экран настройки. */
  app.post('/api/account/totp/restart', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ password: z.string().min(1).max(256), code: z.string().trim().max(10) }), req.body);
    const u = await me(req);
    if (!(await verifyPassword(u.passwordHash, b.password))) throw new HttpError(400, 'bad_password', 'Пароль неверен');
    if (u.totpEnabled) {
      const step = verifyTotp(decryptSecret(u.totpSecretEnc!, config.APP_SECRET), u.login, b.code, u.totpLastStep);
      if (step === null) throw new HttpError(400, 'bad_code', 'Код не подошёл');
    }
    await db.update(schema.users).set({ totpEnabled: false, totpSecretEnc: null, totpPendingEnc: null, totpLastStep: null }).where(eq(schema.users.id, u.id));
    await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, u.id), ne(schema.sessions.id, req.session!.id)));
    await db.update(schema.sessions).set({ mfaOk: false }).where(eq(schema.sessions.id, req.session!.id));
    await audit(db, actorOf(req), 'account.totp_restarted', { type: 'user', id: u.id }, undefined, req.ip);
    return { status: 'totp_setup' };
  });

  // ───── сессии ─────
  app.get('/api/account/sessions', auth, async (req) => {
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, req.session!.user.id)).orderBy(schema.sessions.lastSeenAt);
    return {
      sessions: rows
        .filter((s) => s.expiresAt > new Date())
        .map((s) => ({ id: s.id, current: s.id === req.session!.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent }))
        .reverse(),
    };
  });

  app.delete('/api/account/sessions/:id', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string().length(64) }), req.params);
    if (id === req.session!.id) throw new HttpError(400, 'current_session', 'Это текущая сессия: выйдите кнопкой «Выйти».');
    const gone = await db.delete(schema.sessions).where(and(eq(schema.sessions.id, id), eq(schema.sessions.userId, req.session!.user.id))).returning({ id: schema.sessions.id });
    if (gone.length === 0) throw notFound('Сессия не найдена');
    await audit(db, actorOf(req), 'account.session_revoked', { type: 'user', id: req.session!.user.id }, undefined, req.ip);
    return { ok: true };
  });

  app.post('/api/account/sessions/revoke-others', auth, async (req) => {
    const gone = await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, req.session!.user.id), ne(schema.sessions.id, req.session!.id))).returning({ id: schema.sessions.id });
    await audit(db, actorOf(req), 'account.sessions_revoked', { type: 'user', id: req.session!.user.id }, { count: gone.length }, req.ip);
    return { revoked: gone.length };
  });

  void destroyUserSessions;
}
