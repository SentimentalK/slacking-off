// Pure play-page rules: which menu entries a clicked cell may offer, and which
// key means which direction. The server is still the final judge; this module
// only hides actions the cell obviously cannot take (coordinator addendum 1).

import { t } from '../i18n';
import type { Key } from '../i18n';
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

export interface ActionLabel {
  key: Key;
  vars?: Record<string, string | number>;
}

export function labelText(label: ActionLabel): string {
  return t(label.key, label.vars);
}

export type PlayAction =
  | { id: 'move'; label: ActionLabel; kind: 'move'; dir: Dir }
  | { id: 'path'; label: ActionLabel; kind: 'path'; path: string }
  | { id: string; label: ActionLabel; kind: 'build'; build: BuildKind; target: TargetSpec }
  | { id: string; label: ActionLabel; kind: 'demolish'; target: TargetSpec }
  | { id: string; label: ActionLabel; kind: 'door'; target: Dir; open: boolean }
  | { id: string; label: ActionLabel; kind: 'attack'; dir: Dir }
  | { id: string; label: ActionLabel; kind: 'defend'; dir: Dir }
  | { id: string; label: ActionLabel; kind: 'upgrade'; target: TargetSpec }
  | { id: string; label: ActionLabel; kind: 'downgrade'; target: TargetSpec }
  | { id: string; label: ActionLabel; kind: 'use' };

/**
 * The keyboard and d-pad step: one cardinal move, submitted through the same
 * `submit` path as a clicked menu entry so both share one pending/error track.
 */
export function moveAction(dir: Dir): PlayAction {
  return { id: 'move', label: { key: 'play.act.move', vars: { dir } }, kind: 'move', dir };
}

const BUILD_LABEL: Record<BuildKind, Key> = {
  wall: 'play.act.buildWall',
  door: 'play.act.buildDoor',
  toilet: 'play.act.buildToilet',
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
          label: { key: BUILD_LABEL[build] },
          build,
          target,
        });
      }
    }
    if (object?.site) {
      actions.push({ id: 'demolish', kind: 'demolish', label: { key: 'play.act.demolish' }, target });
    }
  } else {
    // Every finished object can be demolished, toilets included (design
    // §4.6/§4.7).
    actions.push({ id: 'demolish', kind: 'demolish', label: { key: 'play.act.demolish' }, target });
    if (object.kind === 'door') {
      actions.push({
        id: object.open ? 'door-close' : 'door-open',
        kind: 'door',
        label: { key: object.open ? 'play.act.closeDoor' : 'play.act.openDoor' },
        target: dir,
        open: !object.open,
      });
    }
    if (object.kind === 'toilet') {
      // Working a toilet up needs at least the target level (design §4.7).
      if (agent && object.level < TOILET_MAX_LEVEL && agent.level >= object.level + 1) {
        actions.push({ id: 'upgrade', kind: 'upgrade', label: { key: 'play.act.upgrade' }, target });
      }
      if (object.level > 1) {
        actions.push({ id: 'downgrade', kind: 'downgrade', label: { key: 'play.act.downgrade' }, target });
      }
    }
  }

  if (occupant) {
    actions.push({ id: 'attack', kind: 'attack', label: { key: 'play.act.attack' }, dir });
  }
  if (!agent || state.tick >= agent.defend_cooldown_until) {
    actions.push({ id: 'defend', kind: 'defend', label: { key: 'play.act.defend' }, dir });
  }
  return actions;
}

/** The use button: only while standing on a toilet. */
export interface UseOffer {
  action: PlayAction;
  reason: Key | null;
}

export function useOffer(state: PlayState): UseOffer | null {
  const me = ownPos(state);
  if (!me || !canAct(state, state.agent)) return null;
  const here = objectAt(state, me);
  if (!here || here.kind !== 'toilet' || here.site) return null;
  const action: PlayAction = { id: 'use', kind: 'use', label: { key: 'play.act.use' } };
  if (!state.agent?.need) return { action, reason: 'play.reason.noNeed' };
  if (state.agent.action) return { action, reason: 'play.reason.busy' };
  return { action, reason: null };
}

/** Human-readable state of a target cell, shown above its menu. */
export function describeCell(state: PlayState, cell: Pos): string {
  const object = objectAt(state, cell);
  const agent = agentAt(state, cell);
  const parts: string[] = [];
  if (agent) parts.push(agent.nick);
  if (object) {
    if (object.site) parts.push(t('play.cell.site', { kind: object.site }));
    else if (object.kind === 'wall') parts.push(t('play.cell.wall'));
    else if (object.kind === 'door') parts.push(t(object.open ? 'play.cell.doorOpen' : 'play.cell.doorClosed'));
    else parts.push(t('play.cell.toilet', { level: object.level }));
  }
  return parts.length > 0 ? parts.join(' · ') : t('play.cell.empty');
}

/** Cells adjacent to `origin` inside the window, for keyboard/adjacency tests. */
export function isReachable(state: PlayState, cell: Pos): boolean {
  const me = ownPos(state);
  if (!me) return false;
  return Math.abs(me.x - cell.x) + Math.abs(me.y - cell.y) <= 1;
}
