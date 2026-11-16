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

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function trimmedMean(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(xs.length * 0.9)));
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const AUTO_LADDER: RenderSettings[] = [
  { scale: 1, grass: 1, shadow: 2048 },
  { scale: 0.75, grass: 1, shadow: 2048 },
  { scale: 0.75, grass: 0.5, shadow: 1024 },
  { scale: 0.6, grass: 0.5, shadow: 1024 },
  { scale: 0.6, grass: 0.25, shadow: 512 },
  { scale: 0.75, grass: 0, shadow: 0 },
];

// vsync snaps single intervals to 16.7 / 33.3 / 50 ms, so the judge is a mean (of the fastest 90 %).
// The 3–6 s window right after a switch reads ~1.5 ms faster than the steady state on the reference iGPU, hence 32.5 < 33.3.
const LADDER_SLOW_MEAN_MS = 32.5;
const LADDER_MIN_SAMPLES = 30;
const RETRY_BETTER_AFTER_MS = 7 * 24 * 3600 * 1000;

export function ladderAllowed(width: number, renderer: string): boolean {
  return !(width < 700 || SOFTWARE_RENDERER.test(renderer));
}

export interface LadderEvent {
  t: number;
  event: 'start' | 'step' | 'settle';
  from: number;
  to: number;
  meanMs: number | null;
  p75Ms: number | null;
  medianMs: number | null;
  ok?: boolean;
}

export class LadderQuality {
  private readonly enabled: boolean;
  private readonly onEvent: (event: LadderEvent) => void;
  private index: number;
  private settled = false;
  private t0: number | null = null;
  private last: number | null = null;
  private intervals: number[] = [];

  constructor(enabled: boolean, start: number, onEvent: (event: LadderEvent) => void = () => undefined) {
    this.enabled = enabled;
    this.onEvent = onEvent;
    this.index = Math.min(Math.max(0, Math.floor(start)), AUTO_LADDER.length - 1);
  }

  get level(): number {
    return this.index;
  }

  frame(now: number): number | null {
    if (!this.enabled || this.settled) return null;
    if (this.t0 === null) this.begin(now);
    const elapsed = now - (this.t0 as number);
    if (this.last !== null && elapsed >= WINDOW_START_MS && elapsed <= WINDOW_END_MS) {
      this.intervals.push(now - this.last);
    }
    this.last = now;
    if (elapsed <= WINDOW_END_MS) return null;
    if (this.intervals.length < LADDER_MIN_SAMPLES) {
      this.begin(now);
      return null;
    }
    const p75Ms = percentile(this.intervals, 0.75);
    const medianMs = median(this.intervals);
    const meanMs = trimmedMean(this.intervals);
    if (meanMs > LADDER_SLOW_MEAN_MS && this.index < AUTO_LADDER.length - 1) {
      this.onEvent({ t: now, event: 'step', from: this.index, to: this.index + 1, meanMs, p75Ms, medianMs });
      this.index += 1;
      this.begin(now);
      return this.index;
    }
    this.settled = true;
    this.onEvent({ t: now, event: 'settle', from: this.index, to: this.index, meanMs, p75Ms, medianMs, ok: meanMs <= LADDER_SLOW_MEAN_MS });
    return null;
  }

  private begin(now: number): void {
    this.t0 = now;
    this.last = null;
    this.intervals = [];
    this.onEvent({ t: now, event: 'start', from: this.index, to: this.index, meanMs: null, p75Ms: null, medianMs: null });
  }
}

interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const AUTO_KEY = 'loo.autoQuality';

function defaultStorage(): KeyValue | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function startIndexFor(renderer: string, storage: KeyValue | null = defaultStorage(), now = Date.now()): number {
  try {
    const raw = storage?.getItem(AUTO_KEY);
    if (!raw) return 0;
    const record = JSON.parse(raw) as { renderer?: unknown; index?: unknown; at?: unknown };
    if (record.renderer === renderer && Number.isInteger(record.index)) {
      const index = record.index as number;
      if (index < 0 || index >= AUTO_LADDER.length) return 0;
      const stale = typeof record.at !== 'number' || now - record.at > RETRY_BETTER_AFTER_MS;
      return stale ? Math.max(0, index - 1) : index;
    }
  } catch {
    return 0;
  }
  return 0;
}

export function saveAutoRecord(renderer: string, index: number, storage: KeyValue | null = defaultStorage(), now = Date.now()): void {
  try {
    storage?.setItem(AUTO_KEY, JSON.stringify({ renderer, index, at: now }));
  } catch {
    return;
  }
}
