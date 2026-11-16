import * as THREE from 'three';
import type { FrameInput, RenderSettings, UiState } from './types';

const SUN_DAY = new THREE.Color(0xffdfae);
const SUN_DUSK = new THREE.Color(0xff7a3a);
const HEM_DAY = new THREE.Color(0xa9c4ff);
const HEM_DUSK = new THREE.Color(0x4a50a8);
const GND_DAY = new THREE.Color().setRGB(0x2f / 255, 0x3d / 255, 0x1c / 255, THREE.LinearSRGBColorSpace); // r128 used these as linear values
const SUN_DIST = 60;
const SUN_DIR = new THREE.Vector3();

export function duskK(ui: UiState, clock: number): number {
  if (ui.duskT <= 0) return ui.dusk ? 1 : 0;
  const t = Math.min(1, Math.max(0, (clock - ui.duskT) / 0.6));
  const s = t * t * (3 - 2 * t);
  return ui.dusk ? s : 1 - s;
}

export interface Lighting {
  update(input: FrameInput, settings: RenderSettings): void;
}

export function createLighting(scene: THREE.Scene): Lighting {
  const hemi = new THREE.HemisphereLight(HEM_DAY, GND_DAY, 0.42 * Math.PI);
  const sun = new THREE.DirectionalLight(SUN_DAY, 2.6 * Math.PI);
  scene.add(hemi, sun, sun.target);
  let mapShadow = 0;
  sun.shadow.radius = 3;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.08;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;

  return {
    update(input, settings) {
      const k = duskK(input.ui, input.clock);
      const W = input.terrain.width;
      const H = input.terrain.height;
      const cx = W / 2;
      const cz = H / 2;

      sun.color.copy(SUN_DAY).lerp(SUN_DUSK, k);
      sun.intensity = (2.6 - 1.75 * k) * Math.PI;
      hemi.color.copy(HEM_DAY).lerp(HEM_DUSK, k);
      hemi.groundColor.copy(GND_DAY);
      hemi.intensity = (0.42 - 0.14 * k) * Math.PI;
      SUN_DIR.set(-12 - 6 * k, 13 - 8 * k, 5).normalize();
      sun.position.set(cx + SUN_DIR.x * SUN_DIST, SUN_DIR.y * SUN_DIST, cz + SUN_DIR.z * SUN_DIST);
      sun.target.position.set(cx, 0, cz);
      sun.target.updateMatrixWorld();

      sun.castShadow = settings.shadow > 0;
      if (settings.shadow > 0 && settings.shadow !== mapShadow) {
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
        sun.shadow.mapSize.set(settings.shadow, settings.shadow);
        mapShadow = settings.shadow;
      }
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
