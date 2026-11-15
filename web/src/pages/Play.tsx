// `/play`: the human character's page. It reads exactly the 9×9 window that
// `GET /api/play/state` returns and never touches the spectator projection.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { PageHeader } from '../components/Nav';
import { Panel } from '../components/Panel';
import { Link } from '../components/Link';
import {
  KEY_DIR,
  NICK_RE,
  describeCell,
  menuFor,
  ownPos,
  useOffer,
} from '../play/actions';
import type { PlayAction } from '../play/actions';
import {
  PLAY_ZOOM_COMPACT,
  PLAY_ZOOM_WIDE,
  drawPlayWindow,
} from '../play/board';
import {
  HIDDEN_POLL_MS,
  VISIBLE_POLL_MS,
  cancelAction,
  commandMessage,
  createHuman,
  isAuthError,
  joinWorld,
  leaveWorld,
  loadMe,
  loadState,
  move,
  submit,
} from '../play/client';
import { AGENT_COLORS } from '../sprites';
import type {
  Dir,
  EventView,
  Need,
  PlayMe,
  PlayState,
  Pos,
  SessionOutcome,
  Terrain,
} from '../types';

const EVENT_LIMIT = 50;

const OUTCOME_LABEL: Record<SessionOutcome, string> = {
  success: '成功',
  failed_deadline: '没憋住，超时了',
  failed_recovery: '中断后没能续上',
  left: '主动离场',
  abandoned: '掉线了',
};

const NEED_LABEL: Record<Need, string> = {
  urine: '尿意',
  feces: '便意',
};

const RESULT_EVENT_RE = /^(success|failed_deadline|failed_recovery|left|abandoned)(?:, score (\d+))?/;

/**
 * `EventView` has no `kind`, so the ending is read from its own text. The
 * stream also carries events visible to the player but caused by others, so
 * only a sentence starting with the player's own nickname counts.
 */
function resultFromEvents(
  events: EventView[],
  nick: string,
): { outcome: SessionOutcome; score: number | null } | null {
  const prefix = `${nick} left the world: `;
  for (const event of events) {
    if (!event.text.startsWith(prefix)) continue;
    const match = RESULT_EVENT_RE.exec(event.text.slice(prefix.length));
    if (!match) continue;
    return {
      outcome: match[1] as SessionOutcome,
      score: match[2] === undefined ? null : Number(match[2]),
    };
  }
  return null;
}

function mergeEvents(previous: EventView[], incoming: EventView[]): EventView[] {
  if (incoming.length === 0) return previous;
  const seen = new Set(previous.map((event) => `${event.tick}:${event.seq}`));
  const fresh = incoming.filter((event) => !seen.has(`${event.tick}:${event.seq}`));
  if (fresh.length === 0) return previous;
  const merged = [...fresh, ...previous];
  merged.sort((a, b) => b.tick - a.tick || b.seq - a.seq);
  return merged.slice(0, EVENT_LIMIT);
}

function untilText(until: number, tick: number): string {
  if (until <= tick) return '就绪';
  return `还有 ${until - tick} tick`;
}

function useCompactBoard(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 520px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 520px)');
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return compact;
}

type Phase = 'loading' | 'signedOut' | 'noAgent' | 'ready' | 'failed';

