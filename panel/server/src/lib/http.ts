import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Не найдено') => new HttpError(404, 'not_found', what);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'запрос'}: ${i.message}`).join('; ');
    throw new HttpError(400, 'validation', msg);
  }
  return r.data;
}

export function requireAuth(req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void): void {
  if (!req.session?.mfaOk) return done(new HttpError(401, 'unauthorized', 'Требуется вход'));
  done();
}

export const ipOf = (req: FastifyRequest): string => req.ip;
