export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'popug',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON */
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ApiError(res.status, 'unavailable', 'Панель не отвечает. Если запускаете локально, проверьте, что работает npm run dev:server.');
  }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'http_error', e.message ?? `Ошибка ${res.status}`);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ───── типы ответов (повторяют panel/server/src/lib/nodes.ts) ─────

export type NodeStatus = 'pending' | 'online' | 'offline' | 'revoked';

export interface QuotaUsage {
  periodStart: string;
  periodEnd: string;
  rxBytes: number;
  txBytes: number;
  usedBytes: number;
  limitBytes: number | null;
  pct: number | null;
  counts: 'tx' | 'txrx';
}

export interface PublicNode {
  id: string;
  name: string;
  ip: string | null;
  domain: string | null;
  hoster: string | null;
  notes: string | null;
  quotaTb: number | null;
  billingDay: number;
  quotaCounts: 'tx' | 'txrx';
  defaultIpLimitMbit: number | null;
  extraConfig: string | null;
  defaultRouteId: string | null;
  importDone: boolean;
  createdAt: string;
  status: NodeStatus;
  agentVersion: string | null;
  protocol: number | null;
  haproxyVersion: string | null;
  haproxyInstalled: boolean | null;
  hostname: string | null;
  os: string | null;
  ops: string[];
  addrs: string[];
  lastRemoteIp: string | null;
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  enrollPending: boolean;
  bwlimSupported: boolean | null;
}

export interface LiveSummary {
  ts: number;
  rxBps: number;
  txBps: number;
  cpuPct: number | null;
  memUsedPct: number | null;
  load1: number;
  sessions: number;
  activeClients: number | null;
  /** IP с заметным трафиком за минуту; null — агент старый и не считает. */
  flowingClients: number | null;
  backendsTotal: number;
  backendsDown: number;
  haproxyOk: boolean;
  haproxyError: string | null;
}

export interface NodeSummary extends PublicNode {
  live: LiveSummary | null;
  quota: QuotaUsage;
  traffic24h: { rx: number; tx: number };
}

export interface ClientRow {
  ip: string;
  connCur: number;
  connCnt: number;
  bytesIn: number;
  bytesOut: number;
  rateIn: number;
  rateOut: number;
}

export interface LiveBackend {
  name: string;
  status: string;
  scur: number;
  stot: number;
  inBps: number;
  outBps: number;
  servers: { name: string; status: string; check: string | null; checkMs: number | null }[];
}

export interface LiveData {
  ts: number;
  stale: boolean;
  sys: {
    cpuPct: number | null;
    load1: number;
    load5: number;
    load15: number;
    memTotal: number;
    memAvail: number;
    uptimeSec: number;
    rxBps: number;
    txBps: number;
    ifaces: { name: string; rx: number; tx: number }[];
  };
  haproxy: { ok: boolean; error: string | null; version: string | null; uptimeSec: number | null };
  backends: LiveBackend[];
  sessions: number;
  clients: { tracked: number; active: number; flowing?: number; top: ClientRow[] } | null;
  clientsError: string | null;
}

export interface BackendTraffic {
  backend: string;
  in24h: number;
  out24h: number;
  inPeriod: number;
  outPeriod: number;
}

export interface NodeDetail {
  node: PublicNode;
  summary: LiveSummary | null;
  live: LiveData | null;
  quota: QuotaUsage;
  traffic24h: { rx: number; tx: number };
  backendTraffic: BackendTraffic[];
}

export interface Series {
  bin: number;
  from: number;
  to: number;
  t: number[];
  rxBps: (number | null)[];
  txBps: (number | null)[];
  cpu: (number | null)[];
  memUsedPct: (number | null)[];
  load1: (number | null)[];
  sessions: (number | null)[];
  clients: (number | null)[];
  backends: Record<string, { inBps: (number | null)[]; outBps: (number | null)[]; sessions: (number | null)[] }>;
}

export interface FleetSeries {
  bin: number;
  from: number;
  to: number;
  t: number[];
  txBps: number[];
  rxBps: number[];
}

export interface Enrollment {
  token: string;
  expiresAt: string;
  command: string;
}

export interface Me {
  status: 'ok' | 'totp_setup';
  user: { id: string; login: string; role: string };
}

