import * as THREE from 'three';
import type { Terrain } from '../types';
import { CameraControls, pick } from './camera';
import { createAgentsLayer } from './agents';
import { createDecor } from './decor';
import { createForest } from './forest';
import { createObjectsLayer } from './objects';
import { createGround } from './ground';
import { createLighting } from './lighting';
import type { FrameInput, Layer, Quality, SceneCtx } from './types';

export type { FrameInput, Layer, Quality, SceneCtx, UiState } from './types';
export { chooseQuality, AutoQuality } from './quality';

export interface WorldViewOptions {
  quality: Quality;
  still: boolean;
  onSelect?: (id: number | null) => void;
}

export interface WorldView {
  draw(input: FrameInput): void;
  pick(x: number, y: number): number | null;
  resize(): void;
  setQuality(q: Quality): void;
  capture(): { tick: number; png: string; calls: number; triangles: number };
  dispose(): void;
}

export const extraLayers: Array<(ctx: SceneCtx) => Layer> = [];
extraLayers.push((ctx) => createObjectsLayer(ctx));
extraLayers.push((ctx) => createAgentsLayer(ctx));

const EMPTY_TERRAIN: Terrain = { width: 0, height: 0, entrance: { x: 0, y: 0 }, rows: [] };

export function createWorldView(canvas: HTMLCanvasElement, opts: WorldViewOptions): WorldView {
  let quality: Quality = opts.quality;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c120a);
  const world = new THREE.Group();
  scene.add(world);
  const lighting = createLighting(scene);
  const pickables = new Map<THREE.Object3D, number>();
  const ctx: SceneCtx = {
    scene,
    world,
    quality,
    worldId: 0,
    terrain: EMPTY_TERRAIN,
    pickables,
    camera: new THREE.PerspectiveCamera(),
  };

  let last: FrameInput | null = null;
  let layers: Layer[] = [];
  let builtFor: { terrain: Terrain; worldId: number; quality: Quality } | null = null;
  let controls: CameraControls | null = null;
  let controlsDims = '';

  const applyRenderer = (q: Quality): void => {
    renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    renderer.shadowMap.enabled = q === 'high';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    resize();
  };

  const ensureLayers = (input: FrameInput): void => {
    const terrain = input.terrain;
    const worldId = input.cur.world;
    if (builtFor && builtFor.terrain === terrain && builtFor.worldId === worldId && builtFor.quality === quality) return;
    for (const l of layers) l.dispose();
    layers = [];
    pickables.clear();
    ctx.terrain = terrain;
    ctx.worldId = worldId;
    ctx.quality = quality;
    layers = [createGround(ctx), createForest(ctx), createDecor(ctx), ...extraLayers.map((make) => make(ctx))];
    builtFor = { terrain, worldId, quality };
  };

  const ensureControls = (terrain: Terrain): CameraControls => {
    const dims = terrain.width + 'x' + terrain.height;
    if (controls && controlsDims === dims) return controls;
    controls?.dispose();
    const c: CameraControls = new CameraControls(
      canvas,
      terrain.width,
      terrain.height,
      (x, y) => opts.onSelect?.(pick(c.camera, canvas, x, y, pickables)),
      opts.still,
    );
    controls = c;
    controlsDims = dims;
    return c;
  };

  function resize(): void {
    renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
    controls?.resize();
  }

  applyRenderer(quality);

  return {
    draw(input) {
      last = input;
      const cam = ensureControls(input.terrain);
      ctx.camera = cam.camera;
      ensureLayers(input);
      for (const l of layers) l.update(input, ctx);
      lighting.update(input, quality);
      cam.apply();
      renderer.render(scene, cam.camera);
    },
    pick(x, y) {
      return controls ? pick(controls.camera, canvas, x, y, pickables) : null;
    },
    resize,
    setQuality(q) {
      if (q === quality) return;
      quality = q;
      ctx.quality = q;
      applyRenderer(q);
      if (last) ensureLayers(last);
    },
    capture() {
      if (!last || !controls) throw new Error('capture before the first draw');
      ensureLayers(last);
      lighting.update(last, quality);
      controls.apply();
      renderer.render(scene, controls.camera);
      const info = renderer.info.render;
      return {
        tick: last.cur.tick,
        png: canvas.toDataURL('image/png'),
        calls: info.calls,
        triangles: info.triangles,
      };
    },
    dispose() {
      for (const l of layers) l.dispose();
      layers = [];
      controls?.dispose();
      renderer.dispose();
    },
  };
}
