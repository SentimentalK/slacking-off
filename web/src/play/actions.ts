// Pure play-page rules: which menu entries a clicked cell may offer, and which
// key means which direction. The server is still the final judge; this module
// only hides actions the cell obviously cannot take (coordinator addendum 1).

import type {
  AgentView,
  BuildKind,
  Dir,
  PlayAgent,
  PlayState,
  Pos,
  ProjectionObject,
  TargetSpec,
  Terrain,
} from '../types';

/** `Nick` (contract §3): the server decides, the page only hints. */
export const NICK_RE = /^[a-z0-9-]{2,16}$/;

export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];

/** Tile-space delta of each direction. */
export const DIR_DELTA: Record<Dir, Pos> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

/** The eight movement keys: arrows plus WASD, one cardinal direction each. */
export const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'N',
  ArrowDown: 'S',
  ArrowLeft: 'W',
  ArrowRight: 'E',
  w: 'N',
  s: 'S',
  a: 'W',
  d: 'E',
};

export type PlayAction =
  | { id: 'move'; label: string; kind: 'move'; dir: Dir }
  | { id: string; label: string; kind: 'build'; build: BuildKind; target: TargetSpec }
  | { id: string; label: string; kind: 'demolish'; target: TargetSpec }
  | { id: string; label: string; kind: 'door'; target: Dir; open: boolean }
  | { id: string; label: string; kind: 'attack'; dir: Dir }
  | { id: string; label: string; kind: 'defend'; dir: Dir }
  | { id: string; label: string; kind: 'upgrade'; target: TargetSpec }
  | { id: string; label: string; kind: 'downgrade'; target: TargetSpec }
  | { id: string; label: string; kind: 'use' };

/**
 * The keyboard and d-pad step: one cardinal move, submitted through the same
 * `submit` path as a clicked menu entry so both share one pending/error track.
 */
export function moveAction(dir: Dir): PlayAction {
  return { id: 'move', label: `移动 ${dir}`, kind: 'move', dir };
}

const BUILD_LABEL: Record<BuildKind, string> = {
  wall: '建墙',
  door: '建门',
  toilet: '建马桶',
};

const TOILET_MAX_LEVEL = 5;

export function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

/** The caller's own body in the window, if it is standing anywhere. */
export function ownAgent(state: PlayState): PlayAgent | null {
  return state.agents.find((agent) => agent.id === state.me.agent_id) ?? null;
}

/** The caller's own position, from the window body or the status view. */
export function ownPos(state: PlayState): Pos | null {
  return ownAgent(state)?.pos ?? state.agent?.pos ?? null;
}

/** One step between two cells, or `null` when they are not neighbours. */
export function dirBetween(from: Pos, to: Pos): Dir | null {
  for (const dir of DIRS) {
    const delta = DIR_DELTA[dir];
    if (from.x + delta.x === to.x && from.y + delta.y === to.y) return dir;
  }
  return null;
}

export function objectAt(state: PlayState, pos: Pos): ProjectionObject | null {
  return state.objects.find((object) => samePos(object.pos, pos)) ?? null;
}

export function agentAt(state: PlayState, pos: Pos): PlayAgent | null {
  return state.agents.find((agent) => samePos(agent.pos, pos)) ?? null;
}

/** A stunned or benched player has no menu; the board still shows the world. */
function canAct(state: PlayState, agent: AgentView | null): boolean {
  if (state.placement !== 'inside') return false;
  return !agent || state.tick >= agent.stun_until;
}

/**
 * Actions a clicked neighbour may offer. The caller's own cell gets none (the
 * use button lives in the status panel), non-neighbours get none, and objects
 * only expose the verbs their kind supports.
 *
 * `terrain` is the loaded `GET /api/terrain`; `null` (still loading) falls
 * back to the terrain-blind menu.
 */
