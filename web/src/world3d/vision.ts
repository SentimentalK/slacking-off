import * as THREE from 'three';
import type { VisionGrid } from './types';

export interface VisionUniforms {
  visionMap: { value: THREE.DataTexture };
  visionOn: { value: number };
  visionSize: { value: THREE.Vector2 };
}

const VERTEX_HEAD = 'varying vec2 vVisionXZ;\n';
const VERTEX_AFTER_PROJECT = [
  '',
  'vec4 visionWP = vec4( transformed, 1.0 );',
  '#ifdef USE_INSTANCING',
  'visionWP = instanceMatrix * visionWP;',
  '#endif',
  'visionWP = modelMatrix * visionWP;',
  'vVisionXZ = visionWP.xz;',
].join('\n');
const FRAGMENT_HEAD = [
  'uniform sampler2D visionMap;',
  'uniform float visionOn;',
  'uniform vec2 visionSize;',
  'varying vec2 vVisionXZ;',
  '',
].join('\n');
const FRAGMENT_BEFORE_TONEMAP = [
  'if ( visionOn > 0.5 ) { vec2 visionUV = vVisionXZ / visionSize; float visionK = ( visionUV.x < 0.0 || visionUV.y < 0.0 || visionUV.x > 1.0 || visionUV.y > 1.0 ) ? 0.12 : texture2D( visionMap, visionUV ).r; gl_FragColor.rgb *= visionK; }',
  '',
].join('\n');

let installed: VisionUniforms | null = null;
let uploaded: Uint8Array | null = null;

function makeTexture(data: Uint8Array, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function installVisionShader(): VisionUniforms {
  if (installed) return installed;
  const u: VisionUniforms = {
    visionMap: { value: makeTexture(new Uint8Array([255]), 1, 1) },
    visionOn: { value: 0 },
    visionSize: { value: new THREE.Vector2(1, 1) },
  };
  THREE.Material.prototype.onBeforeCompile = (shader) => {
    if (!shader.vertexShader.includes('#include <project_vertex>')) return;
    if (!shader.fragmentShader.includes('#include <tonemapping_fragment>')) return;
    shader.uniforms.visionMap = u.visionMap;
    shader.uniforms.visionOn = u.visionOn;
    shader.uniforms.visionSize = u.visionSize;
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <project_vertex>', (m) => `${m}\n${VERTEX_AFTER_PROJECT}`);
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <tonemapping_fragment>', (m) => `${FRAGMENT_BEFORE_TONEMAP}${m}`);
  };
  installed = u;
  return u;
}

export function applyVision(u: VisionUniforms, grid: VisionGrid | null | undefined): void {
  if (!grid) {
    u.visionOn.value = 0;
    return;
  }
  u.visionOn.value = 1;
  u.visionSize.value.set(grid.width, grid.height);
  if (grid.values === uploaded) return;
  uploaded = grid.values;
  u.visionMap.value.dispose();
  u.visionMap.value = makeTexture(grid.values, grid.width, grid.height);
}
