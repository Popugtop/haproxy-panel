import { flag } from '@popug/protocol/countries';
import { Button, Checkbox, Dialog, Loader, Select, Text, TextInput } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, type ImportPreviewDto } from '../lib/api';
import { COUNTRY_OPTIONS } from './ExitDialog';
import { Notice } from './ui';

interface Row {
  backend: string;
  include: boolean;
  name: string;
  country: string;
  attach: boolean;
}

const nameFor = (slug: string, country: string) => (country ? `${COUNTRY_OPTIONS.find((c) => c.value === country)?.content.replace(/^\S+\s/, '') ?? slug} (${flag('RU')} → ${flag(country)})` : slug);

/** Импорт ручного конфига: предпросмотр, правка имён и стран, подтверждение. До подтверждения ничего не меняется. */
export function ImportDialog({ nodeId, nodeName, onClose, onDone }: { nodeId: string; nodeName: string; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [defaultBackend, setDefaultBackend] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: () => api.post<ImportPreviewDto>(`/api/nodes/${nodeId}/import/preview`),
    onSuccess: (p) => {
      setDefaultBackend(p.preview.defaultBackend);
      setRows(p.preview.routes.map((r) => ({ backend: r.backend, include: true, name: nameFor(r.slug, r.country), country: r.country, attach: !!p.matches[r.backend]?.routeId })));
    },
  });
  useEffect(() => preview.mutate(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const p = preview.data;
  const confirm = useMutation({
    mutationFn: () =>
      api.post<{ routes: number; attached: number; exits: number }>(`/api/nodes/${nodeId}/import/confirm`, {
        cfgSha256: p!.cfgSha256,
        defaultBackend,
        routes: p!.preview.routes
          .filter((r) => rows.find((x) => x.backend === r.backend)?.include)
          .map((r) => {
            const row = rows.find((x) => x.backend === r.backend)!;
            const m = p!.matches[r.backend];
            return {
              backend: r.backend, slug: r.slug, name: row.name.trim() || r.slug, snis: r.snis, proxyProtocol: r.proxyProtocol, healthCheck: r.healthCheck,
              attachToRouteId: row.attach && m?.routeId ? m.routeId : null,
              exits: r.exits.map((e) => ({ host: e.host, port: e.port, name: e.serverName, country: row.country || null })),
            };
          }),
      }),
    onSuccess: () => {
      for (const k of ['config', 'routes', 'exits', 'node', 'nodes']) qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
  });

  const set = (backend: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.backend === backend ? { ...r, ...patch } : r)));

  const columns: TableColumnConfig<Row>[] = [
    { id: 'inc', width: 44, name: '', template: (r) => <Checkbox checked={r.include} onUpdate={(v) => set(r.backend, { include: v })} /> },
    { id: 'b', name: 'Бэкенд', template: (r) => <span className="mono">{r.backend}</span> },
    { id: 'name', name: 'Название', template: (r) => <TextInput size="s" value={r.name} onUpdate={(v) => set(r.backend, { name: v })} disabled={r.attach} /> },
    { id: 'country', width: 190, name: 'Страна выхода', template: (r) => <Select size="s" value={r.country ? [r.country] : []} onUpdate={(v) => set(r.backend, { country: v[0] ?? '' })} options={COUNTRY_OPTIONS} filterable hasClear width="max" placeholder="не указана" disabled={r.attach} /> },
    { id: 'sni', name: 'SNI', template: (r) => <span className="mono">{p!.preview.routes.find((x) => x.backend === r.backend)!.snis.join(', ') || '—'}</span> },
    { id: 'exits', name: 'Выходы', template: (r) => <span className="mono">{p!.preview.routes.find((x) => x.backend === r.backend)!.exits.map((e) => `${e.host}:${e.port}`).join(', ')}</span> },
    { id: 'att', name: 'Уже в панели', template: (r) => {
      const m = p!.matches[r.backend];
      return m?.routeId ? <Checkbox checked={r.attach} onUpdate={(v) => set(r.backend, { attach: v })} content={`привязать к «${m.routeName}»`} /> : <Text color="secondary">новый</Text>;
    } },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} maxWidth="l" fullWidth aria-labelledby="import-title">
      <Dialog.Header caption={`Импорт конфига ноды «${nodeName}»`} id="import-title" />
      <Dialog.Body>
        <div className="stack">
          {preview.isPending && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Loader size="s" /><Text>Запрашиваю у агента текущий haproxy.cfg…</Text></div>}
          {preview.isError && <Notice theme="danger">{preview.error instanceof ApiError ? preview.error.message : 'Не удалось получить конфиг'}</Notice>}
          {p && (
            <>
              <Text color="secondary">Панель прочитала конфиг на ноде и ничего в нём не меняла. Проверьте найденные маршруты: после импорта они станут управляться панелью, а на ноду уйдёт сгенерированный конфиг только когда вы нажмёте «Применить» и увидите дифф.</Text>
              {p.preview.routes.length === 0 && <Notice theme="warning">SNI-маршрутов в конфиге не найдено. Можно пропустить импорт и создать маршруты вручную.</Notice>}
              {p.preview.routes.length > 0 && <div className="tbl"><Table columns={columns} data={rows} getRowId={(r) => r.backend} verticalAlign="middle" width="max" /></div>}
              {p.preview.routes.length > 0 && (
                <Select
                  label="Неизвестный SNI: "
                  value={[defaultBackend ?? '']}
                  onUpdate={(v) => setDefaultBackend(v[0] || null)}
                  options={[{ value: '', content: 'закрывать соединение (reject)' }, ...p.preview.routes.map((r) => ({ value: r.backend, content: `отправлять в ${r.backend}` }))]}
                  width="max"
                />
              )}
              {p.preview.warnings.length > 0 && <Notice theme="warning" title="Что стоит проверить">{p.preview.warnings.map((w, i) => <div key={i}>{w}</div>)}</Notice>}
              {p.preview.ignoredSections.length > 0 && (
                <Notice theme="info" title="Исчезнет из конфига при применении">
                  {p.preview.ignoredSections.map((s) => <div key={s.kind + s.name}><span className="mono">{s.kind} {s.name}</span> — {s.note}</div>)}
                  <div style={{ marginTop: 6 }}>Нужное оставьте в «Своих директивах» в настройках ноды: они дописываются в конец конфига как есть.</div>
                </Notice>
              )}
              {confirm.isError && <Notice theme="danger">{confirm.error instanceof ApiError ? confirm.error.message : 'Импорт не удался'}</Notice>}
            </>
          )}
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonCancel={onClose}
        textButtonCancel="Отмена"
        {...(p && p.preview.routes.length > 0 ? { onClickButtonApply: () => confirm.mutate(), textButtonApply: 'Импортировать', loading: confirm.isPending, propsButtonApply: { disabled: !rows.some((r) => r.include) } } : {})}
      >
        {p && <Button view="flat" onClick={() => preview.mutate()} loading={preview.isPending}>Прочитать заново</Button>}
      </Dialog.Footer>
    </Dialog>
  );
}
