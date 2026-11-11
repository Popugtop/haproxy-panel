import { ThemeProvider } from '@gravity-ui/uikit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { periodRange, StatsPage } from './Stats';

// Рисовать SVG в jsdom нечем: проверяем данные, которые уходят в график, и сам экран.
const charts: unknown[] = [];
vi.mock('@gravity-ui/charts', () => ({
  Chart: ({ data }: { data: unknown }) => {
    charts.push(data);
    return <div data-testid="chart" />;
  },
}));

const stats = {
  by: 'node',
  from: '2026-11-10',
  to: '2026-11-11',
  days: ['2026-11-10', '2026-11-11'],
  total: 12e9,
  avgPerDay: 6e9,
  peak: { day: '2026-11-10', bytes: 9e9 },
  dailyTotal: [9e9, 3e9],
  series: [
    { key: 'a', name: 'Aeza [SPB]', total: 8e9, daily: [6e9, 2e9] },
    { key: 'b', name: 'Beget [SPB]', total: 3e9, daily: [2e9, 1e9] },
    { key: '_other', name: 'Прочие', total: 1e9, daily: [1e9, 0] },
  ],
  others: 2,
};
const get = vi.fn();
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { get: (...a: unknown[]) => get(...a) } }));

const mount = () =>
  render(
    <ThemeProvider theme="dark">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <StatsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );

beforeEach(() => {
  charts.length = 0;
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/traffic/summary')) return { day: '2026-11-11', today: { tx: 0, rx: 0 }, month: { tx: 0, rx: 0 }, total: { tx: 0, rx: 0 }, since: '2026-10-01' };
    return stats;
  });
});

describe('periodRange', () => {
  it('считает границы по UTC-датам', () => {
    expect(periodRange('7d', '2026-11-11', null)).toEqual({ from: '2026-11-05', to: '2026-11-11' });
    expect(periodRange('30d', '2026-11-11', null)).toEqual({ from: '2026-10-13', to: '2026-11-11' });
    expect(periodRange('month', '2026-11-11', null)).toEqual({ from: '2026-11-01', to: '2026-11-11' });
    expect(periodRange('prev', '2026-11-11', null)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange('prev', '2026-01-15', null)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodRange('all', '2026-11-11', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-11-11' });
    expect(periodRange('all', '2026-11-11', null)).toEqual({ from: '2026-11-11', to: '2026-11-11' });
  });
});

describe('страница статистики', () => {
  it('показывает итог, среднее, пик, рейтинг и два графика', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Aeza [SPB]')).toBeTruthy());
    expect(screen.getByText(/^12([.,]0+)? ГБ$/)).toBeTruthy(); // всего за период
    expect(screen.getByText(/^6([.,]0+)? ГБ$/)).toBeTruthy(); // в среднем за сутки
    expect(screen.getByText(/^9([.,]0+)? ГБ$/)).toBeTruthy(); // пик
    expect(screen.getByText('Прочие')).toBeTruthy();
    expect(screen.getByText(/топ 10 и ещё 2/)).toBeTruthy();
    expect(screen.getAllByTestId('chart')).toHaveLength(2);
    // столбцы по дням: по серии на группу, стек, в порядке рейтинга
    const bars = charts.map((c) => c as { series: { data: { type: string; name: string; stacking?: string }[] } }).find((c) => c.series.data[0]!.type === 'bar-x')!;
    expect(bars.series.data.map((s) => s.name)).toEqual(['Aeza [SPB]', 'Beget [SPB]', 'Прочие']);
    expect(bars.series.data.every((s) => s.stacking === 'normal')).toBe(true);
  });

  it('запрашивает последние 30 дней по нодам, а при смене разбивки — по маршрутам', async () => {
    mount();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/traffic/stats?from=2026-10-13&to=2026-11-11&by=node&top=10'));
    await userEvent.setup().click(screen.getByText('По нодам'));
    await userEvent.setup().click(await screen.findByText('По маршрутам'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/traffic/stats?from=2026-10-13&to=2026-11-11&by=route&top=10'));
  });

  it('при пустом периоде объясняет, что данных нет', async () => {
    get.mockImplementation(async (path: string) =>
      path.startsWith('/api/traffic/summary') ? { day: '2026-11-11', today: { tx: 0, rx: 0 }, month: { tx: 0, rx: 0 }, total: { tx: 0, rx: 0 }, since: null } : { ...stats, total: 0, series: [], dailyTotal: [0, 0], peak: null, others: 0 },
    );
    mount();
    await waitFor(() => expect(screen.getByText('За этот период данных нет.')).toBeTruthy());
    expect(screen.queryByTestId('chart')).toBeNull();
  });
});
