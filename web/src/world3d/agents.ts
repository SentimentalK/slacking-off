import * as THREE from 'three';
import { AGENT_COLORS } from '../palette';
import type { AgentPose, Dir, Pos, ProjectionAgent, ProjectionQueueEntry } from '../types';
import { buildDuck, disposeDuck, type Duck } from './duck';
import type { FrameInput, Layer, SceneCtx } from './types';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const HIP_Y = 0.28;
const SEAT_Y = 0.3;
const EYE_Y = 2.3;
const RED = 0xe5484d;
const GOLD = 0xffd23f;
const GRAY = 0x8a8f8a;
const BLUE = 0x58b7ff;
const UP = new THREE.Vector3(0, 1, 0);
const STAR_Y = 1.76;
const ICON_NEAR = 33;
const ICON_MAX = 3.6;
const ICON_OUTLINE = '#16120e';
const ICON_LIFT = 0.45;
const ICON_MIN_PX = 24;
const ICON_RING = '#e5484d';
const ICON_SIZE_UP = 1.5;
const DUCK_SAT = 0.7;
const DUCK_LIGHT = 0.95;
const NAME_H = 0.38;
const NAME_LIFT = 0.55;
const tmpIconAt = new THREE.Vector3();
const ACCENTS = [
  '#f2c230',
  '#3f7fb8',
  '#3f7fb8',
  '#f07a1e',
  '#f2c230',
  '#f07a1e',
  '#f2c230',
  '#f07a1e',
  '#3f7fb8',
  '#f0562e',
  '#f0562e',
  '#f2c230',
];
const DIR_YAW: Record<Dir, number> = { N: Math.PI, E: HALF_PI, S: 0, W: -HALF_PI };

interface Snap {
  id: number;
  nick: string;
  color: number;
  pos: Pos;
  pose: AgentPose;
  facing: Dir;
  target: Pos | null;
  defending: Pos | null;
  useDone: number;
  useTotal: number;
  stunUntil: number;
  attackLand: number | null;
  recovery: boolean;
  urgent: boolean;
}

interface Shared {
  alert: THREE.Texture;
  sweat: THREE.Texture;
}

function fromAgent(a: ProjectionAgent): Snap {
  return {
    id: a.id,
    nick: a.nick,
    color: a.color,
    pos: a.pos,
    pose: a.pose,
    facing: a.facing,
    target: a.action_target,
    defending: a.defending,
    useDone: a.use_done,
    useTotal: a.use_total,
    stunUntil: a.stun_until,
    attackLand: a.attack_land_tick,
    recovery: a.recovery_deadline !== null,
    urgent: a.urgent,
  };
}

function fromQueue(q: ProjectionQueueEntry): Snap {
  return {
    id: q.id,
    nick: q.nick,
    color: q.color,
    pos: q.pos,
    pose: 'idle',
    facing: 'E',
    target: null,
    defending: null,
    useDone: 0,
    useTotal: 0,
    stunUntil: 0,
    attackLand: null,
    recovery: false,
    urgent: false,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const yawToward = (from: Pos, to: Pos): number => Math.atan2(to.x - from.x, to.y - from.y);
const progressOf = (s: Snap): number => (s.useTotal > 0 ? s.useDone / s.useTotal : 0);
const iconScale = (camera: THREE.Camera, x: number, z: number): number =>
  Math.min(ICON_MAX, Math.max(1, camera.position.distanceTo(tmpIconAt.set(x, 0, z)) / ICON_NEAR));
const minWorldSize = (camera: THREE.PerspectiveCamera, x: number, z: number): number => {
  const d = camera.position.distanceTo(tmpIconAt.set(x, 0, z));
  const viewH = window.innerHeight || 900;
  return (ICON_MIN_PX * 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewH;
};

/** The 3D shell of a duck: the UI palette colour with saturation x0.7 and lightness -5 % (the palette itself is untouched). */
function calmShell(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = c.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  return c.setHSL(hsl.h, hsl.s * DUCK_SAT, hsl.l * DUCK_LIGHT, THREE.SRGBColorSpace);
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function drawAlert(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(32, 32, 28, 0, TAU);
  g.strokeStyle = ICON_OUTLINE;
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#e5484d';
  g.fill();
  g.fillStyle = ICON_OUTLINE;
  g.fillRect(24, 9, 16, 32);
  g.fillRect(24, 41, 16, 15);
  g.fillStyle = '#fff';
  g.fillRect(27, 12, 10, 26);
  g.fillRect(27, 44, 10, 9);
}

/** The 2 px red ring the exclamation mark has, on a dark disc, for the small drops and sparks. */
function drawIconRing(g: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  g.beginPath();
  g.arc(c, c, c - 3, 0, TAU);
  g.fillStyle = 'rgba(22,18,14,0.78)';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = ICON_RING;
  g.stroke();
}

function drawSweat(g: CanvasRenderingContext2D): void {
  drawIconRing(g, 48);
  g.translate(8, 4);
  g.beginPath();
  g.moveTo(16, 2);
  g.quadraticCurveTo(29, 18, 27, 23);
  g.arc(16, 23, 11, 0, Math.PI);
  g.quadraticCurveTo(3, 18, 16, 2);
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = ICON_OUTLINE;
  g.stroke();
  g.fillStyle = '#9fdcff';
  g.fill();
}

function setArc(m: THREE.Mesh, inner: number, outer: number, seg: number, len: number): void {
  if (m.userData.len === len) return;
  m.userData.len = len;
  m.geometry.dispose();
  m.geometry = new THREE.RingGeometry(inner, outer, seg, 1, HALF_PI, len);
}

function basic(color: number, extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, ...extra });
}

function arcMesh(color: number, inner: number, outer: number, seg: number, extra: THREE.MeshBasicMaterialParameters = {}): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, seg, 1, HALF_PI, TAU), basic(color, extra));
  m.userData.len = TAU;
  return m;
}

