import type { Projection, Terrain } from './types';
import { AutoQuality, chooseQuality, createWorldView, type Quality, type UiState, type WorldView } from './world3d';

interface Fixture {
  terrain: Terrain;
  prev: Projection | null;
  cur: Projection;
}

declare global {
  interface Window {
    __looReady?: boolean;
    __looCapture?: () => ReturnType<WorldView['capture']>;
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
const fixtureUrl = q.get('fixture');
if (!fixtureUrl) throw new Error('missing ?fixture=');
const still = q.get('still') === '1';
const phase = Number(q.get('phase') ?? '1');
const hoverParts = (q.get('hover') ?? '').split(',').map(Number);
const hoverToilet = hoverParts.length === 2 && hoverParts.every(Number.isFinite) ? { x: hoverParts[0], y: hoverParts[1] } : null;
const ui: UiState = { selected: null, hoverToilet, dusk: q.get('dusk') === '1', duskT: 0 };
const paramQuality = q.get('quality');
const quality: Quality = chooseQuality(paramQuality, readStored(), innerWidth, navigator.hardwareConcurrency || 8);

const canvas = document.getElementById('scene');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #scene canvas');

const fixture = (await (await fetch(fixtureUrl)).json()) as Fixture;
const view = createWorldView(canvas, { quality, still });
const auto = new AutoQuality(!still && paramQuality === null && readStored() === null);
let current: Quality = quality;
const t0 = performance.now();

addEventListener('resize', () => view.resize());

function frame(now: number): void {
  const clock = still ? 0 : (now - t0) / 1000;
  view.draw({ terrain: fixture.terrain, prev: fixture.prev, cur: fixture.cur, phase, clock, ui });
  window.__looReady = true;
  const next = auto.frame(now, current);
  if (next) {
    view.setQuality(next);
    current = next;
  }
  requestAnimationFrame(frame);
}

window.__looCapture = () => view.capture();
requestAnimationFrame(frame);
