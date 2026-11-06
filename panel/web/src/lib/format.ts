// Единицы: скорость — Мбит/с, объём — десятичные КБ/МБ/ГБ/ТБ.
const nf = (digits: number) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF = [nf(0), nf(1), nf(2)];
const fixed = (n: number, d: number) => NF[d]!.format(n);

/** байт/с → «12,3» (Мбит/с). Меньше 0,1 Мбит/с показываем в кбит/с. */
export function mbit(bytesPerSec: number | null | undefined): { value: string; unit: string } {
  if (bytesPerSec === null || bytesPerSec === undefined) return { value: '—', unit: '' };
  const m = (bytesPerSec * 8) / 1e6;
  if (m >= 100) return { value: fixed(m, 0), unit: 'Мбит/с' };
  if (m >= 1) return { value: fixed(m, 1), unit: 'Мбит/с' };
  if (m >= 0.1) return { value: fixed(m, 2), unit: 'Мбит/с' };
  const k = (bytesPerSec * 8) / 1e3;
  return { value: fixed(k, k >= 10 ? 0 : 1), unit: 'кбит/с' };
}

export const mbitText = (b: number | null | undefined): string => {
  const { value, unit } = mbit(b);
  return unit ? `${value} ${unit}` : value;
};

export function bytes(n: number | null | undefined): { value: string; unit: string } {
  if (n === null || n === undefined) return { value: '—', unit: '' };
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return { value: fixed(v, i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2), unit: units[i]! };
}

export const bytesText = (n: number | null | undefined): string => {
  const { value, unit } = bytes(n);
  return unit ? `${value} ${unit}` : value;
};

export const pct = (n: number | null | undefined, d = 0): string => (n === null || n === undefined ? '—' : `${fixed(n, d)}%`);
export const int = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : fixed(Math.round(n), 0));

export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (!iso) return 'никогда';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'только что';
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} д назад`;
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export const dateTime = (iso: string | number | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export const dateShort = (day: string): string => new Date(day + 'T00:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** «5 ч 12 мин», «23 мин», «6 д 4 ч», «меньше минуты». */
export function remaining(untilIso: string | number, now = Date.now()): string {
  const s = Math.floor((new Date(untilIso).getTime() - now) / 1000);
  if (s <= 0) return 'истёк';
  if (s < 60) return 'меньше минуты';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

/** Версии вида 0.3.0: a строго новее b. */
export function newerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
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
