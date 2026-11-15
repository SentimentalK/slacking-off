import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from '../src/play/path.ts';

const W = 12;
const H = 10;
const WIN = { origin: { x: 0, y: 0 }, width: 9, height: 9 };
const inWin = (x, y) => x >= 0 && y >= 0 && x < 9 && y < 9;

function playAgent(id, x, y) {
  return {
    id, nick: `n${id}`, color: 0, session_id: 1, pos: { x, y }, pose: 'idle', facing: 'N', need: null,
    use_done: 0, use_total: 0, deadline_tick: 0, defending: null, stun_until: 0, immunity_until: 0,
    action_target: null, attack_land_tick: null, recovery_deadline: null, urgent: false,
  };
}

function obj(kind, x, y, extra = {}) {
  return { pos: { x, y }, kind, level: 0, open: false, progress: 0, progress_total: 0, site: null, crack: false, ...extra };
}

function memory(charAt, seenAt = () => 1) {
  const rows = [];
  const seen_at = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    const s = [];
    for (let x = 0; x < W; x++) {
      row += charAt(x, y);
      s.push(seenAt(x, y));
    }
    rows.push(row);
    seen_at.push(s);
  }
  return { grid: { origin: { x: 0, y: 0 }, width: W, height: H, rows, legend: [] }, seen_at };
}

function state({ me = { x: 4, y: 4 }, objects = [], others = [], map }) {
  return {
    me: { agent_id: 1, nick: 'me', color: 0 },
    tick: 7, tick_seconds: 1, ms_to_next_tick: 0, joined: true, placement: 'inside',
    window: WIN,
    objects,
    agents: [playAgent(1, me.x, me.y), ...others],
    agent: {
      agent_id: 1, nick: 'me', tick: 7, session_id: 1, placement: 'inside', pos: me, queue_ahead: null, action: null,
      need: null, use_ticks_done: 0, use_ticks_total: 0, deadline_tick: 0, recovery_deadline: null, score: 0,
      outcome: null, score_total: 0, level: 0, stun_until: 0, immunity_until: 0, attack_cooldown_until: 0,
      defend_cooldown_until: 0, defending: null,
    },
    map,
  };
}

function cellsOf(start, path) {
  const cells = [{ ...start }];
  let { x, y } = start;
  for (const c of path) {
    if (c === 'N') y -= 1;
    else if (c === 'S') y += 1;
    else if (c === 'E') x += 1;
    else x -= 1;
    cells.push({ x, y });
  }
  return cells;
}

function allCellsKnown(s, cells) {
  return cells.every(({ x, y }) => inWin(x, y) || s.map.seen_at[y][x] > 0);
}

const WALL_LINE = (except) => {
  const out = [];
  for (let y = 0; y < 9; y++) {
    if (y === except) continue;
    out.push(obj('wall', 6, y));
  }
  return out;
};

test('path only crosses window or remembered cells', () => {
  const s = state({ map: memory(() => '.') });
  const path = findPath(s, W, H, { x: 11, y: 4 });
  assert.equal(path, 'EEEEEEE');
  assert.ok(allCellsKnown(s, cellsOf(s.agent.pos, path)));
});

test('unseen cells are avoided even when they are on the short route', () => {
  const s = state({
    map: memory(
      (x, y) => (y === 4 && (x === 9 || x === 10) ? '?' : '.'),
      (x, y) => (y === 4 && (x === 9 || x === 10) ? 0 : 1),
    ),
  });
  const path = findPath(s, W, H, { x: 11, y: 4 });
  assert.notEqual(path, null);
  assert.notEqual(path, 'EEEEEEE');
  const cells = cellsOf(s.agent.pos, path);
  assert.ok(allCellsKnown(s, cells));
  assert.ok(!cells.some(({ x, y }) => y === 4 && (x === 9 || x === 10)));
  assert.deepEqual(cells[cells.length - 1], { x: 11, y: 4 });
});

test('unseen target is unreachable', () => {
  const s = state({
    map: memory(
      (x, y) => (x === 10 && y === 4 ? '?' : '.'),
      (x, y) => (x === 10 && y === 4 ? 0 : 1),
    ),
  });
  assert.equal(findPath(s, W, H, { x: 10, y: 4 }), null);
});

test('another character in the only gap blocks the route', () => {
  const walls = [...WALL_LINE(4)];
  const outside = memory(() => '#');
  const blocked = state({ objects: walls, others: [playAgent(2, 6, 4)], map: outside });
  assert.equal(findPath(blocked, W, H, { x: 8, y: 4 }), null);
  const free = state({ objects: walls, map: outside });
  assert.equal(findPath(free, W, H, { x: 8, y: 4 }), 'EEEE');
});

test('open doors pass and closed doors block, both in window and in memory', () => {
  const outside = memory((x, y) => (x === 9 && y === 4 ? '+' : '#'));
  const closed = state({ objects: [...WALL_LINE(4), obj('door', 6, 4)], map: outside });
  assert.equal(findPath(closed, W, H, { x: 8, y: 4 }), null);
  const open = state({ objects: [...WALL_LINE(4), obj('door', 6, 4, { open: true })], map: outside });
  assert.equal(findPath(open, W, H, { x: 8, y: 4 }), 'EEEE');
  const wallWithDoor = (door) => (x, y) => (x === 9 ? (y === 4 ? door : '#') : '.');
  const memClosed = state({ map: memory(wallWithDoor('+')) });
  assert.equal(findPath(memClosed, W, H, { x: 10, y: 4 }), null);
  const memOpen = state({ map: memory(wallWithDoor("'")) });
  assert.equal(findPath(memOpen, W, H, { x: 10, y: 4 }), 'EEEEEE');
});

test('target equal to own cell returns empty path', () => {
  const s = state({ map: memory(() => '.') });
  assert.equal(findPath(s, W, H, { x: 4, y: 4 }), '');
});
