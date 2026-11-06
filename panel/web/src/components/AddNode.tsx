import { CircleCheck } from '@gravity-ui/icons';
import { ClipboardButton, Dialog, Icon, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type Enrollment, type NodeDetail, type PublicNode } from '../lib/api';
import { dateTime } from '../lib/format';
import { emptyForm, formToBody, NodeFields, type NodeFormValues } from './NodeForm';
import { Notice } from './ui';

export function CommandBox({ text }: { text: string }) {
  return (
    <div className="copybox">
      <code>{text}</code>
      <ClipboardButton text={text} size="s" />
    </div>
  );
}

/** Окно с командой установки: показывает токен один раз и ждёт подключения агента. */
export function InstallDialog({ nodeId, enrollment, onClose }: { nodeId: string; enrollment: Enrollment; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['node', nodeId, 'install-wait'],
    queryFn: () => api.get<NodeDetail>(`/api/nodes/${nodeId}`),
    refetchInterval: 2500,
  });
  const connected = q.data?.node.status === 'online';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} maxWidth="m" fullWidth aria-labelledby="install-title">
      <Dialog.Header caption="Установка агента на мост" id="install-title" />
      <Dialog.Body>
        <div className="stack">
          <Text>Выполните на мосту от root. Скрипт поставит HAProxy (если его нет), агент и юнит systemd. Существующий <span className="mono">haproxy.cfg</span> он не меняет.</Text>
          <CommandBox text={enrollment.command} />
          <Notice theme="warning">Токен одноразовый, действует до {dateTime(enrollment.expiresAt)} и больше не будет показан. Новый можно выпустить на вкладке «Агент».</Notice>
          {connected ? (
            <Text color="positive"><Icon data={CircleCheck} size={16} /> Агент подключился{q.data?.node.agentVersion ? `, версия ${q.data.node.agentVersion}` : ''}</Text>
          ) : (
            <Text color="secondary">Жду подключения агента…</Text>
          )}
        </div>
      </Dialog.Body>
      <Dialog.Footer onClickButtonApply={onClose} textButtonApply={connected ? 'Готово' : 'Закрыть'} />
    </Dialog>
  );
}

/** onFinished вызывается после закрытия окна с командой установки (нода к тому моменту уже создана). */
export function AddNodeDialog({ open, onClose, onFinished }: { open: boolean; onClose: () => void; onFinished?: (n: PublicNode) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<NodeFormValues>(emptyForm);
  const [created, setCreated] = useState<{ node: PublicNode; enrollment: Enrollment } | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ node: PublicNode; enrollment: Enrollment }>('/api/nodes', formToBody(form)),
    onSuccess: (r) => {
      setCreated(r);
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  const close = () => {
    const done = created?.node;
    setCreated(null);
    setForm(emptyForm);
    create.reset();
    onClose();
    if (done) onFinished?.(done);
  };

  if (created) return <InstallDialog nodeId={created.node.id} enrollment={created.enrollment} onClose={close} />;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} maxWidth="m" fullWidth aria-labelledby="add-title">
      <Dialog.Header caption="Добавить ноду" id="add-title" />
      <Dialog.Body>
        <div className="stack">
          <NodeFields value={form} onChange={setForm} />
          {create.isError && <Notice theme="danger">{create.error instanceof ApiError ? create.error.message : 'Не удалось создать ноду'}</Notice>}
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonCancel={close}
        textButtonCancel="Отмена"
        onClickButtonApply={() => create.mutate()}
        textButtonApply="Создать и получить команду"
        loading={create.isPending}
        propsButtonApply={{ disabled: !form.name.trim() }}
      />
    </Dialog>
  );
}
