import { Button, PasswordInput, SegmentedRadioGroup, Switch, Text, TextArea, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, type RemnaSavePayload, type RemnaTestResult } from '../lib/api';
import { useRemnaSettings, useTelegramSettings } from '../lib/queries';
import { Field, Notice, Panel } from './ui';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Ошибка');
const hours = (sec: number): string => String(Math.round((sec / 3600) * 100) / 100);

/** «Имя: значение» построчно → объект. Возвращает ошибку, если строка не разобралась. */
function parseHeaders(text: string): { value: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(':');
    if (i < 1) return { error: `Строка «${line}»: ожидается «Имя: значение»` };
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { value: out };
}

export function IntegrationsTab() {
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <RemnawaveCard />
      <TelegramCard />
    </div>
  );
}

function RemnawaveCard() {
  const qc = useQueryClient();
  const cur = useRemnaSettings();
  const d = cur.data;
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [headersTouched, setHeadersTouched] = useState(false);
  const [observeOnly, setObserveOnly] = useState(true);
  const [banMode, setBanMode] = useState<'report' | 'fixed'>('report');
  const [scope, setScope] = useState<'route' | 'all'>('route');
  const [fixedH, setFixedH] = useState('1');
  const [maxH, setMaxH] = useState('24');
  const [poll, setPoll] = useState('15');
  const [allow, setAllow] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!d || loaded) return;
    setEnabled(d.enabled);
    setUrl(d.url);
    setObserveOnly(d.observeOnly);
    setBanMode(d.banMode);
    setScope(d.scope);
    setFixedH(hours(d.fixedBanSec));
    setMaxH(hours(d.maxBanSec));
    setPoll(String(d.pollIntervalSec));
    setAllow(d.allowlist.join('\n'));
    setLoaded(true);
  }, [d, loaded]);

  const buildPayload = (): RemnaSavePayload | null => {
    setFormError(null);
    const f = Number(fixedH.replace(',', '.'));
    const m = Number(maxH.replace(',', '.'));
    const p = Number(poll);
    if (!(f > 0) || !(m > 0)) return setFormError('Сроки банов: число часов больше нуля'), null;
    if (!Number.isInteger(p) || p < 5) return setFormError('Интервал опроса: целое число секунд, не меньше 5'), null;
    const payload: RemnaSavePayload = {
      enabled, url: url.trim(), observeOnly, banMode, scope, fixedBanSec: Math.round(f * 3600), maxBanSec: Math.round(m * 3600), pollIntervalSec: p,
      allowlist: allow.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
    };
    if (token.trim()) payload.token = token.trim();
    if (headersTouched) {
      const h = parseHeaders(headersText);
      if ('error' in h) return setFormError(h.error), null;
      payload.headers = h.value;
    }
    return payload;
  };

  const save = useMutation({
    mutationFn: (p: RemnaSavePayload) => api.put('/api/settings/remnawave', p),
    onSuccess: () => {
      setToken('');
      setHeadersTouched(false);
      setHeadersText('');
      void qc.invalidateQueries({ queryKey: ['remna-settings'] });
      void qc.invalidateQueries({ queryKey: ['torrent'] });
    },
  });
  const clearToken = useMutation({
    mutationFn: () => api.put('/api/settings/remnawave', { ...buildPayload()!, enabled: false, clearToken: true }),
    onSuccess: () => {
      setEnabled(false);
      void qc.invalidateQueries({ queryKey: ['remna-settings'] });
      void qc.invalidateQueries({ queryKey: ['torrent'] });
    },
  });
  const test = useMutation({
    mutationFn: () => {
      const body: { url?: string; token?: string; headers?: Record<string, string> } = {};
      if (url.trim()) body.url = url.trim();
      if (token.trim()) body.token = token.trim();
      if (headersTouched) {
        const h = parseHeaders(headersText);
        if ('value' in h) body.headers = h.value;
      }
      return api.post<RemnaTestResult>('/api/settings/remnawave/test', body);
    },
  });

  const onSave = () => {
    const p = buildPayload();
    if (p) save.mutate(p);
  };

  return (
    <Panel>
      <div className="stack" style={{ padding: 20 }}>
        <div>
          <Text variant="subheader-3">Remnawave и торрент-блокер</Text>
          <Text color="secondary" as="div" style={{ marginTop: 4 }}>Панель читает отчёты Torrent Blocker из Remnawave и банит настоящий IP клиента на мостах. Токен нужен только для чтения.</Text>
        </div>
        <Switch checked={enabled} onUpdate={setEnabled} content="Опрашивать отчёты и ставить баны" />
        <Field label="Адрес Remnawave" help="Без пути, например https://remnawave.example.com. Если панель за Caddy на скрытом поддомене, укажите именно его.">
          <TextInput value={url} onUpdate={setUrl} placeholder="https://remnawave.example.com" />
        </Field>
        <Field
          label="API-токен"
          help="Создаётся в Remnawave под админом. Достаточно двух прав на чтение: node-plugins:torrent-blocker-reports и nodes:list. Хранится зашифрованным и после сохранения не показывается."
        >
          <PasswordInput value={token} onUpdate={setToken} placeholder={d?.hasToken ? 'сохранён; введите новый, чтобы заменить' : 'вставьте токен'} autoComplete="off" />
        </Field>
        <Field
          label="Доп. заголовки (если нужны)"
          help={d?.headerNames.length ? `Сейчас заданы: ${d.headerNames.join(', ')} (значения скрыты). Введите заново, чтобы заменить; пустое поле удалит их.` : 'По одному в строке, «Имя: значение». Для панели за Caddy с секретным заголовком. Authorization задавать нельзя.'}
        >
          <TextArea value={headersText} onUpdate={(v) => { setHeadersText(v); setHeadersTouched(true); }} minRows={2} placeholder="X-Gate-Key: секрет" controlProps={{ className: 'mono', autoComplete: 'off' }} />
        </Field>

        <Text variant="subheader-2">Баны</Text>
        <Switch checked={observeOnly} onUpdate={setObserveOnly} content="Режим наблюдения: записывать решения, но не банить" />
        <Field label="Где банить" help="По умолчанию — только на мостах, у которых есть маршрут на выход этой ноды Remnawave: если клиент сидел на Турции, а мостов на Турцию нет, банить некого. Чтобы выход панели сопоставился с нодой Remnawave, их адреса должны совпадать.">
          <SegmentedRadioGroup value={scope} onUpdate={setScope} options={[{ value: 'route', content: 'Только нужные мосты' }, { value: 'all', content: 'На всех мостах' }]} />
        </Field>
        <Field label="Срок бана" help="По умолчанию берётся срок из отчёта Remnawave (blockDuration), но не больше максимума ниже.">
          <SegmentedRadioGroup value={banMode} onUpdate={setBanMode} options={[{ value: 'report', content: 'Как в отчёте' }, { value: 'fixed', content: 'Всегда одинаковый' }]} />
        </Field>
        <div className="split">
          {banMode === 'fixed' && <Field label="Срок бана, часов"><TextInput value={fixedH} onUpdate={setFixedH} controlProps={{ inputMode: 'decimal' }} /></Field>}
          <Field label="Максимальный срок, часов" help="Предохранитель: дольше этого не банить, даже если в отчёте больше."><TextInput value={maxH} onUpdate={setMaxH} controlProps={{ inputMode: 'decimal' }} /></Field>
        </div>
        <Field label="Интервал опроса, секунд"><TextInput value={poll} onUpdate={setPoll} controlProps={{ inputMode: 'numeric' }} /></Field>
        <Field label="Не банить никогда" help="IP и подсети, по одной в строке. Адреса ваших нод, выходов и нод Remnawave, а также частные адреса защищены всегда.">
          <TextArea value={allow} onUpdate={setAllow} minRows={2} placeholder={'203.0.113.7\n10.0.0.0/8'} controlProps={{ className: 'mono' }} />
        </Field>

        {formError && <Notice theme="danger">{formError}</Notice>}
        {save.isError && <Notice theme="danger">{errText(save.error)}</Notice>}
        {save.isSuccess && <Notice theme="success">Сохранено.{enabled ? ' Опрос идёт: при первом запуске старые отчёты пропускаются, баны начнутся с новых.' : ''}</Notice>}
        {test.data && (
          <Notice theme={test.data.reports.ok && test.data.nodes.ok ? 'success' : test.data.reports.ok ? 'warning' : 'danger'} title={test.data.reports.ok ? 'Remnawave отвечает' : 'Не получилось прочитать отчёты'}>
            <div>Отчёты Torrent Blocker: {test.data.reports.ok ? `доступны, всего ${test.data.reports.total}` : test.data.reports.error}</div>
            <div>Список нод: {test.data.nodes.ok ? `доступен, нод ${test.data.nodes.count}` : `${test.data.nodes.error} Баны будут работать, но IP нод Remnawave не попадут в список защиты.`}</div>
          </Notice>
        )}
        {test.isError && <Notice theme="danger">{errText(test.error)}</Notice>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button view="action" loading={save.isPending} onClick={onSave}>Сохранить</Button>
          <Button view="outlined" loading={test.isPending} onClick={() => test.mutate()} disabled={!url.trim() || (!token.trim() && !d?.hasToken)}>Проверить соединение</Button>
          {d?.hasToken && <Button view="flat-danger" loading={clearToken.isPending} onClick={() => buildPayload() && clearToken.mutate()}>Удалить токен</Button>}
        </div>
      </div>
    </Panel>
  );
}

