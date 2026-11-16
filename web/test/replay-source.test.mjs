import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexSpans,
  nextPlayable,
  offsetOfTick,
  pickReplaySpan,
  prevPlayable,
  snapTick,
  tickAtOffset,
} from '../src/replay-source.ts';

const spans = [
  { from: 3, to: 5 },
  { from: 9, to: 10 },
];
const index = indexSpans(spans);

test('offset and tick round-trip across the gap', () => {
  for (const tick of [3, 4, 5, 9, 10]) {
    assert.equal(tickAtOffset(index, offsetOfTick(index, tick)), tick);
  }
  assert.equal(offsetOfTick(index, 7), null);
  assert.equal(tickAtOffset(index, 3), 9);
  assert.equal(tickAtOffset(index, 99), 10);
});

test('playback hops the gap and stops at the last tick', () => {
  assert.equal(nextPlayable(index, 5), 9);
  assert.equal(nextPlayable(index, 10), null);
  assert.equal(prevPlayable(index, 9), 5);
});

test('a tick in a gap snaps to the end of the span before it', () => {
  assert.equal(snapTick(index, 7), 5);
});

test('the replay span skips a span that has not settled yet', () => {
  assert.deepEqual(pickReplaySpan(spans, 7), { from: 3, to: 5 });
  assert.deepEqual(pickReplaySpan(spans, 10), { from: 9, to: 10 });
  assert.equal(pickReplaySpan(spans, 2), null);
});
