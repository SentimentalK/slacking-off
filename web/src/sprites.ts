// Prerenders `docs/art/sprites.svg` into 16px-ish offscreen canvases exactly
// once. Canvas draws copy these bitmaps; nothing re-parses SVG per frame.

import spritesSvg from '../../docs/art/sprites.svg?raw';

/** Art order from `docs/art/README.md` §2; index = `ProjectionAgent.color`. */
export const AGENT_COLORS = [
  '#ef5350',
  '#ff8a50',
  '#ffca28',
  '#66bb6a',
  '#26a69a',
  '#42a5f5',
  '#ab47bc',
  '#cfd8e0',
  '#f06292',
  '#9ccc65',
  '#4dd0e1',
  '#9575cd',
] as const;

export const SPRITE_IDS = [
  'floor',
  'cor',
  'w',
  'wt',
  'dc',
  'do',
  'crack',
  'wip',
  't1',
  't2',
  't3',
  't4',
  't5',
  'bot',
  'bot-sit',
  'f-ok',
  'f-urg',
  'f-joy',
  'f-stun',
  'f-mad',
  'f-work',
  'sw',
  'sp',
  'pow',
  'sh',
  'ham',
] as const;

export type SpriteId = (typeof SPRITE_IDS)[number];

/** The two variants recoloured through `currentColor`. */
const TINTED_IDS: readonly SpriteId[] = ['bot', 'bot-sit'];

const PATTERN_SIZES: Record<'floor' | 'cor', number> = { floor: 32, cor: 16 };

const SHEET_HOST_ID = 'loo-sprite-sheet';

interface Raster {
  markup: string;
  width: number;
  height: number;
}

const rasters = new Map<string, Raster>();
const canvases = new Map<string, HTMLCanvasElement>();
let booting: Promise<void> | null = null;

function parseViewBox(viewBox: string | null): { width: number; height: number } {
  const parts = (viewBox ?? '0 0 16 16').trim().split(/[\s,]+/).map(Number);
  const width = parts[2] > 0 ? parts[2] : 16;
  const height = parts[3] > 0 ? parts[3] : 16;
  return { width, height };
}

function collectRasters(): void {
  const doc = new DOMParser().parseFromString(spritesSvg, 'image/svg+xml');
  for (const symbol of Array.from(doc.querySelectorAll('symbol'))) {
    const id = symbol.getAttribute('id');
    if (!id) continue;
    const { width, height } = parseViewBox(symbol.getAttribute('viewBox'));
    rasters.set(id, { markup: symbol.innerHTML, width, height });
  }
  for (const [id, size] of Object.entries(PATTERN_SIZES)) {
    const pattern = doc.getElementById(id);
    if (!pattern) continue;
    rasters.set(id, {
      markup: `<defs>${pattern.outerHTML}</defs><rect width="${size}" height="${size}" fill="url(#${id})"/>`,
      width: size,
      height: size,
    });
  }
}

function toSvgDataUrl(raster: Raster): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${raster.width}" height="${raster.height}" ` +
    `viewBox="0 0 ${raster.width} ${raster.height}" shape-rendering="crispEdges">${raster.markup}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function rasterize(raster: Raster): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(canvas);
  ctx.imageSmoothingEnabled = false;
  const { promise, resolve } = Promise.withResolvers<HTMLCanvasElement>();
  const image = new Image();
  image.onload = () => {
    ctx.drawImage(image, 0, 0);
    resolve(canvas);
  };
  image.onerror = () => resolve(canvas);
  image.src = toSvgDataUrl(raster);
  return promise;
}

function cacheKey(id: string, color?: string): string {
  return color ? `${id}#${color}` : id;
}

/**
 * Mounts the symbol sheet for DOM `<use href="#bot">` consumers (the agent card)
 * and prerenders every bitmap the renderer needs.
 */
export function ensureSprites(): Promise<void> {
  if (booting) return booting;
  collectRasters();

  let host = document.getElementById(SHEET_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = SHEET_HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.display = 'none';
    host.innerHTML = spritesSvg;
    document.body.appendChild(host);
  }

  const jobs: Promise<void>[] = [];
  const rasterSet = new Map<string, Raster>(rasters);

  for (const id of TINTED_IDS) {
    const raster = rasters.get(id);
    if (!raster) continue;
    for (const color of AGENT_COLORS) {
      const tinted = `${id}#${color}`;
      rasterSet.set(tinted, {
        ...raster,
        markup: raster.markup.replaceAll('currentColor', color),
      });
    }
  }

  for (const [id, raster] of rasterSet) {
    jobs.push(
      rasterize(raster).then((canvas) => {
        canvases.set(id, canvas);
      }),
    );
  }

  booting = Promise.all(jobs).then(() => undefined);
  return booting;
}

const FALLBACK = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  return canvas;
})();

export function getSprite(id: string, color?: string): HTMLCanvasElement {
  return canvases.get(cacheKey(id, color)) ?? canvases.get(id) ?? FALLBACK;
}
