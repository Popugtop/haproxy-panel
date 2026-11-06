import { Ellipsis, Plus } from '@gravity-ui/icons';
import { Button, Checkbox, Icon, Label, Select, Tab, TabList, TabProvider, Text, TextInput } from '@gravity-ui/uikit';
import { DropdownMenu, Table, type DropdownMenuItem, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BanDialog, LimitDialog, useRefreshClients } from '../components/ClientActions';
import { EmptyHint, Hint, Notice, StatusDot } from '../components/ui';
import { api, ApiError, type BanRow, type LimitRow, type LiveClient } from '../lib/api';
import { ago, bytes, dateTime, int, mbit, remaining } from '../lib/format';
import { useBans, useClients, useLimits, useNodes } from '../lib/queries';
import { useNow } from '../lib/useNow';

const TABS = [
  { value: 'live', title: 'Сессии' },
  { value: 'bans', title: 'Баны' },
  { value: 'limits', title: 'Лимиты скорости' },
] as const;

export function ClientsPage() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const tab = pathname.split('/')[2] ?? 'live';
  const bans = useBans();
  const limits = useLimits();
  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Клиенты</Text>
      </div>
      <TabProvider value={tab} onUpdate={(v) => nav(v === 'live' ? '/clients' : `/clients/${v}`)}>
        <TabList style={{ marginBottom: 20 }}>
          <Tab value="live">Сессии</Tab>
          <Tab value="bans" counter={bans.data?.bans.length || undefined}>Баны</Tab>
          <Tab value="limits" counter={limits.data?.limits.length || undefined}>Лимиты скорости</Tab>
        </TabList>
      </TabProvider>
      <Routes>
        <Route index element={<LiveTab />} />
        <Route path="bans" element={<BansTab />} />
        <Route path="limits" element={<LimitsTab />} />
      </Routes>
    </div>
  );
}

// ───────────────────────── Сессии в реальном времени ─────────────────────────

type SortKey = 'speed' | 'volume' | 'conns';

