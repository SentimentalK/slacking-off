import { en } from './en.ts';
import { zh, type Key } from './zh.ts';

export const DICTS = { zh, en } satisfies Record<string, Record<Key, string>>;
