import type { PlayState, Pos, Projection, ProjectionAgent, ProjectionObject, Terrain } from '../types';
import type { VisionGrid } from '../world3d/types';

const VISIBLE = 255;
const MEMORY = 128;
const DARK = 77;
const SCALE = 4;
const FADE = 1.5;
const WILDERNESS = '~';
const KNOWN_MEMORY = /^[.:@#+'*x1-9a-z]$/;

function inWindow(state: PlayState, x: number, y: number): boolean {
  const w = state.window;
  return x >= w.origin.x && y >= w.origin.y && x < w.origin.x + w.width && y < w.origin.y + w.height;
}

function memoryAt(state: PlayState, x: number, y: number): { char: string; seenAt: number } {
  const grid = state.map?.grid;
  if (!grid) return { char: '?', seenAt: 0 };
  const row = y - grid.origin.y;
  const col = x - grid.origin.x;
  if (row < 0 || row >= grid.rows.length || col < 0 || col >= grid.rows[row].length) {
    return { char: '?', seenAt: 0 };
  }
  return { char: grid.rows[row][col], seenAt: state.map?.seen_at?.[row]?.[col] ?? 0 };
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

export function playProjection(
  state: PlayState,
  worldId: number,
  width: number,
  height: number,
  terrain: Terrain,
): Projection {
  const agents: ProjectionAgent[] = state.agents.map((a): ProjectionAgent => ({
    ...a,
    kind: 'ai',
    sent_by: null,
    level: 0,
    score_total: 0,
  }));
  const objects: ProjectionObject[] = state.objects.filter((o) => inWindow(state, o.pos.x, o.pos.y));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inWindow(state, x, y)) continue;
      const pos = { x, y };
      const { char, seenAt } = memoryAt(state, x, y);
      if (seenAt > 0 && KNOWN_MEMORY.test(char)) {
        const o = memoryObject(char, pos);
        if (o) objects.push(o);
      } else if (terrain.rows[y]?.[x] === WILDERNESS) {
        objects.push(memoryObject('#', pos)!);
      }
    }
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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function visionGrid(state: PlayState, width: number, height: number): VisionGrid {
  const w = width * SCALE;
  const h = height * SCALE;
  const values = new Uint8Array(w * h);
  const win = state.window;
  const x0 = win.origin.x;
  const y0 = win.origin.y;
  const x1 = x0 + win.width;
  const y1 = y0 + win.height;
  for (let py = 0; py < h; py++) {
    const y = (py + 0.5) / SCALE;
    const cy = Math.floor(y);
    for (let px = 0; px < w; px++) {
      const x = (px + 0.5) / SCALE;
      const cx = Math.floor(x);
      const d = Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, y0 - y, y - y1));
      if (d === 0) {
        values[py * w + px] = VISIBLE;
        continue;
      }
      const base = memoryAt(state, cx, cy).seenAt > 0 ? MEMORY : DARK;
      values[py * w + px] = Math.round(VISIBLE + (base - VISIBLE) * smoothstep(0, FADE, d));
    }
  }
  return { width, height, scale: SCALE, values };
}
