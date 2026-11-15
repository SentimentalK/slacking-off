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
const GLOW_OPACITY = 0.9;
const GLOW_SIZE = 8;

interface Item {
  x: number;
  y: number;
  mats: THREE.Matrix4[];
}

let glowMap: THREE.CanvasTexture | null = null;

function lampGlowMap(): THREE.CanvasTexture {
  if (glowMap) return glowMap;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,190,110,1)');
  grad.addColorStop(1, 'rgba(255,190,110,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowMap = new THREE.CanvasTexture(c);
  glowMap.colorSpace = THREE.SRGBColorSpace;
  return glowMap;
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
  const pines: Item[] = [];
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

  const lamps: Item[] = [];
  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '.' || (x + 2 * y) % 9 !== 0) return;
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cellAt(terrain, x + dx, y + dy) === ':');
    if (!beside) return;
    const g = place(x + 0.5, 0, y + 0.5, 0, 1);
    lamps.push({ x, y, mats: LAMP_LOCAL.map((l) => g.clone().multiply(l)) });
  });

  const pineI = makeInst(PINE_PARTS, pines, root);
  const boulderI = makeInst(BOULDER_PARTS, boulders, root);
  const barrelI = makeInst(BARREL_PARTS, barrels, root);
  const crateI = makeInst(CRATE_PARTS, crates, root);
  const lampI = makeInst(LAMP_PARTS, lamps, root);

  const glowMat = new THREE.MeshBasicMaterial({
    map: lampGlowMap(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowGeo = new THREE.PlaneGeometry(GLOW_SIZE, GLOW_SIZE);
  glowGeo.rotateX(-PI / 2);
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, lamps.length);
  glow.frustumCulled = false;
  glow.visible = false;
  const glowAt = lamps.map((l) => new THREE.Matrix4().makeTranslation(l.x + 0.5 + 0.34, 0.03, l.y + 0.5));
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  lamps.forEach((_, i) => glow.setMatrixAt(i, glowAt[i]));
  root.add(glow);

  const groups: Array<{ inst: Instancer; items: Item[] }> = [
    { inst: pineI, items: pines },
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
        lamps.forEach((l, i) => glow.setMatrixAt(i, occ.has(cellKey(l.x, l.y)) ? zero : glowAt[i]));
        glow.instanceMatrix.needsUpdate = true;
      }
      const k = duskK(input.ui, input.clock);
      LAMP_BULB_MAT.emissiveIntensity = 0.2 + 2.2 * k;
      glowMat.opacity = GLOW_OPACITY * k;
      glow.visible = k > 0;
    },
    dispose() {
      for (const { inst } of groups) inst.remove();
      glowGeo.dispose();
      glowMat.dispose();
      root.removeFromParent();
    },
  };
}

function makeInst(parts: PartDef[], items: Item[], root: THREE.Group): Instancer {
  const inst = new Instancer(parts, items.length, root);
  items.forEach((it, i) => inst.set(i, it.mats));
  return inst;
}
