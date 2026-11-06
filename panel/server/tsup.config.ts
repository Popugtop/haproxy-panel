import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Протокол — workspace-пакет с TS-исходниками: вшиваем в бандл.
  noExternal: ['@popug/protocol'],
});
