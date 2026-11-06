/**
 * Клиент Remnawave только для чтения. Поля сверены с исходниками remnawave/backend 3.4.x (libs/contract):
 *   GET /api/node-plugins/torrent-blocker  — отчёты (scope node-plugins:torrent-blocker-reports)
 *   GET /api/nodes                         — ноды (scope nodes:list), нужны для списка «не банить»
 */
import { z } from 'zod';
import type { RemnaCreds } from './settings.js';

export type Http = typeof fetch;

export interface TorrentReport {
  id: number;
  username: string;
  nodeUuid: string;
  nodeName: string;
  /** Настоящий IP клиента (xray видит его через PROXY protocol). */
  ip: string;
  /** false — IP или пользователь в ignoreLists плагина: такой отчёт не баним. */
  blocked: boolean;
  blockDurationSec: number;
  willUnblockAt: Date | null;
}

export interface RemnaNode {
  uuid: string;
  name: string;
  address: string;
  ips: string[];
}

export class RemnaError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const num = z.coerce.number().catch(0);
const Report = z.object({
  id: z.coerce.number().int(),
  user: z.object({ username: z.string().catch('') }).partial().catch({}),
  node: z.object({ uuid: z.string().catch(''), name: z.string().catch('') }).partial().catch({}),
  report: z
    .object({
      actionReport: z
        .object({
          blocked: z.boolean().nullish(),
          ip: z.string().nullish(),
          blockDuration: num,
          willUnblockAt: z.string().nullish(),
        })
        .partial()
        .catch({}),
    })
    .partial()
    .catch({}),
});

const Page = z.object({ response: z.object({ records: z.array(z.unknown()), total: z.coerce.number().int().catch(0) }) });
const Nodes = z.object({
  response: z.array(
    z.object({
      uuid: z.string(),
      name: z.string().catch(''),
      address: z.string().catch(''),
      ips: z.array(z.object({ ip: z.string() }).partial()).nullish(),
    }),
  ),
});

/** Время в разных форматах контракта: с поясом и без (без пояса — UTC). */
function parseTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseReports(body: unknown): { records: TorrentReport[]; total: number } {
  const p = Page.safeParse(body);
  if (!p.success) throw new RemnaError('Неожиданный ответ Remnawave: нет response.records. Проверьте адрес панели и версию (нужна 3.x).');
  const records: TorrentReport[] = [];
  for (const raw of p.data.response.records) {
    const r = Report.safeParse(raw);
    if (!r.success) continue; // одна битая запись не должна останавливать остальные
    const ar = r.data.report?.actionReport ?? {};
    records.push({
      id: r.data.id,
      username: r.data.user?.username ?? '',
      nodeUuid: r.data.node?.uuid ?? '',
      nodeName: r.data.node?.name ?? '',
      ip: (ar.ip ?? '').trim(),
      blocked: ar.blocked === true,
      blockDurationSec: Number(ar.blockDuration ?? 0),
      willUnblockAt: parseTime(ar.willUnblockAt),
    });
  }
  return { records, total: p.data.response.total };
}

export function parseNodes(body: unknown): RemnaNode[] {
  const p = Nodes.safeParse(body);
  if (!p.success) throw new RemnaError('Неожиданный ответ Remnawave: нет списка нод. Нужен scope nodes:list.');
  return p.data.response.map((n) => ({ uuid: n.uuid, name: n.name, address: n.address, ips: (n.ips ?? []).map((i) => i.ip ?? '').filter(Boolean) }));
}

const MAX_PAGES = 200;

export class RemnaClient {
  private base: string;
  constructor(
    private creds: RemnaCreds,
    private http: Http = fetch,
    private pageSize = 100,
  ) {
    this.base = creds.url.replace(/\/+$/, '');
  }

  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { ...this.creds.headers, authorization: `Bearer ${this.creds.token}`, accept: 'application/json', 'user-agent': 'popug-bridges-panel' },
      });
    } catch (e) {
      throw new RemnaError(`Не удалось связаться с Remnawave: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) throw new RemnaError(`Remnawave отвечает перенаправлением (HTTP ${res.status}): проверьте адрес панели, нужен конечный https://…`, res.status);
    if (res.status === 401) throw new RemnaError('Remnawave: токен неверный или просрочен (HTTP 401)', 401);
    if (res.status === 403) throw new RemnaError('Remnawave: у токена нет нужного scope либо запрос режет прокси перед панелью (HTTP 403)', 403);
    if (!res.ok) throw new RemnaError(`Remnawave ответил HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new RemnaError('Remnawave вернул не JSON: проверьте адрес панели');
    }
  }

  async page(start: number, size: number) {
    return parseReports(await this.get('/api/node-plugins/torrent-blocker', { start: String(start), size: String(size) }));
  }

  /** Самый большой ID отчёта; 0, если отчётов нет. */
  async latest(): Promise<number> {
    const p = await this.page(0, 1);
    return p.records.reduce((m, r) => Math.max(m, r.id), 0);
  }

  /**
   * Листаем от новых к старым до курсора. Новые отчёты сдвигают старые вниз, поэтому смещения дают повторы
   * (убираем по ID), но не пропуски.
   */
  async since(cursor: number): Promise<{ reports: TorrentReport[]; newest: number; truncated: boolean }> {
    const seen = new Map<number, TorrentReport>();
    let newest = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const p = await this.page(page * this.pageSize, this.pageSize);
      let reached = false;
      for (const r of p.records) {
        if (page === 0) newest = Math.max(newest, r.id);
        if (r.id <= cursor) {
          reached = true;
          continue;
        }
        seen.set(r.id, r);
      }
      if (reached || p.records.length < this.pageSize || (page + 1) * this.pageSize >= p.total) {
        return { reports: [...seen.values()].sort((a, b) => a.id - b.id), newest, truncated: false };
      }
    }
    return { reports: [...seen.values()].sort((a, b) => a.id - b.id), newest, truncated: true };
  }

  async nodes(): Promise<RemnaNode[]> {
    return parseNodes(await this.get('/api/nodes'));
  }
}
