import * as THREE from 'three';
import type { ProjectionObject, Terrain } from '../types';
import { MG, cellKey, forEachCell, objectKeys, signature } from './grid';
import { Instancer } from './instancer';
import { FOREST_MG } from './forest';
import { GRASS_COLORS, GRASS_PARTS } from './models';
import { rand01, SeededRandom } from './rng';
import type { Layer, SceneCtx } from './types';

const PI = Math.PI;
const BLADES = 30;
const BLADE_HEIGHT = 1.5;
const GRASS_SALT = 200;
const GRASS_SAT = 0.92;
const GRASS_VALUE_MIN = 0.72;
const GRASS_VALUE_SPAN = 0.45;
const PATCH_AREA = (18 + 2 * MG) * (12 + 2 * MG);
const PATCH_COUNT = 840;
const PATCH_COLORS = ['rgba(58,84,34,0.275)', 'rgba(96,128,48,0.231)', 'rgba(72,104,38,0.275)', 'rgba(110,138,56,0.165)', 'rgba(52,70,30,0.248)'];
const WILD_COLORS = ['rgba(30,40,16,0.5)', 'rgba(78,66,40,0.35)'];
const DIRT_SPOTS = ['rgba(60,44,30,0.5)', 'rgba(160,128,100,0.5)', 'rgba(74,102,41,0.6)'];
const PATH_BLOBS = ['#82604a', '#8e6b54', '#7a5a40'];
const PATH_CORE = '#6f5138';
const PATH_EDGE_GRASS = 'rgba(88,122,46,0.85)';
const FLOOR_HEX = 0x2c3a1c;

const textures = new WeakMap<Terrain, Map<string, THREE.CanvasTexture>>();

