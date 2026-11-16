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

  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

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

export const AUTO_LADDER: RenderSettings[] = [
  { scale: 1, grass: 1, shadow: 2048 },
  { scale: 0.75, grass: 1, shadow: 2048 },
  { scale: 0.75, grass: 0.5, shadow: 1024 },
  { scale: 0.6, grass: 0.5, shadow: 1024 },
  { scale: 0.6, grass: 0.25, shadow: 512 },
  { scale: 0.75, grass: 0, shadow: 0 },
];

const LADDER_SLOW_MS = 33.4;

export function describeSettings(s: RenderSettings): string {
  const shadow = s.shadow === 0 ? '阴影 关' : `阴影 ${s.shadow}`;
  return `渲染 ${Math.round(s.scale * 100)}% · 草 ${Math.round(s.grass * 100)}% · ${shadow}`;
}

export function ladderAllowed(width: number, renderer: string): boolean {
  return !(width < 700 || SOFTWARE_RENDERER.test(renderer));
}

export interface LadderEvent {
  t: number;
  event: 'start' | 'step' | 'settle';
  from: number;
  to: number;
  medianMs: number | null;
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
    const medianMs = median(this.intervals);
    if (medianMs > LADDER_SLOW_MS && this.index < AUTO_LADDER.length - 1) {
      this.onEvent({ t: now, event: 'step', from: this.index, to: this.index + 1, medianMs });
      this.index += 1;
      this.begin(now);
      return this.index;
    }
    this.settled = true;
    this.onEvent({ t: now, event: 'settle', from: this.index, to: this.index, medianMs });
    return null;
  }

  private begin(now: number): void {
    this.t0 = now;
    this.last = null;
    this.intervals = [];
    this.onEvent({ t: now, event: 'start', from: this.index, to: this.index, medianMs: null });
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

export function startIndexFor(renderer: string, storage: KeyValue | null = defaultStorage()): number {
  try {
    const raw = storage?.getItem(AUTO_KEY);
    if (!raw) return 0;
    const record = JSON.parse(raw) as { renderer?: unknown; index?: unknown };
    if (record.renderer === renderer && Number.isInteger(record.index)) {
      const index = record.index as number;
      if (index >= 0 && index < AUTO_LADDER.length) return index;
    }
  } catch {
    return 0;
  }
  return 0;
}

export function saveAutoRecord(renderer: string, index: number, storage: KeyValue | null = defaultStorage()): void {
  try {
    storage?.setItem(AUTO_KEY, JSON.stringify({ renderer, index }));
  } catch {
    return;
  }
}