function LiveTab() {
  const nodes = useNodes();
  const [nodeId, setNodeId] = useState('');
  const q = useClients(nodeId || undefined);
  const refresh = useRefreshClients();
  const [search, setSearch] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [sort, setSort] = useState<SortKey>('speed');
  const [banFor, setBanFor] = useState<LiveClient | null>(null);
  const [limitFor, setLimitFor] = useState<LiveClient | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<unknown> } | null>(null);
  const now = useNow(1000);

  const quickBan = useMutation({
    mutationFn: ({ c, sec, label }: { c: LiveClient; sec: number; label: string }) =>
      api.post<{ outcomes: { error: string | null }[] }>('/api/bans', { ip: c.ip, nodeIds: [c.nodeId], durationSec: sec }).then((r) => ({ r, c, label })),
    onSuccess: ({ c, label }) => {
      setUndo({ text: `${c.ip} забанен на ${label}, нода «${c.nodeName}»`, run: () => api.post('/api/bans/unban', { ip: c.ip, nodeIds: [c.nodeId] }) });
      refresh();
    },
  });
  const unban = useMutation({
    mutationFn: (c: LiveClient) => api.post('/api/bans/unban', { ip: c.ip, nodeIds: [c.nodeId] }),
    onSuccess: refresh,
  });
  const removeLimit = useMutation({ mutationFn: (id: string) => api.del(`/api/limits/${id}`), onSuccess: refresh });

  const rows = useMemo(() => {
    let r = q.data?.rows ?? [];
    if (onlyActive) r = r.filter((c) => c.connCur > 0 || c.rateIn + c.rateOut > 0);
    if (search.trim()) r = r.filter((c) => c.ip.includes(search.trim()));
    const key = (c: LiveClient) => (sort === 'speed' ? c.rateIn + c.rateOut : sort === 'volume' ? c.bytesIn + c.bytesOut : c.connCur);
    return [...r].sort((a, b) => key(b) - key(a));
  }, [q.data, onlyActive, search, sort]);

  const menu = (c: LiveClient): DropdownMenuItem[][] => [
    c.ban
      ? [{ text: 'Разбанить', action: () => unban.mutate(c) }]
      : [
          { text: 'Забанить на 1 час', action: () => quickBan.mutate({ c, sec: 3600, label: '1 час' }) },
          { text: 'Забанить на 24 часа', action: () => quickBan.mutate({ c, sec: 86400, label: '24 часа' }) },
          { text: 'Забанить на 7 дней', action: () => quickBan.mutate({ c, sec: 604800, label: '7 дней' }) },
          { text: 'Забанить…', action: () => setBanFor(c) },
        ],
    [
      { text: c.limit ? `Изменить лимит (${c.limit.mbit} Мбит/с)…` : 'Ограничить скорость…', action: () => setLimitFor(c) },
      ...(c.limit ? [{ text: 'Снять лимит', action: () => removeLimit.mutate(c.limit!.id) }] : []),
    ],
    [{ text: 'Скопировать IP', action: () => void navigator.clipboard?.writeText(c.ip) }],
  ];

  const columns: TableColumnConfig<LiveClient>[] = [
    { id: 'ip', name: 'IP', template: (c) => <span className="mono">{c.ip}</span> },
    { id: 'node', name: 'Нода', template: (c) => c.nodeName.split(' · ')[0] },
    { id: 'conn', align: 'end', width: 100, name: 'Соединения', template: (c) => int(c.connCur) },
    { id: 'down', align: 'end', width: 130, name: () => <Hint label="Скачивает, Мбит/с" tip="Скорость к клиенту, среднее за минуту (окно stick-table)" />, template: (c) => { const m = mbit(c.rateOut); return m.unit === 'Мбит/с' ? m.value : `${m.value} ${m.unit}`; } },
    { id: 'up', align: 'end', width: 120, name: 'Отдаёт, Мбит/с', template: (c) => { const m = mbit(c.rateIn); return m.unit === 'Мбит/с' ? m.value : `${m.value} ${m.unit}`; } },
    { id: 'dt', align: 'end', width: 110, name: () => <Hint label="Скачано" tip="С момента появления IP в таблице (запись живёт 24 часа простоя)" />, template: (c) => `${bytes(c.bytesOut).value} ${bytes(c.bytesOut).unit}` },
    { id: 'ut', align: 'end', width: 100, name: 'Отдано', template: (c) => `${bytes(c.bytesIn).value} ${bytes(c.bytesIn).unit}` },
    { id: 'state', width: 200, name: 'Состояние', template: (c) => (
      <span className="chips">
        {c.ban && <Label theme="danger" size="s">забанен ещё {remaining(c.ban.expiresAt, now)}</Label>}
        {c.limit && <Label theme="info" size="s">лимит {c.limit.mbit} Мбит/с</Label>}
      </span>
    ) },
    { id: 'act', align: 'end', width: 56, name: '', template: (c) => (
      <DropdownMenu items={menu(c)} renderSwitcher={(props) => <Button {...props} view="flat" size="s" aria-label={`Действия для ${c.ip}`}><Icon data={Ellipsis} size={16} /></Button>} />
    ) },
  ];

  const total = (q.data?.nodes ?? []).reduce((a, n) => a + n.active, 0);
  const problems = (q.data?.nodes ?? []).filter((n) => n.error || n.stale);

  return (
    <div className="stack">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ width: 240 }}><TextInput value={search} onUpdate={setSearch} placeholder="Поиск по IP" hasClear /></div>
        <Select
          value={[nodeId]} onUpdate={(v) => setNodeId(v[0] ?? '')} width={220}
          options={[{ value: '', content: 'Все ноды' }, ...(nodes.data?.nodes ?? []).map((n) => ({ value: n.id, content: n.name }))]}
        />
        <Select value={[sort]} onUpdate={(v) => setSort((v[0] ?? 'speed') as SortKey)} width={220} options={[{ value: 'speed', content: 'Сначала быстрые' }, { value: 'volume', content: 'Сначала по объёму' }, { value: 'conns', content: 'Сначала по соединениям' }]} />
        <Checkbox checked={onlyActive} onUpdate={setOnlyActive} content="Только активные" />
        <span style={{ marginLeft: 'auto' }}>
          <Text color="secondary">
            <span className="live-dot" /> в реальном времени · онлайн {int(total)} IP · обновлено {q.data ? new Date(q.data.at).toLocaleTimeString('ru-RU') : '—'}
          </Text>
        </span>
      </div>

      {undo && (
        <Notice theme="success">
          {undo.text}.{' '}
          <Button view="flat" size="s" onClick={() => { void undo.run().then(refresh); setUndo(null); }}>Отменить</Button>
          <Button view="flat" size="s" onClick={() => setUndo(null)}>Закрыть</Button>
        </Notice>
      )}
      {(quickBan.isError || unban.isError) && <Notice theme="danger">{((quickBan.error ?? unban.error) as ApiError)?.message}</Notice>}
      {problems.map((n) => <Notice key={n.id} theme="warning" title={n.name}>{n.error ?? 'Агент не ответил, показан последний снимок (устарел).'}</Notice>)}
      {q.isError && <Notice theme="danger">{(q.error as Error).message}</Notice>}

      <div className="tbl">
        <Table columns={columns} data={rows} getRowId={(c) => `${c.nodeId}-${c.ip}`} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Запрашиваю таблицы клиентов у агентов…" />}
        {!q.isPending && rows.length === 0 && <EmptyHint title="Подходящих клиентов нет.">{onlyActive ? 'Попробуйте снять «Только активные».' : 'Клиенты появятся, как только кто-то подключится через мост.'}</EmptyHint>}
      </div>

      <BanDialog open={!!banFor} onClose={() => setBanFor(null)} ip={banFor?.ip} nodeIds={banFor ? [banFor.nodeId] : []} />
      <LimitDialog open={!!limitFor} onClose={() => setLimitFor(null)} ip={limitFor?.ip} nodeIds={limitFor ? [limitFor.nodeId] : []} mbit={limitFor?.limit?.mbit} />
    </div>
  );
}

