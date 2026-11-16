import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, fill } from '../src/i18n/detect.ts';
import { LOADERS } from '../src/i18n/registry.ts';

const DICTS = Object.fromEntries(
  await Promise.all(Object.entries(LOADERS).map(async ([name, load]) => [name, await load()])),
);
const { zh } = DICTS;
const LANGS = Object.keys(DICTS);

test('every language has exactly the key set of zh and no empty value', () => {
  const keys = Object.keys(zh).sort();
  for (const [name, dict] of Object.entries(DICTS)) {
    assert.deepEqual(Object.keys(dict).sort(), keys, `${name} key set differs from zh`);
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${name}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${name}.${key} is empty`);
    }
  }
});

test('placeholders match across languages', () => {
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(zh)) {
    for (const [name, dict] of Object.entries(DICTS)) {
      assert.deepEqual(names(dict[key]), names(zh[key]), `${name}.${key} placeholders differ from zh`);
    }
  }
});

test('plural keys come in one/other pairs', () => {
  const ones = Object.keys(zh).filter((key) => key.endsWith('.one'));
  assert.ok(ones.length > 0);
  for (const key of ones) assert.ok(`${key.slice(0, -4)}.other` in zh, `${key} has no .other`);
});

test('every dictionary names its own language', () => {
  const names = Object.values(DICTS).map((dict) => dict['meta.langName']);
  assert.equal(new Set(names).size, names.length);
});

test('the stored choice beats the browser, then the first supported browser language, then English', () => {
  assert.equal(detectLang('zh', ['en-US'], LANGS, 'en'), 'zh');
  assert.equal(detectLang('en', ['zh-CN'], LANGS, 'en'), 'en');
  assert.equal(detectLang(null, ['zh-CN', 'en-US'], LANGS, 'en'), 'zh');
  assert.equal(detectLang(null, ['zh-TW'], LANGS, 'en'), 'zh');
  assert.equal(detectLang(null, ['zh'], LANGS, 'en'), 'zh');
  assert.equal(detectLang(null, ['en-US', 'zh-CN'], LANGS, 'en'), 'en');
  assert.equal(detectLang(null, ['ja-JP'], LANGS, 'en'), 'en');
  assert.equal(detectLang(null, ['ja-JP', 'zh-CN'], LANGS, 'en'), 'zh');
  assert.equal(detectLang(null, [], LANGS, 'en'), 'en');
  assert.equal(detectLang('fr', ['zh-CN'], LANGS, 'en'), 'zh');
});

test('fill replaces known placeholders and leaves unknown ones', () => {
  assert.equal(fill('Turn {n} · {who}', { n: 12, who: 'ai-01' }), 'Turn 12 · ai-01');
  assert.equal(fill('{missing} stays', {}), '{missing} stays');
  assert.equal(fill('no vars'), 'no vars');
});
