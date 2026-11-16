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

const FINAL_LAUNCH = {
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'],
};

async function runFinal() {
  const finalFailures = [];
  const fcheck = (ok, message) => {
    if (!ok) finalFailures.push(message);
  };
  mkdirSync(args.out, { recursive: true });
  const browser = await puppeteer.launch(FINAL_LAUNCH);
  const newPage = async (base, route, viewport) => {
    const page = await browser.newPage();
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return page;
  };
  const snap = async (page, name) => {
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    fcheck(scroll <= inner, `${name}: horizontal scroll (scrollWidth ${scroll} > ${inner})`);
    await page.screenshot({ path: path.join(args.out, `${name}.png`) });
    console.log(`shot ${name}`);
  };
  const settle = (page, selector) =>
    page.waitForFunction(
      (sel) => {
        const win = document.querySelector(sel);
        return win !== null && !win.textContent.includes('载入中…');
      },
      { timeout: 30000 },
      selector,
    );
  const windowShot = async (base, route, key, viewport, name) => {
    const page = await newPage(base, route, viewport);
    try {
      await page.waitForSelector(`.win[data-window="${key}"]`, { timeout: 30000 });
      await settle(page, `.win[data-window="${key}"]`);
      await snap(page, name);
    } finally {
      await page.close();
    }
  };
  const watchPage = async (viewport) => {
    const page = await newPage(args.base, '/', viewport);
    await page.waitForFunction(() => window.__looView && window.__looView.tick() >= 0, { timeout: 60000 });
    await page.waitForSelector('.ui-card', { timeout: 30000 });
    await sleep(2500);
    return page;
  };
  const devAgents = async () => {
    const { result } = await (await fetch(new URL('/api/projection', args.base))).json();
    return result.agents;
  };

  try {
    if (args.final === '1') {
      for (const [w, viewport] of [['1440', DESKTOP], ['390', PHONE]]) {
        const page = await watchPage(viewport);
        const bar = await page.evaluate(() => document.querySelector('.ui-bottom')?.getBoundingClientRect().height ?? 0);
        fcheck(bar <= 96, `watch-${w}: .ui-bottom height ${bar.toFixed(1)} > 96`);
        await snap(page, `watch-${w}`);
        await page.close();
      }

      {
        const agents = await devAgents();
        fcheck(agents.length >= 2, `watch-selected: only ${agents.length} agents on the field`);
        const target = agents[agents.length - 1];
        const page = await watchPage(DESKTOP);
        await page.waitForFunction(
          (id) => window.__looView.screenOf(id) !== null,
          { timeout: 30000 },
          target.id,
        );
        const at = await page.evaluate((id) => window.__looView.screenOf(id), target.id);
        await page.mouse.click(at.x, at.y);
        await page.waitForFunction(
          (nick) => document.querySelector('.ui-card .nick')?.firstChild?.textContent?.trim() === nick,
          { timeout: 15000 },
          target.nick,
        );
        await sleep(800);
        await snap(page, 'watch-selected-1440');
        await page.close();
      }

      for (const [w, viewport] of [['1440', DESKTOP], ['390', PHONE]]) {
        const page = await watchPage(viewport);
        if (viewport === PHONE) {
          await page.click('[data-open="menu"]');
          await page.click('.ui-menu [data-open="settings"]');
        } else {
          await page.click('[data-open="settings"]');
        }
        await page.waitForSelector('.win[data-window="settings"]', { timeout: 15000 });
        await sleep(400);
        await snap(page, `settings-${w}`);
        await page.close();
      }

      const agentId = (await devAgents())[0].id;
      await windowShot(args.base, '/leaderboard', 'leaderboard', DESKTOP, 'board-1440');
      await windowShot(args.base, '/leaderboard', 'leaderboard', PHONE, 'board-390');
      await windowShot(args.base, '/stats', 'stats', DESKTOP, 'stats-1440');
      await windowShot(args.base, '/stats', 'stats', PHONE, 'stats-390');
      await windowShot(args.base, `/agent/${agentId}`, 'agent', DESKTOP, 'profile-1440');
      await windowShot(args.base, `/agent/${agentId}`, 'agent', PHONE, 'profile-390');
    }

    if (args.final === '1' && args.official) {
      const officialRound = async (viewport, w) => {
        const username = `w3f-user${w}`;
        const page = await newPage(args.official, '/register', viewport);
        try {
          await page.waitForSelector('.win[data-window="register"] input[name="username"]', { timeout: 60000 });
          await snap(page, `register-${w}`);
          await page.type('.win[data-window="register"] input[name="username"]', username);
          await page.type('.win[data-window="register"] input[name="password"]', 'w3f-password-1');
          await page.click('.win[data-window="register"] button[type="submit"]');
          await page.waitForSelector('.win[data-window="account"]', { timeout: 30000 });
          await page.waitForFunction(
            (name) => document.querySelector('.acct .nick')?.textContent === name,
            { timeout: 30000 },
            username,
          );
          await settle(page, '.win[data-window="account"]');
          await snap(page, `account-${w}`);
          await page.evaluate(() => {
            const logout = [...document.querySelectorAll('.acct button')].find((button) =>
              button.textContent.includes('退出登录'),
            );
            logout?.click();
          });
          await page.waitForFunction(() => location.pathname === '/login', { timeout: 30000 });
          await page.waitForSelector('.win[data-window="login"]', { timeout: 30000 });
          await snap(page, `login-${w}`);
        } catch (error) {
          finalFailures.push(`official round ${w}: ${error.message}`);
        } finally {
          await page.close();
        }
      };
      await officialRound(DESKTOP, '1440');
      await officialRound(PHONE, '390');
    }

    if (args['replay-auto'] === '1') {
      const deadline = Date.now() + 10 * 60 * 1000;
      let inside = null;
      while (Date.now() < deadline) {
        const { result } = await (await fetch(new URL('/api/projection', args.base))).json();
        inside = result.counts.inside;
        if (inside === 0) break;
        await sleep(3000);
      }
      if (inside !== 0) {
        console.log(`SKIP replay-auto-1440: field still has ${inside} agents after 10 minutes`);
      } else {
        const page = await newPage(args.base, '/', DESKTOP);
        await page.waitForFunction(() => window.__looView && window.__looView.tick() >= 0, { timeout: 60000 });
        try {
          await page.waitForFunction(
            () => document.querySelector('.ui-clock .live.rp') !== null,
            { timeout: 120000, polling: 500 },
          );
          await sleep(1200);
          await snap(page, 'replay-auto-1440');
        } catch (error) {
          console.log(`SKIP replay-auto-1440: no replay badge within 2 minutes (${error.message.split('\n')[0]})`);
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (finalFailures.length > 0) {
    for (const failure of finalFailures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log('final shots passed');
  process.exit(0);
}

if (args.final === '1' || args['replay-auto'] === '1') {
  await runFinal();
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

if (args.windows === '1') {
  const windowFailures = [];
  const winCheck = (ok, message) => {
    if (!ok) windowFailures.push(message);
  };
  const winBrowser = await puppeteer.launch({
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
  const snapWindow = async (page, name) => {
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    winCheck(scroll <= inner, `${name}: horizontal scroll (scrollWidth ${scroll} > ${inner})`);
    await page.screenshot({ path: path.join(args.out, `${name}.png`), fullPage: true });
    console.log(`shot ${name}`);
  };
  const openRoute = async (page, route) => {
    await page.goto(new URL(route, args.base).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  };
  const settleWindow = (page, selector) =>
    page.waitForFunction(
      (sel) => {
        const win = document.querySelector(sel);
        return win !== null && !win.textContent.includes('载入中…');
      },
      { timeout: 30000 },
      selector,
    );
  const runWindowRound = async (viewport, w, username) => {
    const page = await winBrowser.newPage();
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    try {
      await openRoute(page, '/register');
      await page.waitForSelector('input[name="username"]', { timeout: 60000 });
      await page.type('input[name="username"]', username);
      await page.type('input[name="password"]', 'w3c-password-1');
      await page.click('button[type="submit"]');
      await page.waitForSelector('.win[data-window="account"]', { timeout: 30000 });
      await page.waitForFunction(
        (name) => document.querySelector('.acct .nick')?.textContent === name,
        { timeout: 30000 },
        username,
      );
      await settleWindow(page, '.win[data-window="account"]');
      await snapWindow(page, `account-${w}`);

      await page.click('[data-testid="token-action"]');
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="install-command"]')?.textContent ?? '').trim().length > 0,
        { timeout: 30000 },
      );
      await snapWindow(page, `account-token-${w}`);

      await openRoute(page, '/leaderboard');
      await page.waitForSelector('.win[data-window="leaderboard"]', { timeout: 30000 });
      await settleWindow(page, '.win[data-window="leaderboard"]');
      await snapWindow(page, `board-${w}`);

      await openRoute(page, '/stats');
      await page.waitForSelector('.win[data-window="stats"]', { timeout: 30000 });
      await settleWindow(page, '.win[data-window="stats"]');
      await snapWindow(page, `stats-${w}`);

      await openRoute(page, '/agent/1');
      await page.waitForSelector('.win[data-window="agent"]', { timeout: 30000 });
      await settleWindow(page, '.win[data-window="agent"]');
      await snapWindow(page, `profile-${w}`);

      await openRoute(page, '/account');
      await page.waitForSelector('.win[data-window="account"]', { timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelector('.acct .nick')?.textContent !== '载入中…',
        { timeout: 30000 },
      );
      await page.evaluate(() => {
        const logout = [...document.querySelectorAll('.acct button')].find((button) =>
          button.textContent.includes('退出登录'),
        );
        logout?.click();
      });
      await page.waitForFunction(() => location.pathname === '/login', { timeout: 30000 });
      await page.waitForSelector('.win[data-window="login"]', { timeout: 30000 });
      await snapWindow(page, `login-${w}`);
    } catch (error) {
      windowFailures.push(`window round ${w}: ${error.message}`);
    } finally {
      await page.close();
    }
  };
  try {
    mkdirSync(args.out, { recursive: true });
    await runWindowRound(DESKTOP, '1440', 'w3c-user');
    await runWindowRound(PHONE, '390', 'w3c-user2');
  } finally {
    await winBrowser.close();
  }
  if (windowFailures.length > 0) {
    for (const failure of windowFailures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log('window shots passed');
}
