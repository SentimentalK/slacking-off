import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lampField, FIELD_LAYERS, FIELD_STEP, FIELD_COLOR } from '../src/world3d/lamplight.ts';

const W = 24;
const H = 10;
const RES = 4;
const TW = W * RES;
const TH = H * RES;

const POST = { x: 5.5, y: 1.35, z: 5.5, color: FIELD_COLOR, intensity: 3, distance: 7, decay: 0 };
const SHACK = { x: 15, y: 1.0, z: 8, color: [1, 0.44, 0.12], intensity: 2.2 * Math.PI, distance: 5, decay: 2 };

function texel(field, layer, worldX, worldZ) {
  const o = (((layer * TH + Math.floor(worldZ * RES)) * TW) + Math.floor(worldX * RES)) * 4;
  return { x: field[o], y: field[o + 1], z: field[o + 2], s: field[o + 3] };
}

test('on the ground a lamp follows the point-light formula and falls to zero at its radius', () => {
  const f = lampField([POST], W, H, RES);
  const under = texel(f, 0, 5.5, 5.5);
  const dy = POST.y;
  const d = Math.sqrt(2 * 0.125 ** 2 + dy * dy);
  const window = (1 - (d / POST.distance) ** 4) ** 2;
  const want = POST.intensity * window;
  assert.ok(Math.abs(under.s - want) <= 1e-6 * want, `scalar ${under.s} vs ${want}`);
  assert.ok(Math.abs(under.y - want * (dy / d)) <= 1e-6 * want, `up component ${under.y}`);
  assert.ok(under.y > texel(f, 0, 8.5, 5.5).y);
  assert.ok(texel(f, 0, 8.5, 5.5).y > texel(f, 0, 11.5, 5.5).y);
  assert.equal(texel(f, 0, 12.6, 5.5).s, 0);
});

test('light reaches surfaces by their normal: a side faces the lamp, a roof above the lamp stays dark', () => {
  const f = lampField([POST], W, H, RES);
  const roofLayer = Math.round(2.25 / FIELD_STEP);
  assert.ok(roofLayer < FIELD_LAYERS);
  const east = texel(f, roofLayer, 7.5, 5.5);
  assert.ok(east.x < 0, 'light comes from the west of a point east of the lamp');
  assert.ok(Math.max(0, -east.x) > 0, 'a canopy side that faces the lamp (normal -x) is lit');
  assert.ok(Math.max(0, east.x) === 0, 'the side facing away gets none');
  assert.ok(east.y < 0, 'a surface above the lamp is lit from below only: an up normal gets nothing');
});

test('two lamps give the sum of each lamp lit alone', () => {
  const a = lampField([POST], W, H, RES);
  const b = lampField([SHACK], W, H, RES);
  const both = lampField([POST, SHACK], W, H, RES);
  assert.equal(both.length, a.length);
  for (let i = 0; i < both.length; i++) {
    const want = a[i] + b[i];
    assert.ok(Math.abs(both[i] - want) <= 1e-4 * Math.max(1, Math.abs(want)), `texel ${i}: ${both[i]} vs ${want}`);
  }
});
