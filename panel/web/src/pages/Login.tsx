import { Button, Card, Text, TextInput } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Field, Notice } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useBranding } from '../lib/brand';

type Step = 'password' | 'totp';

export function LoginPage({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const brand = useBranding();
  return (
    <div className="auth">
      <div className="auth-box">
        <div className="auth-brand">
          <img src={brand.logo} alt="" width={32} height={32} />
          <Text variant="header-2">{brand.name}</Text>
        </div>
        <Card type="container" view="outlined">{setup ? <TotpSetup onDone={onDone} /> : <PasswordForm onDone={onDone} />}</Card>
      </div>
    </div>
  );
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('password');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ status: 'ok' | 'totp_required' | 'totp_setup' }>('/api/auth/login', { login, password, ...(step === 'totp' ? { code } : {}) });
      if (r.status === 'totp_required') setStep('totp');
      else onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить вход');
      if (step === 'totp') setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <Text variant="subheader-3">{step === 'password' ? 'Вход в панель' : 'Код из приложения'}</Text>
      {step === 'password' ? (
        <>
          <Field label="Логин"><TextInput size="l" autoFocus value={login} onUpdate={setLogin} controlProps={{ autoComplete: 'username' }} /></Field>
          <Field label="Пароль"><TextInput size="l" type="password" value={password} onUpdate={setPassword} controlProps={{ autoComplete: 'current-password' }} /></Field>
        </>
      ) : (
        <Field label="Шестизначный код" help="Из приложения-аутентификатора. Если кода нет, сбросьте TOTP командой reset-totp на сервере.">
          <TextInput size="l" autoFocus value={code} onUpdate={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} controlProps={{ inputMode: 'numeric', autoComplete: 'one-time-code', className: 'mono' }} />
        </Field>
      )}
      {error && <Notice theme="danger">{error}</Notice>}
      <Button type="submit" view="action" size="l" width="max" loading={busy}>{step === 'password' ? 'Продолжить' : 'Войти'}</Button>
    </form>
  );
}

function TotpSetup({ onDone }: { onDone: () => void }) {
  const q = useQuery({ queryKey: ['totp-setup'], queryFn: () => api.get<{ secret: string; qr: string }>('/api/auth/totp/setup'), staleTime: Infinity, gcTime: 0, retry: false });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/totp/enable', { code });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось включить TOTP');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <Text variant="subheader-3">Настройте второй фактор</Text>
      <Text color="secondary">Отсканируйте QR-код приложением-аутентификатором и введите код. Без этого вход в панель закрыт.</Text>
      {q.isPending && <Text color="secondary">Готовлю секрет…</Text>}
      {q.isError && <Notice theme="danger">{(q.error as Error).message}</Notice>}
      {q.data && (
        <>
          <div className="qr"><img src={q.data.qr} alt="QR-код для приложения-аутентификатора" /></div>
          <Field label="Или введите ключ вручную"><span className="mono" style={{ wordBreak: 'break-all' }}>{q.data.secret}</span></Field>
        </>
      )}
      <Field label="Код из приложения">
        <TextInput size="l" value={code} onUpdate={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} controlProps={{ inputMode: 'numeric', autoComplete: 'one-time-code', className: 'mono' }} />
      </Field>
      {error && <Notice theme="danger">{error}</Notice>}
      <Button type="submit" view="action" size="l" width="max" loading={busy} disabled={!q.data}>Включить и войти</Button>
    </form>
  );
}
