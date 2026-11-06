import { ArrowRotateRight, Plus } from '@gravity-ui/icons';
import {
  Breadcrumbs, Button, Card, DefinitionList, Dialog, Icon, Label, SegmentedRadioGroup, Select, Tab, TabList, TabProvider, Text, TextArea, TextInput,
} from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AgentUpdateButton, useAgentRelease } from '../components/AgentUpdate';
import { CommandBox, InstallDialog } from '../components/AddNode';
import { ApplyDialog } from '../components/ApplyDialog';
import { DiffView } from '../components/DiffView';
import { ImportDialog } from '../components/ImportDialog';
import { RouteDialog } from '../components/RouteDialog';
import { RoutesTable } from '../components/RoutesTable';
import { TimeChart, type ChartSeries } from '../components/Chart';
import { formFromNode, formToBody, NodeFields, type NodeFormValues } from '../components/NodeForm';
import { EmptyHint, Field, Hint, Notice, QuotaBar, StatusDot, nodeStatusLabel } from '../components/ui';
import {
  api, ApiError, RANGE_LABELS, type BackendTraffic, type CheckRow, type Enrollment, type LiveBackend, type NodeDetail, type PublicNode, type QuotaUsage, type RangeKey, type RouteDto, type Series, type VersionBrief,
} from '../lib/api';
import { ago, bytes, dateShort, dateTime, duration, int, mbitText, pct } from '../lib/format';
import { useNodeConfig } from '../lib/queries';
import { backendTone } from '../lib/state';

const useDetail = (id: string) =>
  useQuery({ queryKey: ['node', id], queryFn: () => api.get<NodeDetail>(`/api/nodes/${id}`), refetchInterval: 5_000 });

const TABS = [
  { value: 'overview', title: 'Обзор' },
  { value: 'routes', title: 'Маршруты' },
  { value: 'config', title: 'Конфиг' },
  { value: 'checks', title: 'Проверки' },
  { value: 'agent', title: 'Агент' },
  { value: 'settings', title: 'Настройки' },
] as const;

export function NodePage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const q = useDetail(id);
  const tab = pathname.split('/')[3] ?? 'overview';

  const crumbs = (name?: string) => (
    <Breadcrumbs onAction={(key) => key === 'nodes' && nav('/nodes')}>
      <Breadcrumbs.Item key="nodes">Ноды</Breadcrumbs.Item>
      {name ? <Breadcrumbs.Item key="node">{name}</Breadcrumbs.Item> : null}
    </Breadcrumbs>
  );

  if (q.isPending) return <div className="page"><Text color="secondary">Загружаю…</Text></div>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="page">
        <div className="crumbs">{crumbs()}</div>
        <Notice theme="danger">{notFound ? 'Такой ноды нет. Возможно, её удалили.' : `Не удалось загрузить ноду: ${(q.error as Error).message}`}</Notice>
      </div>
    );
  }
  const d = q.data;
  const n = d.node;
  const st = nodeStatusLabel(n.status, n.status === 'online' && !d.summary);

  return (
    <div className="page">
      <div className="crumbs">{crumbs(n.name)}</div>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <div className="page-title">
            <Text variant="header-2" as="h1">{n.name}</Text>
            <StatusDot tone={st.tone}>{st.label}</StatusDot>
            {n.status === 'online' && d.summary?.activeClients != null && (
              <span className="secondary" title="Клиентские IP с активными соединениями или трафиком за последнюю минуту">
                · <b className="num">{int(d.summary.activeClients)}</b> IP онлайн
              </span>
            )}
          </div>
          <Text color="secondary" as="div" style={{ marginTop: 4 }}>
            {[n.domain && <span key="d" className="mono">{n.domain}</span>, n.ip && <span key="i" className="mono">{n.ip}</span>, n.hoster]
              .filter(Boolean)
              .flatMap((x, i) => (i ? [' · ', x] : [x]))}
            {!n.domain && !n.ip && !n.hoster && 'Адрес не задан'}
          </Text>
        </div>
      </div>

      <TabProvider value={tab} onUpdate={(v) => nav(v === 'overview' ? `/nodes/${id}` : `/nodes/${id}/${v}`)}>
        <TabList style={{ marginBottom: 20 }}>
          {TABS.map((t) => <Tab key={t.value} value={t.value}>{t.title}</Tab>)}
        </TabList>
      </TabProvider>

      <Routes>
        <Route index element={<OverviewTab d={d} />} />
        <Route path="routes" element={<RoutesTab d={d} />} />
        <Route path="config" element={<ConfigTab d={d} />} />
        <Route path="checks" element={<ChecksTab d={d} />} />
        <Route path="agent" element={<AgentTab d={d} />} />
        <Route path="settings" element={<SettingsTab node={n} />} />
      </Routes>
    </div>
  );
}

// ───────────────────────── Обзор ─────────────────────────