export const RANGE_LABELS = { '1h': '1 ч', '6h': '6 ч', '24h': '24 ч', '7d': '7 д', '30d': '30 д', '90d': '90 д', '1y': '1 г' } as const;
export type RangeKey = keyof typeof RANGE_LABELS;

// ───── этап 2: выходы, маршруты, конфиг, проверки ─────

export type RouteTone = 'ok' | 'warn' | 'bad' | 'unknown';

export interface ExitDto {
  id: string;
  name: string;
  country: string | null;
  host: string;
  port: number;
}

export interface ExitRow extends ExitDto {
  routes: number;
}

export interface FirewallHints {
  port: number;
  bridges: { nodeId: string; name: string; ip: string }[];
  noIp: string[];
  ufw: string;
  iptables: string;
}

export interface RouteNodeStatus {
  nodeId: string;
  nodeName: string;
  tone: RouteTone;
  reason: string;
  lastAt: string | null;
  avgMs: number | null;
  /** Конфиг этой ноды ещё не отражает изменения маршрутов. */
  pendingApply: boolean;
  online: boolean;
}

export interface RouteDto {
  id: string;
  name: string;
  slug: string;
  snis: string[];
  proxyProtocol: boolean;
  healthCheck: boolean;
  enabled: boolean;
  limitMbit: number | null;
  ipLimitMbit: number | null;
  exits: ExitDto[];
  nodeIds: string[];
  status: RouteTone;
  nodes: RouteNodeStatus[];
}

export interface CheckRow {
  ts: string;
  nodeId: string;
  exitId: string | null;
  source: 'agent' | 'panel';
  ok: boolean;
  ms: number | null;
  error: string | null;
}

/** Нода, на которой после изменения маршрута нужно применить конфиг. */
export interface ApplyTarget {
  nodeId: string;
  nodeName: string;
  online: boolean;
  pendingApply: boolean;
  /** Маршрут с этой ноды убран: в самом маршруте её уже нет, но конфиг на ней старый. */
  removed?: boolean;
}

export interface RouteInput {
  name: string;
  slug: string;
  snis: string[];
  exitIds: string[];
  nodeIds: string[];
  proxyProtocol: boolean;
  healthCheck: boolean;
  enabled: boolean;
  limitMbit: number | null;
  ipLimitMbit: number | null;
}

export type VersionStatus = 'applying' | 'applied' | 'failed' | 'rolled_back' | 'rollback_failed' | 'imported';

export interface VersionBrief {
  id: string;
  number: number;
  status: VersionStatus;
  source: 'panel' | 'import';
  createdAt: string;
  createdBy: string;
  finishedAt: string | null;
  durationMs: number | null;
  output: string | null;
  sha256: string;
}

export interface ConfigState {
  applied: (VersionBrief & { cfg: string; sniMap: string }) | null;
  desired: { cfg: string; sniMap: string; sha256: string };
  inSync: boolean;
  applyingNumber: number | null;
  lastFailed: VersionBrief | null;
  drift: boolean;
  importPending: boolean;
  versions: VersionBrief[];
  expected: number;
}

export interface ApplyReply {
  ok: boolean;
  error: string | null;
  rolledBack: boolean;
  output: string;
  version: VersionBrief | null;
}

export interface ImportedRoute {
  backend: string;
  slug: string;
  country: string;
  snis: string[];
  exits: { serverName: string; host: string; port: number }[];
  proxyProtocol: boolean;
  healthCheck: boolean;
}

export interface ImportPreviewDto {
  cfgSha256: string;
  path: string;
  preview: {
    routes: ImportedRoute[];
    defaultBackend: string | null;
    warnings: string[];
    ignoredSections: { kind: string; name: string; note: string }[];
  };
  matches: Record<string, { exitIds: (string | null)[]; routeId: string | null; routeName: string | null; sameSnis: boolean }>;
}

// ───── клиенты, баны, лимиты, обновление, аккаунт ─────

export interface LiveClient {
  ip: string;
  connCur: number;
  connCnt: number;
  bytesIn: number;
  bytesOut: number;
  rateIn: number;
  rateOut: number;
  nodeId: string;
  nodeName: string;
  ban: { id: string; expiresAt: string; reason: string } | null;
  limit: { id: string; mbit: number } | null;
}

export interface ClientsReply {
  nodes: { id: string; name: string; online: boolean; live: boolean; stale: boolean; error: string | null; tracked: number; active: number }[];
  rows: LiveClient[];
  at: number;
}

