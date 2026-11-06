import { ThemeProvider, type Theme } from '@gravity-ui/uikit';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Ctx = { theme: Theme; toggle: () => void };
const ThemeCtx = createContext<Ctx>({ theme: 'light', toggle: () => {} });

const KEY = 'popug-theme';

function initial(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* приватный режим */
  }
  return 'light'; // светлая по умолчанию
}

/** Тема целиком из Gravity UI (light/dark); переключатель сохраняет выбор в localStorage. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* не запомнится */
      }
      return next;
    });
  }, []);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return (
    <ThemeCtx.Provider value={value}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </ThemeCtx.Provider>
  );
}

export const useAppTheme = () => useContext(ThemeCtx);
