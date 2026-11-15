// Real-Chrome end-to-end for the human `/play` page: register in Chrome, take
// the served install command, register an AI agent, create the human character,
// join, walk to the nearest toilet with the keyboard, close its door, use it and
// score, while the same world's CLI agent is seen by both sides, bumps into the
// human, attacks, and the `/play` data plane is checked for 9×9 leakage. Then
// the human/mixed/AI boards, the mixed stats scope, the 390-wide round and the
// seven screenshots in `docs/screenshots/`.
//
// `scripts/e2e-play.sh` starts the official server and passes the `LOO_PLAY_*`
// values read below. Every successful step prints `PASS: ...`; a failure exits
// non-zero with the failing phase and a page/API summary.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LOO_PLAY_ROOT || path.resolve(HERE, '../..');
const BASE = (process.env.LOO_PLAY_BASE || 'http://127.0.0.1:18131').replace(/\/+$/, '');
const J = process.env.LOO_PLAY_J || path.join(ROOT, '.conductor/j');
const DOWNLOADS = process.env.LOO_PLAY_DOWNLOADS || path.join(J, 'downloads');
const HOME = process.env.LOO_PLAY_HOME || path.join(J, 'home');
const BIN = process.env.LOO_PLAY_BIN || path.join(J, 'bin');
const CHROME_DIR = process.env.LOO_PLAY_CHROME || path.join(J, 'chrome');
const LOG = process.env.LOO_PLAY_LOG || path.join(J, 'server.log');
const LOO = path.join(BIN, 'loo');
const SHOTS = path.join(ROOT, 'docs/screenshots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const USERNAME = 'play-e2e';
const PASSWORD = 'play-e2e-password-123';
const HUMAN_NICK = 'e2e-human';
const AI_NICK = 'e2e-ai';
const NEED_AT = { x: 13, y: 10 };
const DOOR_AT = { x: 13, y: 11 };
const ENTRANCE = { x: 6, y: 15 };
/** Ticks we want left when a round starts: 12 steps + door + use fit easily. */
const ROUND_TICKS_REQUIRED = 44;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let currentPhase = 'startup';
let browser = null;
let page = null;

function phase(name) {
  currentPhase = name;
}

function pass(message) {
  console.log(`PASS: ${message}`);
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

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
}

function cliStatus() {
  const result = run(LOO, ['--json', 'status'], { LOO_HOME: HOME });
  return JSON.parse(result.stdout);
}

function cliPos() {
  const status = cliStatus();
  const pos = status.state?.pos;
  return pos ? { x: pos.x, y: pos.y } : null;
}

function cliEvents() {
  return (cliStatus().events ?? []).map((event) => event.text).join('\n');
}

/** Wait until the CLI's last response satisfies `predicate(state, envelope)`. */
function waitCli(predicate, label, timeout = 8_000) {
  return until(
    () => {
      const envelope = cliStatus();
      return predicate(envelope.state, envelope) ? envelope : null;
    },
    { timeout, interval: 600, label },
  );
}

async function screenshot(target, name, tick, note = '', { fullPage = false } = {}) {
  const file = path.join(SHOTS, name);
  await target.screenshot({ path: file, type: 'png', fullPage });
  const { size } = fs.statSync(file);
  assert(size > 5_000, `${name} looks blank (${size} bytes)`);
  assert(size < 1600 * 1024, `${name} is ${Math.round(size / 1024)} KB, over the 1600 KB budget`);
  const viewport = target.viewport();
  console.log(
    `SHOT: ${name} tick=${tick} viewport=${viewport?.width ?? '?'}x${viewport?.height ?? '?'}${
      note ? ` (${note})` : ''
    }`,
  );
  pass(`screenshot ${name} (${Math.round(size / 1024)} KB, tick ${tick})`);
}

// --- the page-side recorder ------------------------------------------------
//
// The Play page polls `/api/play/state` once a second. Recording those same
// responses lets the test read a tick, a position and the page's own event
// stream without spending the human's rate budget on extra requests; recorded
// request URLs also prove /play never touches the spectator endpoints.

async function installRecorder(target) {
  await target.evaluateOnNewDocument(() => {
    const state = { states: [], urls: [], moves: [], actions: [], moveSeq: 0 };
    window.__e2e = state;
    const original = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      state.urls.push(url);
      if (state.urls.length > 400) state.urls.shift();
      const response = await original.apply(this, arguments);
      try {
        if (url.includes('/api/play/state')) {
          response
            .clone()
            .json()
            .then((body) => {
              if (body && body.ok && body.result) {
                state.states.push({ at: Date.now(), body });
                if (state.states.length > 160) state.states.shift();
              }
            })
            .catch(() => {});
        }
        if (url.includes('/api/play/') && init?.method === 'POST') {
          response
            .clone()
            .json()
            .then((body) => {
              state.actions.push({ at: Date.now(), url, status: response.status, body });
              if (state.actions.length > 80) state.actions.shift();
            })
            .catch(() => {});
        }
        if (url.includes('/api/play/move')) {
          response
            .clone()
            .json()
            .then((body) => {
              state.moves.push({
                seq: ++state.moveSeq,
                at: Date.now(),
                status: response.status,
                ok: body?.ok === true,
                retryAfter: body?.error?.retry_after_seconds ?? null,
                error: body?.error?.message ?? null,
              });
              if (state.moves.length > 80) state.moves.shift();
            })
            .catch(() => {});
        }
      } catch {
        // A clone failure must never break the app's own request.
      }
      return response;
    };
  });
}

async function playSnap(target = page) {
  return target.evaluate(() => {
    const list = window.__e2e?.states;
    return list && list.length > 0 ? list[list.length - 1] : null;
  });
}

