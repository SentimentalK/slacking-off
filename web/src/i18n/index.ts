import { useEffect, useState } from 'preact/hooks';
import { detectLang, fill, type Vars } from './detect';
import { DICTS } from './dicts';
import type { Key } from './zh';

export type Lang = keyof typeof DICTS;
export type LangPref = 'auto' | Lang;
export type { Key };
type PluralBase<K = Key> = K extends `${infer B}.one` ? B : never;

export const LANGS = Object.keys(DICTS) as Lang[];
const FALLBACK: Lang = 'en';
const STORAGE_KEY = 'loo.lang';

let pref: LangPref = 'auto';
let started = false;
let lang: Lang = FALLBACK;
const listeners = new Set<() => void>();

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

function apply(): void {
  lang = detectLang(pref === 'auto' ? null : pref, browserLanguages(), LANGS, FALLBACK);
  if (typeof document === 'undefined') return;
  document.documentElement.lang = t('meta.htmlLang');
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function t(key: Key, vars?: Vars): string {
  return fill(DICTS[lang][key], vars);
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

export function initLang(): void {
  pref = storedPref();
  apply();
  if (started) return;
  started = true;
  window.addEventListener('languagechange', () => {
    if (pref !== 'auto') return;
    apply();
    notify();
  });
}

export function setLangPref(next: LangPref): void {
  pref = next;
  try {
    if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be blocked; the choice still holds for this page.
  }
  apply();
  notify();
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
  return DICTS[of]['meta.langName'];
}