function OverviewTab({ d }: { d: NodeDetail }) {
  const n = d.node;
  const [range, setRange] = useState<RangeKey>('1h');
  const series = useQuery({
    queryKey: ['series', n.id, range],
    queryFn: () => api.get<Series>(`/api/nodes/${n.id}/series?range=${range}`),
    refetchInterval: range === '1h' || range === '6h' ? 15_000 : 60_000,
    placeholderData: (prev) => prev,
  });

  if (n.status === 'pending' || n.status === 'revoked') return <PendingBanner d={d} />;

  const live = d.live;
  const speed = (v: number | undefined) => (v === undefined ? '—' : mbitText(v));
  return (
    <div className="stack">
      {n.status === 'offline' && (
        <Notice theme="danger" title="Агент не на связи">
          Последние данные — {ago(n.lastSeenAt)}{n.lastDisconnectedAt ? `, соединение оборвалось ${dateTime(n.lastDisconnectedAt)}` : ''}. Агент переподключается сам; если он не вернётся, проверьте <span className="mono">systemctl status popug-agent</span> на мосту.
        </Notice>
      )}
      {live && !live.haproxy.ok && n.status === 'online' && (
        <Notice theme="warning" title="HAProxy не отвечает на stats-сокет">
          {live.haproxy.error}. Проверьте, что в <span className="mono">global</span> есть строка <span className="mono">stats socket /run/haproxy/admin.sock mode 660 level admin</span> и сервис запущен.
        </Notice>
      )}
      {live?.clientsError && live.haproxy.ok && (
        <Notice theme="warning">Топ клиентов недоступен: {live.clientsError}. Нужен бэкенд <span className="mono">st_clients</span> со stick-table и <span className="mono">track-sc2 src table st_clients</span> в SNI-фронтенде. Панель добавляет их сама при первом применении конфига: откройте вкладку «Конфиг», при необходимости сначала импортируйте существующие маршруты.</Notice>
      )}

      <div className="split">
        <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0 }}>
          <Text variant="subheader-2" style={{ marginBottom: 8 }}>Сейчас {live?.stale && <Label theme="warning" size="s">данные устарели</Label>}</Text>
          <DefinitionList nameMaxWidth={160}>
            <DefinitionList.Item name="Исходящий">{speed(live?.sys.txBps)}</DefinitionList.Item>
            <DefinitionList.Item name="Входящий">{speed(live?.sys.rxBps)}</DefinitionList.Item>
            <DefinitionList.Item name="IP онлайн">{live?.clients ? <>{int(live.clients.active)} <span className="secondary">из {int(live.clients.tracked)} в таблице</span></> : '—'}</DefinitionList.Item>
            <DefinitionList.Item name="Сессии">{live ? int(live.sessions) : '—'}</DefinitionList.Item>
            <DefinitionList.Item name="CPU">{live ? pct(live.sys.cpuPct, 1) : '—'}</DefinitionList.Item>
            <DefinitionList.Item name="Память">{live && live.sys.memTotal ? `${pct((1 - live.sys.memAvail / live.sys.memTotal) * 100)} из ${bytes(live.sys.memTotal).value} ${bytes(live.sys.memTotal).unit}` : '—'}</DefinitionList.Item>
            <DefinitionList.Item name="Нагрузка">{live ? [live.sys.load1, live.sys.load5, live.sys.load15].map((v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(' / ') : '—'}</DefinitionList.Item>
            <DefinitionList.Item name="Аптайм">{live ? <>сервер {duration(live.sys.uptimeSec)}{live.haproxy.uptimeSec != null && <>, HAProxy {duration(live.haproxy.uptimeSec)}</>}</> : '—'}</DefinitionList.Item>
          </DefinitionList>
        </Card>
        <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0 }}>
          <Text variant="subheader-2" style={{ marginBottom: 8 }}>Квота хостера</Text>
          <QuotaBar q={d.quota} />
          <QuotaCaption q={d.quota} />
          <div style={{ marginTop: 14 }}><DefinitionList nameMaxWidth={150}>
            <DefinitionList.Item name="Период">{dateShort(d.quota.periodStart)} — {dateShort(d.quota.periodEnd)}</DefinitionList.Item>
            <DefinitionList.Item name="Считается">{d.quota.counts === 'tx' ? 'исходящий' : 'входящий + исходящий'}</DefinitionList.Item>
            <DefinitionList.Item name="Исходящий">{bytes(d.quota.txBytes).value} {bytes(d.quota.txBytes).unit}</DefinitionList.Item>
            <DefinitionList.Item name="Входящий">{bytes(d.quota.rxBytes).value} {bytes(d.quota.rxBytes).unit}</DefinitionList.Item>
            <DefinitionList.Item name="За 24 часа">{bytes(d.traffic24h.tx).value} {bytes(d.traffic24h.tx).unit} исх. · {bytes(d.traffic24h.rx).value} {bytes(d.traffic24h.rx).unit} вх.</DefinitionList.Item>
          </DefinitionList></div>
          {d.quota.limitBytes === null && <Text color="secondary" style={{ marginTop: 8 }}>Задайте квоту в «Настройках», чтобы видеть остаток.</Text>}
        </Card>
      </div>

      <div className="page-head" style={{ margin: '12px 0 0' }}>
        <Text variant="subheader-3">Графики</Text>
        <SegmentedRadioGroup
          value={range}
          onUpdate={(v) => setRange(v as RangeKey)}
          options={(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => ({ value: k, content: RANGE_LABELS[k] }))}
        />
      </div>
      {series.isError ? <Notice theme="danger">Не удалось загрузить графики: {(series.error as Error).message}</Notice> : series.data && <Charts s={series.data} />}

      <Text variant="subheader-3" className="section-title"><Hint label="Бэкенды" tip="Маршруты до зарубежных нод. Управление ими появится на следующем этапе" /></Text>
      <BackendsTable live={live?.backends ?? []} traffic={d.backendTraffic} />

      <Text variant="subheader-3" className="section-title"><Hint label="Топ клиентов по скорости" tip="Скорость — среднее за минуту по клиентскому IP. Счётчики — с момента появления IP в таблице, запись живёт 24 часа простоя" /></Text>
      <ClientsTable d={d} />
    </div>
  );
}

const toMbit = (a: (number | null)[]) => a.map((v) => (v === null ? null : (v * 8) / 1e6));
const mbFmt = (v: number) => `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} Мбит/с`;
const pctFmt = (v: number) => `${v.toFixed(1)}%`;
const cntFmt = (v: number) => v.toFixed(v < 10 ? 1 : 0);

