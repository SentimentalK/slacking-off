import './windows.css';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { Account } from '../pages/Account';
import { Leaderboard } from '../pages/Leaderboard';
import { Login } from '../pages/Login';
import { Profile } from '../pages/Profile';
import { Register } from '../pages/Register';
import { Stats } from '../pages/Stats';
import type { WindowKey } from './route';

const TITLES: Record<WindowKey, Key> = {
  leaderboard: 'window.leaderboard',
  stats: 'window.stats',
  account: 'window.account',
  agent: 'window.agent',
  login: 'window.login',
  register: 'window.register',
};

export function windowTitle(w: { key: WindowKey; id?: number }): string {
  return t(TITLES[w.key]);
}

export function WindowBody({ w }: { w: { key: WindowKey; id?: number } }) {
  switch (w.key) {
    case 'leaderboard':
      return <Leaderboard />;
    case 'stats':
      return <Stats />;
    case 'account':
      return <Account />;
    case 'agent':
      return <Profile id={w.id!} />;
    case 'login':
      return <Login />;
    case 'register':
      return <Register />;
  }
}
