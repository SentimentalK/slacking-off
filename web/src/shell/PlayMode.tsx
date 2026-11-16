import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import { getJSON } from '../api';
import { navigate } from '../router';
import {
  DIR_DELTA,
  KEY_DIR,
  NICK_RE,
  agentAt,
  describeCell,
  dirBetween,
  menuFor,
  moveAction,
  objectAt,
  ownAgent,
  ownPos,
  samePos,
  useOffer,
} from '../play/actions';
import { labelText } from '../play/actions';
import type { PlayAction, UseOffer } from '../play/actions';
import { playProjection, visionGrid } from '../play/frame';
import { findPath } from '../play/path';
import { needLabel } from '../labels';
import { actionIn, eventIn } from '../eventText';
import { t, tn, useI18n } from '../i18n';
import type { Key } from '../i18n';
import { agentColor } from '../palette';
import type { ClickHit, WorldView } from '../world3d';
import type {
  Dir,
  LeaderRow,
  PlayState,
  Pos,
  ProjectionAgent,
  SessionOutcome,
  Terrain,
  WorldSummary,
} from '../types';
import { Card, DEADLINE_MAX_TICKS, meterColor } from './Card';
import { Window } from './Window';
import { msgText } from '../play/client';
import type { Msg } from '../play/client';
import type { CommandResult } from './usePlay';
import { usePlay } from './usePlay';
import type { WorldOverride } from './useWorld';

const FLASH_MS = 5000;
const FRAME_CELLS = 9;
const MENU_GAP = 14;
const EDGE = 8;
const CREATE_COLORS = 12;

const OUTCOME_LABEL: Record<SessionOutcome, Key> = {
  success: 'play.outcome.success',
  failed_deadline: 'play.outcome.failed_deadline',
  failed_recovery: 'play.outcome.failed_recovery',
  left: 'play.outcome.left',
  abandoned: 'play.outcome.abandoned',
};

interface Props {
  terrain: Terrain | null;
  top3: LeaderRow[];
  view: () => WorldView | null;
  viewReady: boolean;
  override: RefObject<WorldOverride | null>;
  clickRef: RefObject<((hit: ClickHit) => void) | null>;
  cameraRef: RefObject<(() => void) | null>;
  blocked: boolean;
}

interface Menu {
  cell: Pos;
  own: boolean;
}

interface MenuItem {
  action: PlayAction;
  disabled: boolean;
  reason: string | null;
}

