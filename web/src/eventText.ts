// Server event and action text, turned into Chinese on the client. The server
// keeps its English (CLI and API read it); these rules follow the `format!`
// templates in crates/core/src/event.rs and the label strings next to them. A
// line no rule matches, or whose sub-phrase has no Chinese form, comes back
// unchanged.

const P = String.raw`(\(-?\d+,-?\d+\))`;
const N = '(.+?)';
const NUM = '(\\d+)';

function rx(src: string): RegExp {
  return new RegExp(`^${src}$`);
}

const WORD: Record<string, string> = {
  wall: '墙',
  door: '门',
  toilet: '厕所',
  pillar: '柱子',
  north: '北',
  east: '东',
  south: '南',
  west: '西',
  urine: '小便',
  feces: '大便',
  success: '成功',
  failed_deadline: '憋爆了',
  failed_recovery: '恢复失败',
  left: '中途离开',
  abandoned: '掉线消失',
};

const INTENT: Record<string, string> = {
  move: '移动',
  build: '建造',
  demolish: '拆除',
  door: '开关门',
  use: '上厕所',
  upgrade: '升级',
  downgrade: '降级',
  defend: '防御',
  attack: '攻击',
};

const CODE_DIR: Record<string, string> = { N: '北', E: '东', S: '南', W: '西' };

const BLOCKER: Record<string, string> = {
  'the map edge': '地图边缘',
  'a wall': '墙',
  'a closed door': '关着的门',
  'an unfinished build site': '未完工的工地',
  'a pillar': '柱子',
  'the queue edge': '队列边界',
};

const REASON: Record<string, string> = {
  'you are not in the world': '你不在世界中',
  'target is out of reach; you can only act on your cell or the four neighbours': '目标太远，只能作用于自身格或四邻格',
  'that cell is outside the map': '该格在地图外',
  'that cell is in a no-build area': '该格禁止建造',
  'there is no door there': '那里没有门',
  'only an agent on an adjacent toilet cell can open or close this door': '只有相邻厕所格上的玩家能开关这扇门',
  'a different unfinished site is there; demolish it first': '那里是另一处未完工的工地，请先拆除',
  'something is already there; demolish it first': '那里已有东西，请先拆除',
  'there is nothing to demolish there': '那里没有可拆除的东西',
  'there is no unstunned agent next to you in that direction': '该方向相邻处没有可攻击的玩家',
  'you cannot defend your own cell; defend an adjacent cell': '不能防御自己所在的格，请防御相邻格',
  'a pillar cannot be defended': '柱子不能防御',
  'someone is standing in the doorway': '门口有人站着',
  'a pillar is there; it belongs to the toilet next to it and cannot be built on': '那里是柱子，属于旁边的厕所，不能建造',
  'a pillar cannot be demolished; it goes when its toilet is gone': '柱子不能单独拆除，厕所拆除后才会消失',
  'this toilet is already level 1; use demolish to remove it': '厕所已是 1 级，请用拆除移除',
  'this toilet is already level 5 (the highest); it cannot be upgraded': '厕所已是 5 级（最高），无法升级',
  'you already succeeded in this session': '本次会话已成功',
  'the windup was lost while you were stunned': '眩晕期间蓄力中断',
  'attack was blocked by a defender': '攻击被防御者挡下',
  'stunned by an attack': '被攻击打得眩晕',
  'hit by an attack': '被攻击击中',
  'demolition was blocked by a defender': '拆除被防御者挡下',
  'target left the world': '目标已离开世界',
  'target moved out of reach': '目标已移出范围',
  'target is immune': '目标处于免疫期',
  cancelled: '已取消',
  'the toilet is not at a complete level': '厕所尚未建成完整等级',
  'you must stand on a toilet to use it': '需要站在厕所上才能使用',
};

function nickZh(nick: string): string {
  return nick === 'someone' ? '有人' : nick;
}

function word(key: string): string | null {
  return Object.hasOwn(WORD, key) ? WORD[key] : null;
}

function intent(key: string): string | null {
  return Object.hasOwn(INTENT, key) ? INTENT[key] : null;
}

function blocker(text: string): string | null {
  if (Object.hasOwn(BLOCKER, text)) return BLOCKER[text];
  const agent = /^agent (.+)$/.exec(text);
  return agent ? `玩家 ${nickZh(agent[1] ?? '')}` : null;
}

