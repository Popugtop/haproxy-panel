import { Dialog, Loader, Tab, TabList, TabProvider, Text } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ExitRow, type FirewallHints } from '../lib/api';
import { CommandBox } from './AddNode';
import { Notice } from './ui';

/** Готовые команды для фаервола выхода: открыть его порт для мостов, у которых есть маршрут на этот выход. */
export function FirewallDialog({ exit, onClose }: { exit: ExitRow | null; onClose: () => void }) {
  const [kind, setKind] = useState<'ufw' | 'iptables'>('ufw');
  const q = useQuery({
    queryKey: ['exit-firewall', exit?.id],
    queryFn: () => api.get<FirewallHints>(`/api/exits/${exit!.id}/firewall`),
    enabled: !!exit,
  });
  const d = q.data;
  const cmd = d ? d[kind] : '';
  return (
    <Dialog open={!!exit} onOpenChange={(o) => !o && onClose()} maxWidth="m" fullWidth aria-labelledby="fw-title">
      <Dialog.Header caption={`Фаервол выхода «${exit?.name ?? ''}»`} id="fw-title" />
      <Dialog.Body>
        <div className="stack">
          {q.isPending && <Loader size="m" />}
          {q.isError && <Notice theme="danger">{(q.error as Error).message}</Notice>}
          {d && (
            <>
              <Text color="secondary">
                Выполните на сервере выхода (<span className="mono">{exit?.host}</span>) от root. Откроется порт <span className="mono">{d.port}</span> только для мостов, у которых есть включённый маршрут на этот выход. Список строится из маршрутов, поэтому после добавления маршрута или моста откройте это окно снова.
              </Text>
              {d.bridges.length === 0 ? (
                <Notice theme="info">Пока нет ни одного моста с включённым маршрутом на этот выход и известным IP: открывать порт некому.</Notice>
              ) : (
                <>
                  <TabProvider value={kind} onUpdate={(v) => setKind(v as 'ufw' | 'iptables')}>
                    <TabList>
                      <Tab value="ufw">ufw</Tab>
                      <Tab value="iptables">iptables</Tab>
                    </TabList>
                  </TabProvider>
                  <CommandBox text={cmd} />
                  <Text color="secondary">
                    Мосты: {d.bridges.map((b) => `${b.name} (${b.ip})`).join(', ')}.
                    {kind === 'iptables' && ' Правила iptables пропадают после перезагрузки, если их не сохранить (например, через iptables-persistent).'}
                  </Text>
                </>
              )}
              {d.noIp.length > 0 && (
                <Notice theme="warning" title="Не хватает IP">
                  У мостов {d.noIp.join(', ')} не задан IP, поэтому для них правил нет. Укажите IP на странице ноды или дождитесь подключения агента.
                </Notice>
              )}
            </>
          )}
        </div>
      </Dialog.Body>
      <Dialog.Footer onClickButtonApply={onClose} textButtonApply="Готово" />
    </Dialog>
  );
}
