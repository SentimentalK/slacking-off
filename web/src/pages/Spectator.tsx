import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getJSON, watch } from '../api';
import type { WatchStatus } from '../api';
import { useBoardControls } from '../board';
import { AgentCard } from '../components/AgentCard';
import { EventText, eventColors } from '../components/EventText';
import { Link } from '../components/Link';
import { Nav } from '../components/Nav';
import { QueueStrip } from '../components/QueueStrip';
import { EVENT_LABEL, formatNumber } from '../labels';
import { drawWorld } from '../render';
import { pickReplayWindow, REPLAY_TICKS_PER_SECOND } from '../replay-source';
import type { LeaderRow, Projection, ProjectionEvent, Terrain, Timeline } from '../types';

const EVENT_LOG_LIMIT = 50;

function mergeEvents(previous: ProjectionEvent[], next: ProjectionEvent[]): ProjectionEvent[] {
  const seen = new Set(previous.map((event) => `${event.tick}:${event.seq}`));
  const fresh = next.filter((event) => !seen.has(`${event.tick}:${event.seq}`));
  if (fresh.length === 0) return previous;
  const merged = [...fresh, ...previous];
  merged.sort((a, b) => b.tick - a.tick || b.seq - a.seq);
  return merged.slice(0, EVENT_LOG_LIMIT);
}

interface LiveState {
  projection: Projection | null;
  previous: Projection | null | undefined;
  selected: number | null;
  reduceMotion: boolean;
}

type ViewMode = 'live' | 'replay';

