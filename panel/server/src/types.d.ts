import type { SessionInfo, SessionUser } from './lib/auth.js';
import type { NodeRow } from './lib/nodes.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    session?: SessionInfo;
    agentNode?: NodeRow;
  }
}
