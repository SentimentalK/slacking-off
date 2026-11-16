import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionIn, enAction, enEvent, enReason, eventIn, reasonIn } from '../src/eventText.ts';

const TICK_WORD = /\btick\b/;

const SAMPLES = [
  [
    'dev-12 needs the toilet (urine) before tick 40',
    'dev-12 needs to pee before turn 40',
  ],
  [
    'dev-12 needs the toilet (feces) before tick 40',
    'dev-12 needs to poop before turn 40',
  ],
  [
    "dev-12's use at (4,4) was interrupted: the toilet is not usable; recovery by tick 30",
    "dev-12's use at (4,4) was interrupted: the toilet is not usable; recovery by turn 30",
  ],
  [
    "dev-12's use was interrupted: the toilet is not usable; recovery by tick 30",
    "dev-12's use was interrupted: the toilet is not usable; recovery by turn 30",
  ],
  ['dev-12 has 1 ticks left before the deadline', 'dev-12 has 1 turn left before the deadline'],
  ['dev-12 has 3 ticks left before the deadline', 'dev-12 has 3 turns left before the deadline'],
  [
    'dev-12 attacks dev-7 at (4,4); the hit lands at tick 9',
    'dev-12 attacks dev-7 at (4,4); the hit lands at turn 9',
  ],
  [
    'dev-12 defends (5,4) until tick 20; defend cooldown until tick 25',
    'dev-12 defends (5,4) until turn 20; defend cooldown until turn 25',
  ],
  ['dev-12 is stunned until tick 14: hit by an attack', 'dev-12 is stunned until turn 14: hit by an attack'],
  ['tick 12 settled', 'turn 12 settled'],
  ['dev-12 left the world: failed_deadline', "dev-12 left the world: didn't make it in time"],
  ['dev-12 left the world: failed_recovery', "dev-12 left the world: couldn't recover in time"],
  ['dev-12 left the world: left', 'dev-12 left the world: left early'],
  ['dev-12 left the world: abandoned', 'dev-12 left the world: dropped out'],
  ['dev-12 failed: failed_deadline', "dev-12 failed: didn't make it in time"],
  ['dev-12 moved (3,4) -> (4,4)', 'dev-12 moved (3,4) → (4,4)'],
  ['tick-tock moved (1,2) -> (1,3)', 'tick-tock moved (1,2) → (1,3)'],
  ['something nobody wrote down', 'something nobody wrote down'],
];

test('enEvent gives the exact English line for every sample', () => {
  for (const [input, expected] of SAMPLES) {
    assert.equal(enEvent(input), expected, input);
  }
});

test('enEvent leaves no tick word outside a nickname', () => {
  for (const [input] of SAMPLES) {
    if (input.startsWith('tick-tock')) continue;
    assert.doesNotMatch(enEvent(input), TICK_WORD, input);
  }
});

test('enAction and enReason only turn ticks into turns', () => {
  assert.equal(enAction('move E 2'), 'move E 2');
  assert.equal(enAction('defend'), 'defend');
  assert.equal(enReason('you are stunned until tick 5; you cannot attack'), 'you are stunned until turn 5; you cannot attack');
  assert.equal(enReason('your attack is on cooldown until tick 8'), 'your attack is on cooldown until turn 8');
  assert.equal(enReason('stunned by an attack'), 'stunned by an attack');
});

test('the dispatchers pick the Chinese or English function by language', () => {
  assert.equal(eventIn('zh', 'tick 12 settled'), '回合 12 结算完毕');
  assert.equal(eventIn('en', 'tick 12 settled'), 'turn 12 settled');
  assert.equal(actionIn('zh', 'defend'), '防御');
  assert.equal(actionIn('en', 'defend'), 'defend');
  assert.equal(reasonIn('zh', 'stunned by an attack'), '被攻击打得眩晕');
  assert.equal(reasonIn('en', 'stunned by an attack'), 'stunned by an attack');
});