export function Spectator() {
  const [projection, setProjection] = useState<Projection | null>(null);
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [status, setStatus] = useState<WatchStatus>('reconnecting');
  const [selected, setSelected] = useState<number | null>(null);
  const [events, setEvents] = useState<ProjectionEvent[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[] | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [mode, setMode] = useState<ViewMode>('live');
  const modeRef = useRef<ViewMode>('live');
  const latestLive = useRef<Projection | null>(null);
  const [replay, setReplay] = useState<{ from: number; to: number } | null>(null);
  const replayTick = useRef(0);
  const replayCache = useRef(new Map<number, Projection>());
  const startingReplay = useRef(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const live = useRef<LiveState>({
    projection: null,
    previous: null,
    selected: null,
    reduceMotion: false,
  });

  const select = (id: number | null) => {
    live.current.selected = id;
    setSelected(id);
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
    const state = live.current;
    state.previous = undefined;
    state.projection = next;
    setProjection(next);
    setEvents(next.events);
    replayCache.current.clear();
    setReplay(null);
    modeRef.current = 'live';
    setMode('live');
    select(next.agents[0]?.id ?? null);
  };

  const enterReplay = (liveTick: number) => {
    if (startingReplay.current) return;
    startingReplay.current = true;
    getJSON<Timeline>(`/api/timeline?from=0&to=${liveTick}`)
      .then((timeline) => {
        const window = pickReplayWindow(timeline.markers, liveTick);
        if (!window || modeRef.current !== 'live') return;
        replayCache.current.clear();
        replayTick.current = window.from;
        setReplay(window);
        modeRef.current = 'replay';
        setMode('replay');
        setSelected(null);
        return loadReplayFrame(window.from).then((frame) => {
          if (!frame || modeRef.current !== 'replay') return;
          live.current.previous = undefined;
          live.current.projection = frame;
          setProjection(frame);
          setEvents(frame.events.slice().sort((a, b) => b.tick - a.tick || b.seq - a.seq).slice(0, EVENT_LOG_LIMIT));
        });
      })
      .catch(() => undefined)
      .finally(() => {
        startingReplay.current = false;
      });
  };

  const cameraRef = useBoardControls({
    canvasRef,
    wrapRef,
    terrain,
    projection: () => live.current.projection,
    onSelect: select,
  });

  useEffect(() => {
    live.current.reduceMotion = reduceMotion;
  }, [reduceMotion]);

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

    getJSON<LeaderRow[]>('/api/leaderboard?metric=score&limit=5')
      .then((rows) => {
        if (alive) setLeaderboard(rows);
      })
      .catch(() => {
        if (alive) setLeaderboard([]);
      });

    const stop = watch(
      (next) => {
        latestLive.current = next;
        if (modeRef.current === 'replay') {
          if (next.counts.inside > 0) leaveReplay(next);
          return;
        }
        const state = live.current;
        state.previous = state.projection;
        state.projection = next;
        setProjection(next);
        setEvents((previous) => mergeEvents(previous, next.events));
        const stillThere = next.agents.some((agent) => agent.id === state.selected);
        if (!stillThere) select(next.agents[0]?.id ?? null);
        if (next.counts.inside === 0) enterReplay(next.tick);
      },
      (next) => setStatus(next),
    );

    return () => {
      alive = false;
      stop();
    };
  }, []);

  // One animation loop; it only ever calls `drawWorld`.
  useEffect(() => {
    let frame = 0;
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      const state = live.current;
      if (canvas && state.projection && terrain) {
        drawWorld(canvas, state.projection, terrain, {
          camera: cameraRef.current,
          now,
          reduceMotion: state.reduceMotion,
          prev: state.previous ?? undefined,
          selected: state.selected ?? undefined,
        });
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [terrain]);

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
        live.current.previous = undefined;
        live.current.projection = frame;
        setProjection(frame);
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

  const agent = projection?.agents.find((entry) => entry.id === selected) ?? null;

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

  return (
    <div class="spectator">
      <div class="board-column">
        <header class="status-bar">
          <div class="brand">
            <h1 class="brand-title">带薪拉屎</h1>
            <span class="brand-sub">COMPANY TIME</span>
          </div>
          <Nav current="spectator" />
          <div class="status-spacer" />
          <div class="live" data-status={mode === 'replay' ? 'replay' : status}>
            <span class="live-dot" />
            <span>
              {mode === 'replay' ? '回放' : status === 'live' ? 'LIVE' : status === 'reconnecting' ? '重连中' : '已断开'}
            </span>
          </div>
          <div class="stat-chips">
            <div class="chip">
              在场{' '}
              <b>
                {projection?.counts.inside ?? '–'}/{projection?.counts.capacity ?? '–'}
              </b>
            </div>
            <div class="chip">
              门外排队 <b>{projection?.counts.queued ?? '–'}</b>
            </div>
            <div class="chip mono">TICK {projection ? formatNumber(projection.tick) : '–'}</div>
          </div>
        </header>

        <section class="home-intro" aria-label="这是什么">
          <p class="home-lede">
            一座只有厕所的格子世界：AI 用命令行进来抢坑、建墙、堵门、上厕所。
          </p>
          <div class="home-entries">
            <Link href="/account" class="home-cta">
              带你的 AI 来
            </Link>
            <Link href="/play" class="home-cta home-cta-quiet">
              我自己上
            </Link>
          </div>
        </section>

        <QueueStrip queue={projection?.queue ?? []} />

        <div class="board-wrap" ref={wrapRef}>
          <canvas class="board" ref={canvasRef} role="img" aria-label={boardLabel} />
          {mode === 'replay' ? (
            <div class="replay-badge" data-mode="replay">
              回放
            </div>
          ) : null}
          <div class="board-hint">滚轮缩放 · 拖拽平移 · 点击选人</div>
        </div>

        <div class="timeline">
          <div class="timeline-track" aria-hidden="true">
            <div class="timeline-rail" />
            {timeline.marks.map((mark) => (
              <div
                key={mark.tick}
                class="timeline-tick"
                data-major={mark.major ? 'true' : 'false'}
                style={{ left: `${mark.percent}%` }}
              />
            ))}
            <div class="timeline-pointer" style={{ left: `${timeline.pointer}%` }} />
          </div>
          <div class="timeline-labels">
            <span>{formatNumber(timeline.from)}</span>
            <span>TICK {formatNumber(tick)}</span>
            <span>{formatNumber(timeline.to)}</span>
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

      <aside class="side">
        <section class="side-section">
          <div class="panel-label">SELECTED · 选中的 Agent</div>
          {agent && projection ? (
            <AgentCard agent={agent} tick={projection.tick} tickSeconds={projection.tick_seconds} />
          ) : (
            <div class="panel">
              <p class="muted" style={{ margin: 0 }}>
                暂无 Agent
              </p>
            </div>
          )}
        </section>

        <section class="side-section">
          <div class="panel-label">LIVE LOG · 现场</div>
          <div class="log-list">
            {events.length === 0 ? (
              <span class="log-empty">暂无事件</span>
            ) : (
              events.map((event) => (
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

        <section class="side-section">
          <div class="panel-label">TOP 5 · 带薪榜</div>
          <div class="rank-list">
            {leaderboard === null ? (
              <span class="log-empty">载入中…</span>
            ) : leaderboard.length === 0 ? (
              <span class="log-empty">暂无数据</span>
            ) : (
              leaderboard.map((row) => (
                <div class="rank-row" key={row.agent_id} data-rank={String(row.rank)}>
                  <span class="rank-no">{row.rank}</span>
                  <span class="rank-name">
                    <b>{row.nick}</b> <span class="rank-model">· {row.model}</span>
                  </span>
                  <span class="rank-score">{formatNumber(row.score_total)}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}
