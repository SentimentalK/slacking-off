import { useEffect, useState } from 'preact/hooks';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import type { Key } from '../i18n';
import type { WatchStatus } from '../api';
import { navigate } from '../router';
import type { Projection } from '../types';

export type TopMode = 'watch' | 'play' | 'replay';

const MODES: Array<{ key: TopMode; label: Key; href: string }> = [
  { key: 'watch', label: 'top.watch', href: '/' },
  { key: 'play', label: 'top.play', href: '/play' },
  { key: 'replay', label: 'top.replay', href: '/replay' },
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
  const { t } = useI18n();
  const now = useNow(200);
  const auth = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const tickSeconds = Math.max(1, projection?.tick_seconds ?? 1);
  const elapsed = projection ? Math.min(tickSeconds, Math.max(0, (now - arrivedAt) / 1000)) : 0;
  const remaining = Math.max(0, Math.ceil(tickSeconds - elapsed));
  const fill = (elapsed / tickSeconds) * 100;

  const statusLabel = replaying
    ? t('top.replaying')
    : status === 'live'
      ? '● LIVE'
      : status === 'reconnecting'
        ? t('top.reconnecting')
        : t('top.disconnected');
  const statusClass = replaying ? 'live rp' : status === 'live' ? 'live' : 'off';

  const accountHref = auth.username ? '/account' : '/login';
  const accountLabel = auth.username ? t('window.account') : t('window.login');

  const openFromMenu = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const items = (
    <>
      <button type="button" data-open="leaderboard" onClick={() => openFromMenu(() => navigate('/leaderboard'))}>
        {t('window.leaderboard')}
      </button>
      <button type="button" data-open="stats" onClick={() => openFromMenu(() => navigate('/stats'))}>
        {t('window.stats')}
      </button>
      <button type="button" data-open="account" onClick={() => openFromMenu(() => navigate(accountHref))}>
        {accountLabel}
      </button>
      <button type="button" data-open="settings" onClick={() => openFromMenu(onSettings)}>
        {t('settings.title')}
      </button>
    </>
  );

  return (
    <>
      <div class="ui-brand">
        <div class="t1">{t('brand.name')}</div>
        <div class="t2">{t('brand.sub')}</div>
      </div>

      {hideClock ? null : (
        <div class="ui-clock">
          <span class={statusClass}>{statusLabel}</span>
          <div class="big">{t('top.turn', { n: projection?.tick ?? '–' })}</div>
          {replaying ? null : (
            <>
              <div class="countdown">
                {t('top.nextSettle')} {projection ? remaining : '–'}s
              </div>
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
            {t(mode.label)}
          </button>
        ))}
      </div>

      <div class="ui-navr">
        {playing ? (
          <div class="panel cnt" title={t('top.playing')}>
            <span class="lbl">{t('top.playingWord')} · </span>
            {t('top.playingGrid')}
          </div>
        ) : (
          <div
            class="panel cnt"
            title={`${t('top.inside')} ${projection?.counts.inside ?? '–'}/${projection?.counts.capacity ?? '–'} · ${t('top.queue')} ${projection?.counts.queued ?? '–'}/${projection?.counts.queue_capacity ?? '–'}`}
          >
            <span class="lbl">{t('top.inside')} </span>
            <b>{projection?.counts.inside ?? '–'}</b>/{projection?.counts.capacity ?? '–'} · <span class="lbl">{t('top.queue')} </span>
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
          {t('top.menu')}
        </button>
        {menuOpen ? <div class="panel ui-menu">{items}</div> : null}
      </div>
    </>
  );
}
