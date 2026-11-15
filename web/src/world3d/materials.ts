import * as THREE from 'three';

const cache = new Map<string, THREE.MeshStandardMaterial>();

export function S(hex: number, o?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const params: THREE.MeshStandardMaterialParameters = Object.assign(
    { color: hex, flatShading: true, roughness: 0.88, metalness: 0 },
    o ?? {},
  );
  const key = JSON.stringify([hex, o ?? null]);
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial(params);
    cache.set(key, m);
  }
  return m;
}

export function P(hex: number, o?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return S(hex, Object.assign({ flatShading: false, roughness: 0.5 }, o ?? {}));
}

export const PLANK_COLORS = [0x7a583a, 0x6c4d33, 0x846040, 0x72533a] as const;
export const DEEP_WOOD = 0x4a3526;
export const BARK = 0x3a2a1e;
export const NEEDLE_COLORS = [0x35501f, 0x41612a, 0x4f7431, 0x5f8839, 0x73a043] as const;
