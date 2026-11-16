export interface LampSource {
  x: number;
  z: number;
  y: number;
  color: [number, number, number];
  intensity: number;
  distance: number;
  decay: number;
}

export const LAMPS_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lamps') === '0';

const SURFACE_Y = 0.25;

const owners = new Map<string, LampSource[]>();

export function setLampSources(owner: string, sources: LampSource[]): void {
  owners.set(owner, sources);
}

export function clearLampSources(owner: string): void {
  owners.delete(owner);
}

export function allLampSources(): LampSource[] {
  return [...owners.values()].flat();
}

export function lampIrradiance(sources: readonly LampSource[], W: number, H: number, res = 4): Float32Array {
  const TW = W * res;
  const TH = H * res;
  const out = new Float32Array(TW * TH * 3);
  for (const s of sources) {
    const scale = s.intensity;
    const dy = s.y - SURFACE_Y;
    for (let j = 0; j < TH; j++) {
      const pz = (j + 0.5) / res;
      for (let i = 0; i < TW; i++) {
        const px = (i + 0.5) / res;
        const dx = px - s.x;
        const dz = pz - s.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const u = (d / s.distance) ** 4;
        if (u >= 1) continue;
        const window = (1 - u) * (1 - u);
        const g = scale * window * Math.max(0, dy / d) / Math.max(d ** s.decay, 0.01);
        const o = (j * TW + i) * 3;
        out[o] += s.color[0] * g;
        out[o + 1] += s.color[1] * g;
        out[o + 2] += s.color[2] * g;
      }
    }
  }
  return out;
}
