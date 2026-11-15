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
  return (
    <p class="note" data-placeholder={w.key}>
      {`${windowTitle(w)}窗口正文`}
    </p>
  );
}