function Charts({ s }: { s: Series }) {
  const common = { t: s.t, bin: s.bin, from: s.from, to: s.to };
  const speed = useMemo<ChartSeries[]>(() => [{ label: 'Исходящий', data: toMbit(s.txBps) }, { label: 'Входящий', data: toMbit(s.rxBps) }], [s]);
  const load = useMemo<ChartSeries[]>(() => [{ label: 'CPU', data: s.cpu }, { label: 'Память', data: s.memUsedPct }], [s]);
  const counts = useMemo<ChartSeries[]>(() => [{ label: 'IP онлайн', data: s.clients }, { label: 'Сессии', data: s.sessions }], [s]);
  // Порядок серий по алфавиту: цвет закреплён за бэкендом, а не за местом в рейтинге.
  const byBackend = useMemo<ChartSeries[]>(
    () => Object.keys(s.backends).sort().map((name) => ({ label: name, data: toMbit(s.backends[name]!.outBps) })),
    [s],
  );
  return (
    <div className="charts">
      <TimeChart title="Скорость интерфейса" unit="Мбит/с" series={speed} fmt={mbFmt} {...common} />
      <TimeChart title="CPU и память" unit="%" series={load} fmt={pctFmt} yMax={100} {...common} />
      <TimeChart title="Клиенты и сессии" unit="штук" series={counts} fmt={cntFmt} {...common} />
      <TimeChart title="Скорость по бэкендам (к клиентам)" unit="Мбит/с" series={byBackend} fmt={mbFmt} {...common} />
    </div>
  );
}

const bytesPair = (a: number, b: number) => `${bytes(a).value} ${bytes(a).unit} / ${bytes(b).value} ${bytes(b).unit}`;

function BackendsTable({ live, traffic }: { live: LiveBackend[]; traffic: BackendTraffic[] }) {
  const tmap = new Map(traffic.map((t) => [t.backend, t]));
  const names = [...new Set([...live.map((b) => b.name), ...traffic.map((t) => t.backend)])].sort();
  const lmap = new Map(live.map((b) => [b.name, b]));

  const columns: TableColumnConfig<{ name: string }>[] = [
    { id: 'name', name: 'Бэкенд', template: ({ name }) => { const b = lmap.get(name); return <StatusDot tone={b ? backendTone(b) : 'idle'}>{name}</StatusDot>; } },
    { id: 'servers', name: () => <Hint label="Серверы" tip="Работающих из общего числа по результату check. Без check HAProxy не знает, жив ли сервер" />, template: ({ name }) => {
      const b = lmap.get(name);
      if (!b) return <span className="secondary">нет в конфиге</span>;
      if (b.servers.length === 0) return <span className="secondary">нет серверов</span>;
      const up = b.servers.filter((s) => s.status === 'UP').length;
      return (
        <span title={b.servers.map((s) => `${s.name}: ${s.status}${s.check ? ` (${s.check}${s.checkMs != null ? `, ${s.checkMs} мс` : ''})` : ''}`).join('\n')}>
          {up}/{b.servers.length} <span className="secondary">{b.status === 'UP' || b.status === 'OPEN' ? 'работают' : 'недоступен'}</span>
          {b.servers.some((s) => s.status === 'no check') && <> <Label size="s">без check</Label></>}
        </span>
      );
    } },
    { id: 'out', align: 'end', name: () => <Hint label="К клиенту" tip="Скорость от бэкенда к клиентам (скачивание)" />, template: ({ name }) => { const b = lmap.get(name); return b ? mbitText(b.outBps) : '—'; } },
    { id: 'in', align: 'end', name: () => <Hint label="От клиента" tip="Скорость от клиентов к бэкенду (отдача)" />, template: ({ name }) => { const b = lmap.get(name); return b ? mbitText(b.inBps) : '—'; } },
    { id: 'sess', align: 'end', name: 'Сессии', template: ({ name }) => { const b = lmap.get(name); return b ? int(b.scur) : '—'; } },
    { id: 't24', align: 'end', name: () => <Hint label="За 24 ч" tip="Трафик за 24 часа: к клиентам / от клиентов" />, template: ({ name }) => { const t = tmap.get(name); return t ? bytesPair(t.out24h, t.in24h) : '—'; } },
    { id: 'tp', align: 'end', name: () => <Hint label="За период" tip="Трафик с начала расчётного периода квоты: к клиентам / от клиентов" />, template: ({ name }) => { const t = tmap.get(name); return t ? bytesPair(t.outPeriod, t.inPeriod) : '—'; } },
  ];
  return (
    <div className="tbl">
      <Table columns={columns} data={names.map((name) => ({ name }))} getRowId={(r) => r.name} verticalAlign="middle" width="max" />
      {names.length === 0 && <EmptyHint title="Бэкендов пока нет.">Они появятся, когда в HAProxy будут backend со server-строками.</EmptyHint>}
    </div>
  );
}

