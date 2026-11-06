import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type PublicBranding } from './api';

export const DEFAULT_LOGO = '/popug.png';
const DEFAULT_NAME = 'Popug Bridges';

/** Название и логотип панели (публично: нужны и экрану входа). До ответа сервера — стандартные. */
export function useBranding(): { name: string; logo: string; custom: boolean } {
  const q = useQuery({ queryKey: ['branding'], queryFn: () => api.get<PublicBranding>('/api/branding'), staleTime: 5 * 60_000, retry: false });
  return { name: q.data?.name ?? DEFAULT_NAME, logo: q.data?.logo ?? DEFAULT_LOGO, custom: !!q.data?.logo };
}

function setIcon(rel: string, href: string, sizes?: string) {
  const sel = `link[rel="${rel}"]`;
  let links = Array.from(document.head.querySelectorAll<HTMLLinkElement>(sel));
  if (!links.length) {
    const l = document.createElement('link');
    l.rel = rel;
    document.head.appendChild(l);
    links = [l];
  }
  for (const l of links) {
    l.href = href;
    l.removeAttribute('type');
    if (sizes === undefined) l.removeAttribute('sizes');
  }
}

/** Название вкладки и иконка вкладки из настроек. Сервер подставляет их и в index.html, это — для смены без перезагрузки и для dev. */
export function useApplyBranding(): void {
  const { name, logo, custom } = useBranding();
  useEffect(() => {
    document.title = name;
    if (custom) {
      setIcon('icon', logo);
      setIcon('apple-touch-icon', logo);
    }
  }, [name, logo, custom]);
}
