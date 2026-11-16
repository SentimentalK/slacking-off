// Real-Chrome smoke for the "我自己上" mode inside the shell: register, create a
// character on /play, join, click a reachable cell four or more steps away and
// watch the character walk there, then open the menu of an adjacent empty cell
// and close it with Esc. Clicks are mouse at 1440 wide and touch at 390 wide;
// text goes in with page.type. Screenshots land in --out.

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { findPath } from '../src/play/path.ts';

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) parsed[argv[i].replace(/^--/, '')] = argv[i + 1];
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['base', 'out', 'width', 'height']) {
  if (!args[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}

const BASE = args.base.replace(/\/+$/, '');
const OUT = args.out;
const WIDTH = Number(args.width);
const HEIGHT = Number(args.height);
const TOUCH = WIDTH <= 700;
const CHROME = '/usr/bin/google-chrome';
const RUN = Date.now().toString(36);
const USERNAME = `smk${WIDTH}${RUN}`;
const NICK = `s${RUN}`.slice(0, 16);
const PASSWORD = 'smoke-pass-2026';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(read, accept, { timeout, interval = 100, label }) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(interval);
  }
  throw new Error(`timeout after ${timeout}ms waiting for ${label}; last=${JSON.stringify(last).slice(0, 240)}`);
}

const pass = (message) => console.log(`PASS: ${message}`);

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--lang=zh-CN', '--accept-lang=zh-CN',
    '--no-sandbox',
    '--no-first-run',
    '--use-angle=gl',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
  ],
});

const pageErrors = [];
let page = null;
let phase = 'start';