function ClientsTable({ d }: { d: NodeDetail }) {
  const rows = useMemo(() => [...(d.live?.clients?.top ?? [])].sort((a, b) => b.rateIn + b.rateOut - (a.rateIn + a.rateOut)).slice(0, 15), [d.live]);
  const noTable = !d.live?.clients;
  const columns: TableColumnConfig<(typeof rows)[number]>[] = [
    { id: 'ip', name: 'IP', template: (r) => <span className="mono">{r.ip}</span> },
    { id: 'conn', align: 'end', name: 'Соединения', template: (r) => int(r.connCur) },
    { id: 'down', align: 'end', name: 'Скачивает', template: (r) => mbitText(r.rateOut) },
    { id: 'up', align: 'end', name: 'Отдаёт', template: (r) => mbitText(r.rateIn) },
    { id: 'dtot', align: 'end', name: 'Скачано всего', template: (r) => `${bytes(r.bytesOut).value} ${bytes(r.bytesOut).unit}` },
    { id: 'utot', align: 'end', name: 'Отдано всего', template: (r) => `${bytes(r.bytesIn).value} ${bytes(r.bytesIn).unit}` },
  ];
  return (
    <div className="tbl">
      <Table columns={columns} data={rows} getRowId={(r) => r.ip} verticalAlign="middle" width="max" />
      {noTable && <EmptyHint title="Нет данных по клиентам.">{d.live?.clientsError ?? 'Агент ещё не прислал таблицу st_clients.'}</EmptyHint>}
      {!noTable && rows.length === 0 && <EmptyHint title="В таблице пока пусто.">Клиенты появятся, как только кто-то подключится через мост.</EmptyHint>}
    </div>
  );
}

// ───────────────────────── Ожидание агента ─────────────────────────

function PendingBanner({ d }: { d: NodeDetail }) {
  const n = d.node;
  const [enr, setEnr] = useState<Enrollment | null>(null);
  const qc = useQueryClient();
  const issue = useMutation({
    mutationFn: () => api.post<{ enrollment: Enrollment }>(`/api/nodes/${n.id}/enrollment`),
    onSuccess: (r) => {
      setEnr(r.enrollment);
      qc.invalidateQueries({ queryKey: ['node', n.id] });
    },
  });
  return (
    <Card type="container" view="outlined">
      <EmptyHint
        title={n.status === 'revoked' ? 'Ключ ноды отозван.' : 'Агент ещё не подключался.'}
        action={<Button view="action" size="m" onClick={() => issue.mutate()} loading={issue.isPending}>Получить команду установки</Button>}
      >
        {n.status === 'revoked' ? 'Чтобы вернуть ноду, выпустите новый токен и выполните установку заново.' : 'Выпустите токен и выполните одну команду на мосту.'}
      </EmptyHint>
      {issue.isError && <div style={{ padding: '0 16px 14px' }}><Notice theme="danger">{(issue.error as Error).message}</Notice></div>}
      {enr && <InstallDialog nodeId={n.id} enrollment={enr} onClose={() => setEnr(null)} />}
    </Card>
  );
}

// ───────────────────────── Маршруты ─────────────────────────

function RoutesTab({ d }: { d: NodeDetail }) {
  const n = d.node;
  const q = useQuery({ queryKey: ['node-routes', n.id], queryFn: () => api.get<{ routes: RouteDto[] }>(`/api/nodes/${n.id}/routes`), refetchInterval: 8_000 });
  const cfg = useNodeConfig(n.id);
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState(false);
  const routes = q.data?.routes ?? [];
  const pending = cfg.data && !cfg.data.inSync && cfg.data.applied !== null;
  return (
    <div className="stack">
      <div className="page-head" style={{ margin: 0 }}>
        <Text color="secondary">Маршруты этой ноды. Один маршрут может стоять на нескольких нодах с одинаковым конфигом.</Text>
        <div style={{ display: 'flex', gap: 8 }}>
          {pending && <Button view="outlined" onClick={() => setApplying(true)} disabled={n.status !== 'online'}>Применить изменения…</Button>}
          <Button view="action" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить маршрут</Button>
        </div>
      </div>
      {pending && <Notice theme="warning">Есть изменения, которые ещё не применены на ноде. Откройте «Применить изменения», чтобы увидеть дифф.</Notice>}
      <RoutesTable
        routes={routes}
        nodeId={n.id}
        empty={!q.isPending && <EmptyHint title="На этой ноде маршрутов нет." action={<Button view="action" size="m" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить маршрут</Button>}>{cfg.data?.importPending ? 'На ноде есть ручной конфиг: его маршруты можно импортировать на вкладке «Конфиг».' : 'Добавьте первую локацию: выберите выход и SNI, дальше панель сама соберёт конфиг.'}</EmptyHint>}
      />
      <RouteDialog open={adding} onClose={() => { setAdding(false); q.refetch(); }} presetNodeIds={[n.id]} />
      {applying && <ApplyDialog nodeId={n.id} nodeName={n.name} onClose={() => { setApplying(false); q.refetch(); }} />}
    </div>
  );
}

// ───────────────────────── Конфиг ─────────────────────────

const STATUS_LABEL: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string }> = {
  applied: { tone: 'ok', text: 'применена' },
  imported: { tone: 'idle', text: 'ручной (импорт)' },
  applying: { tone: 'warn', text: 'применяется' },
  failed: { tone: 'bad', text: 'не применена' },
  rolled_back: { tone: 'bad', text: 'откат' },
  rollback_failed: { tone: 'bad', text: 'откат не удался' },
};

