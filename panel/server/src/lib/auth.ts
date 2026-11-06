import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { type DB, schema } from '../db/index.js';
import { randomToken, sha256Hex } from './crypto.js';

export const SESSION_COOKIE = 'popug_sid';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_TOUCH_MS = 10 * 60 * 1000;
export const MAX_FAILED = 10;
export const LOCK_MS = 15 * 60 * 1000;

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // профиль OWASP для argon2id

export const hashPassword = (pw: string): Promise<string> => hash(pw, ARGON);
export const verifyPassword = (hashed: string, pw: string): Promise<boolean> => verify(hashed, pw).catch(() => false);

// Для логинов несуществующих пользователей: время ответа не должно выдавать, что такого нет.
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(pw: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, pw);
}

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 12) return 'Пароль должен быть не короче 12 символов';
  if (pw.length > 256) return 'Пароль слишком длинный';
  return null;
}

// ───────── TOTP ─────────

export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totpFor(secretB32: string, login: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Popug Bridges',
    label: login,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretB32),
  });
}

export function totpUri(secretB32: string, login: string): string {
  return totpFor(secretB32, login).toString();
}

export const totpQrSvg = (uri: string): Promise<string> => QRCode.toString(uri, { type: 'svg', margin: 1 });

/** Номер принятого 30-секундного шага либо null. lastStep — защита от повторного использования кода. */
export function verifyTotp(secretB32: string, login: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totpFor(secretB32, login).validate({ token: code, window: 1, timestamp: now });
  if (delta === null) return null;
  const step = Math.floor(now / 30_000) + delta;
  if (lastStep !== null && step <= lastStep) return null;
  return step;
}

// ───────── сессии ─────────

export interface SessionUser {
  id: string;
  login: string;
  role: string;
  totpEnabled: boolean;
}

export interface SessionInfo {
  id: string; // sha256 токена
  mfaOk: boolean;
  user: SessionUser;
}

export async function createSession(
  db: DB,
  userId: string,
  mfaOk: boolean,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken('s');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    id: sha256Hex(token),
    userId,
    mfaOk,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

export async function loadSession(db: DB, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  const id = sha256Hex(token);
  const [row] = await db
    .select({
      id: schema.sessions.id,
      mfaOk: schema.sessions.mfaOk,
      lastSeenAt: schema.sessions.lastSeenAt,
      uid: schema.users.id,
      login: schema.users.login,
      role: schema.users.role,
      totpEnabled: schema.users.totpEnabled,
      disabled: schema.users.disabled,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.disabled) return null;
  if (Date.now() - row.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
    await db
      .update(schema.sessions)
      .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(schema.sessions.id, id));
  }
  return { id, mfaOk: row.mfaOk, user: { id: row.uid, login: row.login, role: row.role, totpEnabled: row.totpEnabled } };
}

export const destroySession = (db: DB, id: string) => db.delete(schema.sessions).where(eq(schema.sessions.id, id));
export const destroyUserSessions = (db: DB, userId: string) => db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
