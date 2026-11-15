import * as THREE from 'three';

const FOV = 24;
const NEAR = 1;
const FAR = 400;
const VIEW_DIR = new THREE.Vector3(0, 30, 19).normalize();
const FRAME_LIMIT = 0.96;
const CLICK_PX = 5;

export function fitDistance(W: number, H: number, aspect: number): number {
  const cam = new THREE.PerspectiveCamera(FOV, aspect, NEAR, FAR);
  const center = new THREE.Vector3(W / 2, 0, H / 2);
  const corners = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(W, 0, 0),
    new THREE.Vector3(0, 0, H),
    new THREE.Vector3(W, 0, H),
  ];
  const fits = (d: number): boolean => {
    cam.position.copy(center).addScaledVector(VIEW_DIR, d);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    return corners.every((c) => {
      const v = c.clone().project(cam);
      return Math.abs(v.x) <= FRAME_LIMIT && Math.abs(v.y) <= FRAME_LIMIT;
    });
  };
  let lo = 0.5;
  let hi = FAR;
  if (!fits(hi)) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function fitHeightDistance(W: number, H: number, aspect: number, frac: number): number {
  const cam = new THREE.PerspectiveCamera(FOV, aspect, NEAR, FAR);
  const center = new THREE.Vector3(W / 2, 0, H / 2);
  const corners = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, H),
    new THREE.Vector3(W, 0, 0),
    new THREE.Vector3(W, 0, H),
  ];
  const fits = (d: number): boolean => {
    cam.position.copy(center).addScaledVector(VIEW_DIR, d);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    return corners.every((c) => Math.abs(c.clone().project(cam).y) <= frac);
  };
  let lo = 0.5;
  let hi = FAR;
  if (!fits(hi)) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export class CameraControls {
  readonly camera: THREE.PerspectiveCamera;
  private readonly center: THREE.Vector3;
  private readonly focus: THREE.Vector3;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 0.9 : 1.1);
  };
  private readonly onDown = (e: PointerEvent): void => this.down(e);
  private readonly onMove = (e: PointerEvent): void => this.move(e);
  private readonly onUp = (e: PointerEvent): void => this.up(e);
  private fit: number;
  private home: number;
  private dist: number;
  private anchor: THREE.Vector3 | null = null;
  private downX = 0;
  private downY = 0;
  private pinching = false;
  private pinchPrev = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly W: number,
    private readonly H: number,
    private readonly onClick: (x: number, y: number) => void,
    still: boolean,
  ) {
    this.center = new THREE.Vector3(W / 2, 0, H / 2);
    this.focus = this.center.clone();
    this.camera = new THREE.PerspectiveCamera(FOV, this.aspect(), NEAR, FAR);
    this.fit = fitDistance(W, H, this.aspect());
    this.home = this.homeDistance(this.aspect());
    this.dist = this.home;
    this.apply();
    if (!still) {
      canvas.style.touchAction = 'none';
      canvas.addEventListener('wheel', this.onWheel, { passive: false });
      canvas.addEventListener('pointerdown', this.onDown);
      canvas.addEventListener('pointermove', this.onMove);
      canvas.addEventListener('pointerup', this.onUp);
      canvas.addEventListener('pointercancel', this.onUp);
    }
  }

  apply(): void {
    this.camera.position.copy(this.focus).addScaledVector(VIEW_DIR, this.dist);
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
  }

  resize(): void {
    const ratio = this.dist / this.fit;
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    this.fit = fitDistance(this.W, this.H, this.camera.aspect);
    this.home = this.homeDistance(this.camera.aspect);
    this.dist = ratio * this.fit;
    this.apply();
  }

  reset(): void {
    this.focus.copy(this.center);
    this.dist = this.home;
    this.apply();
  }

  setFocus(x: number, z: number): void {
    this.focus.set(x, 0, z);
    this.clampFocus();
    this.apply();
  }

  setZoom(k: number): void {
    this.dist = this.fit * Math.min(1, Math.max(0.3, k));
    this.apply();
  }

  dispose(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
  }

  private aspect(): number {
    return this.canvas.clientWidth / this.canvas.clientHeight || 1;
  }

  private homeDistance(aspect: number): number {
    if (aspect >= 1) return this.fit;
    return Math.min(fitHeightDistance(this.W, this.H, aspect, 0.8), this.fit);
  }

  private zoomBy(f: number): void {
    this.dist = Math.min(this.fit, Math.max(0.3 * this.fit, this.dist * f));
    this.apply();
  }

  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray.ray.intersectPlane(this.plane, new THREE.Vector3());
  }

  private clampFocus(): void {
    this.focus.x = Math.min(this.W, Math.max(0, this.focus.x));
    this.focus.z = Math.min(this.H, Math.max(0, this.focus.z));
  }

  private down(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.anchor = this.groundAt(e.clientX, e.clientY);
    } else if (this.pointers.size === 2) {
      this.pinching = true;
      this.pinchPrev = this.pinchDistance();
    }
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pinching) {
      if (this.pointers.size !== 2) return;
      const d = this.pinchDistance();
      this.dist = Math.min(this.fit, Math.max(0.3 * this.fit, this.dist * (this.pinchPrev / d)));
      this.pinchPrev = d;
      this.apply();
      return;
    }
    if (!this.anchor) return;
    const cur = this.groundAt(e.clientX, e.clientY);
    if (!cur) return;
    this.focus.x += this.anchor.x - cur.x;
    this.focus.z += this.anchor.z - cur.z;
    this.clampFocus();
    this.apply();
  }

  private up(e: PointerEvent): void {
    const wasSingle = this.pointers.size === 1 && !this.pinching;
    this.pointers.delete(e.pointerId);
    if (wasSingle && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < CLICK_PX) {
      this.onClick(e.clientX, e.clientY);
    }
    if (this.pointers.size === 0) this.pinching = false;
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }
}

export function pick(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  pickables: Map<THREE.Object3D, number>,
): number | null {
  if (pickables.size === 0) return null;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([...pickables.keys()], true);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    while (o) {
      const id = pickables.get(o);
      if (id !== undefined) return id;
      o = o.parent;
    }
  }
  return null;
}
