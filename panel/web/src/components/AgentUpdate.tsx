import { Button, Text } from '@gravity-ui/uikit';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type PublicNode } from '../lib/api';
import { newerVersion } from '../lib/format';
import { useSystem } from '../lib/queries';

export type UpdateState = { phase: 'idle' } | { phase: 'running' } | { phase: 'waiting'; to: string } | { phase: 'done'; to: string } | { phase: 'error'; message: string };

/** Нода, чей агент старше версии на панели и может быть обновлён по кнопке (или хотя бы нуждается в обновлении). */
export function useAgentRelease() {
  const sys = useSystem();
  const latest = sys.data?.release.version ?? null;
  return {
    latest,
    outdated: (n: Pick<PublicNode, 'agentVersion'>) => newerVersion(latest, n.agentVersion),
  };
}

export function useAgentUpdate(node: PublicNode) {
  const qc = useQueryClient();
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const target = useRef<string | null>(null);

  // после перезапуска агент переподключается уже новой версией — ловим её из обычного опроса нод
  useEffect(() => {
    if (state.phase === 'waiting' && node.agentVersion && !newerVersion(state.to, node.agentVersion) && node.status === 'online') {
      setState({ phase: 'done', to: node.agentVersion });
    }
  }, [state, node.agentVersion, node.status]);
  useEffect(() => {
    if (state.phase !== 'waiting') return;
    const t = window.setTimeout(() => setState({ phase: 'error', message: 'Агент не вернулся на связь за 90 секунд. Если он не поднимется, откат сделает сторож агента; проверьте journalctl -u popug-agent на мосту.' }), 90_000);
    const poll = window.setInterval(() => void qc.invalidateQueries({ queryKey: ['nodes'] }), 3_000);
    return () => { window.clearTimeout(t); window.clearInterval(poll); };
  }, [state.phase, qc]);

  const run = async (): Promise<boolean> => {
    setState({ phase: 'running' });
    try {
      const r = await api.post<{ to: string }>(`/api/nodes/${node.id}/agent/update`);
      target.current = r.to;
      setState({ phase: 'waiting', to: r.to });
      return true;
    } catch (e) {
      setState({ phase: 'error', message: e instanceof ApiError ? e.message : (e as Error).message });
      return false;
    }
  };
  return { state, run, reset: () => setState({ phase: 'idle' }) };
}

export function AgentUpdateButton({ node, size = 'm' }: { node: PublicNode; size?: 's' | 'm' }) {
  const { latest, outdated } = useAgentRelease();
  const { state, run } = useAgentUpdate(node);
  if (!latest || (!outdated(node) && state.phase === 'idle')) return null;
  const busy = state.phase === 'running' || state.phase === 'waiting';
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      {(outdated(node) || busy) && (
        <Button view="action" size={size} loading={busy} disabled={node.status !== 'online'} onClick={() => void run()}>
          {state.phase === 'waiting' ? 'Перезапускается…' : `Обновить до ${latest}`}
        </Button>
      )}
      {state.phase === 'done' && <Text color="positive">Обновлён до {state.to}</Text>}
      {state.phase === 'error' && <Text color="danger" variant="body-1">{state.message}</Text>}
    </span>
  );
}
