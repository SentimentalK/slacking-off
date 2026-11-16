import { useEffect, useState } from 'preact/hooks';
import { detectLang, fill, type Vars } from './detect';
import type { Key } from './zh';

import { LOADERS, type Dict } from './registry';

export type Lang = keyof typeof LOADERS;
export type LangPref = 'auto' | Lang;
export type { Key };
type PluralBase<K = Key> = K extends `${infer B}.one` ? B : never;

export const LANGS = Object.keys(LOADERS) as Lang[];
const FALLBACK: Lang = 'en';
const STORAGE_KEY = 'loo.lang';

let pref: LangPref = 'auto';
let started = false;
let lang: Lang = FALLBACK;
const listeners = new Set<() => void>();
const loaded: Partial<Record<Lang, Dict>> = {};

async function ensure(of: Lang): Promise<void> {
  loaded[of] ??= await LOADERS[of]();
}

function storedPref(): LangPref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && (LANGS as string[]).includes(raw) ? (raw as Lang) : 'auto';
  } catch {
    return 'auto';
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function target(): Lang {
  return detectLang(pref === 'auto' ? null : pref, browserLanguages(), LANGS, FALLBACK);
}

let applying = 0;

async function apply(): Promise<boolean> {
  const turn = ++applying;
  const next = target();
  await ensure(next);
  if (turn !== applying) return false;
  lang = next;
  if (typeof document === 'undefined') return true;
  document.documentElement.lang = t('meta.htmlLang');
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
  return true;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function t(key: Key, vars?: Vars): string {
  return fill(loaded[lang]?.[key] ?? key, vars);
}

export function tn(base: PluralBase, n: number, vars?: Vars): string {
  return t(`${base}.${n === 1 ? 'one' : 'other'}` as Key, { n, ...vars });
}

export function getLang(): Lang {
  return lang;
}

export function getLangPref(): LangPref {
  return pref;
}

export async function initLang(): Promise<void> {
  pref = storedPref();
  if (!started) {
    started = true;
    window.addEventListener('languagechange', () => {
      if (pref === 'auto') void apply().then((changed) => changed && notify(), () => undefined);
    });
  }
  try {
    await apply();
  } catch {
    pref = FALLBACK;
    await apply();
  }
  void Promise.all(LANGS.map(ensure)).then(notify, () => undefined);
}

export function setLangPref(next: LangPref): void {
  const before = pref;
  pref = next;
  remember(next);
  notify();
  void apply().then(
    (changed) => changed && notify(),
    () => {
      pref = before;
      remember(before);
      notify();
    },
  );
}

function remember(value: LangPref): void {
  try {
    if (value === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be blocked; the choice still holds for this page.
  }
}

// Text computed inside useMemo/useCallback must list `lang` as a dependency: `t` itself never changes.
export function useI18n(): { t: typeof t; tn: typeof tn; lang: Lang; pref: LangPref } {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { t, tn, lang, pref };
}

export function langName(of: Lang): string {
  return loaded[of]?.['meta.langName'] ?? of;
}