interface PathPlan {
  cells: Pos[];
  tick: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Side = 'right' | 'left' | 'below' | 'above';
const SIDES: Side[] = ['right', 'left', 'below', 'above'];
const ARROW_INSET = 12;

const dist = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function pathCells(start: Pos, path: string): Pos[] {
  const cells: Pos[] = [];
  let x = start.x;
  let y = start.y;
  for (const step of path) {
    const delta = DIR_DELTA[step as Dir];
    x += delta.x;
    y += delta.y;
    cells.push({ x, y });
  }
  return cells;
}

function untilText(until: number, tick: number): string {
  if (until <= tick) return t('play.ready');
  return tn('play.until', until - tick);
}

function buildMenu(state: PlayState, terrain: Terrain | null, menu: Menu, offer: UseOffer | null): MenuItem[] {
  if (menu.own) {
    return offer
      ? [{ action: offer.action, disabled: offer.reason !== null, reason: offer.reason ? t(offer.reason) : null }]
      : [];
  }
  const me = ownPos(state);
  if (!me) return [];
  const items: MenuItem[] = [];
  const dir = dirBetween(me, menu.cell);
  if (dir && !objectAt(state, menu.cell) && !agentAt(state, menu.cell)) {
    const walk: PlayAction = { id: 'move', label: { key: 'play.act.walk' }, kind: 'move', dir };
    items.push({ action: walk, disabled: false, reason: null });
  }
  for (const action of menuFor(state, menu.cell, terrain)) {
    items.push({ action, disabled: false, reason: null });
  }
  return items;
}

function selfCard(state: PlayState, agent: NonNullable<PlayState['agent']>): ProjectionAgent {
  const body = ownAgent(state);
  return {
    id: state.me.agent_id,
    nick: state.me.nick,
    color: state.me.color,
    session_id: agent.session_id ?? 0,
    pos: body?.pos ?? agent.pos ?? { x: 0, y: 0 },
    pose: body?.pose ?? 'idle',
    facing: body?.facing ?? 'S',
    kind: 'human',
    need: agent.need,
    use_done: agent.use_ticks_done,
    use_total: agent.use_ticks_total,
    deadline_tick: agent.deadline_tick,
    sent_by: null,
    level: agent.level,
    score_total: agent.score_total,
    defending: body?.defending ?? null,
    stun_until: agent.stun_until,
    immunity_until: agent.immunity_until,
    action_target: body?.action_target ?? null,
    attack_land_tick: body?.attack_land_tick ?? null,
    recovery_deadline: body?.recovery_deadline ?? null,
    urgent: body?.urgent ?? false,
  };
}

function boundsOf(points: Array<{ x: number; y: number }>): Rect {
  return {
    left: Math.min(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    right: Math.max(...points.map((p) => p.x)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
}

function menuRect(view: WorldView, cell: Pos, toilets: Pos[]): Rect | null {
  const shack = toilets.find((t) => Math.abs(t.x - cell.x) <= 1 && Math.abs(t.y - cell.y) <= 1);
  if (shack) {
    const corners = [-1, 1].flatMap((dy) => [-1, 1].map((dx) => view.screenOfCell(shack.x + dx, shack.y + dy)));
    if (corners.some((p) => p === null)) return null;
    const box = boundsOf(corners as Array<{ x: number; y: number }>);
    const padX = (box.right - box.left) / 4;
    const padY = (box.bottom - box.top) / 4;
    return { left: box.left - padX, top: box.top - padY, right: box.right + padX, bottom: box.bottom + padY };
  }
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([dx, dy]) => view.screenOfCell(cell.x + dx - 0.5, cell.y + dy - 0.5));
  if (corners.some((p) => p === null)) return null;
  return boundsOf(corners as Array<{ x: number; y: number }>);
}

function placeMenu(el: HTMLElement, rect: Rect, target: { x: number; y: number }): void {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const spots: Array<{ side: Side; left: number; top: number }> = [
    { side: 'right', left: rect.right + MENU_GAP, top: cy - height / 2 },
    { side: 'left', left: rect.left - MENU_GAP - width, top: cy - height / 2 },
    { side: 'below', left: cx - width / 2, top: rect.bottom + MENU_GAP },
    { side: 'above', left: cx - width / 2, top: rect.top - MENU_GAP - height },
  ];
  const inView = (spot: { left: number; top: number }): boolean =>
    spot.left >= EDGE &&
    spot.top >= EDGE &&
    spot.left + width <= window.innerWidth - EDGE &&
    spot.top + height <= window.innerHeight - EDGE;
  const spot = spots.find(inView) ?? spots[0];
  const left = Math.min(Math.max(EDGE, spot.left), Math.max(EDGE, window.innerWidth - width - EDGE));
  const top = Math.min(Math.max(EDGE, spot.top), Math.max(EDGE, window.innerHeight - height - EDGE));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.setAttribute('data-menu-side', spot.side);
  for (const side of SIDES) el.classList.toggle(`pm-menu--${side}`, side === spot.side);
  const vertical = spot.side === 'right' || spot.side === 'left';
  const span = vertical ? height : width;
  const along = vertical ? target.y - top : target.x - left;
  el.style.setProperty('--pm-arrow', `${Math.min(Math.max(ARROW_INSET, along), span - ARROW_INSET)}px`);
}

export function PlayMode({ terrain, top3, view, viewReady, override, clickRef, cameraRef, blocked }: Props) {
  const { lang } = useI18n();
  const play = usePlay(true);
  const state = play.state;
  const [worldId, setWorldId] = useState<number | null>(null);
  const [path, setPath] = useState<PathPlan | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [following, setFollowing] = useState(false);
  const followRef = useRef(false);
  const menuCellRef = useRef<Pos | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState<Msg | null>(null);
  const flashTimer = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createNick, setCreateNick] = useState('');
  const [createColor, setCreateColor] = useState(0);
  const [createError, setCreateError] = useState<Msg | null>(null);

  const W = terrain?.width ?? 0;
  const H = terrain?.height ?? 0;
  const agent = state?.joined ? state.agent : null;
  const inScene = Boolean(state?.joined && state.agent?.pos);
  const mePos = state ? ownPos(state) : null;
  const offer = state ? useOffer(state) : null;
  const here = state && mePos ? objectAt(state, mePos) : null;
  const onToilet = here?.kind === 'toilet' && !here.site;
  const urgent = state ? (ownAgent(state)?.urgent ?? false) : false;
  const remaining = agent ? Math.max(0, agent.deadline_tick - (state?.tick ?? 0)) : 0;
  const fraction = agent?.need ? Math.min(1, remaining / DEADLINE_MAX_TICKS) : 0;

  const say = (message: Msg) => {
    setFlash(message);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  };

  const report = (result: CommandResult) => {
    if (!result.ok) say(result.message);
    else if (result.notice) say(result.notice);
  };

  const setFollow = (on: boolean) => {
    followRef.current = on;
    setFollowing(on);
  };

  const closeMenu = () => {
    menuCellRef.current = null;
    setMenu(null);
  };

  const openMenu = (next: Menu) => {
    menuCellRef.current = next.cell;
    setMenu(next);
  };

  const submitAction = async (action: PlayAction, plan: PathPlan | null = null) => {
    setFollow(true);
    if (action.kind !== 'path') setPath(null);
    const result = await play.runAction(action);
    report(result);
    if (!result.ok) {
      if (action.kind === 'path') setPath(null);
      return;
    }
    if (plan) setPath(plan);
  };

  const handleClick = (hit: ClickHit) => {
    if (!state || !inScene || !mePos || play.busy || state.placement !== 'inside') return;
    if (hit.agentId !== null && hit.agentId !== state.me.agent_id) {
      const other = state.agents.find((entry) => entry.id === hit.agentId);
      if (other && dist(mePos, other.pos) === 1) {
        openMenu({ cell: other.pos, own: false });
        return;
      }
    }
    const cell = hit.cell;
    if (!cell) return;
    if (samePos(cell, mePos)) {
      if (offer) openMenu({ cell, own: true });
      return;
    }
    if (dist(cell, mePos) === 1) {
      openMenu({ cell, own: false });
      return;
    }
    const route = findPath(state, W, H, cell);
    if (route === null) {
      say({ key: 'play.noRoute' });
      return;
    }
    if (route === '') return;
    void submitAction(
      { id: 'path', kind: 'path', label: { key: 'play.act.path', vars: { cell: `(${cell.x},${cell.y})` } }, path: route },
      { cells: pathCells(mePos, route), tick: state.tick },
    );
  };

  const onMenuItem = (item: MenuItem) => {
    closeMenu();
    void submitAction(item.action);
  };

  const join = () => {
    setFollow(true);
    void play.doJoin().then(report);
  };

  const cancel = () => {
    setFollow(true);
    setPath(null);
    void play.doCancel().then(report);
  };

  const leave = () => {
    setFollow(true);
    setPath(null);
    closeMenu();
    void play.doLeave().then(report);
  };

  const onCreate = (event: Event) => {
    event.preventDefault();
    if (!NICK_RE.test(createNick)) {
      setCreateError({ key: 'play.nickError' });
      return;
    }
    setCreateError(null);
    void play.doCreate(createNick, createColor).then((result) => {
      if (result.ok) {
        setCreateOpen(false);
        report(result);
      } else {
        setCreateError(result.message);
      }
    });
  };

  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyRef.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      if (menuCellRef.current) closeMenu();
      return;
    }
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
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const dir = KEY_DIR[key];
    if (!dir) return;
    if (!inScene || play.busy || blocked || createOpen || menuCellRef.current) return;
    event.preventDefault();
    void submitAction(moveAction(dir));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  useEffect(() => {
    clickRef.current = handleClick;
    cameraRef.current = () => {
      if (followRef.current) setFollow(false);
    };
  });

  useEffect(
    () => () => {
      clickRef.current = null;
      cameraRef.current = null;
      override.current = null;
      window.clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    getJSON<WorldSummary[]>('/api/worlds')
      .then((worlds) => {
        if (alive) setWorldId(worlds.find((entry) => entry.official)?.id ?? null);
      })
      .catch(() => {
        if (alive) setWorldId(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!state || !inScene || !terrain || terrain.width <= 0) {
      override.current = null;
      return;
    }
    const id = worldId ?? 0;
    override.current = {
      cur: playProjection(state, id, W, H, terrain),
      prev: play.prev ? playProjection(play.prev, id, W, H, terrain) : null,
      arrivedAt: play.arrivedAt,
      vision: visionGrid(state, W, H),
      selected: state.me.agent_id,
      path: path ? path.cells : null,
    };
  }, [state, play.prev, play.arrivedAt, path, terrain, worldId, inScene]);

  useEffect(() => {
    if (!path || !state) return;
    const pos = state.agent?.pos;
    if (!pos) {
      setPath(null);
      return;
    }
    const at = path.cells.findIndex((cell) => samePos(cell, pos));
    const rest = at >= 0 ? path.cells.slice(at + 1) : path.cells;
    const idle = !state.agent?.action && state.tick > path.tick + 1;
    if (rest.length === 0 || idle) {
      setPath(null);
      return;
    }
    if (rest.length !== path.cells.length) setPath({ cells: rest, tick: path.tick });
  }, [state]);

  useEffect(() => {
    if (menu && state && mePos && !menu.own && dist(menu.cell, mePos) !== 1) closeMenu();
  }, [state]);

  const frameOnSelf = () => {
    const v = view();
    const pos = state?.agent?.pos;
    if (!v || !pos) return;
    v.setView({ focus: pos });
    v.frameCells(pos, FRAME_CELLS);
  };

  useEffect(() => {
    if (!inScene || !viewReady) return;
    frameOnSelf();
    setFollow(true);
  }, [inScene, viewReady]);

  const toiletsOf = (): Pos[] =>
    override.current?.cur.objects.filter((o) => o.kind === 'toilet').map((o) => o.pos) ?? [];

  const placeOpenMenu = (v: WorldView | null): void => {
    const cell = menuCellRef.current;
    const el = menuRef.current;
    if (!v || !el || !cell) return;
    const target = v.screenOfCell(cell.x, cell.y);
    const rect = menuRect(v, cell, toiletsOf());
    if (target && rect) placeMenu(el, rect, target);
  };

  useLayoutEffect(() => {
    placeOpenMenu(view());
  });

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const ov = override.current;
      const v = view();
      if (v && ov && followRef.current && ov.selected !== null) {
        const id = ov.selected;
        const a = ov.cur.agents.find((entry) => entry.id === id);
        if (a) {
          const b = ov.prev?.agents.find((entry) => entry.id === id) ?? a;
          const phase = clamp01((performance.now() - ov.arrivedAt) / (ov.cur.tick_seconds * 1000));
          v.setView({
            focus: {
              x: b.pos.x + (a.pos.x - b.pos.x) * phase,
              y: b.pos.y + (a.pos.y - b.pos.y) * phase,
            },
          });
        }
      }
      placeOpenMenu(v);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  let hintNode: ComponentChildren;
  if (flash !== null) {
    hintNode = msgText(flash);
  } else if (play.phase === 'loading') {
    hintNode = t('play.loading');
  } else if (play.phase === 'signedOut') {
    hintNode = (
      <>
        {t('play.hint.signedOut')}{' '}
        <button type="button" onClick={() => navigate('/login')}>
          {t('window.login')}
        </button>{' '}
        <button type="button" onClick={() => navigate('/register')}>
          {t('window.register')}
        </button>
      </>
    );
  } else if (play.phase === 'failed') {
    hintNode = t('play.hint.loadFailed', { reason: play.loadError ? msgText(play.loadError) : '' });
  } else if (play.phase === 'noAgent') {
    hintNode = (
      <>
        {t('play.hint.noAgent')}{' '}
        <button type="button" data-testid="play-create-open" onClick={() => setCreateOpen(true)}>
          {t('play.createOpen')}
        </button>
      </>
    );
  } else if (play.outcome) {
    const score = play.outcome.score;
    hintNode = (
      <>
        <span data-testid="play-outcome">
          {t(OUTCOME_LABEL[play.outcome.outcome])}
          {score !== null ? t('play.score', { score }) : ''}
        </span>{' '}
        <button type="button" data-testid="play-again" disabled={play.busy} onClick={join}>
          {t('play.again')}
        </button>
      </>
    );
  } else if (state?.placement === 'waiting') {
    hintNode =
      state.agent?.queue_ahead === 0
        ? t('play.hint.waitingNext')
        : t('play.hint.waiting', { n: state.agent?.queue_ahead ?? '—' });
  } else if (!state?.joined) {
    hintNode = (
      <>
        {t('play.hint.join')}{' '}
        <button type="button" data-testid="play-join" disabled={play.busy} onClick={join}>
          {t('play.join')}
        </button>
      </>
    );
  } else if (onToilet) {
    if (offer && offer.reason === null) hintNode = t('play.hint.useToilet');
    else if (offer?.reason) hintNode = t(offer.reason);
    else if (agent && ownAgent(state)?.pose === 'using') {
      hintNode = t('play.hint.using', { done: agent.use_ticks_done, total: agent.use_ticks_total });
    } else hintNode = t('play.hint.onToilet');
  } else {
    hintNode = t('play.hint.default');
  }

  const menuItems = state && menu ? buildMenu(state, terrain, menu, offer) : [];
  const placementText =
    state?.placement === 'inside'
      ? t('play.placement.inside')
      : state?.placement === 'waiting'
        ? t('play.placement.waiting')
        : t('play.placement.out');

  const pips =
    agent && agent.use_ticks_total > 0
      ? Array.from({ length: agent.use_ticks_total }, (_, index) => (
          <i key={index} class={index < agent.use_ticks_done ? 'f' : undefined} />
        ))
      : [<span key="none" class="sub">—</span>];

  const stats =
    state && agent ? (
      <details class="pm-detail">
        <summary>{t('play.details')}</summary>
        <div class="pm-stats" data-testid="play-stats">
          <div class="kv">
            <span class="sub">{t('play.stat.pos')}</span>
            <span class="mono">{mePos ? `${mePos.x},${mePos.y}` : '—'}</span>
          </div>
          <div class="kv">
            <span class="sub">{t('play.stat.need')}</span>
            <span>{agent.need ? needLabel(agent.need) : t('play.none')}</span>
          </div>
          <div class="kv">
            <span class="sub">{t('play.stat.deadline')}</span>
            <span class="mono">
              {agent.deadline_tick > 0
                ? tn('play.deadline', Math.max(0, agent.deadline_tick - state.tick), { tick: agent.deadline_tick })
                : '—'}
            </span>
          </div>
          <div class="kv">
            <span class="sub">{t('play.stat.action')}</span>
            <span class="mono">
              {agent.action
                ? `${actionIn(lang, agent.action.description)} · ${tn('play.bar.left', agent.action.remaining)}`
                : t('play.none')}
            </span>
          </div>
          <div class="kv">
            <span class="sub">{t('play.stat.cooldown')}</span>
            <span class="mono">
              {`${untilText(agent.attack_cooldown_until, state.tick)} / ${untilText(agent.defend_cooldown_until, state.tick)}`}
            </span>
          </div>
          <div class="kv">
            <span class="sub">{t('play.stat.stun')}</span>
            <span class="mono">
              {`${untilText(agent.stun_until, state.tick)} / ${untilText(agent.immunity_until, state.tick)}`}
            </span>
          </div>
        </div>
      </details>
    ) : null;

  return (
    <>
      <div class="ui-clock play-clock">
        <div class="big" data-testid="play-tick">
          {t('top.turn', { n: state?.tick ?? '–' })}
        </div>
        <div class="countdown">
          {t('top.nextSettle')} <span data-testid="play-countdown">{play.countdown}</span>
        </div>
        <div class="play-placement" data-testid="play-placement">
          {placementText}
        </div>
      </div>

      <div class="ui-feed panel play-feed">
        <h3>{t('play.events')}</h3>
        {play.events.length === 0 ? (
          <div class="sub">{t('play.noEvents')}</div>
        ) : (
          <ol class="pm-events" data-testid="play-events">
            {play.events.slice(0, 3).map((event) => (
              <li key={`${event.tick}:${event.seq}`} class="pm-event">
                <span class="pm-event-tick">{t('top.turn', { n: event.tick })}</span> <span>{eventIn(lang, event.text)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {state && agent ? (
        <Card
          agent={selfCard(state, agent)}
          tick={state.tick}
          top3={top3}
          onVision={() => undefined}
          vision={false}
          play
          extra={stats}
        />
      ) : (
        <Card agent={null} tick={0} top3={top3} onVision={() => undefined} vision={false} play />
      )}

      {menu && state ? (
        <div class="panel play-menu" data-play-menu ref={menuRef}>
          <p class="play-menu-title">{describeCell(state, menu.cell)}</p>
          {menuItems.length === 0 ? <p class="sub">{t('play.noActions')}</p> : null}
          {menuItems.map((item) => (
            <button
              key={item.action.id}
              type="button"
              data-action={item.action.id}
              disabled={item.disabled || play.busy}
              title={item.reason ?? undefined}
              onClick={() => onMenuItem(item)}
            >
              {labelText(item.action.label)}
            </button>
          ))}
          {menuItems.some((item) => item.reason) ? (
            <p class="sub">{menuItems.find((item) => item.reason)?.reason}</p>
          ) : null}
        </div>
      ) : null}

      {inScene && !following ? (
        <button
          type="button"
          class="play-recenter"
          data-testid="play-recenter"
          onClick={() => {
            setFollow(true);
            frameOnSelf();
          }}
        >
          {t('play.recenter')}
        </button>
      ) : null}

      <div class="ui-bottom panel" data-mode="play">
        {state?.joined && agent ? (
          <div class="play-row">
            <div class="col play-need">
              <div class="kv">
                <b>
                  {agent.need
                    ? urgent
                      ? t('card.needUrgent', { need: needLabel(agent.need) })
                      : needLabel(agent.need)
                    : t('card.noNeed')}
                </b>
                <span class="sub">{agent.need ? tn('card.hold', remaining) : '—'}</span>
              </div>
              <div class="bar">
                <i style={{ width: `${agent.need ? fraction * 100 : 0}%`, background: meterColor(fraction) }} />
              </div>
            </div>
            <span class="sep" />
            <div class="col play-pips-col">
              <span class="sub">{t('card.progress', { done: agent.use_ticks_done, total: agent.use_ticks_total })}</span>
              <div class="pips">{pips}</div>
            </div>
            <span class="sep" />
            <div class="col play-doing">
              <span class="sub">{t('play.doing')}</span>
              <span
                class={`pm-pending pm-pending-${play.bar.tone}`}
                data-testid="play-pending"
                data-tone={play.bar.tone}
              >
                <b>{play.bar.title}</b>
                <span class="sub">{play.bar.detail}</span>
              </span>
            </div>
            <span class="sep" />
            <div class="play-actions">
              <button
                type="button"
                class="gold"
                data-testid="play-use"
                disabled={!offer || offer.reason !== null || play.busy}
                title={offer?.reason ? t(offer.reason) : undefined}
                onClick={() => {
                  if (offer) void submitAction(offer.action);
                }}
              >
                {t('play.act.use')}
              </button>
              <button type="button" data-testid="play-cancel" disabled={!agent.action || play.busy} onClick={cancel}>
                {t('play.cancel')}
              </button>
              <button type="button" data-testid="play-leave" disabled={play.busy} onClick={leave}>
                {t('play.leave')}
              </button>
            </div>
          </div>
        ) : null}
        <p class="sub play-hint" data-testid="play-hint">
          {hintNode}
        </p>
      </div>

      {createOpen ? (
        <Window title={t('play.createOpen')} windowKey="create" onClose={() => setCreateOpen(false)}>
          <form class="play-create" onSubmit={onCreate}>
            <label>
              <span class="sub">{t('play.nick')}</span>
              <input
                type="text"
                value={createNick}
                maxLength={16}
                autocomplete="off"
                onInput={(event) => setCreateNick((event.target as HTMLInputElement).value.toLowerCase())}
              />
            </label>
            <p class="sub">{t('play.nickRule')}</p>
            <div class="sw" role="radiogroup" aria-label={t('play.bodyColor')}>
              {Array.from({ length: CREATE_COLORS }, (_, index) => (
                <i
                  key={index}
                  role="radio"
                  aria-checked={index === createColor ? 'true' : 'false'}
                  aria-label={t('play.color', { n: index + 1 })}
                  class={index === createColor ? 'on' : undefined}
                  style={{ background: agentColor(index) }}
                  onClick={() => setCreateColor(index)}
                />
              ))}
            </div>
            <button type="submit" class="gold" data-testid="play-create" disabled={play.busy}>
              {t(play.busy ? 'play.creating' : 'play.create')}
            </button>
            {createError ? <p class="pm-notice">{msgText(createError)}</p> : null}
          </form>
        </Window>
      ) : null}
    </>
  );
}