function ConfigTab({ d }: { d: NodeDetail }) {
  const n = d.node;
  const q = useNodeConfig(n.id);
  const nav = useNavigate();
  const [view, setView] = useState<'diff' | 'applied' | 'desired' | 'history'>('diff');
  const [applying, setApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<VersionBrief | null>(null);
  const qc = useQueryClient();
  const skip = useMutation({ mutationFn: () => api.post(`/api/nodes/${n.id}/import/skip`), onSuccess: () => q.refetch() });
  const raw = useMutation({ mutationFn: () => api.post<{ path: string; content: string; sha256: string }>(`/api/nodes/${n.id}/fetch-config`) });
  const ver = useQuery({
    queryKey: ['version', n.id, open?.number],
    queryFn: () => api.get<{ version: VersionBrief & { cfg: string; sniMap: string } }>(`/api/nodes/${n.id}/config/versions/${open!.number}`),
    enabled: !!open,
  });

  if (q.isPending) return <Text color="secondary">Загружаю…</Text>;
  if (q.isError) return <Notice theme="danger">{(q.error as Error).message}</Notice>;
  const s = q.data;
  const online = n.status === 'online';
  const outdated = online && n.ops.length > 0 && !n.ops.includes('apply_config');

  return (
    <div className="stack">
      {outdated && <Notice theme="warning" title="Агент устарел">Версия {n.agentVersion} не умеет применять конфиг. Обновите его: на мосту выполните команду установки без токена (вкладка «Агент»).</Notice>}

      {s.importPending && (
        <Notice theme="info" title="На ноде может быть ручной конфиг">
          Панель его не меняла. Импортируйте найденные маршруты, чтобы дальше управлять ими отсюда. Или пропустите и создайте маршруты вручную.
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button view="action" size="m" onClick={() => setImporting(true)} disabled={!online}>Импортировать конфиг…</Button>
            <Button size="m" onClick={() => skip.mutate()} loading={skip.isPending}>Пропустить</Button>
            {!online && <Text color="secondary">Нода должна быть онлайн.</Text>}
          </div>
        </Notice>
      )}

      {s.lastFailed && (
        <Notice theme="danger" title={s.lastFailed.status === 'rollback_failed' ? `Версия ${s.lastFailed.number}: откат не удался, нода в неизвестном состоянии` : s.lastFailed.status === 'rolled_back' ? `Версия ${s.lastFailed.number} не применилась, нода вернулась на прежний конфиг` : `Версия ${s.lastFailed.number} не применилась`}>
          {dateTime(s.lastFailed.createdAt)}, {s.lastFailed.createdBy}.
          {s.lastFailed.output && <pre className="output" style={{ marginTop: 8 }}>{s.lastFailed.output}</pre>}
        </Notice>
      )}
      {s.drift && <Notice theme="warning" title="Конфиг на ноде изменён вне панели">Хеш файла на ноде не совпадает с применённой версией. Следующее применение перезапишет эти правки.</Notice>}

      <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <Text variant="subheader-2">
              {s.applied ? <>Нода на версии {s.applied.number}</> : 'Конфиг панелью не применялся'}
              {s.applyingNumber !== null ? <span className="secondary"> / применяется {s.applyingNumber}</span> : !s.inSync && s.applied ? <span className="secondary"> / ожидается {s.expected}</span> : null}
            </Text>
            <div style={{ marginTop: 4 }}>
              <StatusDot tone={s.applyingNumber !== null ? 'warn' : s.inSync ? 'ok' : 'warn'}>
                {s.applyingNumber !== null ? 'Идёт применение' : s.inSync ? 'Совпадает с панелью' : 'Есть неприменённые изменения'}
              </StatusDot>
            </div>
            {s.applied && <Text color="secondary" as="div" style={{ marginTop: 4 }}>{s.applied.source === 'import' ? 'Ручной конфиг, снятый при импорте' : 'Применена'} {dateTime(s.applied.finishedAt ?? s.applied.createdAt)}, {s.applied.createdBy}</Text>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button view="action" size="l" onClick={() => setApplying(true)} disabled={!online || s.inSync || outdated}>Дифф и применение…</Button>
          </div>
        </div>
        {!online && <Text color="secondary" style={{ marginTop: 8 }}>Нода не на связи: применять можно только на подключённую ноду.</Text>}
      </Card>

      <SegmentedRadioGroup
        value={view}
        onUpdate={(v) => setView(v as typeof view)}
        options={[{ value: 'diff', content: 'Дифф' }, { value: 'applied', content: 'Применённый' }, { value: 'desired', content: 'Ожидаемый' }, { value: 'history', content: `История (${s.versions.length})` }]}
      />

      {view === 'diff' && (s.inSync ? <Notice theme="success">Различий нет: на ноде именно то, что хочет панель.</Notice> : (
        <>
          <DiffView title="haproxy.cfg" before={s.applied?.cfg ?? ''} after={s.desired.cfg} beforeLabel={s.applied ? `версия ${s.applied.number}` : 'ничего'} afterLabel="ожидается" />
          <DiffView title="maps/sni.map" before={s.applied?.sniMap ?? ''} after={s.desired.sniMap} />
        </>
      ))}
      {view === 'applied' && <ConfigText title={s.applied ? `Версия ${s.applied.number}` : 'Нет применённой версии'} cfg={s.applied?.cfg} map={s.applied?.sniMap} />}
      {view === 'desired' && <ConfigText title="Что панель собрала из маршрутов" cfg={s.desired.cfg} map={s.desired.sniMap} />}

      {view === 'history' && (
        <div className="tbl">
          <Table
            columns={[
              { id: 'n', width: 90, name: 'Версия', template: (v: VersionBrief) => <b>{v.number}</b> },
              { id: 's', width: 190, name: 'Результат', template: (v: VersionBrief) => <StatusDot tone={STATUS_LABEL[v.status]?.tone ?? 'idle'}>{STATUS_LABEL[v.status]?.text ?? v.status}</StatusDot> },
              { id: 't', width: 170, name: 'Когда', template: (v: VersionBrief) => dateTime(v.createdAt) },
              { id: 'u', width: 130, name: 'Кто', template: (v: VersionBrief) => v.createdBy },
              { id: 'src', width: 130, name: 'Источник', template: (v: VersionBrief) => (v.source === 'import' ? 'импорт' : 'панель') },
              { id: 'd', align: 'end', width: 110, name: 'Длительность', template: (v: VersionBrief) => (v.durationMs ? `${(v.durationMs / 1000).toFixed(1)} с` : '—') },
              { id: 'o', name: 'Вывод', template: (v: VersionBrief) => <span className="mono secondary">{(v.output ?? '').split('\n')[0]?.slice(0, 90)}</span> },
            ] as TableColumnConfig<VersionBrief>[]}
            data={s.versions}
            getRowId={(v) => v.id}
            onRowClick={(v) => setOpen(v)}
            getRowDescriptor={() => ({ interactive: true })}
            verticalAlign="middle"
            width="max"
          />
          {s.versions.length === 0 && <EmptyHint title="Версий ещё нет.">Они появятся после первого применения или импорта.</EmptyHint>}
        </div>
      )}

      <div>
        <Button view="flat" onClick={() => raw.mutate()} loading={raw.isPending} disabled={!online}><Icon data={ArrowRotateRight} size={16} />Показать файл с ноды как есть</Button>
      </div>
      {raw.isError && <Notice theme="danger">{(raw.error as Error).message}</Notice>}
      {raw.data && <ConfigText title={`${raw.data.path} · sha256 ${raw.data.sha256.slice(0, 12)}…`} cfg={raw.data.content} />}

      {applying && <ApplyDialog nodeId={n.id} nodeName={n.name} onClose={() => { setApplying(false); qc.invalidateQueries({ queryKey: ['config', n.id] }); }} />}
      {importing && <ImportDialog nodeId={n.id} nodeName={n.name} onClose={() => setImporting(false)} onDone={() => { setImporting(false); nav(`/nodes/${n.id}/config`); }} />}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)} maxWidth="l" fullWidth aria-labelledby="ver-title">
        <Dialog.Header caption={open ? `Версия ${open.number} · ${STATUS_LABEL[open.status]?.text ?? open.status}` : ''} id="ver-title" />
        <Dialog.Body>
          <div className="stack">
            {open && <Text color="secondary">{dateTime(open.createdAt)}, {open.createdBy}, источник: {open.source === 'import' ? 'импорт' : 'панель'}</Text>}
            {open?.output && <pre className="output">{open.output}</pre>}
            {ver.data && <ConfigText title="haproxy.cfg этой версии" cfg={ver.data.version.cfg} map={ver.data.version.sniMap} />}
          </div>
        </Dialog.Body>
        <Dialog.Footer onClickButtonApply={() => setOpen(null)} textButtonApply="Закрыть" />
      </Dialog>
    </div>
  );
}

