import * as THREE from 'three';
import type { ProjectionAgent, ProjectionObject, Terrain } from '../types';
import { cellAt, cellKey } from './grid';
import { duskK } from './lighting';
import { clearLampSources, setLampSources, type LampSource } from './lamplight';
import {
  ACCENT,
  barrier,
  cornerPost,
  doorFlag,
  doorSide,
  flagMaterial,
  gate,
  levelBadge,
  plankCount,
  plankWall,
  ROOF_EAVE,
  ROOF_RIDGE,
  roof,
  roofPalette,
  sandbagWall,
  scaffold,
  shackFloor,
  shackSeed,
  signalLamp,
  signMaterial,
  toiletModel,
  WH,
} from './shack';
import type { FrameInput, Layer, SceneCtx } from './types';

const PI = Math.PI;
const WALL_LEN = 2.62;
const RIM = 1.42;
const ROOF_RISE = 1.2;
const ROOF_ALPHA_BUSY = 0.03;
const GHOST_OPACITY = 0.45;
const GHOST_SHIFT = 0.35;
const GHOST_LIFT = 0.15;
const DEMOLISH_SINK = 0.35;
const LAMP_ON = 1.4;
const LAMP_OFF = 0.2;
const LAMP_YELLOW = 0xf2c230;
const LAMP_RED = 0xe5484d;
const LAMP_GREEN = 0x4cc964;
const LAMP_GREY = 0xd8dcd6;
const LAMP_GREY_GLOW = 0.5;
const HALO_LIT = 0.8;
const HALO_DIM = 0.15;
const MAX_LEVEL = 5;
const DOOR_SWING = 0.45 * PI;
const FLAG_H = 0.6;
const FLAG_NORTH_H = ROOF_RIDGE - ROOF_EAVE + 0.7;
const BADGE_Z = 0.18;
const BADGE_LIFT = 0.22;
const BADGE_SHOWN = 0.5;
const SHACK_LIGHT_Y = 1.0;
const SHACK_LIGHT_DIST = 5;
const SHACK_LIGHT_INTENSITY = 1.8;
const SHACK_LIGHT_COLOR: [number, number, number] = [1, 0xb0 / 255, 0x60 / 255];
const SHACK_OWNER = 'shack-lamps';

const SIDES = [
  { dx: 0, dy: -1, rot: 0 },
  { dx: 1, dy: 0, rot: PI / 2 },
  { dx: 0, dy: 1, rot: 0 },
  { dx: -1, dy: 0, rot: PI / 2 },
] as const;

type Idx = Map<string, ProjectionObject>;

function indexObjects(objs: ProjectionObject[]): Idx {
  const m: Idx = new Map();
  for (const o of objs) m.set(cellKey(o.pos.x, o.pos.y), o);
  return m;
}

function progressOf(o: ProjectionObject): number {
  return o.progress_total > 0 ? o.progress / o.progress_total : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sameKind(prev: ProjectionObject | undefined, cur: ProjectionObject): ProjectionObject | undefined {
  return prev && prev.kind === cur.kind && !prev.site === !cur.site ? prev : undefined;
}

function isComplete(o: ProjectionObject | undefined): boolean {
  return !!o && (o.kind === 'wall' || o.kind === 'door') && o.site == null;
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) c.geometry.dispose();
    else if (!(c instanceof THREE.Sprite)) return;
    const src = c as THREE.Mesh | THREE.Sprite;
    for (const mat of ([] as THREE.Material[]).concat(src.material)) if (mat.userData.own) mat.dispose();
  });
}

class Registry {
  private readonly slots = new Map<string, THREE.Object3D>();
  private used = new Set<string>();

  constructor(private readonly root: THREE.Group) {}

  begin(): void {
    this.used = new Set();
  }

  get(key: string, make: () => THREE.Object3D): THREE.Object3D {
    this.used.add(key);
    let o = this.slots.get(key);
    if (!o) {
      o = make();
      this.root.add(o);
      this.slots.set(key, o);
    }
    return o;
  }

  end(): void {
    for (const [key, o] of this.slots) {
      if (this.used.has(key)) continue;
      o.removeFromParent();
      disposeTree(o);
      this.slots.delete(key);
    }
  }

