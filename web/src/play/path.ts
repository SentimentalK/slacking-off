import type { PlayState, Pos } from '../types';

const MAX_STEPS = 200;
const WALKABLE_MEMORY = ".:'@123456789";
const STEPS = [
  { dir: 'N', dx: 0, dy: -1 },
  { dir: 'E', dx: 1, dy: 0 },
  { dir: 'S', dx: 0, dy: 1 },
  { dir: 'W', dx: -1, dy: 0 },
];

function inWindow(state: PlayState, x: number, y: number): boolean {
  const w = state.window;
  return x >= w.origin.x && y >= w.origin.y && x < w.origin.x + w.width && y < w.origin.y + w.height;
}

function memoryChar(state: PlayState, x: number, y: number): string | null {
  const grid = state.map?.grid;
  if (!grid) return null;
  const row = y - grid.origin.y;
  const col = x - grid.origin.x;
  if (row < 0 || row >= grid.rows.length) return null;
  if (col < 0 || col >= grid.rows[row].length) return null;
  return grid.rows[row][col];
}

function walkable(state: PlayState, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  if (inWindow(state, x, y)) {
    if (state.agents.some((a) => a.id !== state.me.agent_id && a.pos.x === x && a.pos.y === y)) return false;
    const o = state.objects.find((obj) => obj.pos.x === x && obj.pos.y === y);
    if (!o) return true;
    if (o.site !== null) return false;
    if (o.kind === 'door') return o.open;
    return o.kind === 'toilet';
  }
  const c = memoryChar(state, x, y);
  return c !== null && WALKABLE_MEMORY.includes(c);
}

export function findPath(state: PlayState, width: number, height: number, target: Pos): string | null {
  const start = state.agent?.pos;
  if (!start) return null;
  if (start.x === target.x && start.y === target.y) return '';
  if (!walkable(state, width, height, target.x, target.y)) return null;

  const n = width * height;
  const from = new Int8Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const s = start.y * width + start.x;
  const t = target.y * width + target.x;
  const queue: number[] = [s];
  seen[s] = 1;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const cx = cur % width;
    const cy = Math.floor(cur / width);
    for (let d = 0; d < STEPS.length; d++) {
      const nx = cx + STEPS[d].dx;
      const ny = cy + STEPS[d].dy;
      if (!walkable(state, width, height, nx, ny)) continue;
      const idx = ny * width + nx;
      if (seen[idx]) continue;
      seen[idx] = 1;
      from[idx] = d;
      prev[idx] = cur;
      if (idx === t) {
        let path = '';
        for (let at = t; at !== s; at = prev[at]) path = STEPS[from[at]].dir + path;
        return path.length > MAX_STEPS ? null : path;
      }
      queue.push(idx);
    }
  }
  return null;
}