function ConfigText({ title, cfg, map }: { title: string; cfg?: string; map?: string }) {
  return (
    <Card type="container" view="outlined">
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--g-color-line-generic)' }}><Text variant="subheader-2">{title}</Text></div>
      <pre className="config">{cfg ?? '—'}</pre>
      {map ? <><div style={{ padding: '10px 14px', borderTop: '1px solid var(--g-color-line-generic)' }}><Text variant="subheader-2">maps/sni.map</Text></div><pre className="config">{map}</pre></> : null}
    </Card>
  );
}

// ───────────────────────── Проверки ─────────────────────────

function ChecksTab({ d }: { d: NodeDetail }) {
  const n = d.node;
  const q = useQuery({ queryKey: ['node-checks', n.id], queryFn: () => api.get<{ results: (CheckRow & { routeName: string })[] }>(`/api/nodes/${n.id}/checks`), refetchInterval: 10_000 });
  const run = useMutation({ mutationFn: () => api.post(`/api/nodes/${n.id}/checks/run`), onSettled: () => q.refetch() });
  const rows = q.data?.results ?? [];
  const columns: TableColumnConfig<CheckRow & { routeName: string }>[] = [
    { id: 'ts', width: 150, name: 'Время', template: (c) => <span className="nowrap">{dateTime(c.ts)}</span> },
    { id: 'r', name: 'Маршрут', template: (c) => c.routeName },
    { id: 's', width: 170, name: () => <Hint label="Откуда" tip="Агент проверяет путь мост → выход. Панель — путь клиент → мост:443 с SNI маршрута." />, template: (c) => (c.source === 'agent' ? 'агент → выход' : 'панель → мост') },
    { id: 'ok', width: 120, name: 'Результат', template: (c) => <StatusDot tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'успешно' : 'ошибка'}</StatusDot> },
    { id: 'ms', align: 'end', width: 90, name: 'мс', template: (c) => (c.ms !== null ? Math.round(c.ms) : '—') },
    { id: 'e', name: 'Ошибка', template: (c) => <span className="mono secondary">{c.error ?? ''}</span> },
  ];
  return (
    <div className="stack">
      <div className="page-head" style={{ margin: 0 }}>
        <Text color="secondary">Агент проверяет выходы каждые 30 секунд, панель проверяет мост снаружи раз в 1,5 минуты.</Text>
        <Button onClick={() => run.mutate()} loading={run.isPending} disabled={n.status === 'pending' || n.status === 'revoked'}><Icon data={ArrowRotateRight} size={16} />Проверить сейчас</Button>
      </div>
      <div className="tbl">
        <Table columns={columns} data={rows} getRowId={(c, i) => `${c.ts}-${c.routeName}-${c.source}-${i}`} verticalAlign="middle" width="max" />
        {!q.isPending && rows.length === 0 && <EmptyHint title="Проверок ещё не было.">Они начнутся, когда на ноде появятся маршруты с проверкой здоровья.</EmptyHint>}
      </div>
    </div>
  );
}

// ───────────────────────── Агент ─────────────────────────