async function waitPlay(predicate, label, timeout = 12_000) {
  let last = null;
  return until(
    async () => {
      last = await playSnap();
      return last && predicate(last.body.result, last.body) ? last : null;
    },
    { timeout, interval: 100, label },
  );
}

async function pageEventsText(target = page) {
  return target.evaluate(() => {
    const element = document.querySelector('[data-testid=play-events]');
    return element ? element.textContent ?? '' : '';
  });
}

/**
 * Wait for a visible button and click it. `page.click` re-queries the selector,
 * so a Preact re-render cannot leave a detached handle behind; the DOM click is
 * only a fallback for a button a sticky bar overlaps at 390 px.
 */
async function safeClick(selector, timeout = 5_000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  try {
    await page.click(selector);
  } catch {
    await page.evaluate((wanted) => {
      const element = document.querySelector(wanted);
      if (!element) throw new Error(`${wanted} disappeared`);
      element.click();
    }, selector);
  }
}

async function joinRound() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const snap = await playSnap();
    const placement = snap?.body?.result?.placement ?? null;
    if (placement === 'inside') return snap;
    if (placement === 'waiting') {
      console.log(`  join attempt ${attempt}: the human is still queued; leaving and retrying`);
      await leaveRound();
      await sleep(800);
    }
    const hasJoin = await page.$('[data-testid=play-join]');
    if (hasJoin) {
      await safeClick('[data-testid=play-join]');
    } else if (await page.$('[data-testid=play-again]')) {
      await safeClick('[data-testid=play-again]');
    }
    try {
      return await waitPlay((state) => state.placement === 'inside', 'inside placement', 10_000);
    } catch (error) {
      console.log(`  join attempt ${attempt} did not reach inside: ${error.message}`);
      const latest = await playSnap();
      if (latest?.body?.result?.placement === 'waiting') {
        await leaveRound();
      }
      // A transient 429 or a lost response leaves the page without a fresh
      // state; a reload re-runs loadMe and the poll loop.
      await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
      await sleep(1_500);
      const after = await playSnap();
      if (after?.body?.result?.placement === 'inside') return after;
      await page.waitForSelector('[data-testid=play-join]', { visible: true, timeout: 10_000 }).catch(() => {});
    }
  }
  throw new Error('could not get the human inside after three attempts');
}

async function leaveRound() {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const snap = await playSnap();
    if (snap && !snap.body.result.joined) return;
    await safeClick('[data-testid=play-leave]');
    try {
      await waitPlay((state) => !state.joined, 'left the world', 6_000);
      return;
    } catch (error) {
      console.log(`  leave attempt ${attempt} did not take effect: ${error.message}`);
      await sleep(2_000);
    }
  }
  const snap = await playSnap();
  if (snap && !snap.body.result.joined) return;
  throw new Error('the leave command did not end the session after four attempts');
}

/**
 * Draw a round's deadline until it is long enough for the scripted walk, then
 * return the accepted state. The server's rule is untouched; a rejected draw is
 * simply left and re-drawn.
 */
async function joinWithRoom(label) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const snap = await joinRound();
    const state = snap.body.result;
    const remaining = (state.agent?.deadline_tick ?? 0) - state.tick;
    if (remaining >= ROUND_TICKS_REQUIRED) {
      pass(`${label}: joined with ${remaining} ticks of deadline left`);
      return snap;
    }
    console.log(`  ${label}: deadline draw ${remaining} ticks is too short; leaving (try ${attempt})`);
    await leaveRound();
    await sleep(250);
  }
  throw new Error(`${label}: eight deadline draws were all shorter than ${ROUND_TICKS_REQUIRED} ticks`);
}

function stepPos(pos, key) {
  if (key === 'ArrowRight') return { x: pos.x + 1, y: pos.y };
  if (key === 'ArrowLeft') return { x: pos.x - 1, y: pos.y };
  if (key === 'ArrowUp') return { x: pos.x, y: pos.y - 1 };
  if (key === 'ArrowDown') return { x: pos.x, y: pos.y + 1 };
  throw new Error(`unknown key ${key}`);
}

/** Press one movement key and wait for its `/api/play/move` response. */
async function pressMove(key) {
  const before = await page.evaluate(() => window.__e2e.moves.length);
  await page.keyboard.press(key);
  const record = await until(
    async () => {
      const moves = await page.evaluate(() => window.__e2e.moves);
      return moves.length > before ? moves[moves.length - 1] : null;
    },
    { timeout: 4_000, interval: 40, label: `move response for ${key}` },
  );
  if (record.status === 429) {
    const waitMs = Math.max(1_000, Math.round((record.retryAfter ?? 1) * 1_000));
    await sleep(waitMs);
    return null;
  }
  assert(record.ok, `page move ${key} was rejected: ${record.error ?? `HTTP ${record.status}`}`);
  return record;
}

/** A state snapshot strictly newer than `after` ms, so it saw the last tick. */
async function freshSnap(after, label = 'a fresh play state', timeout = 4_000) {
  return until(
    async () => {
      const snap = await playSnap();
      return snap && snap.at > after ? snap : null;
    },
    { timeout, interval: 100, label },
  );
}

