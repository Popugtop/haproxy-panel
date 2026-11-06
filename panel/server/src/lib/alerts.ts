/**
 * Алерты. Каждое правило описывает условие; движок раз в 30 секунд сравнивает его с текущим состоянием и ведёт инциденты:
 *   условие появилось → «ожидание» (pending) → продержалось нужное время → «сработал» (firing, уведомление)
 *   → напоминания раз в N часов → условие исчезло → «починилось» (resolved, уведомление).
 * На один объект одного вида открыт один инцидент, поэтому дубликатов нет. Если Telegram недоступен, уведомление повторяется на следующем цикле.
 */
import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../app.js';
import { type DB, schema } from '../db/index.js';
import { pairStatuses } from './checks.js';
import { nodeSummaries } from './nodes.js';
import { loadTelegram } from './settings.js';
import { escapeHtml, sendTelegram } from './telegram.js';

export type Severity = 'warn' | 'crit';

export interface KindDef {
  title: string;
  description: string;
  /** Событийный: открывается и закрывается из кода (применение конфига), а не проверкой условия. */
  event: boolean;
  /** Единица порога или null, если порога нет. */
  unit: '%' | 'Мбит/с' | null;
  /** Есть второй порог (авария). */
  hasThreshold2: boolean;
  defaults: { enabled: boolean; threshold: number | null; threshold2: number | null; forMin: number; repeatHours: number };
}

export const KINDS: Record<string, KindDef> = {
  node_offline: {
    title: 'Нода не на связи',
    description: 'Агент ноды не подключён к панели дольше заданного времени.',
    event: false,
    unit: null,
    hasThreshold2: false,
    defaults: { enabled: true, threshold: null, threshold2: null, forMin: 2, repeatHours: 6 },
  },
  config_failed: {
    title: 'Конфиг не применился',
    description: 'Применение конфига на ноде не удалось или было откачено. Закрывается следующим успешным применением.',
    event: true,
    unit: null,
    hasThreshold2: false,
    defaults: { enabled: true, threshold: null, threshold2: null, forMin: 0, repeatHours: 0 },
  },
  route_red: {
    title: 'Маршрут не работает',
    description: 'Проверки пары «маршрут × нода» красные: мост не доходит до выхода или недоступен снаружи.',
    event: false,
    unit: null,
    hasThreshold2: false,
    defaults: { enabled: true, threshold: null, threshold2: null, forMin: 2, repeatHours: 6 },
  },
  quota: {
    title: 'Квота хостера',
    description: 'Израсходована заданная доля квоты трафика ноды за расчётный период. Первый порог — предупреждение, второй — авария.',
    event: false,
    unit: '%',
    hasThreshold2: true,
    defaults: { enabled: true, threshold: 80, threshold2: 95, forMin: 0, repeatHours: 24 },
  },
  ip_speed: {
    title: 'IP забирает много скорости',
    description: 'Один клиентский IP качает быстрее порога дольше заданного времени.',
    event: false,
    unit: 'Мбит/с',
    hasThreshold2: false,
    defaults: { enabled: true, threshold: 200, threshold2: null, forMin: 10, repeatHours: 6 },
  },
  cpu: {
    title: 'Высокая загрузка CPU',
    description: 'Загрузка процессора ноды выше порога дольше заданного времени.',
    event: false,
    unit: '%',
    hasThreshold2: false,
    defaults: { enabled: true, threshold: 85, threshold2: null, forMin: 15, repeatHours: 6 },
  },
};
export const KIND_IDS = Object.keys(KINDS);

/** Строки правил создаются при запуске панели; уже сохранённые настройки не трогаем. */
export async function ensureAlertRules(db: DB): Promise<void> {
  await db
    .insert(schema.alertRules)
    .values(KIND_IDS.map((kind) => ({ kind, ...KINDS[kind]!.defaults })))
    .onConflictDoNothing();
}

export async function loadRules(db: DB) {
  await ensureAlertRules(db);
  const rows = await db.select().from(schema.alertRules);
  return new Map(rows.map((r) => [r.kind, r]));
}

type Rule = typeof schema.alertRules.$inferSelect;
type AlertRow = typeof schema.alerts.$inferSelect;

interface Cond {
  kind: string;
  subject: string;
  label: string;
  severity: Severity;
  message: string;
  value: number | null;
}