function groundTexture(terrain: Terrain, worldId: number, ts: number): THREE.CanvasTexture {
  let perTerrain = textures.get(terrain);
  if (!perTerrain) {
    perTerrain = new Map();
    textures.set(terrain, perTerrain);
  }
  const key = worldId + ':' + ts;
  const hit = perTerrain.get(key);
  if (hit) return hit;
  const tex = paintGround(terrain, worldId, ts);
  perTerrain.set(key, tex);
  return tex;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function paintGround(terrain: Terrain, worldId: number, TS: number): THREE.CanvasTexture {
  const GW = terrain.width + 2 * FOREST_MG;
  const GH = terrain.height + 2 * FOREST_MG;
  const c = document.createElement('canvas');
  c.width = GW * TS;
  c.height = GH * TS;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  const rng = new SeededRandom(worldId * 7919 + 1);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng.next() * a.length)];
  const s = TS / 48;
  const X = (x: number) => (x + FOREST_MG) * TS;
  const Z = (z: number) => (z + FOREST_MG) * TS;
  const ellipse = (x: number, y: number, rx: number, ry: number, rot: number) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot, 0, 7);
    g.fill();
  };

  g.fillStyle = '#4a6629';
  g.fillRect(0, 0, c.width, c.height);
  const patches = Math.round((PATCH_COUNT * GW * GH) / PATCH_AREA);
  for (let i = 0; i < patches; i++) {
    g.fillStyle = pick(PATCH_COLORS);
    ellipse(rng.next() * c.width, rng.next() * c.height, (11.25 + rng.next() * 36) * s, (8.1 + rng.next() * 24.75) * s, rng.next() * 3);
  }

  const ey = terrain.entrance.y;

  const road: Array<{ x: number; y: number }> = [];
  forEachCell(terrain, (x, y, ch) => {
    if (ch === ':') road.push({ x, y });
    if (ch !== '~') return;
    g.fillStyle = '#3b4a24';
    g.fillRect(X(x), Z(y), TS, TS);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = pick(WILD_COLORS);
      ellipse(X(x) + rng.next() * TS, Z(y) + rng.next() * TS, (3 + rng.next() * 6) * s, (3 + rng.next() * 5) * s, rng.next() * 3);
    }
  });
  for (let x = -MG; x <= 0; x++) {
    road.push({ x, y: ey }, { x, y: ey + 1 });
  }

  const edge = document.createElement('canvas');
  edge.width = c.width;
  edge.height = c.height;
  const eg = edge.getContext('2d');
  if (!eg) throw new Error('2d canvas context unavailable');
  eg.fillStyle = 'rgb(88,70,44)';
  for (const p of road) {
    roundRect(eg, X(p.x) - 0.16 * TS, Z(p.y) - 0.16 * TS, 1.32 * TS, 1.32 * TS, 0.35 * TS);
    eg.fill();
  }
  g.globalAlpha = 0.55;
  g.drawImage(edge, 0, 0);
  g.globalAlpha = 1;

  g.fillStyle = PATH_CORE;
  for (const p of road) {
    roundRect(g, X(p.x) - 0.04 * TS, Z(p.y) - 0.04 * TS, 1.08 * TS, 1.08 * TS, 0.35 * TS);
    g.fill();
  }

  for (const p of road) {
    for (let i = 0; i < 14; i++) {
      g.fillStyle = pick(PATH_BLOBS);
      const rx = (0.08 + rng.next() * 0.12) * TS;
      ellipse(X(p.x) + rng.next() * TS, Z(p.y) + rng.next() * TS, rx, rx * (0.6 + rng.next() * 0.4), rng.next() * 3);
    }
  }

  for (const p of road) {
    for (let i = 0; i < 5; i++) {
      g.fillStyle = pick(DIRT_SPOTS);
      ellipse(X(p.x + rng.next()), Z(p.y + rng.next()), (2 + rng.next() * 7) * s, (2 + rng.next() * 5) * s, rng.next() * 3);
    }
  }

  for (const p of road) {
    const n = Math.floor(rng.next() * 4);
    for (let i = 0; i < n; i++) {
      g.fillStyle = PATH_EDGE_GRASS;
      const side = Math.floor(rng.next() * 4);
      const t = rng.next();
      let px: number;
      let py: number;
      if (side === 0) {
        px = X(p.x) + t * TS;
        py = Z(p.y) - 0.16 * TS;
      } else if (side === 1) {
        px = X(p.x) + t * TS;
        py = Z(p.y) + 1.16 * TS;
      } else if (side === 2) {
        px = X(p.x) - 0.16 * TS;
        py = Z(p.y) + t * TS;
      } else {
        px = X(p.x) + 1.16 * TS;
        py = Z(p.y) + t * TS;
      }
      const rad = (0.05 + rng.next() * 0.07) * TS;
      ellipse(px, py, rad, rad * 0.7, rng.next() * 3);
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function grassLayer(ctx: SceneCtx, root: THREE.Group): { inst: Instancer; cells: Array<{ x: number; y: number }> } {
  const cells: Array<{ x: number; y: number }> = [];
  forEachCell(ctx.terrain, (x, y, ch) => {
    if (ch === '.') cells.push({ x, y });
  });
  const inst = new Instancer(GRASS_PARTS, cells.length * BLADES, root);
  const mesh = inst.meshes[0];
  cells.forEach((cell, ci) => {
    for (let b = 0; b < BLADES; b++) {
      const i = ci * BLADES + b;
      const r = (k: number) => rand01(ctx.worldId, cell.x, cell.y, GRASS_SALT + b * 9 + k);
      const sc = 0.6 + r(5) * 0.9;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(cell.x + r(0), 0, cell.y + r(1)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((r(2) - 0.5) * 0.7, r(3) * 6, (r(4) - 0.5) * 0.7)),
        new THREE.Vector3(sc, sc * (0.7 + r(6) * 0.8) * BLADE_HEIGHT, sc),
      );
      inst.set(i, [m]);
      const color = new THREE.Color(GRASS_COLORS[Math.floor(r(7) * GRASS_COLORS.length)]);
      const hsl = color.getHSL({ h: 0, s: 0, l: 0 });
      color.setHSL(hsl.h, hsl.s * GRASS_SAT, hsl.l * (GRASS_VALUE_MIN + r(8) * GRASS_VALUE_SPAN));
      mesh.setColorAt(i, color);
    }
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return { inst, cells };
}

function blockedCells(objects: ProjectionObject[]): Set<string> {
  const blocked = objectKeys(objects);
  for (const o of objects) {
    if (o.kind !== 'toilet') continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) blocked.add(cellKey(o.pos.x + dx, o.pos.y + dy));
    }
  }
  return blocked;
}

export function createGround(ctx: SceneCtx): Layer {
  const { terrain, worldId, quality, world } = ctx;
  const root = new THREE.Group();
  world.add(root);
  const TS = quality === 'low' ? 24 : 48;
  const GW = terrain.width + 2 * FOREST_MG;
  const GH = terrain.height + 2 * FOREST_MG;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(terrain.width + 80, terrain.height + 80),
    new THREE.MeshStandardMaterial({ color: FLOOR_HEX, roughness: 1 }),
  );
  floor.rotation.x = -PI / 2;
  floor.position.set(terrain.width / 2, 0, terrain.height / 2);
  floor.receiveShadow = true;
  root.add(floor);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(GW, GH),
    new THREE.MeshStandardMaterial({
      map: groundTexture(terrain, worldId, TS),
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  plane.rotation.x = -PI / 2;
  plane.position.set(terrain.width / 2, 0.002, terrain.height / 2);
  plane.receiveShadow = true;
  root.add(plane);

  const grass = quality === 'high' ? grassLayer(ctx, root) : null;
  let sig: string | null = null;

  return {
    update(input) {
      if (!grass) return;
      const blocked = blockedCells(input.cur.objects);
      const s = signature(blocked);
      if (s === sig) return;
      sig = s;
      grass.cells.forEach((cell, ci) => {
        const on = !blocked.has(cellKey(cell.x, cell.y));
        for (let b = 0; b < BLADES; b++) grass.inst.show(ci * BLADES + b, on);
      });
      grass.inst.flush();
    },
    dispose() {
      grass?.inst.remove();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      plane.geometry.dispose();
      (plane.material as THREE.Material).dispose();
      root.removeFromParent();
    },
  };
}
