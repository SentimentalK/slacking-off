// Tiny history router. Enough for `/`, the E3 stubs and the later account
// pages; no dependency.

import { useEffect, useState } from 'preact/hooks';

export type Route =
  | { name: 'spectator' }
  | { name: 'replay' }
  | { name: 'agent'; id: number }
  | { name: 'leaderboard' }
  | { name: 'stats' }
  | { name: 'unknown'; path: string };

const NAV_EVENT = 'loo:navigate';

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'spectator' };
  if (path === '/replay') return { name: 'replay' };
  if (path === '/leaderboard') return { name: 'leaderboard' };
  if (path === '/stats') return { name: 'stats' };
  const agent = /^\/agent\/(\d+)$/.exec(path);
  if (agent) return { name: 'agent', id: Number(agent[1]) };
  return { name: 'unknown', path };
}

export function navigate(path: string): void {
  if (path === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    window.addEventListener(NAV_EVENT, onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(NAV_EVENT, onPop);
    };
  }, []);
  return route;
}
