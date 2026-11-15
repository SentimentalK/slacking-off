// The one renderer. Live and replay both call `drawWorld`; `Spectator` never
// touches a 2D context itself. Geometry, palettes and layer order come from
// `docs/art/README.md`.

import { AGENT_COLORS, getSprite } from './sprites';
import type { SpriteId } from './sprites';
import type { AgentPose, Dir, Pos, Projection, ProjectionAgent, ProjectionObject, Terrain } from './types';

export interface Camera {
  /** Integer 2..6. */
  zoom: number;
  /** Tile coordinate of the canvas top-left corner. */
  originX: number;
  originY: number;
}

export interface DrawOptions {
  selected?: number;
  camera: Camera;
  now: number;
  reduceMotion: boolean;
  prev?: Projection;
}

export const ZOOM_MIN = 2;
export const ZOOM_MAX = 6;

const TILE = 16;

// `docs/art/README.md` §2.
const OUTSIDE = '#141926';
const INK = '#2b2233';
const FLOOR_A = '#e4efe9';
const FLOOR_B = '#d3e4dc';
const FLOOR_LINE = '#c3d6cd';
const CORRIDOR = '#d9dcee';
const CORRIDOR_LINE = '#c9cde3';
const GOLD = '#ffcf40';
const GREEN = '#3fb950';
const RED = '#e5484d';
const LABEL_BG = 'rgba(43, 34, 51, 0.85)';
const LABEL_FG = '#ffffff';

/** A `deadline_tick` is 120..=240 ticks out; a quarter of the shortest is 30. */
export const URGENT_TICKS = 30;

export interface AgentLook {
  /** Seated on a toilet: `bot-sit` and every overlay shifted down 5px. */
  sit: boolean;
  face: SpriteId;
  sweat: boolean;
  hammer: boolean;
  shield: boolean;
  punch: boolean;
  stunned: boolean;
  success: boolean;
  urgent: boolean;
}

function poseOf(agent: ProjectionAgent, tick: number): AgentPose {
  if (tick < agent.stun_until) return 'stunned';
  if (agent.defending) return 'defending';
  return agent.pose;
}

function isUrgent(agent: ProjectionAgent, tick: number): boolean {
  return agent.need !== null && agent.deadline_tick > tick && agent.deadline_tick - tick <= URGENT_TICKS;
}

/** Which face/overlay an agent shows; shared with the selected-agent card. */
export function agentLook(agent: ProjectionAgent, tick: number): AgentLook {
  const pose = poseOf(agent, tick);
  const urgent = (pose === 'idle' || pose === 'walking') && isUrgent(agent, tick);
  const look: AgentLook = {
    sit: pose === 'using',
    face: 'f-ok',
    sweat: urgent,
    hammer: pose === 'working' || pose === 'demolishing',
    shield: pose === 'defending',
    punch: pose === 'attacking',
    stunned: pose === 'stunned',
    success: pose === 'success',
    urgent,
  };
  switch (pose) {
    case 'using':
    case 'success':
      look.face = 'f-joy';
      break;
    case 'working':
      look.face = 'f-work';
      break;
    case 'demolishing':
    case 'attacking':
      look.face = 'f-mad';
      break;
    case 'stunned':
      look.face = 'f-stun';
      break;
    case 'idle':
    case 'walking':
    case 'defending':
      look.face = urgent ? 'f-urg' : 'f-ok';
      break;
  }
  return look;
}

export function agentColor(index: number): string {
  const n = AGENT_COLORS.length;
  return AGENT_COLORS[((index % n) + n) % n];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Keeps the camera legal: integer zoom inside `ZOOM_MIN..ZOOM_MAX`, origin
 * clamped so the board never scrolls past its own edges.
 */
export function clampCamera(
  camera: Camera,
  width: number,
  height: number,
  cssW: number,
  cssH: number,
): void {
  camera.zoom = clampZoom(camera.zoom);
  const viewW = cssW / (TILE * camera.zoom);
  const viewH = cssH / (TILE * camera.zoom);
  camera.originX = width <= viewW ? (width - viewW) / 2 : clamp(camera.originX, 0, width - viewW);
  camera.originY = height <= viewH ? (height - viewH) / 2 : clamp(camera.originY, 0, height - viewH);
}

/** Initial view: zoom 2 centred on the entrance (or `focus`), then clamped. */
export function centerCamera(
  camera: Camera,
  terrain: Terrain,
  cssW: number,
  cssH: number,
  focus: Pos | null = terrain.entrance,
): void {
  camera.zoom = 2;
  const viewW = cssW / (TILE * camera.zoom);
  const viewH = cssH / (TILE * camera.zoom);
  const cx = (focus?.x ?? terrain.width / 2) + 0.5;
  const cy = (focus?.y ?? terrain.height / 2) + 0.5;
  camera.originX = cx - viewW / 2;
  camera.originY = cy - viewH / 2;
  clampCamera(camera, terrain.width, terrain.height, cssW, cssH);
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom)));
}