function QuotaCaption({ q }: { q: QuotaUsage }) {
  if (q.limitBytes === null) return null;
  const start = new Date(q.periodStart + 'T00:00:00Z').getTime();
  const end = new Date(q.periodEnd + 'T00:00:00Z').getTime();
  const frac = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
  const forecast = frac > 0.03 ? (q.usedBytes / frac / q.limitBytes) * 100 : null;
  const risk = forecast !== null && forecast > 100;
  return (
    <div className="quota-caption">
      Чёрточка на полосе — сколько расчётного периода уже прошло ({pct(frac * 100)}). Если полоса правее чёрточки, трафик расходуется быстрее, чем идёт время.
      {forecast !== null && (
        <> К концу периода при таком темпе будет около <b className="num" style={risk ? { color: 'var(--g-color-text-danger)' } : undefined}>{pct(forecast)}</b> квоты{risk ? ' — лимит будет превышен.' : '.'}</>
      )}
    </div>
  );
}

function AgentUpdateSection({ n }: { n: PublicNode }) {
  const { latest, outdated } = useAgentRelease();
  const old = outdated(n);
  const canSelf = n.ops.includes('update_agent');
  return (
    <>
      <Text variant="subheader-3" className="section-title">Обновление</Text>
      <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0 }}>
        <DefinitionList nameMaxWidth={230}>
          <DefinitionList.Item name="На ноде"><span className="mono">{n.agentVersion ?? '—'}</span></DefinitionList.Item>
          <DefinitionList.Item name="Доступно на панели"><span className="mono">{latest ?? 'сборок нет'}</span></DefinitionList.Item>
        </DefinitionList>
        <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {latest && !old && <Text color="secondary">Агент актуален.</Text>}
          <AgentUpdateButton node={n} />
          {old && n.status !== 'online' && <Text color="secondary">Нода должна быть онлайн.</Text>}
        </div>
        {old && !canSelf && (
          <Notice theme="info" title="Первое обновление — вручную">Эта версия агента ещё не умеет обновляться сама. Один раз выполните на мосту команду ниже, дальше обновления идут по кнопке.</Notice>
        )}
      </Card>
      <Text color="secondary">Команда установки без токена ставит ту же версию, что лежит на панели; ключ, конфиг и HAProxy она не трогает. Версию самого HAProxy панель не обновляет: это делается вручную в удобное окно.</Text>
      <CommandBox text={`curl -fsSL ${window.location.origin}/install.sh | bash`} />
    </>
  );
}

