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
  WorldSummary,
} from '../types';

const SPEEDS = [0.5, 1, 2, 4] as const;

const MARKER_COLOR: Record<MarkerKind, string> = {
  success: 'var(--success)',
  attack: 'var(--danger)',
  demolish: 'var(--danger)',
  defend: 'var(--defend)',
};

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

  // No `?tick=` in the URL: start at the end of the recording.
  useEffect(() => {
    if (tick >= 0 || lastTick === null) return;
    setTick(lastTick);
  }, [tick, lastTick]);

  // Timeline markers for the whole recording.
  useEffect(() => {
    if (lastTick === null) return;
    let alive = true;
    getJSON<Timeline>(`/api/timeline?from=0&to=${lastTick}`)
      .then((next) => {
        if (alive) setTimeline(next);
      })
      .catch(() => {
        if (alive) setTimeline({ from: 0, to: lastTick, markers: [] });
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

  // One tick per `tick_seconds / speed`; playback only advances the tick, the
  // projection request effect does the loading.
  useEffect(() => {
    if (!playing) return;
    if (tick < 0) return;
    if (lastTick !== null && tick >= lastTick) {
      setPlaying(false);
      return;
    }
    const interval = Math.max(60, ((frame?.tick_seconds ?? 5) * 1000) / speed);
    const timer = window.setTimeout(() => setTick((current) => current + 1), interval);
    return () => window.clearTimeout(timer);
  }, [playing, tick, lastTick, speed, frame?.tick_seconds]);

  // Playback warms the next tick so the switch is instant.
  useEffect(() => {
    if (!playing || !frame) return;
    const next = frame.tick + 1;
    if (lastTick !== null && next > lastTick) return;
    if (cacheRef.current.has(next)) return;
    getJSON<Projection>(`/api/projection?tick=${next}`)
      .then((projection) => {
        cacheRef.current.set(next, projection);
        cacheRef.current.set(projection.tick, projection);
      })
      .catch(() => {
        // The due tick will surface the failure with the retry affordance.
      });
  }, [playing, frame, lastTick]);

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

  const track = useMemo(() => {
    const edge = lastTick ?? Math.max(tick, 1);
    const markers = timeline?.markers ?? [];
    const first = markers.length > 0 ? Math.min(...markers.map((marker) => marker.tick)) : null;
    const last = markers.length > 0 ? Math.max(...markers.map((marker) => marker.tick)) : null;
    let from = first ?? Math.max(0, edge - 600);
    let to = last ?? Math.max(from + 1, edge);
    if (tick >= 0) {
      from = Math.min(from, tick);
      to = Math.max(to, tick);
    }
    return { from, to: Math.max(to, from + 1), markers };
  }, [timeline, lastTick, tick]);

  /** Seek to a pointer position on the timeline; snaps to a marker within 16px. */
  const seek = (clientX: number, rect: DOMRect) => {
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    let snapped: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const marker of track.markers) {
      const markerX = ((marker.tick - track.from) / span) * rect.width;
      const distance = Math.abs(markerX - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        snapped = marker.tick;
      }
    }
    const raw = Math.round(track.from + ratio * span);
    setTick(snapped !== null && bestDistance <= 16 ? snapped : raw);
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
  const span = track.to - track.from;

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
              setWorldId(next);
              const target = worlds?.find((entry) => entry.id === next)?.last_tick;
              if (target !== undefined) setTick(target);
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
          {frame ? `TICK ${formatNumber(frame.tick)}` : '载入中…'}
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
        <button
          type="button"
          class="marker-track"
          aria-label="回放时间轴：点击或拖动跳到该 tick 或最近的事件"
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
                const step = event.key === 'ArrowRight' ? 1 : -1;
                const next = Math.max(0, current + step);
                return lastTick === null ? next : Math.min(lastTick, next);
              });
            }
          }}
        >
          <span class="timeline-rail" />
          {track.markers.map((marker) => (
            <span
              key={`${marker.tick}:${marker.kind}`}
              class="marker-hit"
              style={{ left: `${((marker.tick - track.from) / span) * 100}%` }}
              title={`TICK ${marker.tick} · ${marker.text}`}
            >
              <span class="marker-bar" style={{ background: MARKER_COLOR[marker.kind] }} />
            </span>
          ))}
          <span
            class="timeline-pointer replay-pointer"
            style={{ left: `${((tick - track.from) / span) * 100}%` }}
          />
        </button>
        <div class="timeline-labels">
          <span>{formatNumber(track.from)}</span>
          <span>TICK {tick >= 0 ? formatNumber(tick) : '–'}</span>
          <span>{formatNumber(track.to)}</span>
        </div>
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
        </div>
      </div>
    </div>
  );
}
