import { Plus } from '@gravity-ui/icons';
import { Button, Card, Icon, Progress, Text } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AddNodeDialog } from '../components/AddNode';
import { Sparkline } from '../components/Chart';
import { EmptyHint, Hint, Notice, QuotaBar, RouterLink, StatusDot } from '../components/ui';
import type { NodeSummary } from '../lib/api';
import { bytes, int, mbit, pct } from '../lib/format';
import { useFleetTraffic, useNodes, useRoutes } from '../lib/queries';
import { nodeState } from '../lib/state';

function StatCard({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <Card type="container" view="outlined" className="card-pad">
      <Text color="secondary"><Hint label={label} tip={tip} /></Text>
      {children}
    </Card>
  );
}

const Value = ({ children, unit }: { children: React.ReactNode; unit?: string }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
    <Text variant="display-1">{children}</Text>
    {unit && <Text color="secondary" variant="body-2">{unit}</Text>}
  </div>
);

const Num = ({ v, unit }: { v: { value: string; unit: string }; unit?: boolean }) => <span className="nowrap">{v.value}{(unit || v.unit !== 'Мбит/с') && <span className="secondary"> {v.unit}</span>}</span>;
const W = (w: number) => ({ width: w });

export function OverviewPage() {
  const q = useNodes();
  const fleet = useFleetTraffic();
  const routesQ = useRoutes();
  const allRoutes = routesQ.data?.routes ?? [];
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const nodes = q.data?.nodes ?? [];
  const empty = !q.isPending && nodes.length === 0;

  const online = nodes.filter((n) => n.status === 'online').length;
  const totalTx = nodes.reduce((a, n) => a + (n.live?.txBps ?? 0), 0);
  const totalRx = nodes.reduce((a, n) => a + (n.live?.rxBps ?? 0), 0);
  const clients = nodes.reduce((a, n) => a + (n.live?.activeClients ?? 0), 0);
  const sessions = nodes.reduce((a, n) => a + (n.live?.sessions ?? 0), 0);
  const attention = nodes.map((n) => ({ n, s: nodeState(n) })).filter((x) => x.s.tone === 'bad' || x.s.tone === 'warn');
  const redRoutes = allRoutes.filter((r) => r.enabled && r.status === 'bad');
  const attentionTotal = attention.length + redRoutes.length;
  /** Маршруты ноды: сколько включено и сколько из них красных. */
  const routesOf = (nodeId: string) => {
    const mine = allRoutes.filter((r) => r.enabled && r.nodeIds.includes(nodeId));
    return { total: mine.length, bad: mine.filter((r) => r.nodes.find((x) => x.nodeId === nodeId)?.tone === 'bad').length };
  };
  const tx = mbit(totalTx);

  const spark = useMemo(() => fleet.data?.txBps.map((v) => (v * 8) / 1e6) ?? [], [fleet.data]);

  const columns: TableColumnConfig<NodeSummary>[] = [
    { id: 'state', ...W(160), name: 'Состояние', template: (n) => { const s = nodeState(n); return <StatusDot tone={s.tone} detail={s.detail}>{s.label}</StatusDot>; } },
    { id: 'name', name: 'Нода', template: (n) => (
      <div className="cell-name">
        <RouterLink to={`/nodes/${n.id}`}>{n.name}</RouterLink>
        <span className="mono secondary">{n.domain ?? n.ip ?? '—'}</span>
      </div>
    ) },
    { id: 'tx', align: 'end', ...W(112), name: () => <Hint label="Исходящий, Мбит/с" tip="Скорость исходящего трафика по физическим интерфейсам моста (без docker и veth). Значения меньше 0,1 Мбит/с показаны в кбит/с" />, template: (n) => n.live ? <Num v={mbit(n.live.txBps)} /> : "—" },
    { id: 'clients', align: 'end', ...W(96), name: () => <Hint label="IP онлайн" tip="Клиентские IP с открытыми соединениями прямо сейчас (stick-table st_clients)" />, template: (n) => n.live?.activeClients != null ? int(n.live.activeClients) : '—' },
    { id: 'backends', align: 'end', ...W(92), name: () => <Hint label="Бэкенды" tip="Работающих из общего числа. Бэкенд не работает, если ни один его сервер не проходит check" />, template: (n) => n.live ? (
      <span style={n.live.backendsDown > 0 ? { color: 'var(--g-color-text-danger)' } : undefined}>{n.live.backendsTotal - n.live.backendsDown}/{n.live.backendsTotal}</span>
    ) : '—' },
    { id: 'routes', align: 'end', ...W(100), name: () => <Hint label="Маршруты" tip="Включённых маршрутов на ноде. Красным — сколько из них не работает по результатам проверок" />, template: (n) => {
      const r = routesOf(n.id);
      return r.total === 0 ? '—' : <span style={r.bad > 0 ? { color: 'var(--g-color-text-danger)' } : undefined}>{r.bad > 0 ? `${r.bad} из ${r.total}` : r.total}</span>;
    } },
    { id: 'cpu', align: 'end', ...W(96), name: 'CPU', template: (n) => n.live?.cpuPct != null ? (
      <span className="cpu"><Progress value={n.live.cpuPct} size="xs" theme={n.live.cpuPct >= 85 ? 'danger' : n.live.cpuPct >= 70 ? 'warning' : 'default'} />{pct(n.live.cpuPct)}</span>
    ) : '—' },
    { id: 'quota', ...W(176), name: () => <Hint label="Квота хостера" tip="Заливка — израсходовано. Чёрточка — сколько расчётного периода прошло: если заливка правее чёрточки, квота кончится раньше периода" />, template: (n) => <QuotaBar q={n.quota} /> },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Обзор</Text>
        {!empty && <Button view="action" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить ноду</Button>}
      </div>

      {q.isError && <Notice theme="danger">Не удалось загрузить ноды: {(q.error as Error).message}</Notice>}

      <div className="cards">
        <StatCard label="Ноды онлайн">
          <Value>{online}<Text color="secondary" variant="display-1"> из {nodes.length}</Text></Value>
          <Text color="secondary">{nodes.length - online > 0 ? `не на связи: ${nodes.length - online}` : 'все на связи'}</Text>
        </StatCard>
        <StatCard label="Трафик сейчас" tip="Суммарная исходящая скорость всех мостов; график — последний час">
          <Value unit={tx.unit}>{tx.value}</Value>
          <Text color="secondary">входящий {mbit(totalRx).value} {mbit(totalRx).unit}</Text>
          <Sparkline t={fleet.data?.t ?? []} values={spark} color="#3b82f6" />
        </StatCard>
        <StatCard label="IP онлайн" tip="Клиентские IP с открытыми соединениями на всех мостах">
          <Value>{int(clients)}</Value>
          <Text color="secondary">сессий {int(sessions)}</Text>
        </StatCard>
        <StatCard label="Требуют внимания">
          <Value>{attentionTotal}</Value>
          {attentionTotal === 0 ? <Text color="positive">всё в порядке</Text> : (
            <Text color="secondary">
              {[
                ...redRoutes.map((r) => `маршрут «${r.name.split(' (')[0]}» не работает`),
                ...attention.map((x) => `${x.n.name.split(' · ')[0]}: ${x.s.detail ?? x.s.label}`),
              ].slice(0, 2).join('; ')}{attentionTotal > 2 ? '…' : ''}
            </Text>
          )}
        </StatCard>
      </div>

      <div className="tbl tbl-link">
        <Table
          columns={columns}
          data={nodes}
          getRowId={(n) => n.id}
          onRowClick={(n) => nav(`/nodes/${n.id}`)}
          getRowDescriptor={() => ({ interactive: true })}
          verticalAlign="middle" width="max"
        />
        {q.isPending && <EmptyHint title="Загружаю…" />}
        {empty && (
          <EmptyHint
            title="Мостов пока нет."
            action={<Button view="action" size="m" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить ноду</Button>}
          >
            Здесь появятся состояние, скорость и квота каждого моста.
          </EmptyHint>
        )}
      </div>
      <AddNodeDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
