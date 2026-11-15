import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEEP_WOOD, PLANK_COLORS, S } from './materials';
import { hash32, rand01, SeededRandom } from './rng';

export const WH = 1.25;
export const ROOF_RIDGE = 0.68;
export const ROOF_EAVE = 0.393 - 0.89 * Math.sin(0.3);

const PI = Math.PI;
const RAIL = 0x4a3526;
const IRON = 0x33383a;
const POLE = 0xd9b44a;
const WALK = 0x8c6a3e;
const LAMP_IDLE = 0xd8dcd6;
const WATER_BOWL = 0x4fa3c7;
const TOILET_SCALE = 1.4;
const SIGN_LIT = 0.9;
const TRIM = 0xe9e4da;
const WOODS = PLANK_COLORS;
const BAG_COLORS = [0x6f5340, 0x7a5c46, 0x64493a] as const;
const SIGN_RED = 0xd8392f;
const SIGN_GREEN = 0x3fb950;
export const ACCENT = 0x3f7fb8;

type MatParams = THREE.MeshStandardMaterialParameters;

function own<T extends THREE.Material>(m: T): T {
  m.userData.own = true;
  return m;
}

function shadowed(m: THREE.Mesh): THREE.Mesh {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return g.index ? g.toNonIndexed() : g;
}

function T(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
}

function colored(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function boxGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function rboxGeo(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const b = Math.min(r * 0.6, h * 0.3);
  const rr = Math.max(0.005, Math.min(r, w / 2 - b - 0.003, d / 2 - b - 0.003));
  const hw = w / 2 - b - rr;
  const hd = d / 2 - b - rr;
  const s = new THREE.Shape();
  s.absarc(hw, hd, rr, 0, PI / 2);
  s.absarc(-hw, hd, rr, PI / 2, PI);
  s.absarc(-hw, -hd, rr, PI, PI * 1.5);
  s.absarc(hw, -hd, rr, PI * 1.5, PI * 2);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.001, h - 2 * b),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: 4,
  });
  g.rotateX(-PI / 2);
  g.translate(0, b - h / 2, 0);
  return g;
}

class Batch {
  private readonly groups = new Map<string, { params: MatParams; geos: THREE.BufferGeometry[] }>();

  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, hex: number, params: MatParams = {}): void {
    const key = JSON.stringify(params);
    let e = this.groups.get(key);
    if (!e) {
      e = { params, geos: [] };
      this.groups.set(key, e);
    }
    const g = prep(geo);
    g.applyMatrix4(m);
    e.geos.push(colored(g, hex));
  }

  meshes(material?: (params: MatParams) => THREE.Material): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const e of this.groups.values()) {
      const merged = mergeGeometries(e.geos, false);
      if (!merged) continue;
      const mat = material ? material(e.params) : S(0xffffff, { ...e.params, vertexColors: true });
      out.push(shadowed(new THREE.Mesh(merged, mat)));
    }
    return out;
  }
}

function single(geo: THREE.BufferGeometry, hex: number, params?: MatParams, m?: THREE.Matrix4): THREE.Mesh {
  const b = new Batch();
  b.add(geo, m ?? new THREE.Matrix4(), hex, params);
  const [mesh] = b.meshes(params ? () => S(hex, params) : () => S(hex));
  return mesh;
}

function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

let stripeTexture: THREE.CanvasTexture | null = null;