export function menuFor(
  state: PlayState,
  cell: Pos,
  terrain: Terrain | null = null,
): PlayAction[] {
  const me = ownPos(state);
  const agent = state.agent;
  if (!me || !canAct(state, agent)) return [];
  const dir = dirBetween(me, cell);
  if (!dir) return [];

  const target: TargetSpec = { dir };
  const object = objectAt(state, cell);
  const occupant = agentAt(state, cell);
  const noBuild = terrain?.rows[cell.y]?.[cell.x] === ':';
  const actions: PlayAction[] = [];

  if (!object || object.site) {
    // An unfinished site can only be worked further with the same material.
    const builds: BuildKind[] = object?.site ? [object.site] : ['wall', 'door', 'toilet'];
    if (!noBuild) {
      for (const build of builds) {
        // A body on the cell blocks wall and door foundations (design §4.2);
        // a toilet needs no empty cell, so it stays offerable.
        if (occupant && build !== 'toilet') continue;
        actions.push({
          id: `build-${build}`,
          kind: 'build',
          label: BUILD_LABEL[build],
          build,
          target,
        });
      }
    }
    if (object?.site) {
      actions.push({ id: 'demolish', kind: 'demolish', label: '拆', target });
    }
  } else {
    // Every finished object can be demolished, toilets included (design
    // §4.6/§4.7).
    actions.push({ id: 'demolish', kind: 'demolish', label: '拆', target });
    if (object.kind === 'door') {
      actions.push({
        id: object.open ? 'door-close' : 'door-open',
        kind: 'door',
        label: object.open ? '关门' : '开门',
        target: dir,
        open: !object.open,
      });
    }
    if (object.kind === 'toilet') {
      // Working a toilet up needs at least the target level (design §4.7).
      if (agent && object.level < TOILET_MAX_LEVEL && agent.level >= object.level + 1) {
        actions.push({ id: 'upgrade', kind: 'upgrade', label: '升级', target });
      }
      if (object.level > 1) {
        actions.push({ id: 'downgrade', kind: 'downgrade', label: '降级', target });
      }
    }
  }

  if (occupant) {
    actions.push({ id: 'attack', kind: 'attack', label: '打', dir });
  }
  if (!agent || state.tick >= agent.defend_cooldown_until) {
    actions.push({ id: 'defend', kind: 'defend', label: '防御', dir });
  }
  return actions;
}

/** The use button: only while standing on a toilet. */
export interface UseOffer {
  action: PlayAction;
  /** `null` when usable, otherwise why the page keeps it disabled. */
  reason: string | null;
}

export function useOffer(state: PlayState): UseOffer | null {
  const me = ownPos(state);
  if (!me || !canAct(state, state.agent)) return null;
  const here = objectAt(state, me);
  if (!here || here.kind !== 'toilet' || here.site) return null;
  const action: PlayAction = { id: 'use', kind: 'use', label: '使用' };
  if (!state.agent?.need) return { action, reason: '现在没有需求' };
  if (state.agent.action) return { action, reason: '动作进行中' };
  return { action, reason: null };
}

/** Human-readable state of a target cell, shown above its menu. */
export function describeCell(state: PlayState, cell: Pos): string {
  const object = objectAt(state, cell);
  const agent = agentAt(state, cell);
  const parts: string[] = [];
  if (agent) parts.push(agent.nick);
  if (object) {
    if (object.site) parts.push(`${object.site} 工地`);
    else if (object.kind === 'wall') parts.push('墙');
    else if (object.kind === 'door') parts.push(object.open ? '开着门' : '关着门');
    else parts.push(`马桶 L${object.level}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '空地';
}

/** Cells adjacent to `origin` inside the window, for keyboard/adjacency tests. */
export function isReachable(state: PlayState, cell: Pos): boolean {
  const me = ownPos(state);
  if (!me) return false;
  return Math.abs(me.x - cell.x) + Math.abs(me.y - cell.y) <= 1;
}
