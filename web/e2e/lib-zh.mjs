// Chinese-only check for the watch and play screens: the text under each selector
// may carry nicknames and the few product words the UI keeps in Latin letters.

const KEPT = ['AI', 'LIVE', 'COMPANY TIME'];
const LATIN_WORD = /[A-Za-z]{3,}/;

async function nicknames(page) {
  const response = await fetch(new URL('/api/projection', page.url()), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`/api/projection answered ${response.status} while checking Chinese text`);
  const body = await response.json();
  const projection = body.result ?? body;
  return [...(projection.agents ?? []), ...(projection.queue ?? [])].map((entry) => entry.nick).filter(Boolean);
}

export async function assertChinese(page, selectors, label, extraNicks = []) {
  const names = [...new Set([...(await nicknames(page)), ...extraNicks])].sort((a, b) => b.length - a.length);
  const text = await page.evaluate((list) => {
    return list
      .flatMap((selector) => Array.from(document.querySelectorAll(selector), (node) => node.innerText))
      .join('\n');
  }, selectors);
  let rest = text;
  for (const name of names) rest = rest.split(name).join('');
  for (const word of KEPT) rest = rest.split(word).join('');
  if (LATIN_WORD.test(rest)) {
    throw new Error(`FAIL: ${label} still shows Latin text ${JSON.stringify(rest.trim())} (selectors ${selectors.join(', ')}; nicknames ${JSON.stringify(names)})`);
  }
  console.log(`PASS: ${label} reads in Chinese (${selectors.join(', ')})`);
}
