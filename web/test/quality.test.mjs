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

test('a stored record is the start; after a week it starts one level better; other renderers ignore it', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const day = 24 * 3600 * 1000;
  assert.equal(startIndexFor('gpu-a', storage, 0), 0);
  saveAutoRecord('gpu-a', 4, storage, 1000);
  assert.equal(startIndexFor('gpu-a', storage, 1000 + day), 4);
  assert.equal(startIndexFor('gpu-a', storage, 1000 + 8 * day), 3);
  assert.equal(startIndexFor('gpu-b', storage, 1000 + day), 0);
  store.set('loo.autoQuality', JSON.stringify({ renderer: 'gpu-a', index: 2 }));
  assert.equal(startIndexFor('gpu-a', storage, 1000), 1);
  store.set('loo.autoQuality', '{not json');
  assert.equal(startIndexFor('gpu-a', storage, 1000), 0);
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

test('the slowest tenth is dropped and no more: 2 long frames in 20 settle, 3 step down', () => {
  const keep = new LadderQuality(true, 0);
  feedPattern(keep, [31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 250, 250], 6100);
  assert.equal(keep.level, 0);
  const drop = new LadderQuality(true, 0);
  feedPattern(drop, [31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 250, 250, 250], 6100);
  assert.equal(drop.level, 1);
});

test('a window with too few frames (a throttled background tab) is measured again, not settled', () => {
  const { events, onEvent } = recorder();
  const auto = new LadderQuality(true, 0, onEvent);
  auto.frame(0);
  auto.frame(7000);
  assert.ok(!events.some((e) => e.event === 'settle'));
  for (let t = 7016; t <= 7000 + 6500; t += 16) auto.frame(t);
  assert.equal(events.at(-1).event, 'settle');
  assert.equal(events.at(-1).ok, true);
});