export interface BanRow {
  id: string;
  ip: string;
  nodeId: string;
  nodeName: string;
  reason: 'manual' | 'torrent' | string;
  note: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface LimitRow {
  id: string;
  ip: string;
  nodeId: string;
  nodeName: string;
  mbit: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface BanOutcome {
  nodeId: string;
  nodeName: string;
  applied: boolean;
  error: string | null;
}

export interface SystemInfo {
  version: string;
  publicUrl: string;
  demo: boolean;
  agentsOnline: number;
  sniDomain: string;
  release: { version: string | null; files: Partial<Record<'amd64' | 'arm64', { sha256: string; signed: boolean }>>; hasPublicKey: boolean };
}

export interface AccountDto {
  login: string;
  role: string;
  totpEnabled: boolean;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface PublicBranding {
  name: string;
  /** Путь к копии логотипа на панели либо null (тогда стандартный попугай). */
  logo: string | null;
}

export interface BrandingSettings extends PublicBranding {
  defaultName: string;
  logoUrl: string | null;
  logoBytes: number | null;
  logoMime: string | null;
}

// ───────── торрент-блокер, алерты, аудит, интеграции ─────────

export type TorrentAction = 'ban' | 'observe' | 'skip' | 'already_banned' | 'error';

export interface TorrentStatus {
  configured: boolean;
  enabled: boolean;
  observeOnly: boolean;
  pollIntervalSec: number;
  state: { initialized: boolean; cursor: number; lastPollAt: string | null; lastOkAt: string | null; lastError: string | null; warning: string | null };
  stats: { last24h: Partial<Record<TorrentAction, number>>; activeBans: number };
}

export interface TorrentEvent {
  id: string;
  at: string;
  reportId: number;
  username: string;
  remnaNode: string;
  ip: string;
  action: TorrentAction;
  reason: string | null;
  durationSec: number | null;
  nodesCount: number;
}

export interface RemnaSettingsDto {
  enabled: boolean;
  url: string;
  hasToken: boolean;
  headerNames: string[];
  observeOnly: boolean;
  banMode: 'report' | 'fixed';
  scope: 'route' | 'all';
  fixedBanSec: number;
  maxBanSec: number;
  pollIntervalSec: number;
  allowlist: string[];
}

export interface RemnaSavePayload extends Omit<RemnaSettingsDto, 'hasToken' | 'headerNames'> {
  token?: string;
  clearToken?: boolean;
  headers?: Record<string, string>;
}

export interface RemnaTestResult {
  reports: { ok: boolean; total?: number; error?: string };
  nodes: { ok: boolean; count?: number; error?: string };
}

export interface TelegramSettingsDto {
  enabled: boolean;
  hasToken: boolean;
  chatId: string;
}

export type AlertSeverity = 'warn' | 'crit';

export interface AlertDto {
  id: string;
  kind: string;
  title: string;
  subject: string;
  label: string;
  severity: AlertSeverity;
  status: 'firing' | 'resolved' | 'pending';
  message: string;
  value: number | null;
  firedAt: string | null;
  resolvedAt: string | null;
  lastNotifiedAt: string | null;
  notifyCount: number;
  notifyError: string | null;
}

export interface AlertRuleDto {
  kind: string;
  title: string;
  description: string;
  event: boolean;
  unit: '%' | 'Мбит/с' | null;
  hasThreshold2: boolean;
  enabled: boolean;
  threshold: number | null;
  threshold2: number | null;
  forMin: number;
  repeatHours: number;
  defaults: { enabled: boolean; threshold: number | null; threshold2: number | null; forMin: number; repeatHours: number };
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  diff: Record<string, unknown> | null;
  ip: string | null;
}

export interface TrafficBytes {
  tx: number;
  rx: number;
}

export interface TrafficSummary {
  day: string;
  today: TrafficBytes;
  month: TrafficBytes;
  total: TrafficBytes;
  since: string | null;
}

export type TrafficGroup = 'node' | 'route';

export interface TrafficStats {
  by: TrafficGroup;
  from: string;
  to: string;
  days: string[];
  total: number;
  avgPerDay: number;
  peak: { day: string; bytes: number } | null;
  dailyTotal: number[];
  series: { key: string; name: string; total: number; daily: number[] }[];
  others: number;
}
