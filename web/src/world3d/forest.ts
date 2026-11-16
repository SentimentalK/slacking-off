import * as THREE from 'three';
import type { Pos, Terrain } from '../types';
import { MG, cellAt, cellKey, forEachCell, signature, wallKeys } from './grid';
import { Instancer } from './instancer';
import { PINE_PARTS, STUMP_PARTS, pineMatrices, place, local } from './models';
import { S } from './materials';
import { rand01 } from './rng';
import type { FrameInput, Layer, SceneCtx } from './types';

const PI = Math.PI;
const FIELD_DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CAST_RING = 3;
export const FOREST_MG = 36;
const FAR_RING = 12;
const NO_SHADOW_PINE_PARTS = PINE_PARTS.map((p) => ({ ...p, shadow: false }));

export const TREE_FADE_OPACITY = 0.25;
const TREE_FADE_SECONDS = 0.25;
const TREE_ZONE_AHEAD = 4;
const TREE_ZONE_SIDE = 2;

// The own shack is a 3x3 ring around its toilet cell; trees up to this many cells beyond that ring fade too.
const TREE_ZONE_SHACK = 1;
const SHACK_REACH = 2;

function inTreeZone(tree: Pos, me: Pos, shack: Pos | null): boolean {
  if (tree.y > me.y && tree.y <= me.y + TREE_ZONE_AHEAD && Math.abs(tree.x - me.x) <= TREE_ZONE_SIDE) return true;
  return !!shack && Math.max(Math.abs(tree.x - shack.x), Math.abs(tree.y - shack.y)) <= 1 + TREE_ZONE_SHACK;
}

/** The shack the agent stands in or at the door of: the nearest toilet cell within SHACK_REACH (Chebyshev). */
function ownShack(objects: readonly { kind: string; pos: Pos }[], me: Pos): Pos | null {
  let best: Pos | null = null;
  let bestD = SHACK_REACH + 1;
  for (const o of objects) {
    if (o.kind !== 'toilet') continue;
    const d = Math.max(Math.abs(o.pos.x - me.x), Math.abs(o.pos.y - me.y));
    if (d < bestD) {
      bestD = d;
      best = o.pos;
    }
  }
  return best;
}

function fadeMaterial(src: THREE.Material): THREE.Material {
  const mat = src.clone();
  const base = src.onBeforeCompile;
  mat.transparent = true;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    shader.vertexShader =
      'attribute float aFade;\nvarying float vFade;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', (m) => `${m}\nvFade = aFade;`);
    shader.fragmentShader =
      'varying float vFade;\n' +
      shader.fragmentShader.replace('#include <color_fragment>', (m) => `${m}\ndiffuseColor.a *= vFade;`);
  };
  return mat;
}

export class TreeFade {
  private readonly values: Float32Array;
  private readonly target: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private key = '';
  private last = 0;
  private active = false;

  constructor(
    inst: Instancer,
    private readonly roots: Pos[],
  ) {
    this.values = new Float32Array(roots.length).fill(1);
    this.target = new Float32Array(roots.length).fill(1);
    for (const m of inst.meshes) {
      const geo = m.geometry.clone();
      const attr = new THREE.InstancedBufferAttribute(this.values, 1);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aFade', attr);
      const mat = fadeMaterial(m.material as THREE.Material);
      m.geometry = geo;
      m.material = mat;
      this.attrs.push(attr);
      this.mats.push(mat);
      this.geos.push(geo);
    }
  }

