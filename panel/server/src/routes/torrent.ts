import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { actorOf, audit } from '../lib/audit.js';
import { HttpError, parse, requireAuth } from '../lib/http.js';
import { RemnaError } from '../lib/remnawave.js';
import { loadRemna } from '../lib/settings.js';
import { loadTorrentState, pollOnce, TORRENT_ACTIONS, torrentStats } from '../lib/torrent.js';

export function torrentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const auth = { preHandler: requireAuth };

  app.get('/api/torrent', auth, async () => {
    const s = await loadRemna(db);
    const st = await loadTorrentState(db);
    return {
      configured: !!s.url && !!s.tokenEnc,
      enabled: s.enabled,
      observeOnly: s.observeOnly,
      pollIntervalSec: s.pollIntervalSec,
      state: { initialized: st.initialized, cursor: st.cursor, lastPollAt: st.lastPollAt, lastOkAt: st.lastOkAt, lastError: st.lastError, warning: st.warning },
      stats: await torrentStats(db),
    };
  });

  const Query = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    action: z.enum(TORRENT_ACTIONS).optional(),
    before: z.string().datetime().optional(),
  });
  app.get('/api/torrent/events', auth, async (req) => {
    const q = parse(Query, req.query);
    const rows = await db
      .select()
      .from(schema.torrentEvents)
      .where(and(q.action ? eq(schema.torrentEvents.action, q.action) : undefined, q.before ? lt(schema.torrentEvents.at, new Date(q.before)) : undefined))
      .orderBy(desc(schema.torrentEvents.at))
      .limit(q.limit);
    return { events: rows };
  });

  /** Опросить Remnawave прямо сейчас. */
  app.post('/api/torrent/poll', { ...auth, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    try {
      const r = await pollOnce(ctx);
      await audit(db, actorOf(req), 'torrent.poll', undefined, { ...r }, req.ip);
      return r;
    } catch (e) {
      if (e instanceof RemnaError) throw new HttpError(502, 'remnawave', e.message);
      throw e;
    }
  });
}