function stripeTex(): THREE.CanvasTexture {
  if (stripeTexture) return stripeTexture;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  g.fillStyle = '#f2c230';
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = '#1d1d1d';
  for (let x = -32; x < 96; x += 32) {
    g.beginPath();
    g.moveTo(x, 16);
    g.lineTo(x + 16, 16);
    g.lineTo(x + 32, 0);
    g.lineTo(x + 16, 0);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  stripeTexture = t;
  return t;
}

let tileTexture: THREE.CanvasTexture | null = null;

function tiles(): THREE.CanvasTexture {
  if (tileTexture) return tileTexture;
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  const rng = new SeededRandom(0x5eed);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      g.fillStyle = (i + j) % 2 ? '#c9cdc4' : '#8fa39a';
      g.fillRect(i * 16, j * 16, 16, 16);
      g.fillStyle = 'rgba(60,50,40,' + rng.next() * 0.18 + ')';
      g.fillRect(i * 16, j * 16, 16, 16);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  tileTexture = t;
  return t;
}

let haloTexture: THREE.CanvasTexture | null = null;

function haloTex(): THREE.CanvasTexture {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  haloTexture = t;
  return t;
}

function textTexture(text: string, bg: string, fg: string, w: number, h: number): THREE.CanvasTexture {
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

export function plankCount(len: number): number {
  return Math.round(len / 0.2);
}

function plankColor(seed: number, i: number, k: number): number {
  return WOODS[Math.floor(rand01(seed, i, 0, k) * WOODS.length)];
}

function plankParts(len: number, seed: number, win: boolean, hidden: number, batch: { boards: Batch; rails: Batch }, ox = 0): THREE.BufferGeometry | null {
  const n = plankCount(len);
  const wd = len / n;
  const isWin: boolean[] = [];
  const centers: number[] = [];
  for (let i = 0; i < n; i++) {
    const cx = -len / 2 + i * wd + wd / 2;
    centers.push(cx);
    isWin.push(win && Math.abs(cx) < 0.31);
  }
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) if (!isWin[i]) candidates.push(i);
  candidates.sort((a, b) => rand01(seed, a, 0, 31) - rand01(seed, b, 0, 31));
  const gone = new Set(candidates.slice(0, Math.min(hidden, candidates.length)));

  for (let i = 0; i < n; i++) {
    const cx = centers[i] + ox;
    if (isWin[i]) {
      batch.boards.add(boxGeo(wd - 0.015, 0.5, 0.1), T(cx, 0.25, 0), plankColor(seed, i, 1));
      batch.boards.add(boxGeo(wd - 0.015, 0.22, 0.1), T(cx, WH - 0.11, 0), plankColor(seed, i, 2));
      continue;
    }
    if (gone.has(i)) continue;
    const hh = WH - rand01(seed, i, 0, 11) * 0.07;
    const z = (rand01(seed, i, 0, 13) - 0.5) * 0.015;
    batch.boards.add(boxGeo(wd - 0.015, hh, 0.1), T(cx, hh / 2, z), plankColor(seed, i, 12));
  }
  batch.rails.add(boxGeo(len, 0.07, 0.13), T(ox, 0.5, 0), RAIL);
  batch.rails.add(boxGeo(len, 0.07, 0.13), T(ox, WH - 0.2, 0), RAIL);
  if (!win) return null;
  batch.rails.add(boxGeo(0.03, 0.36, 0.06), T(ox, 0.77, 0), RAIL);
  return boxGeo(0.6, 0.36, 0.04);
}

export function plankWall(len: number, seed: number, win = false, hidden = 0): THREE.Group {
  const boards = new Batch();
  const rails = new Batch();
  const glassGeo = plankParts(len, seed, win, hidden, { boards, rails });
  const g = new THREE.Group();
  for (const m of boards.meshes()) g.add(m);
  for (const m of rails.meshes()) g.add(m);
  if (glassGeo) {
    const mat = own(
      new THREE.MeshStandardMaterial({ color: 0x7fa8b0, flatShading: false, roughness: 0.2, emissive: 0xffb050, emissiveIntensity: 0 }),
    );
    const glass = shadowed(new THREE.Mesh(glassGeo, mat));
    glass.userData.win = true;
    g.add(glass);
  }
  return g;
}

export function doorSide(seed: number, accent = ACCENT): { group: THREE.Group; pivot: THREE.Group; sign: THREE.Mesh; top: THREE.Mesh } {
  const boards = new Batch();
  const rails = new Batch();
  plankParts(0.82, seed + 1, false, 0, { boards, rails }, -0.9);
  plankParts(0.82, seed + 2, false, 0, { boards, rails }, 0.9);
  const segs = new Batch();
  segs.add(boxGeo(1.1, 0.1, 0.14), T(0, WH - 0.02, 0), RAIL);

  const group = new THREE.Group();
  for (const m of boards.meshes()) group.add(m);
  for (const m of rails.meshes()) group.add(m);
  for (const m of segs.meshes()) group.add(m);

  const pivot = new THREE.Group();
  pivot.position.set(-0.5, 0, 0);
  group.add(pivot);
  const leafH = WH - 0.16;
  const leafY = leafH / 2 + 0.04;
  const leaf = new Batch();
  leaf.add(boxGeo(0.98, leafH, 0.12), T(0.49, leafY, 0), accent);
  leaf.add(boxGeo(0.03, leafH, 0.13), T(0.015, leafY, 0), TRIM);
  leaf.add(boxGeo(0.03, leafH, 0.13), T(0.965, leafY, 0), TRIM);
  leaf.add(boxGeo(0.98, 0.03, 0.13), T(0.49, 0.055, 0), TRIM);
  leaf.add(boxGeo(0.98, 0.03, 0.13), T(0.49, 0.04 + leafH - 0.015, 0), TRIM);
  leaf.add(boxGeo(0.98, 0.06, 0.09), T(0.49, 0.3, 0), IRON);
  leaf.add(boxGeo(0.98, 0.06, 0.09), T(0.49, 0.85, 0), IRON);
  for (const m of leaf.meshes()) pivot.add(m);
  const sign = single(boxGeo(0.18, 0.18, 0.03), SIGN_RED, { emissive: SIGN_RED, emissiveIntensity: SIGN_LIT }, T(0.49, 0.6, 0.085));
  pivot.add(sign);
  const top = single(boxGeo(0.34, 0.05, 0.22), SIGN_RED, { emissive: SIGN_RED, emissiveIntensity: SIGN_LIT }, T(0, WH + 0.055, 0));
  group.add(top);
  return { group, pivot, sign, top };
}

export function scaffold(len: number): THREE.Group {
  const poles = new Batch();
  const rails = new Batch();
  for (const sx of [-len / 2, len / 2]) {
    for (const sz of [-0.42, 0.42]) {
      poles.add(new THREE.CylinderGeometry(0.07, 0.07, 1.9, 6), T(sx, 0.95, sz), POLE);
    }
  }
  for (const sz of [-0.42, 0.42]) rails.add(boxGeo(len, 0.05, 0.05), T(0, 1.5, sz), POLE);
  const boards = new Batch();
  for (const sx of [-len / 4, len / 4]) boards.add(boxGeo(0.25, 0.04, 0.94), T(sx, 1.545, 0), WALK);
  const g = new THREE.Group();
  for (const m of poles.meshes(() => S(POLE))) g.add(m);
  for (const m of rails.meshes(() => S(POLE))) g.add(m);
  for (const m of boards.meshes()) g.add(m);
  return g;
}

export function shackFloor(): THREE.Group {
  const base = single(boxGeo(3.1, 0.1, 3.1), 0x5a5852, undefined, T(0, 0.02, 0));
  const tile = shadowed(
    new THREE.Mesh(
      new THREE.BoxGeometry(2.86, 0.06, 2.86).translate(0, 0.07, 0),
      own(new THREE.MeshStandardMaterial({ map: tiles(), roughness: 0.7 })),
    ),
  );
  return group(base, tile);
}

export function cornerPost(): THREE.Group {
  return group(single(boxGeo(0.22, WH + 0.1, 0.22), DEEP_WOOD, undefined, T(0, (WH + 0.1) / 2, 0)));
}

const CER = 0xe9ebe6;
const PORCELAIN = 0xf2f2ee;
const WATER = 0x6aa9bd;
const CLUTTER_LIMIT = 1.05;

function clampClutter(v: number): number {
  return Math.max(-CLUTTER_LIMIT, Math.min(CLUTTER_LIMIT, v));
}

function clutterGroup(): THREE.Group {
  const flat = new Batch();
  const smooth = new Batch();
  const sm = { flatShading: false, roughness: 0.3 };
  const at = (x: number, y: number, z: number): THREE.Matrix4 => T(clampClutter(x), y, clampClutter(z));
  flat.add(boxGeo(0.6, 0.5, 0.4), at(-0.98, 0.33, -1.0), 0x8a8f8a);
  smooth.add(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 14), at(-0.98, 0.59, -0.98), WATER, { ...sm, roughness: 0.1 });
  flat.add(new THREE.CylinderGeometry(0.15, 0.12, 0.3, 10), at(1.0, 0.25, 0.95), 0x5f6a70);
  for (let i = 0; i < 3; i++) {
    smooth.add(new THREE.CylinderGeometry(0.08, 0.08, 0.1, 10), at(-1.02 + (i % 2) * 0.17, 0.15 + (i > 1 ? 0.1 : 0), 0.98), 0xe9e4da, sm);
  }
  flat.add(boxGeo(0.5, 0.3, 0.4), at(1.0, 0.25, -1.0), 0x8a623c);
  flat.add(boxGeo(0.3, 0.2, 0.3), at(1.02, 0.5, -1.02), 0x7a5a3c);
  const g = new THREE.Group();
  for (const m of flat.meshes()) g.add(m);
  for (const m of smooth.meshes()) g.add(m);
  return g;
}

