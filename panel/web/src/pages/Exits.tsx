import { flag, countryName } from '@popug/protocol/countries';
import { Plus } from '@gravity-ui/icons';
import { Button, Dialog, Icon, Text } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ExitDialog } from '../components/ExitDialog';
import { FirewallDialog } from '../components/FirewallDialog';
import { EmptyHint, Notice } from '../components/ui';
import { api, ApiError, type ExitRow } from '../lib/api';
import { useExits } from '../lib/queries';

export function ExitsPage() {
  const qc = useQueryClient();
  const q = useExits();
  const [edit, setEdit] = useState<ExitRow | 'new' | null>(null);
  const [del, setDel] = useState<ExitRow | null>(null);
  const [fw, setFw] = useState<ExitRow | null>(null);
  const exits = q.data?.exits ?? [];
  const empty = !q.isPending && exits.length === 0;

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/exits/${id}`),
    onSuccess: () => {
      setDel(null);
      qc.invalidateQueries({ queryKey: ['exits'] });
    },
  });

  const columns: TableColumnConfig<ExitRow>[] = [
    { id: 'name', name: 'Выход', template: (e) => <b>{e.name}</b> },
    { id: 'country', name: 'Страна', template: (e) => (e.country ? <span><span className="flag">{flag(e.country)}</span>{countryName(e.country)}</span> : <span className="secondary">—</span>) },
    { id: 'addr', name: 'Адрес', template: (e) => <span className="mono">{e.host}:{e.port}</span> },
    { id: 'routes', align: 'end', width: 110, name: 'Маршрутов', template: (e) => e.routes },
    { id: 'act', align: 'end', width: 300, name: '', template: (e) => (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <Button size="s" view="outlined" onClick={() => setFw(e)}>Фаервол</Button>
        <Button size="s" view="outlined" onClick={() => setEdit(e)}>Изменить</Button>
        <Button size="s" view="flat-danger" onClick={() => setDel(e)}>Удалить</Button>
      </span>
    ) },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Выходы</Text>
        {!empty && <Button view="action" onClick={() => setEdit('new')}><Icon data={Plus} size={16} />Добавить выход</Button>}
      </div>
      {q.isError && <Notice theme="danger">Не удалось загрузить выходы: {(q.error as Error).message}</Notice>}
      <div className="tbl">
        <Table columns={columns} data={exits} getRowId={(e) => e.id} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Загружаю…" />}
        {empty && <EmptyHint title="Выходов пока нет." action={<Button view="action" size="m" onClick={() => setEdit('new')}><Icon data={Plus} size={16} />Добавить выход</Button>}>Выход — зарубежная нода, на которую мост пробрасывает соединения. Один выход можно использовать в нескольких маршрутах.</EmptyHint>}
      </div>
      <FirewallDialog exit={fw} onClose={() => setFw(null)} />
      <ExitDialog open={edit !== null} onClose={() => setEdit(null)} exit={edit && edit !== 'new' ? edit : undefined} />
      <Dialog open={!!del} onOpenChange={(o) => !o && setDel(null)} maxWidth="s" fullWidth aria-labelledby="exit-del">
        <Dialog.Header caption="Удалить выход?" id="exit-del" />
        <Dialog.Body>
          <Text>«{del?.name}» ({del?.host}:{del?.port}) будет удалён. {del && del.routes > 0 ? 'Он используется в маршрутах, поэтому удалить его не получится: сначала уберите его из них.' : ''}</Text>
          {remove.isError && <div style={{ marginTop: 12 }}><Notice theme="danger">{remove.error instanceof ApiError ? remove.error.message : 'Не удалось удалить'}</Notice></div>}
        </Dialog.Body>
        <Dialog.Footer onClickButtonCancel={() => setDel(null)} textButtonCancel="Отмена" onClickButtonApply={() => del && remove.mutate(del.id)} textButtonApply="Удалить" loading={remove.isPending} propsButtonApply={{ view: 'outlined-danger' }} />
      </Dialog>
    </div>
  );
}
