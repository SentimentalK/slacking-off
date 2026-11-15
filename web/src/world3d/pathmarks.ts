import * as THREE from 'three';
import type { FrameInput, Layer, SceneCtx } from './types';

const DOT_RADIUS = 0.09;
const DOT_SEGMENTS = 12;
const DOT_Y = 0.04;
const RING_INNER = 0.32;
const RING_OUTER = 0.42;
const RING_SEGMENTS = 28;
const RING_Y = 0.04;
const CAPACITY = 256;
const GOLD = 0xffcf40;
const HALF_PI = Math.PI / 2;

export function createPathMarksLayer(ctx: SceneCtx): Layer {
  const root = new THREE.Group();
  ctx.world.add(root);
  const dotGeo = new THREE.CircleGeometry(DOT_RADIUS, DOT_SEGMENTS).rotateX(-HALF_PI);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
  const dots = new THREE.InstancedMesh(dotGeo, dotMat, CAPACITY);
  dots.count = 0;
  dots.frustumCulled = false;
  root.add(dots);
  const ringGeo = new THREE.RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS).rotateX(-HALF_PI);
  const ringMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.95, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  root.add(ring);
  const m = new THREE.Matrix4();

  return {
    update(input: FrameInput) {
      const path = input.ui.path;
      root.visible = path !== undefined && path !== null && path.length > 0;
      if (!path || path.length === 0) return;
      const n = Math.min(path.length, CAPACITY);
      for (let i = 0; i < n; i++) {
        m.makeTranslation(path[i].x + 0.5, DOT_Y, path[i].y + 0.5);
        dots.setMatrixAt(i, m);
      }
      dots.count = n;
      dots.instanceMatrix.needsUpdate = true;
      const end = path[path.length - 1];
      ring.position.set(end.x + 0.5, RING_Y, end.y + 0.5);
    },
    dispose() {
      dotGeo.dispose();
      dotMat.dispose();
      dots.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      root.removeFromParent();
    },
  };
}
