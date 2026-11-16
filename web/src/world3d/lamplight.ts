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

/** The lamp-post colour (0xffb45a, linear). The field is scalar; lamps of another colour are weighted by their luminance relative to this one. */
export const FIELD_COLOR: [number, number, number] = [1, 0.4564, 0.1022];
const FIELD_LUM = (FIELD_COLOR[0] + FIELD_COLOR[1] + FIELD_COLOR[2]) / 3;

/** Height slices of the baked field, bottom to top, `FIELD_STEP` apart. */
export const FIELD_LAYERS = 6;
export const FIELD_STEP = 0.75;

/**
 * Bakes the light of point lamps into a vector field: per texel and height slice, the sum over
 * lamps of `intensity * window / d^decay * unit(lamp - point)` in xyz and the plain scalar sum in w.
 * A fragment with normal n then gets `max(0, dot(n, xyz))` of lamp light, which is exact for one
 * lamp and a close approximation when several lamps light a point from similar sides. This is
 * the normal-aware stand-in for real point lights (one per lamp was too slow): a canopy's side
 * facing a lamp is lit and a roof above the lamp lights nothing.
 * Layout: slice `l` occupies rows `l * H * res .. (l + 1) * H * res - 1`, four floats per texel.
 */
export function lampField(sources: readonly LampSource[], W: number, H: number, res = 4): Float32Array {
  const TW = W * res;
  const TH = H * res;
  const out = new Float32Array(TW * TH * FIELD_LAYERS * 4);
  for (const s of sources) {
    const lum = (s.color[0] + s.color[1] + s.color[2]) / 3;
    const scale = (s.intensity * lum) / FIELD_LUM;
    const r = Math.ceil(s.distance * res);
    const i0 = Math.max(0, Math.floor(s.x * res) - r);
    const i1 = Math.min(TW - 1, Math.floor(s.x * res) + r);
    const j0 = Math.max(0, Math.floor(s.z * res) - r);
    const j1 = Math.min(TH - 1, Math.floor(s.z * res) + r);
    for (let l = 0; l < FIELD_LAYERS; l++) {
      const dy = s.y - l * FIELD_STEP;
      for (let j = j0; j <= j1; j++) {
        const dz = s.z - (j + 0.5) / res;
        for (let i = i0; i <= i1; i++) {
          const dx = s.x - (i + 0.5) / res;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const u = (d / s.distance) ** 4;
          if (u >= 1) continue;
          const g = (scale * (1 - u) * (1 - u)) / Math.max(d ** s.decay, 0.01);
          const o = (((l * TH + j) * TW) + i) * 4;
          out[o] += (dx / d) * g;
          out[o + 1] += (dy / d) * g;
          out[o + 2] += (dz / d) * g;
          out[o + 3] += g;
        }
      }
    }
  }
  return out;
}
