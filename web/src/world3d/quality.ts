import type { Quality, RenderSettings } from './types';

const LEVELS: readonly string[] = ['high', 'medium', 'low'];
const SHADOW_SIZES: readonly number[] = [0, 512, 1024, 2048];

function level(s: string | null): Quality | null {
  return s !== null && LEVELS.includes(s) ? (s as Quality) : null;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software/i;

export function chooseQuality(
  param: string | null,
  stored: string | null,
  width: number,
  cores: number,
  renderer = '',
): Quality {
  const software = SOFTWARE_RENDERER.test(renderer);
  return level(param) ?? level(stored) ?? (software || width < 700 || cores <= 4 ? 'low' : 'high');
}

export function settingsFor(q: Quality): RenderSettings {
  if (q === 'high') return { scale: 1, grass: 1, shadow: 2048 };
  if (q === 'medium') return { scale: 1, grass: 0, shadow: 1024 };
  return { scale: 1, grass: 0, shadow: 0 };
}

export function overrideSettings(base: RenderSettings, search: string): RenderSettings {
  const params = new URLSearchParams(search);
  const scale = Number(params.get('scale'));
  const grass = Number(params.get('grass'));
  const shadow = Number(params.get('shadow'));
  return {
    scale: params.has('scale') && scale > 0 && scale <= 2 ? scale : base.scale,
    grass: params.has('grass') && grass >= 0 && grass <= 1 ? grass : base.grass,
    shadow: params.has('shadow') && SHADOW_SIZES.includes(shadow) ? (shadow as RenderSettings['shadow']) : base.shadow,
  };
}

export function rendererName(): string {
  const canvas = document.createElement('canvas');
  const gl: WebGLRenderingContextBase | null = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const WINDOW_START_MS = 3000;
const WINDOW_END_MS = 6000;
const SLOW_FRAME_MS = 25;

const STEP_DOWN: Partial<Record<Quality, Quality>> = { high: 'medium', medium: 'low' };

export class AutoQuality {
  private tier: Quality | null = null;
  private t0 = 0;
  private last: number | null = null;
  private intervals: number[] = [];
  private settled = false;

  constructor(private readonly enabled: boolean) {}

  frame(now: number, current: Quality): Quality | null {
    const lower = STEP_DOWN[current];
    if (!this.enabled || this.settled || lower === undefined) return null;
    if (this.tier !== current) {
      this.tier = current;
      this.t0 = now;
      this.last = null;
      this.intervals = [];
    }
    const elapsed = now - this.t0;
    if (this.last !== null && elapsed >= WINDOW_START_MS && elapsed <= WINDOW_END_MS) {
      this.intervals.push(now - this.last);
    }
    this.last = now;
    if (elapsed <= WINDOW_END_MS) return null;
    if (median(this.intervals) > SLOW_FRAME_MS) return lower;
    this.settled = true;
    return null;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
