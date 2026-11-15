import type { Route } from '../router';

export type WindowKey = 'leaderboard' | 'stats' | 'account' | 'agent' | 'login' | 'register';

export type Mode = 'watch' | 'play';

export function windowOf(route: Route): { key: WindowKey; id?: number } | null {
  switch (route.name) {
    case 'leaderboard':
    case 'stats':
    case 'account':
    case 'login':
    case 'register':
      return { key: route.name };
    case 'agent':
      return { key: 'agent', id: route.id };
    default:
      return null;
  }
}

export function modeBase(mode: Mode): string {
  return mode === 'play' ? '/play' : '/';
}
