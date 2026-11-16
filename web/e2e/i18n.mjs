// Real-Chrome end-to-end for the language switch: the page follows the browser language
// (zh-CN, en-US, and ja-JP, which falls back to English), a manual choice in Settings applies at
// once, survives a reload and can be reverted to following the browser, and every window and
// screen reads entirely in the active language. Review screenshots go to docs/screenshots/m/.
//
// `scripts/e2e-i18n.sh` starts the official server and passes LOO_I18N_PORT and LOO_I18N_DIR.
// Every successful check prints `PASS: ...`; a failure prints `FAIL: <phase>: ...` and exits 1.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { assertChinese } from './lib-zh.mjs';
import { assertEnglish } from './lib-en.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = process.env.LOO_I18N_PORT || '18121';
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = process.env.LOO_I18N_DIR || path.join(ROOT, '.conductor/m/i18n');
const HOME = path.join(DIR, 'home');
const BIN = path.join(DIR, 'bin');
const LOO = path.join(BIN, 'loo');
const CHROME_ROOT = path.join(DIR, 'chrome');
const SHOTS = path.join(ROOT, 'docs/screenshots/m');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const PASSWORD = 'i18n-e2e-password-123';
const AI_OWNER = 'i18n-ai';
const AI_NICK = 'i18n-bot';
const AI_MODEL = 'e2e';
const AI_INTRO = 'i18n check bot';
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1 };
const COLOR_4 = { en: 'Color 4', zh: '颜色 4' };
// Each language is listed under its own name in the Settings language picker.
const LANGUAGE_NAMES = ['中文', 'English'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
let currentPhase = 'startup';
let page = null;
let aiId = null;
const browsers = [];
const pageErrors = [];

function phase(name) {
  currentPhase = name;
  console.log(`== ${name}`);
}

function pass(message) {
  checks += 1;
  console.log(`PASS: ${message}`);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function until(condition, { timeout = 10_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await condition();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout after ${timeout}ms waiting for ${label}; last=${JSON.stringify(last).slice(0, 300)}`);
}

function run(command, args, env = {}, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (!allowFail && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runShell(script, env = {}) {
  return run('/bin/sh', ['-c', script], env);
}

function cliState() {
  return JSON.parse(run(LOO, ['--json', 'status'], { LOO_HOME: HOME }).stdout).state ?? null;
}

function recorder(target) {
  return target.evaluateOnNewDocument(() => {
    const original = window.fetch;
    window.fetch = async function (input, init) {
      const response = await original.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (url.includes('/api/play/state')) {
          response
            .clone()
            .json()
            .then((body) => {
              if (body && body.ok && body.result) window.__i18nPlay = body.result;
            })
            .catch(() => {});
        }
      } catch {
        // The app's own request is never affected by the recorder.
      }
      return response;
    };
  });
}

async function newPage(browser, viewport = DESKTOP) {
  const target = await browser.newPage();
  await recorder(target);
  target.on('pageerror', (error) => pageErrors.push(`${currentPhase}: ${error.message}`));
  target.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await target.setViewport(viewport);
  page = target;
  return target;
}

async function launch(locale, name) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: path.join(CHROME_ROOT, name),
    defaultViewport: DESKTOP,
    args: [
      `--lang=${locale}`,
      // Headless Chrome reads navigator.languages only from --accept-lang, so both flags are needed.
      `--accept-lang=${locale}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--use-gl=angle',
      '--use-angle=gl',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  browsers.push(browser);
  return browser;
}

async function closeBrowser(browser) {
  const index = browsers.indexOf(browser);
  if (index >= 0) browsers.splice(index, 1);
  await browser.close().catch(() => {});
}

async function shot(target, name) {
  const file = path.join(SHOTS, name);
  await target.screenshot({ path: file, type: 'png' });
  const { size } = fs.statSync(file);
  assert(size > 5_000, `${name} looks blank (${size} bytes)`);
  console.log(`SHOT: ${name} (${Math.round(size / 1024)} KB)`);
}

async function waitShell(target, lang) {
  await target.waitForFunction(
    (want) => document.documentElement.lang === want && document.querySelector('.ui-clock .live') !== null,
    { timeout: 20_000 },
    lang,
  );
}

async function openSettings(target) {
  if (!(await target.$('.win[data-window="settings"]'))) {
    await target.click('button[data-open="settings"]');
  }
  await target.waitForSelector('.win[data-window="settings"]', { visible: true, timeout: 10_000 });
}

async function assertScreen(target, lang, label, extra = []) {
  if (lang === 'en') await assertEnglish(target, ['body'], label, extra);
  else await assertChinese(target, ['body'], label, extra, ['pre', 'code']);
}

async function screen(target, lang, name, extra = [], size = DESKTOP) {
  await assertScreen(target, lang, `${name} ${lang}`, extra);
  await shot(target, `${name}-${lang}-${size.width}.png`);
}

async function ensureAiInside(minTicks = 30) {
  const env = { LOO_HOME: HOME };
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const state = cliState();
    if (state?.placement === 'inside' && state.deadline_tick - state.tick >= minTicks) return;
    if (state?.placement === 'inside') {
      run(LOO, ['leave'], env, { allowFail: true });
      await sleep(800);
    }
    if (cliState()?.placement !== 'waiting') {
      run(LOO, ['join', '--sent-by', 'self', '--why', 'i18n'], env, { allowFail: true });
    }
    await sleep(800);
  }
  throw new Error(`${AI_NICK} did not get inside: ${JSON.stringify(cliState()).slice(0, 300)}`);
}

async function setupAi() {
  phase('setup: AI owner account, CLI, AI in the world');
  const browser = await launch('en-US', 'setup');
  const target = await newPage(browser);
  let shCommand = '';
  try {
    await target.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await target.waitForSelector('input[name=username]', { visible: true, timeout: 15_000 });
    await target.type('input[name=username]', AI_OWNER);
    await target.type('input[name=password]', PASSWORD);
    await target.click('button[type=submit]');
    await target.waitForFunction(() => window.location.pathname === '/account', { timeout: 15_000 });
    await target.waitForSelector('[data-testid=token-action]', { visible: true, timeout: 10_000 });
    await target.click('[data-testid=token-action]');
    await target.waitForSelector('[data-testid=install-command]', { timeout: 10_000 });
    shCommand = await target.$eval('[data-testid=install-command]', (element) => element.textContent.trim());
  } finally {
    await closeBrowser(browser);
  }
  assert(shCommand.startsWith('curl '), `unexpected install command: ${shCommand.slice(0, 80)}`);
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(BIN, { recursive: true });
  runShell(shCommand, { LOO_HOME: HOME, LOO_BIN_DIR: BIN });
  assert(fs.existsSync(LOO), `installer did not put loo at ${LOO}`);
  pass(`installed the CLI into ${BIN} from the account page's one-time command`);

  const registered = run(LOO, ['register', '--name', AI_NICK, '--model', AI_MODEL, '--intro', AI_INTRO], { LOO_HOME: HOME });
  assert(/created/.test(registered.stdout), `loo register did not report created:\n${registered.stdout}`);
  aiId = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).agent_id;
  assert(typeof aiId === 'number', 'loo register did not save agent_id');
  pass(`registered ${AI_NICK} as agent ${aiId} through the CLI`);
  await ensureAiInside();
  pass(`${AI_NICK} is inside the world`);
}

async function assertBrandClear(target, label) {
  const geometry = await target.evaluate(() => {
    const brand = document.querySelector('.ui-brand .t1');
    const pill = document.querySelector('.ui-navr .cnt');
    if (!brand || !pill) return null;
    const a = brand.getBoundingClientRect();
    const b = pill.getBoundingClientRect();
    return {
      brand: [a.left, a.top, a.right, a.bottom],
      pill: [b.left, b.top, b.right, b.bottom],
      scrollWidth: brand.scrollWidth,
      clientWidth: brand.clientWidth,
    };
  });
  assert(geometry, `${label}: the brand name or the counter capsule is missing from the top bar`);
  const [al, at, ar, ab] = geometry.brand;
  const [bl, bt, br, bb] = geometry.pill;
  const overlap = al < br && bl < ar && at < bb && bt < ab;
  assert(!overlap, `${label}: brand name ${JSON.stringify(geometry.brand)} overlaps counter capsule ${JSON.stringify(geometry.pill)}`);
  assert(
    geometry.scrollWidth <= geometry.clientWidth,
    `${label}: brand name is cut off (scrollWidth ${geometry.scrollWidth} > clientWidth ${geometry.clientWidth})`,
  );
  pass(`${label}: brand name and counter capsule do not overlap, and the brand name is not cut off`);
}

async function assertLastSessionColumnReachable(target, label) {
  const column = await target.evaluate(() => {
    const headers = document.querySelectorAll('.win[data-window="agent"] table thead th');
    const last = headers[headers.length - 1];
    if (!last) return null;
    last.scrollIntoView({ block: 'nearest', inline: 'end' });
    const rect = last.getBoundingClientRect();
    return { text: last.textContent.trim(), left: rect.left, right: rect.right, width: window.innerWidth };
  });
  assert(column, `${label}: the agent window has no session table header row`);
  assert(
    column.left >= 0 && column.right <= column.width,
    `${label}: last session column "${column.text}" is still outside the window after scrolling its table (${column.left}–${column.right} in ${column.width}px)`,
  );
  pass(`${label}: last session column "${column.text}" scrolls into view`);
}

async function homeFollowsBrowser(locale, expect, tag) {
  phase(`A language follow: ${locale}`);
  const browser = await launch(locale, `a-${tag}`);
  try {
    const target = await newPage(browser);
    await target.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await waitShell(target, expect.lang);
    const title = await target.title();
    assert(title.includes(expect.title), `${locale} title is ${JSON.stringify(title)}, expected it to include ${expect.title}`);
    pass(`${locale}: <html lang> is ${expect.lang} and the title reads ${JSON.stringify(title)}`);
    if (expect.zh) {
      await assertChinese(target, ['body'], `home ${locale}`, [], ['pre', 'code']);
    } else {
      await assertEnglish(target, ['body'], `home ${locale}`);
    }
    await shot(target, `home-${tag}-1440.png`);
    await target.setViewport(PHONE);
    if (expect.lang === 'en') await assertBrandClear(target, `home ${tag} 390`);
    await shot(target, `home-${tag}-390.png`);
  } finally {
    await closeBrowser(browser);
  }
}

async function followBrowserLanguage() {
  await homeFollowsBrowser('zh-CN', { lang: 'zh-CN', title: '带薪拉屎', zh: true }, 'zh');
  await homeFollowsBrowser('en-US', { lang: 'en', title: 'Company Time', zh: false }, 'en');
  await homeFollowsBrowser('ja-JP', { lang: 'en', title: 'Company Time', zh: false }, 'ja');
}

async function manualOverride() {
  phase('B manual override (en-US browser)');
  const browser = await launch('en-US', 'b-en');
  try {
    const target = await newPage(browser);
    await target.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await waitShell(target, 'en');
    await target.evaluate(() => {
      window.__noReload = 1;
    });
    await openSettings(target);
    await target.click('[data-lang="zh"]');
    await target.waitForFunction(
      () =>
        document.documentElement.lang === 'zh-CN' &&
        (document.querySelector('.ui-brand .t1')?.textContent ?? '').includes('带薪拉屎'),
      { timeout: 3_000 },
    ).catch(() => {
      throw new Error('the manual 中文 choice did not reach the page within 3 s');
    });
    pass('manual 中文 switches <html lang> to zh-CN and the top bar to 带薪拉屎 within 3 s');
    assert((await target.evaluate(() => window.__noReload)) === 1, 'the page reloaded on the manual language switch');
    pass('the manual 中文 switch did not reload the page');
    assert((await target.title()).includes('带薪拉屎'), 'the title did not switch to 带薪拉屎');
    pass('the title switches to 带薪拉屎 without a reload');
    assert((await target.evaluate(() => localStorage.getItem('loo.lang'))) === 'zh', 'localStorage loo.lang is not zh');
    pass("localStorage['loo.lang'] is 'zh' after the manual choice");
    await shot(target, 'override-zh-1440.png');

    await target.reload({ waitUntil: 'domcontentloaded' });
    await waitShell(target, 'zh-CN');
    assert((await target.$eval('.ui-brand .t1', (element) => element.textContent.trim())).includes('带薪拉屎'), 'after reload the top bar is not 带薪拉屎');
    pass('the manual 中文 choice survives a reload');

    await openSettings(target);
    await target.click('[data-lang="auto"]');
    await target.waitForFunction(() => document.documentElement.lang === 'en', { timeout: 3_000 });
    assert((await target.evaluate(() => localStorage.getItem('loo.lang'))) === null, 'localStorage loo.lang is still set after 自动');
    assert((await target.$eval('.ui-brand .t1', (element) => element.textContent.trim())) === 'Company Time', 'the top bar did not return to Company Time');
    pass('自动 returns to the browser language (English) and clears localStorage loo.lang');
    await assertEnglish(target, ['body'], 'override back to auto', LANGUAGE_NAMES);

    await target.click('[data-lang="en"]');
    await target.waitForFunction(() => localStorage.getItem('loo.lang') === 'en', { timeout: 3_000 });
    await target.click('[data-lang="auto"]');
    await target.waitForFunction(() => localStorage.getItem('loo.lang') === null, { timeout: 3_000 });
    pass('a manual English choice and a return to 自动 both work');
  } finally {
    await closeBrowser(browser);
  }
}

async function cycle(lang) {
  const locale = lang === 'en' ? 'en-US' : 'zh-CN';
  const user = `i18n-${lang}`;
  const human = `${lang}-human`;
  const extra = [user, human, 'en-human', 'zh-human', AI_NICK, AI_OWNER, AI_INTRO, AI_MODEL, AI_MODEL.toUpperCase()];
  const browser = await launch(locale, `c-${lang}`);
  try {
    const target = await newPage(browser);
    phase(`C ${lang}: register (before submit)`);
    await target.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await target.waitForSelector('input[name=username]', { visible: true, timeout: 15_000 });
    await screen(target, lang, 'register', extra);

    phase(`C ${lang}: register, account`);
    await target.type('input[name=username]', user);
    await target.type('input[name=password]', PASSWORD);
    await target.click('button[type=submit]');
    await target.waitForFunction(() => window.location.pathname === '/account', { timeout: 15_000 });
    await target.waitForFunction(
      (name) => document.querySelector('.win[data-window="account"] .nick')?.textContent?.includes(name),
      { timeout: 10_000 },
      user,
    );
    await target.waitForSelector('[data-testid=token-action]', { visible: true, timeout: 10_000 });
    await target.click('[data-testid=token-action]');
    await target.waitForSelector('[data-testid=install-command]', { timeout: 10_000 });
    await screen(target, lang, 'account', extra);

    phase(`C ${lang}: leaderboard, stats, profile`);
    await target.goto(`${BASE}/leaderboard`, { waitUntil: 'domcontentloaded' });
    await target.waitForSelector('.win[data-window="leaderboard"]', { visible: true, timeout: 10_000 });
    await screen(target, lang, 'leaderboard', extra);
    await target.goto(`${BASE}/stats`, { waitUntil: 'domcontentloaded' });
    await target.waitForSelector('.win[data-window="stats"]', { visible: true, timeout: 10_000 });
    await screen(target, lang, 'stats', extra);
    await target.goto(`${BASE}/agent/${aiId}`, { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(
      (name) => document.querySelector('.win[data-window="agent"] .nick')?.textContent?.includes(name),
      { timeout: 10_000 },
      AI_NICK,
    );
    await screen(target, lang, 'profile', extra);
    await assertLastSessionColumnReachable(target, `profile ${lang} 1440`);

    phase(`C ${lang}: watch card`);
    await ensureAiInside();
    await target.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await clickAgentOnField(target, aiId);
    await target.waitForFunction(
      (name) => document.querySelector('.ui-card .nick')?.textContent?.includes(name),
      { timeout: 10_000 },
      AI_NICK,
    );
    await screen(target, lang, 'watch-card', extra);
    if (lang === 'en') {
      await target.setViewport(PHONE);
      await sleep(1_000);
      if (await cardShowsAi(target, AI_NICK)) {
        console.log('NOTE: watch-card-en-390 keeps the card selected after the resize (option C)');
      } else {
        await target.setViewport(DESKTOP);
        await walkAiTowardEntrance();
        await target.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await target.setViewport(PHONE);
        await clickAgentOnField(target, aiId);
        await target.waitForFunction(
          (name) => document.querySelector('.ui-card .nick')?.textContent?.includes(name),
          { timeout: 10_000 },
          AI_NICK,
        );
        console.log('NOTE: watch-card-en-390 walked the AI toward the entrance before clicking (option A)');
      }
      await sleep(500);
      if (lang === 'en') await assertBrandClear(target, 'watch-card en 390');
      await screen(target, lang, 'watch-card', extra, PHONE);
      await target.setViewport(DESKTOP);
    }

    phase(`C ${lang}: play, create and join the human`);
    await target.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await safeClick(target, '[data-testid=play-create-open]');
    await target.waitForSelector('[data-window="create"] input[type=text]', { visible: true, timeout: 10_000 });
    await target.type('[data-window="create"] input[type=text]', human);
    await safeClick(target, `[data-window="create"] [aria-label="${COLOR_4[lang]}"]`);
    await safeClick(target, '[data-testid=play-create]');
    await target.waitForFunction(() => !document.querySelector('[data-window="create"]'), { timeout: 10_000 });
    await target.waitForSelector('[data-testid=play-join]', { visible: true, timeout: 10_000 });
    await joinHuman(target);
    const me = (await target.evaluate(() => window.__i18nPlay?.agent?.pos ?? null));
    assert(me, 'the human has no position after joining');
    await openMenuNextTo(target, me);
    await screen(target, lang, 'play', extra);
    if (lang === 'en') {
      await target.setViewport(PHONE);
      await sleep(800);
      await assertBrandClear(target, 'play en 390');
      await screen(target, lang, 'play', extra, PHONE);
      await target.setViewport(DESKTOP);
    }
    await leaveHuman(target);

    phase(`C ${lang}: replay, settings, login`);
    await target.goto(`${BASE}/replay`, { waitUntil: 'domcontentloaded' });
    await target.waitForSelector('.ui-clock .live.rp', { timeout: 15_000 });
    await sleep(1_000);
    await screen(target, lang, 'replay', extra);

    await target.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await waitShell(target, lang === 'en' ? 'en' : 'zh-CN');
    await openSettings(target);
    await screen(target, lang, 'settings', [...extra, ...LANGUAGE_NAMES]);

    await target.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
    await target.waitForFunction(
      (name) => document.querySelector('.win[data-window="account"] .nick')?.textContent?.includes(name),
      { timeout: 10_000 },
      user,
    );
    await target.evaluate(() => {
      document.querySelector('.win[data-window="account"] .nick').parentElement.querySelector('button').click();
    });
    await target.waitForSelector('.win[data-window="login"]', { visible: true, timeout: 10_000 });
    await screen(target, lang, 'login', extra);
  } finally {
    await closeBrowser(browser);
  }
}

async function safeClick(target, selector, timeout = 10_000) {
  await target.waitForSelector(selector, { visible: true, timeout });
  try {
    await target.click(selector);
  } catch {
    await target.evaluate((wanted) => document.querySelector(wanted)?.click(), selector);
  }
}

async function cardShowsAi(target, name) {
  return target.evaluate((wanted) => document.querySelector('.ui-card .nick')?.textContent?.includes(wanted) ?? false, name);
}

async function walkAiTowardEntrance() {
  const entrance = { x: 6, y: 15 };
  await ensureAiInside();
  for (let step = 0; step < 16; step += 1) {
    const pos = cliState()?.pos;
    if (!pos || (pos.x === entrance.x && pos.y === entrance.y)) break;
    const dir = pos.x < entrance.x ? 'E' : pos.x > entrance.x ? 'W' : pos.y > entrance.y ? 'N' : 'S';
    const moved = run(LOO, ['move', dir], { LOO_HOME: HOME }, { allowFail: true });
    await sleep(moved.status === 3 ? 1_100 : 900);
  }
}

async function clickAgentOnField(target, id) {
  const deadline = Date.now() + 30_000;
  let diag = null;
  while (Date.now() < deadline) {
    diag = await target.evaluate((agent) => {
      const view = window.__looView;
      const canvas = document.querySelector('canvas.ui-canvas');
      if (!view || !canvas) return { ready: false };
      const at = view.screenOf(agent);
      const box = canvas.getBoundingClientRect();
      const inside = at && at.x >= box.left + 20 && at.x <= box.right - 20 && at.y >= box.top + 20 && at.y <= box.bottom - 20;
      return { ready: true, at, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, inside: Boolean(inside) };
    }, id);
    if (diag.inside) {
      await target.mouse.click(diag.at.x, diag.at.y);
      return;
    }
    await sleep(150);
  }
  throw new Error(`agent ${id} is not on the field: ${JSON.stringify(diag)}`);
}

async function joinHuman(target) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const state = await target.evaluate(() => window.__i18nPlay ?? null);
    if (state?.placement === 'inside') return;
    if (await target.$('[data-testid=play-join]')) await safeClick(target, '[data-testid=play-join]');
    try {
      await target.waitForFunction(() => window.__i18nPlay?.placement === 'inside', { timeout: 10_000 });
      return;
    } catch {
      if ((await target.evaluate(() => window.__i18nPlay?.placement ?? null)) === 'waiting') await leaveHuman(target);
      await target.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
      await sleep(1_500);
    }
  }
  throw new Error('could not get the human inside after three attempts');
}

async function leaveHuman(target) {
  const joined = await target.evaluate(() => window.__i18nPlay?.joined ?? false);
  if (!joined) return;
  if (await target.$('[data-testid=play-leave]')) await safeClick(target, '[data-testid=play-leave]');
  await target.waitForFunction(() => window.__i18nPlay?.joined === false, { timeout: 10_000 });
}

async function openMenuNextTo(target, me) {
  const neighbours = [
    { x: me.x + 1, y: me.y },
    { x: me.x - 1, y: me.y },
    { x: me.x, y: me.y + 1 },
    { x: me.x, y: me.y - 1 },
  ];
  let last = null;
  for (const cell of neighbours) {
    try {
      const point = await until(
        () =>
          target.evaluate((wanted) => {
            const view = window.__looView;
            const canvas = document.querySelector('canvas.ui-canvas');
            if (!view || !canvas) return null;
            const at = view.screenOfCell(wanted.x, wanted.y);
            if (!at) return null;
            return document.elementFromPoint(at.x, at.y) === canvas ? { x: at.x, y: at.y } : null;
          }, cell),
        { timeout: 5_000, interval: 100, label: `cell ${cell.x},${cell.y} on screen` },
      );
      await target.mouse.click(point.x, point.y);
      await target.waitForSelector('[data-play-menu]', { visible: true, timeout: 3_000 });
      return;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`the action menu did not open next to the human: ${last?.message}`);
}

async function main() {
  console.log(`i18n e2e against ${BASE} (data ${DIR})`);
  fs.mkdirSync(SHOTS, { recursive: true });
  const health = await fetch(`${BASE}/healthz`);
  assert(health.ok, `server healthz returned ${health.status}`);

  await followBrowserLanguage();
  await manualOverride();
  await setupAi();
  await cycle('en');
  await cycle('zh');

  if (pageErrors.length > 0) console.log(`NOTE: ${pageErrors.length} uncaught page error(s): ${pageErrors.join(' | ')}`);
  console.log(`PASS: i18n e2e complete (${checks} checks)`);
}

main()
  .catch((error) => {
    console.error(`FAIL: ${currentPhase}: ${String(error.message).replace(/^FAIL: /, '')}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const browser of browsers.splice(0)) await browser.close().catch(() => {});
  });
