export type Vars = Record<string, string | number>;

/** First browser language whose primary subtag is supported wins; none -> fallback. */
export function detectLang<L extends string>(
  pref: string | null,
  languages: readonly string[],
  supported: readonly L[],
  fallback: L,
): L {
  if (pref && (supported as readonly string[]).includes(pref)) return pref as L;
  for (const tag of languages) {
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    if ((supported as readonly string[]).includes(base)) return base as L;
  }
  return fallback;
}

export function fill(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}
