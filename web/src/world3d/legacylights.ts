import * as THREE from 'three';

const FALLOFF_FN = /float getDistanceAttenuation\([^)]*\) \{\n[\s\S]*?\n\}/;
const PHYSICAL_TAIL = 'distanceFalloff *= pow2(';
const LEGACY_FN = `float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {

	if ( cutoffDistance > 0.0 && decayExponent > 0.0 ) {

		return pow( saturate( - lightDistance / cutoffDistance + 1.0 ), decayExponent );

	}

	return 1.0;

}`;

let installed = false;

// three r155 起点光源衰减改成物理公式，原型按 r128 旧公式调的灯。
export function installLegacyPointFalloff(): void {
  if (installed) return;
  const chunk = THREE.ShaderChunk.lights_pars_begin;
  if (!FALLOFF_FN.test(chunk) || !chunk.includes(PHYSICAL_TAIL)) {
    throw new Error('lights_pars_begin: physical getDistanceAttenuation not found');
  }
  const next = chunk.replace(FALLOFF_FN, LEGACY_FN);
  if (!next.includes(LEGACY_FN) || next.includes(PHYSICAL_TAIL)) {
    throw new Error('lights_pars_begin: legacy getDistanceAttenuation not installed');
  }
  THREE.ShaderChunk.lights_pars_begin = next;
  installed = true;
}
