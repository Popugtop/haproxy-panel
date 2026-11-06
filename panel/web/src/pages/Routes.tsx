import { Plus } from '@gravity-ui/icons';
import { Button, Icon, Text } from '@gravity-ui/uikit';
import { useState } from 'react';
import { EmptyHint, Notice } from '../components/ui';
import { RouteDialog } from '../components/RouteDialog';
import { RoutesTable } from '../components/RoutesTable';
import { useNodes, useRoutes } from '../lib/queries';

export function RoutesPage() {
  const q = useRoutes();
  const nodes = useNodes();
  const [adding, setAdding] = useState(false);
  const routes = q.data?.routes ?? [];
  const empty = !q.isPending && routes.length === 0;
  const noNodes = !nodes.isPending && (nodes.data?.nodes.length ?? 0) === 0;
  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Маршруты</Text>
        {!empty && <Button view="action" onClick={() => setAdding(true)}><Icon data={Plus} size={16} />Добавить маршрут</Button>}
      </div>
      {q.isError && <Notice theme="danger">Не удалось загрузить маршруты: {(q.error as Error).message}</Notice>}
      <RoutesTable
        routes={routes}
        empty={
          q.isPending ? <EmptyHint title="Загружаю…" /> : empty ? (
            <EmptyHint
              title="Маршрутов пока нет."
              action={<Button view="action" size="m" onClick={() => setAdding(true)} disabled={noNodes}><Icon data={Plus} size={16} />Добавить маршрут</Button>}
            >
              {noNodes ? 'Сначала подключите мост на странице «Ноды».' : 'Маршрут связывает SNI с зарубежным выходом и раскатывается на выбранные мосты.'}
            </EmptyHint>
          ) : null
        }
      />
      <RouteDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
