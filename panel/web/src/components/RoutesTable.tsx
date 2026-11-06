import { flag } from '@popug/protocol/countries';
import { Label } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useNavigate } from 'react-router-dom';
import type { RouteDto } from '../lib/api';
import { ROUTE_LABEL, routeTone } from '../lib/state';
import { Hint, RouterLink, StatusDot } from './ui';

/** Таблица маршрутов. Если указан nodeId — статус и применение показываются для этой ноды, иначе сводно по всем. */
export function RoutesTable({ routes, nodeId, empty }: { routes: RouteDto[]; nodeId?: string; empty?: React.ReactNode }) {
  const nav = useNavigate();
  const columns: TableColumnConfig<RouteDto>[] = [
    { id: 'status', width: 170, name: () => <Hint label="Состояние" tip="Зелёный: проверки проходят. Жёлтый: часть проверок не прошла или рукопожатие медленное. Красный: мост не доходит до выхода или недоступен снаружи." />, template: (r) => {
      const ns = nodeId ? r.nodes.find((n) => n.nodeId === nodeId) : undefined;
      const tone = !r.enabled ? 'unknown' : ns ? ns.tone : r.status;
      return <StatusDot tone={routeTone(tone)} detail={!r.enabled ? 'выключен' : undefined}>{ROUTE_LABEL[tone]}</StatusDot>;
    } },
    { id: 'name', name: 'Маршрут', template: (r) => (
      <div className="cell-name">
        <RouterLink to={`/routes/${r.id}`}>{r.name}</RouterLink>
        <span className="mono secondary">be_{r.slug}</span>
      </div>
    ) },
    { id: 'sni', name: 'SNI', template: (r) => (
      <span className="mono">{r.snis[0] ?? '—'}{r.snis.length > 1 && <span className="secondary"> +{r.snis.length - 1}</span>}</span>
    ) },
    { id: 'exits', name: 'Выходы', template: (r) => (
      <div className="cell-name">
        {r.exits.map((e) => <span key={e.id}>{flag(e.country) && <span className="flag">{flag(e.country)}</span>}{e.name} <span className="mono secondary">{e.host}:{e.port}</span></span>)}
        {r.exits.length === 0 && <span className="secondary">нет</span>}
      </div>
    ) },
    nodeId
      ? { id: 'apply', width: 170, name: 'Конфиг на ноде', template: (r) => { const n = r.nodes.find((x) => x.nodeId === nodeId); return n?.pendingApply ? <Label theme="warning" size="s">ожидает применения</Label> : <span className="secondary">актуален</span>; } }
      : { id: 'nodes', name: 'Ноды', template: (r) => (
        <span className="chips">
          {r.nodes.map((n) => <Label key={n.nodeId} size="s" theme={n.pendingApply ? 'warning' : 'normal'} title={n.pendingApply ? 'изменения ещё не применены на ноде' : undefined}>{n.nodeName.split(' · ')[0]}</Label>)}
          {r.nodes.length === 0 && <span className="secondary">не привязан</span>}
        </span>
      ) },
    { id: 'flags', width: 250, name: 'Параметры', template: (r) => (
      <span className="chips">
        {r.proxyProtocol && <Label size="s">PROXY v2</Label>}
        {!r.healthCheck && <Label size="s" theme="warning">без check</Label>}
        {r.limitMbit && <Label size="s" theme="info" title="Общий потолок скорости маршрута на одной ноде">≤ {r.limitMbit} Мбит/с</Label>}
        {r.ipLimitMbit && <Label size="s" theme="info" title="Лимит на каждый IP в этом маршруте">{r.ipLimitMbit} Мбит/с на IP</Label>}
        {!r.enabled && <Label size="s" theme="unknown">выключен</Label>}
      </span>
    ) },
  ];
  return (
    <div className="tbl tbl-link">
      <Table columns={columns} data={routes} getRowId={(r) => r.id} onRowClick={(r) => nav(`/routes/${r.id}`)} getRowDescriptor={() => ({ interactive: true })} verticalAlign="middle" width="max" />
      {routes.length === 0 && empty}
    </div>
  );
}
