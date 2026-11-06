import {
  AgentMessageSchema, CloseCode, EnrollRequestSchema, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, type EnrollResponse,
} from '@popug/protocol';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData } from 'ws';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { audit, SYSTEM } from '../lib/audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';
import type { AgentConn } from '../lib/registry.js';
import { ingestAgentChecks, pushChecks } from '../lib/checks.js';
import { fullSyncBans } from '../lib/bans.js';
import { reconcile } from '../lib/routes.js';

export const METRICS_INTERVAL_SEC = 15;
const HELLO_TIMEOUT_MS = 10_000;
const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 55_000;

const bearer = (req: FastifyRequest): string | null => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

export function agentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, registry, ingestor } = ctx;

  // ───── обмен токена на ключ ─────
  app.post('/api/agent/enroll', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(EnrollRequestSchema, req.body);
    if (body.protocol < MIN_PROTOCOL_VERSION || body.protocol > PROTOCOL_VERSION) {
      throw new HttpError(426, 'protocol_mismatch', `Версия протокола агента (${body.protocol}) не поддерживается панелью (${MIN_PROTOCOL_VERSION}–${PROTOCOL_VERSION}). Скачайте свежий install.sh.`);
    }
    const key = randomToken('nk', 32);
    // Условный UPDATE делает токен строго одноразовым даже при гонке двух запросов.
    const [node] = await db
      .update(schema.nodes)
      .set({
        enrollTokenHash: null,
        enrollExpiresAt: null,
        keyHash: sha256Hex(key),
        keyCreatedAt: new Date(),
        keyRevokedAt: null,
        hostname: body.hostname,
        agentVersion: body.agentVersion,
        protocol: body.protocol,
        lastRemoteIp: req.ip,
      })
      .where(and(eq(schema.nodes.enrollTokenHash, sha256Hex(body.token)), gt(schema.nodes.enrollExpiresAt, new Date())))
      .returning();
    if (!node) throw new HttpError(403, 'invalid_token', 'Токен не найден, уже использован или истёк. Создайте новый в панели.');
    registry.close(node.id, CloseCode.Superseded, 'ключ заменён повторной регистрацией');
    await audit(db, SYSTEM, 'node.enrolled', { type: 'node', id: node.id }, { hostname: body.hostname, agentVersion: body.agentVersion }, req.ip);
    const res: EnrollResponse = { nodeId: node.id, key };
    return res;
  });

  // ───── постоянное соединение ─────
  app.get(
    '/ws/agent',
    {
      websocket: true,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      // Проверка ключа ДО апгрейда: чужой получает обычный 401 и не занимает сокет.
      preValidation: async (req) => {
        const key = bearer(req);
        if (!key) throw new HttpError(401, 'unauthorized', 'Нужен ключ ноды');
        const [n] = await db.select().from(schema.nodes).where(eq(schema.nodes.keyHash, sha256Hex(key))).limit(1);
        if (!n) throw new HttpError(401, 'unauthorized', 'Неверный ключ');
        if (n.keyRevokedAt) throw new HttpError(403, 'revoked', 'Ключ отозван');
        req.agentNode = n;
      },
    },
    (socket, req) => {
      const node = req.agentNode!;
      const conn: AgentConn = { nodeId: node.id, socket, connectedAt: new Date(), ready: false, ops: new Set(), pending: new Map() };
      const prev = registry.register(conn);
      prev?.socket.close(CloseCode.Superseded, 'вытеснен новым соединением');

      const log = req.log.child({ node: node.id, nodeName: node.name });
      let alive = true;
      let lastFrameAt = Date.now();
      const helloTimer = setTimeout(() => socket.close(CloseCode.BadFrame, 'hello не получен'), HELLO_TIMEOUT_MS);
      const pinger = setInterval(() => {
        if (Date.now() - lastFrameAt > DEAD_AFTER_MS && !alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, PING_EVERY_MS);
      socket.on('pong', () => {
        alive = true;
        lastFrameAt = Date.now();
      });

      // Кадры обрабатываются строго по очереди: порядок метрик важен для расчёта дельт.
      let chain: Promise<void> = Promise.resolve();
      socket.on('message', (raw: RawData) => {
        lastFrameAt = Date.now();
        alive = true;
        const text = raw.toString();
        chain = chain.then(() => onFrame(text)).catch((err) => log.error({ err }, 'ошибка обработки кадра агента'));
      });

      const onFrame = async (text: string) => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return socket.close(CloseCode.BadFrame, 'не JSON');
        }
        const msg = AgentMessageSchema.safeParse(json);
        if (!msg.success) {
          log.warn({ issues: msg.error.issues.slice(0, 3) }, 'кадр агента не прошёл валидацию');
          return socket.close(CloseCode.BadFrame, 'кадр не соответствует протоколу');
        }
        const m = msg.data;
        switch (m.t) {
          case 'hello': {
            if (m.protocol < MIN_PROTOCOL_VERSION || m.protocol > PROTOCOL_VERSION) {
              return socket.close(CloseCode.ProtocolMismatch, `протокол ${m.protocol} не поддерживается (нужно ${MIN_PROTOCOL_VERSION}–${PROTOCOL_VERSION})`);
            }
            clearTimeout(helloTimer);
            conn.ops = new Set(m.ops);
            conn.ready = true;
            await db
              .update(schema.nodes)
              .set({
                agentVersion: m.agentVersion,
                protocol: m.protocol,
                haproxyVersion: m.haproxy.version,
                haproxyInstalled: m.haproxy.installed,
                hostname: m.hostname,
                os: m.os,
                arch: m.arch,
                updateReady: m.updateReady,
                ops: m.ops,
                addrs: m.addrs,
                lastRemoteIp: req.ip,
                lastConnectedAt: new Date(),
                lastSeenAt: new Date(),
                configSha256: m.configSha256,
              })
              .where(eq(schema.nodes.id, node.id));
            await reconcile(db, node.id, m.configSha256);
            // IP не задан вручную: берём публичный адрес интерфейса, а при его отсутствии — адрес, с которого пришло соединение.
            if (!node.ip) await db.update(schema.nodes).set({ ip: m.addrs[0] ?? req.ip }).where(eq(schema.nodes.id, node.id));
            socket.send(JSON.stringify({ t: 'welcome', protocol: PROTOCOL_VERSION, serverTime: Date.now(), nodeId: node.id, metricsIntervalSec: METRICS_INTERVAL_SEC }));
            log.info({ agentVersion: m.agentVersion, haproxy: m.haproxy.version }, 'агент подключён');
            await pushChecks(ctx, [node.id]);
            // Не ждём ответа: кадры обрабатываются строго по очереди, и ответ агента прочитается только после этого хендлера.
            void fullSyncBans(ctx, node.id).catch((err) => log.warn({ err }, 'не удалось синхронизировать баны'));
            return;
          }
          case 'metrics':
            if (!conn.ready) return socket.close(CloseCode.BadFrame, 'metrics до hello');
            await ingestor.ingest(node.id, m);
            return;
          case 'checks':
            if (!conn.ready) return socket.close(CloseCode.BadFrame, 'checks до hello');
            await ingestAgentChecks(db, node.id, m.results);
            return;
          case 'result':
            registry.resolve(conn, m);
            return;
        }
      };

      socket.on('close', () => {
        clearTimeout(helloTimer);
        clearInterval(pinger);
        if (registry.unregister(conn)) {
          void db
            .update(schema.nodes)
            .set({ lastDisconnectedAt: new Date() })
            .where(eq(schema.nodes.id, node.id))
            .catch((err) => log.error({ err }, 'не удалось записать отключение'));
          log.info('агент отключён');
        }
      });
      socket.on('error', (err) => log.warn({ err }, 'ошибка сокета агента'));
    },
  );
}
