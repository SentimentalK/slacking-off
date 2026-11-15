import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lampIrradiance } from '../src/world3d/lamplight.ts';

const W = 24;
const H = 10;
const RES = 4;
const TW = W * RES;

const POST = { x: 5, y: 1.45, z: 5, color: [1, 0.66, 0.33], intensity: 3, distance: 7 };
const SHACK = { x: 15, y: 1.0, z: 8, color: [1, 0.69, 0.38], intensity: 2.2, distance: 5 };

function at(irradiance, worldX, worldZ) {
  const i = (Math.floor(worldZ * RES) * TW + Math.floor(worldX * RES)) * 3;
  return irradiance[i] + irradiance[i + 1] + irradiance[i + 2];
}

test('a lamp is brightest directly under it and falls to zero at its radius', () => {
  const lum = lampIrradiance([POST], W, H, RES);
  const under = at(lum, 5, 5);
  const threeAway = at(lum, 8, 5);
  const sevenAway = at(lum, 12, 5);
  assert.ok(under > threeAway, `under ${under} should exceed 3 cells away ${threeAway}`);
  assert.ok(threeAway > sevenAway, `3 cells away ${threeAway} should exceed 7 cells away ${sevenAway}`);
  assert.equal(sevenAway, 0);
});

test('two lamps give the sum of each lamp lit alone', () => {
  const a = lampIrradiance([POST], W, H, RES);
  const b = lampIrradiance([SHACK], W, H, RES);
  const both = lampIrradiance([POST, SHACK], W, H, RES);
  assert.equal(both.length, a.length);
  for (let i = 0; i < both.length; i++) {
    const want = a[i] + b[i];
    assert.ok(Math.abs(both[i] - want) <= 1e-5 * Math.max(1, Math.abs(want)), `texel ${i}: ${both[i]} vs ${want}`);
  }
});
