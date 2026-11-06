import { randomUUID } from 'node:crypto';
import type { Op, Result } from '@popug/protocol';
import type { WebSocket } from 'ws';

export interface AgentConn {
  nodeId: string;
  socket: WebSocket;
  connectedAt: Date;
  /** true после hello и welcome. */
  ready: boolean;
  ops: Set<string>;
  pending: Map<string, { resolve: (r: Result) => void; timer: NodeJS.Timeout }>;
}

/** Подключённые агенты. Одна активная связь на ноду: новая вытесняет старую. */
export class Registry {
  private conns = new Map<string, AgentConn>();

  /** Возвращает вытесненное соединение, если оно было. */
  register(conn: AgentConn): AgentConn | undefined {
    const prev = this.conns.get(conn.nodeId);
    this.conns.set(conn.nodeId, conn);
    return prev;
  }

  unregister(conn: AgentConn): boolean {
    if (this.conns.get(conn.nodeId) !== conn) return false;
    this.conns.delete(conn.nodeId);
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      p.resolve({ t: 'result', id, ok: false, error: 'соединение с агентом закрыто', data: undefined });
    }
    conn.pending.clear();
    return true;
  }

  isOnline(nodeId: string): boolean {
    return this.conns.get(nodeId)?.ready === true;
  }

  /** Агент подключён и умеет эту операцию (старые агенты её не знают). */
  supports(nodeId: string, op: string): boolean {
    return this.conns.get(nodeId)?.ops.has(op) === true;
  }

  get(nodeId: string): AgentConn | undefined {
    return this.conns.get(nodeId);
  }

  onlineCount(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.ready) n++;
    return n;
  }

  close(nodeId: string, code: number, reason: string): void {
    this.conns.get(nodeId)?.socket.close(code, reason);
  }

  /** Односторонняя отправка (например checks_config). false — агент не подключён. */
  sendRaw(nodeId: string, msg: unknown): boolean {
    const conn = this.conns.get(nodeId);
    if (!conn?.ready) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  /** Отправляет операцию из фиксированного списка и ждёт result. */
  send(nodeId: string, op: Op, opts: { args?: unknown; timeoutMs?: number } = {}): Promise<Result> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const conn = this.conns.get(nodeId);
    if (!conn?.ready) return Promise.resolve({ t: 'result', id: '', ok: false, error: 'агент не подключён', data: undefined });
    if (!conn.ops.has(op)) {
      return Promise.resolve({ t: 'result', id: '', ok: false, error: `агент не поддерживает операцию ${op}: обновите его`, data: undefined });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ t: 'result', id, ok: false, error: 'агент не ответил вовремя', data: undefined });
      }, timeoutMs);
      conn.pending.set(id, { resolve, timer });
      conn.socket.send(JSON.stringify({ t: 'cmd', id, op, ...(opts.args !== undefined ? { args: opts.args } : {}) }));
    });
  }

  resolve(conn: AgentConn, r: Result): void {
    const p = conn.pending.get(r.id);
    if (!p) return;
    clearTimeout(p.timer);
    conn.pending.delete(r.id);
    p.resolve(r);
  }
}