export function toiletModel(level: number, withClutter = true): THREE.Group {
  const flat = new Batch();
  const smooth = new Batch();
  const sm = { flatShading: false, roughness: 0.3 };
  const gold = level === 5;
  const body = gold ? { flatShading: false, roughness: 0.25, metalness: 0.7 } : sm;
  const bodyHex = gold ? 0xe8b93a : PORCELAIN;
  const extra = new THREE.Group();

  if (level === 1) {
    const frame = 0x8a623c;
    flat.add(boxGeo(0.7, 0.14, 0.06), T(0, 0.07, -0.25), frame);
    flat.add(boxGeo(0.7, 0.14, 0.06), T(0, 0.07, 0.25), frame);
    flat.add(boxGeo(0.06, 0.14, 0.44), T(-0.32, 0.07, 0), frame);
    flat.add(boxGeo(0.06, 0.14, 0.44), T(0.32, 0.07, 0), frame);
    flat.add(boxGeo(0.58, 0.02, 0.44), T(0, 0.13, 0), 0xe2cf94);
    for (const [x, z] of [[-0.15, 0.05], [0.05, -0.08], [0.18, 0.1]]) {
      flat.add(new THREE.SphereGeometry(0.035, 8, 6), T(x, 0.15, z), 0x4b3b27);
    }
  } else if (level === 2) {
    smooth.add(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 18), T(0, 0.125, 0), CER, sm);
    smooth.add(new THREE.TorusGeometry(0.245, 0.02, 6, 18), T(0, 0.17, 0, PI / 2, 0, 0), CER, sm);
    flat.add(new THREE.CylinderGeometry(0.09, 0.09, 0.01, 14), T(0, 0.152, 0), 0x2b3238);
    smooth.add(boxGeo(0.3, 0.22, 0.1), T(0, 0.45, -0.3), CER, sm);
  } else {
    smooth.add(rboxGeo(0.44, 0.5, 0.18, 0.06), T(0, 0.35, -0.26), bodyHex, body);
    smooth.add(new THREE.CylinderGeometry(0.23, 0.17, 0.3, 18), T(0, 0.25, 0.02), bodyHex, body);
    smooth.add(
      new THREE.TorusGeometry(0.22, 0.03, 8, 24),
      T(0, 0.42, 0.02, PI / 2, 0, 0),
      gold ? 0xb8322c : bodyHex,
      gold ? { flatShading: false, roughness: 0.9 } : sm,
    );
    smooth.add(new THREE.CylinderGeometry(0.171, 0.171, 0.02, 18), T(0, 0.42, 0.02), WATER_BOWL, { flatShading: false, roughness: 0.1 });
    if (level >= 4) {
      flat.add(boxGeo(0.08, 0.22, 0.3), T(0.3, 0.42, 0), 0x2b3238);
      flat.add(boxGeo(0.2, 0.02, 0.1), T(0, 0.61, -0.26), 0x101417);
      const strip = new THREE.Mesh(
        new THREE.TorusGeometry(0.25, 0.01, 6, 24).rotateX(PI / 2).translate(0, 0.455, 0.02),
        own(new THREE.MeshStandardMaterial({ color: 0x39d7ff, emissive: 0x39d7ff, emissiveIntensity: 1.5 })),
      );
      extra.add(shadowed(strip));
    }
    if (gold) {
      smooth.add(new THREE.SphereGeometry(0.07, 14, 10), T(0, 0.66, -0.26), 0xe8b93a, body);
    }
  }

  const parts = new THREE.Group();
  for (const m of flat.meshes()) parts.add(m);
  for (const m of smooth.meshes()) parts.add(m);
  parts.add(extra);
  parts.scale.setScalar(TOILET_SCALE);
  const g = new THREE.Group();
  g.add(parts);
  if (withClutter) g.add(clutterGroup());
  return g;
}

