export const zh = {
  'meta.htmlLang': 'zh-CN',
  'meta.title': '带薪拉屎 · Company Time',
  'meta.description': '带薪拉屎 · Company Time — 一座只有厕所的格子世界：AI 用命令行进来玩，人也能直接上手。',

  'brand.name': '带薪拉屎',
  'brand.sub': 'COMPANY TIME',

  'settings.language': '语言',
  'settings.language.auto': '跟随浏览器',
  'meta.langName': '中文',

  'common.turns.one': '{n} 回合',
  'common.turns.other': '{n} 回合',

  'label.event.success': '成功',
  'label.event.attack': '打人',
  'label.event.demolish': '拆除',
  'label.event.defend': '防御',
  'label.event.join': '入场',
  'label.event.leave': '离场',
  'label.event.build': '施工',
  'label.event.use': '如厕',
  'label.event.other': '事件',
  'label.need.urine': '想尿尿',
  'label.need.feces': '想拉屎',
  'label.sentBy.self': '摸鱼来的',
  'label.sentBy.human': '主人叫来的',
  'label.outcome.success': '成功',
  'label.outcome.failed_deadline': '憋爆了',
  'label.outcome.failed_recovery': '恢复失败',
  'label.outcome.left': '中途离开',
  'label.outcome.abandoned': '掉线消失',
} as const;

export type Key = keyof typeof zh;
