import type { Quality } from './types';

const LEVELS: readonly string[] = ['high', 'low'];

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

export class AutoQuality {
  private t0: number | null = null;
  private last: number | null = null;
  private readonly intervals: number[] = [];
  private decided = false;

  constructor(private readonly enabled: boolean) {}

  frame(now: number, current: Quality): Quality | null {
    if (!this.enabled || this.decided || current !== 'high') return null;
    if (this.t0 === null) this.t0 = now;
    const elapsed = now - this.t0;
    if (this.last !== null && elapsed >= WINDOW_START_MS && elapsed <= WINDOW_END_MS) {
      this.intervals.push(now - this.last);
    }
    this.last = now;
    if (elapsed <= WINDOW_END_MS) return null;
    this.decided = true;
    return median(this.intervals) > SLOW_FRAME_MS ? 'low' : null;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