export function barrier(): THREE.Group {
  const flat = new Batch();
  for (const sx of [-0.5, 0.5]) {
    for (const sz of [-0.5, 0.5]) flat.add(boxGeo(0.07, 0.8, 0.07), T(sx, 0.5, sz), 0x1d1d1d);
  }
  flat.add(boxGeo(0.3, 0.14, 0.16), T(0.3, 0.17, 0.3), 0xb8322c);
  const rails = new Batch();
  rails.add(boxGeo(1.0, 0.14, 0.07), T(0, 0.45, -0.5), 0xffffff);
  rails.add(boxGeo(1.0, 0.14, 0.07), T(0, 0.45, 0.5), 0xffffff);
  rails.add(boxGeo(0.07, 0.14, 1.0), T(-0.5, 0.45, 0), 0xffffff);
  rails.add(boxGeo(0.07, 0.14, 1.0), T(0.5, 0.45, 0), 0xffffff);
  const g = new THREE.Group();
  for (const m of flat.meshes()) g.add(m);
  for (const m of rails.meshes(() => own(new THREE.MeshStandardMaterial({ map: stripeTex(), roughness: 0.7 })))) g.add(m);
  return g;
}

export function sandbagWall(alongX: boolean, seed: number): THREE.Group {
  const layers: Array<{ y: number; bags: Array<{ d: number; o: number }> }> = [
    { y: 0.11, bags: [{ d: -0.25, o: 0 }, { d: 0.25, o: 0 }] },
    { y: 0.3, bags: [{ d: -0.25, o: 0.02 }, { d: 0.25, o: 0.02 }] },
    { y: 0.49, bags: [{ d: 0, o: 0.02 }] },
  ];
  const g = new THREE.Group();
  layers.forEach((layer, li) => {
    const batch = new Batch();
    layer.bags.forEach((bag, bi) => {
      const k = li * 4 + bi;
      const rot = (alongX ? 0 : PI / 2) + (rand01(seed, k, li, 41) - 0.5) * 0.3;
      const x = alongX ? bag.d : bag.o;
      const z = alongX ? bag.o : bag.d;
      const color = BAG_COLORS[Math.floor(rand01(seed, k, li, 42) * BAG_COLORS.length)];
      batch.add(rboxGeo(0.52, 0.2, 0.36, 0.09), T(x, layer.y, z, 0, rot, 0), color, { flatShading: false, roughness: 0.9 });
    });
    const layerGroup = new THREE.Group();
    for (const m of batch.meshes()) layerGroup.add(m);
    g.add(layerGroup);
  });
  return g;
}

