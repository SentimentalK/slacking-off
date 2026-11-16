// Real end-to-end flow for the official server: register in Chrome, follow the
// one-time install command, register/join with the downloaded CLI, check the
// account page, take screenshots, regenerate and revoke the token, and prove
// the SSE stream recovers after a server restart.
//
// `scripts/e2e-full.sh` starts the server and passes every `LOO_E2E_*` value
// below. Every successful step prints `PASS: ...`; a failure exits non-zero with
// the failing step in the message.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { assertChinese } from './lib-zh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LOO_E2E_ROOT || path.resolve(HERE, '../..');
const BASE = (process.env.LOO_E2E_BASE || 'http://127.0.0.1:18086').replace(/\/+$/, '');
const DATA = process.env.LOO_E2E_DATA || path.join(ROOT, '.conductor/e4-e2e/data');
const DOWNLOADS = process.env.LOO_E2E_DOWNLOADS || path.join(ROOT, '.conductor/e4-e2e/downloads');
const CONFIG = process.env.LOO_E2E_CONFIG || path.join(ROOT, '.conductor/e4-e2e/config.json');
const SERVER = process.env.LOO_E2E_SERVER || path.join(ROOT, 'target/release/loo-server');
const LOG = process.env.LOO_E2E_LOG || path.join(ROOT, '.conductor/e4-e2e/server.log');
const PID_FILE = process.env.LOO_E2E_PID_FILE || path.join(ROOT, '.conductor/e4-e2e/server.pid');
const PORT = Number(process.env.LOO_E2E_PORT || new URL(BASE).port || 18086);
const HOME = process.env.LOO_E2E_HOME || path.join(ROOT, '.conductor/e4-e2e/home');
const BIN = process.env.LOO_E2E_BIN || path.join(ROOT, '.conductor/e4-e2e/bin');
const LOO = path.join(BIN, 'loo');
const SHOTS = path.join(ROOT, 'docs/screenshots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(message) {
  console.log(`PASS: ${message}`);
}

async function until(condition, { timeout = 10_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(interval);
  }
  throw new Error(`timeout after ${timeout}ms waiting for ${label}`);
}

