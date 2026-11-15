import * as THREE from 'three';
import type { FrameInput, Quality, UiState } from './types';

const SUN_DAY = new THREE.Color(0xffdfae);
const SUN_DUSK = new THREE.Color(0xff7a3a);
const HEM_DAY = new THREE.Color(0xa9c4ff);
const HEM_DUSK = new THREE.Color(0x6a6aa0);
const GND_DAY = new THREE.Color(0x2f3d1c);
const GND_DUSK = new THREE.Color(0x3a3a1c);

export function duskK(ui: UiState, clock: number): number {
  if (ui.duskT <= 0) return ui.dusk ? 1 : 0;
  const t = Math.min(1, Math.max(0, (clock - ui.duskT) / 0.6));
  const s = t * t * (3 - 2 * t);
  return ui.dusk ? s : 1 - s;
}

export interface Lighting {
  update(input: FrameInput, quality: Quality): void;
}

export function createLighting(scene: THREE.Scene): Lighting {
  const hemi = new THREE.HemisphereLight(0xa9c4ff, 0x2f3d1c, 0.42 * Math.PI);
  const sun = new THREE.DirectionalLight(0xffdfae, 2.6 * Math.PI);
  scene.add(hemi, sun, sun.target);
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 3;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.08;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;

  return {
    update(input, quality) {
      const k = duskK(input.ui, input.clock);
      const W = input.terrain.width;
      const H = input.terrain.height;
      const cx = W / 2;
      const cz = H / 2;

      sun.color.copy(SUN_DAY).lerp(SUN_DUSK, k);
      sun.intensity = (2.6 - 1.4 * k) * Math.PI;
      hemi.color.copy(HEM_DAY).lerp(HEM_DUSK, k);
      hemi.groundColor.copy(GND_DAY).lerp(GND_DUSK, k);
      hemi.intensity = (0.42 - 0.08 * k) * Math.PI;
      sun.position.set(cx - 20 - 10 * k, 32 - 14 * k, cz + 12);
      sun.target.position.set(cx, 0, cz);
      sun.target.updateMatrixWorld();

      sun.castShadow = quality === 'high';
      const r = Math.max(W, H) / 2 + 3;
      const cam = sun.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.updateProjectionMatrix();
    },
  };
}
