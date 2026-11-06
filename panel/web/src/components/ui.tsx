import { Alert, Card, HelpMark, Link as GLink, Progress, Text } from '@gravity-ui/uikit';
import { useNavigate } from 'react-router-dom';
import { type ReactNode } from 'react';
import type { NodeStatus, QuotaUsage } from '../lib/api';
import { bytes, pct } from '../lib/format';
import type { Tone } from '../lib/state';

/** Статус: точка + слово. Цветом выделена только точка. */
export function StatusDot({ tone, children, detail }: { tone: Tone; children: ReactNode; detail?: ReactNode }) {
  return (
    <div>
      <span className={`status ${tone}`}>
        <i className="dot" />
        <span>{children}</span>
      </span>
      {detail && <div className="status-detail">{detail}</div>}
    </div>
  );
}

export function nodeStatusLabel(status: NodeStatus, stale?: boolean): { tone: Tone; label: string } {
  switch (status) {
    case 'online': return stale ? { tone: 'warn', label: 'Нет метрик' } : { tone: 'ok', label: 'Онлайн' };
    case 'offline': return { tone: 'bad', label: 'Офлайн' };
    case 'pending': return { tone: 'idle', label: 'Ждёт агента' };
    case 'revoked': return { tone: 'bad', label: 'Ключ отозван' };
  }
}

/** Заголовок колонки/раздела с подсказкой: иконка ⓘ рядом, без пунктира. */
export function Hint({ label, tip }: { label: ReactNode; tip?: ReactNode }) {
  return (
    <span className="head-hint">
      {label}
      {tip && <HelpMark>{tip}</HelpMark>}
    </span>
  );
}

export function Field({ label, help, children, wide }: { label: string; help?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'wide' : undefined} style={{ display: 'grid', gap: 6 }}>
      <Text variant="subheader-1">{label}</Text>
      {children}
      {help && <Text variant="body-1" color="secondary">{help}</Text>}
    </div>
  );
}

/** Пустое состояние под заголовками таблицы: маленький попугай и одна строка. */
export function EmptyHint({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-hint">
      <Text variant="body-2"><b style={{ color: 'var(--g-color-text-primary)' }}>{title}</b>{children ? <> {children}</> : null}</Text>
      {action}
    </div>
  );
}

/** Полоса квоты: Progress из Gravity; чёрточка — какая доля расчётного периода уже прошла. */
export function QuotaBar({ q }: { q: QuotaUsage }) {
  if (q.limitBytes === null) return <Text color="secondary">квота не задана</Text>;
  const used = Math.min(100, q.pct ?? 0);
  const start = new Date(q.periodStart + 'T00:00:00Z').getTime();
  const end = new Date(q.periodEnd + 'T00:00:00Z').getTime();
  const elapsed = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
  const theme = used >= 95 ? 'danger' : used >= 80 ? 'warning' : 'default';
  const u = bytes(q.usedBytes);
  const l = bytes(q.limitBytes);
  return (
    <div className="quota" title={`Израсходовано ${pct(q.pct, 1)} квоты (${q.counts === 'tx' ? 'исходящий' : 'входящий + исходящий'} трафик). Чёрточка — ${pct(elapsed)} периода с ${q.periodStart}.`}>
      <div className="quota-bar">
        <Progress value={used} theme={theme} size="xs" />
        <div className="quota-pace" style={{ left: `calc(${elapsed}% - 1px)` }} />
      </div>
      <div className="quota-meta">
        <span>{u.value} {u.unit}</span>
        <span>{pct(q.pct)} из {l.value} {l.unit}</span>
      </div>
    </div>
  );
}

export function Notice({ theme, title, children }: { theme: 'info' | 'warning' | 'danger' | 'success'; title?: string; children: ReactNode }) {
  return <Alert theme={theme} view="outlined" title={title} message={children} />;
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <Card type="container" view="outlined" className={className}>{children}</Card>;
}

/** Ссылка Gravity с клиентской навигацией (без перезагрузки страницы). */
export function RouterLink({ to, children }: { to: string; children: ReactNode }) {
  const nav = useNavigate();
  return (
    <GLink
      view="normal"
      href={to}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey) return; // новая вкладка — как обычно
        e.preventDefault();
        nav(to);
      }}
    >
      {children}
    </GLink>
  );
}
