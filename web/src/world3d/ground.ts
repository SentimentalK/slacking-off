import * as THREE from 'three';
import type { Terrain } from '../types';
import { MG, cellKey, forEachCell, objectKeys, signature } from './grid';
import { Instancer } from './instancer';
import { GRASS_COLORS, GRASS_PARTS } from './models';
import { rand01, SeededRandom } from './rng';
import type { Layer, SceneCtx } from './types';

const PI = Math.PI;
const BLADES = 22;
const GRASS_SALT = 200;
const PATCH_AREA = (18 + 2 * MG) * (12 + 2 * MG);
const PATCH_COUNT = 420;
const PATCH_COLORS = ['rgba(58,84,34,0.5)', 'rgba(96,128,48,0.42)', 'rgba(72,104,38,0.5)', 'rgba(110,138,56,0.3)', 'rgba(52,70,30,0.45)'];
const WILD_COLORS = ['rgba(30,40,16,0.5)', 'rgba(78,66,40,0.35)'];
const DIRT_SPOTS = ['rgba(60,44,30,0.5)', 'rgba(160,128,100,0.5)', 'rgba(74,102,41,0.6)'];

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

function paintGround(terrain: Terrain, worldId: number, TS: number): THREE.CanvasTexture {
  const GW = terrain.width + 2 * MG;
  const GH = terrain.height + 2 * MG;
  const c = document.createElement('canvas');
  c.width = GW * TS;
  c.height = GH * TS;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  const rng = new SeededRandom(worldId * 7919 + 1);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng.next() * a.length)];
  const s = TS / 48;
  const X = (x: number) => (x + MG) * TS;
  const Z = (z: number) => (z + MG) * TS;

  g.fillStyle = '#4a6629';
  g.fillRect(0, 0, c.width, c.height);
  const patches = Math.round((PATCH_COUNT * GW * GH) / PATCH_AREA);
  for (let i = 0; i < patches; i++) {
    g.fillStyle = pick(PATCH_COLORS);
    g.beginPath();
    g.ellipse(rng.next() * c.width, rng.next() * c.height, (25 + rng.next() * 80) * s, (18 + rng.next() * 55) * s, rng.next() * 3, 0, 7);
    g.fill();
  }

  const path = new Set<string>();
  forEachCell(terrain, (x, y, ch) => {
    if (ch === ':') path.add(cellKey(x, y));
  });

  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '~') return;
    g.fillStyle = '#3b4a24';
    g.fillRect(X(x), Z(y), TS, TS);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = pick(WILD_COLORS);
      g.beginPath();
      g.ellipse(X(x) + rng.next() * TS, Z(y) + rng.next() * TS, (3 + rng.next() * 6) * s, (3 + rng.next() * 5) * s, rng.next() * 3, 0, 7);
      g.fill();
    }
  });

  g.lineCap = 'round';
  g.lineJoin = 'round';
  const stroke = (colr: string, wd: number) => {
    g.strokeStyle = colr;
    g.lineWidth = wd;
    for (const k of path) {
      const [x, z] = k.split(',').map(Number);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        if (path.has(cellKey(x + dx, z + dz))) {
          g.beginPath();
          g.moveTo(X(x + 0.5), Z(z + 0.5));
          g.lineTo(X(x + dx + 0.5), Z(z + dz + 0.5));
          g.stroke();
        }
      }
    }
  };
  stroke('rgba(88,70,44,0.55)', TS * 1.25);
  stroke('#6f5138', TS * 0.98);
  stroke('#82604a', TS * 0.74);
  stroke('#8e6b54', TS * 0.4);
  for (const k of path) {
    const [x, z] = k.split(',').map(Number);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = pick(DIRT_SPOTS);
      g.beginPath();
      g.ellipse(X(x + rng.next()), Z(z + rng.next()), (2 + rng.next() * 7) * s, (2 + rng.next() * 5) * s, rng.next() * 3, 0, 7);
      g.fill();
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
        new THREE.Vector3(sc, sc * (0.7 + r(6) * 0.8), sc),
      );
      inst.set(i, [m]);
      const color = new THREE.Color(GRASS_COLORS[Math.floor(r(7) * GRASS_COLORS.length)]).multiplyScalar(0.8 + r(8) * 0.5);
      mesh.setColorAt(i, color);
    }
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return { inst, cells };
}

export function createGround(ctx: SceneCtx): Layer {
  const { terrain, worldId, quality, world } = ctx;
  const root = new THREE.Group();
  world.add(root);
  const TS = quality === 'high' ? 48 : 24;
  const GW = terrain.width + 2 * MG;
  const GH = terrain.height + 2 * MG;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(GW, GH),
    new THREE.MeshStandardMaterial({ map: groundTexture(terrain, worldId, TS), roughness: 1 }),
  );
  plane.rotation.x = -PI / 2;
  plane.position.set(terrain.width / 2, 0, terrain.height / 2);
  plane.receiveShadow = true;
  root.add(plane);

  const grass = quality === 'high' ? grassLayer(ctx, root) : null;
  let sig: string | null = null;

  return {
    update(input) {
      if (!grass) return;
      const occ = objectKeys(input.cur.objects);
      const s = signature(occ);
      if (s === sig) return;
      sig = s;
      grass.cells.forEach((cell, ci) => {
        const on = !occ.has(cellKey(cell.x, cell.y));
        for (let b = 0; b < BLADES; b++) grass.inst.show(ci * BLADES + b, on);
      });
      grass.inst.flush();
    },
    dispose() {
      grass?.inst.remove();
      plane.geometry.dispose();
      (plane.material as THREE.Material).dispose();
      root.removeFromParent();
    },
  };
}