interface Layout {
  zoom: number;
  tile: number;
  offX: number;
  offY: number;
}

function layoutOf(camera: Camera): Layout {
  const zoom = clampZoom(camera.zoom);
  const tile = TILE * zoom;
  return {
    zoom,
    tile,
    offX: Math.round(-camera.originX * tile),
    offY: Math.round(-camera.originY * tile),
  };
}

interface Cell {
  obj: ProjectionObject | null;
}

function indexObjects(objects: ProjectionObject[]): Map<number, Cell> {
  const cells = new Map<number, Cell>();
  for (const obj of objects) {
    // 64-bit enough for worlds ±2^15.
    const key = (obj.pos.y + 4096) * 8192 + (obj.pos.x + 4096);
    cells.set(key, { obj });
  }
  return cells;
}

function cellAt(cells: Map<number, Cell>, x: number, y: number): ProjectionObject | null {
  return cells.get((y + 4096) * 8192 + (x + 4096))?.obj ?? null;
}

/** The `w`/`wt` pair: a wall with a wall directly south shows only its top. */
function wallSprite(cells: Map<number, Cell>, x: number, y: number): SpriteId {
  const below = cellAt(cells, x, y + 1);
  return below && below.kind === 'wall' ? 'wt' : 'w';
}

function toiletSprite(level: number): SpriteId {
  const n = Math.min(5, Math.max(1, Math.round(level)));
  return `t${n}` as SpriteId;
}

function objectSprite(cells: Map<number, Cell>, obj: ProjectionObject): SpriteId {
  switch (obj.kind) {
    case 'wall':
    case 'pillar':
      return wallSprite(cells, obj.pos.x, obj.pos.y);
    case 'door':
      return obj.open ? 'do' : 'dc';
    case 'toilet':
      return toiletSprite(obj.level);
  }
}

const FACING_DELTA: Record<Dir, { x: number; y: number }> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

interface AgentFrame {
  agent: ProjectionAgent;
  /** Tile-space float position after movement interpolation. */
  x: number;
  y: number;
  look: AgentLook;
}

interface Arrival {
  at: number;
}

const arrivals = new WeakMap<Projection, Arrival>();

function arrivalOf(projection: Projection, now: number): number {
  const seen = arrivals.get(projection);
  if (seen) return seen.at;
  arrivals.set(projection, { at: now });
  return now;
}

function interpolate(p: Projection, prev: Projection, now: number, reduceMotion: boolean): AgentFrame[] {
  const prevById = new Map(prev.agents.map((agent) => [agent.id, agent]));
  const prevAt = arrivalOf(prev, now);
  const span = Math.max(1, prev.tick_seconds * 1000);
  const t = reduceMotion ? 1 : Math.min(1, Math.max(0, (now - prevAt) / span));
  return p.agents.map((agent) => {
    let x = agent.pos.x;
    let y = agent.pos.y;
    const before = prevById.get(agent.id);
    if (before && p.tick === prev.tick + 1) {
      const manhattan = Math.abs(before.pos.x - agent.pos.x) + Math.abs(before.pos.y - agent.pos.y);
      if (manhattan === 1) {
        x = before.pos.x + (agent.pos.x - before.pos.x) * t;
        y = before.pos.y + (agent.pos.y - before.pos.y) * t;
      }
    }
    return { agent, x, y, look: agentLook(agent, p.tick) };
  });
}

const BLINK_MS = 1000;
const SHAKE_MS = 300;
const BOB_MS = 1000;

function blinkPhase(now: number, offsetMs = 0): boolean {
  return Math.floor((now + offsetMs) / BLINK_MS) % 2 === 1;
}

function shakePhase(now: number): number {
  return Math.floor(now / (SHAKE_MS / 2)) % 2 === 0 ? 0 : 1;
}

function bobPhase(now: number): number {
  return Math.floor((now % BOB_MS) / (BOB_MS / 2));
}

