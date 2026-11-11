import { Chart } from '@gravity-ui/charts';
import type { ChartData } from '@gravity-ui/charts';
import { Card, Select, Text } from '@gravity-ui/uikit';
import { useMemo, useState } from 'react';
import { EmptyHint, Hint, Notice } from '../components/ui';
import type { TrafficGroup } from '../lib/api';
import { bytesText } from '../lib/format';
import { useTrafficStats, useTrafficSummary } from '../lib/queries';

/** Цвета групп закреплены за порядком в рейтинге (крупнейшая — первый цвет); «Прочие» — серый. */
const PALETTE = ['#5b9bf5', '#ef6b73', '#f0b24a', '#5ec28f', '#a98af0', '#4dc3d8', '#e987b8', '#9bbf55', '#e8845a', '#7f8ff0'];
const OTHER_COLOR = '#8b95a5';
const OTHER_KEY = '_other';
/** Подписи оси Y в тех же единицах, что и по всей панели (десятичные: 1 ТБ = 1000 ГБ). */
const BYTES_AXIS = { precision: 'auto' as const, units: { scale: { base: 1000, postfixes: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'] }, delimiter: ' ' } };

type PeriodKey = '7d' | '30d' | '90d' | 'month' | 'prev' | 'all';
const PERIODS: { value: PeriodKey; content: string }[] = [
  { value: '7d', content: '7 дней' },
  { value: '30d', content: '30 дней' },
  { value: '90d', content: '90 дней' },
  { value: 'month', content: 'Этот месяц' },
  { value: 'prev', content: 'Прошлый месяц' },
  { value: 'all', content: 'За всё время' },
];

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fmtDay = (day: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(ms(day));

/** Границы периода в UTC-датах: сутки в статистике, как и в квоте хостера, считаются по UTC. */
export function periodRange(key: PeriodKey, today: string, since: string | null): { from: string; to: string } {
  const t = ms(today);
  switch (key) {
    case '7d': return { from: iso(t - 6 * DAY), to: today };
    case '30d': return { from: iso(t - 29 * DAY), to: today };
    case '90d': return { from: iso(t - 89 * DAY), to: today };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'prev': {
      const first = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      return { from: iso(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1)), to: iso(first.getTime() - DAY) };
    }
    default: return { from: since ?? today, to: today };
  }
}

const colorOf = (key: string, i: number) => (key === OTHER_KEY ? OTHER_COLOR : PALETTE[i % PALETTE.length]!);

export function StatsPage() {
  const summary = useTrafficSummary();
  const today = summary.data?.day ?? iso(Date.now());
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [by, setBy] = useState<TrafficGroup>('node');
  const [top, setTop] = useState(10);
  const range = periodRange(period, today, summary.data?.since ?? null);
  // «За всё время» ждёт сводку: до неё неизвестно, с какого дня считать.
  const q = useTrafficStats({ ...range, by, top }, period !== 'all' || summary.isSuccess);
  const d = q.data;

  const areaData = useMemo<ChartData | null>(() => {
    if (!d) return null;
    return {
      chart: { margin: { top: 8, right: 12, bottom: 8, left: 8 } },
      series: {
        data: [{
          type: 'area' as const,
          name: 'Трафик',
          color: PALETTE[0],
          data: d.days.map((day, i) => ({ x: ms(day), y: d.dailyTotal[i]! })),
          tooltip: { valueFormat: { type: 'custom' as const, formatter: ({ value }: { value: unknown }) => bytesText(Number(value)) } },
        }],
      },
      xAxis: { type: 'datetime', grid: { enabled: false } },
      yAxis: [{ min: 0, grid: { enabled: true }, labels: { numberFormat: BYTES_AXIS } }],
      legend: { enabled: false },
      tooltip: { enabled: true },
    };
  }, [d]);

  const barsData = useMemo<ChartData | null>(() => {
    if (!d) return null;
    return {
      chart: { margin: { top: 8, right: 12, bottom: 8, left: 8 } },
      series: {
        data: d.series.map((s, i) => ({
          type: 'bar-x' as const,
          name: s.name,
          color: colorOf(s.key, i),
          stacking: 'normal' as const,
          data: d.days.map((day, k) => ({ x: fmtDay(day), y: s.daily[k]! })),
          tooltip: { valueFormat: { type: 'custom' as const, formatter: ({ value }: { value: unknown }) => bytesText(Number(value)) } },
        })),
      },
      xAxis: { type: 'category', categories: d.days.map(fmtDay) },
      yAxis: [{ min: 0, grid: { enabled: true }, labels: { numberFormat: BYTES_AXIS } }],
      legend: { enabled: false },
      tooltip: { enabled: true },
    };
  }, [d]);

  const empty = !!d && d.total === 0;
  const max = d?.series.reduce((m, s) => Math.max(m, s.total), 0) ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <Text variant="header-2" as="h1">Статистика</Text>
        <div className="stats-controls">
          <Select value={[by]} onUpdate={(v) => setBy((v[0] as TrafficGroup) ?? 'node')} width={150} options={[{ value: 'node', content: 'По нодам' }, { value: 'route', content: 'По маршрутам' }]} />
          <Select value={[String(top)]} onUpdate={(v) => setTop(Number(v[0] ?? 10))} width={110} options={[5, 10, 20].map((n) => ({ value: String(n), content: `Топ ${n}` }))} />
          <Select value={[period]} onUpdate={(v) => setPeriod((v[0] as PeriodKey) ?? '30d')} width={170} options={PERIODS} />
        </div>
      </div>
      {q.isError && <Notice theme="danger">Не удалось загрузить статистику: {(q.error as Error).message}</Notice>}

      {d && (
        <Text color="secondary" as="div" style={{ marginBottom: 14 }}>
          {fmtDay(d.from)} — {fmtDay(d.to)} · сутки по UTC ·{' '}
          {by === 'node' ? 'исходящий трафик нод (то есть весь пользовательский трафик)' : 'вход + выход маршрута со стороны клиента'}
        </Text>
      )}

      {q.isPending && period !== 'all' && <EmptyHint title="Загружаю…" />}
      {empty && <EmptyHint title="За этот период данных нет.">Статистика копится с момента подключения нод; попробуйте другой период.</EmptyHint>}

      {d && !empty && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="split">
            <Card type="container" view="outlined" className="card-pad">
              <Text color="secondary"><Hint label="Всего за период" tip="Сумма за выбранные сутки. Среднее считается на все сутки периода, пик — самые тяжёлые сутки." /></Text>
              <Text variant="display-1" as="div">{bytesText(d.total)}</Text>
              <div className="stats-figures">
                <div><Text color="secondary" as="div">В среднем за сутки</Text><Text variant="subheader-3">{bytesText(d.avgPerDay)}</Text></div>
                <div><Text color="secondary" as="div">Пик{d.peak ? ` · ${fmtDay(d.peak.day)}` : ''}</Text><Text variant="subheader-3">{d.peak ? bytesText(d.peak.bytes) : '—'}</Text></div>
              </div>
              <div className="stats-chart">{areaData && <Chart data={areaData} />}</div>
            </Card>
            <Card type="container" view="outlined" className="card-pad">
              <Text color="secondary" as="div" style={{ marginBottom: 10 }}>{by === 'node' ? 'Ноды' : 'Маршруты'} по трафику{d.others > 0 ? ` (топ ${top} и ещё ${d.others})` : ''}</Text>
              <div className="toplist">
                {d.series.map((s, i) => (
                  <div className="toplist-row" key={s.key}>
                    <div className="toplist-fill" style={{ width: `${max ? Math.max(3, (s.total / max) * 100) : 0}%`, background: colorOf(s.key, i) }} />
                    <span><i className="toplist-dot" style={{ background: colorOf(s.key, i) }} /><Text ellipsis>{s.name}</Text></span>
                    <span><Text variant="subheader-2">{bytesText(s.total)}</Text></span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <Card type="container" view="outlined" className="card-pad">
            <Text color="secondary" as="div">Трафик по дням</Text>
            <div className="stats-chart-tall">{barsData && <Chart data={barsData} />}</div>
          </Card>
        </div>
      )}
    </div>
  );
}
