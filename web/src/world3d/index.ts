import * as THREE from 'three';
import type { Pos, Terrain } from '../types';
import { CameraControls, pick } from './camera';
import { createAgentsLayer } from './agents';
import { createDecor } from './decor';
import { createForest } from './forest';
import { createObjectsLayer } from './objects';
import { createVisionBoxLayer } from './visionbox';
import { createPathMarksLayer } from './pathmarks';
import { createGround } from './ground';
import { createLighting } from './lighting';
import { applyVision, installVisionShader } from './vision';
import type { FrameInput, Layer, Quality, SceneCtx } from './types';

export type { FrameInput, Layer, Quality, SceneCtx, UiState, VisionGrid } from './types';
export { chooseQuality, rendererName, AutoQuality } from './quality';

export interface ClickHit {
  clientX: number;
  clientY: number;
  agentId: number | null;
  cell: Pos | null;
}

export interface WorldViewOptions {
  quality: Quality;
  still: boolean;
  onSelect?: (id: number | null) => void;
  onClick?: (hit: ClickHit) => void;
  onUserCamera?: () => void;
}

export interface WorldView {
  draw(input: FrameInput): void;
  pick(x: number, y: number): number | null;
  resize(): void;
  setQuality(q: Quality): void;
  setView(view: { focus?: Pos; zoom?: number }): void;
  capture(): { tick: number; png: string; calls: number; triangles: number };
  groundCell(clientX: number, clientY: number): Pos | null;
  screenOf(agentId: number): { x: number; y: number } | null;
  screenOfCell(x: number, y: number): { x: number; y: number } | null;
  lastTick(): number;
  dispose(): void;
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export const extraLayers: Array<(ctx: SceneCtx) => Layer> = [];
extraLayers.push((ctx) => createObjectsLayer(ctx));
extraLayers.push((ctx) => createAgentsLayer(ctx));
extraLayers.push((ctx) => createVisionBoxLayer(ctx));
extraLayers.push((ctx) => createPathMarksLayer(ctx));

const EMPTY_TERRAIN: Terrain = { width: 0, height: 0, entrance: { x: 0, y: 0 }, rows: [] };

const projectToPage = (v: THREE.Vector3, canvas: HTMLCanvasElement): { x: number; y: number } => {
  const r = canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
};

export function createWorldView(canvas: HTMLCanvasElement, opts: WorldViewOptions): WorldView {
  const vision = installVisionShader();
  let quality: Quality = opts.quality;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2412);
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
  let pendingView: { focus?: Pos; zoom?: number } = {};

  const applyView = (): void => {
    if (!controls) return;
    if (pendingView.focus) controls.setFocus(pendingView.focus.x + 0.5, pendingView.focus.y + 0.5);
    if (pendingView.zoom !== undefined) controls.setZoom(pendingView.zoom);
  };

  const applyRenderer = (q: Quality): void => {
    renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    renderer.shadowMap.enabled = q !== 'low';
    renderer.shadowMap.type = THREE.PCFShadowMap;
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

  const cellAt = (clientX: number, clientY: number, camera: THREE.Camera): Pos | null => {
    if (!last) return null;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const p = ray.ray.intersectPlane(GROUND, new THREE.Vector3());
    if (!p) return null;
    const x = Math.floor(p.x);
    const y = Math.floor(p.z);
    if (x < 0 || y < 0 || x >= last.terrain.width || y >= last.terrain.height) return null;
    return { x, y };
  };

  const ensureControls = (terrain: Terrain): CameraControls => {
    const dims = terrain.width + 'x' + terrain.height;
    if (controls && controlsDims === dims) return controls;
    controls?.dispose();
    const c: CameraControls = new CameraControls(
      canvas,
      terrain.width,
      terrain.height,
      (x, y) => {
        const agentId = pick(c.camera, canvas, x, y, pickables);
        opts.onClick?.({ clientX: x, clientY: y, agentId, cell: cellAt(x, y, c.camera) });
        opts.onSelect?.(agentId);
      },
      opts.still,
      () => opts.onUserCamera?.(),
    );
    controls = c;
    controlsDims = dims;
    applyView();
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
      applyVision(vision, input.ui.vision);
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
      applyVision(vision, last.ui.vision);
      renderer.render(scene, controls.camera);
      const info = renderer.info.render;
      return {
        tick: last.cur.tick,
        png: canvas.toDataURL('image/png'),
        calls: info.calls,
        triangles: info.triangles,
      };
    },
    groundCell(clientX, clientY) {
      if (!controls) return null;
      return cellAt(clientX, clientY, controls.camera);
    },
    screenOf(agentId) {
      if (!controls) return null;
      let hit: THREE.Object3D | null = null;
      for (const [obj, id] of pickables) {
        if (id === agentId) {
          hit = obj;
          break;
        }
      }
      if (!hit) return null;
      const v = hit.getWorldPosition(new THREE.Vector3());
      v.y += 0.6;
      v.project(controls.camera);
      return projectToPage(v, canvas);
    },
    screenOfCell(x, y) {
      if (!controls) return null;
      const v = new THREE.Vector3(x + 0.5, 0, y + 0.5).project(controls.camera);
      return projectToPage(v, canvas);
    },
    setView(view) {
      pendingView = view;
      applyView();
    },
    lastTick() {
      return last ? last.cur.tick : -1;
    },
    dispose() {
      for (const l of layers) l.dispose();
      layers = [];
      controls?.dispose();
      renderer.dispose();
    },
  };
}
