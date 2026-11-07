import { useEffect, useRef } from 'react';

/**
 * Выполняет init один раз в момент открытия окна. Нельзя вешать сброс полей на useEffect с зависимостями-объектами:
 * страницы перерисовываются по таймеру, объекты и массивы в пропсах каждый раз новые, и введённое обнулялось бы на глазах.
 */
export function useOnOpen(open: boolean, init: () => void): void {
  const was = useRef(false);
  useEffect(() => {
    if (open && !was.current) init();
    was.current = open;
  });
}