export function gate(alongX: boolean): THREE.Group {
  const posts = new Batch();
  for (const px of [-0.46, 0.46]) posts.add(boxGeo(0.12, 1.0, 0.12), T(px, 0.5, 0), DEEP_WOOD);
  const leaf = new Batch();
  for (let i = 0; i < 5; i++) leaf.add(boxGeo(0.05, 0.9, 0.04), T(0.02 + i * 0.19, 0.5, 0), 0x7a583a);
  leaf.add(boxGeo(0.8, 0.05, 0.04), T(0.4, 0.25, 0), 0x7a583a);
  leaf.add(boxGeo(0.8, 0.05, 0.04), T(0.4, 0.75, 0), 0x7a583a);
  const pivot = new THREE.Group();
  pivot.position.set(-0.4, 0, 0);
  for (const m of leaf.meshes()) pivot.add(m);
  const g = new THREE.Group();
  for (const m of posts.meshes()) g.add(m);
  g.add(pivot);
  g.rotation.y = alongX ? 0 : PI / 2;
  const sign = single(boxGeo(0.34, 0.05, 0.22), SIGN_RED, { emissive: SIGN_RED, emissiveIntensity: SIGN_LIT }, T(0, 1.025, 0));
  g.add(sign);
  g.userData.pivot = pivot;
  g.userData.sign = sign;
  return g;
}

