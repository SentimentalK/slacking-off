import * as THREE from 'three';
import { cellAt, cellKey, forEachCell, objectKeys, signature } from './grid';
import { Instancer, type PartDef } from './instancer';
import {
  BARREL_LOCAL,
  BARREL_PARTS,
  BOULDER_LOCAL,
  BOULDER_PARTS,
  CRATE_LOCAL,
  CRATE_PARTS,
  LAMP_BULB_MAT,
  LAMP_LOCAL,
  LAMP_PARTS,
  PINE_PARTS,
  pineMatrices,
  place,
} from './models';
import { duskK } from './lighting';
import { rand01 } from './rng';
import type { Layer, SceneCtx } from './types';

const PI = Math.PI;
const LAMP_GAIN = 0.55;
const POOL_HALF = 7;
const POOL_PX = 128;
const POOL_H = 1.35;
const POOL_COLOR = 0xffa850;

interface Item {
  x: number;
  y: number;
  mats: THREE.Matrix4[];
}

let poolMap: THREE.CanvasTexture | null = null;

function poolF(r: number): number {
  const R = Math.sqrt(r * r + POOL_H * POOL_H);
  return (Math.max(0, 1 - R / POOL_HALF) ** 2 * POOL_H) / R;
}

function lampPoolMap(): THREE.CanvasTexture {
  if (poolMap) return poolMap;
  const c = document.createElement('canvas');
  c.width = POOL_PX;
  c.height = POOL_PX;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  const img = g.createImageData(POOL_PX, POOL_PX);
  const f0 = poolF(0);
  const half = POOL_PX / 2;
  for (let py = 0; py < POOL_PX; py++) {
    for (let px = 0; px < POOL_PX; px++) {
      const d = (Math.hypot(px + 0.5 - half, py + 0.5 - half) * POOL_HALF) / half;
      const v = Math.round((255 * poolF(d)) / f0);
      const i = (py * POOL_PX + px) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  poolMap = new THREE.CanvasTexture(c);
  return poolMap;
}

export function createDecor(ctx: SceneCtx): Layer {
  const { terrain, worldId, world } = ctx;
  const root = new THREE.Group();
  world.add(root);
  const ex = terrain.entrance.x;
  const ey = terrain.entrance.y;
  const r = (x: number, y: number, salt: number) => rand01(worldId, x, y, salt);

  const treeLine = (x: number, y: number): boolean =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cellAt(terrain, x + dx, y + dy) === '~');
  const wildNear = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d >= 1 && d <= 2 && cellAt(terrain, x + dx, y + dy) === '~') return true;
      }
    }
    return false;
  };
  const pines: Item[] = [];
  const bigPines: Item[] = [];
  const boulders: Item[] = [];
  const barrels: Item[] = [];
  const crates: Item[] = [];
  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '.' || (x === ex && y === ey) || Math.abs(x - ex) + Math.abs(y - ey) <= 2) return;
    if (treeLine(x, y)) return;
    const v = r(x, y, 101);
    const cx = x + 0.5;
    const cz = y + 0.5;
    if (v < 0.025) {
      pines.push({
        x,
        y,
        mats: pineMatrices(place(cx, 0, cz, r(x, y, 103) * 2 * PI, 0.55 + r(x, y, 102) * 0.35), (i) => r(x, y, 110 + i) * 2 * PI),
      });
    } else if (v < 0.035) {
      const g = place(cx, 0, cz, r(x, y, 104) * 2 * PI, 1);
      boulders.push({ x, y, mats: BOULDER_LOCAL.map((l) => g.clone().multiply(l)) });
    } else if (v < 0.041) {
      const g = place(cx, 0, cz, 0, 1);
      barrels.push({ x, y, mats: BARREL_LOCAL.map((l) => g.clone().multiply(l)) });
    } else if (v < 0.046) {
      const g = place(cx, 0, cz, (r(x, y, 105) - 0.5) * 0.7, 1);
      crates.push({ x, y, mats: CRATE_LOCAL.map((l) => g.clone().multiply(l)) });
    }
  });

  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '.' || (x === ex && y === ey) || Math.abs(x - ex) + Math.abs(y - ey) <= 2) return;
    if (r(x, y, 510) >= (wildNear(x, y) ? 0.35 : 0.03)) return;
    const s = (0.55 + r(x, y, 511) * 0.35) * (2 + r(x, y, 512));
    bigPines.push({
      x,
      y,
      mats: pineMatrices(place(x + 0.5, 0, y + 0.5, r(x, y, 513) * 2 * PI, s), (i) => r(x, y, 520 + i) * 2 * PI),
    });
  });

  const lamps: Item[] = [];
  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '.' || (x + 2 * y) % 9 !== 0) return;
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cellAt(terrain, x + dx, y + dy) === ':');
    if (!beside) return;
    const g = place(x + 0.5, 0, y + 0.5, 0, 1);
    lamps.push({ x, y, mats: LAMP_LOCAL.map((l) => g.clone().multiply(l)) });
  });

  const pineI = makeInst(PINE_PARTS, pines, root);
  const bigPineI = makeInst(PINE_PARTS, bigPines, root);
  const boulderI = makeInst(BOULDER_PARTS, boulders, root);
  const barrelI = makeInst(BARREL_PARTS, barrels, root);
  const crateI = makeInst(CRATE_PARTS, crates, root);
  const lampI = makeInst(LAMP_PARTS, lamps, root);

  const poolMat = new THREE.MeshBasicMaterial({
    map: lampPoolMap(),
    color: POOL_COLOR,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0,
  });
  const poolGeo = new THREE.PlaneGeometry(POOL_HALF * 2, POOL_HALF * 2);
  poolGeo.rotateX(-PI / 2);
  const pool = new THREE.InstancedMesh(poolGeo, poolMat, lamps.length);
  pool.frustumCulled = false;
  pool.visible = false;
  const poolAt = lamps.map((l) => new THREE.Matrix4().makeTranslation(l.x + 0.5 + 0.34, 0.03, l.y + 0.5));
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  lamps.forEach((_, i) => pool.setMatrixAt(i, poolAt[i]));
  pool.instanceMatrix.needsUpdate = true;
  root.add(pool);

  const groups: Array<{ inst: Instancer; items: Item[] }> = [
    { inst: pineI, items: pines },
    { inst: bigPineI, items: bigPines },
    { inst: boulderI, items: boulders },
    { inst: barrelI, items: barrels },
    { inst: crateI, items: crates },
    { inst: lampI, items: lamps },
  ];
  let sig: string | null = null;

  return {
    update(input) {
      const occ = objectKeys(input.cur.objects);
      const s = signature(occ);
      if (s !== sig) {
        sig = s;
        for (const { inst, items } of groups) {
          items.forEach((it, i) => inst.show(i, !occ.has(cellKey(it.x, it.y))));
          inst.flush();
        }
        lamps.forEach((l, i) => pool.setMatrixAt(i, occ.has(cellKey(l.x, l.y)) ? zero : poolAt[i]));
        pool.instanceMatrix.needsUpdate = true;
      }
      const k = duskK(input.ui, input.clock);
      LAMP_BULB_MAT.emissiveIntensity = 0.2 + 2.2 * k;
      poolMat.opacity = k * LAMP_GAIN;
      pool.visible = k > 0;
    },
    dispose() {
      for (const { inst } of groups) inst.remove();
      poolGeo.dispose();
      poolMat.dispose();
      root.removeFromParent();
    },
  };
}

function makeInst(parts: PartDef[], items: Item[], root: THREE.Group): Instancer {
  const inst = new Instancer(parts, items.length, root);
  items.forEach((it, i) => inst.set(i, it.mats));
  return inst;
}
