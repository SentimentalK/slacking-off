import { getJSON } from './api';
import type { Projection, Terrain } from './types';
import {
  AUTO_LADDER,
  LadderQuality,
  chooseQuality,
  createWorldView,
  ladderAllowed,
  rendererName,
  saveAutoRecord,
  startIndexFor,
  type LadderEvent,
  type Quality,
  type UiState,
  type VisionGrid,
  type WorldView,
} from './world3d';

interface Fixture {
  terrain: Terrain;
  prev: Projection | null;
  cur: Projection;
}

function playVision(cur: Projection, width: number, height: number, id: number): VisionGrid | null {
  const me = cur.agents.find((a) => a.id === id);
  if (!me) return null;
  const values = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.max(Math.abs(x - me.pos.x), Math.abs(y - me.pos.y));
      values[y * width + x] = d <= 4 ? 255 : d <= 12 ? 110 : 30;
    }
  }
  return { width, height, values };
}

declare global {
  interface Window {
    __looReady?: boolean;
    __looCapture?: () => ReturnType<WorldView['capture']>;
    __looFrames?: number[];
    __looQualityLog?: LadderEvent[];
  }
}

const QUALITY_KEY = 'loo-world-quality';

function readStored(): string | null {
  try {
    return localStorage.getItem(QUALITY_KEY);
  } catch {
    return null;
  }
}

const q = new URLSearchParams(location.search);
const api = q.get('api') === '1';
const fixtureUrl = q.get('fixture');
const still = q.get('still') === '1';
const animate = q.get('animate') === '1' && !still;
const phase = Number(q.get('phase') ?? '1');
const hoverParts = (q.get('hover') ?? '').split(',').map(Number);
const hoverToilet = hoverParts.length === 2 && hoverParts.every(Number.isFinite) ? { x: hoverParts[0], y: hoverParts[1] } : null;
const visionParam = q.get('vision');
const visionOf = visionParam !== null && /^\d+$/.test(visionParam) ? Number(visionParam) : null;
const playParam = q.get('play');
const playId = playParam !== null && /^\d+$/.test(playParam) ? Number(playParam) : null;
const ui: UiState = { selected: null, hoverToilet, dusk: q.get('dusk') === '1', duskT: 0, visionOf };
const paramQuality = q.get('quality');
const renderer = rendererName();
const manualTier = still || paramQuality !== null || readStored() !== null;
const ladder = !manualTier && ladderAllowed(innerWidth, renderer);
const quality: Quality = chooseQuality(paramQuality, readStored(), innerWidth, navigator.hardwareConcurrency || 8, renderer);
const focusParts = (q.get('focus') ?? '').split(',').map(Number);
const focus = focusParts.length === 2 && focusParts.every(Number.isFinite) ? { x: focusParts[0], y: focusParts[1] } : undefined;
const zoomParam = Number(q.get('zoom'));
const zoom = q.get('zoom') !== null && Number.isFinite(zoomParam) ? zoomParam : undefined;

const canvas = document.getElementById('scene');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #scene canvas');

const width = Number(q.get('w'));
const height = Number(q.get('h'));
if (width > 0 && height > 0) {
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

async function loadFixture(): Promise<Fixture> {
  if (!fixtureUrl) throw new Error('missing ?fixture= or ?api=1&tick=');
  return (await (await fetch(fixtureUrl)).json()) as Fixture;
}

async function loadApi(): Promise<Fixture> {
  const tick = Number(q.get('tick'));
  if (!Number.isInteger(tick)) throw new Error('api=1 needs an integer ?tick=');
  const [terrain, cur, prev] = await Promise.all([
    getJSON<Terrain>('/api/terrain'),
    getJSON<Projection>(`/api/projection?tick=${tick}`),
    getJSON<Projection>(`/api/projection?tick=${tick - 1}`).catch(() => null),
  ]);
  return { terrain, prev, cur };
}

const data = api ? await loadApi() : await loadFixture();
if (playId !== null) ui.vision = playVision(data.cur, data.terrain.width, data.terrain.height, playId);
const startLevel = ladder ? startIndexFor(renderer) : 0;
const view = createWorldView(canvas, { quality: ladder ? 'high' : quality, still });
if (ladder) view.setSettings(AUTO_LADDER[startLevel]);
if (focus || zoom !== undefined) view.setView({ focus, zoom });
window.__looQualityLog = [];
const auto = ladder
  ? new LadderQuality(true, startLevel, (event) => {
      window.__looQualityLog?.push(event);
      if (event.event === 'settle') saveAutoRecord(renderer, event.to);
    })
  : null;
const t0 = performance.now();
const span = data.cur.tick_seconds * 1000;
if (animate) window.__looFrames = [];

addEventListener('resize', () => view.resize());

function frame(now: number): void {
  if (animate) window.__looFrames?.push(performance.now());
  const animPhase = (now % span) / span;
  const clock = still ? 0 : animate ? now / 1000 : (now - t0) / 1000;
  view.draw({
    terrain: data.terrain,
    prev: data.prev,
    cur: data.cur,
    phase: animate ? animPhase : phase,
    clock,
    ui,
  });
  window.__looReady = true;
  const next = auto?.frame(now) ?? null;
  if (next !== null) view.setSettings(AUTO_LADDER[next]);
  requestAnimationFrame(frame);
}

window.__looCapture = () => view.capture();
requestAnimationFrame(frame);