function flatRing(color: number, inner: number, outer: number, seg: number, extra: THREE.MeshBasicMaterialParameters = {}): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, seg), basic(color, extra));
  m.rotation.x = -HALF_PI;
  return m;
}

class Actor {
  readonly duck: Duck;
  readonly fx = new THREE.Group();
  readonly color: number;
  readonly nick: string;
  private readonly made = new Map<string, THREE.Object3D>();
  private readonly textures: THREE.Texture[] = [];
  private readonly shared: Shared;

  constructor(color: number, nick: string, shared: Shared) {
    this.color = color;
    this.nick = nick;
    this.shared = shared;
    this.duck = buildDuck(calmShell(AGENT_COLORS[color]), ACCENTS[color]);
  }

  get<T extends THREE.Object3D>(key: string, make: () => T): T {
    let o = this.made.get(key) as T | undefined;
    if (!o) {
      o = make();
      this.made.set(key, o);
      this.fx.add(o);
    }
    return o;
  }

  alertSprite(): THREE.Sprite {
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: this.shared.alert, depthTest: false }));
  }

  sweatSprite(): THREE.Sprite {
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: this.shared.sweat }));
  }

  nameSprite(): THREE.Sprite {
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) throw new Error('2d canvas context unavailable');
    probe.font = 'bold 26px sans-serif';
    const w = Math.ceil(probe.measureText(this.nick).width) + 24;
    const tex = canvasTexture(w, 64, (g) => {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, 0, w, 64);
      g.fillStyle = '#fff';
      g.font = 'bold 26px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(this.nick, w / 2, 33);
    });
    this.textures.push(tex);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.userData.aspect = w / 64;
    return sp;
  }

  hideAll(): void {
    for (const o of this.fx.children) o.visible = false;
  }

  dispose(): void {
    this.fx.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) (o.material as THREE.Material).dispose();
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const t of this.textures) t.dispose();
  }
}