function run(command, args, env = {}, { allowFail = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (!allowFail && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function runShell(script, env = {}, options) {
  return run('/bin/sh', ['-c', script], env, options);
}

async function getJSON(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { headers: { accept: 'application/json' } });
  const body = await response.json();
  return { status: response.status, body };
}

async function currentTick() {
  const { body } = await getJSON('/api/projection');
  if (!body.ok || typeof body.result?.tick !== 'number') {
    throw new Error(`/api/projection did not return a tick: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.result.tick;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
}

async function waitForHealth(timeout = 15_000) {
  await until(
    async () => {
      try {
        const response = await fetch(`${BASE}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { timeout, label: 'server healthz' },
  );
}

function serverArgs() {
  return [
    '--official',
    '--addr',
    `127.0.0.1:${PORT}`,
    '--map',
    'maps/default.txt',
    '--config',
    CONFIG,
    '--tick-seconds',
    '1',
    '--data-dir',
    DATA,
    '--downloads-dir',
    DOWNLOADS,
  ];
}

function startServer() {
  const log = fs.openSync(LOG, 'a');
  const child = spawn(SERVER, serverArgs(), {
    cwd: ROOT,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  fs.writeFileSync(PID_FILE, `${child.pid}\n`);
  // The restarted server outlives this script; the shell trap stops it by pid.
  child.unref();
  return child;
}

async function stopServer() {
  const raw = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8').trim() : '';
  if (!raw) return;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  try {
    await until(() => !processAlive(pid), { timeout: 2_500, interval: 50, label: `server ${pid} exit` });
  } catch {
    // axum's graceful shutdown waits for every open connection, and the live
    // SSE stream never ends on its own. Per-tick events are already committed,
    // so a hard stop is safe here and restart recovery continues from them.
    process.kill(pid, 'SIGKILL');
    await until(() => !processAlive(pid), { timeout: 5_000, interval: 50, label: `server ${pid} exit` });
  }
  await sleep(200);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function waitForWindow(page, key) {
  await page.waitForSelector(`.win[data-window="${key}"]`, { timeout: 10_000 });
  // The window's Escape listener and its initial focus are set up in the same
  // effect pass, so focus inside the window means the key handler is attached.
  await until(
    () => page.evaluate(() => !!document.activeElement?.closest('.win')),
    { timeout: 10_000, label: `${key} window focus` },
  );
}

async function waitForPath(page, pathname) {
  await until(async () => new URL(page.url()).pathname === pathname, {
    timeout: 10_000,
    label: `path ${pathname}`,
  });
}

async function waitForNoWindow(page, label) {
  await until(async () => (await page.$('.win')) === null, { timeout: 5_000, label });
}

async function noHorizontalScroll(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(overflow <= 1, `${label} scrolls horizontally by ${overflow}px`);
  pass(`${label} has no horizontal scroll`);
}

async function screenshot(page, name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, type: 'png' });
  const { size } = fs.statSync(file);
  assert(size > 5_000, `${name} looks blank (${size} bytes)`);
  assert(size < 1600 * 1024, `${name} is ${Math.round(size / 1024)} KB, over the 1600 KB budget`);
  pass(`screenshot ${name} (${Math.round(size / 1024)} KB)`);
}

function walkFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else files.push(full);
  }
  return files;
}

function sourceContains(dir, needle) {
  return walkFiles(dir).find((file) => {
    try {
      return fs.readFileSync(file, 'utf8').includes(needle);
    } catch {
      return false;
    }
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  await waitForHealth();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--use-gl=angle',
      '--use-angle=gl',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('loo.quality', 'low');
    } catch {}
  });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  if (renderer === 'unknown' || /swiftshader|llvmpipe|softpipe|software/i.test(renderer)) {
    console.error(`FAIL: software renderer: ${renderer}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`PASS: browser renderer is ${renderer}`);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });

  try {
    await browser
      .defaultBrowserContext()
      .overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

    // --- negative: signed out /account -> /login ---------------------------
    await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
    await waitForPath(page, '/login');
    await page.waitForSelector('input[name=username]');
    pass('signed-out /account redirects to /login');

    // The identity probe behind the nav must not bounce public pages.
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
    await sleep(500);
    assert(
      new URL(page.url()).pathname === '/',
      `the signed-out spectator was redirected to ${page.url()}`,
    );
    const accountText = await page.$eval('[data-open="account"]', (element) => element.textContent.trim());
    assert(accountText === '登录', `the signed-out account button reads ${accountText}, expected 登录`);
    pass('public spectator stays put and the account button reads 登录');

    // --- register -----------------------------------------------------------
    const username = `e2e-${Date.now().toString(36).slice(-10)}`.slice(0, 16);
    const password = 'e2e-password-123';
    await page.click('[data-open="account"]');
    await waitForWindow(page, 'login');
    await page.click('.win[data-window="login"] a[href="/register"]');
    await waitForWindow(page, 'register');
    await page.waitForSelector('.win[data-window="register"] input[name=username]');
    await page.type('.win[data-window="register"] input[name=username]', username);
    await page.type('.win[data-window="register"] input[name=password]', password);
    await page.click('.win[data-window="register"] button[type=submit]');
    await waitForPath(page, '/account');
    await page.waitForFunction(
      (name) => document.querySelector('.win[data-window="account"] .nick')?.textContent?.includes(name),
      { timeout: 10_000 },
      username,
    );
    pass(`registered ${username} and landed on /account`);

    // --- generate the install command --------------------------------------
    await page.waitForSelector('[data-testid=token-action]');
    await page.click('[data-testid=token-action]');
    await page.waitForSelector('[data-testid=install-command]', { timeout: 10_000 });
    const shCommand = await page.$eval('[data-testid=install-command]', (element) =>
      element.textContent.trim(),
    );
    assert(shCommand.startsWith('curl '), `unexpected sh command: ${shCommand}`);
    assert(shCommand.includes('--token'), 'the sh command carries no token');
    assert(shCommand.includes('/install.sh'), 'the sh command is not the installer');
    pass('generated the one-time install command');

    // --- install through the served installer ------------------------------
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(BIN, { recursive: true });
    runShell(shCommand, { LOO_HOME: HOME, LOO_BIN_DIR: BIN });
    assert(fs.existsSync(LOO), `installer did not put loo at ${LOO}`);
    assert(fs.statSync(LOO).mode & 0o111, `${LOO} is not executable`);
    const installed = readConfig();
    assert(typeof installed.token === 'string' && installed.token.length === 64, 'config has no token');
    assert(installed.server === BASE, `config server is ${installed.server}, expected ${BASE}`);
    const downloaded = path.join(DOWNLOADS, 'loo-linux-x64');
    assert(fs.existsSync(downloaded), 'downloads/loo-linux-x64 is missing');
    pass('install command downloaded the Linux x64 binary and wrote config.json');

    // --- register an agent and join ---------------------------------------
    const registered = run(
      LOO,
      ['register', '--name', 'e2e-bot', '--model', 'e2e-model', '--intro', 'e2e intro'],
      { LOO_HOME: HOME },
    );
    assert(/created/.test(registered.stdout), `register did not report created:\n${registered.stdout}`);
    const agent = readConfig();
    assert(typeof agent.agent_id === 'number', 'register did not save agent_id');
    pass(`loo register created agent ${agent.agent_id}`);

    const joined = run(LOO, ['join', '--sent-by', 'self', '--why', 'e2e why'], { LOO_HOME: HOME });
    assert(joined.status === 0, 'loo join failed');
    pass('loo join entered the world');

    // --- account after reload: no command, token active, agent listed -----
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('[data-testid=agent-list]')?.textContent?.includes('e2e-bot'),
      { timeout: 10_000 },
    );
    assert(
      (await page.$('[data-testid=install-command]')) === null,
      'the install command survived a reload',
    );
    const tokenStatus = await page.$eval('[data-testid=token-status]', (element) =>
      element.textContent.trim(),
    );
    assert(tokenStatus === '有效', `token status after reload is ${tokenStatus}`);
    pass('reload hides the install command and still lists e2e-bot with a valid token');
    await screenshot(page, 'account-1440.png');

    // --- wait two ticks, then the live spectator --------------------------
    const beforeTicks = await currentTick();
    await until(async () => (await currentTick()) >= beforeTicks + 2, {
      timeout: 15_000,
      label: 'two server ticks',
    });
    pass(`server advanced at least two ticks (from ${beforeTicks})`);

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector('.ui-clock .live') !== null,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        if (text.includes('e2e-bot')) return true;
        const inside = document.querySelector('.ui-navr .cnt b');
        return inside !== null && Number(inside.textContent?.split('/')[0]) >= 1;
      },
      { timeout: 15_000 },
    );
    await page.waitForFunction(() => window.__looView && window.__looView.tick() >= 0, { timeout: 15_000 });
    const painted = await page.evaluate(async () => {
      const src = window.__looView.capture().png;
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonEmpty = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] || data[index + 1] || data[index + 2]) nonEmpty += 1;
      }
      return nonEmpty;
    });
    assert(painted > 0, 'the spectator canvas is blank');
    pass('live spectator shows the agent and a painted board');
    await screenshot(page, 'spectator-1440.png');

    // --- shell: deep links, history, window features -----------------------
    const boardRequests = [];
    const statsRequests = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/leaderboard')) boardRequests.push(url);
      if (url.includes('/api/stats')) statsRequests.push(url);
    });

    const deepLinks = [
      ['/leaderboard', 'leaderboard'],
      ['/stats', 'stats'],
      ['/account', 'account'],
      [`/agent/${agent.agent_id}`, 'agent'],
      ['/login', 'login'],
      ['/register', 'register'],
    ];
    for (const [route, key] of deepLinks) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
      await waitForWindow(page, key);
      await page.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
      await page.click('.win-close');
      await waitForPath(page, '/');
      await waitForNoWindow(page, `${route} closed`);
      pass(`deep link ${route} opens the ${key} window; 关闭 returns to /`);
    }

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
    await page.evaluate(() => {
      window.__looCanvas = document.querySelector('canvas');
    });
    await page.click('[data-open="leaderboard"]');
    await waitForPath(page, '/leaderboard');
    await waitForWindow(page, 'leaderboard');
    await page.goBack();
    await waitForPath(page, '/');
    await waitForNoWindow(page, 'back closes the window');
    await page.goForward();
    await waitForPath(page, '/leaderboard');
    await waitForWindow(page, 'leaderboard');
    await page.keyboard.press('Escape');
    await waitForPath(page, '/');
    await waitForNoWindow(page, 'Escape closes the window');
    const sameCanvas = await page.evaluate(() => document.querySelector('canvas') === window.__looCanvas);
    assert(sameCanvas, 'the 3D canvas element was replaced during back, forward and Escape');
    pass('back, forward and Escape move the window with the URL and keep one canvas');

    await page.goto(`${BASE}/leaderboard`, { waitUntil: 'domcontentloaded' });
    await waitForWindow(page, 'leaderboard');
    for (const kind of ['ai', 'human', 'mixed']) {
      const before = boardRequests.length;
      await page.click(`.win[data-window="leaderboard"] [data-board="${kind}"]`);
      await until(
        async () => boardRequests.slice(before).some((url) => new URL(url).searchParams.get('kind') === kind),
        { timeout: 10_000, label: `leaderboard request for kind=${kind}` },
      );
      await page.waitForFunction(
        (key) => document.querySelector(`.win[data-window="leaderboard"] [data-board="${key}"]`)?.classList.contains('on'),
        { timeout: 5_000 },
        kind,
      );
    }
    pass('leaderboard AI, 人类 and 混合 each switch and request /api/leaderboard?kind=…');
    await page.click('.win-close');
    await waitForPath(page, '/');

    await page.goto(`${BASE}/stats`, { waitUntil: 'domcontentloaded' });
    await waitForWindow(page, 'stats');
    await page.waitForSelector('.win[data-window="stats"] .tiles');
    for (const scope of ['mixed', 'all']) {
      await page.click(`.win[data-window="stats"] [data-scope="${scope}"]`);
      await page.waitForFunction(
        (key) => document.querySelector(`.win[data-window="stats"] [data-scope="${key}"]`)?.classList.contains('on'),
        { timeout: 5_000 },
        scope,
      );
    }
    pass('stats scope switches between 全部会话 and 有另一类在场');
    for (const prompt of ['on', 'off', 'any']) {
      const before = statsRequests.length;
      await page.click(`.win[data-window="stats"] [data-prompt="${prompt}"]`);
      await until(
        async () => statsRequests.slice(before).some((url) => new URL(url).searchParams.get('prompt') === prompt),
        { timeout: 10_000, label: `stats request for prompt=${prompt}` },
      );
      await page.waitForFunction(
        (key) => document.querySelector(`.win[data-window="stats"] [data-prompt="${key}"]`)?.classList.contains('on'),
        { timeout: 5_000 },
        prompt,
      );
    }
    pass('stats prompt filter 全部 / 装了提示 / 没装提示 each switch and request /api/stats?prompt=…');
    await page.click('.win-close');
    await waitForPath(page, '/');

    await page.goto(`${BASE}/agent/${agent.agent_id}`, { waitUntil: 'domcontentloaded' });
    await waitForWindow(page, 'agent');
    await page.waitForFunction(
      () => document.querySelector('.win[data-window="agent"] .nick')?.textContent?.includes('e2e-bot'),
      { timeout: 10_000 },
    );
    await page.waitForSelector('.win[data-window="agent"] table thead');
    pass('档案 window lists the session table');
    await assertChinese(page, ['.win'], '档案 window', ['e2e-bot', 'e2e-model', 'e2e intro', 'e2e why', username]);
    await page.click('.win-close');
    await waitForPath(page, '/');

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
    await page.waitForFunction(
      (id) => window.__looView?.screenOf(id) != null,
      { timeout: 15_000 },
      agent.agent_id,
    );
    const at = await page.evaluate((id) => window.__looView.screenOf(id), agent.agent_id);
    await page.mouse.click(at.x, at.y);
    await page.waitForFunction(
      () => document.querySelector('.ui-card .nick')?.firstChild?.textContent?.trim() === 'e2e-bot',
      { timeout: 5_000 },
    );
    pass('clicking the agent on the field selects it into the card');
    // The feed lists only events that arrive after the page opened.
    const moves = ['E', 'W', 'N', 'S'];
    let fed = false;
    for (let attempt = 0; attempt < 8 && !fed; attempt += 1) {
      run(LOO, ['move', moves[attempt % moves.length]], { LOO_HOME: HOME }, { allowFail: true });
      fed = await page
        .waitForSelector('.ui-feed .feed-row', { timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
    }
    assert(fed, 'the event feed stayed empty after the bot moved');
    await assertChinese(page, ['.ui-feed'], 'watch: event feed');
    await assertChinese(page, ['.ui-card'], 'watch: selected card');
    await assertChinese(page, ['.ui-bottom'], 'watch: bottom bar');
    const bottomHeight = await page.$eval(
      '.ui-bottom[data-mode="watch"]',
      (element) => element.getBoundingClientRect().height,
    );
    assert(bottomHeight < 64, `watch bottom bar is ${bottomHeight}px tall at 1440×900; expected one line`);
    pass(`watch bottom bar sits on one line at 1440×900 (${Math.round(bottomHeight)}px)`);
    await assertChinese(page, ['.ui-brand', '.ui-clock'], 'watch: top bar');

    // --- replay / profile / leaderboard / stats ---------------------------
    const tick = await currentTick();
    await page.goto(`${BASE}/replay?tick=${tick}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rp-bar .rp-track', { timeout: 15_000 });
    await page.waitForFunction(
      (want) => document.querySelector('.ui-modes .on')?.textContent?.trim() === want && window.__looView?.tick() > 0,
      { timeout: 15_000 },
      '回放',
    );
    pass('/replay opens the shell replay mode and the 3D view draws a replay frame');
    await assertChinese(page, ['.rp-bar', '.ui-feed', '.ui-clock'], 'replay: timeline, feed and clock');
    await sleep(300);
    await screenshot(page, 'replay-1440.png');

    await page.goto(`${BASE}/agent/${agent.agent_id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('.win[data-window="agent"] .nick')?.textContent?.includes('e2e-bot'),
      { timeout: 10_000 },
    );
    await screenshot(page, 'profile-1440.png');

    await page.goto(`${BASE}/leaderboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document.querySelector('.win[data-window="leaderboard"] table') ||
        document.querySelector('.win[data-window="leaderboard"]')?.innerText.includes('暂无数据'),
      { timeout: 10_000 },
    );
    await screenshot(page, 'leaderboard-1440.png');
    await assertChinese(page, ['.win'], 'leaderboard window', ['e2e-bot', 'e2e-model', 'e2e intro', 'e2e why', username]);

    await page.goto(`${BASE}/stats`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.win[data-window="stats"] .tiles', { timeout: 10_000 });
    await screenshot(page, 'stats-1440.png');
    await assertChinese(page, ['.win'], 'stats window', ['e2e-bot', 'e2e-model', 'e2e intro', 'e2e why', username]);

    // --- phone viewport ----------------------------------------------------
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector('.ui-clock .live') !== null,
      { timeout: 15_000 },
    );
    await noHorizontalScroll(page, 'spectator at 390px');
    await screenshot(page, 'spectator-390.png');

    await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=token-status]', { timeout: 10_000 });
    await noHorizontalScroll(page, 'account at 390px');
    await screenshot(page, 'account-390.png');

    // --- regenerate: old command gone, new one copyable -------------------
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('[data-testid=token-action]')?.textContent?.includes('重新生成'),
      { timeout: 10_000 },
    );
    await assertChinese(page, ['.win'], 'account window', ['e2e-bot', 'e2e-model', 'e2e intro', 'e2e why', username]);
    const oldConfig = readConfig();
    await page.click('[data-testid=token-action]');
    await page.waitForSelector('[data-testid=install-command]', { timeout: 10_000 });
    const newCommand = await page.$eval('[data-testid=install-command]', (element) =>
      element.textContent.trim(),
    );
    assert(newCommand !== shCommand, 'regenerating returned the same install command');
    assert(!newCommand.includes(oldConfig.token), 'the new command still carries the old token');
    const oldVisible = await page.evaluate(
      (old) => document.body.textContent.includes(old),
      shCommand,
    );
    assert(!oldVisible, 'the old install command is still on the page');
    await page.click('[data-testid=copy-command]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=copy-command]')?.textContent?.includes('已复制'),
      { timeout: 5_000 },
    );
    pass('regenerate replaced the old command and the new command copies');

    // The regenerated token revoked the first one: the old LOO_HOME still
    // carries it, so status must fail before clicking revoke.
    const stale = run(LOO, ['status'], { LOO_HOME: HOME }, { allowFail: true });
    assert(stale.status === 2, `loo status with the replaced token exited ${stale.status}, expected 2`);
    pass('regenerating invalidated the previous token');

    // Install the new command, then attach the same nick to it: the new token
    // must work (status exits 0) until we revoke it.
    runShell(newCommand, { LOO_HOME: HOME, LOO_BIN_DIR: BIN });
    const attached = run(
      LOO,
      ['register', '--name', 'e2e-bot', '--model', 'e2e-model', '--intro', 'e2e intro'],
      { LOO_HOME: HOME },
    );
    assert(/attached/.test(attached.stdout), `expected attached, got:\n${attached.stdout}`);
    assert(readConfig().agent_id === agent.agent_id, 'attach changed the agent id');
    const fresh = run(LOO, ['status'], { LOO_HOME: HOME }, { allowFail: true });
    assert(fresh.status === 0, `loo status with the new token exited ${fresh.status}, expected 0`);
    pass('the new token works before revocation');

    // --- revoke: CLI must exit 2 with an authentication message -----------
    await page.click('[data-testid=revoke-token]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=token-status]')?.textContent?.includes('已吊销'),
      { timeout: 10_000 },
    );
    const revoked = run(LOO, ['status'], { LOO_HOME: HOME }, { allowFail: true });
    assert(revoked.status === 2, `loo status after revoke exited ${revoked.status}, expected 2`);
    assert(
      /token|鉴权|401|not authenticated/i.test(revoked.stderr),
      `revoked status stderr has no authentication hint:\n${revoked.stderr}`,
    );
    pass('revoked token makes loo status exit 2 with an authentication message');

    // --- SSE reconnect after a server restart -----------------------------
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('.ui-clock .live') !== null,
      { timeout: 15_000 },
    );
    const tickBeforeRestart = await currentTick();
    await stopServer();
    const restarted = startServer();
    assert(restarted.pid, 'restart did not produce a pid');
    await waitForHealth();
    // A restarted server starts with an empty field, which the shell shows as
    // the replay loop. Re-attach the same agent through the account window so
    // the live projection, and with it the live TICK, comes back.
    await page.click('[data-open="account"]');
    await waitForWindow(page, 'account');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=token-status]')?.textContent?.includes('已吊销'),
      { timeout: 15_000 },
    );
    await page.click('[data-testid=token-action]');
    await page.waitForSelector('[data-testid=install-command]', { timeout: 10_000 });
    const rejoinCommand = await page.$eval('[data-testid=install-command]', (element) =>
      element.textContent.trim(),
    );
    runShell(rejoinCommand, { LOO_HOME: HOME, LOO_BIN_DIR: BIN });
    const reattached = run(
      LOO,
      ['register', '--name', 'e2e-bot', '--model', 'e2e-model', '--intro', 'e2e intro'],
      { LOO_HOME: HOME },
    );
    assert(/attached/.test(reattached.stdout), `expected attached after restart, got:\n${reattached.stdout}`);
    const restored = JSON.parse(run(LOO, ['--json', 'status'], { LOO_HOME: HOME }).stdout).state;
    if (restored?.placement === 'inside' || restored?.placement === 'waiting') {
      assert(run(LOO, ['leave'], { LOO_HOME: HOME }).status === 0, 'loo leave of the session restored from the snapshot failed');
    }
    assert(run(LOO, ['join', '--sent-by', 'self', '--why', 'e2e why'], { LOO_HOME: HOME }).status === 0, 'loo join after restart failed');
    await page.click('.win-close');
    await waitForPath(page, '/');
    await waitForNoWindow(page, 'account closed after restart');
    await page.waitForFunction(
      (before) => {
        const big = document.querySelector('.ui-clock .big');
        const tick = big ? Number(big.textContent.replace(/\D/g, '')) : 0;
        return document.querySelector('.ui-clock .countdown') !== null && tick > before;
      },
      { timeout: 30_000 },
      tickBeforeRestart,
    );
    pass('SSE reconnected after restart and the tick continued growing');

    // --- static invariants -------------------------------------------------
    assert(
      sourceContains(path.join(ROOT, 'web/dist'), 'fonts.googleapis.com') === undefined,
      'web/dist references fonts.googleapis.com',
    );
    assert(
      sourceContains(path.join(ROOT, 'crates/server'), 'fonts.googleapis.com') === undefined,
      'crates/server references fonts.googleapis.com',
    );
    assert(
      sourceContains(path.join(ROOT, 'web/src'), 'dangerouslySetInnerHTML') === undefined,
      'web/src uses dangerouslySetInnerHTML',
    );
    pass('no Google Fonts reference and no dangerouslySetInnerHTML');

    const rootResponse = await fetch(`${BASE}/`);
    const rootHtml = await rootResponse.text();
    assert(rootResponse.headers.get('content-type')?.startsWith('text/html'), 'GET / is not HTML');
    assert(rootResponse.headers.get('cache-control') === 'no-cache', 'index.html is not no-cache');
    assert(rootHtml.includes('<div id="root">'), 'GET / is not the SPA');
    const assetPath = /\/assets\/[^"']+\.js/.exec(rootHtml)?.[0];
    assert(assetPath, 'index.html has no hashed JS asset');
    const assetResponse = await fetch(`${BASE}${assetPath}`);
    assert(assetResponse.status === 200, `${assetPath} returned ${assetResponse.status}`);
    assert(
      assetResponse.headers.get('content-type')?.startsWith('text/javascript'),
      `${assetPath} has the wrong Content-Type`,
    );
    assert(
      assetResponse.headers.get('cache-control')?.includes('immutable'),
      `${assetPath} is missing the immutable cache`,
    );
    const apiMissing = await fetch(`${BASE}/api/nope`);
    assert(apiMissing.status === 404, `/api/nope returned ${apiMissing.status}`);
    assert(
      apiMissing.headers.get('content-type')?.startsWith('application/json'),
      '/api/nope did not return JSON',
    );
    pass('SPA, hashed asset caching and JSON API 404 are served from the binary');

    assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join(' | ')}`);
    pass('no uncaught browser errors');
    console.log('PASS: full end-to-end flow completed');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
