import { flag } from '@popug/protocol/countries';
import { ArrowRotateRight } from '@gravity-ui/icons';
import { Breadcrumbs, Button, Dialog, Icon, Label, Text } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApplyDialog } from '../components/ApplyDialog';
import { RouteDialog } from '../components/RouteDialog';
import { EmptyHint, Hint, Notice, StatusDot } from '../components/ui';
import { api, ApiError, type CheckRow, type RouteDto, type RouteNodeStatus } from '../lib/api';
import { ago, dateTime } from '../lib/format';
import { ROUTE_LABEL, routeTone } from '../lib/state';

export function RoutePage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['route', id], queryFn: () => api.get<{ route: RouteDto; history: CheckRow[] }>(`/api/routes/${id}`), refetchInterval: 8_000 });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [applyFor, setApplyFor] = useState<RouteNodeStatus | null>(null);

  const run = useMutation({
    mutationFn: () => api.post(`/api/routes/${id}/checks/run`),
    onSettled: () => q.refetch(),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/routes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['config'] });
      nav('/routes');
    },
  });

  const crumbs = (name?: string) => (
    <Breadcrumbs onAction={(k) => k === 'routes' && nav('/routes')}>
      <Breadcrumbs.Item key="routes">Маршруты</Breadcrumbs.Item>
      {name ? <Breadcrumbs.Item key="r">{name}</Breadcrumbs.Item> : null}
    </Breadcrumbs>
  );

  if (q.isPending) return <div className="page"><Text color="secondary">Загружаю…</Text></div>;
  if (q.isError) {
    const nf = q.error instanceof ApiError && q.error.status === 404;
    return <div className="page"><div className="crumbs">{crumbs()}</div><Notice theme="danger">{nf ? 'Такого маршрута нет. Возможно, его удалили.' : (q.error as Error).message}</Notice></div>;
  }
  const { route: r, history } = q.data;
  const nodeName = (nid: string) => r.nodes.find((n) => n.nodeId === nid)?.nodeName ?? '—';
  const exitName = (eid: string | null) => r.exits.find((e) => e.id === eid)?.name ?? '';

  const nodeCols: TableColumnConfig<RouteNodeStatus>[] = [
    { id: 'node', name: 'Нода', template: (n) => <b>{n.nodeName}</b> },
    { id: 'tone', name: 'Состояние', template: (n) => <StatusDot tone={routeTone(r.enabled ? n.tone : 'unknown')}>{r.enabled ? ROUTE_LABEL[n.tone] : 'Выключен'}</StatusDot> },
    { id: 'reason', name: 'Почему', template: (n) => <span className="secondary">{r.enabled ? n.reason : 'маршрут выключен'}</span> },
    { id: 'last', name: 'Последняя проверка', template: (n) => (n.lastAt ? ago(n.lastAt) : '—') },
    { id: 'ms', align: 'end', width: 130, name: () => <Hint label="Рукопожатие" tip="Среднее время TCP-соединения и TLS-рукопожатия за последние 3 минуты, мс" />, template: (n) => (n.avgMs !== null ? `${Math.round(n.avgMs)} мс` : '—') },
    { id: 'cfg', name: 'Конфиг', template: (n) => (n.pendingApply ? <Label theme="warning" size="s">ожидает применения</Label> : <span className="secondary">актуален</span>) },
    { id: 'act', align: 'end', width: 190, name: '', template: (n) => <Button size="s" view={n.pendingApply ? 'action' : 'outlined'} disabled={!n.online} onClick={() => setApplyFor(n)}>{n.online ? 'Дифф и применение…' : 'Не на связи'}</Button> },
  ];

  const histCols: TableColumnConfig<CheckRow>[] = [
    { id: 'ts', width: 150, name: 'Время', template: (c) => <span className="nowrap">{dateTime(c.ts)}</span> },
    { id: 'node', name: 'Нода', template: (c) => nodeName(c.nodeId) },
    { id: 'src', width: 170, name: () => <Hint label="Откуда" tip="Агент проверяет путь мост → выход. Панель — путь клиент → мост:443 с SNI маршрута, то есть что мост жив и доходит до выхода." />, template: (c) => (c.source === 'agent' ? `агент → ${exitName(c.exitId) || 'выход'}` : 'панель → мост') },
    { id: 'res', width: 120, name: 'Результат', template: (c) => <StatusDot tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'успешно' : 'ошибка'}</StatusDot> },
    { id: 'ms', align: 'end', width: 100, name: 'мс', template: (c) => (c.ms !== null ? Math.round(c.ms) : '—') },
    { id: 'err', name: 'Ошибка', template: (c) => <span className="mono secondary">{c.error ?? ''}</span> },
  ];

  return (
    <div className="page">
      <div className="crumbs">{crumbs(r.name)}</div>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <div className="page-title">
            <Text variant="header-2" as="h1">{r.name}</Text>
            <StatusDot tone={routeTone(r.enabled ? r.status : 'unknown')}>{r.enabled ? ROUTE_LABEL[r.status] : 'Выключен'}</StatusDot>
          </div>
          <Text color="secondary" as="div" style={{ marginTop: 4 }}>
            <span className="mono">be_{r.slug}</span> · SNI: <span className="mono">{r.snis.join(', ') || '—'}</span>
          </Text>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => run.mutate()} loading={run.isPending}><Icon data={ArrowRotateRight} size={16} />Проверить сейчас</Button>
          <Button onClick={() => setEditing(true)}>Изменить</Button>
          <Button view="outlined-danger" onClick={() => setDeleting(true)}>Удалить</Button>
        </div>
      </div>

      <div className="stack">
        <Text variant="subheader-3">Выходы</Text>
        <Text>{r.exits.map((e) => <span key={e.id} style={{ marginRight: 18 }}>{flag(e.country) && <span className="flag">{flag(e.country)}</span>}{e.name} <span className="mono secondary">{e.host}:{e.port}</span></span>)}{r.proxyProtocol && <Label size="s">PROXY v2</Label>}{!r.healthCheck && <Label size="s" theme="warning">без check</Label>}{r.limitMbit && <Label size="s" theme="info">≤ {r.limitMbit} Мбит/с</Label>}{r.ipLimitMbit && <Label size="s" theme="info">{r.ipLimitMbit} Мбит/с на IP</Label>}</Text>

        <Text variant="subheader-3" className="section-title">Ноды</Text>
        <div className="tbl"><Table columns={nodeCols} data={r.nodes} getRowId={(n) => n.nodeId} verticalAlign="middle" width="max" />
          {r.nodes.length === 0 && <EmptyHint title="Маршрут не привязан ни к одной ноде.">Откройте «Изменить» и выберите ноды.</EmptyHint>}</div>

        <Text variant="subheader-3" className="section-title"><Hint label="История проверок" tip="Последние 100 результатов. Агент проверяет каждые 30 секунд, панель — раз в 1,5 минуты." /></Text>
        <div className="tbl"><Table columns={histCols} data={history} getRowId={(c, i) => `${c.ts}-${c.nodeId}-${c.source}-${i}`} verticalAlign="middle" width="max" />
          {history.length === 0 && <EmptyHint title="Проверок ещё не было.">{r.healthCheck ? 'Результаты появятся через полминуты после применения конфига на ноду.' : 'У маршрута отключена проверка здоровья.'}</EmptyHint>}</div>
      </div>

      <RouteDialog open={editing} onClose={() => { setEditing(false); q.refetch(); }} route={r} />
      {applyFor && <ApplyDialog nodeId={applyFor.nodeId} nodeName={applyFor.nodeName} onClose={() => { setApplyFor(null); q.refetch(); }} />}
      <Dialog open={deleting} onOpenChange={(o) => !o && setDeleting(false)} maxWidth="s" fullWidth aria-labelledby="route-del">
        <Dialog.Header caption="Удалить маршрут?" id="route-del" />
        <Dialog.Body>
          <Text>Маршрут «{r.name}» исчезнет из конфига всех {r.nodeIds.length} нод после следующего применения. Выходы не удаляются.</Text>
          {del.isError && <div style={{ marginTop: 12 }}><Notice theme="danger">{(del.error as Error).message}</Notice></div>}
        </Dialog.Body>
        <Dialog.Footer onClickButtonCancel={() => setDeleting(false)} textButtonCancel="Отмена" onClickButtonApply={() => del.mutate()} textButtonApply="Удалить" loading={del.isPending} propsButtonApply={{ view: 'outlined-danger' }} />
      </Dialog>
    </div>
  );
}
