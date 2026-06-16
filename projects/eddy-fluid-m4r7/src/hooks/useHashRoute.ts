// useHashRoute.ts — minimal hash router (required: history routes 404 on the
// catalog's relative base, so we navigate with #/path only).

import { useEffect, useState } from 'react';

export function useHashRoute(): [string, (to: string) => void] {
  const read = () => {
    const h = window.location.hash.replace(/^#/, '');
    return h === '' ? '/' : h;
  };
  const [route, setRoute] = useState<string>(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = (to: string) => {
    const target = to.startsWith('/') ? to : `/${to}`;
    if (read() !== target) window.location.hash = target;
  };

  return [route, navigate];
}
