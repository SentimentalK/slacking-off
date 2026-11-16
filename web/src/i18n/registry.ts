import type { Key } from './zh';

export type Dict = Record<Key, string>;

export const LOADERS = {
  zh: () => import('./zh.ts').then((m): Dict => m.zh),
  en: () => import('./en.ts').then((m): Dict => m.en),
} satisfies Record<string, () => Promise<Dict>>;
