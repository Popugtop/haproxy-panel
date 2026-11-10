import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Тесты фронта: только окна и мелкие утилиты, настоящий браузер не нужен.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Without globals, @testing-library/react cannot register its automatic cleanup after each test.
    globals: true,
    // gravity-ui тащит .css из ESM-сборки: без инлайна Node не умеет их импортировать.
    server: { deps: { inline: [/@gravity-ui\//] } },
  },
});
