import { CircleCheck } from '@gravity-ui/icons';
import { Button, Dialog, Icon, Loader, Text } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type ApplyReply } from '../lib/api';
import { useNodeConfig } from '../lib/queries';
import { DiffView } from './DiffView';
import { Notice } from './ui';

/**
 * Дифф и применение для ОДНОЙ ноды. У каждой ноды свой дифф, своя попытка и свой откат:
 * неудача на одной не мешает применить другую.
 */
export function ApplyDialog({ nodeId, nodeName, onClose }: { nodeId: string; nodeName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useNodeConfig(nodeId, 3000);
  const [validation, setValidation] = useState<{ ok: boolean; error: string | null; output: string } | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['config', nodeId] });
    qc.invalidateQueries({ queryKey: ['routes'] });
    qc.invalidateQueries({ queryKey: ['node', nodeId] });
    qc.invalidateQueries({ queryKey: ['nodes'] });
  };

  const validate = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error: string | null; output: string }>(`/api/nodes/${nodeId}/config/validate`, { expectedHash: q.data!.desired.sha256 }),
    onSuccess: setValidation,
  });
  const apply = useMutation({
    mutationFn: () => api.post<ApplyReply>(`/api/nodes/${nodeId}/config/apply`, { expectedHash: q.data!.desired.sha256 }),
    onSettled: refresh,
  });

  const s = q.data;
  const result = apply.data;
  const err = apply.error instanceof ApiError ? apply.error : null;
  const done = !!result?.ok;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} maxWidth="l" fullWidth aria-labelledby="apply-title">
      <Dialog.Header caption={`Применение на «${nodeName}»`} id="apply-title" />
      <Dialog.Body>
        <div className="stack">
          {q.isPending && <Loader size="m" />}
          {q.isError && <Notice theme="danger">{(q.error as Error).message}</Notice>}

          {s && !apply.isPending && !result && (
            <>
              {!s.applied && <Notice theme="warning">Панель ещё не применяла конфиг на эту ноду. Если на ней лежит ручной конфиг, сначала импортируйте его на вкладке «Конфиг»: иначе он будет заменён целиком.</Notice>}
              {s.inSync && <Notice theme="success">На ноде уже то, что хочет панель (версия {s.applied?.number}). Применять нечего.</Notice>}
              {!s.inSync && (
                <>
                  <Text color="secondary">Сначала посмотрите, что изменится на ноде. Конфиг проверяется командой <span className="mono">haproxy -c</span>, затем атомарно заменяется и перезагружается. Если HAProxy не поднимется за 12 секунд, вернётся прежний конфиг.</Text>
                  <DiffView title="haproxy.cfg" before={s.applied?.cfg ?? ''} after={s.desired.cfg} />
                  <DiffView title="maps/sni.map" before={s.applied?.sniMap ?? ''} after={s.desired.sniMap} />
                </>
              )}
              {validation && <Notice theme={validation.ok ? 'success' : 'danger'} title={validation.ok ? 'Конфиг прошёл проверку' : 'Проверка не прошла'}>{validation.error ?? ''}<pre className="output" style={{ marginTop: 8 }}>{validation.output}</pre></Notice>}
              {validate.isError && <Notice theme="danger">{(validate.error as Error).message}</Notice>}
            </>
          )}

          {apply.isPending && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Loader size="m" />
              <Text>Применяю{s ? ` версию ${s.expected}` : ''}: проверка, замена, перезагрузка HAProxy… Это занимает несколько секунд, при откате до 15.</Text>
            </div>
          )}

          {done && (
            <Notice theme="success" title={`Версия ${result!.version?.number} применена`}>
              <Icon data={CircleCheck} size={14} /> HAProxy перезагружен и работает на новом конфиге ({result!.version?.durationMs ? `${Math.round(result!.version.durationMs)} мс` : 'готово'}).
            </Notice>
          )}
          {result && !result.ok && (
            <Notice theme="danger" title={result.rolledBack ? `Версия ${result.version?.number ?? ''} не применилась, нода откатилась` : 'Применить не удалось'}>
              {result.error}
              {result.output && <pre className="output" style={{ marginTop: 8 }}>{result.output}</pre>}
            </Notice>
          )}
          {err && <Notice theme="danger" title={err.code === 'changed' ? 'Маршруты изменились' : 'Применить не удалось'}>{err.message}</Notice>}
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonCancel={onClose}
        textButtonCancel={result || err ? 'Закрыть' : 'Отмена'}
        {...(!done && s && !s.inSync && !apply.isPending
          ? { onClickButtonApply: () => apply.mutate(), textButtonApply: result && !result.ok ? 'Повторить' : 'Применить на ноду', loading: apply.isPending }
          : {})}
      >
        {!done && s && !s.inSync && !apply.isPending && !result && <Button view="outlined" onClick={() => validate.mutate()} loading={validate.isPending}>Проверить без применения</Button>}
      </Dialog.Footer>
    </Dialog>
  );
}
