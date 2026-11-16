// The replay bar: the timeline with one solid block per replayable span, the
// gaps between spans, the marker highlights and the pointer, plus transport and
// navigation. Every position is in replayable offsets, so the gaps take no room.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MARKER_COLOR, SPEEDS, offsetOfTick, pointerOffset, precedingSpanIndex, spanIndexAt, tickAtOffset } from '../replay-source';
import type { SpanIndex } from '../replay-source';
import type { Timeline, WorldSummary } from '../types';

interface Props {
  worlds: WorldSummary[] | null;
  worldId: number | null;
  onWorld: (id: number) => void;
  index: SpanIndex;
  markers: Timeline['markers'];
  loaded: boolean;
  lastTick: number | null;
  tick: number;
  playing: boolean;
  speed: number;
  reduceMotion: boolean;
  loadError: boolean;
  onRetry: () => void;
  onPlay: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (tick: number) => void;
}

export function BottomReplay({
  worlds,
  worldId,
  onWorld,
  index,
  markers,
  loaded,
  lastTick,
  tick,
  playing,
  speed,
  reduceMotion,
  loadError,
  onRetry,
  onPlay,
  onSpeed,
  onSeek,
}: Props) {
  const spans = index.spans;
  const hasSpans = spans.length > 0;
  const scale = index.total > 0 ? 100 / index.total : 0;
  const current = spanIndexAt(index, tick);
  const anchor = current >= 0 ? current : precedingSpanIndex(index, tick);
  const dragging = useRef(false);

  const [tickText, setTickText] = useState('');
  useEffect(() => {
    setTickText(tick >= 0 ? String(tick) : '');
  }, [tick]);

  const segments = spans.map((span, i) => ({
    key: `span:${i}`,
    left: index.starts[i] * scale,
    width: (span.to - span.from + 1) * scale,
    title: `第 ${i + 1} 段 · TICK ${span.from}–${span.to}`,
  }));
  const gaps = spans.slice(1).map((span, i) => ({
    key: `gap:${i}`,
    left: index.starts[i + 1] * scale,
    title: `跳过 ${span.from - spans[i].to - 1} 回合`,
  }));
  const marks = useMemo(() => {
    const placed: Array<{ key: string; left: number; color: string; title: string }> = [];
    markers.forEach((marker, i) => {
      const offset = offsetOfTick(index, marker.tick);
      if (offset === null) return;
      placed.push({
        key: `mark:${i}`,
        left: (offset + 0.5) * scale,
        color: MARKER_COLOR[marker.kind],
        title: `TICK ${marker.tick} · ${marker.text}`,
      });
    });
    return placed;
  }, [markers, index, scale]);
  const nextMarkerTick = useMemo(() => {
    let best: number | null = null;
    for (const marker of markers) {
      if (marker.tick > tick && (best === null || marker.tick < best)) best = marker.tick;
    }
    return best;
  }, [markers, tick]);

  const seekAt = (clientX: number, rect: DOMRect) => {
    if (index.total <= 0 || rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const next = tickAtOffset(index, Math.min(index.total - 1, Math.floor(ratio * index.total)));
    if (next !== null) onSeek(next);
  };

  const commitTick = () => {
    const value = Number(tickText);
    if (tickText.trim() === '' || !Number.isFinite(value)) {
      setTickText(tick >= 0 ? String(tick) : '');
      return;
    }
    const rounded = Math.round(value);
    const clamped = Math.max(0, Math.min(lastTick ?? rounded, rounded));
    onSeek(clamped);
    setTickText(String(clamped));
  };

  const cycleSpeed = () => {
    const at = SPEEDS.findIndex((value) => value === speed);
    onSpeed(SPEEDS[(at + 1) % SPEEDS.length]);
  };

  const status = tick < 0
    ? ''
    : current >= 0
      ? `第 ${current + 1}/${spans.length} 段 · 回合 ${tick}`
      : `回合 ${tick} · 非高光`;

  const worldDisabled = !worlds || worlds.length <= 1;

  return (
    <div class="rp-bar panel" data-mode="replay">
      <div class="replay-timeline">
        {!loaded ? (
          <div class="rp-empty">载入中…</div>
        ) : !hasSpans ? (
          <div class="rp-empty">没有可回放的区间</div>
        ) : (
          <>
            <div
              class="rp-track"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                // Keeps focus where it is, so a typed tick does not commit over the drag.
                event.preventDefault();
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                seekAt(event.clientX, event.currentTarget.getBoundingClientRect());
              }}
              onPointerMove={(event) => {
                if (dragging.current) seekAt(event.clientX, event.currentTarget.getBoundingClientRect());
              }}
              onPointerUp={(event) => {
                dragging.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                dragging.current = false;
              }}
            >
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  class="rp-span"
                  style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
                  title={segment.title}
                />
              ))}
              {gaps.map((gap) => (
                <span key={gap.key} class="rp-gap" style={{ left: `${gap.left}%` }} title={gap.title} />
              ))}
              {marks.map((mark) => (
                <span
                  key={mark.key}
                  class="rp-mark"
                  style={{ left: `${mark.left}%`, background: mark.color }}
                  title={mark.title}
                />
              ))}
              <span class="rp-pointer" style={{ left: `${pointerOffset(index, tick) * scale}%` }} />
            </div>
            <div class="rp-labels">
              <span>{spans[0].from}</span>
              <span>
                {status}
                {reduceMotion ? ' · 减少动态' : ''}
              </span>
              <span>{spans[spans.length - 1].to}</span>
            </div>
          </>
        )}
      </div>

      <div class="rp-controls">
        <button
          type="button"
          aria-label={playing ? '暂停' : '播放'}
          aria-pressed={playing}
          disabled={!hasSpans}
          onClick={onPlay}
        >
          {playing ? '暂停' : '播放'}
        </button>
        <button type="button" disabled={!hasSpans} onClick={cycleSpeed}>
          {speed}×
        </button>
        <button
          type="button"
          aria-label="上一段"
          disabled={!hasSpans || anchor <= 0}
          onClick={() => {
            const previous = spans[anchor - 1];
            if (previous) onSeek(previous.from);
          }}
        >
          上一段
        </button>
        <button
          type="button"
          aria-label="下一段"
          disabled={!hasSpans || anchor >= spans.length - 1}
          onClick={() => {
            const next = spans[anchor + 1];
            if (next) onSeek(next.from);
          }}
        >
          下一段
        </button>
        <button
          type="button"
          aria-label="下一个高光"
          disabled={nextMarkerTick === null}
          onClick={() => {
            if (nextMarkerTick !== null) onSeek(nextMarkerTick);
          }}
        >
          下一个高光
        </button>
        <label class="rp-field">
          <span>回合</span>
          <input
            type="text"
            inputMode="numeric"
            value={tickText}
            aria-label="跳转到回合"
            onInput={(event) => setTickText(event.currentTarget.value)}
            onBlur={commitTick}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTick();
              }
            }}
          />
        </label>
        <select
          class="rp-world"
          aria-label="世界"
          value={worldId ?? ''}
          disabled={worldDisabled}
          onChange={(event) => onWorld(Number(event.currentTarget.value))}
        >
          {(worlds ?? []).map((entry) => (
            <option key={entry.id} value={entry.id} title={entry.name}>
              世界 {entry.id}
            </option>
          ))}
        </select>
        {loadError ? (
          <button type="button" class="rp-retry" onClick={onRetry}>
            这个回合没取到，重试
          </button>
        ) : null}
      </div>
    </div>
  );
}
