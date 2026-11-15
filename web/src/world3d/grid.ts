import type { ProjectionObject, Pos, Terrain } from '../types';

export const MG = 8;

export function cellKey(x: number, y: number): string {
  return x + ',' + y;
}

export function cellAt(terrain: Terrain, x: number, y: number): string | null {
  if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) return null;
  return terrain.rows[y]?.[x] ?? null;
}

export function forEachCell(terrain: Terrain, fn: (x: number, y: number, c: string) => void): void {
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) fn(x, y, terrain.rows[y][x]);
  }
}

export function objectKeys(objects: ProjectionObject[]): Set<string> {
  const s = new Set<string>();
  for (const o of objects) s.add(cellKey(o.pos.x, o.pos.y));
  return s;
}

export function wallKeys(objects: ProjectionObject[]): Set<string> {
  const s = new Set<string>();
  for (const o of objects) if (o.kind === 'wall') s.add(cellKey(o.pos.x, o.pos.y));
  return s;
}

export function signature(keys: Set<string>): string {
  return [...keys].sort().join(';');
}

export function neighbours(p: Pos): Pos[] {
  return [
    { x: p.x + 1, y: p.y },
    { x: p.x - 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x, y: p.y - 1 },
  ];
}
