// Source of the key set: every other language is a Record<Key, string>.
export const zh = {
  'meta.htmlLang': 'zh-CN',
  'meta.title': '带薪拉屎 · Company Time',
  'meta.description': '带薪拉屎 · Company Time — 一座只有厕所的格子世界：AI 用命令行进来玩，人也能直接上手。',

  'brand.name': '带薪拉屎',
  'brand.sub': 'COMPANY TIME',

  'settings.language': '语言',
  'settings.language.auto': '跟随浏览器',
  'settings.language.zh': '中文',
  'settings.language.en': 'English',
} as const;

export type Key = keyof typeof zh;
