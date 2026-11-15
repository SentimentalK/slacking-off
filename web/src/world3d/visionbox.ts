import * as THREE from 'three';
import type { FrameInput, Layer, SceneCtx } from './types';

const RADIUS = 4;
const GOLD = 0xffcf40;
const LINE_W = 0.08;
const LINE_H = 0.04;
const LINE_Y = 0.035;
const FILL_Y = 0.02;
const HALF_PI = Math.PI / 2;

export function createVisionBoxLayer(ctx: SceneCtx): Layer {
  const root = new THREE.Group();
  ctx.world.add(root);
  const lineGeo = new THREE.BoxGeometry(1, LINE_H, LINE_W);
  const lineMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.9, depthWrite: false });
  const fillGeo = new THREE.PlaneGeometry(1, 1).rotateX(-HALF_PI);
  const fillMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.07, depthWrite: false });
  const lines = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(lineGeo, lineMat);
    root.add(m);
    return m;
  });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  root.add(fill);

  const placeX = (m: THREE.Mesh, x: number, z: number, len: number): void => {
    m.rotation.y = 0;
    m.position.set(x, LINE_Y, z);
    m.scale.set(len, 1, 1);
  };
  const placeZ = (m: THREE.Mesh, x: number, z: number, len: number): void => {
    m.rotation.y = HALF_PI;
    m.position.set(x, LINE_Y, z);
    m.scale.set(len, 1, 1);
  };

  return {
    update(input: FrameInput) {
      const id = input.ui.visionOf;
      const a = id == null ? undefined : input.cur.agents.find((agent) => agent.id === id);
      root.visible = a !== undefined;
      if (!a) return;
      const W = input.terrain.width;
      const H = input.terrain.height;
      const x0 = Math.max(0, a.pos.x - RADIUS);
      const x1 = Math.min(W - 1, a.pos.x + RADIUS);
      const y0 = Math.max(0, a.pos.y - RADIUS);
      const y1 = Math.min(H - 1, a.pos.y + RADIUS);
      const left = x0;
      const right = x1 + 1;
      const top = y0;
      const bottom = y1 + 1;
      const spanX = right - left;
      const spanZ = bottom - top;
      placeX(lines[0], (left + right) / 2, top, spanX);
      placeX(lines[1], (left + right) / 2, bottom, spanX);
      placeZ(lines[2], left, (top + bottom) / 2, spanZ);
      placeZ(lines[3], right, (top + bottom) / 2, spanZ);
      fill.position.set((left + right) / 2, FILL_Y, (top + bottom) / 2);
      fill.scale.set(spanX, 1, spanZ);
    },
    dispose() {
      lineGeo.dispose();
      lineMat.dispose();
      fillGeo.dispose();
      fillMat.dispose();
      root.removeFromParent();
    },
  };
}
