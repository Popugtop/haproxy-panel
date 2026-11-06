import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Случайный токен с префиксом: 32 байта энтропии, base64url. */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function key(appSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'popug-bridges', 'secrets-at-rest-v1', 32));
}

/** AES-256-GCM. Формат: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plain: string, appSecret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(appSecret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, appSecret: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('неизвестный формат зашифрованного значения');
  const d = createDecipheriv('aes-256-gcm', key(appSecret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
