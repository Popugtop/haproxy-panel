import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ReleaseFile {
  sha256: string;
  /** Рядом лежит подпись релиза: без неё обновление по кнопке невозможно. */
  signed: boolean;
}

export interface AgentRelease {
  /** Версия агентов, которые лежат на панели. null — не известна (dev-сборка). */
  version: string | null;
  files: Partial<Record<'amd64' | 'arm64', ReleaseFile>>;
  /** Есть публичный ключ подписи: новые установки закрепят его, и их можно обновлять по кнопке. */
  hasPublicKey: boolean;
}

const cache = new Map<string, { mtime: number; sha: string }>();

function sha(path: string): string {
  const mtime = statSync(path).mtimeMs;
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.sha;
  const s = createHash('sha256').update(readFileSync(path)).digest('hex');
  cache.set(path, { mtime, sha: s });
  return s;
}

export function readRelease(dist: string): AgentRelease {
  const verFile = join(dist, 'VERSION');
  const version = existsSync(verFile) ? readFileSync(verFile, 'utf8').trim() || null : null;
  const files: AgentRelease['files'] = {};
  for (const arch of ['amd64', 'arm64'] as const) {
    const bin = join(dist, `popug-agent-linux-${arch}`);
    if (existsSync(bin)) files[arch] = { sha256: sha(bin), signed: existsSync(`${bin}.sig`) };
  }
  return { version, files, hasPublicKey: existsSync(join(dist, 'update.pub')) };
}

/** a строго новее b (числовые компоненты). */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').replace(/[-+].*$/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