function zhLabel(text: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^move ([NESW]) (\d+)$/.exec(text))) return `向${CODE_DIR[m[1] ?? '']}走 ${m[2]} 步`;
  if ((m = /^move ([NESW]+)$/.exec(text))) {
    return `沿路线${[...(m[1] ?? '')].map((c) => CODE_DIR[c]).join('')}走`;
  }
  if (text === 'use the toilet') return '上厕所';
  if ((m = rx(`attack the agent at ${P}`).exec(text))) return `攻击 ${m[1]} 的玩家`;
  if ((m = rx(`build (wall|door|toilet) at ${P}`).exec(text))) return `建造${word(m[1] ?? '')} ${m[2]}`;
  if ((m = rx(`demolish at ${P}`).exec(text))) return `拆除 ${m[1]}`;
  if ((m = rx(`(open|close) the door at ${P}`).exec(text))) {
    return `${m[1] === 'open' ? '开' : '关'}门 ${m[2]}`;
  }
  if ((m = rx(`(upgrade|downgrade) the toilet at ${P}`).exec(text))) {
    return `${m[1] === 'upgrade' ? '升级' : '降级'}厕所 ${m[2]}`;
  }
  if (text === 'defend') return '防御';
  return null;
}

/** The server's action description, in Chinese; unknown text comes back as is. */
export function zhAction(description: string): string {
  return zhLabel(description) ?? description;
}

function zhReason(text: string): string | null {
  if (Object.hasOwn(REASON, text)) return REASON[text];
  let m: RegExpExecArray | null;
  if ((m = /^you are stunned until tick (\d+); you cannot attack$/.exec(text))) return `眩晕至第 ${m[1]} 回合，不能攻击`;
  if ((m = /^you are stunned until tick (\d+); you cannot defend$/.exec(text))) return `眩晕至第 ${m[1]} 回合，不能防御`;
  if ((m = /^you are stunned until tick (\d+); no action was taken$/.exec(text))) return `眩晕至第 ${m[1]} 回合，本次未执行动作`;
  if ((m = /^your attack is on cooldown until tick (\d+)$/.exec(text))) return `攻击冷却至第 ${m[1]} 回合`;
  if ((m = /^your defend is on cooldown until tick (\d+)$/.exec(text))) return `防御冷却至第 ${m[1]} 回合`;
  if ((m = /^replaced by (.+)$/.exec(text))) {
    const label = zhLabel(m[1] ?? '');
    return label === null ? null : `被「${label}」替换`;
  }
  if ((m = /^you cannot build a (wall|door|toilet) on a cell with an agent$/.exec(text))) {
    return `不能在有玩家的格子上建造${word(m[1] ?? '')}`;
  }
  if ((m = /^the door is already (open|closed)$/.exec(text))) return `门已经${m[1] === 'open' ? '开着' : '关着'}`;
  if ((m = /^this toilet already has (\d+) workers \(the maximum\); wait for one to finish$/.exec(text))) {
    return `厕所已有 ${m[1]} 人（已满），请等一人完成`;
  }
  if ((m = /^the toilet is under construction \(progress (\d+)\); it is not usable$/.exec(text))) {
    return `厕所施工中（进度 ${m[1]}），不能使用`;
  }
  if ((m = rx(`a pillar cannot be demolished; it goes when the toilet at ${P} is gone`).exec(text))) {
    return `柱子不能单独拆除，厕所 ${m[1]} 拆除后才会消失`;
  }
  if ((m = /^the toilet is not usable: (.+)$/.exec(text))) {
    const parts = (m[1] ?? '').split('; ').map(zhPart);
    return parts.some((part) => part === null) ? null : `厕所不可用：${parts.join('；')}`;
  }
  return null;
}

function zhPart(text: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^the (north|east|south|west) side is the map edge$/.exec(text))) return `${word(m[1] ?? '')}侧是地图边缘`;
  if ((m = /^the (north|east|south|west) door is open$/.exec(text))) return `${word(m[1] ?? '')}侧的门开着`;
  if ((m = /^the (north|east|south|west) side is not enclosed by a wall or a closed door$/.exec(text))) {
    return `${word(m[1] ?? '')}侧没有墙或关着的门围住`;
  }
  return null;
}

interface Rule {
  re: RegExp;
  build: (m: RegExpExecArray) => string | null;
}

const g = (m: RegExpExecArray, i: number): string => m[i] ?? '';

