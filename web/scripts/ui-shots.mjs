import { mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['base', 'out']) {
  if (!args[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}

const CHROME = '/usr/bin/google-chrome';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SHOTS = [
  { name: 'shell-watch-1440', route: '/', viewport: DESKTOP, card: true },
  { name: 'shell-watch-390', route: '/', viewport: PHONE, card: false },
  { name: 'shell-leaderboard-1440', route: '/leaderboard', viewport: DESKTOP, card: true },
  { name: 'shell-leaderboard-390', route: '/leaderboard', viewport: PHONE, card: false },
  { name: 'shell-ui0-1440', route: '/?ui=0', viewport: DESKTOP, card: false },
];
const WATCH_SELECTORS = ['.ui-brand', '.ui-clock', '.ui-modes', '.ui-navr', '.ui-feed', '.ui-bottom[data-mode="watch"]'];

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPage(browser, route, viewport) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await page.goto(new URL(route, args.base).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__looView && window.__looView.tick() >= 0, { timeout: 60000 });
  return page;
}

async function checkLayout(page, label) {
  const result = await page.evaluate(() => {
    const inner = window.innerWidth;
    const scroll = document.documentElement.scrollWidth;
    const outside = [];
    for (const el of document.querySelectorAll('.shell [class*="ui-"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.left < -0.5 || rect.right > inner + 0.5) outside.push(el.className || el.tagName);
    }
    return { inner, scroll, outside };
  });
  check(result.scroll <= result.inner, `${label}: horizontal scroll (scrollWidth ${result.scroll} > ${result.inner})`);
  check(result.outside.length === 0, `${label}: ui elements outside viewport: ${result.outside.join(', ')}`);
}

async function shoot(browser, shot) {
  const page = await openPage(browser, shot.route, shot.viewport);
  await sleep(2000);
  if (shot.route === '/') {
    for (const selector of WATCH_SELECTORS) {
      const found = await page.$(selector);
      check(found !== null, `${shot.name}: missing ${selector}`);
    }
    if (shot.card) {
      const card = await page.$('.ui-card');
      check(card !== null, `${shot.name}: missing .ui-card`);
    }
    if (shot.viewport.width === PHONE.width) {
      await page.waitForSelector('.ui-card.sel', { timeout: 30000 });
      const geometry = await page.evaluate(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
        };
        return { card: box(document.querySelector('.ui-card')), bar: box(document.querySelector('.ui-bottom')) };
      });
      const { card, bar } = geometry;
      check(card.height <= 56, `${shot.name}: .ui-card height ${card.height.toFixed(1)} > 56`);
      check(bar.height <= 96, `${shot.name}: .ui-bottom height ${bar.height.toFixed(1)} > 96`);
      const overlap = card.left < bar.right && card.right > bar.left && card.top < bar.bottom && card.bottom > bar.top;
      check(!overlap, `${shot.name}: .ui-card and .ui-bottom bounding boxes overlap`);
    }
  }
  if (shot.route === '/leaderboard') {
    const win = await page.$('.win[data-window="leaderboard"]');
    check(win !== null, `${shot.name}: missing .win[data-window="leaderboard"]`);
  }
  await checkLayout(page, shot.name);
  const file = path.join(args.out, `${shot.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  console.log(`shot ${file}`);
}

async function cardToggleFlow(browser) {
  const page = await openPage(browser, '/', PHONE);
  await page.waitForSelector('.ui-card.sel', { timeout: 30000 });
  const archiveVisible = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.ui-card button')).some(
        (b) => b.textContent.trim() === '看档案' && b.getBoundingClientRect().height > 0,
      ),
    );
  check(!(await archiveVisible()), 'card toggle: 看档案 visible before expanding');
  await page.click('[data-card-toggle]');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.ui-card button')).some(
        (b) => b.textContent.trim() === '看档案' && b.getBoundingClientRect().height > 0,
      ),
    { timeout: 5000 },
  );
  check(await archiveVisible(), 'card toggle: 看档案 not visible after expanding');
  await page.close();
}

async function windowFlow(browser) {
  const page = await openPage(browser, '/', DESKTOP);
  await page.evaluate(() => {
    window.__canvasRef = document.querySelector('canvas');
  });
  const sameCanvas = () => page.evaluate(() => document.querySelector('canvas') === window.__canvasRef);
  const stepAt = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
  };

  await stepAt('open', () => page.click('[data-open="leaderboard"]'));
  await stepAt('open waits for window', () =>
    page.waitForSelector('.win[data-window="leaderboard"]', { timeout: 10000 }),
  );
  check((await page.evaluate(() => location.pathname)) === '/leaderboard', 'flow: URL is not /leaderboard after open');
  check(await sameCanvas(), 'flow: canvas replaced on open');

  await stepAt('close click', () => page.click('.win-close'));
  await stepAt('close waits for root', () =>
    page.waitForFunction(() => location.pathname === '/' && !document.querySelector('.win'), { timeout: 10000 }),
  );
  check(await sameCanvas(), 'flow: canvas replaced on close');

  await stepAt('back', () => page.goBack());
  await stepAt('back waits for window', () =>
    page.waitForSelector('.win[data-window="leaderboard"]', { timeout: 10000 }),
  );
  check(await sameCanvas(), 'flow: canvas replaced on back');

  await stepAt('esc', () => page.keyboard.press('Escape'));
  await stepAt('esc waits for close', () =>
    page.waitForFunction(() => !document.querySelector('.win'), { timeout: 10000 }),
  );
  check(await sameCanvas(), 'flow: canvas replaced on Esc');
  await page.close();
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--use-angle=gl',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
  ],
});

try {
  mkdirSync(args.out, { recursive: true });
  for (const shot of SHOTS) {
    try {
      await shoot(browser, shot);
    } catch (error) {
      failures.push(`${shot.name}: ${error.message}`);
    }
  }
  try {
    await cardToggleFlow(browser);
  } catch (error) {
    failures.push(`card toggle flow: ${error.message}`);
  }
  try {
    await windowFlow(browser);
  } catch (error) {
    failures.push(`window flow: ${error.message}`);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('all ui assertions passed');
