import type * as THREE from 'three';
import type { Pos, Projection, Terrain } from '../types';

export interface VisionGrid {
  width: number;
  height: number;
  scale?: number;
  values: Uint8Array;
}

export interface UiState {
  selected: number | null;
  hoverToilet: Pos | null;
  dusk: boolean;
  duskT: number;
  visionOf?: number | null;
  vision?: VisionGrid | null;
  path?: Pos[] | null;
}

export interface FrameInput {
  terrain: Terrain;
  prev: Projection | null;
  cur: Projection;
  phase: number;
  clock: number;
  ui: UiState;
}

export type Quality = 'high' | 'medium' | 'low';

export interface SceneCtx {
  scene: THREE.Scene;
  world: THREE.Group;
  quality: Quality;
  worldId: number;
  terrain: Terrain;
  pickables: Map<THREE.Object3D, number>;
  camera: THREE.PerspectiveCamera;
}

export interface Layer {
  update(input: FrameInput, ctx: SceneCtx): void;
  dispose(): void;
}
