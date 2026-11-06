import { Button, Dialog, Select, Text, TextInput } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { EmptyHint, Notice } from '../components/ui';
import { api, type AuditEntry } from '../lib/api';
import { ago, dateTime } from '../lib/format';
import { useNow } from '../lib/useNow';

const LABELS: Record<string, string> = {
  'auth.login': 'Вход', 'auth.login_failed': 'Неудачный вход', 'auth.logout': 'Выход', 'auth.password_changed': 'Смена пароля', 'auth.totp_enabled': 'Включён TOTP',
  'account.login_changed': 'Смена логина', 'account.totp_restarted': 'Перенастройка TOTP', 'account.session_revoked': 'Сессия завершена', 'account.sessions_revoked': 'Сессии завершены',
  'user.create': 'Создан пользователь', 'user.reset_password': 'Сброс пароля', 'user.reset_totp': 'Сброс TOTP',
  'node.create': 'Нода создана', 'node.update': 'Нода изменена', 'node.delete': 'Нода удалена', 'node.enrolled': 'Агент подключён', 'node.enrollment_token': 'Выдан токен установки', 'node.revoke_key': 'Ключ ноды отозван',
  'agent.update': 'Обновление агента',
  'exit.create': 'Выход создан', 'exit.update': 'Выход изменён', 'exit.delete': 'Выход удалён',
  'route.create': 'Маршрут создан', 'route.update': 'Маршрут изменён', 'route.delete': 'Маршрут удалён',
  'config.apply': 'Применён конфиг', 'config.import': 'Импорт конфига', 'config.import_skipped': 'Импорт пропущен',
  'ban.create': 'Бан', 'ban.remove': 'Разбан', 'limit.set': 'Лимит скорости', 'limit.remove': 'Лимит снят',
  'torrent.ban': 'Бан за торрент', 'torrent.poll': 'Опрос Remnawave вручную',
  'alert.rule_update': 'Правило алерта изменено', 'alert.rule_reset': 'Правило алерта сброшено',
  'settings.branding': 'Оформление', 'settings.remnawave': 'Настройки Remnawave', 'settings.telegram': 'Настройки Telegram', 'settings.telegram_test': 'Тест Telegram',
};

const GROUPS = [
  { value: '', content: 'Все действия' }, { value: 'auth', content: 'Вход и выход' }, { value: 'account', content: 'Аккаунт' }, { value: 'node', content: 'Ноды' },
  { value: 'route', content: 'Маршруты' }, { value: 'exit', content: 'Выходы' }, { value: 'config', content: 'Конфиги' }, { value: 'ban', content: 'Баны' },
  { value: 'limit', content: 'Лимиты' }, { value: 'torrent', content: 'Торрент-блокер' }, { value: 'alert', content: 'Алерты' }, { value: 'settings', content: 'Настройки' }, { value: 'agent', content: 'Агенты' },
];
const PERIODS = [{ value: '', content: 'За всё время' }, { value: '1', content: 'За сутки' }, { value: '7', content: 'За неделю' }, { value: '30', content: 'За 30 дней' }];

