import * as THREE from 'three';
import type { VisionGrid } from './types';
import { lampIrradiance, type LampSource } from './lamplight';

export interface VisionUniforms {
  visionMap: { value: THREE.DataTexture };
  visionOn: { value: number };
  visionSize: { value: THREE.Vector2 };
  lampMap: { value: THREE.DataTexture };
  lampK: { value: number };
  lampSize: { value: THREE.Vector2 };
}

const LAMP_RES = 4;

const VERTEX_HEAD = 'varying vec2 vVisionXZ;\nvarying float vVisionY;\n';
const VERTEX_AFTER_PROJECT = [
  '',
  'vec4 visionWP = vec4( transformed, 1.0 );',
  '#ifdef USE_INSTANCING',
  'visionWP = instanceMatrix * visionWP;',
  '#endif',
  'visionWP = modelMatrix * visionWP;',
  'vVisionXZ = visionWP.xz;',
  'vVisionY = visionWP.y;',
].join('\n');
const FRAGMENT_HEAD = [
  'uniform sampler2D visionMap;',
  'uniform float visionOn;',
  'uniform vec2 visionSize;',
  'uniform sampler2D lampMap;',
  'uniform float lampK;',
  'uniform vec2 lampSize;',
  'varying vec2 vVisionXZ;',
  'varying float vVisionY;',
  '',
].join('\n');
const FRAGMENT_AFTER_LIGHTS = [
  'if ( lampK > 0.0 ) { vec2 lampUV = vVisionXZ / lampSize; if ( lampUV.x >= 0.0 && lampUV.y >= 0.0 && lampUV.x <= 1.0 && lampUV.y <= 1.0 ) { float lampH = clamp( ( 2.0 - vVisionY ) / 1.2, 0.0, 1.0 ); reflectedLight.directDiffuse += BRDF_Lambert( diffuseColor.rgb ) * texture2D( lampMap, lampUV ).rgb * lampK * lampH; } }',
  '',
].join('\n');
const FRAGMENT_BEFORE_TONEMAP = [
  'if ( visionOn > 0.5 ) { vec2 visionUV = vVisionXZ / visionSize; float visionK = ( visionUV.x < 0.0 || visionUV.y < 0.0 || visionUV.x > 1.0 || visionUV.y > 1.0 ) ? 0.12 : texture2D( visionMap, visionUV ).r; gl_FragColor.rgb *= visionK; }',
  '',
].join('\n');

let installed: VisionUniforms | null = null;
let uploaded: Uint8Array | null = null;
let lampKey = '';
let lampMode = false;

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

function makeLampTexture(data: Uint16Array, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export function installVisionShader(): VisionUniforms {
  if (installed) return installed;
  const u: VisionUniforms = {
    visionMap: { value: makeTexture(new Uint8Array([255]), 1, 1) },
    visionOn: { value: 0 },
    visionSize: { value: new THREE.Vector2(1, 1) },
    lampMap: { value: makeLampTexture(new Uint16Array(4), 1, 1) },
    lampK: { value: 0 },
    lampSize: { value: new THREE.Vector2(1, 1) },
  };
  THREE.Material.prototype.customProgramCacheKey = function customProgramCacheKey(this: THREE.Material): string {
    return (lampMode ? 'lamp:' : 'day:') + this.onBeforeCompile.toString();
  };
  THREE.Material.prototype.onBeforeCompile = (shader) => {
    if (!shader.vertexShader.includes('#include <project_vertex>')) return;
    if (!shader.fragmentShader.includes('#include <tonemapping_fragment>')) return;
    shader.uniforms.visionMap = u.visionMap;
    shader.uniforms.visionOn = u.visionOn;
    shader.uniforms.visionSize = u.visionSize;
    shader.uniforms.lampMap = u.lampMap;
    shader.uniforms.lampK = u.lampK;
    shader.uniforms.lampSize = u.lampSize;
    let fragment = shader.fragmentShader;
    if (lampMode && fragment.includes('#include <lights_fragment_end>')) {
      fragment = fragment.replace('#include <lights_fragment_end>', (m) => `${m}\n${FRAGMENT_AFTER_LIGHTS}`);
    }
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <project_vertex>', (m) => `${m}\n${VERTEX_AFTER_PROJECT}`);
    shader.fragmentShader = FRAGMENT_HEAD + fragment.replace('#include <tonemapping_fragment>', (m) => `${FRAGMENT_BEFORE_TONEMAP}${m}`);
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

export function applyLamps(u: VisionUniforms, sources: LampSource[] | null, k: number, W: number, H: number): boolean {
  const on = k > 0 && !!sources && sources.length > 0;
  const toggled = on !== lampMode;
  lampMode = on;
  if (!on || !sources) {
    u.lampK.value = 0;
    return toggled;
  }
  const key = `${W}x${H}|` + sources.map((s) => [s.x, s.y, s.z, s.color.join(','), s.intensity, s.distance].join(',')).join(';');
  if (key !== lampKey) {
    lampKey = key;
    const rgb = lampIrradiance(sources, W, H, LAMP_RES);
    const w = W * LAMP_RES;
    const h = H * LAMP_RES;
    const half = new Uint16Array(w * h * 4);
    const one = THREE.DataUtils.toHalfFloat(1);
    for (let i = 0; i < w * h; i++) {
      half[i * 4] = THREE.DataUtils.toHalfFloat(rgb[i * 3]);
      half[i * 4 + 1] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 1]);
      half[i * 4 + 2] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 2]);
      half[i * 4 + 3] = one;
    }
    u.lampMap.value.dispose();
    u.lampMap.value = makeLampTexture(half, w, h);
  }
  u.lampSize.value.set(W, H);
  u.lampK.value = k;
  return toggled;
}
