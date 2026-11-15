import * as THREE from 'three';

const PI = Math.PI;
const SERVO = 0x1c1d21;
const STEEL = 0x9a9da3;
const TIE = 0xb8322c;
const SCALE = 0.47 / 0.36;

let sharedBody: THREE.MeshStandardMaterial | null = null;

function bodyMaterial(): THREE.MeshStandardMaterial {
  if (!sharedBody) sharedBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
  return sharedBody;
}

function rboxGeometry(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
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

function xform(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

class Batch {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly v = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly nm = new THREE.Matrix3();

  add(src: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.ColorRepresentation): void {
    const g = src.index ? src.toNonIndexed() : src;
    const p = g.getAttribute('position');
    const nn = g.getAttribute('normal');
    this.nm.getNormalMatrix(m);
    const c = new THREE.Color(color);
    for (let i = 0; i < p.count; i++) {
      this.v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.n.fromBufferAttribute(nn, i).applyNormalMatrix(this.nm);
      this.nor.push(this.n.x, this.n.y, this.n.z);
      this.col.push(c.r, c.g, c.b);
    }
    if (g !== src) g.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

function meshOf(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export interface Duck {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  lens: THREE.Mesh;
  hit: THREE.Mesh;
}

export function buildDuck(shell: THREE.ColorRepresentation, accent: THREE.ColorRepresentation): Duck {
  const BODY_FRAME = xform(0, -0.28, 0);
  const bodyB = new Batch();
  const headB = new Batch();
  const lensB = new Batch();

  const tor = rboxGeometry(0.36, 0.2, 0.3, 0.08);
  bodyB.add(tor, BODY_FRAME.clone().multiply(xform(0, 0.5, -0.03)), shell);
  tor.dispose();

  const hipServo = new THREE.BoxGeometry(0.3, 0.11, 0.13);
  bodyB.add(hipServo, BODY_FRAME.clone().multiply(xform(0, 0.35, 0)), SERVO);
  hipServo.dispose();

  for (const d of [-0.06, 0, 0.06]) {
    const vent = new THREE.CylinderGeometry(0.012, 0.012, 0.01, 6);
    bodyB.add(vent, BODY_FRAME.clone().multiply(xform(d, 0.605, -0.1)), SERVO);
    vent.dispose();
  }

  const neck = BODY_FRAME.clone().multiply(xform(0, 0.6, 0.02, 0.22));
  const neckA = new THREE.BoxGeometry(0.1, 0.15, 0.1);
  bodyB.add(neckA, neck.clone().multiply(xform(0, 0.07, 0)), SERVO);
  neckA.dispose();
  const neckB = new THREE.BoxGeometry(0.085, 0.14, 0.085);
  bodyB.add(neckB, neck.clone().multiply(xform(0, 0.22, 0)), SERVO);
  neckB.dispose();
  const neckC = new THREE.CylinderGeometry(0.04, 0.04, 0.11, 8);
  bodyB.add(neckC, neck.clone().multiply(xform(0, 0.15, 0, 0, 0, PI / 2)), STEEL);
  neckC.dispose();

  const tie = new THREE.BoxGeometry(0.05, 0.15, 0.015);
  bodyB.add(tie, BODY_FRAME.clone().multiply(xform(0, 0.5, 0.125)), TIE);
  tie.dispose();

  const shellHead = rboxGeometry(0.3, 0.24, 0.44, 0.1);
  headB.add(shellHead, xform(0, 0.04, 0), shell);
  shellHead.dispose();

  for (const s of [-1, 1]) {
    const plate = rboxGeometry(0.02, 0.17, 0.3, 0.008);
    headB.add(plate, xform(s * 0.15, 0.04, 0), STEEL);
    plate.dispose();
    const ring = new THREE.TorusGeometry(0.058, 0.026, 8, 18);
    headB.add(ring, xform(s * 0.166, 0.05, 0.04, 0, PI / 2, 0), accent);
    ring.dispose();
    const lens = new THREE.SphereGeometry(0.042, 18, 12);
    lensB.add(lens, xform(s * 0.166, 0.05, 0.04, 0, 0, 0, 0.5, 1, 1), 0xffffff);
    lens.dispose();
  }

  const billA = rboxGeometry(0.3, 0.035, 0.3, 0.012);
  headB.add(billA, xform(0, -0.07, 0.24), accent);
  billA.dispose();
  const billB = rboxGeometry(0.27, 0.03, 0.24, 0.012);
  headB.add(billB, xform(0, -0.115, 0.2, 0.08), accent);
  billB.dispose();

  const root = new THREE.Group();
  root.scale.setScalar(SCALE);

  const body = new THREE.Group();
  body.position.set(0, 0.28, 0);
  root.add(body);
  body.add(meshOf(bodyB.build(), bodyMaterial()));

  const head = new THREE.Group();
  head.position.set(0, 0.7, 0.12);
  body.add(head);
  head.add(meshOf(headB.build(), bodyMaterial()));

  const lens = meshOf(
    lensB.build(),
    new THREE.MeshStandardMaterial({
      color: 0x0b0c10,
      roughness: 0.1,
      emissive: 0x39d7ff,
      emissiveIntensity: 0.25,
    }),
  );
  head.add(lens);

  const legs = ([-0.13, 0.13] as const).map((dx) => {
    const sgn = dx < 0 ? -1 : 1;
    const LEG = xform(-dx, -0.28, 0);
    const b = new Batch();
    const foot = rboxGeometry(0.17, 0.08, 0.26, 0.035);
    b.add(foot, LEG.clone().multiply(xform(dx, 0.04, 0.05)), accent);
    foot.dispose();
    const servo = new THREE.BoxGeometry(0.08, 0.2, 0.09);
    b.add(servo, LEG.clone().multiply(xform(dx, 0.17, 0)), SERVO);
    servo.dispose();
    const axle = new THREE.CylinderGeometry(0.045, 0.045, 0.1, 10);
    b.add(axle, LEG.clone().multiply(xform(dx, 0.28, 0, 0, 0, PI / 2)), STEEL);
    axle.dispose();
    const thigh = rboxGeometry(0.05, 0.24, 0.2, 0.02);
    b.add(thigh, LEG.clone().multiply(xform(dx + sgn * 0.07, 0.3, -0.03, 0.35)), shell);
    thigh.dispose();
    const group = new THREE.Group();
    group.position.set(dx, 0.28, 0);
    root.add(group);
    group.add(meshOf(b.build(), bodyMaterial()));
    return group;
  });

  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(0.5 / SCALE, 1.4 / SCALE, 0.5 / SCALE),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.set(0, 0.7 / SCALE, 0);
  root.add(hit);

  return { root, body, head, legL: legs[0], legR: legs[1], lens, hit };
}

export function disposeDuck(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    if (o.material !== sharedBody) (o.material as THREE.Material).dispose();
  });
}
