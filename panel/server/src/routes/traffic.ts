import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { HttpError, parse, requireAuth } from '../lib/http.js';
import { daysBetween, MAX_RANGE_DAYS, trafficStats, trafficSummary, utcDate } from '../lib/traffic.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && utcDate(Date.parse(`${s}T00:00:00Z`)) === s, 'Такой даты нет');
const Query = z.object({
  from: date.optional(),
  to: date.optional(),
  by: z.enum(['node', 'route']).default('node'),
  top: z.coerce.number().int().min(1).max(50).default(10),
});

export function trafficRoutes(app: FastifyInstance, ctx: Ctx): void {
  const auth = { preHandler: requireAuth };

  /** Трафик сегодня, в этом календарном месяце и за всё время. */
  app.get('/api/traffic/summary', auth, async () => trafficSummary(ctx.db));

  /** Статистика потребления по дням: за период, с разбивкой по нодам или маршрутам. */
  app.get('/api/traffic/stats', auth, async (req) => {
    const q = parse(Query, req.query);
    const today = utcDate(Date.now());
    const to = q.to ?? today;
    const from = q.from ?? utcDate(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000);
    if (from > to) throw new HttpError(400, 'validation', 'Начало периода позже конца');
    if (daysBetween(from, to).length > MAX_RANGE_DAYS) throw new HttpError(400, 'validation', `Период не длиннее ${MAX_RANGE_DAYS} дней`);
    return trafficStats(ctx.db, { from, to, by: q.by, top: q.top });
  });
}
