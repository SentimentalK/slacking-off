import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { getJSON, watch } from '../api';
import type { WatchStatus } from '../api';
import { eventColors } from '../components/EventText';
import { pickReplaySpan, REPLAY_TICKS_PER_SECOND } from '../replay-source';
import { AutoQuality, chooseQuality, createWorldView, rendererName } from '../world3d';
import type { ClickHit, Quality, UiState, VisionGrid, WorldView } from '../world3d';
import type { LeaderRow, Pos, Projection, ProjectionEvent, Terrain, Timeline } from '../types';

declare global {
  interface Window {
    __looView?: {
      capture: () => ReturnType<WorldView['capture']>;
      screenOf: (id: number) => { x: number; y: number } | null;
      screenOfCell: (x: number, y: number) => { x: number; y: number } | null;
      cellAt: (x: number, y: number) => Pos | null;
      tick: () => number;
    };
  }
}

/** A scene the shell draws instead of the spectator projection (the play mode). */
export interface WorldOverride {
  cur: Projection;
  prev: Projection | null;
  arrivedAt: number;
  vision: VisionGrid | null;
  selected: number | null;
  path: Pos[] | null;
  spanMs?: number;
}

const EVENT_LOG_LIMIT = 50;
const QUALITY_KEY = 'loo.quality';
const STILL_MODE = new URLSearchParams(location.search).get('still') === '1';

export type QualityChoice = 'auto' | Quality;
export type ViewMode = 'live' | 'replay';

function mergeEvents(previous: ProjectionEvent[], next: ProjectionEvent[]): ProjectionEvent[] {
  const seen = new Set(previous.map((event) => `${event.tick}:${event.seq}`));
  const fresh = next.filter((event) => !seen.has(`${event.tick}:${event.seq}`));
  if (fresh.length === 0) return previous;
  const merged = [...fresh, ...previous];
  merged.sort((a, b) => b.tick - a.tick || b.seq - a.seq);
  return merged.slice(0, EVENT_LOG_LIMIT);
}

function readStoredQuality(): string | null {
  try {
    return localStorage.getItem(QUALITY_KEY);
  } catch {
    return null;
  }
}

function writeStoredQuality(value: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, value);
  } catch {
    return;
  }
}

function clearStoredQuality(): void {
  try {
    localStorage.removeItem(QUALITY_KEY);
  } catch {
    return;
  }
}

