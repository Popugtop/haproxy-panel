import { COUNTRIES, flag } from '@popug/protocol/countries';
import { Dialog, Select, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, type ExitDto } from '../lib/api';
import { Field, Notice } from './ui';

export const COUNTRY_OPTIONS = Object.entries(COUNTRIES)
  .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
  .map(([code, name]) => ({ value: code, content: `${flag(code)} ${name}`, text: `${name} ${code}` }));

export function ExitDialog({ open, onClose, exit, onSaved }: { open: boolean; onClose: () => void; exit?: ExitDto; onSaved?: (e: ExitDto) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [country, setCountry] = useState<string[]>([]);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('443');

  useEffect(() => {
    if (!open) return;
    setName(exit?.name ?? '');
    setCountry(exit?.country ? [exit.country] : []);
    setHost(exit?.host ?? '');
    setPort(String(exit?.port ?? 443));
  }, [open, exit]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), country: country[0] ?? null, host: host.trim(), port: Number(port) };
      return exit ? api.patch<{ exit: ExitDto }>(`/api/exits/${exit.id}`, body) : api.post<{ exit: ExitDto }>('/api/exits', body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['exits'] });
      qc.invalidateQueries({ queryKey: ['routes'] });
      onSaved?.(r.exit);
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} maxWidth="s" fullWidth aria-labelledby="exit-title">
      <Dialog.Header caption={exit ? 'Выход' : 'Новый выход'} id="exit-title" />
      <Dialog.Body>
        <div className="stack">
          <Field label="Имя"><TextInput value={name} onUpdate={setName} placeholder="Германия 1" autoFocus /></Field>
          <Field label="Страна" help="Нужна для флага в названии маршрута."><Select value={country} onUpdate={setCountry} options={COUNTRY_OPTIONS} filterable width="max" placeholder="не указана" hasClear /></Field>
          <div className="form-grid">
            <Field label="Адрес выхода" help="IP-адрес зарубежной ноды."><TextInput value={host} onUpdate={setHost} placeholder="203.0.113.21" controlProps={{ className: 'mono' }} /></Field>
            <Field label="Порт"><TextInput value={port} onUpdate={setPort} controlProps={{ className: 'mono', inputMode: 'numeric' }} /></Field>
          </div>
          {exit && <Notice theme="info">Адрес и порт попадут в конфиг всех нод, где этот выход используется. Изменения нужно применить на каждой ноде.</Notice>}
          {save.isError && <Notice theme="danger">{save.error instanceof ApiError ? save.error.message : 'Не удалось сохранить выход'}</Notice>}
        </div>
      </Dialog.Body>
      <Dialog.Footer onClickButtonCancel={onClose} textButtonCancel="Отмена" onClickButtonApply={() => save.mutate()} textButtonApply="Сохранить" loading={save.isPending} propsButtonApply={{ disabled: !name.trim() || !host.trim() }} />
    </Dialog>
  );
}
