import { Ellipsis } from '@gravity-ui/icons';
import { Button, Dialog, Icon, Label, Switch, Tab, TabList, TabProvider, Text, TextInput } from '@gravity-ui/uikit';
import { DropdownMenu, Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { EmptyHint, Field, Notice, RouterLink, StatusDot } from '../components/ui';
import { api, ApiError, type AlertDto, type AlertRuleDto } from '../lib/api';
import { dateTime } from '../lib/format';
import { useAlertHistory, useAlertRules, useAlerts } from '../lib/queries';
import { useNow } from '../lib/useNow';

const spanText = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ч ${min % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
};

export function AlertsPage() {
  const nav = useNavigate();
  const tab = useLocation().pathname.split('/')[2] ?? 'active';
  const alerts = useAlerts();
  return (
    <div className="page">
      <div className="page-head"><Text variant="header-2" as="h1">Алерты</Text></div>
      <TabProvider value={tab} onUpdate={(v) => nav(v === 'active' ? '/alerts' : `/alerts/${v}`)}>
        <TabList style={{ marginBottom: 20 }}>
          <Tab value="active" counter={alerts.data?.active.length || undefined}>Сейчас</Tab>
          <Tab value="history">История</Tab>
          <Tab value="rules">Правила</Tab>
        </TabList>
      </TabProvider>
      <Routes>
        <Route index element={<ActiveTab />} />
        <Route path="history" element={<HistoryTab />} />
        <Route path="rules" element={<RulesTab />} />
      </Routes>
    </div>
  );
}

const sev = (a: AlertDto) => <StatusDot tone={a.severity === 'crit' ? 'bad' : 'warn'}>{a.severity === 'crit' ? 'авария' : 'внимание'}</StatusDot>;

function notifyCell(a: AlertDto, telegram: boolean) {
  if (a.notifyError) return <Label theme="danger" size="s" title={a.notifyError}>не отправлено</Label>;
  if (a.notifyCount > 0) return <span className="secondary">отправлено{a.notifyCount > 1 ? ` ×${a.notifyCount}` : ''}</span>;
  return <span className="secondary">{telegram ? 'ожидает отправки' : 'Telegram не настроен'}</span>;
}

function ActiveTab() {
  const q = useAlerts();
  const now = useNow(1000);
  const tg = q.data?.telegram.configured && q.data.telegram.enabled;
  const columns: TableColumnConfig<AlertDto>[] = [
    { id: 'sev', width: 120, name: 'Важность', template: sev },
    { id: 'title', width: 250, name: 'Что случилось', template: (a) => a.title },
    { id: 'label', width: 280, name: 'Где', template: (a) => (/^\d/.test(a.label) ? <span className="mono">{a.label}</span> : a.label) },
    { id: 'msg', name: 'Подробности', template: (a) => <span className="secondary">{a.message}</span> },
    { id: 'since', width: 140, name: 'Длится', template: (a) => (a.firedAt ? spanText(now - new Date(a.firedAt).getTime()) : '—') },
    { id: 'notify', width: 170, name: 'Уведомление', template: (a) => notifyCell(a, !!tg) },
  ];
  const rows = q.data?.active ?? [];
  return (
    <div className="stack">
      {q.data && !tg && (
        <Notice theme="info" title={q.data.telegram.configured ? 'Уведомления в Telegram выключены' : 'Telegram не настроен'}>
          Алерты видны только здесь. Чтобы получать их в Telegram, <RouterLink to="/settings/integrations">настройте бота</RouterLink>.
        </Notice>
      )}
      <div className="tbl">
        <Table columns={columns} data={rows} getRowId={(a) => a.id} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Загружаю…" />}
        {!q.isPending && rows.length === 0 && <EmptyHint title="Всё спокойно: горящих алертов нет.">{q.data && q.data.pending > 0 ? `Условий на подходе: ${q.data.pending}, они сработают, если продержатся заданное время.` : 'Когда что-то сломается, это появится здесь и в Telegram.'}</EmptyHint>}
      </div>
    </div>
  );
}

function HistoryTab() {
  const q = useAlertHistory();
  const columns: TableColumnConfig<AlertDto>[] = [
    { id: 'state', width: 130, name: 'Состояние', template: (a) => (a.status === 'firing' ? <StatusDot tone={a.severity === 'crit' ? 'bad' : 'warn'}>горит</StatusDot> : <StatusDot tone="ok">починилось</StatusDot>) },
    { id: 'title', width: 250, name: 'Что случилось', template: (a) => a.title },
    { id: 'label', width: 280, name: 'Где', template: (a) => (/^\d/.test(a.label) ? <span className="mono">{a.label}</span> : a.label) },
    { id: 'msg', name: 'Подробности', template: (a) => <span className="secondary">{a.message}</span> },
    { id: 'fired', width: 170, name: 'Началось', template: (a) => dateTime(a.firedAt) },
    { id: 'dur', width: 130, name: 'Длилось', template: (a) => (a.firedAt ? spanText((a.resolvedAt ? new Date(a.resolvedAt).getTime() : Date.now()) - new Date(a.firedAt).getTime()) : '—') },
  ];
  const rows = q.data?.alerts ?? [];
  return (
    <div className="tbl">
      <Table columns={columns} data={rows} getRowId={(a) => a.id} verticalAlign="middle" width="max" />
      {q.isPending && <EmptyHint title="Загружаю…" />}
      {!q.isPending && rows.length === 0 && <EmptyHint title="Истории пока нет.">Закрытые алерты хранятся полгода.</EmptyHint>}
    </div>
  );
}

// ───────── правила ─────────

const thresholdText = (r: AlertRuleDto): string => {
  if (!r.unit) return '—';
  const u = r.unit === '%' ? '%' : ` ${r.unit}`;
  return r.hasThreshold2 ? `${r.threshold}${u} / ${r.threshold2}${u}` : `${r.threshold}${u}`;
};

function RulesTab() {
  const q = useAlertRules();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<AlertRuleDto | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alert-rules'] });
  const toggle = useMutation({
    mutationFn: (r: AlertRuleDto) => api.put(`/api/alerts/rules/${r.kind}`, { enabled: !r.enabled, threshold: r.threshold, threshold2: r.threshold2, forMin: r.forMin, repeatHours: r.repeatHours }),
    onSuccess: refresh,
  });
  const reset = useMutation({ mutationFn: (k: string) => api.post(`/api/alerts/rules/${k}/reset`), onSuccess: refresh });
  const columns: TableColumnConfig<AlertRuleDto>[] = [
    { id: 'on', width: 90, name: 'Включено', template: (r) => <Switch checked={r.enabled} onUpdate={() => toggle.mutate(r)} aria-label={`Правило «${r.title}»`} /> },
    { id: 'title', width: 280, name: 'Правило', template: (r) => <div><div>{r.title}</div><div className="secondary" style={{ fontSize: 12 }}>{r.description}</div></div> },
    { id: 'th', width: 170, name: 'Порог', template: (r) => thresholdText(r) },
    { id: 'for', width: 150, name: 'Держится', template: (r) => (r.event ? 'сразу' : r.forMin ? `${r.forMin} мин` : 'сразу') },
    { id: 'rep', width: 150, name: 'Напоминать', template: (r) => (r.repeatHours ? `раз в ${r.repeatHours} ч` : 'не напоминать') },
    { id: 'act', align: 'end', width: 56, name: '', template: (r) => (
      <DropdownMenu
        items={[[{ text: 'Изменить…', action: () => setEdit(r) }, { text: 'Вернуть значения по умолчанию', action: () => reset.mutate(r.kind) }]]}
        renderSwitcher={(props) => <Button {...props} view="flat" size="s" aria-label={`Действия для правила «${r.title}»`}><Icon data={Ellipsis} size={16} /></Button>}
      />
    ) },
  ];
  return (
    <div className="stack">
      <Text color="secondary">Каждое правило следит за своим условием раз в 30 секунд. Алерт срабатывает, когда условие продержалось заданное время, напоминает, пока проблема не решена, и сообщает, когда она исчезла.</Text>
      {(toggle.isError || reset.isError) && <Notice theme="danger">{((toggle.error ?? reset.error) as ApiError).message}</Notice>}
      <div className="tbl">
        <Table columns={columns} data={q.data?.rules ?? []} getRowId={(r) => r.kind} verticalAlign="middle" width="max" />
        {q.isPending && <EmptyHint title="Загружаю…" />}
      </div>
      <RuleDialog rule={edit} onClose={() => setEdit(null)} onSaved={refresh} />
    </div>
  );
}

function RuleDialog({ rule, onClose, onSaved }: { rule: AlertRuleDto | null; onClose: () => void; onSaved: () => void }) {
  const [th, setTh] = useState('');
  const [th2, setTh2] = useState('');
  const [forMin, setForMin] = useState('');
  const [rep, setRep] = useState('');
  useEffect(() => {
    if (!rule) return;
    setTh(rule.threshold === null ? '' : String(rule.threshold));
    setTh2(rule.threshold2 === null ? '' : String(rule.threshold2));
    setForMin(String(rule.forMin));
    setRep(String(rule.repeatHours));
  }, [rule]);
  const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v.replace(',', '.'))) ? null : Number(v.replace(',', '.')));
  const save = useMutation({
    mutationFn: () => api.put(`/api/alerts/rules/${rule!.kind}`, { enabled: rule!.enabled, threshold: rule!.unit ? num(th) : null, threshold2: rule!.hasThreshold2 ? num(th2) : null, forMin: Math.round(num(forMin) ?? 0), repeatHours: Math.round(num(rep) ?? 0) }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  if (!rule) return null;
  const unit = rule.unit ?? '';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} maxWidth="s" fullWidth aria-labelledby="rule-title">
      <Dialog.Header caption={rule.title} id="rule-title" />
      <Dialog.Body>
        <div className="stack">
          <Text color="secondary">{rule.description}</Text>
          {rule.unit && <Field label={rule.hasThreshold2 ? `Порог предупреждения, ${unit}` : `Порог, ${unit}`}><TextInput value={th} onUpdate={setTh} controlProps={{ inputMode: 'decimal' }} /></Field>}
          {rule.hasThreshold2 && <Field label={`Порог аварии, ${unit}`} help="Когда этот порог пройден, алерт становится аварийным и в Telegram приходит «стало хуже»."><TextInput value={th2} onUpdate={setTh2} controlProps={{ inputMode: 'decimal' }} /></Field>}
          {!rule.event && <Field label="Условие должно держаться, минут" help="0 — срабатывать сразу. Защищает от ложных тревог при кратковременных скачках."><TextInput value={forMin} onUpdate={setForMin} controlProps={{ inputMode: 'numeric' }} /></Field>}
          <Field label="Напоминать, раз в часов" help="Пока проблема не решена. 0 — не напоминать."><TextInput value={rep} onUpdate={setRep} controlProps={{ inputMode: 'numeric' }} /></Field>
          {save.isError && <Notice theme="danger">{(save.error as ApiError).message}</Notice>}
        </div>
      </Dialog.Body>
      <Dialog.Footer onClickButtonCancel={onClose} textButtonCancel="Отмена" onClickButtonApply={() => save.mutate()} textButtonApply="Сохранить" loading={save.isPending} />
    </Dialog>
  );
}