/** The permanent action bar: its state, its one-line text, page overflow. */
async function actionBar() {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid=play-pending]');
    if (!bar) return null;
    return {
      state: bar.getAttribute('data-state'),
      text: (bar.textContent ?? '').replace(/\s+/g, ' ').trim(),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

/** Ticks update every 100ms from the last poll's deadline, so the DOM is fresh. */
async function domTick() {
  return page.$eval('[data-testid=play-tick]', (element) =>
    Number(element.getAttribute('data-play-tick') ?? '0'),
  );
}

/**
 * Wait for the page to paint a new tick. The poll cadence (1 s) and the tick
 * cadence (0.5 s) stay in phase, so `ms_to_next_tick` is roughly constant;
 * pressing right after a rollover is the reliable way to land just after a
 * settlement instead of just before one.
 */
async function waitTickRollover(label) {
  const from = await domTick();
  return until(async () => ((await domTick()) > from ? domTick() : null), {
    timeout: 4_000,
    interval: 20,
    label: `${label}: tick after ${from}`,
  });
}

async function walkTo(target, { takeAtStep = null } = {}) {
  let snap = await playSnap();
  let pos = { ...ENTRANCE };
  if (snap) {
    const mine = snap.body.result.agents.find((agent) => agent.id === snap.body.result.me.agent_id);
    if (mine) pos = { x: mine.pos.x, y: mine.pos.y };
  }
  let steps = 0;
  let checkedAt = 0;
  let lastMoveAt = 0;
  let guard = 0;
  while (guard < 70) {
    guard += 1;
    if (pos.x === target.x && pos.y === target.y) {
      // Confirm with a poll that saw the last settlement, then re-read the
      // server's position; a lost step is corrected rather than guessed.
      const fresh = await freshSnap(lastMoveAt + 550, `arrival at ${target.x},${target.y}`);
      const mine = fresh.body.result.agents.find(
        (agent) => agent.id === fresh.body.result.me.agent_id,
      );
      if (mine && mine.pos.x === target.x && mine.pos.y === target.y) break;
      if (mine) {
        console.log(`  walk correction: expected ${target.x},${target.y}, server says ${mine.pos.x},${mine.pos.y}`);
        pos = { x: mine.pos.x, y: mine.pos.y };
      }
      continue;
    }
    if (steps > 40) {
      throw new Error(`walk to ${target.x},${target.y} took too many steps from ${pos.x},${pos.y}`);
    }
    let key;
    if (pos.x < target.x) key = 'ArrowRight';
    else if (pos.x > target.x) key = 'ArrowLeft';
    else if (pos.y > target.y) key = 'ArrowUp';
    else key = 'ArrowDown';
    const record = await pressMove(key);
    if (!record) continue;
    pos = stepPos(pos, key);
    lastMoveAt = record.at;
    steps += 1;
    if (takeAtStep && steps === 2) {
      const shotSnap = await playSnap();
      if (shotSnap) await takeAtStep(shotSnap);
    }
    await sleep(620);

    if (steps - checkedAt >= 5) {
      const fresh = await freshSnap(lastMoveAt + 550, 'a poll after five steps');
      const mine = fresh.body.result.agents.find(
        (agent) => agent.id === fresh.body.result.me.agent_id,
      );
      if (mine && (mine.pos.x !== pos.x || mine.pos.y !== pos.y)) {
        console.log(`  walk correction: expected ${pos.x},${pos.y}, server says ${mine.pos.x},${mine.pos.y}`);
        pos = { x: mine.pos.x, y: mine.pos.y };
      }
      checkedAt = steps;
    }
  }
  if (guard >= 70) throw new Error(`walk to ${target.x},${target.y} did not converge`);
  pass(`walked the keyboard path to the toilet at ${target.x},${target.y} in ${steps} steps`);
}

/** Click the centre of a cell in the 9×9 board, using the page's own window. */
async function clickCell(cell) {
  const point = await page.evaluate(async (wanted) => {
    const canvas = document.querySelector('[data-testid=play-board]');
    canvas.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const list = window.__e2e.states;
    const state = list[list.length - 1].body.result;
    const rect = canvas.getBoundingClientRect();
    const cellWidth = rect.width / state.window.width;
    return {
      x: rect.left + (wanted.x - state.window.origin.x + 0.5) * cellWidth,
      y: rect.top + (wanted.y - state.window.origin.y + 0.5) * cellWidth,
    };
  }, cell);
  const viewport = page.viewport();
  assert(
    point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height,
    `board cell ${cell.x},${cell.y} maps outside the viewport at ${point.x},${point.y}`,
  );
  await page.mouse.click(point.x, point.y);
}

async function roundAt(label, { takeAtStep, successShot = null } = {}) {
  // The previous round, the board pages and the join itself all spend the same
  // per-agent token bucket. Waiting here (no session yet, so no deadline cost)
  // lets it refill so the walk's refreshes and the mid-round screenshot are not
  // covered by a rate-limit toast.
  phase(`${label}: token bucket`);
  await sleep(6_000);
  phase(`${label}: join`);
  await joinWithRoom(label);

  phase(`${label}: walk`);
  await walkTo(NEED_AT, {
    takeAtStep: async () => {
      const snap = await playSnap();
      if (takeAtStep && snap) await takeAtStep(snap);
    },
  });

  phase(`${label}: close the door`);
  await clickCell(DOOR_AT);
  await page.waitForSelector('[data-testid=play-close-door]', { visible: true, timeout: 5_000 });
  await until(
    () =>
      page.evaluate(() => {
        const button = document.querySelector('[data-testid=play-close-door]');
        return button !== null && !button.disabled;
      }),
    { timeout: 5_000, interval: 100, label: 'close door button enabled' },
  );
  await safeClick('[data-testid=play-close-door]');
  const closed = await waitPlay(
    (state) =>
      state.objects.some(
        (object) =>
          object.pos.x === DOOR_AT.x &&
          object.pos.y === DOOR_AT.y &&
          object.kind === 'door' &&
          !object.open &&
          !object.site,
      ),
    'the door closed',
    8_000,
  );
  pass(`${label}: closed the south door at ${DOOR_AT.x},${DOOR_AT.y} (tick ${closed.body.result.tick})`);

  // The walk spends the human's token bucket almost to the floor; a short pause
  // refills it so the use, its refresh and the success poll cannot put a
  // rate-limit toast over the result screenshot.
  await sleep(2_500);

  phase(`${label}: use`);
  await page.waitForSelector('[data-testid=play-use]', { visible: true, timeout: 5_000 });
  await until(
    () =>
      page.evaluate(() => {
        const button = document.querySelector('[data-testid=play-use]');
        return button !== null && !button.disabled;
      }),
    { timeout: 5_000, interval: 100, label: 'use button enabled' },
  );
  await safeClick('[data-testid=play-use]');
  const success = await waitPlay(
    (state) => state.agent?.outcome === 'success',
    'a successful use',
    15_000,
  );
  const outcome = await page.$eval('[data-testid=play-outcome]', (element) => element.textContent?.trim() ?? '');
  assert(outcome === '成功', `result panel says ${JSON.stringify(outcome)} instead of 成功`);
  const score = success.body.result.agent?.score ?? 0;
  assert(score > 0, `success recorded no positive score (${score})`);
  const successTick = success.body.result.tick;
  pass(`${label}: use succeeded at tick ${successTick} with score ${score}, result panel says 成功`);

  if (successShot) {
    await page.evaluate(() => document.querySelector('[data-testid=play-outcome]')?.scrollIntoView({ block: 'center' }));
    await sleep(150);
    await successShot(successTick);
  }

  phase(`${label}: leave the successful session`);
  await leaveRound();
  pass(`${label}: left the world after the success (the board can start a fresh round)`);
  return { successTick };
}

async function dumpFailureSummary() {
  try {
    if (!page || page.isClosed()) return;
    const summary = await page.evaluate(() => ({
      url: window.location.href,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1600),
      lastState: window.__e2e?.states?.at(-1)?.body?.result ?? null,
      lastActions: window.__e2e?.actions?.slice(-6) ?? [],
      lastMoves: window.__e2e?.moves?.slice(-6) ?? [],
      urls: window.__e2e?.urls?.slice(-30) ?? [],
    }));
    console.error(`page: ${summary.url}`);
    console.error(`page text: ${summary.text}`);
    console.error(`last play state: ${JSON.stringify(summary.lastState).slice(0, 1800)}`);
    console.error(`last actions: ${JSON.stringify(summary.lastActions).slice(0, 1400)}`);
    console.error(`last moves: ${JSON.stringify(summary.lastMoves).slice(0, 900)}`);
    console.error(`recent urls: ${summary.urls.join(', ')}`);
  } catch (error) {
    console.error(`page summary failed: ${error?.message || error}`);
  }
}