function blit(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  x: number,
  y: number,
  pixel: number,
): void {
  ctx.drawImage(sprite, Math.round(x), Math.round(y), sprite.width * pixel, sprite.height * pixel);
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  layout: Layout,
  noBuild: boolean,
  cssW: number,
  cssH: number,
): void {
  const { tile, offX, offY } = layout;
  const px = offX + x * tile;
  const py = offY + y * tile;
  if (px > cssW || py > cssH || px + tile < 0 || py + tile < 0) return;
  if (noBuild) {
    ctx.fillStyle = CORRIDOR;
    ctx.fillRect(px, py, tile, tile);
    ctx.fillStyle = CORRIDOR_LINE;
  } else {
    ctx.fillStyle = (x + y) % 2 === 0 ? FLOOR_A : FLOOR_B;
    ctx.fillRect(px, py, tile, tile);
    ctx.fillStyle = FLOOR_LINE;
  }
  ctx.fillRect(px + tile - 1, py, 1, tile);
  ctx.fillRect(px, py + tile - 1, tile, 1);
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  centerPx: number,
  topPy: number,
  layout: Layout,
  fraction: number,
  color: string,
): void {
  const { zoom } = layout;
  const width = 14 * zoom;
  const height = 3 * zoom;
  const left = Math.round(centerPx - width / 2);
  const top = Math.round(topPy);
  ctx.fillStyle = INK;
  ctx.fillRect(left, top, width, height);
  const filled = Math.round(12 * zoom * Math.min(1, Math.max(0, fraction)));
  ctx.fillStyle = color;
  ctx.fillRect(left + zoom, top + zoom, filled, zoom);
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  nick: string,
  centerPx: number,
  topPy: number,
  layout: Layout,
  selected: boolean,
  human: boolean,
): void {
  const fontPx = Math.max(10, 5 * layout.zoom);
  ctx.font = `400 ${fontPx}px Silkscreen, ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badgeGap = human ? Math.max(2, Math.round(fontPx * 0.25)) : 0;
  const nickWidth = Math.ceil(ctx.measureText(nick).width);
  const badgeWidth = human ? Math.ceil(ctx.measureText('人').width) : 0;
  const textWidth = nickWidth + (human ? badgeGap + badgeWidth : 0);
  const pad = Math.max(3, Math.round(fontPx * 0.3));
  const width = textWidth + pad * 2;
  const height = fontPx + 2;
  const left = Math.round(centerPx - width / 2);
  const top = Math.round(topPy);
  ctx.fillStyle = LABEL_BG;
  ctx.fillRect(left, top, width, height);
  const textLeft = left + pad;
  const baseline = top + height / 2 + 1;
  ctx.textAlign = 'left';
  ctx.fillStyle = selected ? GOLD : LABEL_FG;
  ctx.fillText(nick, textLeft, baseline);
  if (human) {
    // A person in the browser: the same gold 「人」 the HTML pages use.
    ctx.fillStyle = GOLD;
    ctx.fillText('人', textLeft + nickWidth + badgeGap, baseline);
  }
}

export function drawWorld(
  canvas: HTMLCanvasElement,
  p: Projection,
  terrain: Terrain,
  opts: DrawOptions,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const pixelW = Math.round(cssW * dpr);
  const pixelH = Math.round(cssH * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(0, 0, cssW, cssH);

  const layout = layoutOf(opts.camera);
  const { zoom, tile, offX, offY } = layout;
  const pixel = zoom;

  // --- ground -------------------------------------------------------------
  const rows = terrain.rows;
  const width = p.width > 0 ? p.width : terrain.width;
  const height = p.height > 0 ? p.height : terrain.height;
  const x0 = Math.max(0, Math.floor(opts.camera.originX));
  const y0 = Math.max(0, Math.floor(opts.camera.originY));
  const x1 = Math.min(width - 1, Math.ceil(opts.camera.originX + cssW / tile));
  const y1 = Math.min(height - 1, Math.ceil(opts.camera.originY + cssH / tile));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      drawTile(ctx, x, y, layout, rows[y]?.[x] === ':', cssW, cssH);
    }
  }

  const cells = indexObjects(p.objects);

  // --- objects ------------------------------------------------------------
  for (const obj of p.objects) {
    const px = offX + obj.pos.x * tile;
    const py = offY + obj.pos.y * tile;
    if (px > cssW || py > cssH || px + tile < 0 || py + tile < 0) continue;
    blit(ctx, getSprite(objectSprite(cells, obj)), px, py, pixel);
  }

  // --- sites and cracks ---------------------------------------------------
  for (const obj of p.objects) {
    const px = offX + obj.pos.x * tile;
    const py = offY + obj.pos.y * tile;
    if (px > cssW || py > cssH || px + tile < 0 || py + tile < 0) continue;
    if (obj.site) {
      blit(ctx, getSprite('wip'), px, py, pixel);
    } else if (obj.crack) {
      blit(ctx, getSprite('crack'), px, py, pixel);
    }
  }

  // --- outside queue ------------------------------------------------------
  // Waiters stand on the `q`/`r` cells; the ground layer already draws those
  // cells as no-build, so only the bodies are added here.
  const stunnedIds = new Set(
    p.agents.filter((agent) => p.tick < agent.stun_until).map((agent) => agent.id),
  );
  for (const entry of p.queue) {
    const px = offX + entry.pos.x * tile;
    const py = offY + entry.pos.y * tile;
    if (px > cssW || py > cssH || px + tile < 0 || py + tile < 0) continue;
    if (stunnedIds.has(entry.id)) ctx.globalAlpha = 0.6;
    blit(ctx, getSprite('bot', agentColor(entry.color)), px, py, pixel);
    ctx.globalAlpha = 1;
  }

  // --- agents -------------------------------------------------------------
  const frames = opts.prev ? interpolate(p, opts.prev, opts.now, opts.reduceMotion) : interpolate(p, p, opts.now, true);
  const selected = opts.selected;

  for (const frame of frames) {
    const { agent, look } = frame;
    const px = offX + frame.x * tile;
    const py = offY + frame.y * tile;
    if (px > cssW + tile || py > cssH + tile || px + tile < -tile || py + tile < -tile) continue;
    const bob = opts.reduceMotion ? 0 : look.sit || look.stunned ? 0 : bobPhase(opts.now);
    const bodyY = py - (bob ? pixel : 0);
    const color = agentColor(agent.color);
    const body = getSprite(look.sit ? 'bot-sit' : 'bot', color);
    if (look.stunned) ctx.globalAlpha = 0.6;
    blit(ctx, body, px, bodyY, pixel);
    const faceY = look.sit ? bodyY + 5 * pixel : bodyY;
    blit(ctx, getSprite(look.face), px, faceY, pixel);
    ctx.globalAlpha = 1;
  }

  // --- effects ------------------------------------------------------------
  // Reduced motion freezes the loops but keeps every static cue (shield,
  // hammer, sweat, hit spark) on screen.
  for (const frame of frames) {
      const { agent, look } = frame;
      const px = offX + frame.x * tile;
      const py = offY + frame.y * tile;
      if (px > cssW + tile || py > cssH + tile || px + tile < -tile || py + tile < -tile) continue;
      const blinkA = opts.reduceMotion || blinkPhase(opts.now);
      const blinkB = opts.reduceMotion || blinkPhase(opts.now, 500);
      const shake = look.urgent && !opts.reduceMotion ? shakePhase(opts.now) : 0;
      const sway = shake ? pixel : 0;

      if (look.sweat) {
        blit(ctx, getSprite('sw'), px, py, pixel);
      }
      if (look.hammer) {
        const delta = FACING_DELTA[agent.facing];
        const swing = opts.reduceMotion || Math.floor(opts.now / 300) % 2 === 0 ? 0 : -pixel;
        blit(ctx, getSprite('ham'), px + delta.x * 12 * pixel + sway, py + delta.y * 4 * pixel + swing, pixel);
      }
      if (look.shield && agent.defending) {
        const dx = Math.sign(agent.defending.x - agent.pos.x);
        const dy = Math.sign(agent.defending.y - agent.pos.y);
        blit(
          ctx,
          getSprite('sh'),
          px + 4 * pixel + dx * 3 * pixel + sway,
          py + 8 * pixel + dy * 3 * pixel,
          pixel,
        );
      }
      if (look.punch && blinkA) {
        const delta = FACING_DELTA[agent.facing];
        blit(ctx, getSprite('pow'), px + delta.x * 9 * pixel - 2 * pixel + sway, py + delta.y * 9 * pixel + 4 * pixel, pixel);
      }
      if (look.stunned) {
        if (blinkA) blit(ctx, getSprite('sp'), px + pixel, py - 4 * pixel, pixel);
        if (blinkB) blit(ctx, getSprite('sp'), px + 10 * pixel, py - 3 * pixel, pixel);
      }
      if (look.success) {
        if (blinkA) blit(ctx, getSprite('sp'), px - 3 * pixel, py - 2 * pixel, pixel);
        if (blinkB) blit(ctx, getSprite('sp'), px + 14 * pixel, py + 3 * pixel, pixel);
      }
    }

    // The golden toilet keeps two sparkles going (README §5).
    for (const obj of p.objects) {
      if (obj.kind !== 'toilet' || obj.level < 5) continue;
      const px = offX + obj.pos.x * tile;
      const py = offY + obj.pos.y * tile;
      if (px > cssW || py > cssH || px + tile < 0 || py + tile < 0) continue;
      if (opts.reduceMotion || blinkPhase(opts.now)) {
        blit(ctx, getSprite('sp'), px - 3 * pixel, py - 2 * pixel, pixel);
      }
      if (opts.reduceMotion || blinkPhase(opts.now, 500)) {
        blit(ctx, getSprite('sp'), px + 14 * pixel, py + 3 * pixel, pixel);
      }
    }

  // --- progress bars ------------------------------------------------------
  for (const obj of p.objects) {
    const px = offX + obj.pos.x * tile;
    const py = offY + obj.pos.y * tile;
    if (px > cssW || py > cssH || px + tile < 0 || py + tile < 0) continue;
    const center = px + tile / 2;
    const top = py - 4 * pixel;
    if (obj.site) {
      if (obj.progress_total > 0) {
        drawBar(ctx, center, top, layout, obj.progress / obj.progress_total, GOLD);
      }
    } else if (obj.kind === 'toilet') {
      if (obj.progress_total > 0 && obj.progress > 0) {
        drawBar(ctx, center, top, layout, obj.progress / obj.progress_total, GOLD);
      }
    } else if (obj.crack && obj.progress_total > 0) {
      drawBar(ctx, center, top, layout, obj.progress / obj.progress_total, RED);
    }
  }

  for (const frame of frames) {
    const { agent } = frame;
    if (agent.pose !== 'using' || agent.use_total <= 0) continue;
    const px = offX + frame.x * tile;
    const py = offY + frame.y * tile;
    drawBar(ctx, px + tile / 2, py - 4 * pixel, layout, agent.use_done / agent.use_total, GREEN);
  }

  // --- nicknames ----------------------------------------------------------
  for (const frame of frames) {
    const px = offX + frame.x * tile;
    const py = offY + frame.y * tile;
    if (px > cssW + tile || py > cssH + tile || px + tile < -tile || py + tile < -tile) continue;
    drawLabel(
      ctx,
      frame.agent.nick,
      px + tile / 2,
      py + tile + 3,
      layout,
      frame.agent.id === selected,
      frame.agent.kind === 'human',
    );
  }

  // --- selection and vision ----------------------------------------------
  const target = frames.find((frame) => frame.agent.id === selected);
  if (target) {
    const px = Math.round(offX + target.x * tile);
    const py = Math.round(offY + target.y * tile);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(px + 0.5, py + 0.5, tile - 1, tile - 1);

    const visionX0 = Math.max(0, target.agent.pos.x - 4);
    const visionX1 = Math.min(width - 1, target.agent.pos.x + 4);
    const visionY0 = Math.max(0, target.agent.pos.y - 4);
    const visionY1 = Math.min(height - 1, target.agent.pos.y + 4);
    ctx.setLineDash([3 * zoom, 2 * zoom]);
    ctx.strokeRect(
      offX + visionX0 * tile + 0.5,
      offY + visionY0 * tile + 0.5,
      (visionX1 - visionX0 + 1) * tile - 1,
      (visionY1 - visionY0 + 1) * tile - 1,
    );
    ctx.setLineDash([]);
  }
}

/** Which agent sits under a CSS-pixel point, if any. */
export function hitTest(
  p: Projection,
  terrain: Terrain,
  camera: Camera,
  cssX: number,
  cssY: number,
): number | null {
  const layout = layoutOf(camera);
  const x = Math.floor((cssX - layout.offX) / layout.tile);
  const y = Math.floor((cssY - layout.offY) / layout.tile);
  const width = p.width > 0 ? p.width : terrain.width;
  const height = p.height > 0 ? p.height : terrain.height;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  for (const agent of p.agents) {
    if (agent.pos.x === x && agent.pos.y === y) return agent.id;
  }
  return null;
}