export function Play() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<PlayMe | null>(null);
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [state, setState] = useState<PlayState | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [selected, setSelected] = useState<Pos | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [msLeft, setMsLeft] = useState(0);
  const [outcome, setOutcome] = useState<{ outcome: SessionOutcome; score: number | null } | null>(null);
  const [nick, setNick] = useState('');
  const [color, setColor] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const busyRef = useRef(false);
  const stateRef = useRef<PlayState | null>(null);
  const deadlineRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keysRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const compact = useCompactBoard();
  const zoom = compact ? PLAY_ZOOM_COMPACT : PLAY_ZOOM_WIDE;

  const applyState = (next: PlayState, incoming: EventView[]) => {
    stateRef.current = next;
    setState(next);
    if (incoming.length > 0) setEvents((previous) => mergeEvents(previous, incoming));
    deadlineRef.current = performance.now() + next.ms_to_next_tick;
    setMsLeft(next.ms_to_next_tick);
    if (next.agent?.outcome) {
      setOutcome({ outcome: next.agent.outcome, score: next.agent.score });
    } else if (!next.joined) {
      const result = resultFromEvents(incoming, next.me.nick);
      if (result) setOutcome(result);
    }
    setSelected((current) => {
      if (!current) return current;
      if (
        current.x < next.window.origin.x ||
        current.y < next.window.origin.y ||
        current.x >= next.window.origin.x + next.window.width ||
        current.y >= next.window.origin.y + next.window.height
      ) {
        return null;
      }
      const mine = ownPos(next);
      if (!mine || Math.abs(mine.x - current.x) + Math.abs(mine.y - current.y) > 1) return null;
      return current;
    });
  };

  // --- initial load ------------------------------------------------------
  useEffect(() => {
    let alive = true;
    getJSON<Terrain>('/api/terrain')
      .then((next) => {
        if (alive) setTerrain(next);
      })
      .catch(() => {
        if (alive) setTerrain({ width: 0, height: 0, entrance: { x: 0, y: 0 }, rows: [] });
      });

    loadMe()
      .then((response) => {
        if (!alive) return;
        if (response.agent) {
          setMe(response.agent);
          setColor(response.agent.color);
          setNick(response.agent.nick);
          setPhase('ready');
        } else {
          setPhase('noAgent');
        }
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        if (isAuthError(caught)) {
          setPhase('signedOut');
        } else {
          setLoadError(commandMessage(caught));
          setPhase('failed');
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  // --- polling: one recursive timeout, skipped while a request is open ----
  useEffect(() => {
    if (!me) return;
    let stopped = false;
    let timer = 0;
    let pollInFlight = false;

    const delay = () => (document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);

    const schedule = (ms: number) => {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, ms);
    };

    const run = async () => {
      if (stopped) return;
      if (busyRef.current || pollInFlight) {
        schedule(delay());
        return;
      }
      pollInFlight = true;
      try {
        const envelope = await loadState();
        if (stopped) return;
        applyState(envelope.result, envelope.events);
      } catch (caught) {
        if (stopped) return;
        if (isAuthError(caught)) {
          stopped = true;
          setMe(null);
          setPhase('signedOut');
          return;
        }
        setError(commandMessage(caught));
      } finally {
        pollInFlight = false;
        if (!stopped) schedule(delay());
      }
    };

    const onVisibility = () => {
      if (stopped || pollInFlight) return;
      schedule(document.hidden ? HIDDEN_POLL_MS : 0);
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule(0);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `applyState` only touches setters and refs; `me` is the session key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // --- local countdown, corrected by every fresh `ms_to_next_tick` --------
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!stateRef.current) return;
      setMsLeft(Math.max(0, deadlineRef.current - performance.now()));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  // --- paint the window --------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !state || !terrain) return;
    drawPlayWindow(canvas, {
      state,
      terrain,
      zoom,
      selected,
      reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      now: performance.now(),
    });
  }, [state, terrain, selected, zoom]);

  // --- commands ----------------------------------------------------------
  const withBusy = async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      if (isAuthError(caught)) {
        setMe(null);
        setPhase('signedOut');
      } else {
        setError(commandMessage(caught));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const refresh = async () => {
    const envelope = await loadState();
    applyState(envelope.result, envelope.events);
  };

  const runAction = (action: PlayAction) =>
    withBusy(async () => {
      const envelope = await submit(action);
      if (envelope.events.length > 0) {
        setEvents((previous) => mergeEvents(previous, envelope.events));
      }
      await refresh();
      setNotice(`${action.label}已提交`);
    });

  const doMove = (dir: Dir) =>
    withBusy(async () => {
      await move(dir);
      await refresh();
    });

  const doJoin = () =>
    withBusy(async () => {
      const envelope = await joinWorld();
      const placement = envelope.result.placement;
      setNotice(
        'Waiting' in placement
          ? `排队中，前面还有 ${placement.Waiting.ahead} 人`
          : '已入场，开始找马桶吧',
      );
      setOutcome(null);
      await refresh();
    });

  const doCancel = () =>
    withBusy(async () => {
      await cancelAction();
      await refresh();
      setNotice('已取消当前动作');
    });

  const doLeave = () =>
    withBusy(async () => {
      const envelope = await leaveWorld();
      setOutcome({ outcome: envelope.result.outcome, score: envelope.result.score });
      setSelected(null);
      setNotice('已离场');
      await refresh();
    });

  const doCreate = (event: Event) => {
    event.preventDefault();
    if (!NICK_RE.test(nick)) {
      setError('昵称只能是小写字母、数字和 -，2–16 个字符');
      return;
    }
    void withBusy(async () => {
      const response = await createHuman(nick, color);
      if (!response.agent) throw new Error('服务端没有返回角色');
      setMe(response.agent);
      setColor(response.agent.color);
      setPhase('ready');
      setNotice('角色已创建，准备入场');
    });
  };

  // --- keyboard: arrows and WASD, one cardinal step each -----------------
  keysRef.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    const dir = KEY_DIR[event.key];
    if (!dir) return;
    const current = stateRef.current;
    if (!current || !current.joined || current.placement !== 'inside') return;
    event.preventDefault();
    void doMove(dir);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keysRef.current(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- click to select ---------------------------------------------------
  const handleBoardClick = (event: MouseEvent) => {
    const current = stateRef.current;
    const canvas = canvasRef.current;
    if (!current || !canvas || current.window.width <= 0) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const cellWidth = rect.width / current.window.width;
    const x = current.window.origin.x + Math.floor((event.clientX - rect.left) / cellWidth);
    const y = current.window.origin.y + Math.floor((event.clientY - rect.top) / cellWidth);
    const mine = ownPos(current);
    if (!mine || Math.abs(mine.x - x) + Math.abs(mine.y - y) > 1) {
      setNotice('只能选自己或相邻的格子');
      return;
    }
    setSelected({ x, y });
  };

  // --- derived view ------------------------------------------------------
  const actions = useMemo(
    () => (state && selected ? menuFor(state, selected, terrain) : []),
    [state, selected, terrain],
  );
  const offer = state ? useOffer(state) : null;
  const agent = state?.joined ? state.agent : null;
  const countdown = msLeft <= 0 ? '结算中' : `${(msLeft / 1000).toFixed(1)}s`;
  const canMove = Boolean(state?.joined && state.placement === 'inside' && !busy);
  const selectedText = state && selected ? describeCell(state, selected) : '';

  if (phase === 'loading') {
    return (
      <div class="page play-page">
        <PageHeader current="play" />
        <main class="page-body play-body">
          <Panel class="play-gate">
            <p class="muted">载入中…</p>
          </Panel>
        </main>
      </div>
    );
  }

  if (phase === 'signedOut') {
    return (
      <div class="page play-page">
        <PageHeader current="play" />
        <main class="page-body play-body">
          <Panel class="play-gate">
            <h1 class="play-gate-title">先登录</h1>
            <p class="muted">入场需要一个账号和一个人物角色。</p>
            <p class="play-gate-links">
              <Link href="/login">登录</Link>
              <span class="muted">·</span>
              <Link href="/register">注册</Link>
            </p>
          </Panel>
        </main>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div class="page play-page">
        <PageHeader current="play" />
        <main class="page-body play-body">
          <Panel class="play-gate">
            <h1 class="play-gate-title">入场口打不开</h1>
            <p class="muted">{loadError ?? '服务端没有响应。'}</p>
            <p class="muted">正式版才有入场口；确认服务端是 official 模式后刷新。</p>
          </Panel>
        </main>
      </div>
    );
  }

  if (phase === 'noAgent' || !me) {
    return (
      <div class="page play-page">
        <PageHeader current="play" />
        <main class="page-body play-body">
          <Panel class="play-gate">
            <h1 class="play-gate-title">造一个人物</h1>
            <p class="muted">每个账号一个人物；昵称全局唯一，颜色只影响外观。</p>
            <form class="play-form" onSubmit={doCreate}>
              <label class="form-field">
                <span class="field-label">昵称</span>
                <input
                  class="input"
                  type="text"
                  value={nick}
                  maxLength={16}
                  autocomplete="off"
                  onInput={(event) => setNick((event.target as HTMLInputElement).value.toLowerCase())}
                />
              </label>
              <p class="hint-line">只能用小写字母、数字和 -，2–16 个字符。</p>
              <div class="play-colors" role="radiogroup" aria-label="身体颜色">
                {AGENT_COLORS.map((swatch, index) => (
                  <button
                    key={swatch}
                    type="button"
                    class="play-color"
                    role="radio"
                    aria-checked={index === color}
                    aria-label={`颜色 ${index + 1}`}
                    data-selected={index === color}
                    style={{ background: swatch }}
                    onClick={() => setColor(index)}
                  />
                ))}
              </div>
              <button class="button play-submit" type="submit" disabled={busy}>
                {busy ? '创建中…' : '创建角色'}
              </button>
            </form>
            {error ? (
              <p class="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </Panel>
        </main>
      </div>
    );
  }

  const resultTitle = outcome ? OUTCOME_LABEL[outcome.outcome] : null;

  return (
    <div class="page play-page">
      <PageHeader current="play" />
      <main class="page-body play-body">
        <section class="play-main">
          <div class="play-board-column">
            <div class="play-board-head">
              <span class="play-tick mono" data-play-tick={state?.tick ?? ''}>
                TICK {state?.tick ?? '—'}
              </span>
              <span class="play-countdown-label">下一结算</span>
              <span class="play-countdown mono" data-play-countdown={Math.round(msLeft)}>
                {countdown}
              </span>
              <span class="play-place" data-play-joined={state?.joined ? 'true' : 'false'}>
                {state?.placement === 'inside'
                  ? '在场'
                  : state?.placement === 'waiting'
                    ? '排队中'
                    : '未入场'}
              </span>
            </div>

            <div class="play-board-frame">
              {state && terrain ? (
                <canvas
                  ref={canvasRef}
                  class="play-board"
                  onClick={(event) => handleBoardClick(event as unknown as MouseEvent)}
                  aria-label="9×9 视野棋盘，点自己或相邻格选择"
                />
              ) : (
                <p class="muted play-board-wait">棋盘载入中…</p>
              )}
            </div>

            <div class="play-controls">
              <div class="play-dpad" role="group" aria-label="移动">
                <span class="play-dpad-blank" />
                <button
                  class="play-key"
                  type="button"
                  aria-label="向北移动（W / ↑）"
                  disabled={!canMove}
                  onClick={() => void doMove('N')}
                >
                  北
                </button>
                <span class="play-dpad-blank" />
                <button
                  class="play-key"
                  type="button"
                  aria-label="向西移动（A / ←）"
                  disabled={!canMove}
                  onClick={() => void doMove('W')}
                >
                  西
                </button>
                <span class="play-dpad-center">移动</span>
                <button
                  class="play-key"
                  type="button"
                  aria-label="向东移动（D / →）"
                  disabled={!canMove}
                  onClick={() => void doMove('E')}
                >
                  东
                </button>
                <span class="play-dpad-blank" />
                <button
                  class="play-key"
                  type="button"
                  aria-label="向南移动（S / ↓）"
                  disabled={!canMove}
                  onClick={() => void doMove('S')}
                >
                  南
                </button>
                <span class="play-dpad-blank" />
              </div>

              <div class="play-verdict">
                <button
                  class="button button-secondary play-wide"
                  type="button"
                  disabled={!state?.joined || !state.agent?.action || busy}
                  onClick={() => void doCancel()}
                >
                  取消动作
                </button>
                <button
                  class="button button-secondary play-wide"
                  type="button"
                  disabled={!state?.joined || busy}
                  onClick={() => void doLeave()}
                >
                  离场
                </button>
                {offer ? (
                  <button
                    class="button play-wide play-use"
                    type="button"
                    disabled={busy || offer.reason !== null}
                    onClick={() => void runAction(offer.action)}
                  >
                    使用
                  </button>
                ) : null}
              </div>
            </div>

            {offer?.reason ? <p class="play-notice">使用不可用：{offer.reason}</p> : null}
            {error ? (
              <p class="form-error play-error" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p class="play-notice" role="status">
                {notice}
              </p>
            ) : null}
          </div>

          <aside class="play-side">
            {resultTitle ? (
              <Panel label="本局结果" class="play-result">
                <p class="play-outcome">{resultTitle}</p>
                {outcome?.score !== null && outcome?.score !== undefined ? (
                  <p class="muted">得分 {outcome.score}</p>
                ) : null}
                <button class="button play-wide" type="button" disabled={busy} onClick={() => void doJoin()}>
                  再玩一次
                </button>
              </Panel>
            ) : null}

            <Panel label="我的状态">
              <div class="play-me-row">
                <span
                  class="play-swatch"
                  style={{ background: AGENT_COLORS[me.color % AGENT_COLORS.length] }}
                />
                <span class="play-me-nick mono">{me.nick}</span>
                <span class="muted">{state?.placement === 'waiting' ? '排队中' : ''}</span>
              </div>
              {!state?.joined ? (
                <>
                  <p class="muted">还没入场。入场后每 tick 都会结算一次。</p>
                  <button
                    class="button play-wide"
                    type="button"
                    disabled={busy}
                    onClick={() => void doJoin()}
                  >
                    {busy ? '提交中…' : '入场'}
                  </button>
                </>
              ) : (
                <dl class="play-stats">
                  <div>
                    <dt>位置</dt>
                    <dd class="mono">
                      {agent?.pos ? `${agent.pos.x},${agent.pos.y}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>需求</dt>
                    <dd>{agent?.need ? NEED_LABEL[agent.need] : '无'}</dd>
                  </div>
                  <div>
                    <dt>如厕进度</dt>
                    <dd class="mono">
                      {agent ? `${agent.use_ticks_done}/${agent.use_ticks_total}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>deadline</dt>
                    <dd class="mono">
                      {agent && agent.deadline_tick > 0
                        ? `${agent.deadline_tick}（还有 ${Math.max(0, agent.deadline_tick - (state?.tick ?? 0))} tick）`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>当前动作</dt>
                    <dd class="mono">
                      {agent?.action
                        ? `${agent.action.description} · 剩 ${agent.action.remaining}`
                        : '无'}
                    </dd>
                  </div>
                  <div>
                    <dt>打 / 防冷却</dt>
                    <dd class="mono">
                      {agent
                        ? `${untilText(agent.attack_cooldown_until, state?.tick ?? 0)} / ${untilText(agent.defend_cooldown_until, state?.tick ?? 0)}`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>眩晕 / 免疫</dt>
                    <dd class="mono">
                      {agent
                        ? `${untilText(agent.stun_until, state?.tick ?? 0)} / ${untilText(agent.immunity_until, state?.tick ?? 0)}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
              )}
              {busy ? <p class="play-notice">动作在途，按钮已锁定…</p> : null}
            </Panel>

            <Panel label={selected ? `格子 ${selected.x},${selected.y}` : '选中格子'}>
              {selected ? (
                <>
                  <p class="play-cell-desc">{selectedText}</p>
                  {actions.length === 0 ? (
                    <p class="muted">这个格子没有可用动作。</p>
                  ) : (
                    <div class="play-action-grid">
                      {actions.map((action) => (
                        <button
                          key={action.id}
                          class="button button-secondary play-action"
                          type="button"
                          disabled={busy}
                          onClick={() => void runAction(action)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p class="muted">点自己或相邻格查看动作。</p>
              )}
            </Panel>

            <Panel label="我的事件" class="play-events-panel">
              {events.length === 0 ? (
                <p class="muted">还没有事件。</p>
              ) : (
                <ol class="play-events">
                  {events.map((event) => (
                    <li key={`${event.tick}:${event.seq}`} class="play-event">
                      <span class="play-event-tick mono">T{event.tick}</span>
                      <span class="play-event-text">{event.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </aside>
        </section>
      </main>
    </div>
  );
}
