import { Plus } from '@gravity-ui/icons';
import { Button, Icon, Label, Text } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AddNodeDialog } from '../components/AddNode';
import { AgentUpdateButton, useAgentRelease } from '../components/AgentUpdate';
import { EmptyHint, Hint, Notice, RouterLink, StatusDot } from '../components/ui';
import { api, type NodeSummary } from '../lib/api';
import { ago, int } from '../lib/format';
import { useNodes } from '../lib/queries';
import { nodeState } from '../lib/state';

export function NodesPage() {
  const q = useNodes();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const nodes = q.data?.nodes ?? [];
  const empty = !q.isPending && nodes.length === 0;
  const { latest, outdated } = useAgentRelease();
  const stale = nodes.filter((n) => n.status === 'online' && outdated(n) && n.ops.includes('update_agent'));
  const [bulk, setBulk] = useState<{ done: number; total: number; errors: string[] } | null>(null);
  const updateAll = async () => {
    const list = [...stale];
    setBulk({ done: 0, total: list.length, errors: [] });
    const errors: string[] = [];
    for (const [i, n] of list.entries()) {
      try {
        await api.post(`/api/nodes/${n.id}/agent/update`);
      } catch (e) {
        errors.push(`${n.name}: ${(e as Error).message}`);
      }
      setBulk({ done: i + 1, total: list.length, errors: [...errors] });
    }
  };

  const columns: TableColumnConfig<NodeSummary>[] = [
    { id: 'state', name: 'Состояние', template: (n) => { const s = nodeState(n); return <StatusDot tone={s.tone}>{s.label}</StatusDot>; } },
    { id: 'name', name: 'Нода', template: (n) => (
      <div className="cell-name">
        <RouterLink to={`/nodes/${n.id}`}>{n.name}</RouterLink>
        <span className="mono secondary">{n.domain ?? '—'}</span>
      </div>
    ) },
    { id: 'ip', name: 'IP', template: (n) => <span className="mono">{n.ip ?? '—'}</span> },
    { id: 'hoster', name: 'Хостер', template: (n) => n.hoster ?? '—' },
    { id: 'haproxy', name: () => <Hint label="HAProxy" tip="Версия HAProxy на мосту. Лимиты скорости (bwlim) работают с версии 2.7" />, template: (n) => (
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        {n.haproxyInstalled === false ? <Label theme="warning" size="s">не установлен</Label> : <span className="mono">{n.haproxyVersion ?? '—'}</span>}
        {n.bwlimSupported === false && <Label size="s" title="Лимиты скорости работают только на HAProxy 2.7 и новее">без bwlim</Label>}
      </span>
    ) },
    { id: 'online', align: 'end', name: () => <Hint label="IP онлайн" tip="Клиентские IP с соединениями или трафиком за последнюю минуту" />, template: (n) => (n.status === 'online' && n.live?.activeClients != null ? int(n.live.activeClients) : '—') },
    { id: 'agent', name: 'Агент', template: (n) => (
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
        <span className="mono">{n.agentVersion ?? '—'}</span>
        {outdated(n) && <Label theme="warning" size="s" title={`На панели лежит ${latest}`}>устарел</Label>}
      </span>
    ) },
    { id: 'seen', name: 'На связи', template: (n) => (n.status === 'online' ? 'сейчас' : ago(n.lastSeenAt)) },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Ноды</Text>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          {stale.length > 0 && <Button view="outlined" loading={!!bulk && bulk.done < bulk.total} onClick={() => void updateAll()}>Обновить агентов ({stale.length})</Button>}
          {!empty && <Button view="action" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить ноду</Button>}
        </span>
      </div>
      {bulk && bulk.done === bulk.total && bulk.errors.length === 0 && <Notice theme="success">Обновление отправлено на {bulk.total} нод. Агенты перезапускаются и вернутся на связь за пару секунд.</Notice>}
      {bulk && bulk.errors.length > 0 && <Notice theme="danger" title="Не всё обновилось">{bulk.errors.join('; ')}</Notice>}
      {q.isError && <Notice theme="danger">Не удалось загрузить ноды: {(q.error as Error).message}</Notice>}
      <div className="tbl tbl-link">
        <Table columns={columns} data={nodes} getRowId={(n) => n.id} onRowClick={(n) => nav(`/nodes/${n.id}`)} getRowDescriptor={() => ({ interactive: true })} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Загружаю…" />}
        {empty && (
          <EmptyHint
            title="Нод нет."
            action={<Button view="action" size="m" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить ноду</Button>}
          >
            Создайте ноду, скопируйте команду и выполните её на мосту.
          </EmptyHint>
        )}
      </div>
      <AddNodeDialog open={adding} onClose={() => setAdding(false)} onFinished={(n) => nav(`/nodes/${n.id}`)} />
    </div>
  );
}
