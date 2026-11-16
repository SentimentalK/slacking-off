import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zhAction, zhEvent } from '../src/eventText.ts';

const NICK = /dev-\d+/g;
const ENGLISH = /[A-Za-z]{3,}/;

// Each sample is a line the Rust `format!` in `Event::text()` produces, filled in by hand.
const SAMPLES = [
  ['dev-12 entered the world at (13,10)', 'dev-12 入场 (13,10)'],
  ['dev-12 entered the world', 'dev-12 入场'],
  ['dev-12 joined the queue at (0,5) with 2 ahead', 'dev-12 在门外排队 (0,5)，前面 2 人'],
  ['dev-12 joined and waits outside the entrance', 'dev-12 在门外排队'],
  ['dev-12 moved up the queue from (0,5) to (0,4)', 'dev-12 在队列中前移 (0,5) -> (0,4)'],
  ['dev-12 checked in from the queue', 'dev-12 在队列中签到'],
  ['dev-12 moved (3,4) -> (4,4); dev-7 was pushed (4,4) -> (4,5)', 'dev-12 从 (3,4) 走到 (4,4)，dev-7 从 (4,4) 被推到 (4,5)'],
  ['dev-12 moved (3,4) -> (4,4)', 'dev-12 从 (3,4) 走到 (4,4)'],
  ["dev-12's action move N 3 was replaced by use the toilet", 'dev-12 原动作「向北走 3 步」被「上厕所」替换'],
  ['dev-12 started move E 2', 'dev-12 开始向东走 2 步'],
  ["dev-12's move finished at (4,4)", 'dev-12 走到 (4,4)'],
  ["dev-12's move stopped at (4,4): towards the north is blocked by a wall", 'dev-12 在 (4,4) 停下：朝北被墙挡住'],
  ["dev-12's move stopped at (4,4): ahead is blocked by agent dev-7", 'dev-12 在 (4,4) 停下：前方被玩家 dev-7挡住'],
  ['dev-12 finished build wall at (5,5) at (4,4)', 'dev-12 在 (4,4) 完成了建造墙 (5,5)'],
  ["dev-12's demolish at (5,5) was cancelled at (4,4)", 'dev-12 的拆除 (5,5)在 (4,4) 已取消'],
  ["dev-12's build wall at (5,5) failed at (4,4): something is already there; demolish it first", 'dev-12 的建造墙 (5,5)在 (4,4) 失败：那里已有东西，请先拆除'],
  ['dev-12 worked on a wall at (5,5)', 'dev-12 在 (5,5) 施工（墙）'],
  ['dev-12 raised a pillar at (4,4)', 'dev-12 在 (4,4) 立起了柱子'],
  ['dev-12 finished a toilet at (4,4)', 'dev-12 在 (4,4) 建成了厕所'],
  ['dev-12 damaged a wall at (5,5) (damage 2)', 'dev-12 在 (5,5) 损坏了墙（损伤 2）'],
  ['dev-12 demolished the object at (5,5)', 'dev-12 拆除了 (5,5) 的物件'],
  ['dev-12 opened the door at (2,2)', 'dev-12 打开了 (2,2) 的门'],
  ['dev-12 closed the door at (2,2)', 'dev-12 关上了 (2,2) 的门'],
  ['the door at (2,2) closed with nobody on its toilet and opened automatically', '(2,2) 的门因厕所无人而自动打开'],
  ['dev-12 upgraded the toilet at (4,4) to level 2 (progress 0)', 'dev-12 把 (4,4) 的厕所升级到 2 级（进度 0）'],
  ['dev-12 upgraded the wall at (5,5)', 'dev-12 升级了 (5,5) 的墙'],
  ['dev-12 downgraded the object at (5,5)', 'dev-12 降级了 (5,5) 的物件'],
  ['dev-12 needs the toilet (urine) before tick 120', 'dev-12 需要如厕（小便），须在第 120 回合前'],
  ['dev-12 started using the toilet at (4,4)', 'dev-12 开始上厕所 (4,4)'],
  ['dev-12 is using the level 1 toilet at (4,4): 2/5', 'dev-12 在 (4,4) 上 1 级厕所：2/5'],
  ["dev-12's use at (4,4) was interrupted: hit by an attack; recovery by tick 150", 'dev-12 在 (4,4) 的如厕中断：被攻击击中；须在第 150 回合前恢复'],
  ["dev-12's use was interrupted: hit by an attack; recovery by tick 150", 'dev-12 的如厕中断：被攻击击中；须在第 150 回合前恢复'],
  ['dev-12 resumed using the toilet at (4,4)', 'dev-12 在 (4,4) 继续上厕所'],
  ['dev-12 finished at (4,4) and scored 30', 'dev-12 如厕成功 (4,4)，得 30 分'],
  ['dev-12 failed: failed_deadline', 'dev-12 如厕失败：憋爆了'],
  ['dev-12 left the world: success, score 30', 'dev-12 离开世界：成功，得 30 分'],
  ['dev-12 left the world: abandoned', 'dev-12 离开世界：掉线消失'],
  ['dev-12 has 30 ticks left before the deadline', 'dev-12 还剩 30 回合到期'],
  ['dev-12 attacks dev-7 at (4,4); the hit lands at tick 130', 'dev-12 攻击 dev-7 (4,4)，第 130 回合命中'],
  ['dev-12 hit dev-7 at (4,4): deadline -5 to 140, stunned until 135, immune until 150', 'dev-12 打中了 dev-7 (4,4)：期限减 5，改为第 140 回合；眩晕至第 135 回合，免疫至第 150 回合'],
  ["dev-12's attack on dev-7 at (4,4) missed: target moved out of reach", 'dev-12 攻击 dev-7 (4,4) 未命中：目标已移出范围'],
  ["dev-7 blocked dev-12's attack on dev-9 at (4,4); dev-12 is stunned until 140", 'dev-7 防住了 dev-12 对 dev-9 的攻击 (4,4)；dev-12 眩晕至第 140 回合'],
  ["dev-12's attack on dev-7 at (4,4) was cancelled: the windup was lost while you were stunned", 'dev-12 对 dev-7 (4,4) 的攻击已取消：眩晕期间蓄力中断'],
  ['dev-12 defends (4,4) until tick 130; defend cooldown until tick 140', 'dev-12 防御 (4,4)，至第 130 回合；防御冷却至第 140 回合'],
  ['dev-12 stopped defending', 'dev-12 停止防御'],
  ["dev-7 blocked dev-12's demolition at (4,4); dev-12 is stunned until 140", 'dev-7 防住了 dev-12 的拆除 (4,4)；dev-12 眩晕至第 140 回合'],
  ['dev-12 is stunned until tick 140: hit by an attack', 'dev-12 眩晕至第 140 回合：被攻击击中'],
  ["dev-12's move was rejected at (4,4): you are stunned until tick 140; no action was taken", 'dev-12 的移动指令在 (4,4) 被拒：眩晕至第 140 回合，本次未执行动作'],
  ['tick 341 settled', '回合 341 结算完毕'],
];

test('every rule renders its sample in Chinese, nicknames aside', () => {
  for (const [english, chinese] of SAMPLES) {
    const out = zhEvent(english);
    assert.equal(out, chinese, english);
    assert.doesNotMatch(out.replace(NICK, ''), ENGLISH, english);
  }
});

test('unrecognised text and unmapped sub-phrases come back as they were', () => {
  const unknown = 'the wind changed direction';
  assert.equal(zhEvent(unknown), unknown);
  const badReason = "dev-12's move failed at (4,4): some reason the server never had";
  assert.equal(zhEvent(badReason), badReason);
  const badLabel = "dev-12's juggle failed at (4,4): you are not in the world";
  assert.equal(zhEvent(badLabel), badLabel);
  assert.equal(zhAction('move N 3'), '向北走 3 步');
  assert.equal(zhAction('teleport home'), 'teleport home');
});