function AgentTab({ d }: { d: NodeDetail }) {
  const n = d.node;
  const qc = useQueryClient();
  const [enr, setEnr] = useState<Enrollment | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const st = nodeStatusLabel(n.status);

  const issue = useMutation({
    mutationFn: () => api.post<{ enrollment: Enrollment }>(`/api/nodes/${n.id}/enrollment`),
    onSuccess: (r) => {
      setEnr(r.enrollment);
      qc.invalidateQueries({ queryKey: ['node', n.id] });
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.post(`/api/nodes/${n.id}/revoke`),
    onSuccess: () => {
      setConfirmRevoke(false);
      qc.invalidateQueries({ queryKey: ['node', n.id] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0 }}>
        <DefinitionList nameMaxWidth={230}>
          <DefinitionList.Item name="Состояние"><StatusDot tone={st.tone}>{st.label}</StatusDot></DefinitionList.Item>
          <DefinitionList.Item name="Версия агента"><span className="mono">{n.agentVersion ?? '—'}</span></DefinitionList.Item>
          <DefinitionList.Item name="Протокол"><span className="mono">{n.protocol ?? '—'}</span></DefinitionList.Item>
          <DefinitionList.Item name="HAProxy">
            {n.haproxyInstalled === false ? <Label theme="warning" size="s">не установлен</Label> : <span className="mono">{n.haproxyVersion ?? '—'}</span>}
            {n.bwlimSupported === false && <span className="secondary"> — старше 2.7, лимиты скорости будут отключены</span>}
          </DefinitionList.Item>
          <DefinitionList.Item name="Хост">{n.hostname ?? '—'}{n.os && <span className="secondary"> · {n.os}</span>}</DefinitionList.Item>
          <DefinitionList.Item name="Адрес, который видит панель"><span className="mono">{n.lastRemoteIp ?? '—'}</span></DefinitionList.Item>
          <DefinitionList.Item name="Публичные адреса"><span className="mono">{n.addrs.length ? n.addrs.join(', ') : '—'}</span></DefinitionList.Item>
          <DefinitionList.Item name="Операции агента"><span className="mono">{n.ops.length ? n.ops.join(', ') : '—'}</span></DefinitionList.Item>
          <DefinitionList.Item name="Последнее подключение">{dateTime(n.lastConnectedAt)}</DefinitionList.Item>
          <DefinitionList.Item name="Последние данные">{n.lastSeenAt ? `${dateTime(n.lastSeenAt)} (${ago(n.lastSeenAt)})` : '—'}</DefinitionList.Item>
        </DefinitionList>
      </Card>

      <AgentUpdateSection n={n} />

      <Text variant="subheader-3" className="section-title">Ключ ноды</Text>
      <Text color="secondary">Новый токен нужен для переустановки или переноса на другой сервер. Старый ключ перестанет действовать, когда агент зарегистрируется по новому. Отзыв рвёт соединение сразу, агент больше не сможет подключиться.</Text>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button onClick={() => issue.mutate()} loading={issue.isPending}>Выпустить токен установки</Button>
        <Button view="outlined-danger" onClick={() => setConfirmRevoke(true)} disabled={n.status === 'pending' || n.status === 'revoked'}>Отозвать ключ</Button>
      </div>
      {issue.isError && <Notice theme="danger">{(issue.error as Error).message}</Notice>}
      {enr && <InstallDialog nodeId={n.id} enrollment={enr} onClose={() => setEnr(null)} />}
      <Dialog open={confirmRevoke} onOpenChange={(o) => !o && setConfirmRevoke(false)} maxWidth="s" fullWidth aria-labelledby="revoke-title">
        <Dialog.Header caption="Отозвать ключ ноды?" id="revoke-title" />
        <Dialog.Body>
          <Text>Агент на «{n.name}» будет отключён и не сможет подключиться снова. Трафик клиентов через мост не пострадает: HAProxy работает независимо от агента.</Text>
          {revoke.isError && <Notice theme="danger">{(revoke.error as Error).message}</Notice>}
        </Dialog.Body>
        <Dialog.Footer onClickButtonCancel={() => setConfirmRevoke(false)} textButtonCancel="Отмена" onClickButtonApply={() => revoke.mutate()} textButtonApply="Отозвать" loading={revoke.isPending} propsButtonApply={{ view: 'outlined-danger' }} />
      </Dialog>
    </div>
  );
}

// ───────────────────────── Настройки ─────────────────────────

function SettingsTab({ node }: { node: PublicNode }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [form, setForm] = useState<NodeFormValues>(() => formFromNode(node));
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const save = useMutation({
    mutationFn: () => api.patch<{ node: PublicNode }>(`/api/nodes/${node.id}`, formToBody(form)),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['node', node.id] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/nodes/${node.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['nodes'] });
      nav('/nodes');
    },
  });

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0, gap: 16 }}>
        <NodeFields value={form} onChange={(v) => { setForm(v); setSaved(false); }} />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Button view="action" onClick={() => save.mutate()} disabled={!form.name.trim()} loading={save.isPending}>Сохранить</Button>
          {saved && <Text color="positive">Сохранено</Text>}
          {save.isError && <Text color="danger">{save.error instanceof ApiError ? save.error.message : 'Не удалось сохранить'}</Text>}
        </div>
      </Card>
      <RoutingSettings node={node} />
      <Text variant="subheader-3" className="section-title">Удаление</Text>
      <Text color="secondary">Удалит ноду из панели вместе с историей метрик. На самом мосту HAProxy и агент останутся: агент потеряет связь с панелью.</Text>
      <div><Button view="outlined-danger" onClick={() => setDeleting(true)}>Удалить ноду…</Button></div>
      <Dialog open={deleting} onOpenChange={(o) => !o && (setDeleting(false), setConfirmName(''))} maxWidth="s" fullWidth aria-labelledby="del-title">
        <Dialog.Header caption="Удалить ноду" id="del-title" />
        <Dialog.Body>
          <Field label={`Введите имя ноды «${node.name}», чтобы подтвердить`}>
            <TextInput value={confirmName} onUpdate={setConfirmName} autoFocus />
          </Field>
          {del.isError && <Notice theme="danger">{(del.error as Error).message}</Notice>}
        </Dialog.Body>
        <Dialog.Footer onClickButtonCancel={() => setDeleting(false)} textButtonCancel="Отмена" onClickButtonApply={() => del.mutate()} textButtonApply="Удалить навсегда" loading={del.isPending} propsButtonApply={{ view: 'outlined-danger', disabled: confirmName !== node.name }} />
      </Dialog>
    </div>
  );
}

/** Маршрут по умолчанию и свои директивы. Применяются вместе с конфигом ноды. */
function RoutingSettings({ node }: { node: PublicNode }) {
  const qc = useQueryClient();
  const routes = useQuery({ queryKey: ['node-routes', node.id], queryFn: () => api.get<{ routes: RouteDto[] }>(`/api/nodes/${node.id}/routes`) });
  const [def, setDef] = useState(node.defaultRouteId ?? '');
  const [extra, setExtra] = useState(node.extraConfig ?? '');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/nodes/${node.id}`, { defaultRouteId: def || null, extraConfig: extra }),
    onSuccess: () => {
      setSaved(true);
      for (const k of ['node', 'nodes', 'config']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  return (
    <>
      <Text variant="subheader-3" className="section-title">Маршрутизация</Text>
      <Card type="container" view="outlined" className="card-pad" style={{ minHeight: 0, gap: 16 }}>
        <Field label="Неизвестный SNI" help="Что делать с соединением, SNI которого нет ни в одном маршруте ноды. По умолчанию соединение закрывается.">
          <Select value={[def]} onUpdate={(v) => { setDef(v[0] ?? ''); setSaved(false); }} width="max" options={[{ value: '', content: 'закрывать соединение (reject)' }, ...(routes.data?.routes ?? []).map((r) => ({ value: r.id, content: `отправлять в «${r.name}»` }))]} />
        </Field>
        <Field label="Свои директивы" help="Дописываются в конец haproxy.cfg как есть: например, секции listen или bwlim. Запрещены директивы, запускающие программы (program, external-check, lua-load и подобные).">
          <TextArea value={extra} onUpdate={(v) => { setExtra(v); setSaved(false); }} minRows={4} controlProps={{ className: 'mono' }} placeholder={'listen stats\n    bind 127.0.0.1:8404'} />
        </Field>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>Сохранить</Button>
          {saved && <Text color="positive">Сохранено. Чтобы изменения попали на ноду, примените конфиг на вкладке «Конфиг».</Text>}
          {save.isError && <Text color="danger">{save.error instanceof ApiError ? save.error.message : 'Не удалось сохранить'}</Text>}
        </div>
      </Card>
    </>
  );
}
