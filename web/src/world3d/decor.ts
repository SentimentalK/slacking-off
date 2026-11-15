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

interface Item {
  x: number;
  y: number;
  mats: THREE.Matrix4[];
}

export function createDecor(ctx: SceneCtx): Layer {
  const { terrain, worldId, quality, world } = ctx;
  const root = new THREE.Group();
  world.add(root);
  const ex = terrain.entrance.x;
  const ey = terrain.entrance.y;
  const r = (x: number, y: number, salt: number) => rand01(worldId, x, y, salt);

  const pines: Item[] = [];
  const boulders: Item[] = [];
  const barrels: Item[] = [];
  const crates: Item[] = [];
  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '.' || (x === ex && y === ey) || Math.abs(x - ex) + Math.abs(y - ey) <= 2) return;
    const v = r(x, y, 101);
    const cx = x + 0.5;
    const cz = y + 0.5;
    if (v < 0.012) {
      pines.push({
        x,
        y,
        mats: pineMatrices(place(cx, 0, cz, r(x, y, 103) * 2 * PI, 0.45 + r(x, y, 102) * 0.2), (i) => r(x, y, 110 + i) * 2 * PI),
      });
    } else if (v < 0.022) {
      const g = place(cx, 0, cz, r(x, y, 104) * 2 * PI, 1);
      boulders.push({ x, y, mats: BOULDER_LOCAL.map((l) => g.clone().multiply(l)) });
    } else if (v < 0.028) {
      const g = place(cx, 0, cz, 0, 1);
      barrels.push({ x, y, mats: BARREL_LOCAL.map((l) => g.clone().multiply(l)) });
    } else if (v < 0.033) {
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

  const lampLights: Array<{ light: THREE.PointLight; cell: string }> = [];
  if (quality === 'high') {
    const first = [...lamps].sort((a, b) => a.x - b.x || a.y - b.y).slice(0, 12);
    for (const l of first) {
      const light = new THREE.PointLight(0xffa850, 0, 7, 2);
      light.position.set(l.x + 0.5 + 0.34, 1.35, l.y + 0.5);
      root.add(light);
      lampLights.push({ light, cell: cellKey(l.x, l.y) });
    }
  }

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
      }
      const k = duskK(input.ui, input.clock);
      LAMP_BULB_MAT.emissiveIntensity = 0.2 + 2.2 * k;
      for (const L of lampLights) L.light.intensity = occ.has(L.cell) ? 0 : 3.0 * k * Math.PI;
    },
    dispose() {
      for (const { inst } of groups) inst.remove();
      root.removeFromParent();
    },
  };
}

function makeInst(parts: PartDef[], items: Item[], root: THREE.Group): Instancer {
  const inst = new Instancer(parts, items.length, root);
  items.forEach((it, i) => inst.set(i, it.mats));
  return inst;
}
