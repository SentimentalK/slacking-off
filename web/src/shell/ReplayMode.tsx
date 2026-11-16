// `/replay` inside the shell: the recorded world drawn by the same 3D renderer
// as the live spectator. The renderer reads `override`; this component keeps the
// current frame, a prefetch cache and the playback clock, and writes each frame
// there. Nothing here opens the live stream.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { getJSON } from '../api';
import { eventColors } from '../components/EventText';
import { useI18n } from '../i18n';
import {
  indexSpans,
  nextPlayable,
  readReplayQuery,
  offsetOfTick,
  snapTick,
} from '../replay-source';
import type { ClickHit } from '../world3d';
import type { Projection, Timeline, WorldSummary } from '../types';
import { BottomReplay } from './BottomReplay';
import { Card } from './Card';
import { Feed } from './Feed';
import type { WorldOverride } from './useWorld';

const CACHE_LIMIT = 32;
const MIN_STEP_MS = 60;

interface Props {
  override: RefObject<WorldOverride | null>;
  clickRef: RefObject<((hit: ClickHit) => void) | null>;
  blocked: boolean;
  /** Receives the replay URL query, so closing a window can return to it. */
  queryRef: RefObject<string>;
  onFrame: (frame: Projection | null) => void;
  /** Panels and the bottom bar; the frame driver runs either way. */
  ui: boolean;
}

