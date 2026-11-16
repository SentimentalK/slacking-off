import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playProjection, visionGrid } from '../src/play/frame.ts';

const W = 12;
const H = 10;
const WIN = { origin: { x: 0, y: 0 }, width: 9, height: 9 };

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

function state({ objects = [], agents = [], map }) {
  return {
    me: { agent_id: 1, nick: 'me', color: 0 },
    tick: 7, tick_seconds: 1, ms_to_next_tick: 0, joined: true, placement: 'inside',
    window: WIN,
    objects,
    agents,
    agent: null,
    map,
  };
}

const at = (list, x, y) => list.find((o) => o.pos.x === x && o.pos.y === y);

const FLAT = { width: W, height: H, entrance: { x: 0, y: 0 }, rows: Array.from({ length: H }, () => '.'.repeat(W)) };

function terrainWith(wild) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) row += wild(x, y) ? '~' : '.';
    rows.push(row);
  }
  return { width: W, height: H, entrance: { x: 0, y: 0 }, rows };
}

test('objects outside the window come only from memory', () => {
  const s = state({
    objects: [obj('toilet', 2, 2, { level: 2 }), obj('pillar', 11, 1)],
    agents: [playAgent(1, 4, 4)],
    map: memory((x, y) => {
      if (x === 10 && y === 0) return '#';
      if (x === 11 && y === 0) return 'x';
      if (x === 9 && y === 9) return '*';
      if (x === 11 && y === 8) return '3';
      if (x === 11 && y === 7) return "'";
      if (x === 11 && y === 6) return '+';
      if (x === 4 && y === 4) return '@';
      return '.';
    }),
  });
  const p = playProjection(s, 5, W, H, FLAT);
  assert.equal(p.world, 5);
  assert.equal(p.tick, 7);
  assert.equal(p.width, W);
  assert.equal(p.height, H);
  assert.equal(at(p.objects, 11, 1), undefined, 'out-of-window object from state.objects must not appear');
  assert.equal(at(p.objects, 2, 2).kind, 'toilet');
  assert.equal(at(p.objects, 2, 2).level, 2);
  assert.deepEqual(
    { kind: at(p.objects, 10, 0).kind, site: at(p.objects, 10, 0).site },
    { kind: 'wall', site: null },
  );
  const site = at(p.objects, 11, 0);
  assert.equal(site.kind, 'wall');
  assert.equal(site.site, 'wall');
  assert.equal(site.progress, 1);
  assert.equal(site.progress_total, 2);
  assert.equal(at(p.objects, 9, 9).kind, 'pillar');
  assert.equal(at(p.objects, 11, 8).kind, 'toilet');
  assert.equal(at(p.objects, 11, 8).level, 3);
  assert.equal(at(p.objects, 11, 7).kind, 'door');
  assert.equal(at(p.objects, 11, 7).open, true);
  assert.equal(at(p.objects, 11, 6).kind, 'door');
  assert.equal(at(p.objects, 11, 6).open, false);
  assert.equal(at(p.objects, 11, 9), undefined, 'unmapped remembered cell yields no object');
});

test('unseen wilderness outside the window is a wall, unseen floor stays empty', () => {
  const terrain = terrainWith((x, y) => (x === 10 && y === 0) || (x === 11 && y === 0) || (x === 10 && y === 1));
  const s = state({
    agents: [playAgent(1, 4, 4)],
    map: memory(
      (x, y) => {
        if (x === 10 && y === 0) return '?';
        if (x === 10 && y === 1) return '?';
        if (x === 11 && y === 9) return '?';
        return '.';
      },
      (x, y) => {
        if (x === 10 && y === 0) return 0;
        if (x === 11 && y === 9) return 0;
        if (x === 10 && y === 1) return 3;
        return 1;
      },
    ),
  });
  const p = playProjection(s, 5, W, H, terrain);
  assert.deepEqual(
    { kind: at(p.objects, 10, 0).kind, site: at(p.objects, 10, 0).site },
    { kind: 'wall', site: null },
    'unseen wilderness becomes a wall',
  );
  assert.equal(at(p.objects, 10, 1).kind, 'wall', 'a wilderness cell with an unknown glyph counts as unseen');
  assert.equal(at(p.objects, 11, 0), undefined, 'a remembered wilderness cell keeps its remembered glyph');
  assert.equal(at(p.objects, 11, 9), undefined, 'an unseen plain floor cell yields no object');
  assert.equal(at(p.objects, 9, 9), undefined, 'a remembered plain floor cell yields no object');
});

test('remembered character letters do not create agents', () => {
  const s = state({
    agents: [playAgent(1, 4, 4)],
    map: memory((x, y) => (x === 10 && y === 2 ? 'a' : '.')),
  });
  const p = playProjection(s, 5, W, H, FLAT);
  assert.deepEqual(p.agents.map((a) => a.id), [1]);
  assert.equal(p.agents[0].kind, 'ai');
  assert.equal(p.agents[0].sent_by, null);
  assert.equal(at(p.objects, 10, 2), undefined);
  assert.deepEqual(p.queue, []);
  assert.deepEqual(p.events, []);
  assert.deepEqual(p.counts, { inside: 0, queued: 0, capacity: 0, queue_capacity: 0 });
});

function sample(g, x, y) {
  return g.values[(y * g.scale + 2) * g.width * g.scale + x * g.scale + 2];
}

test('vision grid is 255 in the window and fades from the window edge to the memory or dark base', () => {
  const seen = new Set(['10,0', '12,0']);
  const s = state({
    agents: [playAgent(1, 4, 4)],
    map: memory(() => '.', (x, y) => (seen.has(`${x},${y}`) ? 3 : 0)),
  });
  const g = visionGrid(s, W, H);
  assert.equal(g.scale, 4);
  assert.equal(g.values.length, W * 4 * H * 4);
  assert.equal(sample(g, 0, 0), 255);
  assert.equal(sample(g, 8, 8), 255);
  const edge = sample(g, 9, 0);
  assert.ok(edge > 92 && edge < 255, `0.6 cells outside an unseen cell should be between 92 and 255, got ${edge}`);
  assert.equal(sample(g, 10, 0), 128, 'a remembered cell two cells out shows its base');
  assert.equal(sample(g, 11, 0), 92, 'an unseen cell two cells out shows its base');
});

test('memory indexes seen_at relative to the grid origin', () => {
  const map = {
    grid: { origin: { x: 2, y: 1 }, width: 2, height: 2, rows: ['..', '..'], legend: [] },
    seen_at: [[1, 0], [0, 0]],
  };
  const s = { ...state({ agents: [playAgent(1, 0, 0)], map }), window: { origin: { x: 0, y: 0 }, width: 1, height: 1 } };
  const g = visionGrid(s, W, H);
  assert.equal(sample(g, 2, 1), 128);
  assert.equal(sample(g, 3, 1), 92);
  assert.equal(sample(g, 2, 2), 92);
});

test('vision grid without map is dark outside the window', () => {
  const g = visionGrid(state({ agents: [playAgent(1, 4, 4)], map: null }), W, H);
  assert.equal(sample(g, 4, 4), 255);
  assert.equal(sample(g, 10, 0), 92);
  assert.equal(sample(g, 11, 5), 92);
});
