// A tiny hash-based router. We deliberately avoid the History API: the app is served from
// a relative base under /agent-experiments/projects/<slug>/, where only `#/route` URLs
// survive a refresh.

import { useEffect, useState } from 'react';

export function currentRoute(): string {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h.length ? h : 'registers';
}

export function useHashRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState<string>(() => currentRoute());

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (r: string) => {
    if (currentRoute() !== r) window.location.hash = `/${r}`;
    else setRoute(r);
  };

  return [route, navigate];
}