// ───────── текст ─────────

export function humanDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} ч ${m} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

type Phase = 'fire' | 'repeat' | 'escalate' | 'resolve';

function textFor(ctx: Ctx, a: Pick<AlertRow, 'kind' | 'subjectLabel' | 'message' | 'severity' | 'firedAt' | 'pendingSince'>, phase: Phase, now: Date): string {
  const title = KINDS[a.kind]?.title ?? a.kind;
  const head = phase === 'resolve' ? `✅ <b>Починилось: ${escapeHtml(title)}</b>` : phase === 'repeat' ? `⏰ <b>Всё ещё: ${escapeHtml(title)}</b>` : phase === 'escalate' ? `🔴 <b>Стало хуже: ${escapeHtml(title)}</b>` : `${a.severity === 'crit' ? '🔴' : '🟠'} <b>${escapeHtml(title)}</b>`;
  const since = a.firedAt ?? a.pendingSince;
  const tail = phase === 'resolve' ? `Проблема длилась ${humanDuration(now.getTime() - since.getTime())}.` : phase === 'repeat' ? `Длится уже ${humanDuration(now.getTime() - since.getTime())}.` : '';
  return [head, escapeHtml(a.subjectLabel), a.message && phase !== 'resolve' ? escapeHtml(a.message) : '', tail, `${ctx.config.publicUrl}/alerts`].filter(Boolean).join('\n');
}

/** Отправка уведомления. Возвращает true, если сообщение ушло (или отправлять некуда и повторять незачем). */
async function notify(ctx: Ctx, a: AlertRow, phase: Phase, now: Date): Promise<void> {
  const tg = await loadTelegram(ctx.db);
  if (!tg.enabled || !tg.tokenEnc || !tg.chatId) return; // Telegram не настроен: инцидент виден в панели, уведомление уйдёт после настройки
  const r = await sendTelegram(tg, ctx.config.APP_SECRET, textFor(ctx, a, phase, now), ctx.http);
  await ctx.db
    .update(schema.alerts)
    .set(r.ok ? { lastNotifiedAt: now, notifyCount: sql`${schema.alerts.notifyCount} + 1`, lastNotifyError: null } : { lastNotifyError: r.error })
    .where(eq(schema.alerts.id, a.id));
}

// ───────── условия ─────────

async function currentConditions(ctx: Ctx, rules: Map<string, Rule>, now: Date): Promise<Cond[]> {
  const { db, registry } = ctx;
  const on = (k: string) => rules.get(k)?.enabled === true;
  const out: Cond[] = [];
  const nodes = await nodeSummaries(db, registry, now);
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

  if (on('node_offline')) {
    for (const n of nodes) {
      if (n.status !== 'offline') continue; // «ожидает подключения» и «отозван» — не авария
      out.push({ kind: 'node_offline', subject: n.id, label: n.name, severity: 'crit', message: n.lastSeenAt ? `Последние данные: ${new Date(n.lastSeenAt).toLocaleString('ru-RU')}` : 'Агент не подключается', value: null });
    }
  }
  const cpu = rules.get('cpu');
  if (cpu?.enabled && cpu.threshold != null) {
    for (const n of nodes) if (n.status === 'online' && n.live?.cpuPct != null && n.live.cpuPct >= cpu.threshold) out.push({ kind: 'cpu', subject: n.id, label: n.name, severity: 'warn', message: `CPU ${n.live.cpuPct.toFixed(0)}% при пороге ${cpu.threshold}%`, value: n.live.cpuPct });
  }
  const q = rules.get('quota');
  if (q?.enabled && q.threshold != null) {
    for (const n of nodes) {
      const pct = n.quota.pct;
      if (pct == null || pct < q.threshold) continue;
      const crit = q.threshold2 != null && pct >= q.threshold2;
      out.push({ kind: 'quota', subject: n.id, label: n.name, severity: crit ? 'crit' : 'warn', message: `Использовано ${pct.toFixed(0)}% квоты за период ${n.quota.periodStart} — ${n.quota.periodEnd}`, value: pct });
    }
  }
  const sp = rules.get('ip_speed');
  if (sp?.enabled && sp.threshold != null) {
    const lives = await db.select({ nodeId: schema.nodeLive.nodeId, data: schema.nodeLive.data }).from(schema.nodeLive);
    for (const l of lives) {
      const n = nodes.find((x) => x.id === l.nodeId);
      if (!n || n.status !== 'online') continue;
      for (const c of l.data.clients?.top ?? []) {
        const mbit = (Math.max(c.rateIn, c.rateOut) * 8) / 1e6;
        if (mbit >= sp.threshold) out.push({ kind: 'ip_speed', subject: `${n.id}|${c.ip}`, label: `${c.ip} · ${n.name}`, severity: 'warn', message: `${mbit.toFixed(0)} Мбит/с при пороге ${sp.threshold} Мбит/с`, value: mbit });
      }
    }
  }
  if (on('route_red')) {
    const routes = new Map((await db.select({ id: schema.routes.id, name: schema.routes.name, enabled: schema.routes.enabled }).from(schema.routes)).map((r) => [r.id, r]));
    for (const p of await pairStatuses(db, {}, now)) {
      const r = routes.get(p.routeId);
      if (p.tone !== 'bad' || !r?.enabled) continue;
      out.push({ kind: 'route_red', subject: `${p.routeId}|${p.nodeId}`, label: `${r.name} · ${nodeName.get(p.nodeId) ?? '—'}`, severity: 'crit', message: p.reason, value: null });
    }
  }
  return out;
}

