import type { MarkerKind, TimelineSpan } from './types';

/** Replay runs at four ticks per second. */
export const REPLAY_TICKS_PER_SECOND = 4;

export const SPEEDS = [0.5, 1, 2, 4] as const;

export const MARKER_COLOR: Record<MarkerKind, string> = {
  success: 'var(--success)',
  attack: 'var(--danger)',
  demolish: 'var(--danger)',
  defend: 'var(--defend)',
};

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

// --- replayable spans ------------------------------------------------------
// The recording is not contiguous: quiet stretches (nobody inside the world)
// have no frame worth showing. The rail therefore lays every replayable tick
// out end to end, one position each, and draws one solid segment per span.
// Every helper below is a pure function over a precomputed index, so a scrub
// never rebuilds the layout.

export interface SpanIndex {
  spans: TimelineSpan[];
  /** Offset of each span's first tick on the rail. */
  starts: number[];
  /** Number of replayable ticks; also the rail's width in positions. */
  total: number;
}

export function indexSpans(spans: TimelineSpan[]): SpanIndex {
  const starts: number[] = [];
  let total = 0;
  for (const span of spans) {
    starts.push(total);
    total += span.to - span.from + 1;
  }
  return { spans, starts, total };
}

/** Rail position of `tick`, or `null` when the tick is not replayable. */
export function offsetOfTick(index: SpanIndex, tick: number): number | null {
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i];
    if (tick >= span.from && tick <= span.to) return index.starts[i] + (tick - span.from);
  }
  return null;
}

/** The tick at a rail position; positions outside the rail clamp to its ends. */
export function tickAtOffset(index: SpanIndex, offset: number): number | null {
  if (index.spans.length === 0 || index.total <= 0) return null;
  const clamped = Math.max(0, Math.min(index.total - 1, Math.round(offset)));
  for (let i = index.spans.length - 1; i >= 0; i -= 1) {
    if (clamped >= index.starts[i]) {
      const span = index.spans[i];
      return span.from + Math.min(span.to - span.from, clamped - index.starts[i]);
    }
  }
  return index.spans[0].from;
}

/** Index of the span holding `tick`; `-1` when the tick is not replayable. */
export function spanIndexAt(index: SpanIndex, tick: number): number {
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i];
    if (tick >= span.from && tick <= span.to) return i;
  }
  return -1;
}

/** Index of the last span that ends before `tick`; `-1` when there is none. */
export function precedingSpanIndex(index: SpanIndex, tick: number): number {
  for (let i = index.spans.length - 1; i >= 0; i -= 1) {
    if (index.spans[i].to < tick) return i;
  }
  return -1;
}

/** The next replayable tick, hopping across a gap to the next span's first. */
export function nextPlayable(index: SpanIndex, tick: number): number | null {
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i];
    if (tick < span.from) return span.from;
    if (tick < span.to) return tick + 1;
  }
  return null;
}

/** The previous replayable tick, hopping across a gap to the last span's end. */
export function prevPlayable(index: SpanIndex, tick: number): number | null {
  for (let i = index.spans.length - 1; i >= 0; i -= 1) {
    const span = index.spans[i];
    if (tick > span.to) return span.to;
    if (tick > span.from) return tick - 1;
  }
  return null;
}

/** Nearest replayable tick to `tick`: itself inside a span, else a span edge. */
export function snapTick(index: SpanIndex, tick: number): number | null {
  if (index.spans.length === 0) return null;
  let best: number | null = null;
  for (const span of index.spans) {
    if (tick < span.from) break;
    best = Math.min(tick, span.to);
  }
  return best ?? index.spans[0].from;
}

/** Pointer position: a non-replayable tick sits at the end of the span before it. */
export function pointerOffset(index: SpanIndex, tick: number): number {
  const inside = offsetOfTick(index, tick);
  if (inside !== null) return inside;
  const previous = precedingSpanIndex(index, tick);
  if (previous < 0) return 0;
  const span = index.spans[previous];
  return index.starts[previous] + (span.to - span.from + 1);
}

export function readReplayQuery(search: string): { tick: number | null; agent: number | null } {
  const params = new URLSearchParams(search);
  const rawTick = params.get('tick');
  const rawAgent = params.get('agent');
  const tick = rawTick === null ? Number.NaN : Number(rawTick);
  const agent = rawAgent === null ? Number.NaN : Number(rawAgent);
  return {
    tick: Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : null,
    agent: Number.isFinite(agent) ? Math.floor(agent) : null,
  };
}
