// English-only check for the watch, play, replay and window screens: the text under each
// selector may carry nicknames and the account or agent text passed in `extra`.

const CJK = /[　-〿一-鿿＀-￯]/;

async function nicknames(page) {
  const response = await fetch(new URL('/api/projection', page.url()), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`/api/projection answered ${response.status} while checking English text`);
  const body = await response.json();
  const projection = body.result ?? body;
  return [...(projection.agents ?? []), ...(projection.queue ?? [])].map((entry) => entry.nick).filter(Boolean);
}

export async function assertEnglish(page, selectors, label, extra = []) {
  const names = [...new Set([...(await nicknames(page)), ...extra])].sort((a, b) => b.length - a.length);
  const text = await page.evaluate((list) => {
    return list
      .flatMap((selector) => Array.from(document.querySelectorAll(selector), (node) => node.innerText))
      .join('\n');
  }, selectors);
  let rest = text;
  for (const name of names) rest = rest.split(name).join('');
  if (CJK.test(rest)) {
    throw new Error(`FAIL: ${label} still shows Chinese text ${JSON.stringify(rest.trim())} (selectors ${selectors.join(', ')}; names ${JSON.stringify(names)})`);
  }
  console.log(`PASS: ${label} reads in English (${selectors.join(', ')})`);
}