// ───────── движок ─────────

const key = (kind: string, subject: string) => `${kind}\u0000${subject}`;

export interface EvalResult {
  fired: number;
  resolved: number;
  pending: number;
}

export async function evaluateAlerts(ctx: Ctx, now = new Date()): Promise<EvalResult> {
  const { db } = ctx;
  const rules = await loadRules(db);
  const conds = await currentConditions(ctx, rules, now);
  let open = await db.select().from(schema.alerts).where(ne(schema.alerts.status, 'resolved'));
  // Нода удалена (или демо-данные убраны): инциденты о ней закрывать некому, убираем без уведомлений.
  const nodeIds = new Set((await db.select({ id: schema.nodes.id }).from(schema.nodes)).map((n) => n.id));
  const nodeOf = (a: { kind: string; subject: string }) => a.subject.split('|')[a.kind === 'route_red' ? 1 : 0]!;
  const orphans = open.filter((a) => !nodeIds.has(nodeOf(a)));
  if (orphans.length) await db.delete(schema.alerts).where(inArray(schema.alerts.id, orphans.map((o) => o.id)));
  open = open.filter((a) => nodeIds.has(nodeOf(a)));
  const openBy = new Map(open.map((a) => [key(a.kind, a.subject), a]));
  const res: EvalResult = { fired: 0, resolved: 0, pending: 0 };
  const present = new Set<string>();

  for (const c of conds) {
    const rule = rules.get(c.kind)!;
    const k = key(c.kind, c.subject);
    present.add(k);
    let a = openBy.get(k);
    if (!a) {
      const [ins] = await db
        .insert(schema.alerts)
        .values({ kind: c.kind, subject: c.subject, subjectLabel: c.label, severity: c.severity, message: c.message, value: c.value, pendingSince: now, status: 'pending' })
        .onConflictDoNothing()
        .returning();
      if (!ins) continue;
      a = ins;
    }
    const escalated = a.status === 'firing' && a.severity === 'warn' && c.severity === 'crit';
    const [cur] = await db.update(schema.alerts).set({ subjectLabel: c.label, severity: c.severity, message: c.message, value: c.value }).where(eq(schema.alerts.id, a.id)).returning();
    a = cur!;
    if (a.status === 'pending') {
      if (now.getTime() - a.pendingSince.getTime() >= rule.forMin * 60_000) {
        const [f] = await db.update(schema.alerts).set({ status: 'firing', firedAt: now }).where(eq(schema.alerts.id, a.id)).returning();
        res.fired++;
        await notify(ctx, f!, 'fire', now);
      } else res.pending++;
    } else if (escalated) {
      await notify(ctx, a, 'escalate', now);
    }
  }

  for (const a of open) {
    if (present.has(key(a.kind, a.subject))) continue;
    const def = KINDS[a.kind];
    if (def?.event && rules.get(a.kind)?.enabled) continue; // событийные закрываются из кода
    if (a.status === 'pending') {
      await db.delete(schema.alerts).where(eq(schema.alerts.id, a.id)); // не успел сработать: в истории ему делать нечего
      continue;
    }
    const [r] = await db.update(schema.alerts).set({ status: 'resolved', resolvedAt: now }).where(eq(schema.alerts.id, a.id)).returning();
    res.resolved++;
    // Правило выключили, пока алерт горел: закрываем молча.
    if (rules.get(a.kind)?.enabled) await notify(ctx, r!, 'resolve', now);
  }

  await remind(ctx, rules, now);
  return res;
}

