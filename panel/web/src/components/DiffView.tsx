import { Text } from '@gravity-ui/uikit';
import { structuredPatch } from 'diff';
import { useMemo } from 'react';

interface Props {
  title: string;
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}

/** Построчный дифф с тремя строками контекста. Зелёное — появится на ноде, красное — исчезнет. */
export function DiffView({ title, before, after, beforeLabel = 'сейчас на ноде', afterLabel = 'будет' }: Props) {
  const { hunks, added, removed } = useMemo(() => {
    const p = structuredPatch(beforeLabel, afterLabel, before, after, '', '', { context: 3 });
    let a = 0;
    let r = 0;
    for (const h of p.hunks) for (const l of h.lines) l.startsWith('+') ? a++ : l.startsWith('-') ? r++ : 0;
    return { hunks: p.hunks, added: a, removed: r };
  }, [before, after, beforeLabel, afterLabel]);

  return (
    <div className="diff">
      <div className="diff-head">
        <Text variant="subheader-2">{title}</Text>
        {hunks.length === 0 ? <Text color="secondary">без изменений</Text> : <Text color="secondary"><span style={{ color: 'var(--g-color-text-positive)' }}>+{added}</span> <span style={{ color: 'var(--g-color-text-danger)' }}>−{removed}</span></Text>}
      </div>
      {hunks.length > 0 && (
        <pre className="diff-body">
          {hunks.map((h, i) => (
            <div key={i}>
              <div className="diff-hunk">@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
              {h.lines.map((l, j) => (
                <div key={j} className={l[0] === '+' ? 'diff-add' : l[0] === '-' ? 'diff-del' : 'diff-ctx'}>
                  <span className="diff-sign">{l[0] === ' ' ? ' ' : l[0]}</span>
                  {l.slice(1) || ' '}
                </div>
              ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
