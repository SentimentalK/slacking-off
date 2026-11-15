import type { PlayState, Pos, Projection, ProjectionAgent, ProjectionObject } from '../types';
import type { VisionGrid } from '../world3d/types';

const VISIBLE = 255;
const MEMORY = 110;
const DARK = 30;

function inWindow(state: PlayState, x: number, y: number): boolean {
  const w = state.window;
  return x >= w.origin.x && y >= w.origin.y && x < w.origin.x + w.width && y < w.origin.y + w.height;
}

function memoryObject(c: string, pos: Pos): ProjectionObject | null {
  const plain = { pos, level: 0, open: false, progress: 0, progress_total: 0, site: null, crack: false };
  if (c === '#') return { ...plain, kind: 'wall' };
  if (c === '+') return { ...plain, kind: 'door' };
  if (c === "'") return { ...plain, kind: 'door', open: true };
  if (c >= '1' && c <= '9') return { ...plain, kind: 'toilet', level: Number(c) };
  if (c === 'x') return { ...plain, kind: 'wall', site: 'wall', progress: 1, progress_total: 2 };
  if (c === '*') return { ...plain, kind: 'pillar' };
  return null;
}

export function playProjection(state: PlayState, worldId: number, width: number, height: number): Projection {
  const agents: ProjectionAgent[] = state.agents.map((a): ProjectionAgent => ({
    ...a,
    kind: 'ai',
    sent_by: null,
    level: 0,
    score_total: 0,
  }));
  const objects: ProjectionObject[] = state.objects.filter((o) => inWindow(state, o.pos.x, o.pos.y));
  const grid = state.map?.grid;
  if (grid) {
    grid.rows.forEach((line, row) => {
      for (let col = 0; col < line.length; col++) {
        const pos = { x: grid.origin.x + col, y: grid.origin.y + row };
        if (inWindow(state, pos.x, pos.y)) continue;
        const o = memoryObject(line[col], pos);
        if (o) objects.push(o);
      }
    });
  }
  return {
    world: worldId,
    tick: state.tick,
    tick_seconds: state.tick_seconds,
    width,
    height,
    counts: { inside: 0, queued: 0, capacity: 0, queue_capacity: 0 },
    agents,
    objects,
    queue: [],
    events: [],
  };
}

export function visionGrid(state: PlayState, width: number, height: number): VisionGrid {
  const values = new Uint8Array(width * height);
  const seen = state.map?.seen_at;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (inWindow(state, x, y)) values[i] = VISIBLE;
      else if ((seen?.[y]?.[x] ?? 0) > 0) values[i] = MEMORY;
      else values[i] = DARK;
    }
  }
  return { width, height, values };
}