function toiletNear(frame: Projection, cell: Pos): Pos | null {
  for (const object of frame.objects) {
    if (object.kind === 'toilet' && Math.abs(object.pos.x - cell.x) <= 1 && Math.abs(object.pos.y - cell.y) <= 1) {
      return object.pos;
    }
  }
  return null;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

interface LiveState {
  projection: Projection | null;
  previous: Projection | null;
  terrain: Terrain | null;
  arrivedAt: number;
  selected: number | null;
  hoverToilet: Pos | null;
  dusk: boolean;
  duskT: number;
  reduceMotion: boolean;
  vision: boolean;
}

export function useWorld(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  override: RefObject<WorldOverride | null>,
  onClick: RefObject<((hit: ClickHit) => void) | null>,
  onUserCamera: RefObject<(() => void) | null>,
  active: boolean,
) {
  const [projection, setProjection] = useState<Projection | null>(null);
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [status, setStatus] = useState<WatchStatus>('reconnecting');
  const [selected, setSelected] = useState<number | null>(null);
  const [events, setEvents] = useState<ProjectionEvent[]>([]);
  const [top3, setTop3] = useState<LeaderRow[]>([]);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [mode, setMode] = useState<ViewMode>('live');
  const modeRef = useRef<ViewMode>('live');
  const activeRef = useRef(active);
  activeRef.current = active;
  const [replay, setReplay] = useState<{ from: number; to: number } | null>(null);
  const replayTick = useRef(0);
  const replayCache = useRef(new Map<number, Projection>());
  const startingReplay = useRef(false);
  const [dusk, setDusk] = useState(false);
  const [choice, setChoice] = useState<QualityChoice>('high');
  const [visionState, setVisionState] = useState(true);
  const [arrivedAt, setArrivedAt] = useState(0);

  const viewRef = useRef<WorldView | null>(null);
  const autoRef = useRef<AutoQuality | null>(null);
  const qualityRef = useRef<Quality>('high');
  const live = useRef<LiveState>({
    projection: null,
    previous: null,
    terrain: null,
    arrivedAt: 0,
    selected: null,
    hoverToilet: null,
    dusk: false,
    duskT: 0,
    reduceMotion: false,
    vision: true,
  });

  const select = (id: number | null) => {
    live.current.selected = id;
    setSelected(id);
  };

  const autoSelect = (id: number | null) => {
    if (!STILL_MODE) select(id);
  };

  const showLive = (frame: Projection, previous: Projection | null) => {
    const now = performance.now();
    live.current.previous = previous;
    live.current.projection = frame;
    live.current.arrivedAt = now;
    setArrivedAt(now);
    setProjection(frame);
  };

  const loadReplayFrame = (tick: number): Promise<Projection | null> => {
    const cached = replayCache.current.get(tick);
    if (cached) return Promise.resolve(cached);
    return getJSON<Projection>(`/api/projection?tick=${tick}`)
      .then((frame) => {
        replayCache.current.set(tick, frame);
        while (replayCache.current.size > 32) {
          const oldest = replayCache.current.keys().next();
          if (oldest.done) break;
          replayCache.current.delete(oldest.value);
        }
        return frame;
      })
      .catch(() => null);
  };

  const leaveReplay = (next: Projection) => {
    showLive(next, null);
    setEvents(next.events);
    replayCache.current.clear();
    setReplay(null);
    modeRef.current = 'live';
    setMode('live');
    autoSelect(next.agents[0]?.id ?? null);
  };

  const enterReplay = (liveTick: number) => {
    if (startingReplay.current) return;
    startingReplay.current = true;
    getJSON<Timeline>(`/api/timeline?from=0&to=${liveTick}`)
      .then((timeline) => {
        const span = pickReplaySpan(timeline.spans, liveTick);
        if (!span || modeRef.current !== 'live' || !activeRef.current) return;
        replayCache.current.clear();
        replayTick.current = span.from;
        setReplay(span);
        modeRef.current = 'replay';
        setMode('replay');
        setSelected(null);
        return loadReplayFrame(span.from).then((frame) => {
          if (!frame || modeRef.current !== 'replay') return;
          showLive(frame, replayCache.current.get(frame.tick - 1) ?? null);
          setEvents(frame.events.slice().sort((a, b) => b.tick - a.tick || b.seq - a.seq).slice(0, EVENT_LOG_LIMIT));
        });
      })
      .catch(() => undefined)
      .finally(() => {
        startingReplay.current = false;
      });
  };

  useEffect(() => {
    live.current.reduceMotion = reduceMotion;
  }, [reduceMotion]);

  useEffect(() => {
    live.current.terrain = terrain;
  }, [terrain]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let alive = true;

    getJSON<Terrain>('/api/terrain')
      .then((next) => {
        if (alive) setTerrain(next);
      })
      .catch(() => {
        if (alive) setTerrain({ width: 0, height: 0, entrance: { x: 0, y: 0 }, rows: [] });
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      if (modeRef.current === 'replay') {
        replayCache.current.clear();
        modeRef.current = 'live';
        setReplay(null);
        setMode('live');
      }
      return;
    }
    let alive = true;

    getJSON<LeaderRow[]>('/api/leaderboard?metric=score&limit=3')
      .then((rows) => {
        if (alive) setTop3(rows);
      })
      .catch(() => {
        if (alive) setTop3([]);
      });

    const stop = watch(
      (next) => {
        if (modeRef.current === 'replay') {
          if (next.counts.inside > 0) leaveReplay(next);
          return;
        }
        showLive(next, live.current.projection);
        setEvents((previous) => mergeEvents(previous, next.events));
        const stillThere = next.agents.some((agent) => agent.id === live.current.selected);
        if (!stillThere) autoSelect(next.agents[0]?.id ?? null);
        if (next.counts.inside === 0) enterReplay(next.tick);
      },
      (next) => setStatus(next),
    );

    return () => {
      alive = false;
      stop();
    };
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const params = new URLSearchParams(location.search);
    const urlQuality = params.get('quality');
    const stored = readStoredQuality();
    const initial = chooseQuality(urlQuality, stored, innerWidth, navigator.hardwareConcurrency ?? 8, rendererName());
    const view = createWorldView(canvas, {
      quality: initial,
      still: STILL_MODE,
      onSelect: select,
      onClick: (hit) => onClick.current?.(hit),
      onUserCamera: () => onUserCamera.current?.(),
    });
    viewRef.current = view;
    qualityRef.current = initial;
    const autoPick = !STILL_MODE && urlQuality === null && stored === null;
    autoRef.current = new AutoQuality(autoPick);
    setChoice(autoPick ? 'auto' : initial);
    const initialDusk = params.get('dusk') === '1';
    live.current.dusk = initialDusk;
    live.current.duskT = 0;
    setDusk(initialDusk);
    window.__looView = {
      capture: () => view.capture(),
      screenOf: (id) => view.screenOf(id),
      tick: () => view.lastTick(),
      screenOfCell: (x, y) => view.screenOfCell(x, y),
      cellAt: (x, y) => view.groundCell(x, y),
    };

    const observer = new ResizeObserver(() => view.resize());
    observer.observe(canvas);

    const onMove = (event: PointerEvent) => {
      if (STILL_MODE) return;
      const current = live.current.projection;
      const cell = view.groundCell(event.clientX, event.clientY);
      const scene = override.current?.cur ?? current;
      live.current.hoverToilet = scene && cell ? toiletNear(scene, cell) : null;
    };
    const onLeave = () => {
      live.current.hoverToilet = null;
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    let frame = 0;
    const loop = (now: number) => {
      const state = live.current;
      const auto = autoRef.current;
      if (auto) {
        const next = auto.frame(now, qualityRef.current);
        if (next) {
          qualityRef.current = next;
          view.setQuality(next);
        }
      }
      const ov = override.current;
      const cur = ov ? ov.cur : state.projection;
      if (cur && state.terrain) {
        const replaying = !ov && modeRef.current === 'replay';
        const prev = ov
          ? ov.prev
          : replaying
            ? (replayCache.current.get(cur.tick - 1) ?? null)
            : state.previous;
        const span = ov
          ? (ov.spanMs ?? cur.tick_seconds * 1000)
          : replaying
            ? 1000 / REPLAY_TICKS_PER_SECOND
            : cur.tick_seconds * 1000;
        const arrivedAt = ov ? ov.arrivedAt : state.arrivedAt;
        const motionless = STILL_MODE || state.reduceMotion;
        const phase = motionless ? 1 : clamp01((now - arrivedAt) / span);
        const ui: UiState = {
          selected: ov ? ov.selected : STILL_MODE ? null : state.selected,
          hoverToilet: STILL_MODE ? null : state.hoverToilet,
          dusk: state.dusk,
          duskT: state.duskT,
          visionOf: ov || STILL_MODE || !state.vision ? null : state.selected,
          vision: ov ? ov.vision : null,
          path: ov ? ov.path : null,
        };
        view.draw({
          terrain: state.terrain,
          prev,
          cur,
          phase,
          clock: motionless ? 0 : now / 1000,
          ui,
        });
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      view.dispose();
      viewRef.current = null;
      autoRef.current = null;
      delete window.__looView;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'replay' || !replay) return;
    let cancelled = false;
    const step = () => {
      if (cancelled || modeRef.current !== 'replay') return;
      const tick = replayTick.current;
      for (let ahead = 1; ahead <= 2; ahead += 1) {
        const next = tick + ahead;
        if (next <= replay.to) void loadReplayFrame(next);
      }
      void loadReplayFrame(tick).then((frame) => {
        if (cancelled || !frame || modeRef.current !== 'replay') return;
        showLive(frame, replayCache.current.get(frame.tick - 1) ?? null);
        setEvents(frame.events.slice().sort((a, b) => b.tick - a.tick || b.seq - a.seq).slice(0, EVENT_LOG_LIMIT));
      });
      replayTick.current = tick >= replay.to ? replay.from : tick + 1;
    };
    step();
    const timer = window.setInterval(step, 1000 / REPLAY_TICKS_PER_SECOND);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode, replay]);

  const toggleDusk = () => {
    const on = !live.current.dusk;
    live.current.dusk = on;
    live.current.duskT = performance.now() / 1000;
    setDusk(on);
  };

  const setQuality = (next: QualityChoice) => {
    if (next === 'auto') {
      const picked = chooseQuality(null, null, innerWidth, navigator.hardwareConcurrency ?? 8, rendererName());
      clearStoredQuality();
      autoRef.current = new AutoQuality(!STILL_MODE);
      qualityRef.current = picked;
      viewRef.current?.setQuality(picked);
      setChoice('auto');
      return;
    }
    autoRef.current = null;
    qualityRef.current = next;
    viewRef.current?.setQuality(next);
    writeStoredQuality(next);
    setChoice(next);
  };

  const colors = useMemo(() => eventColors(projection), [projection]);

  const boardLabel = useMemo(() => {
    if (!projection) return '厕所世界俯视图，正在载入';
    const parts = [
      `厕所世界俯视图：${projection.width}×${projection.height} 格`,
      `在场 ${projection.counts.inside}/${projection.counts.capacity} 人`,
      `门外排队 ${projection.counts.queued} 人`,
    ];
    if (projection.agents.length === 0) parts.push('暂无 Agent');
    const focus = projection.agents.find((entry) => entry.id === selected) ?? projection.agents[0];
    if (focus) parts.push(`${focus.nick} 位于 (${focus.pos.x}, ${focus.pos.y})`);
    return parts.join('，');
  }, [projection, selected]);

  const tick = projection?.tick ?? 0;
  const timeline = useMemo(() => {
    const half = 300;
    const from = Math.max(0, tick - half);
    const to = Math.max(from + 1, tick + half);
    const marks: Array<{ tick: number; percent: number; major: boolean }> = [];
    const step = 10;
    for (let value = Math.ceil(from / step) * step; value <= to; value += step) {
      marks.push({ tick: value, percent: ((value - from) / (to - from)) * 100, major: value % 100 === 0 });
    }
    return { from, to, marks, pointer: ((tick - from) / (to - from)) * 100 };
  }, [tick]);

  const setVision = (on: boolean) => {
    live.current.vision = on;
    setVisionState(on);
  };

  return {
    setVision,
    vision: visionState,
    view: () => viewRef.current,
    projection,
    terrain,
    status,
    mode,
    replay,
    events,
    top3,
    selected,
    select,
    dusk,
    toggleDusk,
    quality: choice,
    setQuality,
    arrivedAt,
    colors,
    boardLabel,
    timeline,
  };
}
