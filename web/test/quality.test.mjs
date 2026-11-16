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

test('the stored record only applies to the same renderer and a valid index', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(startIndexFor('gpu-a', storage), 0);
  saveAutoRecord('gpu-a', 4, storage);
  assert.equal(startIndexFor('gpu-a', storage), 4);
  assert.equal(startIndexFor('gpu-b', storage), 0);
  store.set('loo.autoQuality', '{not json');
  assert.equal(startIndexFor('gpu-a', storage), 0);
});
