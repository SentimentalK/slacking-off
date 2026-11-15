import './windows.css';
import { Account } from '../pages/Account';
import { Leaderboard } from '../pages/Leaderboard';
import { Login } from '../pages/Login';
import { Profile } from '../pages/Profile';
import { Register } from '../pages/Register';
import { Stats } from '../pages/Stats';
import type { WindowKey } from './route';

const TITLES: Record<WindowKey, string> = {
  leaderboard: '排行榜',
  stats: '统计',
  account: '账号',
  agent: '档案',
  login: '登录',
  register: '注册',
};

export function windowTitle(w: { key: WindowKey; id?: number }): string {
  return TITLES[w.key];
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
