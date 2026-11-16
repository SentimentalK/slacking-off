import { useEffect, useState } from 'preact/hooks';
import { useAuth } from '../auth';
import type { WatchStatus } from '../api';
import { navigate } from '../router';
import type { Projection } from '../types';

export type TopMode = 'watch' | 'play' | 'replay';

const MODES: Array<{ key: TopMode; label: string; href: string }> = [
  { key: 'watch', label: '观战', href: '/' },
  { key: 'play', label: '我自己上', href: '/play' },
  { key: 'replay', label: '回放', href: '/replay' },
];

interface Props {
  status: WatchStatus;
  replaying: boolean;
  projection: Projection | null;
  arrivedAt: number;
  current: TopMode;
  onSettings: () => void;
  hideClock?: boolean;
  playing?: boolean;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function TopBar({
  status,
  replaying,
  projection,
  arrivedAt,
  current,
  onSettings,
  hideClock = false,
  playing = false,
}: Props) {
  const now = useNow(200);
  const auth = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const tickSeconds = Math.max(1, projection?.tick_seconds ?? 1);
  const elapsed = projection ? Math.min(tickSeconds, Math.max(0, (now - arrivedAt) / 1000)) : 0;
  const remaining = Math.max(0, Math.ceil(tickSeconds - elapsed));
  const fill = (elapsed / tickSeconds) * 100;

  const statusLabel = replaying ? '● 回放' : status === 'live' ? '● LIVE' : status === 'reconnecting' ? '重连中' : '已断开';
  const statusClass = replaying ? 'live rp' : status === 'live' ? 'live' : 'off';

  const accountHref = auth.username ? '/account' : '/login';
  const accountLabel = auth.username ? '账号' : '登录';

  const openFromMenu = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const items = (
    <>
      <button type="button" data-open="leaderboard" onClick={() => openFromMenu(() => navigate('/leaderboard'))}>
        排行榜
      </button>
      <button type="button" data-open="stats" onClick={() => openFromMenu(() => navigate('/stats'))}>
        统计
      </button>
      <button type="button" data-open="account" onClick={() => openFromMenu(() => navigate(accountHref))}>
        {accountLabel}
      </button>
      <button type="button" data-open="settings" onClick={() => openFromMenu(onSettings)}>
        设置
      </button>
    </>
  );

  return (
    <>
      <div class="ui-brand">
        <div class="t1">带薪拉屎</div>
        <div class="t2">COMPANY TIME</div>
      </div>

      {hideClock ? null : (
        <div class="ui-clock">
          <span class={statusClass}>{statusLabel}</span>
          <div class="big">回合 {projection?.tick ?? '–'}</div>
          {replaying ? null : (
            <>
              <div class="countdown">下次结算 {projection ? remaining : '–'}s</div>
              <div class="cdbar">
                <i style={{ width: `${fill}%` }} />
              </div>
            </>
          )}
        </div>
      )}

      <div class="ui-modes panel">
        {MODES.map((mode) => (
          <button
            key={mode.key}
            type="button"
            data-mode-btn={mode.key}
            class={mode.key === current ? 'on' : undefined}
            onClick={() => navigate(mode.href)}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div class="ui-navr">
        {playing ? (
          <div class="panel cnt">上场中 · 视野 9×9</div>
        ) : (
          <div class="panel cnt">
            在场 <b>{projection?.counts.inside ?? '–'}</b>/{projection?.counts.capacity ?? '–'} · 排队{' '}
            <b>{projection?.counts.queued ?? '–'}</b>/{projection?.counts.queue_capacity ?? '–'}
          </div>
        )}
        {items}
        <button
          type="button"
          data-open="menu"
          class="ui-menu-btn"
          aria-expanded={menuOpen ? 'true' : 'false'}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          菜单
        </button>
        {menuOpen ? <div class="panel ui-menu">{items}</div> : null}
      </div>
    </>
  );
}