try {
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  if (TOUCH) {
    const agent = (await browser.userAgent()).replace('(X11; Linux x86_64)', '(Linux; Android 14; Pixel 7) Mobile');
    await page.emulate({
      userAgent: agent,
      viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    });
  } else {
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  }

  const tapPoint = async (x, y) => {
    if (TOUCH) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  };
  const tapSelector = async (selector) => {
    const handle = await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    await tapPoint(box.x + box.width / 2, box.y + box.height / 2);
  };
  const fetchState = () =>
    page.evaluate(async () => {
      const response = await fetch('/api/play/state', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      const body = await response.json();
      if (!body.ok) throw new Error(`/api/play/state: ${body.error?.code ?? 'failed'}`);
      return body.result;
    });
  const bottomText = (selector) =>
    page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', selector);

  phase = 'register';
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=username]', { visible: true, timeout: 15_000 });
  await page.type('input[name=username]', USERNAME);
  await page.type('input[name=password]', PASSWORD);
  await tapSelector('button[type=submit]');
  await page.waitForFunction(() => location.pathname === '/account', { timeout: 15_000 });
  pass(`registered ${USERNAME} and reached /account`);

  phase = 'create character';
  await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
  await tapSelector('[data-testid="play-create-open"]');
  await page.waitForSelector('[data-window="create"] input[type=text]', { visible: true, timeout: 10_000 });
  await page.type('[data-window="create"] input[type=text]', NICK);
  await tapSelector('[data-window="create"] .sw i:nth-child(4)');
  await tapSelector('[data-testid="play-create"]');
  await page.waitForFunction(() => !document.querySelector('[data-window="create"]'), { timeout: 10_000 });
  pass(`created character ${NICK}`);

  phase = 'join';
  await tapSelector('[data-testid="play-join"]');
  await page.waitForSelector('.ui-bottom[data-mode="play"] .play-row .bar', { visible: true, timeout: 15_000 });
  await sleep(600);
  const joined = await fetchState();
  if (joined.placement !== 'inside') throw new Error(`joined but placement is ${joined.placement}: the entrance is taken`);
  pass('joined: the need bar is in the play bottom bar');
  if (WIDTH >= 1440) {
    await page.screenshot({ path: path.join(OUT, `play-${WIDTH}.png`) });
  }

  phase = 'walk';
  const state = await fetchState();
  const terrain = await (await fetch(`${BASE}/api/terrain`)).json();
  const me = state.agent.pos;
  const win = state.window;
  const candidates = [];
  for (let y = win.origin.y; y < win.origin.y + win.height; y++) {
    for (let x = win.origin.x; x < win.origin.x + win.width; x++) {
      const distance = Math.abs(x - me.x) + Math.abs(y - me.y);
      if (distance < 4) continue;
      const route = findPath(state, terrain.width, terrain.height, { x, y });
      if (route) candidates.push({ x, y, length: route.length });
    }
  }
  candidates.sort((a, b) => a.length - b.length);
  if (candidates.length === 0) throw new Error('no reachable cell four or more steps away in the window');

  const target = await pollUntil(
    () =>
      page.evaluate((list) => {
        const view = window.__looView;
        const canvas = document.querySelector('canvas.ui-canvas');
        if (!view || !canvas) return null;
        for (const cell of list) {
          const point = view.screenOfCell(cell.x, cell.y);
          if (!point) continue;
          if (document.elementFromPoint(point.x, point.y) === canvas) return { cell, point };
        }
        return null;
      }, candidates),
    (value) => value !== null,
    { timeout: 10_000, label: 'a reachable cell on the canvas' },
  );
  await tapPoint(target.point.x, target.point.y);
  const sawSubmitted = await pollUntil(
    () => bottomText('[data-testid="play-pending"]'),
    (text) => text.includes('已提交'),
    { timeout: 3_000, interval: 50, label: 'the 已提交 pending bar' },
  ).then(() => true, () => false);
  if (!sawSubmitted) {
    const text = await bottomText('[data-testid="play-pending"]');
    throw new Error(`play-pending never showed 已提交; last text: ${text}`);
  }
  pass(`walk to (${target.cell.x},${target.cell.y}) submitted: pending bar showed 已提交`);

  await pollUntil(
    async () => {
      const current = await fetchState();
      return current.agent?.pos ?? null;
    },
    (pos) => pos && pos.x === target.cell.x && pos.y === target.cell.y,
    { timeout: 15_000, interval: 500, label: 'the character to reach the target cell' },
  );
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, `play-walk-${WIDTH}.png`) });
  pass(`character reached (${target.cell.x},${target.cell.y}) within 15s`);

  phase = 'menu';
  const arrived = await fetchState();
  const here = arrived.agent.pos;
  const objectAt = (x, y) => arrived.objects.find((o) => o.pos.x === x && o.pos.y === y) ?? null;
  const agentAt = (x, y) => arrived.agents.find((a) => a.pos.x === x && a.pos.y === y) ?? null;
  const adjacent = [
    { x: here.x, y: here.y - 1 },
    { x: here.x + 1, y: here.y },
    { x: here.x, y: here.y + 1 },
    { x: here.x - 1, y: here.y },
  ].filter(
    (cell) =>
      cell.x >= 0 &&
      cell.y >= 0 &&
      cell.x < terrain.width &&
      cell.y < terrain.height &&
      !objectAt(cell.x, cell.y) &&
      !agentAt(cell.x, cell.y) &&
      terrain.rows[cell.y][cell.x] !== ':',
  );
  if (adjacent.length === 0) throw new Error('no empty adjacent cell that allows building');
  const menuTarget = await pollUntil(
    () =>
      page.evaluate((list) => {
        const view = window.__looView;
        const canvas = document.querySelector('canvas.ui-canvas');
        if (!view || !canvas) return null;
        for (const cell of list) {
          const point = view.screenOfCell(cell.x, cell.y);
          if (point && document.elementFromPoint(point.x, point.y) === canvas) return { cell, point };
        }
        return null;
      }, adjacent),
    (value) => value !== null,
    { timeout: 10_000, label: 'an adjacent cell on the canvas' },
  );
  await tapPoint(menuTarget.point.x, menuTarget.point.y);
  await page.waitForSelector('[data-play-menu]', { visible: true, timeout: 5_000 });
  const menuLabels = await page.$$eval('[data-play-menu] button', (buttons) =>
    buttons.map((button) => `${button.dataset.action}:${button.textContent.trim()}`),
  );
  if (!menuLabels.some((label) => label === 'move:走过去')) throw new Error(`menu lacks 走过去: ${menuLabels}`);
  if (!menuLabels.some((label) => label === 'build-wall:建墙')) throw new Error(`menu lacks 建墙: ${menuLabels}`);
  await page.screenshot({ path: path.join(OUT, `play-menu-${WIDTH}.png`) });
  pass(`adjacent menu opened with ${menuLabels.join(', ')}`);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-play-menu]'), { timeout: 3_000 });
  pass('Esc closed the menu');

  await tapSelector('[data-testid="play-leave"]');
  await page.waitForSelector('[data-testid="play-again"]', { visible: true, timeout: 10_000 });
  pass('left the world so the entrance is free for the next run');

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  pass(`${WIDTH}-wide run finished with no page errors`);
} catch (error) {
  console.error(`FAIL at ${phase}: ${error.message}`);
  if (page) {
    await page.screenshot({ path: path.join(OUT, `play-fail-${WIDTH}.png`) }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
