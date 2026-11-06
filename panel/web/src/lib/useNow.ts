import { useEffect, useState } from 'react';

/** Текущее время, обновляется раз в интервал: для обратных отсчётов «осталось …». */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