const RULES: Rule[] = [
  // Joined (inside, with a cell) and EnteredWorld print the same line.
  { re: rx(`${N} entered the world at ${P}`), build: (m) => `${nickZh(g(m, 1))} 入场 ${g(m, 2)}` },
  { re: rx(`${N} entered the world`), build: (m) => `${nickZh(g(m, 1))} 入场` },
  {
    re: rx(`${N} joined the queue at ${P} with ${NUM} ahead`),
    build: (m) => `${nickZh(g(m, 1))} 在门外排队 ${g(m, 2)}，前面 ${g(m, 3)} 人`,
  },
  { re: rx(`${N} joined and waits outside the entrance`), build: (m) => `${nickZh(g(m, 1))} 在门外排队` },
  {
    re: rx(`${N} moved up the queue from ${P} to ${P}`),
    build: (m) => `${nickZh(g(m, 1))} 在队列中前移 ${g(m, 2)} -> ${g(m, 3)}`,
  },
  { re: rx(`${N} checked in from the queue`), build: (m) => `${nickZh(g(m, 1))} 在队列中签到` },
  {
    re: rx(`${N} moved ${P} -> ${P}; ${N} was pushed ${P} -> ${P}`),
    build: (m) =>
      `${nickZh(g(m, 1))} 从 ${g(m, 2)} 走到 ${g(m, 3)}，${nickZh(g(m, 4))} 从 ${g(m, 5)} 被推到 ${g(m, 6)}`,
  },
  { re: rx(`${N} moved ${P} -> ${P}`), build: (m) => `${nickZh(g(m, 1))} 从 ${g(m, 2)} 走到 ${g(m, 3)}` },
  {
    re: rx(`${N}'s action (.+?) was replaced by (.+)`),
    build: (m) => {
      const from = zhLabel(g(m, 2));
      const to = zhLabel(g(m, 3));
      return from === null || to === null ? null : `${nickZh(g(m, 1))} 原动作「${from}」被「${to}」替换`;
    },
  },
  { re: rx(`${N} started using the toilet at ${P}`), build: (m) => `${nickZh(g(m, 1))} 开始上厕所 ${g(m, 2)}` },
  {
    re: rx(`${N} started (.+)`),
    build: (m) => {
      const label = zhLabel(g(m, 2));
      return label === null ? null : `${nickZh(g(m, 1))} 开始${label}`;
    },
  },
  { re: rx(`${N}'s move finished at ${P}`), build: (m) => `${nickZh(g(m, 1))} 走到 ${g(m, 2)}` },
  {
    re: rx(`${N}'s (.+?) stopped at ${P}: towards the (north|east|south|west) is blocked by (.+)`),
    build: (m) => {
      const by = blocker(g(m, 5));
      const dir = word(g(m, 4));
      if (by === null || dir === null) return null;
      const what = g(m, 2);
      const who = what === 'move' ? nickZh(g(m, 1)) : `${nickZh(g(m, 1))} 的${zhLabel(what) ?? ''}`;
      return `${who} 在 ${g(m, 3)} 停下：朝${dir}被${by}挡住`;
    },
  },
  {
    re: rx(`${N}'s (.+?) stopped at ${P}: ahead is blocked by (.+)`),
    build: (m) => {
      const by = blocker(g(m, 4));
      if (by === null) return null;
      const what = g(m, 2);
      const who = what === 'move' ? nickZh(g(m, 1)) : `${nickZh(g(m, 1))} 的${zhLabel(what) ?? ''}`;
      return `${who} 在 ${g(m, 3)} 停下：前方被${by}挡住`;
    },
  },
  {
    re: rx(`${N} finished a (wall|door|toilet) at ${P}`),
    build: (m) => `${nickZh(g(m, 1))} 在 ${g(m, 3)} 建成了${word(g(m, 2)) ?? ''}`,
  },
  {
    re: rx(`${N} finished (.+) at ${P}`),
    build: (m) => {
      const label = zhLabel(g(m, 2));
      return label === null ? null : `${nickZh(g(m, 1))} 在 ${g(m, 3)} 完成了${label}`;
    },
  },
  {
    re: rx(`${N}'s (.+) was cancelled at ${P}`),
    build: (m) => {
      const label = zhLabel(g(m, 2));
      return label === null ? null : `${nickZh(g(m, 1))} 的${label}在 ${g(m, 3)} 已取消`;
    },
  },
  {
    re: rx(`${N}'s (.+) failed at ${P}: (.+)`),
    build: (m) => {
      const label = zhLabel(g(m, 2));
      const reason = zhReason(g(m, 4));
      return label === null || reason === null ? null : `${nickZh(g(m, 1))} 的${label}在 ${g(m, 3)} 失败：${reason}`;
    },
  },
  {
    re: rx(`${N} worked on a (wall|door|toilet) at ${P}`),
    build: (m) => `${nickZh(g(m, 1))} 在 ${g(m, 3)} 施工（${word(g(m, 2)) ?? ''}）`,
  },
  { re: rx(`${N} raised a pillar at ${P}`), build: (m) => `${nickZh(g(m, 1))} 在 ${g(m, 2)} 立起了柱子` },
  {
    re: rx(`${N} damaged a (wall|door|toilet|pillar) at ${P}(?: \\(damage ${NUM}\\))?`),
    build: (m) => {
      const kind = word(g(m, 2));
      if (kind === null) return null;
      const damage = m[4] ? `（损伤 ${m[4]}）` : '';
      return `${nickZh(g(m, 1))} 在 ${g(m, 3)} 损坏了${kind}${damage}`;
    },
  },
  { re: rx(`${N} demolished the object at ${P}`), build: (m) => `${nickZh(g(m, 1))} 拆除了 ${g(m, 2)} 的物件` },
  { re: rx(`${N} opened the door at ${P}`), build: (m) => `${nickZh(g(m, 1))} 打开了 ${g(m, 2)} 的门` },
  { re: rx(`${N} closed the door at ${P}`), build: (m) => `${nickZh(g(m, 1))} 关上了 ${g(m, 2)} 的门` },
  {
    re: rx(`the door at ${P} closed with nobody on its toilet and opened automatically`),
    build: (m) => `${g(m, 1)} 的门因厕所无人而自动打开`,
  },
  {
    re: rx(`${N} (upgraded|downgraded) the toilet at ${P} to level ${NUM} \\(progress ${NUM}\\)`),
    build: (m) =>
      `${nickZh(g(m, 1))} 把 ${g(m, 3)} 的厕所${g(m, 2) === 'upgraded' ? '升级' : '降级'}到 ${g(m, 4)} 级（进度 ${g(m, 5)}）`,
  },
  {
    re: rx(`${N} (upgraded|downgraded) the (wall|door|toilet|pillar) at ${P}`),
    build: (m) => {
      const kind = word(g(m, 3));
      if (kind === null) return null;
      return `${nickZh(g(m, 1))} ${g(m, 2) === 'upgraded' ? '升级' : '降级'}了 ${g(m, 4)} 的${kind}`;
    },
  },
  {
    re: rx(`${N} (upgraded|downgraded) the object at ${P}`),
    build: (m) => `${nickZh(g(m, 1))} ${g(m, 2) === 'upgraded' ? '升级' : '降级'}了 ${g(m, 3)} 的物件`,
  },
  {
    re: rx(`${N} needs the toilet \\((urine|feces)\\) before tick ${NUM}`),
    build: (m) => {
      const need = word(g(m, 2));
      return need === null ? null : `${nickZh(g(m, 1))} 需要如厕（${need}），须在第 ${g(m, 3)} 回合前`;
    },
  },
  {
    re: rx(`${N} is using the level ${NUM} toilet at ${P}: ${NUM}/${NUM}`),
    build: (m) => `${nickZh(g(m, 1))} 在 ${g(m, 3)} 上 ${g(m, 2)} 级厕所：${g(m, 4)}/${g(m, 5)}`,
  },
  {
    re: rx(`${N}'s use at ${P} was interrupted: (.+); recovery by tick ${NUM}`),
    build: (m) => {
      const reason = zhReason(g(m, 3));
      return reason === null ? null : `${nickZh(g(m, 1))} 在 ${g(m, 2)} 的如厕中断：${reason}；须在第 ${g(m, 4)} 回合前恢复`;
    },
  },
  {
    re: rx(`${N}'s use was interrupted: (.+); recovery by tick ${NUM}`),
    build: (m) => {
      const reason = zhReason(g(m, 2));
      return reason === null ? null : `${nickZh(g(m, 1))} 的如厕中断：${reason}；须在第 ${g(m, 3)} 回合前恢复`;
    },
  },
  { re: rx(`${N} resumed using the toilet at ${P}`), build: (m) => `${nickZh(g(m, 1))} 在 ${g(m, 2)} 继续上厕所` },
  {
    re: rx(`${N} finished at ${P} and scored ${NUM}`),
    build: (m) => `${nickZh(g(m, 1))} 如厕成功 ${g(m, 2)}，得 ${g(m, 3)} 分`,
  },
  {
    re: rx(`${N} failed: (failed_deadline|failed_recovery|left|abandoned|success)`),
    build: (m) => `${nickZh(g(m, 1))} 如厕失败：${word(g(m, 2)) ?? ''}`,
  },
  {
    re: rx(`${N} left the world: success, score ${NUM}`),
    build: (m) => `${nickZh(g(m, 1))} 离开世界：成功，得 ${g(m, 2)} 分`,
  },
  {
    re: rx(`${N} left the world: (failed_deadline|failed_recovery|left|abandoned)`),
    build: (m) => `${nickZh(g(m, 1))} 离开世界：${word(g(m, 2)) ?? ''}`,
  },
  { re: rx(`${N} has ${NUM} ticks left before the deadline`), build: (m) => `${nickZh(g(m, 1))} 还剩 ${g(m, 2)} 回合到期` },
  {
    re: rx(`${N} attacks (.+?) at ${P}; the hit lands at tick ${NUM}`),
    build: (m) => `${nickZh(g(m, 1))} 攻击 ${nickZh(g(m, 2))} ${g(m, 3)}，第 ${g(m, 4)} 回合命中`,
  },
  {
    re: rx(`${N} hit (.+?) at ${P}: deadline -${NUM} to ${NUM}, stunned until ${NUM}, immune until ${NUM}`),
    build: (m) =>
      `${nickZh(g(m, 1))} 打中了 ${nickZh(g(m, 2))} ${g(m, 3)}：期限减 ${g(m, 4)}，改为第 ${g(m, 5)} 回合；` +
      `眩晕至第 ${g(m, 6)} 回合，免疫至第 ${g(m, 7)} 回合`,
  },
  {
    re: rx(`${N}'s attack on (.+?) at ${P} missed: (.+)`),
    build: (m) => {
      const reason = zhReason(g(m, 4));
      return reason === null ? null : `${nickZh(g(m, 1))} 攻击 ${nickZh(g(m, 2))} ${g(m, 3)} 未命中：${reason}`;
    },
  },
  {
    re: rx(`${N} blocked (.+?)'s attack on (.+?) at ${P}; (.+?) is stunned until ${NUM}`),
    build: (m) =>
      `${nickZh(g(m, 1))} 防住了 ${nickZh(g(m, 2))} 对 ${nickZh(g(m, 3))} 的攻击 ${g(m, 4)}；` +
      `${nickZh(g(m, 5))} 眩晕至第 ${g(m, 6)} 回合`,
  },
  {
    re: rx(`${N}'s attack on (.+?) at ${P} was cancelled: (.+)`),
    build: (m) => {
      const reason = zhReason(g(m, 4));
      return reason === null ? null : `${nickZh(g(m, 1))} 对 ${nickZh(g(m, 2))} ${g(m, 3)} 的攻击已取消：${reason}`;
    },
  },
  {
    re: rx(`${N} defends ${P} until tick ${NUM}; defend cooldown until tick ${NUM}`),
    build: (m) => `${nickZh(g(m, 1))} 防御 ${g(m, 2)}，至第 ${g(m, 3)} 回合；防御冷却至第 ${g(m, 4)} 回合`,
  },
  { re: rx(`${N} stopped defending`), build: (m) => `${nickZh(g(m, 1))} 停止防御` },
  {
    re: rx(`${N} blocked (.+?)'s demolition at ${P}; (.+?) is stunned until ${NUM}`),
    build: (m) =>
      `${nickZh(g(m, 1))} 防住了 ${nickZh(g(m, 2))} 的拆除 ${g(m, 3)}；${nickZh(g(m, 4))} 眩晕至第 ${g(m, 5)} 回合`,
  },
  {
    re: rx(`${N} is stunned until tick ${NUM}: (.+)`),
    build: (m) => {
      const reason = zhReason(g(m, 3));
      return reason === null ? null : `${nickZh(g(m, 1))} 眩晕至第 ${g(m, 2)} 回合：${reason}`;
    },
  },
  {
    re: rx(`${N}'s (.+?) was rejected at ${P}: (.+)`),
    build: (m) => {
      const verb = intent(g(m, 2));
      const reason = zhReason(g(m, 4));
      return verb === null || reason === null ? null : `${nickZh(g(m, 1))} 的${verb}指令在 ${g(m, 3)} 被拒：${reason}`;
    },
  },
  { re: rx(`tick (\\d+) settled`), build: (m) => `回合 ${g(m, 1)} 结算完毕` },
];

export function zhEvent(text: string): string {
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) return rule.build(m) ?? text;
  }
  return text;
}
