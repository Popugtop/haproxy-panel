import { Button, Text } from '@gravity-ui/uikit';
import type { ApplyTarget } from '../lib/api';

/** Строки «нода — применить»: у каждой ноды свой дифф и свой откат. */
export function ApplyTargetRows({ targets, onApply }: { targets: ApplyTarget[]; onApply: (t: ApplyTarget) => void }) {
  return (
    <>
      {targets.map((n) => (
        <div key={n.nodeId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--g-color-line-generic)' }}>
          <div>
            <Text variant="subheader-2">{n.nodeName}</Text>
            <div>
              <Text color={n.pendingApply ? 'warning' : 'positive'}>
                {n.removed ? (n.pendingApply ? 'маршрут убран, на ноде ещё старый конфиг' : 'маршрут убран, актуально') : n.pendingApply ? 'ожидает применения' : 'актуально'}
              </Text>
            </div>
          </div>
          <Button view={n.pendingApply ? 'action' : 'outlined'} disabled={!n.online} onClick={() => onApply(n)}>{n.online ? 'Дифф и применение…' : 'Нода не на связи'}</Button>
        </div>
      ))}
    </>
  );
}