// ───────────────────────── Баны ─────────────────────────

function BansTab() {
  const q = useBans();
  const refresh = useRefreshClients();
  const now = useNow(1000);
  const [adding, setAdding] = useState(false);
  const [extend, setExtend] = useState<BanRow | null>(null);
  const unbanOne = useMutation({ mutationFn: (id: string) => api.del(`/api/bans/${id}`), onSuccess: refresh });
  const unbanAll = useMutation({ mutationFn: (ip: string) => api.post('/api/bans/unban', { ip }), onSuccess: refresh });
  const bans = q.data?.bans ?? [];

  const columns: TableColumnConfig<BanRow>[] = [
    { id: 'ip', name: 'IP', template: (b) => <span className="mono">{b.ip}</span> },
    { id: 'node', name: 'Нода', template: (b) => b.nodeName.split(' · ')[0] },
    { id: 'reason', width: 130, name: 'Причина', template: (b) => (b.reason === 'torrent' ? <Label theme="warning" size="s">торрент</Label> : <Label size="s">вручную</Label>) },
    { id: 'note', name: 'Заметка', template: (b) => <span className="secondary">{b.note ?? ''}</span> },
    { id: 'by', width: 140, name: 'Кто', template: (b) => b.createdBy },
    { id: 'at', width: 150, name: 'Когда', template: (b) => ago(b.createdAt, now) },
    { id: 'left', width: 150, name: 'Осталось', template: (b) => <StatusDot tone="warn">{remaining(b.expiresAt, now)}</StatusDot> },
    { id: 'act', align: 'end', width: 56, name: '', template: (b) => (
      <DropdownMenu
        items={[
          [{ text: 'Разбанить на этой ноде', action: () => unbanOne.mutate(b.id) }, { text: 'Разбанить на всех нодах', action: () => unbanAll.mutate(b.ip) }],
          [{ text: 'Продлить…', action: () => setExtend(b) }],
        ]}
        renderSwitcher={(props) => <Button {...props} view="flat" size="s" aria-label={`Действия для ${b.ip}`}><Icon data={Ellipsis} size={16} /></Button>}
      />
    ) },
  ];

  return (
    <div className="stack">
      <div className="page-head" style={{ margin: 0 }}>
        <Text color="secondary">Забаненный клиент отбрасывается на самом мосту (nftables) до HAProxy. Срок отсчитывает сама нода, поэтому бан истекает даже без связи с панелью.</Text>
        <Button view="action" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Забанить IP</Button>
      </div>
      {(unbanOne.isError || unbanAll.isError) && <Notice theme="danger">{((unbanOne.error ?? unbanAll.error) as ApiError)?.message}</Notice>}
      <div className="tbl">
        <Table columns={columns} data={bans} getRowId={(b) => b.id} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Загружаю…" />}
        {!q.isPending && bans.length === 0 && <EmptyHint title="Активных банов нет.">Забанить клиента можно из вкладки «Сессии» (меню ⋯) или кнопкой выше.</EmptyHint>}
      </div>
      <BanDialog open={adding} onClose={() => setAdding(false)} />
      <BanDialog open={!!extend} onClose={() => setExtend(null)} ip={extend?.ip} nodeIds={extend ? [extend.nodeId] : []} />
    </div>
  );
}

