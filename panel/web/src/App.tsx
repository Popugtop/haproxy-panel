import { ArrowRightFromSquare, ArrowsRotateRight, Bell, ClockArrowRotateLeft, Gear, Globe, Magnet, Moon, PersonWorker, Pulse, Server, Sun } from '@gravity-ui/icons';
import { Button, Icon, Label, Text } from '@gravity-ui/uikit';
import { AsideHeader, type MenuItem } from '@gravity-ui/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type Me } from './lib/api';
import { useApplyBranding, useBranding } from './lib/brand';
import { useAlertSummary, useNodes, usePanelStatus } from './lib/queries';
import { useAppTheme } from './lib/theme';
import { AlertsPage } from './pages/Alerts';
import { AuditPage } from './pages/Audit';
import { ClientsPage } from './pages/Clients';
import { LoginPage } from './pages/Login';
import { SettingsPage } from './pages/Settings';
import { TorrentPage } from './pages/Torrent';
import { NodePage } from './pages/Node';
import { NodesPage } from './pages/Nodes';
import { ExitsPage } from './pages/Exits';
import { OverviewPage } from './pages/Overview';
import { RoutePage } from './pages/Route';
import { RoutesPage } from './pages/Routes';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function AsideFooter({ me, compact }: { me: Me; compact: boolean }) {
  const qc = useQueryClient();
  const { theme, toggle } = useAppTheme();
  const nodes = useNodes();
  const status = usePanelStatus();
  const list = nodes.data?.nodes ?? [];
  const online = list.filter((n) => n.status === 'online').length;

  const logout = async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    window.location.assign('/');
  };
  const themeBtn = (
    <Button view="flat" size="m" onClick={toggle} title={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'} aria-label="Переключить тему">
      <Icon data={theme === 'light' ? Moon : Sun} size={16} />
    </Button>
  );
  const outBtn = (
    <Button view="flat" size="m" onClick={logout} title="Выйти" aria-label="Выйти">
      <Icon data={ArrowRightFromSquare} size={16} />
    </Button>
  );

  if (compact) return <div className="aside-foot-compact">{themeBtn}{outBtn}</div>;
  return (
    <div className="aside-foot" aria-label="Состояние панели">
      <div className="row">
        <Text variant="body-2">{me.user.login}</Text>
        <span>{themeBtn}{outBtn}</span>
      </div>
      <div className="row"><span>нод <b>{list.length}</b></span><span>онлайн <b>{online}</b></span></div>
      <div className="row" title="Время последнего успешного обновления данных">
        <span>обновлено</span>
        {nodes.isError ? <b style={{ color: 'var(--g-color-text-danger)' }}>нет связи</b> : <b>{nodes.dataUpdatedAt ? clock(nodes.dataUpdatedAt) : '—'}</b>}
      </div>
      <div className="row">
        <span>панель {status.data ? `v${status.data.version}` : ''}</span>
        {status.data?.demo && <span className="demo-flag" title="Включён демо-режим: данные нереальные">DEMO</span>}
      </div>
    </div>
  );
}

function Shell({ me }: { me: Me }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const brand = useBranding();
  const alertCount = useAlertSummary().data?.firing ?? 0;
  const [compact, setCompact] = useState(() => {
    try {
      const saved = localStorage.getItem('popug-aside-compact');
      if (saved !== null) return saved === '1';
    } catch {
      /* без сохранённого выбора */
    }
    return window.innerWidth < 1400; // на узких экранах меню по умолчанию свёрнуто: таблицам нужна ширина
  });

  const items: MenuItem[] = [
    { id: 'overview', title: 'Обзор', icon: Pulse, current: pathname === '/', onItemClick: () => nav('/') },
    { id: 'nodes', title: 'Ноды', icon: Server, current: pathname.startsWith('/nodes'), onItemClick: () => nav('/nodes') },
    { id: 'routes', title: 'Маршруты', icon: ArrowsRotateRight, current: pathname.startsWith('/routes'), onItemClick: () => nav('/routes') },
    { id: 'clients', title: 'Клиенты', icon: PersonWorker, current: pathname.startsWith('/clients'), onItemClick: () => nav('/clients') },
    { id: 'torrent', title: 'Торрент-блокер', icon: Magnet, current: pathname.startsWith('/torrent'), onItemClick: () => nav('/torrent') },
    { id: 'alerts', title: 'Алерты', icon: Bell, rightAdornment: alertCount > 0 ? <Label theme="danger" size="xs">{alertCount}</Label> : undefined, current: pathname.startsWith('/alerts'), onItemClick: () => nav('/alerts') },
    { id: 'exits', title: 'Выходы', icon: Globe, current: pathname.startsWith('/exits'), onItemClick: () => nav('/exits') },
    { id: 'audit', title: 'Аудит', icon: ClockArrowRotateLeft, current: pathname.startsWith('/audit'), onItemClick: () => nav('/audit') },
    { id: 'settings', title: 'Настройки', icon: Gear, current: pathname.startsWith('/settings'), onItemClick: () => nav('/settings') },
  ];

  return (
    <AsideHeader
      logo={{ text: brand.name, iconSrc: brand.logo, iconSize: 28, onClick: () => nav('/') }}
      compact={compact}
      onChangeCompact={(c) => {
        setCompact(c);
        try {
          localStorage.setItem('popug-aside-compact', c ? '1' : '0');
        } catch {
          /* не запомнится */
        }
      }}
      menuItems={items}
      renderFooter={({ compact: c }) => <AsideFooter me={me} compact={c} />}
      renderContent={() => (
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/nodes/:id/*" element={<NodePage />} />
          <Route path="/routes" element={<RoutesPage />} />
          <Route path="/routes/:id" element={<RoutePage />} />
          <Route path="/clients/*" element={<ClientsPage />} />
          <Route path="/torrent" element={<TorrentPage />} />
          <Route path="/alerts/*" element={<AlertsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/exits" element={<ExitsPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    />
  );
}

export function App() {
  const me = useMe();
  useApplyBranding();

  if (me.isPending) return null;
  const unauth = me.error instanceof ApiError && me.error.status === 401;
  if (me.isError && !unauth) {
    return (
      <div className="auth">
        <div className="auth-box">
          <Text color="danger">Не удалось связаться с панелью: {me.error.message}</Text>
          <Button onClick={() => me.refetch()}>Повторить</Button>
        </div>
      </div>
    );
  }
  if (unauth || me.data?.status === 'totp_setup') {
    return <LoginPage setup={me.data?.status === 'totp_setup'} onDone={() => me.refetch()} />;
  }
  return <Shell me={me.data!} />;
}
