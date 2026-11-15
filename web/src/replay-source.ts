import type { TimelineMarker } from './types';

/** The replay window is this many ticks wide. */
export const REPLAY_WINDOW_TICKS = 120;
/** Replay runs at four ticks per second. */
export const REPLAY_TICKS_PER_SECOND = 4;

/**
 * The most recent highlight tick closes a fixed-width window. `null` means
 * there is nothing worth replaying yet.
 */
export function pickReplayWindow(
  markers: TimelineMarker[],
  lastTick: number,
): { from: number; to: number } | null {
  let highlight = -1;
  for (const marker of markers) {
    if (marker.tick > highlight) highlight = marker.tick;
  }
  if (highlight < 0) return null;
  const to = Math.min(highlight, Math.max(0, lastTick));
  const from = Math.max(0, to - REPLAY_WINDOW_TICKS);
  return { from, to };
}
