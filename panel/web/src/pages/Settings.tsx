import { Button, Label, PasswordInput, Tab, TabList, TabProvider, Text, TextInput } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { IntegrationsTab } from '../components/Integrations';
import { Field, Notice, Panel } from '../components/ui';
import { api, ApiError, type AccountDto, type BrandingSettings, type SessionRow } from '../lib/api';
import { DEFAULT_LOGO } from '../lib/brand';
import { ago, dateTime } from '../lib/format';
import { useSystem } from '../lib/queries';

export function SettingsPage() {
  const nav = useNavigate();
  const tab = useLocation().pathname.split('/')[2] ?? 'account';
  return (
    <div className="page">
      <div className="page-head"><Text variant="header-2" as="h1">Настройки</Text></div>
      <TabProvider value={tab} onUpdate={(v) => nav(v === 'account' ? '/settings' : `/settings/${v}`)}>
        <TabList style={{ marginBottom: 20 }}>
          <Tab value="account">Аккаунт</Tab>
          <Tab value="security">Безопасность</Tab>
          <Tab value="integrations">Интеграции</Tab>
          <Tab value="branding">Оформление</Tab>
          <Tab value="panel">Панель</Tab>
        </TabList>
      </TabProvider>
      <Routes>
        <Route index element={<AccountTab />} />
        <Route path="security" element={<SecurityTab />} />
        <Route path="integrations" element={<IntegrationsTab />} />
        <Route path="branding" element={<BrandingTab />} />
        <Route path="panel" element={<PanelTab />} />
      </Routes>
    </div>
  );
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Ошибка');

function AccountTab() {
  const qc = useQueryClient();
  const acc = useQuery({ queryKey: ['account'], queryFn: () => api.get<AccountDto>('/api/account') });
  const [login, setLogin] = useState('');
  const [pw, setPw] = useState('');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');

  const rename = useMutation({
    mutationFn: () => api.patch<{ login: string }>('/api/account', { login, password: pw }),
    onSuccess: () => { setPw(''); void qc.invalidateQueries({ queryKey: ['account'] }); void qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password', { current: cur, next }),
    onSuccess: () => { setCur(''); setNext(''); setNext2(''); void qc.invalidateQueries({ queryKey: ['sessions'] }); },
  });
  const current = acc.data?.login ?? '';
  const mismatch = next2.length > 0 && next !== next2;

  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      <Panel>
        <div className="stack" style={{ padding: 20 }}>
          <Text variant="subheader-3">Имя аккаунта</Text>
          <Field label="Логин" help={`Сейчас: ${current}. Для смены нужен текущий пароль.`}>
            <TextInput value={login} onUpdate={setLogin} placeholder={current} />
          </Field>
          <Field label="Текущий пароль"><PasswordInput value={pw} onUpdate={setPw} autoComplete="current-password" /></Field>
          {rename.isError && <Notice theme="danger">{errText(rename.error)}</Notice>}
          {rename.isSuccess && <Notice theme="success">Логин изменён.</Notice>}
          <div><Button view="action" disabled={!login.trim() || !pw} loading={rename.isPending} onClick={() => rename.mutate()}>Сменить логин</Button></div>
        </div>
      </Panel>
      <Panel>
        <div className="stack" style={{ padding: 20 }}>
          <Text variant="subheader-3">Пароль</Text>
          <Field label="Текущий пароль"><PasswordInput value={cur} onUpdate={setCur} autoComplete="current-password" /></Field>
          <Field label="Новый пароль" help="Минимум 12 символов."><PasswordInput value={next} onUpdate={setNext} autoComplete="new-password" /></Field>
          <Field label="Ещё раз"><PasswordInput value={next2} onUpdate={setNext2} autoComplete="new-password" validationState={mismatch ? 'invalid' : undefined} errorMessage={mismatch ? 'Пароли не совпадают' : undefined} /></Field>
          {change.isError && <Notice theme="danger">{errText(change.error)}</Notice>}
          {change.isSuccess && <Notice theme="success">Пароль изменён. Остальные сессии завершены.</Notice>}
          <div><Button view="action" disabled={!cur || !next || next !== next2} loading={change.isPending} onClick={() => change.mutate()}>Сменить пароль</Button></div>
        </div>
      </Panel>
    </div>
  );
}

function SecurityTab() {
  const qc = useQueryClient();
  const acc = useQuery({ queryKey: ['account'], queryFn: () => api.get<AccountDto>('/api/account') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ sessions: SessionRow[] }>('/api/account/sessions'), refetchInterval: 15_000 });
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['sessions'] });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/account/sessions/${id}`), onSuccess: refresh });
  const revokeOthers = useMutation({ mutationFn: () => api.post('/api/account/sessions/revoke-others'), onSuccess: refresh });
  const restart = useMutation({
    mutationFn: () => api.post('/api/account/totp/restart', { password: pw, code }),
    // сессия вернулась на экран настройки TOTP — /api/auth/me скажет об этом
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const rows = sessions.data?.sessions ?? [];
  const columns: TableColumnConfig<SessionRow>[] = [
    { id: 'dev', name: 'Устройство', template: (s) => <span>{shortAgent(s.userAgent)}{s.current && <> <Label theme="success" size="xs">эта сессия</Label></>}</span> },
    { id: 'ip', width: 160, name: 'IP', template: (s) => <span className="mono">{s.ip ?? '—'}</span> },
    { id: 'seen', width: 150, name: 'Активность', template: (s) => ago(s.lastSeenAt) },
    { id: 'start', width: 170, name: 'Вход', template: (s) => dateTime(s.createdAt) },
    { id: 'act', align: 'end', width: 130, name: '', template: (s) => s.current ? null : <Button view="flat-danger" size="s" onClick={() => revoke.mutate(s.id)}>Завершить</Button> },
  ];

  return (
    <div className="stack">
      <Panel>
        <div className="stack" style={{ padding: 20, maxWidth: 520 }}>
          <Text variant="subheader-3">Двухфакторная аутентификация</Text>
          <Text color="secondary">Статус: {acc.data?.totpEnabled ? 'включена (приложение-аутентификатор)' : 'не настроена'}. Перенастройка выдаст новый секрет и завершит остальные сессии.</Text>
          {!confirm ? (
            <div><Button view="outlined" onClick={() => setConfirm(true)}>Перенастроить TOTP…</Button></div>
          ) : (
            <>
              <Field label="Пароль"><PasswordInput value={pw} onUpdate={setPw} autoComplete="current-password" /></Field>
              <Field label="Текущий код из приложения"><TextInput value={code} onUpdate={setCode} placeholder="123456" controlProps={{ inputMode: 'numeric' }} /></Field>
              {restart.isError && <Notice theme="danger">{errText(restart.error)}</Notice>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button view="action" disabled={!pw || !code} loading={restart.isPending} onClick={() => restart.mutate()}>Продолжить</Button>
                <Button view="flat" onClick={() => { setConfirm(false); setPw(''); setCode(''); }}>Отмена</Button>
              </div>
            </>
          )}
        </div>
      </Panel>
      <div>
        <div className="page-head" style={{ margin: '0 0 8px' }}>
          <Text variant="subheader-3">Сессии входа</Text>
          <Button view="outlined" disabled={rows.filter((s) => !s.current).length === 0} loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Завершить все остальные</Button>
        </div>
        {(revoke.isError || revokeOthers.isError) && <Notice theme="danger">{errText(revoke.error ?? revokeOthers.error)}</Notice>}
        <div className="tbl"><Table columns={columns} data={rows} getRowId={(s) => s.id} verticalAlign="middle" width="max" /></div>
      </div>
    </div>
  );
}

function shortAgent(ua: string | null): string {
  if (!ua) return 'Неизвестно';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua.slice(0, 24);
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function PanelTab() {
  const qc = useQueryClient();
  const sys = useSystem();
  const s = sys.data;
  const rel = s?.release;
  const [domain, setDomain] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (s && !loaded) {
      setDomain(s.sniDomain);
      setLoaded(true);
    }
  }, [s, loaded]);
  const saveDomain = useMutation({
    mutationFn: (v: string) => api.put<{ sniDomain: string }>('/api/settings/panel', { sniDomain: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['system'] }),
  });
  const domainDirty = !!s && domain.trim() !== s.sniDomain;
  const rows: [string, React.ReactNode][] = [
    ['Версия панели', s ? `v${s.version}` : '—'],
    ['Публичный адрес', <span className="mono" key="u">{s?.publicUrl ?? '—'}</span>],
    ['Агентов на связи', s ? String(s.agentsOnline) : '—'],
    ['Версия агента в панели', rel?.version ? `v${rel.version}` : 'сборки агента не найдены'],
    ['Архитектуры', rel ? (Object.keys(rel.files).join(', ') || '—') : '—'],
    ['Подпись обновлений', rel ? (rel.hasPublicKey ? (Object.values(rel.files).every((f) => f?.signed) ? 'подписаны, публичный ключ задан' : 'есть неподписанные сборки') : 'ключ подписи не настроен') : '—'],
  ];
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <Panel>
        <div style={{ padding: 20, display: 'grid', gridTemplateColumns: '220px 1fr', gap: '10px 16px' }}>
          {rows.map(([k, v]) => (<><Text key={k} color="secondary">{k}</Text><Text key={k + 'v'}>{v}</Text></>))}
        </div>
      </Panel>
      <Panel>
        <div className="stack" style={{ padding: 20 }}>
          <Text variant="subheader-3">Домен для новых маршрутов</Text>
          <Field label="Базовый домен" help="Из него строится подсказка SNI при создании маршрута: маршрут de → de.popug.cloud. Уже созданные SNI не меняются.">
            <TextInput value={domain} onUpdate={setDomain} placeholder="popug.cloud" controlProps={{ className: 'mono' }} />
          </Field>
          {saveDomain.isError && <Notice theme="danger">{errText(saveDomain.error)}</Notice>}
          {saveDomain.isSuccess && !domainDirty && <Notice theme="success">Сохранено.</Notice>}
          <div>
            <Button view="action" disabled={!domainDirty || !domain.trim()} loading={saveDomain.isPending} onClick={() => saveDomain.mutate(domain.trim().toLowerCase())}>Сохранить</Button>
          </div>
        </div>
      </Panel>
      {rel && !rel.hasPublicKey && <Notice theme="warning" title="Обновление агентов по кнопке отключено">Сгенерируйте ключ (<span className="mono">make keygen</span> в каталоге agent), положите <span className="mono">agent/release.pub</span> и пересоберите панель с подписью — подробности в README.</Notice>}
      <Text color="secondary">Версия HAProxy на нодах не обновляется из панели намеренно: обновление демона-балансировщика делается вручную в окно обслуживания.</Text>
    </div>
  );
}

function BrandingTab() {
  const qc = useQueryClient();
  const cur = useQuery({ queryKey: ['branding-settings'], queryFn: () => api.get<BrandingSettings>('/api/settings/branding') });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (cur.data && !loaded) {
      setName(cur.data.name);
      setUrl(cur.data.logoUrl ?? '');
      setLoaded(true);
    }
  }, [cur.data, loaded]);

  const save = useMutation({
    mutationFn: (v: { name: string; logoUrl: string | null; refresh?: boolean }) => api.put('/api/settings/branding', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['branding'] });
      void qc.invalidateQueries({ queryKey: ['branding-settings'] });
    },
  });
  const d = cur.data;
  const logo = d?.logo ?? DEFAULT_LOGO;
  const shownName = name.trim() || d?.defaultName || 'Popug Bridges';
  const dirty = !!d && (name.trim() !== d.name || url.trim() !== (d.logoUrl ?? ''));
  const kb = d?.logoBytes ? `${Math.max(1, Math.round(d.logoBytes / 1024))} КБ` : null;

  return (
    <div className="stack" style={{ maxWidth: 620 }}>
      <Panel>
        <div className="stack" style={{ padding: 20 }}>
          <Text variant="subheader-3">Название и логотип</Text>
          <Field label="Название" help="Показывается в левом верхнем углу, на экране входа и как название вкладки браузера. До 40 символов.">
            <TextInput value={name} onUpdate={setName} placeholder={d?.defaultName ?? 'Popug Bridges'} controlProps={{ maxLength: 40 }} />
          </Field>
          <Field
            label="Ссылка на логотип"
            help="Прямая https-ссылка на PNG, JPEG, WebP, GIF, SVG или ICO до 512 КБ. Панель один раз скачивает картинку и отдаёт её со своего адреса, поэтому внешний сайт не видит ваших посетителей. Он же служит иконкой вкладки; лучше квадратный."
          >
            <TextInput value={url} onUpdate={setUrl} placeholder="https://example.com/logo.png" hasClear />
          </Field>
          {save.isError && <Notice theme="danger">{errText(save.error)}</Notice>}
          {save.isSuccess && !dirty && <Notice theme="success">Сохранено. Название и иконка вкладки обновятся сразу.</Notice>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button view="action" disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate({ name: name.trim(), logoUrl: url.trim() || null })}>Сохранить</Button>
            <Button view="outlined" disabled={!d?.logoUrl || dirty} loading={save.isPending} onClick={() => save.mutate({ name: d!.name, logoUrl: d!.logoUrl, refresh: true })}>Скачать логотип заново</Button>
            <Button view="flat" disabled={!d || (d.name === d.defaultName && !d.logoUrl && !url && name === d.defaultName)} onClick={() => { setName(d?.defaultName ?? ''); setUrl(''); save.mutate({ name: d?.defaultName ?? 'Popug Bridges', logoUrl: null }); }}>Вернуть стандартные</Button>
          </div>
        </div>
      </Panel>
      <div className="stack">
        <Text variant="subheader-3">Как это выглядит сейчас</Text>
        <div className="brand-preview"><img src={logo} alt="" /><Text variant="body-3">{d?.name ?? ''}</Text></div>
        <div className="brand-preview" style={{ borderStyle: 'dashed' }}><span className="tab"><img src={logo} alt="" />{d?.name ?? ''}</span></div>
        {d?.logoUrl && <Text color="secondary">Скачано с <span className="mono">{d.logoUrl}</span>{kb && <>, {kb}</>}. Если картинку на том сайте заменили, нажмите «Скачать логотип заново».</Text>}
        {dirty && <Text color="secondary">Несохранённое название — «{shownName}».</Text>}
      </div>
    </div>
  );
}
