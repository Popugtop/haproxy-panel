import { ago } from './format';
import type { LiveBackend, NodeSummary } from './api';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/** Итоговое состояние ноды для таблиц: статус агента + здоровье HAProxy. */
export function nodeState(n: NodeSummary): { tone: Tone; label: string; detail?: string } {
  switch (n.status) {
    case 'pending':
      return { tone: 'idle', label: 'Ждёт агента', detail: n.enrollPending ? 'токен выдан' : 'токен истёк' };
    case 'revoked':
      return { tone: 'bad', label: 'Ключ отозван' };
    case 'offline':
      return { tone: 'bad', label: 'Офлайн', detail: n.lastSeenAt ? `на связи ${ago(n.lastSeenAt)}` : undefined };
  }
  if (!n.live) return { tone: 'warn', label: 'Нет метрик', detail: 'агент подключён, но снимки не приходят' };
  if (!n.live.haproxyOk) return { tone: 'warn', label: 'HAProxy не отвечает', detail: n.live.haproxyError ?? undefined };
  if (n.live.backendsDown > 0) return { tone: 'warn', label: 'Онлайн', detail: `бэкендов не работает: ${n.live.backendsDown}` };
  return { tone: 'ok', label: 'Онлайн' };
}

export function backendTone(b: LiveBackend): Tone {
  if (b.status === 'UP' || b.status === 'OPEN') {
    return b.servers.some((s) => s.status === 'DOWN') ? 'warn' : 'ok';
  }
  return 'bad';
}

/** Статус маршрута для StatusDot. */
export const routeTone = (t: 'ok' | 'warn' | 'bad' | 'unknown'): Tone => (t === 'unknown' ? 'idle' : t);
export const ROUTE_LABEL: Record<'ok' | 'warn' | 'bad' | 'unknown', string> = { ok: 'Работает', warn: 'Есть проблемы', bad: 'Не работает', unknown: 'Нет данных' };
