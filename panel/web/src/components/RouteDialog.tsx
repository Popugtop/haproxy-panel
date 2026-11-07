import { flag, routeNameFor } from '@popug/protocol/countries';
import { Button, Dialog, Label, Select, Switch, Text, TextArea, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, ApiError, type ExitDto, type RouteDto, type RouteInput } from '../lib/api';
import { useExits, useNodes, useRoutes } from '../lib/queries';
import { useOnOpen } from '../lib/useOnOpen';
import { ApplyDialog } from './ApplyDialog';
import { ExitDialog } from './ExitDialog';
import { Field, Notice } from './ui';

const parseSnis = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
export const exitLabel = (e: ExitDto): string => `${flag(e.country) ? flag(e.country) + ' ' : ''}${e.name} · ${e.host}:${e.port}`;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Редактируемый маршрут; без него — создание. */
  route?: RouteDto;
  /** Ноды, выбранные при создании (например, нода, со страницы которой нажали «Добавить маршрут»). */
  presetNodeIds?: string[];
}

export function RouteDialog({ open, onClose, route, presetNodeIds }: Props) {
  const qc = useQueryClient();
  const exits = useExits();
  const nodes = useNodes();
  const routes = useRoutes();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [snis, setSnis] = useState('');
  const [exitIds, setExitIds] = useState<string[]>([]);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [proxy, setProxy] = useState(true);
  const [health, setHealth] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState('');
  const [ipLimit, setIpLimit] = useState('');
  const [touched, setTouched] = useState({ name: false, slug: false, snis: false });
  const [newExit, setNewExit] = useState(false);
  const [saved, setSaved] = useState<RouteDto | null>(null);
  const [applyNode, setApplyNode] = useState<{ id: string; name: string } | null>(null);

  useOnOpen(open, () => {
    setSaved(null);
    setName(route?.name ?? '');
    setSlug(route?.slug ?? '');
    setSnis(route?.snis.join('\n') ?? '');
    setExitIds(route?.exits.map((e) => e.id) ?? []);
    setNodeIds(route?.nodeIds ?? presetNodeIds ?? []);
    setProxy(route?.proxyProtocol ?? true);
    setHealth(route?.healthCheck ?? true);
    setEnabled(route?.enabled ?? true);
    setLimit(route?.limitMbit ? String(route.limitMbit) : '');
    setIpLimit(route?.ipLimitMbit ? String(route.ipLimitMbit) : '');
    setTouched({ name: !!route, slug: !!route, snis: !!route });
  });

  const exitList = exits.data?.exits ?? [];
  const takenSlugs = useMemo(() => new Set((routes.data?.routes ?? []).filter((r) => r.id !== route?.id).map((r) => r.slug)), [routes.data, route]);

  // Домен для подсказки SNI: самый частый «хвост» после первой точки у SNI существующих маршрутов (de.popug.cloud → popug.cloud).
  const suffix = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of routes.data?.routes ?? []) for (const sni of r.snis) {
      const d = sni.split('.').slice(1).join('.');
      if (d.includes('.')) count.set(d, (count.get(d) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }, [routes.data]);
  const suggestSni = (slugValue: string) => (!touched.snis && suffix && slugValue ? setSnis(`${slugValue}.${suffix}`) : undefined);

  // Подсказки по первому выбранному выходу: имя «Германия (🇷🇺 → 🇩🇪)», идентификатор de, SNI de.<домен>.
  const onExits = (ids: string[]) => {
    setExitIds(ids);
    const first = exitList.find((e) => e.id === ids[0]);
    if (!first?.country) return;
    if (!touched.name) setName(routeNameFor(first.country));
    if (!touched.slug) {
      let s = first.country.toLowerCase();
      for (let n = 2; takenSlugs.has(s); n++) s = `${first.country.toLowerCase()}${n}`;
      setSlug(s);
      suggestSni(s);
    }
  };

  const mbit = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim()));
  const mbitBad = (v: string) => v.trim() !== '' && !/^\d{1,6}$/.test(v.trim());
  const limitsBad = mbitBad(limit) || mbitBad(ipLimit) || mbit(limit) === 0 || mbit(ipLimit) === 0;
  const body: RouteInput = { name: name.trim(), slug: slug.trim().toLowerCase(), snis: parseSnis(snis), exitIds, nodeIds, proxyProtocol: proxy, healthCheck: health, enabled, limitMbit: mbit(limit), ipLimitMbit: mbit(ipLimit) };

  const save = useMutation({
    mutationFn: () => (route ? api.patch<{ route: RouteDto }>(`/api/routes/${route.id}`, body) : api.post<{ route: RouteDto }>('/api/routes', body)),
    onSuccess: (r) => {
      setSaved(r.route);
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  const close = () => {
    setApplyNode(null);
    onClose();
  };

  if (applyNode) return <ApplyDialog nodeId={applyNode.id} nodeName={applyNode.name} onClose={() => setApplyNode(null)} />;

  // Шаг 2: маршрут сохранён — применить на каждую ноду отдельно.
  if (saved) {
    return (
      <Dialog open onOpenChange={(o) => !o && close()} maxWidth="m" fullWidth aria-labelledby="route-saved">
        <Dialog.Header caption={`Маршрут «${saved.name}» сохранён`} id="route-saved" />
        <Dialog.Body>
          <div className="stack">
            <Text color="secondary">Конфиг на нодах пока прежний. Применяйте на каждую ноду отдельно: у каждой свой дифф, и если применение сорвётся, откатится только эта нода.</Text>
            {saved.nodes.length === 0 && <Notice theme="info">Маршрут не привязан ни к одной ноде, применять нечего.</Notice>}
            {saved.nodes.map((n) => (
              <div key={n.nodeId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--g-color-line-generic)' }}>
                <div>
                  <Text variant="subheader-2">{n.nodeName}</Text>
                  <div><Text color={n.pendingApply ? 'warning' : 'positive'}>{n.pendingApply ? 'ожидает применения' : 'актуально'}</Text></div>
                </div>
                <Button view={n.pendingApply ? 'action' : 'outlined'} disabled={!n.online} onClick={() => setApplyNode({ id: n.nodeId, name: n.nodeName })}>{n.online ? 'Дифф и применение…' : 'Нода не на связи'}</Button>
              </div>
            ))}
          </div>
        </Dialog.Body>
        <Dialog.Footer onClickButtonApply={close} textButtonApply="Готово" />
      </Dialog>
    );
  }

  const nodeOptions = (nodes.data?.nodes ?? []).map((n) => ({ value: n.id, content: n.name }));
  const exitOptions = exitList.map((e) => ({ value: e.id, content: exitLabel(e), text: `${e.name} ${e.host}` }));

  return (
    <>
      <Dialog open={open && !newExit} onOpenChange={(o) => !o && close()} maxWidth="m" fullWidth aria-labelledby="route-title">
        <Dialog.Header caption={route ? 'Маршрут' : 'Добавить маршрут'} id="route-title" />
        <Dialog.Body>
          <div className="stack">
            <Field label="Выходы" help="Зарубежные ноды, на которые мост пробрасывает соединения. Если выходов несколько, HAProxy распределяет между ними и обходит упавшие.">
              <div style={{ display: 'flex', gap: 8 }}>
                <Select value={exitIds} onUpdate={onExits} options={exitOptions} multiple filterable width="max" placeholder={exitList.length ? 'Выберите выход' : 'Выходов пока нет'} />
                <Button view="outlined" onClick={() => setNewExit(true)}>Новый выход</Button>
              </div>
            </Field>
            <Field label="Название"><TextInput value={name} onUpdate={(v) => { setName(v); setTouched((t) => ({ ...t, name: true })); }} placeholder="Германия (🇷🇺 → 🇩🇪)" /></Field>
            <div className="form-grid">
              <Field label="Идентификатор" help="Латиница, цифры и «_». Имя бэкенда в HAProxy будет be_…"><TextInput value={slug} onUpdate={(v) => { setSlug(v); setTouched((t) => ({ ...t, slug: true })); suggestSni(v.trim().toLowerCase()); }} placeholder="de" controlProps={{ className: 'mono' }} /></Field>
              <Field label="Ноды" help="На каких мостах появится этот маршрут. Конфиг на них будет одинаковым.">
                <Select value={nodeIds} onUpdate={setNodeIds} options={nodeOptions} multiple width="max" placeholder="Не выбрано" />
              </Field>
            </div>
            <Field label="SNI" help="Домены, по которым клиенты попадают в этот маршрут. По одному в строке или через запятую.">
              <TextArea value={snis} onUpdate={(v) => { setSnis(v); setTouched((t) => ({ ...t, snis: true })); }} minRows={3} placeholder={'de.popug.cloud\nwww.de.popug.cloud'} controlProps={{ className: 'mono' }} />
            </Field>
            {parseSnis(snis).length > 0 && <div className="chips">{parseSnis(snis).map((s) => <Label key={s} size="s">{s}</Label>)}</div>}
            <div className="split">
              <Field label="Потолок маршрута, Мбит/с" help="Общая скорость всех клиентов этого маршрута на одной ноде. Пусто — без потолка.">
                <TextInput value={limit} onUpdate={setLimit} placeholder="без потолка" validationState={mbitBad(limit) || mbit(limit) === 0 ? 'invalid' : undefined} controlProps={{ inputMode: 'numeric' }} />
              </Field>
              <Field label="Лимит на IP в маршруте, Мбит/с" help="Заменяет лимит ноды для клиентов этого маршрута. За одним IP бывает много людей (CGNAT у мобильных): лимит они делят.">
                <TextInput value={ipLimit} onUpdate={setIpLimit} placeholder="как у ноды" validationState={mbitBad(ipLimit) || mbit(ipLimit) === 0 ? 'invalid' : undefined} controlProps={{ inputMode: 'numeric' }} />
              </Field>
            </div>
            {(limit.trim() !== '' || ipLimit.trim() !== '') && <Text color="secondary" variant="body-1">Лимиты скорости работают на HAProxy 2.7 и новее; на более старых нодах они не применяются. После сохранения конфиг нужно применить на ноде.</Text>}
            <div style={{ display: 'grid', gap: 10 }}>
              <Switch checked={proxy} onUpdate={setProxy} content="PROXY protocol v2 к выходу" />
              <Switch checked={health} onUpdate={setHealth} content="Проверка здоровья выходов (check)" />
              <Switch checked={enabled} onUpdate={setEnabled} content="Маршрут включён" />
            </div>
            {save.isError && <Notice theme="danger" title={(save.error as ApiError).code === 'sni_conflict' ? 'SNI уже занят' : undefined}>{save.error instanceof ApiError ? save.error.message : 'Не удалось сохранить маршрут'}</Notice>}
          </div>
        </Dialog.Body>
        <Dialog.Footer onClickButtonCancel={close} textButtonCancel="Отмена" onClickButtonApply={() => save.mutate()} textButtonApply={route ? 'Сохранить' : 'Создать'} loading={save.isPending} propsButtonApply={{ disabled: !body.name || !body.slug || limitsBad }} />
      </Dialog>
      <ExitDialog open={open && newExit} onClose={() => setNewExit(false)} onSaved={(e) => onExits([...exitIds, e.id])} />
    </>
  );
}