function drawActor(a: Actor, s: Snap, link: Snap | null, input: FrameInput, ctx: SceneCtx): void {
  const { phase, clock, ui } = input;
  const moved = link !== null && manhattan(link.pos, s.pos) === 1;
  const from: Pos = link && moved ? link.pos : s.pos;
  const t = moved ? phase : 1;
  const cx = lerp(from.x, s.pos.x, t) + 0.5;
  const cz = lerp(from.y, s.pos.y, t) + 0.5;

  let yaw: number;
  if (link && moved) yaw = yawToward(link.pos, s.pos);
  else if (s.target && (s.target.x !== s.pos.x || s.target.y !== s.pos.y)) yaw = yawToward(s.pos, s.target);
  else if (s.pose === 'defending' && s.defending) yaw = yawToward(s.pos, s.defending);
  else yaw = DIR_YAW[s.facing];
  if (s.pose === 'using') yaw = DIR_YAW.S;

  const f = link ? lerp(progressOf(link), progressOf(s), phase * phase * (3 - 2 * phase)) : progressOf(s);
  const stunned = input.cur.tick < s.stunUntil;
  const interrupted = s.recovery && s.pose !== 'using';

  const g = moved ? TAU * 2 * phase : 0;
  const swing = moved ? 0.45 * Math.sin(g) : 0;
  const bob = moved ? 0.04 * Math.abs(Math.sin(g)) : 0;
  let headX = moved ? 0.1 * Math.sin(g) : 0;
  const idleLook = !moved && (s.pose === 'idle' || s.pose === 'success');
  let headY = idleLook ? 0.35 * Math.sin(clock * 0.9 + s.id) : 0;
  let lean = 0;
  let bodyZ = 0;
  let lunge = 0;
  let rootY = 0;
  let shakeX = 0;
  let fan: { target: Pos; len: number; w: number } | null = null;

  if (s.pose === 'using') rootY = SEAT_Y;
  if (s.pose === 'working') headX = 0.25 * Math.sin(clock * 8);
  if (s.pose === 'demolishing') {
    headX = 0.25 * Math.sin(clock * 8);
    bodyZ = 0.05 * Math.abs(Math.sin(clock * 10));
  }
  if (s.pose === 'attacking' && s.attackLand !== null) {
    const r = s.attackLand - input.cur.tick - phase;
    const w = clamp01(1 - r / 6);
    if (r < 0.3) lunge = 0.15;
    else lean = -0.35 * w;
    if (s.target) fan = { target: s.target, len: TAU * clamp01(r / 6), w };
  }
  if (stunned) lean = 0.25;
  if (interrupted) shakeX = 0.02 * Math.sin(clock * 30);

  const icon = iconScale(ctx.camera, cx, cz);
  const minWorld = minWorldSize(ctx.camera, cx, cz);
  const lift = (icon - 1) * ICON_LIFT;

  const d = a.duck;
  a.hideAll();
  d.root.position.set(cx + Math.sin(yaw) * lunge, rootY, cz + Math.cos(yaw) * lunge);
  d.root.rotation.set(0, yaw, 0);
  d.body.position.set(shakeX, HIP_Y + bob, bodyZ);
  d.body.rotation.set(lean, 0, 0);
  d.head.rotation.set(headX, headY, 0);
  d.legL.rotation.set(swing, 0, 0);
  d.legR.rotation.set(-swing, 0, 0);
  (d.lens.material as THREE.MeshStandardMaterial).emissiveIntensity = stunned ? 0 : 0.25;
  ctx.pickables.set(d.hit, s.id);

  if (s.pose === 'using' || interrupted) {
    const key = s.pose === 'using' ? 'gold' : 'gray';
    const [inner, outer] = s.pose === 'using' ? [0.24, 0.33] : [0.16, 0.22];
    const ring = a.get(key, () => arcMesh(s.pose === 'using' ? GOLD : GRAY, inner, outer, 32));
    const gold = key === 'gold';
    setArc(ring, inner, outer, 32, -TAU * f);
    ring.position.set(cx, EYE_Y + (gold ? lift : 0), cz);
    ring.scale.setScalar(gold ? Math.max(icon, minWorld / 0.66) : Math.max(1, minWorld / 0.44));
    ring.quaternion.copy(ctx.camera.quaternion);
    ring.visible = f > 0;
  }

  if (interrupted) {
    const alert = a.get('alert', () => a.alertSprite());
    alert.position.set(cx, 2.0 + lift, cz);
    alert.scale.setScalar(Math.max(0.6 * icon, minWorld));
    alert.visible = Math.sin(clock * 10) > -0.3;
  }

  if (s.urgent) {
    for (let i = 0; i < 2; i++) {
      const sweat = a.get('sweat' + i, () => a.sweatSprite());
      sweat.position.set(cx + (i === 0 ? -0.3 : 0.3), 1.55 + 0.05 * Math.sin(clock * 5 + i) + lift, cz);
      sweat.scale.setScalar(Math.max(0.35 * ICON_SIZE_UP * icon, minWorld));
      sweat.visible = true;
    }
    const pulse = a.get('pulse', () => flatRing(RED, 0.46, 0.6, 32, { transparent: true, depthWrite: false }));
    (pulse.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.3 * Math.sin(clock * 6);
    pulse.position.set(cx, 0.05, cz);
    pulse.visible = true;
  }

  if (ui.selected === s.id) {
    const sel = a.get('select', () => flatRing(0xffffff, 0.3, 0.4, 28, { transparent: true, opacity: 0.9, depthTest: false }));
    sel.position.set(cx, 0.06, cz);
    sel.scale.setScalar(1 + 0.08 * Math.sin(clock * 6));
    sel.visible = true;
    const name = a.get('name', () => a.nameSprite());
    const aspect = name.userData.aspect as number;
    name.position.set(cx, EYE_Y + NAME_LIFT * icon + lift, cz);
    name.scale.set(NAME_H * aspect * icon, NAME_H * icon, 1);
    name.visible = true;
  }

  if (fan) {
    const m = a.get('fan', () => {
      const mesh = arcMesh(RED, 0.36, 0.56, 32, { transparent: true, opacity: 0.95, depthWrite: false });
      mesh.rotation.x = -HALF_PI;
      return mesh;
    });
    setArc(m, 0.36, 0.56, 32, fan.len);
    m.position.set(fan.target.x + 0.5, 0.06, fan.target.y + 0.5);
    m.visible = fan.len > 0;

    const arrow = a.get('arrow', () => new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.42, 12),
      new THREE.MeshStandardMaterial({ color: RED, emissive: RED, emissiveIntensity: 0.8 }),
    ));
    const ax = fan.target.x + 0.5 - cx;
    const az = fan.target.y + 0.5 - cz;
    const dist = Math.hypot(ax, az) || 1;
    const push = 0.25 + 0.5 * fan.w;
    arrow.position.set(cx + (ax / dist) * push, 1.1, cz + (az / dist) * push);
    arrow.quaternion.setFromUnitVectors(UP, new THREE.Vector3(ax / dist, 0, az / dist));
    arrow.scale.setScalar(Math.max(0.8 + 0.6 * fan.w, minWorld / 0.42));
    arrow.visible = fan.len > 0;
  }

  if (s.pose === 'defending' && s.defending) {
    const dx = s.defending.x + 0.5 - cx;
    const dz = s.defending.y + 0.5 - cz;
    const shield = a.get('shield', () => {
      const grp = new THREE.Group();
      grp.add(
        new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshStandardMaterial({
            color: BLUE,
            transparent: true,
            opacity: 0.35,
            emissive: BLUE,
            emissiveIntensity: 0.5,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        ),
      );
      const rim = new THREE.MeshBasicMaterial({ color: BLUE });
      const edges: Array<[number, number, number, number]> = [
        [0, 0.5, 1.04, 0.04],
        [0, -0.5, 1.04, 0.04],
        [-0.5, 0, 0.04, 1],
        [0.5, 0, 0.04, 1],
      ];
      for (const [x, y, w, h] of edges) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), rim);
        box.position.set(x, y, 0);
        grp.add(box);
      }
      return grp;
    });
    shield.position.set(cx + dx / 2, 1, cz + dz / 2);
    shield.rotation.set(0, Math.atan2(dx, dz), 0);
    shield.scale.setScalar(Math.max(1, minWorld));
    shield.visible = true;
    const outline = a.get('outline', () => {
      const grp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: BLUE });
      const edges: Array<[number, number, number, number]> = [
        [0, -0.47, 1, 0.06],
        [0, 0.47, 1, 0.06],
        [-0.47, 0, 0.06, 1],
        [0.47, 0, 0.06, 1],
      ];
      for (const [x, z, w, dz] of edges) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, dz), mat);
        box.position.set(x, 0, z);
        grp.add(box);
      }
      return grp;
    });
    outline.position.set(s.defending.x + 0.5, 0.05, s.defending.y + 0.5);
    outline.visible = true;
  }

  if (stunned) {
    for (let i = 0; i < 3; i++) {
      const star = a.get('star' + i, () => {
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.11),
          new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.8 }),
        );
        return mesh;
      });
      const ang = clock * 3 + (i * TAU) / 3;
      star.scale.setScalar(icon * ICON_SIZE_UP);
      star.position.set(cx + 0.32 * icon * Math.cos(ang), STAR_Y + lift, cz + 0.32 * icon * Math.sin(ang));
      star.visible = true;
    }
  }
}