const short = (v: unknown): string => (typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 38)}…` : v) : Array.isArray(v) ? v.map(short).join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v));
/** Краткое описание изменений для таблицы: «snis: a → b» либо «ключ: значение». */
function summary(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d)
    .slice(0, 4)
    .map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && 'to' in (v as object) ? `${k}: ${short((v as { from: unknown }).from ?? '∅')} → ${short((v as { to: unknown }).to ?? '∅')}` : `${k}: ${short(v)}`))
    .join(' · ');
}

export function AuditPage() {
  const now = useNow(30_000);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [actor, setActor] = useState('');
  const [group, setGroup] = useState('');
  const [period, setPeriod] = useState('');
  const [view, setView] = useState<AuditEntry | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const facets = useQuery({ queryKey: ['audit-facets'], queryFn: () => api.get<{ actors: string[]; actions: string[] }>('/api/audit/facets'), staleTime: 60_000 });
  const list = useInfiniteQuery({
    queryKey: ['audit', debounced, actor, group, period],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (pageParam) p.set('before', String(pageParam));
      if (debounced) p.set('q', debounced);
      if (actor) p.set('actor', actor);
      if (group) p.set('action', group);
      if (period) p.set('from', new Date(Date.now() - Number(period) * 86400e3).toISOString());
      return api.get<{ entries: AuditEntry[]; next: number | null }>(`/api/audit?${p}`);
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.entries) ?? [];

  const columns: TableColumnConfig<AuditEntry>[] = [
    { id: 'at', width: 150, name: 'Когда', template: (e) => <span title={dateTime(e.at)}>{ago(e.at, now)}</span> },
    { id: 'actor', width: 150, name: 'Кто', template: (e) => e.actor },
    { id: 'action', width: 250, name: 'Действие', template: (e) => <div><div>{LABELS[e.action] ?? e.action}</div><div className="mono secondary" style={{ fontSize: 12 }}>{e.action}</div></div> },
    { id: 'entity', width: 200, name: 'Объект', template: (e) => (e.entityType ? <span className="mono" title={e.entityId ?? ''}>{e.entityType}{e.entityId ? ` · ${e.entityId.length > 14 ? e.entityId.slice(0, 8) + '…' : e.entityId}` : ''}</span> : '—') },
    { id: 'diff', name: 'Что изменилось', template: (e) => <span className="secondary">{summary(e.diff)}</span> },
    { id: 'ip', width: 150, name: 'IP', template: (e) => <span className="mono">{e.ip ?? '—'}</span> },
    { id: 'more', width: 110, align: 'end', name: '', template: (e) => (e.diff && Object.keys(e.diff).length ? <Button view="flat" size="s" onClick={() => setView(e)}>Подробнее</Button> : null) },
  ];

  return (
    <div className="page">
      <div className="page-head"><Text variant="header-2" as="h1">Аудит</Text></div>
      <div className="stack">
        <Text color="secondary">Все изменения в панели: кто, что и когда сделал, и с какого IP. Секреты (токены, пароли) в журнал не попадают.</Text>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 260 }}><TextInput value={q} onUpdate={setQ} placeholder="Поиск по действию, объекту, содержимому" hasClear /></div>
          <Select value={[group]} onUpdate={(v) => setGroup(v[0] ?? '')} options={GROUPS} width={200} />
          <Select value={[actor]} onUpdate={(v) => setActor(v[0] ?? '')} options={[{ value: '', content: 'Все авторы' }, ...(facets.data?.actors ?? []).map((a) => ({ value: a, content: a }))]} width={200} />
          <Select value={[period]} onUpdate={(v) => setPeriod(v[0] ?? '')} options={PERIODS} width={180} />
        </div>
        {list.isError && <Notice theme="danger">{(list.error as Error).message}</Notice>}
        <div className="tbl">
          <Table columns={columns} data={rows} getRowId={(e) => String(e.id)} verticalAlign="middle" width="max" />
          {list.isPending && <EmptyHint title="Загружаю…" />}
          {!list.isPending && rows.length === 0 && <EmptyHint title="Записей нет.">Измените фильтры или дождитесь первых действий.</EmptyHint>}
        </div>
        {list.hasNextPage && <div><Button view="outlined" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Показать ещё</Button></div>}
      </div>
      {view && (
        <Dialog open onOpenChange={(o) => !o && setView(null)} maxWidth="m" fullWidth aria-labelledby="audit-title">
          <Dialog.Header caption={LABELS[view.action] ?? view.action} id="audit-title" />
          <Dialog.Body>
            <Text color="secondary" as="div" style={{ marginBottom: 8 }}>{view.actor} · {dateTime(view.at)}{view.ip ? ` · ${view.ip}` : ''}</Text>
            <pre className="mono" style={{ margin: 0, padding: 12, borderRadius: 8, background: 'var(--g-color-base-generic)', overflow: 'auto', maxHeight: 420, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(view.diff, null, 2)}</pre>
          </Dialog.Body>
          <Dialog.Footer onClickButtonApply={() => setView(null)} textButtonApply="Закрыть" />
        </Dialog>
      )}
    </div>
  );
}
