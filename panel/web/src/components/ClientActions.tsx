import { Button, Checkbox, Dialog, Select, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOnOpen } from '../lib/useOnOpen';
import { api, ApiError, type BanOutcome } from '../lib/api';
import { useNodes } from '../lib/queries';
import { ApplyDialog } from './ApplyDialog';
import { Field, Notice } from './ui';

export const DURATIONS = [
  { value: '900', content: '15 минут' },
  { value: '3600', content: '1 час' },
  { value: '21600', content: '6 часов' },
  { value: '86400', content: '24 часа' },
  { value: '604800', content: '7 дней' },
  { value: '2592000', content: '30 дней' },
];

/** Что обновить после действия над клиентами. */
export function useRefreshClients() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['clients', 'bans', 'limits', 'config', 'nodes', 'node']) qc.invalidateQueries({ queryKey: [k] });
  };
}

interface BanProps {
  open: boolean;
  onClose: () => void;
  /** IP заранее известен (из таблицы клиентов); иначе вводится вручную. */
  ip?: string;
  /** Ноды, выбранные по умолчанию. */
  nodeIds?: string[];
  durationSec?: number;
}

/** Бан IP: срок, ноды (одна, несколько или все), заметка. */
export function BanDialog({ open, onClose, ip: fixedIp, nodeIds: preset, durationSec }: BanProps) {
  const nodes = useNodes();
  const refresh = useRefreshClients();
  const [ip, setIp] = useState('');
  const [dur, setDur] = useState('86400');
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<BanOutcome[] | null>(null);

  useOnOpen(open, () => {
    setIp(fixedIp ?? '');
    setDur(String(durationSec ?? 86400));
    setSel(preset ?? []);
    setNote('');
    setResult(null);
  });

  const list = nodes.data?.nodes ?? [];
  const save = useMutation({
    mutationFn: () => api.post<{ outcomes: BanOutcome[] }>('/api/bans', { ip: ip.trim(), nodeIds: sel, durationSec: Number(dur), note: note.trim() || null }),
    onSuccess: (r) => {
      setResult(r.outcomes);
      refresh();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} maxWidth="s" fullWidth aria-labelledby="ban-title">
      <Dialog.Header caption={fixedIp ? `Забанить ${fixedIp}` : 'Забанить IP'} id="ban-title" />
      <Dialog.Body>
        <div className="stack">
          {!result && (
            <>
              {!fixedIp && <Field label="IP-адрес"><TextInput value={ip} onUpdate={setIp} placeholder="198.51.100.7" autoFocus controlProps={{ className: 'mono' }} /></Field>}
              <Field label="Срок"><Select value={[dur]} onUpdate={(v) => setDur(v[0] ?? '86400')} options={DURATIONS} width="max" /></Field>
              <Field label="На каких нодах" help="Клиент отбрасывается на самом мосту до HAProxy: соединений и трафика от него больше нет.">
                <div style={{ display: 'grid', gap: 6 }}>
                  <Checkbox checked={sel.length === list.length && list.length > 0} indeterminate={sel.length > 0 && sel.length < list.length} onUpdate={(c) => setSel(c ? list.map((n) => n.id) : [])} content="Все ноды" />
                  {list.map((n) => <Checkbox key={n.id} checked={sel.includes(n.id)} onUpdate={(c) => setSel(c ? [...sel, n.id] : sel.filter((x) => x !== n.id))} content={n.name} />)}
                </div>
              </Field>
              <Field label="Заметка (необязательно)"><TextInput value={note} onUpdate={setNote} placeholder="за что" /></Field>
              {save.isError && <Notice theme="danger">{save.error instanceof ApiError ? save.error.message : 'Не удалось забанить'}</Notice>}
            </>
          )}
          {result && result.map((o) => (
            <Notice key={o.nodeId} theme={o.error ? 'danger' : o.applied ? 'success' : 'warning'} title={o.nodeName}>
              {o.error ?? (o.applied ? 'Бан применён на ноде.' : 'Нода не на связи: бан сохранён и применится при её подключении.')}
            </Notice>
          ))}
        </div>
      </Dialog.Body>
      {result ? (
        <Dialog.Footer onClickButtonApply={onClose} textButtonApply="Готово" />
      ) : (
        <Dialog.Footer onClickButtonCancel={onClose} textButtonCancel="Отмена" onClickButtonApply={() => save.mutate()} textButtonApply="Забанить" loading={save.isPending} propsButtonApply={{ view: 'outlined-danger', disabled: !ip.trim() || sel.length === 0 }} />
      )}
    </Dialog>
  );
}

interface LimitProps {
  open: boolean;
  onClose: () => void;
  ip?: string;
  nodeIds?: string[];
  mbit?: number;
}

/** Персональный лимит скорости. Попадает в конфиг HAProxy, поэтому после сохранения предлагается применить. */
export function LimitDialog({ open, onClose, ip: fixedIp, nodeIds: preset, mbit: presetMbit }: LimitProps) {
  const nodes = useNodes();
  const refresh = useRefreshClients();
  const [ip, setIp] = useState('');
  const [mbit, setMbit] = useState('10');
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<{ id: string; name: string }[] | null>(null);
  const [applyFor, setApplyFor] = useState<{ id: string; name: string } | null>(null);

  useOnOpen(open, () => {
    setIp(fixedIp ?? '');
    setMbit(String(presetMbit ?? 10));
    setSel(preset ?? []);
    setNote('');
    setSaved(null);
  });

  const list = nodes.data?.nodes ?? [];
  const save = useMutation({
    mutationFn: () => api.post<{ nodes: { nodeId: string; nodeName: string }[] }>('/api/limits', { ip: ip.trim(), nodeIds: sel, mbit: Number(mbit), note: note.trim() || null }),
    onSuccess: (r) => {
      setSaved(r.nodes.map((n) => ({ id: n.nodeId, name: n.nodeName })));
      refresh();
    },
  });

  if (applyFor && open) return <ApplyDialog nodeId={applyFor.id} nodeName={applyFor.name} onClose={() => { setApplyFor(null); refresh(); }} />;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} maxWidth="s" fullWidth aria-labelledby="limit-title">
      <Dialog.Header caption={fixedIp ? `Лимит скорости для ${fixedIp}` : 'Лимит скорости для IP'} id="limit-title" />
      <Dialog.Body>
        <div className="stack">
          {!saved && (
            <>
              {!fixedIp && <Field label="IP-адрес"><TextInput value={ip} onUpdate={setIp} placeholder="198.51.100.7" autoFocus controlProps={{ className: 'mono' }} /></Field>}
              <Field label="Лимит, Мбит/с" help="Для скачивания и отдачи отдельно. За одним IP бывает много людей (CGNAT у мобильных), лимит они делят.">
                <TextInput value={mbit} onUpdate={setMbit} controlProps={{ className: 'mono', inputMode: 'numeric' }} />
              </Field>
              <Field label="На каких нодах" help="Работает на HAProxy 2.7 и новее.">
                <div style={{ display: 'grid', gap: 6 }}>
                  {list.map((n) => <Checkbox key={n.id} checked={sel.includes(n.id)} onUpdate={(c) => setSel(c ? [...sel, n.id] : sel.filter((x) => x !== n.id))} content={<>{n.name}{n.bwlimSupported === false && <Text color="secondary"> · HAProxy {n.haproxyVersion}, лимиты недоступны</Text>}</>} disabled={n.bwlimSupported === false} />)}
                </div>
              </Field>
              <Field label="Заметка (необязательно)"><TextInput value={note} onUpdate={setNote} placeholder="почему" /></Field>
              {save.isError && <Notice theme="danger">{save.error instanceof ApiError ? save.error.message : 'Не удалось сохранить лимит'}</Notice>}
            </>
          )}
          {saved && (
            <>
              <Text color="secondary">Лимит сохранён. Он действует через конфиг HAProxy, поэтому его нужно применить на каждой ноде: у каждой свой дифф.</Text>
              {saved.map((n) => (
                <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <Text variant="subheader-2">{n.name}</Text>
                  <Button view="action" onClick={() => setApplyFor(n)}>Дифф и применение…</Button>
                </div>
              ))}
            </>
          )}
        </div>
      </Dialog.Body>
      {saved ? (
        <Dialog.Footer onClickButtonApply={onClose} textButtonApply="Применю позже" />
      ) : (
        <Dialog.Footer onClickButtonCancel={onClose} textButtonCancel="Отмена" onClickButtonApply={() => save.mutate()} textButtonApply="Сохранить" loading={save.isPending} propsButtonApply={{ disabled: !ip.trim() || sel.length === 0 || !Number(mbit) }} />
      )}
    </Dialog>
  );
}