export function createAgentsLayer(ctx: SceneCtx): Layer {
  const actors = new Map<string, Actor>();
  const shared: Shared = {
    alert: canvasTexture(64, 64, drawAlert),
    sweat: canvasTexture(48, 48, drawSweat),
  };

  const release = (key: string, c: SceneCtx): void => {
    const a = actors.get(key);
    if (!a) return;
    c.world.remove(a.duck.root, a.fx);
    c.pickables.delete(a.duck.hit);
    disposeDuck(a.duck.root);
    a.dispose();
    actors.delete(key);
  };

  return {
    update(input, c) {
      const adjacent = input.prev !== null && input.prev.tick + 1 === input.cur.tick;
      const prevById = new Map<number, Snap>();
      if (input.prev) {
        for (const a of input.prev.agents) prevById.set(a.id, fromAgent(a));
        for (const q of input.prev.queue) prevById.set(q.id, fromQueue(q));
      }
      const seen = new Set<string>();
      const snaps = [...input.cur.agents.map(fromAgent), ...input.cur.queue.map(fromQueue)];
      for (const s of snaps) {
        const key = 'agent:' + s.id;
        seen.add(key);
        let a = actors.get(key);
        if (a && (a.color !== s.color || a.nick !== s.nick)) {
          release(key, c);
          a = undefined;
        }
        if (!a) {
          a = new Actor(s.color, s.nick, shared);
          actors.set(key, a);
          c.world.add(a.duck.root, a.fx);
        }
        const link = adjacent ? prevById.get(s.id) ?? null : null;
        drawActor(a, s, link, input, c);
      }
      for (const key of [...actors.keys()]) if (!seen.has(key)) release(key, c);
    },
    dispose() {
      for (const key of [...actors.keys()]) release(key, ctx);
      shared.alert.dispose();
      shared.sweat.dispose();
    },
  };
}