// --- the whole scenario ----------------------------------------------------

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  phase('prerequisites');
  assert(fs.existsSync(path.join(ROOT, 'web/dist/index.html')), 'web/dist/index.html is missing');
  assert(fs.statSync(CHROME).mode & 0o111, `${CHROME} is not executable`);

  const health = await fetch(`${BASE}/healthz`);
  assert(health.ok, `server healthz returned ${health.status}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: CHROME_DIR,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  page = await browser.newPage();
  await installRecorder(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });

  try {
    await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);

    // --- account -----------------------------------------------------------
    phase('account register');
    await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name=username]', { timeout: 10_000 });
    await page.type('input[name=username]', USERNAME);
    await page.type('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window.location.pathname === '/account', { timeout: 15_000 });
    await page.waitForFunction(
      (name) => document.querySelector('.account-username')?.textContent?.includes(name),
      { timeout: 10_000 },
      USERNAME,
    );
    pass(`registered ${USERNAME} in real Chrome`);

    // --- install command ---------------------------------------------------
    phase('install command');
    await page.waitForSelector('[data-testid=token-action]', { timeout: 10_000 });
    await page.click('[data-testid=token-action]');
    await page.waitForSelector('[data-testid=install-command]', { timeout: 10_000 });
    const shCommand = await page.$eval('[data-testid=install-command]', (element) => element.textContent?.trim() ?? '');
    assert(shCommand.startsWith('curl '), `unexpected sh install command: ${shCommand}`);
    assert(shCommand.includes('--token'), 'the sh install command carries no token');
    await page.click('[data-testid=copy-command]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=copy-command]')?.textContent?.includes('已复制'),
      { timeout: 5_000 },
    );
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert(clipboard.trim() === shCommand, 'the copied text is not the install command');
    pass('copied the one-time install command from /account');

    phase('install CLI');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(BIN, { recursive: true });
    runShell(shCommand, { LOO_HOME: HOME, LOO_BIN_DIR: BIN });
    assert(fs.existsSync(LOO), `installer did not put loo at ${LOO}`);
    assert(fs.statSync(LOO).mode & 0o111, `${LOO} is not executable`);
    const installed = readConfig();
    assert(typeof installed.token === 'string' && installed.token.length === 64, 'config.json has no account token');
    assert(installed.server === BASE, `config server is ${installed.server}, expected ${BASE}`);
    assert(fs.existsSync(path.join(DOWNLOADS, 'loo-linux-x64')), 'downloads/loo-linux-x64 is missing');
    pass(`installed the CLI into ${BIN} from the served one-time command`);

    // --- AI agent ----------------------------------------------------------
    phase('register AI');
    const registered = run(LOO, ['register', '--name', AI_NICK, '--model', 'e2e', '--intro', 'e2e'], {
      LOO_HOME: HOME,
    });
    assert(/created/.test(registered.stdout), `loo register did not report created:\n${registered.stdout}`);
    const aiConfig = readConfig();
    assert(typeof aiConfig.agent_id === 'number', 'loo register did not save agent_id');
    const aiId = aiConfig.agent_id;
    pass(`registered ${AI_NICK} as agent ${aiId}`);

    // --- create the human character ---------------------------------------
    phase('create human');
    await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=play-create]', { timeout: 10_000 });
    await page.type('.play-form input.input', HUMAN_NICK);
    await page.click('[aria-label="颜色 4"]');
    await page.click('[data-testid=play-create]');
    await page.waitForFunction(
      (nick) => document.querySelector('.play-me-nick')?.textContent?.includes(nick),
      { timeout: 10_000 },
      HUMAN_NICK,
    );
    await page.waitForSelector('[data-testid=play-join]', { timeout: 10_000 });
    const created = await waitPlay(() => true, 'the first play state');
    const humanId = created.body.result.me.agent_id;
    assert(created.body.result.me.nick === HUMAN_NICK, `page says the human nick is ${created.body.result.me.nick}`);
    pass(`created the human character ${HUMAN_NICK} (#${humanId}, colour 4) and the card is on /play`);

    // --- combat session: CLI inside, visible, collision, attack ------------
    phase('join human (combat)');
    const joined = await joinRound();
    assert(joined.body.result.agent?.need, 'the joined human has no need');
    assert(joined.body.result.agent?.deadline_tick > 0, 'the joined human has no deadline');
    await page.waitForSelector('[data-testid=play-board]', { visible: true, timeout: 5_000 });
    const statusText = await page.$eval('[data-testid=play-stats]', (element) => element.textContent ?? '');
    assert(/需求/.test(statusText) && /deadline/.test(statusText), `status panel lacks need/deadline: ${statusText}`);
    const countdownText = await page.$eval(
      '[data-testid=play-countdown]',
      (element) => element.textContent?.trim() ?? '',
    );
    assert(countdownText.length > 0, 'the countdown is empty');
    pass(
      `human entered at ${joined.body.result.agent.pos.x},${joined.body.result.agent.pos.y} with need ${joined.body.result.agent.need} and deadline ${joined.body.result.agent.deadline_tick}`,
    );

    phase('CLI join');
    const cliJoin = run(LOO, ['join', '--sent-by', 'self', '--why', 'e2e'], { LOO_HOME: HOME });
    assert(
      /waiting outside the entrance|entered the world/.test(cliJoin.stdout),
      `unexpected loo join output:\n${cliJoin.stdout}`,
    );
    pass(`${AI_NICK} joined the same world (${/waiting/.test(cliJoin.stdout) ? 'queued at the entrance' : 'inside'})`);

    // One human step frees the entrance; the queued AI enters on the next tick.
    phase('CLI enters');
    await pressMove('ArrowRight');
    await waitCli((state) => state?.placement === 'inside', `${AI_NICK} inside the world`, 10_000);
    const aiPos = cliPos();
    assert(aiPos && aiPos.x === ENTRANCE.x && aiPos.y === ENTRANCE.y, `AI entered at ${JSON.stringify(aiPos)}`);
    pass(`${AI_NICK} left the queue and entered at ${aiPos.x},${aiPos.y}`);

    phase('cross-visibility');
    const lookResult = run(LOO, ['--json', 'look'], { LOO_HOME: HOME });
    const look = JSON.parse(lookResult.stdout);
    const legend = (look.result?.grid?.legend ?? []).map((entry) => entry.meaning).join(' | ');
    assert(
      legend.includes(`another agent #${humanId}`),
      `loo look legend does not show the human #${humanId}: ${legend}`,
    );
    pass(`loo look shows the human ${HUMAN_NICK} as another agent #${humanId}`);

    const pageStateCall = await page.evaluate(async () => {
      const response = await fetch('/api/play/state', { headers: { accept: 'application/json' } });
      return { status: response.status, body: await response.json() };
    });
    assert(pageStateCall.body?.ok, `/api/play/state failed: ${JSON.stringify(pageStateCall.body).slice(0, 300)}`);
    const seenAi = pageStateCall.body.result.agents.find((agent) => agent.id === aiId);
    assert(seenAi, `/api/play/state agents do not contain ${AI_NICK} (#${aiId})`);
    assert(seenAi.nick === AI_NICK, `the window agent #${aiId} is ${seenAi.nick}, not ${AI_NICK}`);
    pass(`/api/play/state in the page lists ${AI_NICK} at ${seenAi.pos.x},${seenAi.pos.y}`);

    // --- spectator badge ---------------------------------------------------
    phase('spectator human badge');
    const spectator = await browser.newPage();
    try {
      await spectator.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await spectator.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await spectator.waitForSelector('canvas.board', { timeout: 10_000 });
      await spectator.waitForFunction(
        () => document.querySelector('.live')?.getAttribute('data-status') === 'live',
        { timeout: 15_000 },
      );
      const projection = (await getJSON('/api/projection')).body.result;
      const human = projection.agents.find((agent) => agent.id === humanId);
      assert(human, `the live spectator does not show ${HUMAN_NICK}`);
      const at = await spectator.evaluate((id) => window.__looView.screenOf(id), humanId);
      assert(at, `the spectator renderer has no screen position for ${HUMAN_NICK} (#${humanId})`);
      await spectator.mouse.click(at.x, at.y);
      await spectator.waitForFunction(
        () => document.querySelector('.kind-badge')?.textContent?.includes('人'),
        { timeout: 8_000 },
      );
      const cardName = await spectator.$eval('.agent-card', (element) => element.textContent ?? '').catch(() => '');
      assert(cardName.includes(HUMAN_NICK), `the selected spectator card is not ${HUMAN_NICK}: ${cardName.slice(0, 120)}`);
      const spectatorTick = projection.tick;
      await screenshot(spectator, 'spectator-human-badge-1440.png', spectatorTick, `${HUMAN_NICK} selected, 人 badge`);
    } finally {
      await spectator.close();
    }
    await page.bringToFront();
    pass('spectator page marks the human character with the 人 badge');

    // --- collision ---------------------------------------------------------
    phase('CLI collision');
    const beforeBlock = Date.now();
    run(LOO, ['move', 'E'], { LOO_HOME: HOME });
    const blockedCli = await until(
      () => {
        const text = cliEvents();
        return text.includes('blocked by agent') && text.includes(HUMAN_NICK) ? text : null;
      },
      { timeout: 6_000, interval: 700, label: 'the CLI bumping into the human' },
    );
    assert(/towards the east is blocked by agent e2e-human/.test(blockedCli), `unexpected CLI block text: ${blockedCli}`);
    pass(`CLI was blocked by the human: ${blockedCli.split('\n').find((line) => line.includes('blocked by'))?.trim()}`);

    phase('human collision');
    await pressMove('ArrowLeft');
    const humanBlocked = await until(
      async () => {
        const text = await pageEventsText();
        return text.includes(`blocked by agent ${AI_NICK}`) ? text : null;
      },
      { timeout: 6_000, interval: 150, label: 'the page showing the human blocked by the AI' },
    );
    assert(
      /towards the west is blocked by agent e2e-ai/.test(humanBlocked),
      `unexpected page block text: ${humanBlocked.slice(-300)}`,
    );
    const humanPos = (await playSnap()).body.result.agents.find((agent) => agent.id === humanId)?.pos;
    assert(humanPos && humanPos.x === ENTRANCE.x + 1 && humanPos.y === ENTRANCE.y, `human moved to ${JSON.stringify(humanPos)}`);
    pass(`page action was stopped by the AI: ${humanBlocked.split('\n').find((line) => line.includes('blocked by'))?.trim()}`);

    // --- attack ------------------------------------------------------------
    phase('CLI attack');
    const deadlineBefore = (await playSnap()).body.result.agent.deadline_tick;
    run(LOO, ['attack', 'E'], { LOO_HOME: HOME });
    const hit = await waitPlay(
      (state) => state.agent && state.agent.deadline_tick <= deadlineBefore - 6 && state.agent.stun_until > state.tick,
      'the attack landing on the human',
      12_000,
    );
    const attackText = await until(
      async () => {
        const text = await pageEventsText();
        return text.includes(`hit ${HUMAN_NICK}`) ? text : null;
      },
      { timeout: 6_000, interval: 200, label: 'the hit in the page event stream' },
    );
    assert(
      new RegExp(`hit ${HUMAN_NICK} .*deadline -6`).test(attackText),
      `the page event stream has no AttackLanded line: ${attackText.slice(-400)}`,
    );
    const cliHit = cliEvents();
    assert(cliHit.includes(`hit ${HUMAN_NICK}`), `the CLI did not see the landing: ${cliHit.slice(-400)}`);
    assert(
      hit.body.result.agent.deadline_tick === deadlineBefore - 6,
      `deadline fell from ${deadlineBefore} to ${hit.body.result.agent.deadline_tick}, expected -6`,
    );
    pass(
      `attack landed on ${HUMAN_NICK}: page shows "hit", deadline ${deadlineBefore}->${hit.body.result.agent.deadline_tick}, stun until ${hit.body.result.agent.stun_until}`,
    );

    // --- /play data-plane leak checks -------------------------------------
    phase('9x9 leak');
    const terrain = (await getJSON('/api/terrain')).body;
    const leak = await page.evaluate(async () => {
      const response = await fetch('/api/play/state', { headers: { accept: 'application/json' } });
      const text = await response.text();
      return { status: response.status, text };
    });
    assert(leak.status === 200, `/api/play/state returned ${leak.status}`);
    const envelope = JSON.parse(leak.text);
    assert(envelope.ok, `/api/play/state is not ok: ${leak.text.slice(0, 300)}`);
    const state = envelope.result;
    assert(state.window.width === 9 && state.window.height === 9, `window is ${state.window.width}x${state.window.height}`);
    const inside = (pos) =>
      pos.x >= state.window.origin.x &&
      pos.y >= state.window.origin.y &&
      pos.x < state.window.origin.x + state.window.width &&
      pos.y < state.window.origin.y + state.window.height;
    for (const object of state.objects) {
      assert(inside(object.pos), `object at ${object.pos.x},${object.pos.y} is outside the 9x9 window`);
    }
    for (const agent of state.agents) {
      assert(inside(agent.pos), `agent ${agent.nick} at ${agent.pos.x},${agent.pos.y} is outside the 9x9 window`);
    }
    assert(
      state.window.origin.x >= 0 &&
        state.window.origin.y >= 0 &&
        state.window.origin.x + state.window.width <= terrain.width &&
        state.window.origin.y + state.window.height <= terrain.height,
      `window ${JSON.stringify(state.window)} is not clipped to the ${terrain.width}x${terrain.height} map`,
    );
    const forbidden = ['kind', 'score_total', 'sent_by', 'why', 'model'];
    for (const agent of state.agents) {
      for (const key of forbidden) {
        assert(!(key in agent), `window agent ${agent.nick} carries ${key}`);
      }
    }
    for (const key of forbidden) {
      if (key === 'kind') continue; // object kind (wall/door/toilet) is part of the view
      for (const object of state.objects) {
        assert(!(key in object), `window object at ${object.pos.x},${object.pos.y} carries ${key}`);
      }
      // The caller's own AgentView may carry its own cumulative score; only
      // the 9×9 window slice must not.
      if (key !== 'score_total') {
        assert(!(key in state.agent), `the caller AgentView carries ${key}`);
      }
    }
    assert(!/"sent_by"|"why"|"model"/.test(leak.text), 'the raw /api/play/state JSON names sent_by/why/model');
    assert(
      !JSON.stringify(state.agents).includes('score_total'),
      'window agents leak score_total',
    );
    // The caller's own AgentView is allowed its own score; nothing else is.
    assert(typeof state.agent?.score_total === 'number', 'the caller own AgentView lost score_total');
    pass(
      `9x9 window ${state.window.width}x${state.window.height} at ${state.window.origin.x},${state.window.origin.y}: every object/agent inside, window agents expose no kind/score_total/sent_by/why/model`,
    );

    await page.evaluate(() => {
      window.__e2e.urls = [];
    });
    await sleep(1_500);
    const urls = await page.evaluate(() => window.__e2e.urls);
    assert(!urls.some((url) => url.includes('/api/projection')), `/play requested /api/projection: ${urls.join(', ')}`);
    assert(!urls.some((url) => url.includes('/api/watch')), `/play requested /api/watch: ${urls.join(', ')}`);
    pass('/play made no /api/projection or /api/watch request');

    // --- leave the combat session -----------------------------------------
    phase('leave combat session');
    await leaveRound();
    pass('left the combat session after the collision and attack');

    // --- clear the human's route and start a clean round ------------------
    phase('park the AI');
    run(LOO, ['move', 'E'], { LOO_HOME: HOME });
    await until(() => cliPos()?.x === ENTRANCE.x + 1, { timeout: 5_000, interval: 500, label: 'AI step east' });
    run(LOO, ['move', 'N'], { LOO_HOME: HOME });
    await until(() => cliPos()?.y === ENTRANCE.y - 1, { timeout: 5_000, interval: 500, label: 'AI step north' });
    pass('moved the AI off the human path to 7,14; the AI stays in the world for the mixed stats');

    // --- successful desktop round -----------------------------------------
    phase('1440 round');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const round1440 = await roundAt('1440 round', {
      takeAtStep: async (snap) => {
        await screenshot(page, 'play-1440.png', snap.body.result.tick, 'desktop round mid-walk');
      },
    });

    // --- boards ------------------------------------------------------------
    phase('boards');
    const humanBoard = (await getJSON('/api/leaderboard?metric=score&kind=human&limit=50')).body.result;
    assert(Array.isArray(humanBoard), 'human leaderboard is not an array');
    assert(humanBoard.some((row) => row.nick === HUMAN_NICK), 'human board does not contain e2e-human');
    const mixedBoard = (await getJSON('/api/leaderboard?metric=score&kind=mixed&limit=50')).body.result;
    assert(mixedBoard.some((row) => row.nick === HUMAN_NICK), 'mixed board does not contain e2e-human');
    const aiBoard = (await getJSON('/api/leaderboard?metric=score&kind=ai&limit=50')).body.result;
    assert(!aiBoard.some((row) => row.nick === HUMAN_NICK), 'AI board contains the human e2e-human');
    pass('human and mixed boards contain e2e-human; the AI board does not');

    await page.goto(`${BASE}/leaderboard?kind=human`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (nick) => document.querySelector('.data-table')?.textContent?.includes(nick),
      { timeout: 10_000 },
      HUMAN_NICK,
    );
    const humanBadge = await page.$$eval('.data-table .kind-badge', (badges) => badges.map((badge) => badge.textContent?.trim()));
    assert(humanBadge.includes('人'), 'the human board row has no 人 badge');
    const boardTick = (await getJSON('/api/projection')).body.result.tick;
    await screenshot(page, 'leaderboard-human-1440.png', boardTick, '?kind=human');

    await page.goto(`${BASE}/leaderboard?kind=mixed`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (nick) => document.querySelector('.data-table')?.textContent?.includes(nick),
      { timeout: 10_000 },
      HUMAN_NICK,
    );
    await screenshot(page, 'leaderboard-mixed-1440.png', boardTick, '?kind=mixed');

    await page.goto(`${BASE}/leaderboard?kind=ai`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('.data-table') || document.body.innerText.includes('暂无数据'),
      { timeout: 10_000 },
    );
    const aiBoardText = await page.evaluate(() => document.body.innerText);
    assert(!aiBoardText.includes(HUMAN_NICK), 'the AI board page shows the human e2e-human');
    pass('the AI board page does not show the human');

    phase('stats');
    await page.goto(`${BASE}/stats`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stat-cards', { timeout: 10_000 });
    await page.click('[data-scope=mixed]');
    await page.waitForFunction(
      () => document.querySelector('[data-scope=mixed]')?.getAttribute('aria-selected') === 'true',
      { timeout: 5_000 },
    );
    const mixedStats = (await getJSON('/api/stats')).body.result.mixed;
    assert(mixedStats.total_sessions > 0, 'the mixed stats total is empty');
    assert(mixedStats.human.sessions > 0, `the mixed human session count is ${mixedStats.human.sessions}`);
    assert(mixedStats.human.successes > 0, `the mixed human success count is ${mixedStats.human.successes}`);
    const cardText = await page.$$eval('.kind-card', (cards) => cards.map((card) => card.textContent?.replace(/\s+/g, ' ').trim()));
    assert(cardText.length >= 2, `stats renders ${cardText.length} kind cards`);
    assert(cardText[1].includes(String(mixedStats.human.sessions)), 'the human stats card does not show its session count');
    await screenshot(page, 'stats-kinds-1440.png', boardTick, 'stats scope=有另一类在场');
    pass(
      `stats mixed scope has ${mixedStats.total_sessions} sessions (human ${mixedStats.human.sessions}, ai ${mixedStats.ai.sessions})`,
    );

    // --- permanent action bar (390) ---------------------------------------
    // The bar is the page's single surface for "queued / running / refused", so
    // it is exercised once at 390: a keyboard move must land in `pending`, a
    // settled tick must move it on, and an exhausted token bucket must show the
    // retry sentence — with the page still 390 wide at every step.
    phase('pending bar');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=play-join]', { timeout: 10_000 });
    await joinWithRoom('pending bar');

    // The join spent most of the per-agent burst and the page polls once a
    // second against a 2/s refill, so a starved bucket would answer the poll
    // with a 429 and paint `rejected` over the window asserted below.
    await sleep(6_000);

    // A queued command only reads `pending` until the server's next tick, so
    // each attempt submits right after the page paints a settlement and retries
    // on a miss.
    let queued = null;
    for (let attempt = 1; attempt <= 6 && !queued; attempt += 1) {
      const tick = await waitTickRollover('pending bar');
      await page.keyboard.press('ArrowRight');
      try {
        const bar = await until(
          async () => {
            const current = await actionBar();
            return current && current.state === 'pending' ? current : null;
          },
          { timeout: 700, interval: 20, label: 'the pending bar' },
        );
        queued = { bar, tick };
      } catch (error) {
        const seen = await actionBar();
        console.log(
          `  pending bar: attempt ${attempt} at tick ${tick} missed (bar=${seen?.state ?? 'none'}: ${JSON.stringify(seen?.text ?? '')}): ${error.message}`,
        );
        await sleep(1_200);
      }
    }
    assert(queued, 'the action bar never reached data-state=pending after a keyboard move');
    assert(
      /已提交：移动 [NSEW]/.test(queued.bar.text),
      `pending bar title is ${JSON.stringify(queued.bar.text)}`,
    );
    assert(
      /下一次结算执行 · \d+\.\ds/.test(queued.bar.text),
      `pending bar detail is ${JSON.stringify(queued.bar.text)}`,
    );
    assert(
      queued.bar.overflow <= 0,
      `the 390 page scrolls horizontally by ${queued.bar.overflow}px while the pending bar is shown`,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(80);
    await screenshot(page, 'play-pending-390.png', queued.tick, '390-wide pending bar right after a keyboard move');
    pass(`action bar reads ${JSON.stringify(queued.bar.text)} at 390 with no horizontal overflow`);

    phase('pending bar settles');
    const settled = await until(
      async () => {
        const tick = await domTick();
        if (tick <= queued.tick) return null;
        const bar = await actionBar();
        return bar && bar.state !== 'pending' ? { tick, bar } : null;
      },
      { timeout: 5_000, interval: 25, label: 'the bar leaving pending after one tick' },
    );
    assert(
      settled.bar.state === 'executing' || settled.bar.state === 'idle',
      `the bar is ${settled.bar.state} at tick ${settled.tick}: ${settled.bar.text}`,
    );
    pass(`after tick ${settled.tick} the bar is ${settled.bar.state}: ${JSON.stringify(settled.bar.text)}`);

    phase('pending bar rejected');
    const flood = await page.evaluate(async () => {
      const pair = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('loo_csrf='));
      const csrf = pair ? decodeURIComponent(pair.slice('loo_csrf='.length)) : '';
      const results = [];
      for (let index = 0; index < 15; index += 1) {
        const response = await fetch('/api/play/cancel', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'X-Loo-CSRF': csrf,
          },
          credentials: 'same-origin',
          body: '{}',
        });
        const body = await response.json().catch(() => null);
        results.push({
          status: response.status,
          code: body?.error?.code ?? null,
          retryAfter: body?.error?.retry_after_seconds ?? null,
        });
      }
      return results;
    });
    const limited = flood.find((entry) => entry.status === 429 || entry.code === 'rate_limited');
    assert(limited, `15 cancel calls never exhausted the bucket: ${JSON.stringify(flood)}`);
    await page.keyboard.press('ArrowLeft');
    const rejected = await until(
      async () => {
        const bar = await actionBar();
        return bar && bar.state === 'rejected' ? bar : null;
      },
      { timeout: 4_000, interval: 25, label: 'the rejected bar' },
    );
    assert(/被拒绝：/.test(rejected.text), `rejected bar title is ${JSON.stringify(rejected.text)}`);
    assert(/请求过快/.test(rejected.text), `rejected bar carries no retry sentence: ${JSON.stringify(rejected.text)}`);
    const retrySeconds = limited.retryAfter ?? 1;
    await sleep(Math.max(1_500, Math.round(retrySeconds * 1_000) + 500));
    pass(`the bucket refused the 15th command (retry ${retrySeconds}s) and the bar showed ${JSON.stringify(rejected.text)}`);

    phase('pending bar: leave');
    await leaveRound();
    pass('left the world after the action-bar checks');

    // --- 390-wide round ----------------------------------------------------
    phase('390 round');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=play-join]', { timeout: 10_000 });
    const round390 = await roundAt('390 round', {
      takeAtStep: async (snap) => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(100);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - 390);
        assert(overflow <= 0, `390 play page scrolls horizontally by ${overflow}px`);
        await screenshot(page, 'play-390.png', snap.body.result.tick, '390-wide round mid-walk', {
          fullPage: true,
        });
      },
      successShot: async (tick) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - 390);
        assert(overflow <= 0, `390 success page scrolls horizontally by ${overflow}px`);
        await screenshot(page, 'play-success-390.png', tick, '390-wide success result', {
          fullPage: true,
        });
      },
    });

    const finalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - 390);
    assert(finalOverflow <= 0, `the 390 play page ends ${finalOverflow}px wider than its viewport`);
    pass('390-wide viewport completed a full round with no horizontal overflow');

    phase('page errors');
    assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join(' | ')}`);
    pass('no uncaught browser errors');

    console.log(
      `PASS: play end-to-end completed (1440 success tick ${round1440.successTick}, 390 success tick ${round390.successTick})`,
    );
  } catch (error) {
    await dumpFailureSummary();
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(async (error) => {
  console.error(`FAIL: ${currentPhase}: ${error?.stack || error?.message || error}`);
  try {
    if (fs.existsSync(LOG)) {
      const log = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-20).join('\n');
      console.error(`server log tail:\n${log}`);
    }
  } catch {
    // Best-effort only.
  }
  process.exitCode = 1;
});