function remember(cache: Map<number, Projection>, target: number, frame: Projection): void {
  cache.set(target, frame);
  cache.set(frame.tick, frame);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function ReplayMode({ override, clickRef, blocked, queryRef, onFrame, ui }: Props) {
  const { t } = useI18n();
  const initial = useMemo(() => readReplayQuery(window.location.search), []);

  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [worldId, setWorldId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [tick, setTick] = useState<number>(initial.tick ?? -1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState<number | null>(initial.agent);
  const [frame, setFrame] = useState<Projection | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [narrow, setNarrow] = useState(false);

  const frameRef = useRef<Projection | null>(null);
  const selectedRef = useRef<number | null>(initial.agent);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const cacheRef = useRef(new Map<number, Projection>());
  const seqRef = useRef(0);
  const snappedRef = useRef(false);
  const intervalRef = useRef(1000);

  const select = (id: number | null) => {
    selectedRef.current = id;
    setSelected(id);
  };

  const present = useCallback(
    (next: Projection) => {
      const current = frameRef.current;
      if (current?.tick === next.tick) return;
      // Interpolate from the frame just before, never across a gap or a seek.
      const step = current !== null && Math.abs(next.tick - current.tick) === 1 ? current : null;
      frameRef.current = next;
      setFrame(next);
      override.current = {
        cur: next,
        prev: step,
        arrivedAt: performance.now(),
        vision: null,
        selected: selectedRef.current,
        path: null,
        spanMs: intervalRef.current,
      };
      onFrame(next);
    },
    [override, onFrame],
  );

  const loadFrame = useCallback(
    (target: number) => {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      const cached = cacheRef.current.get(target);
      if (cached) {
        present(cached);
        setLoadError(false);
        return;
      }
      getJSON<Projection>(`/api/projection?tick=${target}`)
        .then((next) => {
          remember(cacheRef.current, target, next);
          if (seq !== seqRef.current) return;
          present(next);
          setLoadError(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          // The previous frame stays on the canvas; the bottom bar offers a retry.
          setLoadError(true);
          setPlaying(false);
        });
    },
    [present],
  );

  useEffect(() => {
    let alive = true;
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
  const index = useMemo(() => indexSpans(spans), [spans]);

  // No `?tick=` in the URL: start at the first tick of the last replayable span.
  useEffect(() => {
    if (tick >= 0 || spans.length === 0) return;
    setTick(spans[spans.length - 1].from);
  }, [tick, spans]);

  // A shared `?tick=N` keeps its tick when replayable, else snaps once to a span edge.
  useEffect(() => {
    if (snappedRef.current || spans.length === 0) return;
    snappedRef.current = true;
    if (initial.tick === null || offsetOfTick(index, initial.tick) !== null) return;
    const snapped = snapTick(index, initial.tick);
    if (snapped !== null) setTick(snapped);
  }, [spans, index, initial.tick]);

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

  // Keep the URL shareable as `/replay?tick=N&agent=ID`. The query is remembered
  // even while a window is open, so closing it returns to the same tick.
  useEffect(() => {
    if (tick < 0) return;
    // Other parameters (quality, still, ui) stay: the renderer reads them at mount.
    const params = new URLSearchParams(window.location.search);
    params.set('tick', String(tick));
    if (selected !== null) params.set('agent', String(selected));
    else params.delete('agent');
    const search = `?${params.toString()}`;
    queryRef.current = search;
    if (window.location.pathname === '/replay' && window.location.search !== search) {
      window.history.replaceState(null, '', `/replay${search}`);
    }
  }, [tick, selected, queryRef]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 480px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const playInterval = Math.max(MIN_STEP_MS, ((frame?.tick_seconds ?? 5) * 1000) / speed);
  useEffect(() => {
    intervalRef.current = playInterval;
  }, [playInterval]);

  // One replayable tick per interval; a gap between spans is crossed in one step,
  // and the last span's end stops the reel.
  useEffect(() => {
    if (!playing || tick < 0) return;
    const next = nextPlayable(index, tick);
    if (next === null) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setTick(next), playInterval);
    return () => window.clearTimeout(timer);
  }, [playing, tick, playInterval, index]);

  // Playback warms the next replayable tick so the switch is instant.
  useEffect(() => {
    if (!playing || !frame) return;
    const next = nextPlayable(index, frame.tick);
    if (next === null || cacheRef.current.has(next)) return;
    getJSON<Projection>(`/api/projection?tick=${next}`)
      .then((projection) => remember(cacheRef.current, next, projection))
      .catch(() => {
        // The due tick surfaces the failure with the retry button.
      });
  }, [playing, frame, index]);

  useEffect(() => {
    if (override.current) override.current.selected = selected;
  }, [selected, override]);

  useEffect(() => {
    clickRef.current = (hit) => {
      if (!blockedRef.current) select(hit.agentId);
    };
    return () => {
      clickRef.current = null;
    };
  }, [clickRef]);

  useEffect(
    () => () => {
      override.current = null;
      onFrame(null);
    },
    [override, onFrame],
  );

  const changeWorld = (next: number) => {
    cacheRef.current.clear();
    frameRef.current = null;
    setFrame(null);
    onFrame(null);
    setTimeline(null);
    setWorldId(next);
    snappedRef.current = false;
    setTick(-1);
    setPlaying(false);
  };

  const retry = () => {
    setLoadError(false);
    setRetryToken((value) => value + 1);
  };

  const feedEvents = useMemo(
    () => (frame ? frame.events.slice().sort((a, b) => b.tick - a.tick || b.seq - a.seq) : []),
    [frame],
  );
  const colors = useMemo(() => eventColors(frame), [frame]);
  const agent = frame?.agents.find((entry) => entry.id === selected) ?? null;

  if (!ui) return null;
  return (
    <>
      {narrow ? null : <Feed events={feedEvents} colors={colors} />}
      <Card agent={agent} tick={frame?.tick ?? 0} top3={[]} visionState={false} />
      {frame === null && !loadError ? <div class="rp-loading">{t('replay.loadingFrame')}</div> : null}
      <BottomReplay
        worlds={worlds}
        worldId={worldId}
        onWorld={changeWorld}
        index={index}
        markers={timeline?.markers ?? []}
        loaded={timeline !== null}
        lastTick={lastTick}
        tick={tick}
        playing={playing}
        speed={speed}
        reduceMotion={reduceMotion}
        loadError={loadError}
        onRetry={retry}
        onPlay={() => setPlaying((value) => !value)}
        onSpeed={setSpeed}
        onSeek={setTick}
      />
    </>
  );
}
