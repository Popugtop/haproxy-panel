import { Button, Label, Select, Switch, Text } from '@gravity-ui/uikit';
import { Table, type TableColumnConfig } from '@gravity-ui/uikit/legacy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyHint, Hint, Notice, RouterLink } from '../components/ui';
import { api, ApiError, type RemnaSettingsDto, type TorrentAction, type TorrentEvent } from '../lib/api';
import { ago, dateTime, int } from '../lib/format';
import { useRemnaSettings, useTorrent, useTorrentEvents } from '../lib/queries';
import { useNow } from '../lib/useNow';

export function hoursText(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  const h = sec / 3600;
  return h < 48 ? `${Number.isInteger(h) ? h : h.toFixed(1)} ч` : `${Math.round(h / 24)} дн`;
}

const ACTIONS: Record<TorrentAction, { label: string; theme: 'danger' | 'info' | 'normal' | 'warning' | 'utility'; tip: string }> = {
  ban: { label: 'забанен', theme: 'danger', tip: 'IP забанен на мостах' },
  observe: { label: 'наблюдение', theme: 'info', tip: 'Режим наблюдения: бан был бы поставлен, но не ставится' },
  skip: { label: 'пропущен', theme: 'normal', tip: 'Отчёт не привёл к бану, причина указана справа' },
  already_banned: { label: 'уже в бане', theme: 'utility', tip: 'Бан уже действует: он не продлевается и не укорачивается' },
  error: { label: 'ошибка', theme: 'warning', tip: 'Бан не удалось поставить' },
};

const FILTERS = [
  { value: '', content: 'Все решения' },
  { value: 'ban', content: 'Баны' },
  { value: 'observe', content: 'Наблюдение' },
  { value: 'skip', content: 'Пропуски' },
  { value: 'already_banned', content: 'Уже в бане' },
  { value: 'error', content: 'Ошибки' },
];