  update(input: FrameInput): void {
    const now = performance.now();
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const me = input.ui.vision ? input.cur.agents.find((a) => a.id === input.ui.selected) : undefined;
    const shack = me ? ownShack(input.cur.objects, me.pos) : null;
    const key = me ? `${me.pos.x},${me.pos.y}|${shack ? `${shack.x},${shack.y}` : ''}` : '';
    if (key !== this.key) {
      this.key = key;
      for (let i = 0; i < this.roots.length; i++) {
        this.target[i] = me && inTreeZone(this.roots[i], me.pos, shack) ? TREE_FADE_OPACITY : 1;
      }
      this.active = true;
    }
    if (!this.active) return;
    const step = (dt * (1 - TREE_FADE_OPACITY)) / TREE_FADE_SECONDS;
    let changed = false;
    let moving = false;
    for (let i = 0; i < this.values.length; i++) {
      const v = this.values[i];
      const t = this.target[i];
      if (v !== t) {
        const next = Math.abs(t - v) <= step ? t : v + Math.sign(t - v) * step;
        this.values[i] = next;
        changed = true;
      }
      if (this.values[i] !== t) moving = true;
    }
    if (changed) for (const a of this.attrs) a.needsUpdate = true;
    this.active = moving;
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}

interface PineRec {
  x: number;
  y: number;
  wild: boolean;
  far: boolean;
  mats: THREE.Matrix4[];
  shades: number[];
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

  const lane: Pos[] = [terrain.entrance];
  forEachCell(terrain, (x, y, ch) => {
    if (ch === ':') lane.push({ x, y });
  });
  const nearLane = (x: number, y: number): boolean => lane.some((p) => Math.abs(x - p.x) + Math.abs(y - p.y) <= 2);
  const fieldEdge = (x: number, y: number): boolean =>
    FIELD_DIRS.some(([dx, dy]) => {
      const c = cellAt(terrain, x + dx, y + dy);
      return c === '.' || c === ':';
    });
  const shadesOf = (x: number, y: number, j: number): number[] =>
    [0, 1, 2, 3, 4].map((i) => 0.9 + r(x, y, 100 + j * 8 + i) * 0.15);

  const pineAt = (x: number, y: number, j: number, lo: number, span: number, px: number, pz: number) => {
    const s = (lo + span * r(x, y, j * 16 + 12)) * (0.7 + 0.6 * r(x, y, j * 16 + 9));
    const root = place(px, 0, pz, r(x, y, j * 16 + 3) * 2 * PI, s);
    pines.push({
      x,
      y,
      wild: true,
      far: false,
      mats: pineMatrices(root, (i) => r(x, y, j * 16 + 4 + i) * 2 * PI),
      shades: shadesOf(x, y, j),
    });
  };

  forEachCell(terrain, (x, y, ch) => {
    if (ch !== '~') return;
    const px = x + 0.5 + (r(x, y, 1) - 0.5) * 0.9;
    const pz = y + 0.5 + (r(x, y, 2) - 0.5) * 0.9;
    if (nearLane(x, y)) {
      pineAt(x, y, 0, 0.95 * 0.55, 0.75 * 0.55, px, pz);
    } else {
      if (fieldEdge(x, y)) pineAt(x, y, 0, 0.7, 0.6, px, pz);
      else pineAt(x, y, 0, 0.95, 0.75, px, pz);
      if (r(x, y, 13) < 0.5) {
        pineAt(x, y, 1, 0.6, 0.3, x + 0.5 + (r(x, y, 17) - 0.5) * 0.9, y + 0.5 + (r(x, y, 18) - 0.5) * 0.9);
      }
    }
    stumps.push({ x, y, mats: [local(x + 0.5, 0.125, y + 0.5)] });
  });

