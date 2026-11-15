// The `/play` board: exactly the 9×9 window from `GET /api/play/state`, drawn
// at an integer zoom with the sprites from `docs/art/sprites.svg`. The
// spectator's whole-world `drawWorld` is deliberately not reused: this view
// has no camera, no queue strip and no other players' private state.

import { URGENT_TICKS } from '../render';
import { AGENT_COLORS, getSprite } from '../sprites';
import type { SpriteId } from '../sprites';
import type {
  AgentPose,
  PlayAgent,
  PlayState,
  Pos,
  ProjectionObject,
  Terrain,
  Tick,
} from '../types';

export const PLAY_TILE = 16;

/** 390-wide phones: 9 × 16 × 2 = 288 px. */
export const PLAY_ZOOM_COMPACT = 2;
/** Wider screens: 9 × 16 × 3 = 432 px. */
export const PLAY_ZOOM_WIDE = 3;

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

export interface PlayBoardOptions {
  state: PlayState;
  terrain: Terrain;
  zoom: number;
  selected: Pos | null;
  reduceMotion: boolean;
  now: number;
}

interface CellMap {
  get(x: number, y: number): ProjectionObject | null;
}

function indexObjects(objects: ProjectionObject[]): CellMap {
  const table = new Map<string, ProjectionObject>();
  for (const object of objects) table.set(`${object.pos.x},${object.pos.y}`, object);
  return {
    get: (x, y) => table.get(`${x},${y}`) ?? null,
  };
}

/** The `w`/`wt` pair: a wall with a wall directly south shows only its top. */
function objectSprite(cells: CellMap, object: ProjectionObject): SpriteId {
  switch (object.kind) {
    case 'wall':
      return cells.get(object.pos.x, object.pos.y + 1)?.kind === 'wall' ? 'wt' : 'w';
    case 'door':
      return object.open ? 'do' : 'dc';
    case 'toilet': {
      const level = Math.min(5, Math.max(1, Math.round(object.level)));
      return `t${level}` as SpriteId;
    }
  }
}

function agentColor(index: number): string {
  const n = AGENT_COLORS.length;
  return AGENT_COLORS[((index % n) + n) % n];
}

