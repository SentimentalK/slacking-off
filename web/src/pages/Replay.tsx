// `/replay`: scrub the recorded world tick by tick. Same `drawWorld` as the
// live board; a prefetch cache keeps playback ahead of the network.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { useBoardControls } from '../board';
import { AgentCard } from '../components/AgentCard';
import { EventText, eventColors } from '../components/EventText';
import { PageHeader } from '../components/Nav';
import { EVENT_LABEL, formatNumber } from '../labels';
import { drawWorld } from '../render';
import type {
  MarkerKind,
  Projection,
  Terrain,
  Timeline,
  TimelineSpan,
  WorldSummary,
} from '../types';

const SPEEDS = [0.5, 1, 2, 4] as const;

const MARKER_COLOR: Record<MarkerKind, string> = {
  success: 'var(--success)',
  attack: 'var(--danger)',
  demolish: 'var(--danger)',
  defend: 'var(--defend)',
};

// --- replayable spans ------------------------------------------------------
// The recording is not contiguous: quiet stretches (nobody inside the world)
// have no frame worth showing. The rail therefore lays every replayable tick
// out end to end, one position each, and draws one solid segment per span.
// Every helper below is a pure function over a precomputed index, so a scrub
// never rebuilds the layout.

interface SpanIndex {
  spans: TimelineSpan[];
  /** Offset of each span's first tick on the rail. */
  starts: number[];
  /** Number of replayable ticks; also the rail's width in positions. */
  total: number;
}

function indexSpans(spans: TimelineSpan[]): SpanIndex {
  const starts: number[] = [];
  let total = 0;
  for (const span of spans) {
    starts.push(total);
    total += span.to - span.from + 1;
  }
  return { spans, starts, total };
}

/** Rail position of `tick`, or `null` when the tick is not replayable. */
function offsetOfTick(index: SpanIndex, tick: number): number | null {
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i];
    if (tick >= span.from && tick <= span.to) return index.starts[i] + (tick - span.from);
  }
  return null;
}

/** The tick at a rail position; positions outside the rail clamp to its ends. */
function tickAtOffset(index: SpanIndex, offset: number): number | null {
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
function spanIndexAt(index: SpanIndex, tick: number): number {
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i];
    if (tick >= span.from && tick <= span.to) return i;
  }
  return -1;
}

/** Index of the last span that ends before `tick`; `-1` when there is none. */
function precedingSpanIndex(index: SpanIndex, tick: number): number {
  for (let i = index.spans.length - 1; i >= 0; i -= 1) {
    if (index.spans[i].to < tick) return i;
  }
  return -1;
}

/** The next replayable tick, hopping across a gap to the next span's first. */
function nextPlayable(index: SpanIndex, tick: number): number | null {
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i];
    if (tick < span.from) return span.from;
    if (tick < span.to) return tick + 1;
  }
  return null;
}

/** The previous replayable tick, hopping across a gap to the last span's end. */
function prevPlayable(index: SpanIndex, tick: number): number | null {
  for (let i = index.spans.length - 1; i >= 0; i -= 1) {
    const span = index.spans[i];
    if (tick > span.to) return span.to;
    if (tick > span.from) return tick - 1;
  }
  return null;
}

/** Nearest replayable tick to `tick`: itself inside a span, else a span edge. */
function snapTick(index: SpanIndex, tick: number): number | null {
  if (index.spans.length === 0) return null;
  let best: number | null = null;
  for (const span of index.spans) {
    if (tick < span.from) break;
    best = Math.min(tick, span.to);
  }
  return best ?? index.spans[0].from;
}

/** Pointer position: a non-replayable tick sits at the end of the span before it. */
function pointerOffset(index: SpanIndex, tick: number): number {
  const inside = offsetOfTick(index, tick);
  if (inside !== null) return inside;
  const previous = precedingSpanIndex(index, tick);
  if (previous < 0) return 0;
  const span = index.spans[previous];
  return index.starts[previous] + (span.to - span.from + 1);
}


function readQuery(): { tick: number | null; agent: number | null } {
  const params = new URLSearchParams(window.location.search);
  const rawTick = params.get('tick');
  const rawAgent = params.get('agent');
  const tick = rawTick === null ? Number.NaN : Number(rawTick);
  const agent = rawAgent === null ? Number.NaN : Number(rawAgent);
  return {
    tick: Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : null,
    agent: Number.isFinite(agent) ? Math.floor(agent) : null,
  };
}

