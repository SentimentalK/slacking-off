// Chinese-only check for the watch and play screens: the text under each selector
// may carry nicknames and the few product words the UI keeps in Latin letters.

const KEPT = ['AI', 'LIVE', 'COMPANY TIME', 'Linux', 'macOS', 'Windows', 'loo'];
const LATIN_WORD = /[A-Za-z]{3,}/;

async function nicknames(page) {
  const response = await fetch(new URL('/api/projection', page.url()), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`/api/projection answered ${response.status} while checking Chinese text`);
  const body = await response.json();
  const projection = body.result ?? body;
  return [...(projection.agents ?? []), ...(projection.queue ?? [])].map((entry) => entry.nick).filter(Boolean);
}

export async function assertChinese(page, selectors, label, extraNicks = [], ignore = []) {
  const names = [...new Set([...(await nicknames(page)), ...extraNicks])].sort((a, b) => b.length - a.length);
  const { text, cut } = await page.evaluate(
    (list, skip) => {
      const textOf = (selector) => Array.from(document.querySelectorAll(selector), (node) => node.innerText);
      return { text: list.flatMap(textOf).join('\n'), cut: skip.flatMap(textOf) };
    },
    selectors,
    ignore,
  );
  let rest = text;
  for (const piece of cut.filter(Boolean).sort((a, b) => b.length - a.length)) rest = rest.split(piece).join('');
  for (const name of names) rest = rest.split(name).join('');
  for (const word of KEPT) rest = rest.split(word).join('');
  if (LATIN_WORD.test(rest)) {
    throw new Error(`FAIL: ${label} still shows Latin text ${JSON.stringify(rest.trim())} (selectors ${selectors.join(', ')}; nicknames ${JSON.stringify(names)})`);
  }
  console.log(`PASS: ${label} reads in Chinese (${selectors.join(', ')})`);
}