  const expected = quality === 'low' ? 0.65 : 1.3;
  for (let y = -FOREST_MG; y < H + FOREST_MG; y++) {
    for (let x = -FOREST_MG; x < W + FOREST_MG; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) continue;
      if (x < 0 && x >= -MG && (y === ey || y === ey + 1)) continue;
      const out = Math.max(-x, x - (W - 1), -y, y - (H - 1));
      const density = out > FAR_RING ? expected * 0.5 : expected;
      const whole = Math.floor(density);
      const frac = density - whole;
      const n = whole + (r(x, y, 1) < frac ? 1 : 0);
      for (let j = 0; j < n; j++) {
        const px = x + 0.5 + (r(x, y, j * 16 + 2) - 0.5) * 0.9;
        const pz = y + 0.5 + (r(x, y, j * 16 + 3) - 0.5) * 0.9;
        const s = (0.8 + r(x, y, j * 16 + 4) * 1.1) * (0.7 + 0.6 * r(x, y, j * 16 + 11));
        const root = place(px, 0, pz, r(x, y, j * 16 + 5) * 2 * PI, s);
        pines.push({
          x,
          y,
          wild: false,
          far: out > CAST_RING,
          mats: pineMatrices(root, (i) => r(x, y, j * 16 + 6 + i) * 2 * PI),
          shades: shadesOf(x, y, j),
        });
      }
    }
  }
  return { pines, stumps };
}

function paintShades(inst: Instancer, i: number, shades: number[]): void {
  shades.forEach((s, t) => inst.meshes[t + 1].setColorAt(i, new THREE.Color().setScalar(s)));
}

function checkpoint(root: THREE.Group, ex: number, ey: number): void {
  const bx = ex + 0.5;
  const bz = ey - 0.5;
  boxMesh(0.8, 1.0, 0.8, S(0x7a5a3c), bx, 0.5, bz, root);
  boxMesh(0.96, 0.1, 0.96, S(0x58808a), bx, 1.05, bz, root);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.3),
    new THREE.MeshStandardMaterial({ map: signText('COMPANY TIME', '#7a5a3c', '#f4ead2', 256, 52), roughness: 1 }),
  );
  sign.position.set(bx, 1.25, bz);
  root.add(sign);
  const start = bz + 0.4;
  for (let i = 0; i < 5; i++) {
    boxMesh(0.1, 0.1, 0.44, S(i % 2 ? 0xe9e4da : 0xb8402f), bx, 1.0, start + 0.22 + i * 0.44, root);
  }
}

export function createForest(ctx: SceneCtx): Layer {
  const { terrain, worldId, quality, world } = ctx;
  const root = new THREE.Group();
  world.add(root);
  const ex = terrain.entrance.x;
  const ey = terrain.entrance.y;

  const { pines, stumps } = buildPines(terrain, worldId, quality);
  const nearPines = pines.filter((p) => !p.far);
  const farPines = pines.filter((p) => p.far);

  const pineInst = new Instancer(PINE_PARTS, nearPines.length, root);
  nearPines.forEach((p, i) => {
    pineInst.set(i, p.mats);
    paintShades(pineInst, i, p.shades);
  });
  const farInst = new Instancer(NO_SHADOW_PINE_PARTS, farPines.length, root);
  farPines.forEach((p, i) => {
    farInst.set(i, p.mats);
    paintShades(farInst, i, p.shades);
  });
  for (const inst of [pineInst, farInst]) {
    for (const m of inst.meshes) {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
  farInst.flush();

  const stumpInst = new Instancer(STUMP_PARTS, stumps.length, root);
  stumps.forEach((s, i) => stumpInst.set(i, s.mats));

  const fades = [new TreeFade(pineInst, nearPines), new TreeFade(farInst, farPines)];

  checkpoint(root, ex, ey);

  let sig: string | null = null;
  return {
    update(input) {
      for (const f of fades) f.update(input);
      const walls = wallKeys(input.cur.objects);
      const s = signature(walls);
      if (s === sig) return;
      sig = s;
      nearPines.forEach((p, i) => pineInst.show(i, !p.wild || walls.has(cellKey(p.x, p.y))));
      stumps.forEach((st, i) => stumpInst.show(i, !walls.has(cellKey(st.x, st.y))));
      pineInst.flush();
      stumpInst.flush();
    },
    dispose() {
      for (const f of fades) f.dispose();
      pineInst.remove();
      farInst.remove();
      stumpInst.remove();
      root.removeFromParent();
    },
  };
}