export function signalLamp(): THREE.Group {
  const pole = single(new THREE.CylinderGeometry(0.02, 0.02, 1.35, 6), IRON, undefined, T(0, 0.675, 0));
  const mat = own(new THREE.MeshStandardMaterial({ color: LAMP_IDLE, emissive: LAMP_IDLE, emissiveIntensity: 0.5, roughness: 0.5 }));
  const ball = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10).translate(0, 1.35, 0), mat));
  const halo = new THREE.Sprite(
    own(
      new THREE.SpriteMaterial({
        map: haloTex(),
        color: LAMP_IDLE,
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    ),
  );
  halo.scale.set(0.9, 0.9, 1);
  halo.position.set(0, 1.35, 0);
  const g = group(pole, ball, halo);
  g.userData.mat = mat;
  g.userData.halo = halo;
  return g;
}

export function roof(palette: readonly [number, number]): { group: THREE.Group; materials: THREE.Material[] } {
  const [tin, rib] = palette;
  const batch = new Batch();
  const k = 3.3 / 3.7;
  for (const s of [-1, 1]) {
    const half = new THREE.Matrix4().multiply(T(s * 0.815, 0.393, 0)).multiply(new THREE.Matrix4().makeRotationZ(-s * 0.3));
    batch.add(boxGeo(1.78, 0.06, 3.3), half.clone(), tin);
    for (let i = 0; i < 15; i++) {
      batch.add(boxGeo(1.78, 0.035, 0.09), half.clone().multiply(T(0, 0.045, -1.65 + (i * 3.3) / 14)), rib);
    }
  }
  batch.add(boxGeo(0.16, 0.07, 3.34), T(0, ROOF_RIDGE, 0), rib);
  const tri = new THREE.Shape();
  tri.moveTo(-1.5 * k, 0);
  tri.lineTo(1.5 * k, 0);
  tri.lineTo(0, 0.52 * k);
  tri.lineTo(-1.5 * k, 0);
  for (const z of [1.44 * k, -1.44 * k]) batch.add(new THREE.ShapeGeometry(tri), T(0, 0.02, z), 0x6c4d33);
  batch.add(rboxGeo(0.5, 0.2, 0.34, 0.09), T(0.9, 0.46, -0.9, 0, 0.5, -0.3), 0x6f5340);
  batch.add(boxGeo(0.7, 0.03, 0.5), T(-0.8, 0.5, 0.6, 0.05, 0.4, 0.3), 0x4d6f78);
  batch.add(boxGeo(0.8, 0.46, 0.05), T(0, 0.3, 1.5), RAIL);

  const roofMat = own(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      metalness: 0.35,
      roughness: 0.6,
    }),
  );
  const signMat = own(
    new THREE.MeshStandardMaterial({ map: textTexture('WC', '#e9e4da', '#33383a', 96, 56), transparent: true, roughness: 1 }),
  );
  const g = new THREE.Group();
  for (const m of batch.meshes(() => roofMat)) g.add(m);
  g.add(shadowed(new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.38).translate(0, 0.3, 1.53), signMat)));
  return { group: g, materials: [roofMat, signMat] };
}

const GOLD = 0xffcf40;
const GOLD_MAT: MatParams = { emissive: GOLD, emissiveIntensity: 0.35 };
const FLAG_LIT = 0.35;
const BADGE_SPACING = 0.15;

export function levelBadge(level: number): THREE.Group {
  const plate = single(boxGeo(0.9, 0.3, 0.04), level === 5 ? GOLD : DEEP_WOOD, level === 5 ? GOLD_MAT : undefined);
  const dots = new Batch();
  for (let i = 0; i < level; i++) {
    dots.add(new THREE.SphereGeometry(0.065, 10, 8), T((i - (level - 1) / 2) * BADGE_SPACING, 0, 0.03), GOLD);
  }
  const g = new THREE.Group();
  g.add(plate);
  for (const m of dots.meshes(() => S(GOLD, GOLD_MAT))) g.add(m);
  g.rotation.x = -0.5;
  return g;
}

export function flagMaterial(open: boolean): THREE.MeshStandardMaterial {
  const hex = open ? SIGN_GREEN : SIGN_RED;
  return S(hex, { emissive: hex, emissiveIntensity: FLAG_LIT });
}

export function doorFlag(height: number): THREE.Group {
  const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, height, 6).translate(0, height / 2, 0), S(DEEP_WOOD)));
  const cloth = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.02).translate(0.15, height - 0.1, 0), flagMaterial(true)));
  const g = new THREE.Group();
  g.add(pole, cloth);
  g.userData.cloth = cloth;
  return g;
}

export function signMaterial(open: boolean): THREE.MeshStandardMaterial {
  const hex = open ? SIGN_GREEN : SIGN_RED;
  return S(hex, { emissive: hex, emissiveIntensity: SIGN_LIT });
}

export function roofPalette(worldId: number, x: number, y: number): readonly [number, number] {
  const palettes: ReadonlyArray<readonly [number, number]> = [
    [0x58808a, 0x44656e],
    [0x9a5038, 0x7a3d2a],
    [0xb08f3a, 0x8c7029],
  ];
  return palettes[Math.floor(rand01(worldId, x, y, 7) * palettes.length)];
}

export function shackSeed(worldId: number, x: number, y: number, salt: number): number {
  return hash32(worldId, x, y, salt);
}
