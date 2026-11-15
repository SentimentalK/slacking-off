import * as THREE from 'three';
import { S, BARK, NEEDLE_COLORS } from './materials';
import type { PartDef } from './instancer';

const PI = Math.PI;
const Y = new THREE.Vector3(0, 1, 0);

function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.toNonIndexed();
  n.computeVertexNormals();
  return n;
}

export function local(px: number, py: number, pz: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
}

export function yaw(a: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(a);
}

export function place(x: number, y: number, z: number, rotY: number, s: number | THREE.Vector3): THREE.Matrix4 {
  const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : s;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(Y, rotY),
    sc,
  );
}

function tierGeo(r: number, h: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, 12);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), rr = Math.hypot(x, z);
    if (y < -h / 2 + 1e-3 && rr > 1e-4) {
      const a = Math.round((Math.atan2(z, x) + PI) / (PI / 6));
      if (a % 2) {
        p.setX(i, x * 0.7);
        p.setZ(i, z * 0.7);
        p.setY(i, y + h * 0.2);
      } else p.setY(i, y - h * 0.06);
    }
  }
  return flat(g);
}

const TIER_GEOS = [0, 1, 2, 3, 4].map((i) => tierGeo(0.95 - i * 0.17, 0.85));
const TIER_MATS = NEEDLE_COLORS.map((c) => S(c));
const BARK_MAT = S(BARK);
const TRUNK_GEO = new THREE.CylinderGeometry(0.12, 0.18, 0.7, 7);

export const PINE_PARTS: PartDef[] = [
  { geo: TRUNK_GEO, mat: BARK_MAT, shadow: true },
  ...TIER_GEOS.map((g, i) => ({ geo: g, mat: TIER_MATS[i], shadow: true })),
];

export function pineMatrices(root: THREE.Matrix4, tierYaw: (i: number) => number): THREE.Matrix4[] {
  const mats = [root.clone().multiply(local(0, 0.35, 0))];
  for (let i = 0; i < TIER_GEOS.length; i++) {
    mats.push(root.clone().multiply(local(0, 0.75 + i * 0.44, 0)).multiply(yaw(tierYaw(i))));
  }
  return mats;
}

const GRASS_GEO = (() => {
  const g = new THREE.ConeGeometry(0.04, 0.26, 3);
  g.translate(0, 0.13, 0);
  return g;
})();

export const GRASS_PARTS: PartDef[] = [{ geo: GRASS_GEO, mat: S(0xffffff, { roughness: 1 }), shadow: false }];

export const GRASS_COLORS = [0x4a6f28, 0x577f2e, 0x40611d, 0x648f36, 0x6f9a3c, 0x38561b];

const BOULDER_GEOS = [
  { geo: flat(new THREE.IcosahedronGeometry(0.4, 0)), mat: S(0x55535e), local: local(0, 0.176, 0, 1.1, 0.75, 0.95) },
  { geo: flat(new THREE.IcosahedronGeometry(0.32, 0)), mat: S(0x5d8a2e), local: local(0.024, 0.336, -0.016, 1.05, 0.4, 0.9) },
  { geo: flat(new THREE.IcosahedronGeometry(0.176, 0)), mat: S(0x625f6b), local: local(0.336, 0.1, 0.2) },
];

export const BOULDER_PARTS: PartDef[] = BOULDER_GEOS.map((b) => ({ geo: b.geo, mat: b.mat, shadow: true }));
export const BOULDER_LOCAL = BOULDER_GEOS.map((b) => b.local);

const BARREL_PARTS_DEF = [
  { geo: new THREE.CylinderGeometry(0.27, 0.25, 0.66, 14), mat: S(0xbdb5a8, { flatShading: false }), local: local(0, 0.33, 0) },
  { geo: new THREE.CylinderGeometry(0.275, 0.275, 0.2, 14), mat: S(0x9a3a30, { flatShading: false }), local: local(0, 0.32, 0) },
  { geo: new THREE.CylinderGeometry(0.24, 0.24, 0.02, 14), mat: S(0x8c867c), local: local(0, 0.665, 0) },
];

export const BARREL_PARTS: PartDef[] = BARREL_PARTS_DEF.map((b) => ({ geo: b.geo, mat: b.mat, shadow: true }));
export const BARREL_LOCAL = BARREL_PARTS_DEF.map((b) => b.local);

const CRATE_PARTS_DEF = [
  { geo: new THREE.BoxGeometry(0.64, 0.56, 0.64), mat: S(0x8a623c), local: local(0, 0.28, 0) },
  { geo: new THREE.BoxGeometry(0.07, 0.6, 0.68), mat: S(0x5e422a), local: local(-0.3, 0.29, 0) },
  { geo: new THREE.BoxGeometry(0.07, 0.6, 0.68), mat: S(0x5e422a), local: local(0.3, 0.29, 0) },
  { geo: new THREE.BoxGeometry(0.68, 0.07, 0.68), mat: S(0x5e422a), local: local(0, 0.56, 0) },
];

export const CRATE_PARTS: PartDef[] = CRATE_PARTS_DEF.map((b) => ({ geo: b.geo, mat: b.mat, shadow: true }));
export const CRATE_LOCAL = CRATE_PARTS_DEF.map((b) => b.local);

export const LAMP_BULB_MAT = new THREE.MeshStandardMaterial({
  color: 0xfff1c2,
  roughness: 0.88,
  emissive: 0xffb860,
  emissiveIntensity: 0.2,
});

const LAMP_PARTS_DEF = [
  { geo: new THREE.CylinderGeometry(0.04, 0.06, 1.7, 7), mat: S(0x4a3526), local: local(0, 0.85, 0), shadow: true },
  { geo: new THREE.BoxGeometry(0.4, 0.04, 0.04), mat: S(0x4a3526), local: local(0.17, 1.66, 0), shadow: true },
  { geo: new THREE.CylinderGeometry(0.005, 0.005, 0.16, 4), mat: S(0x1d1d1d), local: local(0.34, 1.57, 0), shadow: true },
  { geo: new THREE.SphereGeometry(0.085, 18, 12), mat: LAMP_BULB_MAT, local: local(0.34, 1.45, 0), shadow: true },
  { geo: new THREE.ConeGeometry(0.15, 0.1, 10, 1, true), mat: S(0x33383a, { side: THREE.DoubleSide }), local: local(0.34, 1.54, 0), shadow: true },
];

export const LAMP_PARTS: PartDef[] = LAMP_PARTS_DEF.map((b) => ({ geo: b.geo, mat: b.mat, shadow: b.shadow }));
export const LAMP_LOCAL = LAMP_PARTS_DEF.map((b) => b.local);

export const STUMP_GEO = new THREE.CylinderGeometry(0.18, 0.18, 0.25, 8);
export const STUMP_PARTS: PartDef[] = [{ geo: STUMP_GEO, mat: S(0x4a3526), shadow: true }];
