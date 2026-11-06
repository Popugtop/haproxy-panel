import { Card, Text } from '@gravity-ui/uikit';
import { Chart } from '@gravity-ui/charts';
import type { ChartData } from '@gravity-ui/charts';
import { useMemo } from 'react';

export interface ChartSeries {
  label: string;
  /** Явный цвет; без него берётся палитра Gravity по порядку (порядок серий стабилен). */
  color?: string;
  data: (number | null)[];
}

/**
 * Gravity Charts рисует datetime-ось строго в UTC и не имеет настройки часового пояса.
 * Сдвигаем метку на локальное смещение этой самой даты, чтобы оси и подсказки показывали местное время.
 */
export const localMs = (tSec: number): number => tSec * 1000 - new Date(tSec * 1000).getTimezoneOffset() * 60_000;

/** Вставляет null там, где данных нет дольше 2,5 корзин: линия рвётся, а не соединяет провал. */
export function withGaps(t: number[], cols: (number | null)[][], bin: number): { t: number[]; cols: (number | null)[][] } {
  const outT: number[] = [];
  const outC: (number | null)[][] = cols.map(() => []);
  for (let i = 0; i < t.length; i++) {
    if (i > 0 && t[i]! - t[i - 1]! > bin * 2.5) {
      outT.push(t[i - 1]! + bin);
      outC.forEach((c) => c.push(null));
    }
    outT.push(t[i]!);
    cols.forEach((c, k) => outC[k]!.push(c[i] ?? null));
  }
  return { t: outT, cols: outC };
}

interface Props {
  title: string;
  unit?: string;
  t: number[];
  series: ChartSeries[];
  bin: number;
  from: number;
  to: number;
  fmt: (v: number) => string;
  yMax?: number;
}

export function TimeChart({ title, unit, t, series, bin, from, to, fmt, yMax }: Props) {
  const prepared = useMemo(() => withGaps(t, series.map((s) => s.data), bin), [t, series, bin]);
  const hasData = prepared.cols.some((c) => c.some((v) => v !== null));

  const data = useMemo<ChartData>(
    () => ({
      chart: { margin: { top: 8, right: 12, bottom: 8, left: 8 } },
      series: {
        data: series.map((s, k) => ({
          type: 'line' as const,
          name: s.label,
          ...(s.color ? { color: s.color } : {}),
          lineWidth: 1.5,
          data: prepared.t.map((x, i) => ({ x: localMs(x), y: prepared.cols[k]![i] ?? null })),
          tooltip: { valueFormat: { type: 'custom' as const, formatter: ({ value }: { value: unknown }) => fmt(Number(value)) } },
        })),
      },
      xAxis: { type: 'datetime', min: localMs(from), max: localMs(to), grid: { enabled: false } },
      yAxis: [{ min: 0, ...(yMax ? { max: yMax } : {}), grid: { enabled: true } }],
      legend: { enabled: series.length > 1 },
      tooltip: { enabled: true },
    }),
    [prepared, series, from, to, fmt, yMax],
  );

  return (
    <Card type="container" view="outlined" className="chart-box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text variant="subheader-2">{title}</Text>
        {unit && <Text color="secondary">{unit}</Text>}
      </div>
      <div className="chart-host">
        {hasData ? <Chart data={data} /> : <Text color="secondary">Нет данных за период</Text>}
      </div>
    </Card>
  );
}

/** Мини-график без осей и подписей для карточки обзора. */
export function Sparkline({ t, values, color }: { t: number[]; values: number[]; color?: string }) {
  const data = useMemo<ChartData>(
    () => ({
      chart: { margin: { top: 2, right: 2, bottom: 2, left: 2 } },
      series: {
        data: [
          {
            type: 'line' as const,
            name: 'Трафик',
            ...(color ? { color } : {}),
            lineWidth: 1.5,
            data: t.map((x, i) => ({ x: localMs(x), y: values[i] ?? null })),
          },
        ],
      },
      xAxis: { type: 'datetime', visible: false, grid: { enabled: false } },
      yAxis: [{ visible: false, grid: { enabled: false }, padding: { min: '10%', max: '10%' } }],
      legend: { enabled: false },
      tooltip: { enabled: false },
    }),
    [t, values, color],
  );
  if (values.length < 2) return null;
  return <div className="sparkline"><Chart data={data} /></div>;
}