export function TorrentPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const now = useNow(1000);
  const [filter, setFilter] = useState('');
  const status = useTorrent();
  const settings = useRemnaSettings();
  const events = useTorrentEvents(filter || undefined);
  const st = status.data;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['torrent'] });
    void qc.invalidateQueries({ queryKey: ['torrent-events'] });
    void qc.invalidateQueries({ queryKey: ['bans'] });
  };
  const poll = useMutation({ mutationFn: () => api.post<{ status: string; processed: number; banned: number }>('/api/torrent/poll'), onSuccess: refresh, onError: refresh });
  const mode = useMutation({
    mutationFn: (observeOnly: boolean) => {
      const s = settings.data as RemnaSettingsDto;
      const { hasToken: _t, headerNames: _h, ...rest } = s;
      return api.put('/api/settings/remnawave', { ...rest, observeOnly });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['remna-settings'] });
      refresh();
    },
  });

  const columns: TableColumnConfig<TorrentEvent>[] = [
    { id: 'at', width: 130, name: 'Когда', template: (e) => <span title={dateTime(e.at)}>{ago(e.at, now)}</span> },
    { id: 'ip', width: 190, name: 'IP клиента', template: (e) => <span className="mono">{e.ip}</span> },
    { id: 'user', width: 150, name: 'Пользователь', template: (e) => e.username || '—' },
    { id: 'node', width: 110, name: () => <Hint label="Нода Remnawave" tip="Зарубежная нода, на которой Torrent Blocker поймал торрент-трафик" />, template: (e) => <span className="mono">{e.remnaNode || '—'}</span> },
    { id: 'action', width: 140, name: 'Решение', template: (e) => <Label theme={ACTIONS[e.action].theme} size="s" title={ACTIONS[e.action].tip}>{ACTIONS[e.action].label}</Label> },
    { id: 'dur', width: 90, align: 'end', name: 'Срок', template: (e) => hoursText(e.durationSec) },
    { id: 'nodes', width: 90, align: 'end', name: () => <Hint label="Мосты" tip="На скольких мостах поставлен (или был бы поставлен) бан" />, template: (e) => (e.nodesCount ? int(e.nodesCount) : '—') },
    { id: 'reason', name: 'Пояснение', template: (e) => <span className="secondary">{e.reason ?? ''}</span> },
  ];

  const by = st?.stats.last24h ?? {};
  const rows = events.data?.events ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Торрент-блокер</Text>
        <span style={{ display: 'inline-flex', gap: 16, alignItems: 'center' }}>
          {st?.configured && (
            <Switch
              checked={st.observeOnly}
              disabled={mode.isPending || !settings.data}
              onUpdate={(v) => mode.mutate(v)}
              content="Режим наблюдения"
              title="В режиме наблюдения панель записывает решения, но баны не ставит"
            />
          )}
          <Button view="outlined" disabled={!st?.enabled} loading={poll.isPending} onClick={() => poll.mutate()}>Опросить сейчас</Button>
        </span>
      </div>

      <div className="stack">
        {st && !st.configured && (
          <Notice theme="info" title="Remnawave не подключён">
            Панель читает отчёты Torrent Blocker из Remnawave и банит IP клиентов на мостах. Нужен токен с правами только на чтение.{' '}
            <Button view="action" size="s" onClick={() => nav('/settings/integrations')}>Подключить Remnawave</Button>
          </Notice>
        )}
        {st?.configured && !st.enabled && (
          <Notice theme="warning" title="Опрос выключен">
            Отчёты не читаются, баны не ставятся. <RouterLink to="/settings/integrations">Включить в настройках</RouterLink>
          </Notice>
        )}
        {st?.enabled && st.observeOnly && <Notice theme="info" title="Режим наблюдения">Решения записываются в таблицу ниже, но баны не ставятся. Когда убедитесь, что IP определяются верно, выключите режим переключателем выше.</Notice>}
        {st?.state.lastError && <Notice theme="danger" title="Опрос Remnawave не удался">{st.state.lastError}</Notice>}
        {st?.state.warning && <Notice theme="warning">{st.state.warning}</Notice>}
        {poll.isError && <Notice theme="danger">{(poll.error as ApiError).message}</Notice>}
        {poll.isSuccess && <Notice theme="success">{poll.data.status === 'initialized' ? 'Курсор установлен на последний отчёт. Старые отчёты не обрабатываются, баны начнутся с новых.' : `Опрос выполнен: обработано отчётов ${poll.data.processed}, банов ${poll.data.banned}.`}</Notice>}

        {st?.enabled && (
          <Text color="secondary" as="div">
            Последний успешный опрос: {st.state.lastOkAt ? ago(st.state.lastOkAt, now) : 'ещё не было'} · курсор по отчёту <span className="mono">#{st.state.cursor}</span> · за 24 часа: банов {int(by.ban ?? 0)}, наблюдений {int(by.observe ?? 0)}, пропусков {int(by.skip ?? 0)}, повторов {int(by.already_banned ?? 0)}
            {(by.error ?? 0) > 0 && <>, ошибок {int(by.error)}</>} · активных банов от торрента: <RouterLink to="/clients/bans">{int(st.stats.activeBans)}</RouterLink>
          </Text>
        )}

        <div style={{ width: 220 }}>
          <Select value={[filter]} onUpdate={(v) => setFilter(v[0] ?? '')} options={FILTERS} width="max" />
        </div>
        <div className="tbl">
          <Table columns={columns} data={rows} getRowId={(e) => e.id} verticalAlign="middle" width="max" />
          {events.isPending && <EmptyHint title="Загружаю…" />}
          {!events.isPending && rows.length === 0 && (
            <EmptyHint title={filter ? 'С таким решением событий нет.' : 'Событий пока нет.'}>
              {st?.enabled ? 'Они появятся, когда Remnawave пришлёт отчёт о торрент-трафике: старые отчёты при подключении не обрабатываются.' : 'Подключите Remnawave, и здесь появятся решения по каждому отчёту.'}
            </EmptyHint>
          )}
        </div>
      </div>
    </div>
  );
}
