import * as THREE from 'three';
import type { Terrain } from '../types';
import { MG, cellKey, forEachCell, signature, wallKeys } from './grid';
import { Instancer } from './instancer';
import { PINE_PARTS, STUMP_PARTS, pineMatrices, place, local } from './models';
import { DEEP_WOOD, S } from './materials';
import { rand01 } from './rng';
import type { Layer, SceneCtx } from './types';

const PI = Math.PI;

interface PineRec {
  x: number;
  y: number;
  wild: boolean;
  mats: THREE.Matrix4[];
}

interface StumpRec {
  x: number;
  y: number;
  mats: THREE.Matrix4[];
}

function boxMesh(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function signText(text: string, bg: string, fg: string, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = 'bold ' + Math.floor(h * 0.6) + 'px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildPines(terrain: Terrain, worldId: number, quality: SceneCtx['quality']): { pines: PineRec[]; stumps: StumpRec[] } {
  const W = terrain.width;
  const H = terrain.height;
  const ey = terrain.entrance.y;
  const r = (x: number, y: number, salt: number) => rand01(worldId, x, y, salt);
  const pines: PineRec[] = [];
  const stumps: StumpRec[] = [];

  const pineAt = (x: number, y: number, j: number, lo: number, span: number, wild: boolean, offset: number) => {
    const px = x + 0.5 + (r(x, y, j * 16 + 1) - 0.5) * offset;
    const pz = y + 0.5 + (r(x, y, j * 16 + 2) - 0.5) * offset;
    const s = lo + span * r(x, y, j * 16 + 12);
    const root = place(px, 0, pz, r(x, y, j * 16 + 3) * 2 * PI, s);
    pines.push({ x, y, wild, mats: pineMatrices(root, (i) => r(x, y, j * 16 + 4 + i) * 2 * PI) });
  };

  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '~') return;
    pineAt(x, y, 0, 0.95, 0.75, true, 0.5);
    if (r(x, y, 13) < 0.5) pineAt(x, y, 1, 0.6, 0.3, true, 0.5);
    stumps.push({ x, y, mats: [local(x + 0.5, 0.125, y + 0.5)] });
  });

  const expected = quality === 'high' ? 1.3 : 0.65;
  const whole = Math.floor(expected);
  const frac = expected - whole;
  for (let y = -MG; y < H + MG; y++) {
    for (let x = -MG; x < W + MG; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) continue;
      const n = whole + (r(x, y, 1) < frac ? 1 : 0);
      for (let j = 0; j < n; j++) {
        const px = x + r(x, y, j * 16 + 2);
        const pz = y + r(x, y, j * 16 + 3);
        if (px < 0 && Math.abs(pz - (ey + 1)) < 0.75) continue;
        const s = 0.95 + r(x, y, j * 16 + 4) * 0.75;
        const root = place(px, 0, pz, r(x, y, j * 16 + 5) * 2 * PI, s);
        pines.push({ x, y, wild: false, mats: pineMatrices(root, (i) => r(x, y, j * 16 + 6 + i) * 2 * PI) });
      }
    }
  }
  return { pines, stumps };
}

export function createForest(ctx: SceneCtx): Layer {
  const { terrain, worldId, quality, world } = ctx;
  const root = new THREE.Group();
  world.add(root);
  const ex = terrain.entrance.x;
  const ey = terrain.entrance.y;

  const { pines, stumps } = buildPines(terrain, worldId, quality);
  const pineInst = new Instancer(PINE_PARTS, pines.length, root);
  pines.forEach((p, i) => pineInst.set(i, p.mats));
  const stumpInst = new Instancer(STUMP_PARTS, stumps.length, root);
  stumps.forEach((s, i) => stumpInst.set(i, s.mats));

  const gate = new THREE.Group();
  gate.position.set(ex + 0.5, 0, ey + 0.5);
  gate.rotation.y = -PI / 2;
  root.add(gate);
  const post = S(DEEP_WOOD);
  [-0.95, 0.95].forEach((dx) => boxMesh(0.14, 2.0, 0.14, post, dx, 1.0, 0, gate));
  boxMesh(2.2, 0.5, 0.08, S(0x7a5a3c), 0, 2.0, 0, gate).rotation.z = -0.03;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 0.4),
    new THREE.MeshStandardMaterial({ map: signText('COMPANY TIME', '#7a5a3c', '#f4ead2', 256, 52), roughness: 1 }),
  );
  sign.position.set(0, 2.0, 0.05);
  sign.rotation.z = -0.03;
  gate.add(sign);
  const arm = new THREE.Group();
  arm.position.set(-0.95, 0.9, 0.12);
  arm.rotation.z = 1.05;
  gate.add(arm);
  for (let i = 0; i < 5; i++) {
    boxMesh(0.38, 0.07, 0.07, S(i % 2 ? 0xe9e4da : 0xb8402f), 0.19 + i * 0.38, 0, 0, arm);
  }

  let sig: string | null = null;
  return {
    update(input) {
      const walls = wallKeys(input.cur.objects);
      const s = signature(walls);
      if (s === sig) return;
      sig = s;
      pines.forEach((p, i) => pineInst.show(i, !p.wild || walls.has(cellKey(p.x, p.y))));
      stumps.forEach((st, i) => stumpInst.show(i, !walls.has(cellKey(st.x, st.y))));
      pineInst.flush();
      stumpInst.flush();
    },
    dispose() {
      pineInst.remove();
      stumpInst.remove();
      root.removeFromParent();
    },
  };
}