function TelegramCard() {
  const qc = useQueryClient();
  const cur = useTelegramSettings();
  const d = cur.data;
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState('');
  const [chat, setChat] = useState('');
  useEffect(() => {
    if (!d || loaded) return;
    setEnabled(d.enabled);
    setChat(d.chatId);
    setLoaded(true);
  }, [d, loaded]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['telegram-settings'] });
    void qc.invalidateQueries({ queryKey: ['alerts'] });
  };
  const save = useMutation({
    mutationFn: () => api.put('/api/settings/telegram', { enabled, chatId: chat.trim(), ...(token.trim() ? { token: token.trim() } : {}) }),
    onSuccess: () => {
      setToken('');
      refresh();
    },
  });
  const clear = useMutation({ mutationFn: () => api.put('/api/settings/telegram', { enabled: false, chatId: chat.trim(), clearToken: true }), onSuccess: () => { setEnabled(false); refresh(); } });
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; error: string | null }>('/api/settings/telegram/test', { ...(token.trim() ? { token: token.trim() } : {}), ...(chat.trim() ? { chatId: chat.trim() } : {}) }) });

  return (
    <Panel>
      <div className="stack" style={{ padding: 20 }}>
        <div>
          <Text variant="subheader-3">Уведомления в Telegram</Text>
          <Text color="secondary" as="div" style={{ marginTop: 4 }}>Алерты (нода не на связи, конфиг не применился, маршрут красный, квота, нагрузка) приходят в чат. Когда проблема решена, бот пишет «починилось».</Text>
        </div>
        <Switch checked={enabled} onUpdate={setEnabled} content="Отправлять алерты" />
        <Field label="Токен бота" help="Создайте бота у @BotFather. Токен выглядит как 123456789:AAE… и после сохранения не показывается.">
          <PasswordInput value={token} onUpdate={setToken} placeholder={d?.hasToken ? 'сохранён; введите новый, чтобы заменить' : 'вставьте токен'} autoComplete="off" />
        </Field>
        <Field label="chat_id" help="Свой чат: напишите боту /start и узнайте id у @userinfobot. Для группы добавьте бота в группу; id группы отрицательный (-100…). Для канала — @имя_канала.">
          <TextInput value={chat} onUpdate={setChat} placeholder="-1001234567890" controlProps={{ className: 'mono' }} />
        </Field>
        {save.isError && <Notice theme="danger">{errText(save.error)}</Notice>}
        {save.isSuccess && <Notice theme="success">Сохранено.</Notice>}
        {test.data && (test.data.ok ? <Notice theme="success">Тестовое сообщение отправлено. Проверьте чат.</Notice> : <Notice theme="danger" title="Сообщение не отправилось">{test.data.error}</Notice>)}
        {test.isError && <Notice theme="danger">{errText(test.error)}</Notice>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button view="action" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button>
          <Button view="outlined" loading={test.isPending} disabled={(!token.trim() && !d?.hasToken) || !chat.trim()} onClick={() => test.mutate()}>Отправить тестовое сообщение</Button>
          {d?.hasToken && <Button view="flat-danger" loading={clear.isPending} onClick={() => clear.mutate()}>Удалить токен</Button>}
        </div>
      </div>
    </Panel>
  );
}