function agentFace(
  agent: PlayAgent,
  pose: AgentPose,
  tick: Tick,
): { sit: boolean; face: SpriteId; urgent: boolean } {
  const urgent =
    agent.need !== null &&
    agent.deadline_tick > tick &&
    agent.deadline_tick - tick <= URGENT_TICKS;
  switch (pose) {
    case 'using':
      return { sit: true, face: 'f-joy', urgent };
    case 'working':
      return { sit: false, face: 'f-work', urgent };
    case 'demolishing':
    case 'attacking':
      return { sit: false, face: 'f-mad', urgent };
    case 'stunned':
      return { sit: false, face: 'f-stun', urgent };
    case 'success':
      return { sit: false, face: 'f-joy', urgent };
    default:
      return { sit: false, face: urgent ? 'f-urg' : 'f-ok', urgent };
  }
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  centerPx: number,
  topPy: number,
  zoom: number,
  fraction: number,
  color: string,
): void {
  const width = 14 * zoom;
  const height = 3 * zoom;
  const left = Math.round(centerPx - width / 2);
  ctx.fillStyle = INK;
  ctx.fillRect(left, Math.round(topPy), width, height);
  ctx.fillStyle = color;
  ctx.fillRect(
    left + zoom,
    Math.round(topPy) + zoom,
    Math.round(12 * zoom * Math.min(1, Math.max(0, fraction))),
    zoom,
  );
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  nick: string,
  centerPx: number,
  topPy: number,
  zoom: number,
  cssW: number,
  mine: boolean,
): void {
  const fontPx = Math.max(9, 5 * zoom);
  ctx.font = `400 ${fontPx}px Silkscreen, ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textWidth = Math.ceil(ctx.measureText(nick).width);
  const pad = Math.max(3, Math.round(fontPx * 0.3));
  const width = textWidth + pad * 2;
  const height = fontPx + 2;
  const left = Math.round(Math.min(cssW - width, Math.max(0, centerPx - width / 2)));
  const top = Math.round(topPy);
  ctx.fillStyle = LABEL_BG;
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = mine ? GOLD : LABEL_FG;
  ctx.fillText(nick, left + width / 2, top + height / 2 + 1);
}

export function drawPlayWindow(canvas: HTMLCanvasElement, opts: PlayBoardOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { state, terrain, zoom } = opts;
  const { width, height } = state.window;
  if (width <= 0 || height <= 0) return;

  const cssW = width * PLAY_TILE * zoom;
  const cssH = height * PLAY_TILE * zoom;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
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

  const tile = PLAY_TILE * zoom;
  const origin = state.window.origin;
  const px = (x: number) => (x - origin.x) * tile;
  const py = (y: number) => (y - origin.y) * tile;

  // --- ground -------------------------------------------------------------
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const x = origin.x + col;
      const y = origin.y + row;
      const left = col * tile;
      const top = row * tile;
      const noBuild = terrain.rows[y]?.[x] === ':';
      ctx.fillStyle = noBuild ? CORRIDOR : (x + y) % 2 === 0 ? FLOOR_A : FLOOR_B;
      ctx.fillRect(left, top, tile, tile);
      ctx.fillStyle = noBuild ? CORRIDOR_LINE : FLOOR_LINE;
      ctx.fillRect(left + tile - 1, top, 1, tile);
      ctx.fillRect(left, top + tile - 1, tile, 1);
    }
  }

  const cells = indexObjects(state.objects);

  // --- objects, sites and cracks -----------------------------------------
  for (const object of state.objects) {
    const left = px(object.pos.x);
    const top = py(object.pos.y);
    ctx.drawImage(getSprite(objectSprite(cells, object)), left, top, tile, tile);
    if (object.site) ctx.drawImage(getSprite('wip'), left, top, tile, tile);
    else if (object.crack) ctx.drawImage(getSprite('crack'), left, top, tile, tile);
  }

  // --- agents -------------------------------------------------------------
  const me = state.me.agent_id;
  for (const agent of state.agents) {
    const left = px(agent.pos.x);
    const top = py(agent.pos.y);
    const stunned = state.tick < agent.stun_until;
    const look = agentFace(agent, agent.pose, state.tick);
    if (stunned) ctx.globalAlpha = 0.6;
    ctx.drawImage(
      getSprite(look.sit ? 'bot-sit' : 'bot', agentColor(agent.color)),
      left,
      top,
      tile,
      tile,
    );
    // Faces on a seated body shift down with the body (README §4).
    ctx.drawImage(getSprite(look.face), left, top + (look.sit ? 5 * zoom : 0), tile, tile);
    ctx.globalAlpha = 1;

    if (look.urgent) ctx.drawImage(getSprite('sw'), left, top, tile, tile);
    if (agent.defending) {
      const dx = Math.sign(agent.defending.x - agent.pos.x);
      const dy = Math.sign(agent.defending.y - agent.pos.y);
      ctx.drawImage(
        getSprite('sh'),
        left + 4 * zoom + dx * 3 * zoom,
        top + 8 * zoom + dy * 3 * zoom,
        7 * zoom,
        8 * zoom,
      );
    }
    if (agent.id === me) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(left + 0.5, top + 0.5, tile - 1, tile - 1);
    }
  }

  // --- progress bars ------------------------------------------------------
  for (const object of state.objects) {
    const left = px(object.pos.x);
    const top = py(object.pos.y);
    if (object.site && object.progress_total > 0) {
      drawBar(ctx, left + tile / 2, top - 4 * zoom, zoom, object.progress / object.progress_total, GOLD);
    } else if (object.crack && object.progress_total > 0) {
      drawBar(ctx, left + tile / 2, top - 4 * zoom, zoom, object.progress / object.progress_total, RED);
    } else if (object.kind === 'toilet' && object.progress_total > 0 && object.progress > 0) {
      drawBar(ctx, left + tile / 2, top - 4 * zoom, zoom, object.progress / object.progress_total, GOLD);
    }
  }
  for (const agent of state.agents) {
    if (agent.pose !== 'using' || agent.use_total <= 0) continue;
    drawBar(
      ctx,
      px(agent.pos.x) + tile / 2,
      py(agent.pos.y) - 4 * zoom,
      zoom,
      agent.use_done / agent.use_total,
      GREEN,
    );
  }

  // --- nicknames ----------------------------------------------------------
  for (const agent of state.agents) {
    drawLabel(
      ctx,
      agent.nick,
      px(agent.pos.x) + tile / 2,
      py(agent.pos.y) + tile + 3,
      zoom,
      cssW,
      agent.id === me,
    );
  }

  // --- selected cell ------------------------------------------------------
  if (opts.selected) {
    const left = px(opts.selected.x);
    const top = py(opts.selected.y);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    ctx.setLineDash([3 * zoom, 2 * zoom]);
    ctx.strokeRect(left + 1, top + 1, tile - 2, tile - 2);
    ctx.setLineDash([]);
  }
}
