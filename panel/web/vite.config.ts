import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В dev фронт на :5173 проксирует API и WebSocket на панель (:3000).
const target = process.env.PANEL_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': target, '/install.sh': target, '/dl': target, '/ws': { target, ws: true } } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 600 },
});