/** Первое уведомление, не ушедшее из-за ошибки (или отправленное до настройки Telegram), и напоминания раз в N часов. */
async function remind(ctx: Ctx, rules: Map<string, Rule>, now: Date): Promise<void> {
  const firing = await ctx.db.select().from(schema.alerts).where(eq(schema.alerts.status, 'firing'));
  for (const a of firing) {
    if (!a.lastNotifiedAt) {
      await notify(ctx, a, 'fire', now);
      continue;
    }
    const every = (rules.get(a.kind)?.repeatHours ?? 0) * 3_600_000;
    if (every > 0 && now.getTime() - a.lastNotifiedAt.getTime() >= every) await notify(ctx, a, 'repeat', now);
  }
}

// ───────── событийные алерты ─────────

export async function raiseAlert(ctx: Ctx, a: { kind: string; subject: string; label: string; severity?: Severity; message: string }, now = new Date()): Promise<void> {
  const { db } = ctx;
  const rule = (await loadRules(db)).get(a.kind);
  if (!rule?.enabled) return;
  const [open] = await db.select().from(schema.alerts).where(and(eq(schema.alerts.kind, a.kind), eq(schema.alerts.subject, a.subject), ne(schema.alerts.status, 'resolved')));
  if (open) {
    await db.update(schema.alerts).set({ message: a.message, subjectLabel: a.label }).where(eq(schema.alerts.id, open.id));
    return; // уже горит: повторное сообщение придёт как напоминание
  }
  const [row] = await db
    .insert(schema.alerts)
    .values({ kind: a.kind, subject: a.subject, subjectLabel: a.label, severity: a.severity ?? 'crit', message: a.message, status: 'firing', pendingSince: now, firedAt: now })
    .returning();
  await notify(ctx, row!, 'fire', now);
}

export async function clearAlert(ctx: Ctx, kind: string, subject: string, now = new Date()): Promise<void> {
  const [open] = await ctx.db.select().from(schema.alerts).where(and(eq(schema.alerts.kind, kind), eq(schema.alerts.subject, subject), ne(schema.alerts.status, 'resolved')));
  if (!open) return;
  const [r] = await ctx.db.update(schema.alerts).set({ status: 'resolved', resolvedAt: now }).where(eq(schema.alerts.id, open.id)).returning();
  if (open.status === 'firing') await notify(ctx, r!, 'resolve', now);
}

// ───────── запуск и обслуживание ─────────

/** После старта панели ждём минуту: агенты должны успеть переподключиться, иначе все ноды на секунду «offline». */
export function startAlertEngine(ctx: Ctx, log: { error: (o: unknown, m: string) => void }, opts: { graceMs?: number; intervalMs?: number } = {}): () => void {
  const interval = opts.intervalMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      await evaluateAlerts(ctx);
    } catch (e) {
      log.error({ err: (e as Error).message }, 'движок алертов: цикл не удался');
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };
  timer = setTimeout(() => void tick(), opts.graceMs ?? 60_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Закрытые инциденты храним полгода. */
export async function purgeAlerts(db: DB, nowMs = Date.now()): Promise<void> {
  await db.delete(schema.alerts).where(and(eq(schema.alerts.status, 'resolved'), lt(schema.alerts.resolvedAt, new Date(nowMs - 180 * 86400e3))));
}

export async function alertSummary(db: DB) {
  const rows = await db.select({ severity: schema.alerts.severity, n: sql<number>`count(*)::int` }).from(schema.alerts).where(eq(schema.alerts.status, 'firing')).groupBy(schema.alerts.severity);
  const by = Object.fromEntries(rows.map((r) => [r.severity, r.n]));
  return { firing: (by.warn ?? 0) + (by.crit ?? 0), crit: by.crit ?? 0, warn: by.warn ?? 0 };
}

export { desc, inArray };
