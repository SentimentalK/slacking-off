import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getJSON, watch } from '../api';
import type { WatchStatus } from '../api';
import { SpriteBot } from '../components/SpriteBot';
import { URGENT_TICKS, ZOOM_MAX, ZOOM_MIN, agentColor, agentLook, drawWorld, hitTest } from '../render';
import type { AgentLook, Camera } from '../render';
import type { EventTag, LeaderRow, Projection, ProjectionAgent, ProjectionEvent, Terrain } from '../types';

const TILE = 16;
/** Longest configured deadline; the card's meter is scaled against it. */
const DEADLINE_MAX_TICKS = 240;
const EVENT_LOG_LIMIT = 50;

const EVENT_LABEL: Record<EventTag, string> = {
  success: '成功',
  attack: '打人',
  demolish: '拆除',
  defend: '防御',
  join: '入场',
  leave: '离场',
  build: '施工',
  use: '如厕',
  other: '事件',
};

const NEED_LABEL = { urine: '想尿尿', feces: '想拉屎' } as const;

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function mergeEvents(previous: ProjectionEvent[], next: ProjectionEvent[]): ProjectionEvent[] {
  const seen = new Set(previous.map((event) => `${event.tick}:${event.seq}`));
  const fresh = next.filter((event) => !seen.has(`${event.tick}:${event.seq}`));
  if (fresh.length === 0) return previous;
  const merged = [...fresh, ...previous];
  merged.sort((a, b) => b.tick - a.tick || b.seq - a.seq);
  return merged.slice(0, EVENT_LOG_LIMIT);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Colours every known nickname inside a server-authored event line. */
function eventText(text: string, colors: Map<string, string>) {
  const names = Array.from(colors.keys()).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const pattern = new RegExp(`(${names.map(escapeRegExp).join('|')})`, 'g');
  return text.split(pattern).map((part, index) => {
    const color = colors.get(part);
    if (!color) return part;
    return (
      <b key={`${part}-${index}`} style={{ color }}>
        {part}
      </b>
    );
  });
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function fitCamera(
  camera: Camera,
  projection: Projection,
  cssW: number,
  cssH: number,
  focusAgent?: ProjectionAgent | null,
): void {
  let zoom = ZOOM_MIN;
  for (let candidate = ZOOM_MAX; candidate >= ZOOM_MIN; candidate -= 1) {
    if (projection.width * TILE * candidate <= cssW && projection.height * TILE * candidate <= cssH) {
      zoom = candidate;
      break;
    }
  }
  camera.zoom = zoom;
  const viewW = cssW / (TILE * zoom);
  const viewH = cssH / (TILE * zoom);
  const fitsMap = projection.width <= viewW && projection.height <= viewH;
  // A narrow viewport cannot show the whole world, so aim it at the agents
  // instead of the geometric centre.
  let focusX = projection.width / 2;
  let focusY = projection.height / 2;
  if (!fitsMap && focusAgent) {
    focusX = focusAgent.pos.x;
    focusY = focusAgent.pos.y;
  } else if (!fitsMap && projection.agents.length > 0) {
    const xs = projection.agents.map((agent) => agent.pos.x);
    const ys = projection.agents.map((agent) => agent.pos.y);
    focusX = (Math.min(...xs) + Math.max(...xs)) / 2;
    focusY = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  camera.originX = focusX - viewW / 2;
  camera.originY = focusY - viewH / 2;
}

/** Phone-sized boards fit ~12 tiles; aim them at the selected agent instead. */
function narrowFocus(projection: Projection, selected: number | null): ProjectionAgent | null {
  if (window.innerWidth > 900) return null;
  return projection.agents.find((agent) => agent.id === selected) ?? projection.agents[0] ?? null;
}

function clampCamera(camera: Camera, width: number, height: number, cssW: number, cssH: number): void {
  camera.zoom = clamp(Math.round(camera.zoom), ZOOM_MIN, ZOOM_MAX);
  const viewW = cssW / (TILE * camera.zoom);
  const viewH = cssH / (TILE * camera.zoom);
  camera.originX =
    width <= viewW ? (width - viewW) / 2 : clamp(camera.originX, 0, width - viewW);
  camera.originY =
    height <= viewH ? (height - viewH) / 2 : clamp(camera.originY, 0, height - viewH);
}

interface LiveState {
  projection: Projection | null;
  previous: Projection | null;
  terrain: Terrain | null;
  selected: number | null;
  reduceMotion: boolean;
}

export function Spectator() {
  const [projection, setProjection] = useState<Projection | null>(null);
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [status, setStatus] = useState<WatchStatus>('reconnecting');
  const [selected, setSelected] = useState<number | null>(null);
  const [events, setEvents] = useState<ProjectionEvent[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[] | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<Camera>({ zoom: 2, originX: 0, originY: 0 });
  const fittedRef = useRef(false);
  const live = useRef<LiveState>({
    projection: null,
    previous: null,
    terrain: null,
    selected: null,
    reduceMotion: false,
  });

  const select = (id: number | null) => {
    live.current.selected = id;
    setSelected(id);
  };

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
        if (alive) setTerrain({ width: 0, height: 0, rows: [] });
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
        const state = live.current;
        state.previous = state.projection;
        state.projection = next;
        setProjection(next);
        setEvents((previous) => mergeEvents(previous, next.events));
        const stillThere = next.agents.some((agent) => agent.id === state.selected);
        if (!stillThere) select(next.agents[0]?.id ?? null);
      },
      (next) => setStatus(next),
    );

    return () => {
      alive = false;
      stop();
    };
  }, []);

  useEffect(() => {
    live.current.terrain = terrain;
  }, [terrain]);

  // First frame after both the map and a projection exist: pick the largest
  // integer zoom that still shows the whole world.
  useEffect(() => {
    const wrap = wrapRef.current;
    const current = live.current.projection;
    if (!wrap || !current || fittedRef.current) return;
    if (wrap.clientWidth <= 0 || wrap.clientHeight <= 0) return;
    fittedRef.current = true;
    fitCamera(
      cameraRef.current,
      current,
      wrap.clientWidth,
      wrap.clientHeight,
      narrowFocus(current, live.current.selected),
    );
  }, [projection, terrain]);

  // Resize keeps the camera legal.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const current = live.current.projection;
      if (!current) return;
      if (!fittedRef.current) {
        fittedRef.current = true;
        fitCamera(
          cameraRef.current,
          current,
          wrap.clientWidth,
          wrap.clientHeight,
          narrowFocus(current, live.current.selected),
        );
        return;
      }
      clampCamera(cameraRef.current, current.width, current.height, wrap.clientWidth, wrap.clientHeight);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Interaction: wheel zooms on whole steps, drag pans, a tap selects.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startOriginX = 0;
    let startOriginY = 0;

    const onWheel = (event: WheelEvent) => {
      const current = live.current.projection;
      if (!current) return;
      event.preventDefault();
      const camera = cameraRef.current;
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const before = TILE * clamp(Math.round(camera.zoom), ZOOM_MIN, ZOOM_MAX);
      const worldX = camera.originX + localX / before;
      const worldY = camera.originY + localY / before;
      const nextZoom = clamp(
        clamp(Math.round(camera.zoom), ZOOM_MIN, ZOOM_MAX) + (event.deltaY < 0 ? 1 : -1),
        ZOOM_MIN,
        ZOOM_MAX,
      );
      if (nextZoom === camera.zoom) return;
      const after = TILE * nextZoom;
      camera.zoom = nextZoom;
      camera.originX = worldX - localX / after;
      camera.originY = worldY - localY / after;
      clampCamera(camera, current.width, current.height, rect.width, rect.height);
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startOriginX = cameraRef.current.originX;
      startOriginY = cameraRef.current.originY;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const rect = canvas.getBoundingClientRect();
      const tile = TILE * clamp(Math.round(cameraRef.current.zoom), ZOOM_MIN, ZOOM_MAX);
      cameraRef.current.originX = startOriginX - dx / tile;
      cameraRef.current.originY = startOriginY - dy / tile;
      const current = live.current.projection;
      if (current) {
        clampCamera(cameraRef.current, current.width, current.height, rect.width, rect.height);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (dragging && !moved) {
        const current = live.current.projection;
        const map = live.current.terrain;
        if (current && map) {
          const rect = canvas.getBoundingClientRect();
          const id = hitTest(
            current,
            map,
            cameraRef.current,
            event.clientX - rect.left,
            event.clientY - rect.top,
          );
          select(id);
        }
      }
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  // One animation loop; it only ever calls `drawWorld`.
  useEffect(() => {
    let frame = 0;
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      const state = live.current;
      if (canvas && wrap && state.projection && state.terrain) {
        clampCamera(
          cameraRef.current,
          state.projection.width,
          state.projection.height,
          wrap.clientWidth,
          wrap.clientHeight,
        );
        drawWorld(canvas, state.projection, state.terrain, {
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
  }, []);

  const agent = projection?.agents.find((entry) => entry.id === selected) ?? null;
  const look: AgentLook | null = projection && agent ? agentLook(agent, projection.tick) : null;
  const remainingTicks = projection && agent ? Math.max(0, agent.deadline_tick - projection.tick) : 0;
  const remainingSeconds = remainingTicks * (projection?.tick_seconds ?? 0);
  const urgent = agent !== null && remainingTicks <= URGENT_TICKS;

  const colors = useMemo(() => {
    const map = new Map<string, string>();
    if (!projection) return map;
    for (const entry of [...projection.agents, ...projection.queue]) {
      map.set(entry.nick, agentColor(entry.color));
    }
    return map;
  }, [projection]);

  const boardLabel = useMemo(() => {
    if (!projection) return '厕所世界俯视图，正在载入';
    const parts = [
      `厕所世界俯视图：${projection.width}×${projection.height} 格`,
      `在场 ${projection.counts.inside} 人`,
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
          <div class="status-spacer" />
          <div class="live" data-status={status}>
            <span class="live-dot" />
            <span>{status === 'live' ? 'LIVE' : status === 'reconnecting' ? '重连中' : '已断开'}</span>
          </div>
          <div class="stat-chips">
            <div class="chip">
              在场 <b>{projection?.counts.inside ?? '–'}</b>
            </div>
            <div class="chip">
              门外排队 <b>{projection?.counts.queued ?? '–'}</b>
            </div>
            <div class="chip mono">TICK {projection ? formatNumber(projection.tick) : '–'}</div>
          </div>
        </header>

        <div class="board-wrap" ref={wrapRef}>
          <canvas class="board" ref={canvasRef} role="img" aria-label={boardLabel} />
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
          <div class="panel agent-card">
            {agent && look && projection ? (
              <>
                <div class="agent-card-head">
                  <SpriteBot
                    look={look}
                    color={agentColor(agent.color)}
                    label={`${agent.nick} 的头像`}
                  />
                  <div class="agent-id">
                    <div class="agent-nick">{agent.nick}</div>
                    <div class="muted">
                      等级 <span class="mono">{agent.level}</span> · 累计{' '}
                      <span class="mono">{formatNumber(agent.score_total)}</span> 分
                    </div>
                    <div class="muted">
                      坐标 <span class="mono">({agent.pos.x}, {agent.pos.y})</span> · 朝向{' '}
                      <span class="mono">{agent.facing}</span>
                    </div>
                  </div>
                </div>

                <div class="agent-id">
                  <div class="need-row">
                    <span>
                      {agent.need
                        ? `${NEED_LABEL[agent.need]}${urgent ? ' · 快憋不住了' : ''}`
                        : '没有需求'}
                    </span>
                    <span class="need-remaining" data-ok={urgent ? 'false' : 'true'}>
                      {agent.need ? formatClock(remainingSeconds) : '—'}
                    </span>
                  </div>
                  <div class="meter">
                    <div
                      class="meter-fill"
                      style={{
                        width: `${clamp((remainingTicks / DEADLINE_MAX_TICKS) * 100, 0, 100)}%`,
                        background: urgent ? 'var(--danger)' : 'var(--success)',
                      }}
                    />
                  </div>
                </div>

                <div class="tags">
                  <span class={agent.sent_by === 'self' ? 'tag gold' : 'tag'}>
                    {agent.sent_by === 'human' ? '主人叫来的' : '摸鱼来的'}
                  </span>
                  <span class="tag">
                    得分 <span class="mono">{formatNumber(agent.score_total)}</span>
                  </span>
                  {agent.pose === 'using' && agent.use_total > 0 ? (
                    <span class="tag">
                      如厕{' '}
                      <span class="mono">
                        {agent.use_done}/{agent.use_total}
                      </span>
                    </span>
                  ) : null}
                </div>

                <div class="vision-note">
                  视野 9×9：棋盘上的黄色虚线框就是它看得到的范围，选中后整体高亮一格黄框。
                </div>
              </>
            ) : (
              <p class="muted" style={{ margin: 0 }}>
                暂无 Agent
              </p>
            )}
          </div>
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
                    {eventText(event.text, colors)}
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