export function Replay() {
  const initial = useMemo(readQuery, []);

  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [worldId, setWorldId] = useState<number | null>(null);
  const [tick, setTick] = useState<number>(initial.tick ?? -1);
  const [tickText, setTickText] = useState(initial.tick !== null ? String(initial.tick) : '');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [selected, setSelected] = useState<number | null>(initial.agent);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [frame, setFrame] = useState<Projection | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<Projection | null>(null);
  const prevRef = useRef<Projection | null>(null);
  const selectedRef = useRef<number | null>(initial.agent);
  const reduceMotionRef = useRef(false);
  const cacheRef = useRef(new Map<number, Projection>());
  const seqRef = useRef(0);
  const scrubbingRef = useRef(false);

  const select = (id: number | null) => {
    selectedRef.current = id;
    setSelected(id);
  };

  const cameraRef = useBoardControls({
    canvasRef,
    wrapRef,
    terrain,
    projection: () => frameRef.current,
    onSelect: select,
  });

  const present = useCallback((next: Projection) => {
    if (frameRef.current?.tick === next.tick) return;
    prevRef.current = frameRef.current;
    frameRef.current = next;
    setFrame(next);
  }, []);

  const loadFrame = useCallback(
    (target: number) => {
      const cached = cacheRef.current.get(target);
      if (cached) {
        present(cached);
        setLoadError(false);
        return;
      }
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      getJSON<Projection>(`/api/projection?tick=${target}`)
        .then((next) => {
          cacheRef.current.set(target, next);
          cacheRef.current.set(next.tick, next);
          // Playback is contiguous now; thirty-two frames is plenty of runway.
          while (cacheRef.current.size > 32) {
            const oldest = cacheRef.current.keys().next();
            if (oldest.done) break;
            cacheRef.current.delete(oldest.value);
          }
          if (seq !== seqRef.current) return;
          present(next);
          setLoadError(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          // The previous frame stays on the canvas; the toolbar offers a retry.
          setLoadError(true);
          setPlaying(false);
        });
    },
    [present],
  );

  // Map and world list.
  useEffect(() => {
    let alive = true;
    getJSON<Terrain>('/api/terrain')
      .then((next) => {
        if (alive) setTerrain(next);
      })
      .catch(() => {
        if (alive) setTerrain({ width: 0, height: 0, entrance: { x: 0, y: 0 }, rows: [] });
      });
    getJSON<WorldSummary[]>('/api/worlds')
      .then((list) => {
        if (!alive) return;
        setWorlds(list);
        setWorldId(list[0]?.id ?? null);
      })
      .catch(() => {
        if (alive) setWorlds([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const world = worlds?.find((entry) => entry.id === worldId) ?? null;
  const lastTick = world?.last_tick ?? null;

  const spans = useMemo(() => timeline?.spans ?? [], [timeline]);
  const spanIndex = useMemo(() => indexSpans(spans), [spans]);
  /** Rail geometry: percent per replayable tick, so positions are exact. */
  const railScale = spanIndex.total > 0 ? 100 / spanIndex.total : 0;
  const currentSpan = spanIndexAt(spanIndex, tick);
  // A tick typed or linked outside a span still needs a neighbour to hop from.
  const anchorSpan = currentSpan >= 0 ? currentSpan : precedingSpanIndex(spanIndex, tick);
  const nextMarkerTick = useMemo(() => {
    let best: number | null = null;
    for (const marker of timeline?.markers ?? []) {
      if (marker.tick > tick && (best === null || marker.tick < best)) best = marker.tick;
    }
    return best;
  }, [timeline, tick]);

  // No `?tick=` in the URL: start at the first tick of the last replayable
  // span, never at the empty tail after it.
  useEffect(() => {
    if (tick >= 0 || spans.length === 0) return;
    setTick(spans[spans.length - 1].from);
  }, [tick, spans]);

  // A shared `/replay?tick=N` keeps its tick when that tick is replayable and
  // otherwise snaps to the nearest span edge once the spans land.
  const snappedRef = useRef(false);
  useEffect(() => {
    if (snappedRef.current || spans.length === 0) return;
    snappedRef.current = true;
    if (initial.tick === null || offsetOfTick(spanIndex, initial.tick) !== null) return;
    const snapped = snapTick(spanIndex, initial.tick);
    if (snapped !== null) setTick(snapped);
  }, [spans, spanIndex, initial.tick]);

  // Timeline markers for the whole recording.
  useEffect(() => {
    if (lastTick === null) return;
    let alive = true;
    getJSON<Timeline>(`/api/timeline?from=0&to=${lastTick}`)
      .then((next) => {
        if (alive) setTimeline(next);
      })
      .catch(() => {
        if (alive) setTimeline({ from: 0, to: lastTick, markers: [], spans: [] });
      });
    return () => {
      alive = false;
    };
  }, [lastTick]);

  useEffect(() => {
    if (tick < 0) return;
    loadFrame(tick);
  }, [tick, loadFrame, retryToken]);

  // Keep the URL shareable: `/replay?tick=N&agent=ID`.
  useEffect(() => {
    if (tick < 0) return;
    const params = new URLSearchParams();
    params.set('tick', String(tick));
    if (selected !== null) params.set('agent', String(selected));
    const next = `/replay?${params.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [tick, selected]);

  useEffect(() => {
    setTickText(tick >= 0 ? String(tick) : '');
  }, [tick]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReduceMotion(query.matches);
      reduceMotionRef.current = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // One replayable tick per `tick_seconds / speed`; a gap between spans is
  // crossed in a single step, and the last span's end stops the reel.
  useEffect(() => {
    if (!playing) return;
    if (tick < 0) return;
    const next = nextPlayable(spanIndex, tick);
    if (next === null) {
      setPlaying(false);
      return;
    }
    const interval = Math.max(60, ((frame?.tick_seconds ?? 5) * 1000) / speed);
    const timer = window.setTimeout(() => setTick(next), interval);
    return () => window.clearTimeout(timer);
  }, [playing, tick, speed, frame?.tick_seconds, spanIndex]);

  // Playback warms the next replayable tick so the switch is instant.
  useEffect(() => {
    if (!playing || !frame) return;
    const next = nextPlayable(spanIndex, frame.tick);
    if (next === null) return;
    if (cacheRef.current.has(next)) return;
    getJSON<Projection>(`/api/projection?tick=${next}`)
      .then((projection) => {
        cacheRef.current.set(next, projection);
        cacheRef.current.set(projection.tick, projection);
        while (cacheRef.current.size > 32) {
          const oldest = cacheRef.current.keys().next();
          if (oldest.done) break;
          cacheRef.current.delete(oldest.value);
        }
      })
      .catch(() => {
        // The due tick will surface the failure with the retry affordance.
      });
  }, [playing, frame, spanIndex]);

  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      const current = frameRef.current;
      if (canvas && current && terrain) {
        drawWorld(canvas, current, terrain, {
          camera: cameraRef.current,
          now,
          reduceMotion: reduceMotionRef.current,
          prev: prevRef.current ?? undefined,
          selected: selectedRef.current ?? undefined,
        });
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [terrain]);

  /** Seek by rail position: every replayable tick owns exactly one position. */
  const seek = (clientX: number, rect: DOMRect) => {
    if (spanIndex.total <= 0) return;
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    const next = tickAtOffset(spanIndex, ratio * (spanIndex.total - 1));
    if (next !== null) setTick(next);
  };

  const commitTick = () => {
    const value = Number(tickText);
    if (!Number.isFinite(value) || tickText.trim() === '') {
      setTickText(tick >= 0 ? String(tick) : '');
      return;
    }
    const clamped = Math.max(0, Math.min(lastTick ?? Math.round(value), Math.round(value)));
    setTick(clamped);
    setTickText(String(clamped));
  };

  const retry = () => {
    setLoadError(false);
    setRetryToken((value) => value + 1);
  };

  const colors = useMemo(() => eventColors(frame), [frame]);
  const agent = frame?.agents.find((entry) => entry.id === selected) ?? null;

  // Rail layout, computed once per timeline: one solid segment per span and one
  // marker per highlight, both positioned by replayable offset.
  const segments = useMemo(
    () =>
      spanIndex.spans.map((span, index) => ({
        key: `span:${index}:${span.from}`,
        left: spanIndex.starts[index] * railScale,
        width: (span.to - span.from + 1) * railScale,
        title: `第 ${index + 1} 段 · TICK ${span.from}–${span.to}`,
      })),
    [spanIndex, railScale],
  );
  const marks = useMemo(() => {
    const placed: Array<{ key: string; left: number; title: string; color: string }> = [];
    let index = 0;
    for (const marker of timeline?.markers ?? []) {
      const offset = offsetOfTick(spanIndex, marker.tick);
      index += 1;
      if (offset === null) continue;
      placed.push({
        key: `marker:${marker.tick}:${index}`,
        left: (offset + 0.5) * railScale,
        title: `TICK ${marker.tick} · ${marker.text}`,
        color: MARKER_COLOR[marker.kind],
      });
    }
    return placed;
  }, [timeline, spanIndex, railScale]);
  const pointerLeft = spanIndex.total > 0 ? pointerOffset(spanIndex, tick) * railScale : 0;

  return (
    <div class="page replay">
      <PageHeader current="replay" />

      <div class="replay-toolbar">
        <label class="toolbar-field">
          <span class="field-label">世界</span>
          <select
            class="select"
            value={worldId ?? ''}
            disabled={!worlds || worlds.length <= 1}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              cacheRef.current.clear();
              frameRef.current = null;
              prevRef.current = null;
              setFrame(null);
              setTimeline(null);
              setWorldId(next);
              snappedRef.current = false;
              setTick(-1);
              setTickText('');
            }}
          >
            {(worlds ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <label class="toolbar-field">
          <span class="field-label">TICK</span>
          <input
            class="tick-input mono"
            type="text"
            inputMode="numeric"
            value={tickText}
            aria-label="跳转到 tick"
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

        <button
          class="transport"
          type="button"
          aria-label={playing ? '暂停' : '播放'}
          aria-pressed={playing}
          disabled={spans.length === 0}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="3" width="3" height="10" fill="currentColor" />
              <rect x="9" y="3" width="3" height="10" fill="currentColor" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 2 L13 8 L5 14 Z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div class="span-nav" role="group" aria-label="按段跳转">
          <button
            type="button"
            class="span-button"
            aria-label="第一段"
            disabled={spans.length === 0}
            onClick={() => {
              const first = spans[0];
              if (first) setTick(first.from);
            }}
          >
            第一段
          </button>
          <button
            type="button"
            class="span-button"
            aria-label="上一段"
            disabled={anchorSpan <= 0}
            onClick={() => {
              const previous = spans[anchorSpan - 1];
              if (previous) setTick(previous.from);
            }}
          >
            上一段
          </button>
          <button
            type="button"
            class="span-button"
            aria-label="下一段"
            disabled={spans.length === 0 || anchorSpan >= spans.length - 1}
            onClick={() => {
              const next = spans[anchorSpan + 1];
              if (next) setTick(next.from);
            }}
          >
            下一段
          </button>
          <button
            type="button"
            class="span-button"
            aria-label="下一个事件"
            disabled={nextMarkerTick === null}
            onClick={() => {
              if (nextMarkerTick !== null) setTick(nextMarkerTick);
            }}
          >
            下一个事件
          </button>
        </div>

        <div class="speed-group" role="group" aria-label="播放速度">
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              class="speed"
              aria-pressed={speed === value}
              onClick={() => setSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </div>

        <div class="toolbar-spacer" />
        <div class="toolbar-note mono">
          {frame
            ? `TICK ${formatNumber(frame.tick)}`
            : timeline !== null && spans.length === 0
              ? '无可回放区间'
              : '载入中…'}
          {reduceMotion ? ' · 减少动态' : ''}
        </div>
      </div>

      <div class="replay-body">
        <div class="board-wrap" ref={wrapRef}>
          <canvas
            class="board"
            ref={canvasRef}
            role="img"
            aria-label={
              frame
                ? `回放棋盘：tick ${frame.tick}，在场 ${frame.counts.inside}/${frame.counts.capacity} 人`
                : '回放棋盘，正在载入'
            }
          />
          <div class="board-hint">滚轮缩放 · 拖拽平移 · 点击选人</div>
          {loadError ? (
            <button class="board-retry" type="button" onClick={retry}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M3 8a5 5 0 1 1 2 4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                />
                <path d="M2 12 L2 7 L7 7 Z" fill="currentColor" />
              </svg>
              <span>这个 tick 没取到，重试</span>
            </button>
          ) : null}
        </div>

        <aside class="side replay-side">
          <section class="side-section">
            <div class="panel-label">SELECTED · 选中的 Agent</div>
            {agent && frame ? (
              <AgentCard agent={agent} tick={frame.tick} tickSeconds={frame.tick_seconds} />
            ) : (
              <div class="panel">
                <p class="muted" style={{ margin: 0 }}>
                  {selected === null ? '点棋盘上的 Agent 看详情。' : '这个 tick 它不在场。'}
                </p>
              </div>
            )}
          </section>

          <section class="side-section">
            <div class="panel-label">EVENTS · 本 tick 事件</div>
            <div class="log-list">
              {!frame ? (
                <span class="log-empty">载入中…</span>
              ) : frame.events.length === 0 ? (
                <span class="log-empty">本 tick 没有事件</span>
              ) : (
                frame.events.map((event) => (
                  <div class="log-row" key={`${event.tick}:${event.seq}`}>
                    <span class="log-tick">{formatNumber(event.tick)}</span>
                    <span class="log-text">
                      <span class="muted">[{EVENT_LABEL[event.kind]}]</span>{' '}
                      <EventText text={event.text} colors={colors} />
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>

      <div class="replay-timeline">
        {spans.length === 0 ? (
          <div class="timeline-empty">没有可回放的区间</div>
        ) : (
        <button
          type="button"
          class="marker-track"
          aria-label="回放时间轴：只覆盖有玩家在场的区间"
          onClick={(event) => {
            // Keyboard activation has no pointer position; arrow keys step instead.
            if (event.detail === 0) return;
            seek(event.clientX, event.currentTarget.getBoundingClientRect());
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            scrubbingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            seek(event.clientX, event.currentTarget.getBoundingClientRect());
          }}
          onPointerMove={(event) => {
            if (!scrubbingRef.current) return;
            seek(event.clientX, event.currentTarget.getBoundingClientRect());
          }}
          onPointerUp={(event) => {
            scrubbingRef.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setTick((current) => {
                const next =
                  event.key === 'ArrowRight'
                    ? nextPlayable(spanIndex, current)
                    : prevPlayable(spanIndex, current);
                return next ?? current;
              });
            }
          }}
        >
          <span class="timeline-rail" />
          {segments.map((segment) => (
            <span
              key={segment.key}
              class="span-segment"
              style={{
                left: `calc(${segment.left}% + 1.5px)`,
                width: `max(2px, calc(${segment.width}% - 3px))`,
              }}
              title={segment.title}
            />
          ))}
          {marks.map((mark) => (
            <span
              key={mark.key}
              class="marker-hit"
              style={{ left: `${mark.left}%` }}
              title={mark.title}
            >
              <span class="marker-bar" style={{ background: mark.color }} />
            </span>
          ))}
          <span
            class="timeline-pointer replay-pointer"
            style={{ left: `${pointerLeft}%` }}
          />
        </button>
        )}
        {spans.length > 0 ? (
          <div class="timeline-labels">
            <span>{formatNumber(spans[0].from)}</span>
            <span>
              {currentSpan >= 0
                ? `第 ${currentSpan + 1}/${spans.length} 段 · TICK ${formatNumber(tick)} · 本段 ${formatNumber(tick - spans[currentSpan].from + 1)}/${formatNumber(spans[currentSpan].to - spans[currentSpan].from + 1)}`
                : `TICK ${formatNumber(tick)} · 不在可回放区间`}
            </span>
            <span>{formatNumber(spans[spans.length - 1].to)}</span>
          </div>
        ) : null}
        <div class="timeline-legend">
          <span class="legend-item">
            <span class="legend-mark" style={{ background: 'var(--success)' }} />
            成功
          </span>
          <span class="legend-item">
            <span class="legend-mark" style={{ background: 'var(--danger)' }} />
            打人 / 拆除
          </span>
          <span class="legend-item">
            <span class="legend-mark" style={{ background: 'var(--defend)' }} />
            防住了
          </span>
          <span class="legend-item">
            <span class="legend-mark vision" />
            选中 Agent 的视野
          </span>
          <span class="legend-item">
            <span class="legend-gap" />
            灰段=无人在场（不可回放）
          </span>
        </div>
      </div>
    </div>
  );
}