// ───────────────────────── Лимиты ─────────────────────────

function LimitsTab() {
  const q = useLimits();
  const refresh = useRefreshClients();
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<LimitRow | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/limits/${id}`), onSuccess: refresh });
  const rows = q.data?.limits ?? [];
  const columns: TableColumnConfig<LimitRow>[] = [
    { id: 'ip', name: 'IP', template: (l) => <span className="mono">{l.ip}</span> },
    { id: 'node', name: 'Нода', template: (l) => l.nodeName.split(' · ')[0] },
    { id: 'mbit', align: 'end', width: 130, name: 'Лимит, Мбит/с', template: (l) => l.mbit },
    { id: 'note', name: 'Заметка', template: (l) => <span className="secondary">{l.note ?? ''}</span> },
    { id: 'by', width: 140, name: 'Кто', template: (l) => l.createdBy },
    { id: 'at', width: 160, name: 'Когда', template: (l) => dateTime(l.createdAt) },
    { id: 'act', align: 'end', width: 56, name: '', template: (l) => (
      <DropdownMenu
        items={[[{ text: 'Изменить…', action: () => setEdit(l) }, { text: 'Снять лимит', action: () => remove.mutate(l.id) }]]}
        renderSwitcher={(props) => <Button {...props} view="flat" size="s" aria-label={`Действия для ${l.ip}`}><Icon data={Ellipsis} size={16} /></Button>}
      />
    ) },
  ];
  return (
    <div className="stack">
      <div className="page-head" style={{ margin: 0 }}>
        <Text color="secondary">Лимит работает через конфиг HAProxy (bwlim, нужен HAProxy 2.7+), поэтому после изменения его нужно применить на ноде. Общий лимит на каждый IP задаётся в настройках ноды.</Text>
        <Button view="action" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить лимит</Button>
      </div>
      {remove.isSuccess && <Notice theme="info">Лимит снят в панели. Чтобы он пропал и на ноде, примените конфиг на странице ноды («Конфиг»).</Notice>}
      <div className="tbl">
        <Table columns={columns} data={rows} getRowId={(l) => l.id} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Загружаю…" />}
        {!q.isPending && rows.length === 0 && <EmptyHint title="Персональных лимитов нет.">Ограничить клиента можно из вкладки «Сессии» (меню ⋯) или кнопкой выше.</EmptyHint>}
      </div>
      <LimitDialog open={adding} onClose={() => setAdding(false)} />
      <LimitDialog open={!!edit} onClose={() => setEdit(null)} ip={edit?.ip} nodeIds={edit ? [edit.nodeId] : []} mbit={edit?.mbit} />
    </div>
  );
}