  dispose(): void {
    for (const o of this.slots.values()) {
      o.removeFromParent();
      disposeTree(o);
    }
    this.slots.clear();
  }
}

function toGhost(g: THREE.Group): THREE.Group {
  g.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    const mat = src.clone();
    if (src.userData.own) src.dispose();
    mat.transparent = true;
    mat.opacity = GHOST_OPACITY;
    mat.depthWrite = false;
    mat.userData.own = true;
    m.material = mat;
  });
  return g;
}

function setOpacity(g: THREE.Object3D, opacity: number): void {
  g.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) (m.material as THREE.Material).opacity = opacity;
  });
}

function agentOn(agents: ProjectionAgent[], x: number, y: number): boolean {
  return agents.some((a) => a.pos.x === x && a.pos.y === y);
}

function agentNear(agents: ProjectionAgent[], x: number, y: number): boolean {
  return agents.some((a) => Math.abs(a.pos.x - x) <= 1 && Math.abs(a.pos.y - y) <= 1);
}

function demolishing(agents: ProjectionAgent[], x: number, y: number): boolean {
  return agents.some((a) => a.pose === 'demolishing' && a.action_target != null && a.action_target.x === x && a.action_target.y === y);
}

export function createObjectsLayer(ctx: SceneCtx): Layer {
  const worldId = ctx.worldId;
  const root = new THREE.Group();
  ctx.world.add(root);
  const reg = new Registry(root);

  function frame(input: FrameInput): void {
    const { cur, prev, phase, clock, ui } = input;
    const terrain: Terrain = input.terrain;
    const e = phase * phase * (3 - 2 * phase);
    const k = duskK(ui, clock);
    const shackSources: LampSource[] = [];
    const cIdx = indexObjects(cur.objects);
    const pIdx = prev ? indexObjects(prev.objects) : null;
    const curAgents = cur.agents;
    const prevAgents = prev ? prev.agents : [];
    const wild = (x: number, y: number): boolean => cellAt(terrain, x, y) === '~';
    const curSide = (x: number, y: number): ProjectionObject | undefined => (wild(x, y) ? undefined : cIdx.get(cellKey(x, y)));
    const prevSide = (x: number, y: number): ProjectionObject | undefined =>
      wild(x, y) ? undefined : pIdx?.get(cellKey(x, y));
    const sidesComplete = (get: (x: number, y: number) => ProjectionObject | undefined, x: number, y: number): boolean =>
      SIDES.every((s) => isComplete(get(x + s.dx, y + s.dy)));
    const wallLike = (x: number, y: number): boolean => {
      const o = curSide(x, y);
      return !!o && (o.kind === 'wall' || o.kind === 'pillar');
    };
    const wallOnly = (x: number, y: number): boolean => {
      const o = curSide(x, y);
      return !!o && o.kind === 'wall';
    };
    const alongXFor = (x: number, y: number): boolean => {
      if (wallLike(x - 1, y) || wallLike(x + 1, y)) return true;
      if (wallOnly(x, y - 1) || wallOnly(x, y + 1)) return false;
      return true;
    };

    reg.begin();

    const toilets = cur.objects.filter((o) => o.kind === 'toilet' && !wild(o.pos.x, o.pos.y));
    const shackCells = new Set<string>();
    const diagonalPillars = new Set<string>();
    for (const t of toilets) {
      const tx = t.pos.x + 0.5;
      const tz = t.pos.y + 0.5;
      const tk = cellKey(t.pos.x, t.pos.y);
      const occupied = agentOn(curAgents, t.pos.x, t.pos.y);
      for (const s of SIDES) shackCells.add(cellKey(t.pos.x + s.dx, t.pos.y + s.dy));

      reg.get('floor:' + tk, () => shackFloor()).position.set(tx, 0, tz);

      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const cx = t.pos.x + sx;
          const cy = t.pos.y + sy;
          const pillar = cIdx.get(cellKey(cx, cy));
          if (!pillar || pillar.kind !== 'pillar') continue;
          diagonalPillars.add(cellKey(cx, cy));
          const post = reg.get(`post:${cellKey(cx, cy)}@${tk}`, () => cornerPost());
          post.position.set(tx + sx * RIM, 0, tz + sy * RIM);
          if (sx === 1 && sy === -1) {
            const lamp = reg.get('lamp:' + tk, () => signalLamp()) as THREE.Group;
            lamp.position.set(tx + RIM, WH + 0.1, tz - RIM);
            const mat = lamp.userData.mat as THREE.MeshStandardMaterial;
            const halo = lamp.userData.halo as THREE.Sprite;
            const busy = t.site === 'toilet' || t.progress !== 0;
            let color = LAMP_GREY;
            let emissive = LAMP_GREY_GLOW;
            let lit = false;
            if (busy) {
              color = LAMP_YELLOW;
              lit = Math.sin(clock * 6) > 0;
              emissive = lit ? LAMP_ON : LAMP_OFF;
            } else if (occupied) {
              color = LAMP_RED;
              lit = true;
              emissive = LAMP_ON;
            } else if (sidesComplete(curSide, t.pos.x, t.pos.y)) {
              color = LAMP_GREEN;
              lit = true;
              emissive = LAMP_ON;
            }
            mat.color.setHex(color);
            mat.emissive.setHex(color);
            mat.emissiveIntensity = emissive;
            halo.material.color.setHex(color);
            halo.material.opacity = lit ? HALO_LIT : HALO_DIM;
          }
        }
      }

      if (t.site !== 'toilet' && t.level >= 1) {
        shackSources.push({ x: tx, z: tz, y: SHACK_LIGHT_Y, color: SHACK_LIGHT_COLOR, intensity: SHACK_LIGHT_INTENSITY, distance: SHACK_LIGHT_DIST });
      }

      const prevT = pIdx ? sameKind(pIdx.get(cellKey(t.pos.x, t.pos.y)), t) : undefined;
      const pCur = progressOf(t);
      const p = prevT ? lerp(progressOf(prevT), pCur, e) : pCur;
      const level = Math.max(1, Math.min(MAX_LEVEL, t.level));
      const busyDemolish = demolishing(curAgents, t.pos.x, t.pos.y);
      const bodyPos = (obj: THREE.Object3D, y = 0): void => {
        obj.position.set(tx, y, tz);
      };

      if (t.site === 'toilet') {
        bodyPos(reg.get('barrier:' + tk, () => barrier()));
        const ghost = reg.get(`ghost:${tk}:1`, () => toGhost(toiletModel(1, false)));
        bodyPos(ghost);
        ghost.scale.y = Math.max(0.001, p);
      } else if (t.progress !== 0) {
        bodyPos(reg.get('barrier:' + tk, () => barrier()));
        if (busyDemolish) {
          const model = reg.get(`model:${tk}:${level}`, () => toiletModel(level));
          bodyPos(model, -DEMOLISH_SINK * p);
        } else {
          bodyPos(reg.get(`model:${tk}:${level}`, () => toiletModel(level)));
          const next = Math.min(level + 1, MAX_LEVEL);
          const ghost = reg.get(`ghost:${tk}:${next}`, () => toGhost(toiletModel(next, false)));
          bodyPos(ghost, GHOST_LIFT * (1 - p));
          ghost.position.x += GHOST_SHIFT;
          setOpacity(ghost, 0.25 + 0.5 * p);
        }
      } else {
        bodyPos(reg.get(`model:${tk}:${level}`, () => toiletModel(level)));
      }

      for (const s of SIDES) {
        const wx = t.pos.x + s.dx;
        const wy = t.pos.y + s.dy;
        if (wild(wx, wy)) continue;
        const o = cIdx.get(cellKey(wx, wy));
        if (!o) continue;
        const ck = cellKey(wx, wy);
        const ox = tx + s.dx * RIM;
        const oz = tz + s.dy * RIM;
        const faceRot = s.rot;
        const prevO = pIdx ? sameKind(pIdx.get(ck), o) : undefined;

        if (o.kind === 'wall' && o.site == null) {
          const d = progressOf(o);
          const hidden = o.crack ? Math.round(plankCount(WALL_LEN) * d * 0.6) : 0;
          const tilt = o.crack ? 0.06 * d : 0;
          const shake = demolishing(curAgents, wx, wy) ? Math.sin(clock * 40) * 0.02 : 0;
          const outer = reg.get(`side:${ck}@${tk}:${hidden}`, () => {
            const g = new THREE.Group();
            const inner = new THREE.Group();
            const wall = plankWall(WALL_LEN, shackSeed(worldId, wx, wy, 5), true, hidden);
            inner.add(wall);
            g.add(inner);
            g.userData.inner = inner;
            g.userData.glass = wall.children.find((c) => c.userData.win) ?? null;
            return g;
          }) as THREE.Group;
          outer.position.set(ox, 0, oz);
          outer.rotation.y = faceRot;
          (outer.userData.inner as THREE.Group).rotation.x = tilt + shake;
          const glass = outer.userData.glass as THREE.Mesh | null;
          if (glass) (glass.material as THREE.MeshStandardMaterial).emissiveIntensity = occupied ? 1.6 * k : 0;
        } else if (o.kind === 'wall') {
          const pw = prevO ? lerp(progressOf(prevO), progressOf(o), e) : progressOf(o);
          const site = reg.get(`siteWall:${ck}@${tk}`, () => {
            const g = new THREE.Group();
            g.add(scaffold(WALL_LEN));
            g.add(plankWall(WALL_LEN, shackSeed(worldId, wx, wy, 5), false, 0));
            return g;
          });
          site.position.set(ox, 0, oz);
          site.rotation.y = faceRot;
          site.scale.y = Math.max(0.001, pw);
        } else if (o.kind === 'door' && o.site == null) {
          const prevOpen = prevO ? (prevO.open ? 1 : 0) : o.open ? 1 : 0;
          const a = lerp(prevOpen, o.open ? 1 : 0, e) * DOOR_SWING;
          const dr = reg.get(`sideDoor:${ck}@${tk}`, () => {
            const d = doorSide(shackSeed(worldId, wx, wy, 6), ACCENT);
            d.group.userData.pivot = d.pivot;
            d.group.userData.sign = d.sign;
            d.group.userData.top = d.top;
            return d.group;
          });
          dr.position.set(ox, 0, oz);
          dr.rotation.y = faceRot;
          const pivot = dr.userData.pivot as THREE.Group;
          pivot.rotation.y = -a;
          (dr.userData.sign as THREE.Mesh).material = signMaterial(o.open);
          (dr.userData.top as THREE.Mesh).material = signMaterial(o.open);
          const flag = reg.get(`flag:${ck}@${tk}`, () => doorFlag(s.dy < 0 ? FLAG_NORTH_H : FLAG_H));
          flag.position.set(ox, WH + ROOF_EAVE, oz);
          flag.rotation.y = faceRot;
          (flag.userData.cloth as THREE.Mesh).material = flagMaterial(phase < 0.5 && prevO ? prevO.open : o.open);
        } else if (o.kind === 'door') {
          const pd = prevO ? lerp(progressOf(prevO), progressOf(o), e) : progressOf(o);
          const site = reg.get(`siteDoor:${ck}@${tk}`, () => {
            const g = new THREE.Group();
            g.add(scaffold(WALL_LEN));
            const d = doorSide(shackSeed(worldId, wx, wy, 6), ACCENT);
            d.sign.material = signMaterial(false);
            d.top.material = signMaterial(false);
            g.add(d.group);
            return g;
          });
          site.position.set(ox, 0, oz);
          site.rotation.y = faceRot;
          site.scale.y = Math.max(0.001, pd);
        }
      }

      const occPrev = prev ? agentNear(prevAgents, t.pos.x, t.pos.y) : false;
      const occCur = agentNear(curAgents, t.pos.x, t.pos.y);
      const hover = ui.hoverToilet != null && ui.hoverToilet.x === t.pos.x && ui.hoverToilet.y === t.pos.y;
      const prevToilet = pIdx?.get(tk);
      const busyCur = t.site === 'toilet' || t.progress !== 0;
      const busyPrev = !!prevToilet && prevToilet.kind === 'toilet' && (prevToilet.site === 'toilet' || prevToilet.progress !== 0);
      const aCur = hover || occCur || busyCur ? ROOF_ALPHA_BUSY : 1;
      const aPrev = hover || occPrev || busyPrev ? ROOF_ALPHA_BUSY : 1;
      const roofCur = sidesComplete(curSide, t.pos.x, t.pos.y);
      const roofPrev = prevToilet?.kind === 'toilet' && sidesComplete(prevSide, t.pos.x, t.pos.y);
      let alpha = 0;
      let y = WH;
      if (!prev) {
        alpha = roofCur ? aCur : 0;
      } else if (roofCur && roofPrev) {
        alpha = lerp(aPrev, aCur, e);
      } else if (roofCur) {
        alpha = aCur * e;
        y = WH + ROOF_RISE * (1 - e);
      } else if (roofPrev) {
        alpha = aPrev * (1 - e);
        y = WH + ROOF_RISE * e;
      }
      if (roofCur || roofPrev) {
        const r = reg.get('roof:' + tk, () => {
          const built = roof(roofPalette(worldId, t.pos.x, t.pos.y));
          built.group.userData.mats = built.materials;
          return built.group;
        });
        r.position.set(tx, y, tz);
        r.visible = alpha >= 0.02;
        const mats = r.userData.mats as THREE.Material[];
        for (const m of mats) {
          m.opacity = alpha;
          m.depthWrite = alpha > 0.9;
        }
        r.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) c.castShadow = alpha > 0.5;
        });
      }

      if (t.site !== 'toilet' && t.level >= 1) {
        const badge = reg.get(`badge:${tk}:${level}`, () => levelBadge(level));
        badge.position.set(tx, y + ROOF_RIDGE + BADGE_LIFT, tz + BADGE_Z);
        badge.visible = alpha >= BADGE_SHOWN;
      }
    }

    setLampSources(SHACK_OWNER, shackSources);

    for (const obj of cur.objects) {
      const ck = cellKey(obj.pos.x, obj.pos.y);
      if (wild(obj.pos.x, obj.pos.y) || obj.kind === 'toilet') continue;
      if (obj.kind === 'pillar') {
        if (diagonalPillars.has(ck)) continue;
        const post = reg.get('post:' + ck, () => cornerPost());
        post.position.set(obj.pos.x + 0.5, 0, obj.pos.y + 0.5);
        continue;
      }
      if (shackCells.has(ck)) continue;
      const alongX = alongXFor(obj.pos.x, obj.pos.y);
      const ax = alongX ? 1 : 0;
      const cx = obj.pos.x + 0.5;
      const cz = obj.pos.y + 0.5;
      const prevO = pIdx ? sameKind(pIdx.get(ck), obj) : undefined;
      const p = prevO ? lerp(progressOf(prevO), progressOf(obj), e) : progressOf(obj);

      if (obj.kind === 'wall' && obj.site == null) {
        const d = progressOf(obj);
        const removed = obj.crack ? Math.floor(d * 2) : 0;
        const g = reg.get(`free:${ck}:${ax}`, () => sandbagWall(alongX, shackSeed(worldId, obj.pos.x, obj.pos.y, 61)));
        g.position.set(cx, 0, cz);
        g.children.forEach((layer, i) => (layer.visible = i < 3 - removed));
      } else if (obj.kind === 'wall') {
        const layers = Math.ceil(p * 3);
        const g = reg.get(`freeSite:${ck}:${ax}`, () => {
          const w = new THREE.Group();
          w.add(sandbagWall(alongX, shackSeed(worldId, obj.pos.x, obj.pos.y, 61)));
          w.add(cornerPost());
          return w;
        });
        g.position.set(cx, 0, cz);
        const bags = g.children[0] as THREE.Group;
        bags.children.forEach((layer, i) => (layer.visible = i < layers));
      } else if (obj.kind === 'door' && obj.site == null) {
        const prevOpen = prevO ? (prevO.open ? 1 : 0) : obj.open ? 1 : 0;
        const a = lerp(prevOpen, obj.open ? 1 : 0, e) * DOOR_SWING;
        const g = reg.get(`freeDoor:${ck}:${ax}`, () => gate(alongX));
        g.position.set(cx, 0, cz);
        (g.userData.pivot as THREE.Group).rotation.y = -a;
        (g.userData.sign as THREE.Mesh).material = signMaterial(obj.open);
      } else if (obj.kind === 'door') {
        const g = reg.get(`freeDoorSite:${ck}:${ax}`, () => gate(alongX));
        g.position.set(cx, 0, cz);
        (g.userData.pivot as THREE.Group).scale.y = Math.max(0.001, p);
      }
    }

    reg.end();
  }

  return {
    update(input) {
      frame(input);
    },
    dispose() {
      reg.dispose();
      clearLampSources(SHACK_OWNER);
      root.removeFromParent();
    },
  };
}
