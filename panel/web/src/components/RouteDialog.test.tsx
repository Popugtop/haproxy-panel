import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@gravity-ui/uikit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDto } from '../lib/api';
import { RouteDialog } from './RouteDialog';

// Реальные хуки не нужны: подменяем сетевые вызовы на заготовки.
vi.mock('../lib/queries', () => ({
  useNodes: () => ({ data: { nodes: [{ id: 'n1', name: 'aeza-1' }] } }),
  useExits: () => ({ data: { exits: [{ id: 'e1', name: 'Германия 1', host: '203.0.113.21', port: 443, country: 'de' }] } }),
  useRoutes: () => ({ data: { routes: [] } }),
  useSystem: () => ({ data: { sniDomain: 'popug.cloud' } }),
}));
const post = vi.fn();
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  api: {
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
  },
}));

const route = { id: 'r1', name: 'Германия', slug: 'de', snis: ['de.popug.cloud'], exits: [], nodeIds: ['n1'], proxyProtocol: true, healthCheck: true, enabled: true, limitMbit: null, ipLimitMbit: null, nodes: [{ nodeId: 'n1', nodeName: 'aeza-1', pendingApply: true, online: true }] } as unknown as RouteDto;

/** Родитель держит окно смонтированным всегда — именно так устроены страницы «Маршруты» и «Ноды». */
function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <RouteDialog
      open={open}
      presetNodeIds={['n1']}
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
    />
  );
}

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ThemeProvider theme="dark">
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </ThemeProvider>,
  );
};

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ route });
});
afterEach(() => vi.unstubAllGlobals());

describe('RouteDialog: сохранение и закрытие', () => {
  it('после «Создать» показывает шаг применения, а «Готово» закрывает окно', async () => {
    const onClose = vi.fn();
    wrap(<Host onClose={onClose} />);
    const user = userEvent.setup();

    const name = screen.getByPlaceholderText('Германия (🇷🇺 → 🇩🇪)');
    await user.type(name, 'Германия');
    const slug = screen.getByPlaceholderText('de');
    await user.type(slug, 'de');
    // SNI подставился из домена панели, а не из старых маршрутов
    await waitFor(() => expect(screen.getByDisplayValue('de.popug.cloud')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.getByText(/Маршрут «Германия» сохранён/)).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Плашка сохранения исчезла: родитель закрыл окно, и шаг «сохранён» не остался на экране
    await waitFor(() => expect(screen.queryByText(/Маршрут «Германия» сохранён/)).toBeNull());
  });

  it('крестик на шаге применения закрывает окно', async () => {
    const onClose = vi.fn();
    wrap(<Host onClose={onClose} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Германия (🇷🇺 → 🇩🇪)'), 'Германия');
    await user.type(screen.getByPlaceholderText('de'), 'de');
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.getByText(/сохранён/)).toBeTruthy());
    // Подпись крестика зависит от языка uikit: «Закрыть диалоговое окно» или «Close dialog».
    await user.click(screen.getByRole('button', { name: /закрыть диалоговое окно|close dialog/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/сохранён/)).toBeNull());
  });

  it('повторное открытие после закрытия начинается с пустой формы, без старого сохранения', async () => {
    // Host с кнопкой «Открыть»: проверяем, что сброс шагов срабатывает при каждом открытии.
    function Reopen({ onState }: { onState: () => void }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <RouteDialog open={open} presetNodeIds={['n1']} onClose={() => { setOpen(false); onState(); }} />
          <button onClick={() => setOpen(true)}>Открыть</button>
        </>
      );
    }
    const closed = vi.fn();
    wrap(<Reopen onState={closed} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Германия (🇷🇺 → 🇩🇪)'), 'Германия');
    await user.type(screen.getByPlaceholderText('de'), 'de');
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.getByText(/сохранён/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(closed).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Создать' })).toBeTruthy());
    expect(screen.queryByText(/сохранён/)).toBeNull();
    expect((screen.getByPlaceholderText('Германия (🇷🇺 → 🇩🇪)') as HTMLInputElement).value).toBe('');
  });
});
