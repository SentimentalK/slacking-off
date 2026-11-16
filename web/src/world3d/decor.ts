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
import { clearLampSources, setLampSources, type LampSource } from './lamplight';
import { rand01 } from './rng';
import type { Layer, SceneCtx } from './types';

const PI = Math.PI;
const LAMP_BULB_Y = 1.45;
const LAMP_LIGHT_DIST = 7;
const LAMP_LIGHT_INTENSITY = 2.4;
const LAMP_COLOR = new THREE.Color(0xffa850);
const LAMP_OWNER = 'lamp-posts';

interface Item {
  x: number;
  y: number;
  mats: THREE.Matrix4[];
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
        setLampSources(LAMP_OWNER, lamps.filter((l) => !occ.has(cellKey(l.x, l.y))).map(lampSource));
      }
      const k = duskK(input.ui, input.clock);
      LAMP_BULB_MAT.emissiveIntensity = 0.2 + 2.2 * k;
    },
    dispose() {
      for (const { inst } of groups) inst.remove();
      clearLampSources(LAMP_OWNER);
      root.removeFromParent();
    },
  };
}

function lampSource(l: Item): LampSource {
  return {
    x: l.x + 0.5 + 0.34,
    z: l.y + 0.5,
    y: LAMP_BULB_Y,
    color: [LAMP_COLOR.r, LAMP_COLOR.g, LAMP_COLOR.b],
    intensity: LAMP_LIGHT_INTENSITY,
    distance: LAMP_LIGHT_DIST,
  };
}

function makeInst(parts: PartDef[], items: Item[], root: THREE.Group): Instancer {
  const inst = new Instancer(parts, items.length, root);
  items.forEach((it, i) => inst.set(i, it.mats));
  return inst;
}
