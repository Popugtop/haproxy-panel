import { useQuery } from '@tanstack/react-query';
import { api, type AlertDto, type AlertRuleDto, type BanRow, type ClientsReply, type ConfigState, type ExitRow, type FleetSeries, type LimitRow, type NodeSummary, type RemnaSettingsDto, type RouteDto, type SystemInfo, type TelegramSettingsDto, type TorrentEvent, type TorrentStatus } from './api';

export function useNodes() {
  return useQuery({ queryKey: ['nodes'], queryFn: () => api.get<{ nodes: NodeSummary[] }>('/api/nodes'), refetchInterval: 5_000 });
}

export function usePanelStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => api.get<{ version: string; demo: boolean }>('/api/status'), staleTime: Infinity });
}

export function useFleetTraffic() {
  return useQuery({ queryKey: ['fleet-traffic'], queryFn: () => api.get<FleetSeries>('/api/overview/traffic'), refetchInterval: 15_000 });
}

export const useRoutes = () => useQuery({ queryKey: ['routes'], queryFn: () => api.get<{ routes: RouteDto[] }>('/api/routes'), refetchInterval: 10_000 });
export const useExits = () => useQuery({ queryKey: ['exits'], queryFn: () => api.get<{ exits: ExitRow[] }>('/api/exits') });
export const useNodeConfig = (id: string, refetchMs = 6_000) => useQuery({ queryKey: ['config', id], queryFn: () => api.get<ConfigState>(`/api/nodes/${id}/config`), refetchInterval: refetchMs });

export const useClients = (nodeId?: string) =>
  useQuery({
    queryKey: ['clients', nodeId ?? 'all'],
    queryFn: () => api.get<ClientsReply>(`/api/clients${nodeId ? `?nodeId=${nodeId}` : ''}`),
    refetchInterval: 3_000, // «в реальном времени»: опрашиваем агентов каждые 3 секунды, пока страница открыта
    placeholderData: (prev) => prev,
  });
export const useBans = () => useQuery({ queryKey: ['bans'], queryFn: () => api.get<{ bans: BanRow[] }>('/api/bans'), refetchInterval: 10_000 });
export const useLimits = () => useQuery({ queryKey: ['limits'], queryFn: () => api.get<{ limits: LimitRow[] }>('/api/limits'), refetchInterval: 10_000 });
export const useSystem = () => useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system'), staleTime: 30_000 });

// ───────── торрент-блокер, алерты, аудит, интеграции ─────────
export const useTorrent = () => useQuery({ queryKey: ['torrent'], queryFn: () => api.get<TorrentStatus>('/api/torrent'), refetchInterval: 10_000 });
export const useTorrentEvents = (action?: string) =>
  useQuery({ queryKey: ['torrent-events', action ?? ''], queryFn: () => api.get<{ events: TorrentEvent[] }>(`/api/torrent/events?limit=200${action ? `&action=${action}` : ''}`), refetchInterval: 10_000 });
export const useRemnaSettings = () => useQuery({ queryKey: ['remna-settings'], queryFn: () => api.get<RemnaSettingsDto>('/api/settings/remnawave') });
export const useTelegramSettings = () => useQuery({ queryKey: ['telegram-settings'], queryFn: () => api.get<TelegramSettingsDto>('/api/settings/telegram') });
export const useAlerts = () => useQuery({ queryKey: ['alerts'], queryFn: () => api.get<{ active: AlertDto[]; pending: number; telegram: { configured: boolean; enabled: boolean } }>('/api/alerts'), refetchInterval: 10_000 });
export const useAlertSummary = () => useQuery({ queryKey: ['alert-summary'], queryFn: () => api.get<{ firing: number; crit: number; warn: number }>('/api/alerts/summary'), refetchInterval: 15_000 });
export const useAlertHistory = () => useQuery({ queryKey: ['alert-history'], queryFn: () => api.get<{ alerts: AlertDto[] }>('/api/alerts/history?limit=100'), refetchInterval: 30_000 });
export const useAlertRules = () => useQuery({ queryKey: ['alert-rules'], queryFn: () => api.get<{ rules: AlertRuleDto[] }>('/api/alerts/rules') });
