import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';

/** Только эти файлы, только по точному имени: никаких путей из запроса. */
const DL_FILES: Record<string, string> = {
  'popug-agent-linux-amd64': 'application/octet-stream',
  'popug-agent-linux-arm64': 'application/octet-stream',
  SHA256SUMS: 'text/plain; charset=utf-8',
  'popug-agent.service': 'text/plain; charset=utf-8',
  'popug-agent-linux-amd64.sig': 'text/plain; charset=utf-8',
  'popug-agent-linux-arm64.sig': 'text/plain; charset=utf-8',
  'update.pub': 'text/plain; charset=utf-8',
  VERSION: 'text/plain; charset=utf-8',
};

export function distRoutes(app: FastifyInstance, { config }: Ctx): void {
  const dir = resolve(config.AGENT_DIST);

  app.get('/install.sh', async (_req, reply) => {
    const file = join(dir, 'install.sh');
    if (!existsSync(file)) return reply.code(404).type('text/plain').send('install.sh отсутствует на панели (AGENT_DIST)\n');
    // Адрес панели берётся из PUBLIC_URL, а не из заголовка Host: скрипт запускается под root.
    const body = (await readFile(file, 'utf8')).replace('__PANEL_URL__', config.publicUrl);
    return reply.header('cache-control', 'no-store').type('text/x-shellscript; charset=utf-8').send(body);
  });

  app.get<{ Params: { name: string } }>('/dl/:name', async (req, reply) => {
    const type = Object.hasOwn(DL_FILES, req.params.name) ? DL_FILES[req.params.name] : undefined;
    const file = join(dir, req.params.name);
    if (!type || !existsSync(file)) return reply.code(404).type('text/plain').send('не найдено\n');
    return reply.header('cache-control', 'no-cache').type(type).send(createReadStream(file));
  });
}
