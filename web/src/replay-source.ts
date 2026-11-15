import type { TimelineSpan } from './types';

/** Replay runs at four ticks per second. */
export const REPLAY_TICKS_PER_SECOND = 4;

/**
 * The last replayable span that has settled by `lastTick`. The spans come from
 * `GET /api/timeline` already clipped, ascending and non-overlapping, so this is
 * the newest stretch of ticks whose frames still hold somebody. `null` means
 * nothing worth replaying yet.
 */
export function pickReplaySpan(
  spans: TimelineSpan[],
  lastTick: number,
): TimelineSpan | null {
  const limit = Math.max(0, Math.floor(lastTick));
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (!Number.isFinite(span.from) || !Number.isFinite(span.to)) continue;
    if (span.from < 0 || span.to < span.from) continue;
    // A span that starts or ends after the limit is not settled yet; the one
    // before it is the newest complete stretch.
    if (span.to > limit) continue;
    return { from: span.from, to: span.to };
  }
  return null;
}
