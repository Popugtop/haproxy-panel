import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { alertSummary, evaluateAlerts, KIND_IDS, KINDS, loadRules } from '../lib/alerts.js';
import { actorOf, audit, diffOf } from '../lib/audit.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';
import { loadTelegram } from '../lib/settings.js';

const view = (a: typeof schema.alerts.$inferSelect) => ({
  id: a.id,
  kind: a.kind,
  title: KINDS[a.kind]?.title ?? a.kind,
  subject: a.subject,
  label: a.subjectLabel,
  severity: a.severity,
  status: a.status,
  message: a.message,
  value: a.value,
  firedAt: a.firedAt,
  resolvedAt: a.resolvedAt,
  lastNotifiedAt: a.lastNotifiedAt,
  notifyCount: a.notifyCount,
  notifyError: a.lastNotifyError,
});

const RuleBody = z.object({
  enabled: z.boolean(),
  threshold: z.number().nullable(),
  threshold2: z.number().nullable(),
  forMin: z.number().int().min(0).max(1440),
  repeatHours: z.number().int().min(0).max(168),
});

export function alertRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const auth = { preHandler: requireAuth };

  app.get('/api/alerts/summary', auth, async () => alertSummary(db));

  /** Горящие сейчас; а также настроен ли Telegram (без него алерты видны только в панели). */
  app.get('/api/alerts', auth, async () => {
    const tg = await loadTelegram(db);
    const rows = await db.select().from(schema.alerts).where(eq(schema.alerts.status, 'firing')).orderBy(desc(schema.alerts.firedAt));
    const pending = await db.$count(schema.alerts, eq(schema.alerts.status, 'pending'));
    return {
      active: rows.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'crit' ? -1 : 1)).map(view),
      pending,
      telegram: { configured: !!tg.tokenEnc && !!tg.chatId, enabled: tg.enabled },
    };
  });

  const Hist = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional(), kind: z.enum(KIND_IDS as [string, ...string[]]).optional() });
  /** История: закрытые инциденты и ещё горящие. Не сработавшие (ожидание) не показываем. */
  app.get('/api/alerts/history', auth, async (req) => {
    const q = parse(Hist, req.query);
    const rows = await db
      .select()
      .from(schema.alerts)
      .where(and(ne(schema.alerts.status, 'pending'), q.kind ? eq(schema.alerts.kind, q.kind) : undefined, q.before ? lt(schema.alerts.firedAt, new Date(q.before)) : undefined))
      .orderBy(desc(schema.alerts.firedAt))
      .limit(q.limit);
    return { alerts: rows.map(view) };
  });

  app.get('/api/alerts/rules', auth, async () => {
    const rules = await loadRules(db);
    return {
      rules: KIND_IDS.map((kind) => {
        const d = KINDS[kind]!;
        const r = rules.get(kind)!;
        return { kind, title: d.title, description: d.description, event: d.event, unit: d.unit, hasThreshold2: d.hasThreshold2, enabled: r.enabled, threshold: r.threshold, threshold2: r.threshold2, forMin: r.forMin, repeatHours: r.repeatHours, defaults: d.defaults };
      }),
    };
  });

  app.put('/api/alerts/rules/:kind', auth, async (req) => {
    const { kind } = parse(z.object({ kind: z.string() }), req.params);
    const def = KINDS[kind];
    if (!def) throw notFound('Такого правила нет');
    const b = parse(RuleBody, req.body);
    if (def.unit === null && (b.threshold !== null || b.threshold2 !== null)) throw new HttpError(400, 'validation', 'У этого правила нет порога');
    if (def.unit !== null) {
      if (b.threshold === null) throw new HttpError(400, 'validation', 'Укажите порог');
      const max = def.unit === '%' ? 100 : 100_000;
      if (b.threshold <= 0 || b.threshold > max) throw new HttpError(400, 'validation', `Порог: больше 0 и не больше ${max} ${def.unit}`);
      if (def.hasThreshold2) {
        if (b.threshold2 === null || b.threshold2 <= b.threshold || b.threshold2 > max) throw new HttpError(400, 'validation', `Порог аварии должен быть больше порога предупреждения и не больше ${max} ${def.unit}`);
      } else if (b.threshold2 !== null) throw new HttpError(400, 'validation', 'У этого правила один порог');
    }
    if (def.event && b.forMin !== 0) throw new HttpError(400, 'validation', 'Это событие срабатывает сразу: задержки нет');
    const before = (await loadRules(db)).get(kind)!;
    await db.update(schema.alertRules).set({ ...b, updatedAt: new Date() }).where(eq(schema.alertRules.kind, kind));
    await audit(db, actorOf(req), 'alert.rule_update', { type: 'alert_rule', id: kind }, diffOf({ enabled: before.enabled, threshold: before.threshold, threshold2: before.threshold2, forMin: before.forMin, repeatHours: before.repeatHours }, b), req.ip);
    return { ok: true };
  });

  /** Применить значения по умолчанию к одному правилу. */
  app.post('/api/alerts/rules/:kind/reset', auth, async (req) => {
    const { kind } = parse(z.object({ kind: z.string() }), req.params);
    const def = KINDS[kind];
    if (!def) throw notFound('Такого правила нет');
    await loadRules(db);
    await db.update(schema.alertRules).set({ ...def.defaults, updatedAt: new Date() }).where(eq(schema.alertRules.kind, kind));
    await audit(db, actorOf(req), 'alert.rule_reset', { type: 'alert_rule', id: kind }, undefined, req.ip);
    return { ok: true };
  });

  /** Проверить условия прямо сейчас, не дожидаясь цикла. */
  app.post('/api/alerts/evaluate', { ...auth, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async () => evaluateAlerts(ctx));
}

export { inArray };
