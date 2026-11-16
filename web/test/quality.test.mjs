import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_LADDER, LadderQuality, saveAutoRecord, startIndexFor } from '../src/world3d/quality.ts';

function run(auto, frameMs, untilMs) {
  let t = 0;
  while (t <= untilMs) {
    auto.frame(t);
    t += frameMs;
  }
}

function recorder() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

test('when every level is slow the walk goes down to the last level and settles there', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  run(auto, 40, 60000);
  assert.equal(auto.level, AUTO_LADDER.length - 1);
  assert.equal(events.filter((e) => e.event === 'step').length, AUTO_LADDER.length - 1);
  assert.equal(events.at(-1).event, 'settle');
  assert.equal(events.at(-1).to, AUTO_LADDER.length - 1);
});

test('a fast level settles where it is and the walk never climbs back', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  run(auto, 40, 6500);
  assert.equal(auto.level, 1);
  run(auto, 16, 60000);
  assert.equal(auto.level, 1);
  const settle = events.filter((e) => e.event === 'settle');
  assert.equal(settle.length, 1);
  assert.equal(settle[0].to, 1);
  assert.equal(events.filter((e) => e.event === 'step').length, 1);
});

test('the stored index is the start: fast settles there, slow keeps walking down from it', () => {
  const fast = new LadderQuality(true, 3);
  run(fast, 16, 60000);
  assert.equal(fast.level, 3);

  const slow = new LadderQuality(true, 3);
  run(slow, 40, 60000);
  assert.equal(slow.level, AUTO_LADDER.length - 1);
});

test('a stored record starts one level better on the same renderer and is ignored otherwise', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(startIndexFor('gpu-a', storage), 0);
  saveAutoRecord('gpu-a', 4, storage);
  assert.equal(startIndexFor('gpu-a', storage), 3);
  saveAutoRecord('gpu-a', 0, storage);
  assert.equal(startIndexFor('gpu-a', storage), 0);
  assert.equal(startIndexFor('gpu-b', storage), 0);
  store.set('loo.autoQuality', '{not json');
  assert.equal(startIndexFor('gpu-a', storage), 0);
});

function feedPattern(auto, pattern, untilMs) {
  let t = 0;
  let i = 0;
  auto.frame(t);
  while (t < untilMs) {
    t += pattern[i % pattern.length];
    i += 1;
    auto.frame(t);
  }
}

test('a level that mixes 33.3 and 50 ms frames (about 25 fps) steps down', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  feedPattern(auto, [33.3, 33.3, 50], 6100);
  assert.equal(auto.level, 1);
  const step = events.find((e) => e.event === 'step');
  assert.ok(step.meanMs > 32.5);
});

test('a level locked to 30 fps by vsync with some 60 fps frames (mean about 31 ms) settles', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  feedPattern(auto, [33.3, 33.3, 33.3, 33.3, 33.3, 33.3, 33.3, 16.7], 6100);
  assert.equal(auto.level, 0);
  assert.equal(events.at(-1).event, 'settle');
  assert.ok(events.at(-1).meanMs <= 32.5);
});

test('a level that only holds a steady 33.4 ms steps down for margin', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  feedPattern(auto, [33.4], 6100);
  assert.equal(auto.level, 1);
  assert.equal(events.find((e) => e.event === 'step').from, 0);
});

test('a few long stalls in an otherwise 30 fps window do not step the level down', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  feedPattern(auto, [31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 250], 6100);
  assert.equal(auto.level, 0);
  assert.equal(events.at(-1).event, 'settle');
});
