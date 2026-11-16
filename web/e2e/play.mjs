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
import { findPath } from '../src/play/path.ts';
import { zhReason } from '../src/eventText.ts';
import { assertChinese } from './lib-zh.mjs';

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
// The server draws the deadline uniformly from 36–60 ticks (0.5 s each); a full click-only round took 36–41 ticks from join to success on this host, and the menu sub-rounds stay outside the shack.
const ROUND_TICKS_REQUIRED = 50;
const MENU_ROUND_TICKS_REQUIRED = 44;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DIR_DELTA = { N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 } };
const DIR_KEY = { N: 'ArrowUp', E: 'ArrowRight', S: 'ArrowDown', W: 'ArrowLeft' };
const pageErrors = [];
const netLog = [];
let mainPage = null;
let tapMode = 'mouse';
let keyboardForbidden = false;

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
    try {
      localStorage.setItem('loo.quality', 'low');
    } catch {}
    const state = { states: [], urls: [], moves: [], actions: [], moveSeq: 0 };
    window.__e2e = state;
    const Source = window.EventSource;
    state.sources = [];
    window.EventSource = class extends Source {
      constructor(url, init) {
        super(url, init);
        state.urls.push(String(url));
        state.sources.push(this);
      }
    };
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
  const handle = await page.waitForSelector(selector, { visible: true, timeout });
  if (tapMode === 'touch') {
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    return;
  }
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
    if (!(await page.$('[data-testid=play-leave]'))) {
      await sleep(300);
      continue;
    }
    try {
      await safeClick('[data-testid=play-leave]');
    } catch (error) {
      const ended = await playSnap();
      if (ended && !ended.body.result.joined) return;
      throw error;
    }
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
async function joinWithRoom(label, required = ROUND_TICKS_REQUIRED, attempts = 20) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const snap = await joinRound();
    const state = snap.body.result;
    const remaining = (state.agent?.deadline_tick ?? 0) - state.tick;
    if (remaining >= required) {
      pass(`${label}: joined with ${remaining} ticks of deadline left`);
      return snap;
    }
    console.log(`  ${label}: deadline draw ${remaining} ticks is too short; leaving (try ${attempt})`);
    await leaveRound();
    await sleep(250);
  }
  throw new Error(`${label}: ${attempts} deadline draws were all shorter than ${required} ticks`);
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
  await pressKey(key);
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
      state: bar.getAttribute('data-tone'),
      text: (bar.textContent ?? '').replace(/\s+/g, ' ').trim(),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

/** Ticks update every 100ms from the last poll's deadline, so the DOM is fresh. */
async function domTick() {
  return page.$eval('[data-testid=play-tick]', (element) =>
    Number((element.textContent ?? '').replace(/\D/g, '') || '0'),
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

async function cellPoint(cell) {
  return page.evaluate((wanted) => {
    const view = window.__looView;
    const canvas = document.querySelector('canvas.ui-canvas');
    if (!view || !canvas) return null;
    const at = view.screenOfCell(wanted.x, wanted.y);
    if (!at) return null;
    const under = view.cellAt(at.x, at.y);
    if (!under || under.x !== wanted.x || under.y !== wanted.y) return null;
    return document.elementFromPoint(at.x, at.y) === canvas ? at : null;
  }, cell);
}

async function tapCell(cell) {
  const point = await page.evaluate(
    (wanted) =>
      new Promise((resolve, reject) => {
        const view = window.__looView;
        const canvas = document.querySelector('canvas.ui-canvas');
        if (!view || !canvas) {
          reject(new Error('the world view is not ready'));
          return;
        }
        const started = performance.now();
        let last = null;
        let still = 0;
        const step = () => {
          const at = view.screenOfCell(wanted.x, wanted.y);
          if (at && last && Math.abs(at.x - last.x) < 0.5 && Math.abs(at.y - last.y) < 0.5) still += 1;
          else still = 0;
          last = at;
          if (still >= 3) {
            const under = view.cellAt(at.x, at.y);
            if (under && under.x === wanted.x && under.y === wanted.y && document.elementFromPoint(at.x, at.y) === canvas) {
              resolve({ x: at.x, y: at.y });
            } else {
              reject(new Error(`cell ${wanted.x},${wanted.y} is not under its own centre once the camera is still`));
            }
            return;
          }
          if (performance.now() - started > 30000) {
            reject(new Error(`the camera did not hold still over ${wanted.x},${wanted.y} within 30 s`));
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    cell,
  );
  if (tapMode === 'touch') await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function roundAt(label, { takeAtStep, successShot = null } = {}) {
  // The previous round, the board pages and the join itself all spend the same
  // per-agent token bucket. Waiting here (no session yet, so no deadline cost)
  // lets it refill so the walk's refreshes and the mid-round screenshot are not
  // covered by a rate-limit toast.
  phase(`${label}: token bucket`);
  await parkAi();
  await sleep(6_000);
  phase(`${label}: join`);
  await joinWithRoom(label);
  ensureAiInWorld();

  phase(`${label}: walk`);
  await walkToToiletByClicks(label, async () => {
    const snap = await playSnap();
    if (takeAtStep && snap) await takeAtStep(snap);
  });

  phase(`${label}: close the door`);
  await tapCell(DOOR_AT);
  await page.waitForSelector('[data-play-menu] [data-action="door-close"]', { visible: true, timeout: 5_000 }).catch(async (error) => { const snap = (await playSnap()).body.result; console.log(`  diag ${label}: menu=${await page.$$eval('[data-play-menu] button', (buttons) => buttons.map((b) => b.dataset.action).join(','))} menuText=${await page.$eval('[data-play-menu]', (element) => element.textContent).catch(() => 'none')} door=${JSON.stringify(snap.objects.find((o) => o.kind === 'door' && o.pos.x === DOOR_AT.x && o.pos.y === DOOR_AT.y) ?? null)} pos=${JSON.stringify(snap.agent?.pos)} stun=${snap.agent?.stun_until} tick=${snap.tick}`); throw error; });
  await waitEnabled('[data-play-menu] [data-action="door-close"]');
  await safeClick('[data-play-menu] [data-action="door-close"]');
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
  ).catch(async (error) => {
    const snap = (await playSnap()).body.result;
    const usePosts = await page.evaluate(() => window.__e2e.actions.filter((action) => action.url.includes('/api/play/use')).slice(-2));
    console.log(`  diag 1440 round: use posts=${JSON.stringify(usePosts).slice(0, 500)}`);
    console.log(`  diag 1440 round: use state tick=${snap.tick} joined=${snap.joined} placement=${snap.placement} pose=${snap.agent?.pose ?? null} action=${JSON.stringify(snap.agent?.action ?? null)} done=${snap.agent?.use_ticks_done} total=${snap.agent?.use_ticks_total} outcome=${snap.agent?.outcome} deadline=${snap.agent?.deadline_tick} hint=${await page.$eval('[data-testid=play-hint]', (element) => element.textContent).catch(() => 'none')}`);
    throw error;
  });
  const outcome = await page.$eval('[data-testid=play-outcome]', (element) => element.textContent?.trim() ?? '');
  assert(outcome.startsWith('成功'), `result panel says ${JSON.stringify(outcome)} instead of 成功`);
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

async function pressKey(key) {
  assert(!keyboardForbidden, `the key ${key} was pressed in a click-only round`);
  await page.keyboard.press(key);
}

async function attachPage(target) {
  await installRecorder(target);
  target.on('pageerror', (error) => pageErrors.push(error.message));
  target.on('dialog', (dialog) => {
    void dialog.accept();
  });
  target.on('request', (request) => {
    netLog.push({
      at: Date.now(),
      method: request.method(),
      url: request.url(),
      postData: request.postData() ?? '',
    });
  });
}

function dist(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function samePos(a, b) {
  return a.x === b.x && a.y === b.y;
}

function neighbours(cell) {
  return Object.keys(DIR_DELTA).map((dir) => ({ x: cell.x + DIR_DELTA[dir].x, y: cell.y + DIR_DELTA[dir].y }));
}

function inWindow(state, cell) {
  const win = state.window;
  return (
    cell.x >= win.origin.x &&
    cell.y >= win.origin.y &&
    cell.x < win.origin.x + win.width &&
    cell.y < win.origin.y + win.height
  );
}

function objectAtState(state, cell) {
  return state.objects.find((object) => samePos(object.pos, cell)) ?? null;
}

function agentAtState(state, cell) {
  return state.agents.find((agent) => samePos(agent.pos, cell)) ?? null;
}

function groundFree(state, terrain, cell) {
  return (
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.x < terrain.width &&
    cell.y < terrain.height &&
    terrain.rows[cell.y][cell.x] === '.' &&
    inWindow(state, cell) &&
    !objectAtState(state, cell) &&
    !agentAtState(state, cell)
  );
}

function checkPathCells(state, start, path) {
  const origin = state.map?.grid?.origin ?? { x: 0, y: 0 };
  let x = start.x;
  let y = start.y;
  let inside = 0;
  let remembered = 0;
  for (const step of path) {
    x += DIR_DELTA[step].x;
    y += DIR_DELTA[step].y;
    const cell = { x, y };
    const seenAt = state.map?.seen_at?.[y - origin.y]?.[x - origin.x] ?? 0;
    assert(
      inWindow(state, cell) || seenAt > 0,
      `path cell ${x},${y} is outside the 9x9 window and was never seen (seen_at ${seenAt})`,
    );
    if (inWindow(state, cell)) inside += 1;
    else remembered += 1;
  }
  return { cells: path.length, inside, remembered };
}

function isMoveRequest(record) {
  return record.method === 'POST' && record.url.includes('/api/play/move');
}

async function reached(cell, timeout) {
  return until(
    async () => {
      const pos = (await playSnap()).body.result.agent.pos;
      return samePos(pos, cell) ? true : null;
    },
    { timeout, interval: 100, label: `arrival at ${cell.x},${cell.y}` },
  ).then(
    () => true,
    () => false,
  );
}

async function waitArrived(cell, label, timeout = 30_000) {
  await waitPlay((state) => state.agent?.pos && samePos(state.agent.pos, cell), label, timeout);
}

async function goTo(cell) {
  const here = (await playSnap()).body.result.agent.pos;
  if (samePos(here, cell)) return;
  if (dist(here, cell) > 1) {
    await tapCell(cell);
    await waitArrived(cell, `the walk to ${cell.x},${cell.y}`);
    return;
  }
  const dir = Object.keys(DIR_DELTA).find(
    (name) => here.x + DIR_DELTA[name].x === cell.x && here.y + DIR_DELTA[name].y === cell.y,
  );
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await pressKey(DIR_KEY[dir]);
    if (await reached(cell, 2_000)) return;
  }
  throw new Error(`the step to ${cell.x},${cell.y} did not land in three tries`);
}

async function openMenuAt(cell) {
  await tapCell(cell);
  await page.waitForSelector('[data-play-menu]', { visible: true, timeout: 6_000 });
  return page.$$eval('[data-play-menu] button', (buttons) => buttons.map((button) => button.dataset.action));
}

async function shot(name, note, { checkWidth = false } = {}) {
  if (checkWidth) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `${name}: the page scrolls horizontally by ${overflow}px`);
  }
  const snap = await playSnap();
  await screenshot(page, `l4/${name}`, snap?.body.result.tick ?? 0, note);
}

async function waitEnabled(selector, timeout = 6_000) {
  await until(
    () =>
      page.evaluate((wanted) => {
        const element = document.querySelector(wanted);
        return element !== null && !element.disabled;
      }, selector),
    { timeout, interval: 100, label: `${selector} enabled` },
  );
}

async function centreOffset(agentId) {
  return page.evaluate((id) => {
    const canvas = document.querySelector('canvas.ui-canvas');
    const view = window.__looView;
    const at = view ? view.screenOf(id) : null;
    if (!canvas || !at) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      dx: Math.abs(at.x - (rect.left + rect.width / 2)) / rect.width,
      dy: Math.abs(at.y - (rect.top + rect.height / 2)) / rect.height,
    };
  }, agentId);
}

async function memoryLuma(own) {
  return page.evaluate(async (cell) => {
    const view = window.__looView;
    const canvas = document.querySelector('canvas.ui-canvas');
    const rect = canvas.getBoundingClientRect();
    const frame = view.capture();
    const image = new Image();
    image.src = frame.png;
    await image.decode();
    const work = document.createElement('canvas');
    work.width = image.width;
    work.height = image.height;
    const context = work.getContext('2d');
    context.drawImage(image, 0, 0);
    const luma = (point) => {
      const x = Math.round((point.x - rect.left) * (image.width / rect.width));
      const y = Math.round((point.y - rect.top) * (image.height / rect.height));
      const data = context.getImageData(x - 2, y - 2, 5, 5).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      return sum / (data.length / 4);
    };
    const onCanvas = (point) =>
      point.x >= rect.left && point.y >= rect.top && point.x <= rect.right && point.y <= rect.bottom;
    const near = view.screenOfCell(cell.x, cell.y);
    const farEntry = [
      { x: cell.x + 8, y: cell.y },
      { x: cell.x - 8, y: cell.y },
      { x: cell.x, y: cell.y + 8 },
      { x: cell.x, y: cell.y - 8 },
    ]
      .map((candidate) => ({ candidate, at: view.screenOfCell(candidate.x, candidate.y) }))
      .find((entry) => entry.at && onCanvas(entry.at));
    return {
      own: luma(near),
      far: farEntry ? luma(farEntry.at) : null,
      farCell: farEntry ? farEntry.candidate : null,
    };
  }, own);
}

async function signUpAndCreate({ username, nick, width, height, touch }) {
  if (touch) {
    const agent = (await browser.userAgent()).replace('(X11; Linux x86_64)', '(Linux; Android 14; Pixel 7) Mobile');
    await page.emulate({
      userAgent: agent,
      viewport: { width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    });
  } else {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
  }
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=username]', { visible: true, timeout: 15_000 });
  await page.type('input[name=username]', username);
  await page.type('input[name=password]', PASSWORD);
  await safeClick('button[type=submit]');
  await page.waitForFunction(() => window.location.pathname === '/account', { timeout: 15_000 });
  await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
  await safeClick('[data-testid=play-create-open]');
  await page.waitForSelector('[data-window="create"] input[type=text]', { visible: true, timeout: 10_000 });
  await page.type('[data-window="create"] input[type=text]', nick);
  await safeClick('[data-window="create"] [aria-label="颜色 4"]');
  await safeClick('[data-testid=play-create]');
  await page.waitForFunction(() => !document.querySelector('[data-window="create"]'), { timeout: 10_000 });
  await page.waitForSelector('[data-testid=play-join]', { visible: true, timeout: 10_000 });
}

async function withFreshHuman(options, body) {
  const context = await browser.createBrowserContext();
  const target = await context.newPage();
  await attachPage(target);
  page = target;
  tapMode = options.touch ? 'touch' : 'mouse';
  try {
    await signUpAndCreate(options);
    return await body();
  } catch (error) {
    await dumpFailureSummary();
    throw error;
  } finally {
    tapMode = 'mouse';
    page = mainPage;
    await context.close().catch(() => {});
  }
}

async function walkToToiletByClicks(label, midWalk = null) {
    const dims = (await getJSON('/api/terrain')).body;
    const cellsChecked = { cells: 0, inside: 0, remembered: 0 };
    const clickPath = async (target, stepLabel) => {
      const before = await playSnap();
      const sentFrom = netLog.length;
      await tapCell(target);
      const posts = await until(
        () => {
          const found = netLog.slice(sentFrom).filter(isMoveRequest);
          return found.length > 0 ? found : null;
        },
        { timeout: 6_000, interval: 50, label: `${stepLabel}: the path command` },
      ).catch(async (error) => {
        const snap = (await playSnap()).body.result;
        console.log(`  diag ${stepLabel}: hint=${await page.$eval('[data-testid=play-hint]', (element) => element.textContent).catch(() => 'none')} pending=${await page.$eval('[data-testid=play-pending]', (element) => element.textContent).catch(() => 'none')} pos=${JSON.stringify(snap.agent?.pos)} target=${JSON.stringify(target)} tap=${JSON.stringify(await cellPoint(target))}`);
        throw error;
      });
      assert(posts.length === 1, `${stepLabel}: ${posts.length} move commands were sent for one click`);
      const sentBody = JSON.parse(posts[0].postData);
      const path = sentBody?.spec?.Path?.path;
      assert(typeof path === 'string' && path.length > 0, `${stepLabel}: the move command is not a Path: ${posts[0].postData}`);
      const checked = checkPathCells(before.body.result, before.body.result.agent.pos, path);
      cellsChecked.cells += checked.cells;
      cellsChecked.inside += checked.inside;
      cellsChecked.remembered += checked.remembered;
      await waitArrived(target, stepLabel, 40_000);
      const after = netLog.slice(sentFrom).filter(isMoveRequest).length;
      assert(after === 1, `${stepLabel}: ${after} move commands were sent for the walk`);
      return { steps: path.length };
    };

    phase(`${label}: one-click far walk`);
    const start = (await playSnap()).body.result;
    const farCells = [];
    for (let y = start.window.origin.y; y < start.window.origin.y + start.window.height; y += 1) {
      for (let x = start.window.origin.x; x < start.window.origin.x + start.window.width; x += 1) {
        const cell = { x, y };
        if (dist(cell, start.agent.pos) < 4) continue;
        if (findPath(start, dims.width, dims.height, cell) === null) continue;
        farCells.push(cell);
      }
    }
    farCells.sort((a, b) => dist(a, NEED_AT) - dist(b, NEED_AT));
    assert(farCells.length > 0, `${label}: no known ground at least four cells away is reachable`);
    const far = await clickPath(farCells[0], `${label}: far walk`);
    if (midWalk) await midWalk();
    pass(
      `far walk: one click to ${farCells[0].x},${farCells[0].y} sent exactly one Path move (${far.steps} steps) and the human arrived there`,
    );

    phase(`${label}: into the shack`);
    let clicks = 0;
    for (let guard = 0; guard < 8; guard += 1) {
      const state = (await playSnap()).body.result;
      if (findPath(state, dims.width, dims.height, NEED_AT) !== null) break;
      const here = state.agent.pos;
      const closer = [];
      for (let y = state.window.origin.y; y < state.window.origin.y + state.window.height; y += 1) {
        for (let x = state.window.origin.x; x < state.window.origin.x + state.window.width; x += 1) {
          const cell = { x, y };
          if (dist(cell, here) < 2) continue;
          if (dist(cell, NEED_AT) >= dist(here, NEED_AT)) continue;
          if (findPath(state, dims.width, dims.height, cell) === null) continue;
          closer.push(cell);
        }
      }
      closer.sort((a, b) => dist(a, NEED_AT) - dist(b, NEED_AT));
      assert(closer.length > 0, `${label}: no reachable cell in the window is closer to the toilet than ${here.x},${here.y}`);
      await clickPath(closer[0], `${label}: shack step ${clicks + 1}`);
      clicks += 1;
    }
    await clickPath(NEED_AT, `${label}: the toilet`);
    clicks += 1;
    pass(
      `path cells: all ${cellsChecked.cells} cells of the paths are inside the 9x9 window or were seen before (${cellsChecked.inside} in view, ${cellsChecked.remembered} remembered)`,
    );
    const toiletPos = (await playSnap()).body.result.agent.pos;
    assert(samePos(toiletPos, NEED_AT), `${label}: the human is at ${toiletPos.x},${toiletPos.y}, not the toilet`);
    pass(`${label}: ${clicks} clicks into the shack after the far walk, each one Path move; the human stands on the toilet`);
    return { pathSteps: far.steps, clicks };
}

async function shotSession(label, { entry = null, menu = null, using = null, checkWidth = false }) {
  await joinWithRoom(label);
  if (entry) await shot(entry, `${label}: just joined`, { checkWidth });
  if (menu || using) await walkToToiletByClicks(label);
  if (menu) {
    await tapCell(DOOR_AT);
    await page.waitForSelector('[data-play-menu] [data-action="door-close"]', { visible: true, timeout: 6_000 });
    await waitEnabled('[data-play-menu] [data-action="door-close"]');
    await shot(menu, `${label}: the door menu`, { checkWidth });
  }
  if (using) {
    await tapCell(DOOR_AT);
    await page.waitForSelector('[data-play-menu] [data-action="door-close"]', { visible: true, timeout: 6_000 });
    await waitEnabled('[data-play-menu] [data-action="door-close"]');
    await safeClick('[data-play-menu] [data-action="door-close"]');
    await waitPlay(
      (state) =>
        state.objects.some(
          (object) => samePos(object.pos, DOOR_AT) && object.kind === 'door' && !object.open && !object.site,
        ),
      `${label}: the door closed for the using`,
      8_000,
    );
    await waitEnabled('[data-testid=play-use]');
    await safeClick('[data-testid=play-use]');
    await waitPlay(
      (state) => (state.agent?.use_ticks_done ?? 0) >= 1 || state.agent?.outcome,
      `${label}: the use in progress`,
      8_000,
    );
    await shot(using, `${label}: using the toilet`, { checkWidth });
  }
  await leaveRound();
}

async function clickOnlyRound({ label, shots = {}, memory = false, checkWidth = false }) {
  keyboardForbidden = true;
  try {
    phase(`${label}: join`);
    await parkAi();
    await sleep(4_000);
    await joinWithRoom(label);
    await sleep(400);
    const joined = await playSnap();
    const me = joined.body.result.me.agent_id;
    if (shots.join) await shot(shots.join, `${label}: just joined`, { checkWidth });
    const joinOffset = await centreOffset(me);
    assert(
      joinOffset && joinOffset.dx <= 0.15 && joinOffset.dy <= 0.15,
      `${label}: the own body is ${JSON.stringify(joinOffset)} from the canvas centre after joining`,
    );
    pass(
      `follow camera: after joining the own body is ${(joinOffset.dx * 100).toFixed(1)}% and ${(joinOffset.dy * 100).toFixed(1)}% of the canvas from its centre`,
    );

    const { pathSteps, clicks } = await walkToToiletByClicks(label, shots.midWalk);

    phase(`${label}: close the door`);
    await tapCell(DOOR_AT);
    await page.waitForSelector('[data-play-menu] [data-action="door-close"]', { visible: true, timeout: 6_000 }).catch(async (error) => {
      const snap = (await playSnap()).body.result;
      const menuItems = await page.$$eval('[data-play-menu] button', (buttons) => buttons.map((button) => button.dataset.action).join(','));
      const menuText = await page.$eval('[data-play-menu]', (element) => element.textContent).catch(() => 'none');
      console.log(`  diag ${label}: menu=${menuItems} text=${menuText} door=${JSON.stringify(snap.objects.find((object) => samePos(object.pos, DOOR_AT)) ?? null)} pos=${JSON.stringify(snap.agent?.pos)} need=${snap.agent?.need} action=${JSON.stringify(snap.agent?.action)}`);
      throw error;
    });
    await waitEnabled('[data-play-menu] [data-action="door-close"]');
    if (shots.menu) await shot(shots.menu, `${label}: the door menu`, { checkWidth });
    await safeClick('[data-play-menu] [data-action="door-close"]').catch(async (error) => {
      const snap = (await playSnap()).body.result;
      const menuItems = await page.$$eval('[data-play-menu] button', (buttons) => buttons.map((button) => button.dataset.action).join(','));
      const menuText = await page.$eval('[data-play-menu]', (element) => element.textContent).catch(() => 'none');
      const hint = await page.$eval('[data-testid=play-hint]', (element) => element.textContent).catch(() => 'none');
      console.log(`  diag ${label}: after the shot menu=${menuItems} text=${menuText} hint=${hint} door=${JSON.stringify(snap.objects.find((object) => samePos(object.pos, DOOR_AT)) ?? null)} pos=${JSON.stringify(snap.agent?.pos)} tick=${snap.tick}`);
      throw error;
    });
    await waitPlay(
      (state) =>
        state.objects.some(
          (object) => samePos(object.pos, DOOR_AT) && object.kind === 'door' && !object.open && !object.site,
        ),
      `${label}: the door closed`,
      8_000,
    );

    await sleep(2_500);
    phase(`${label}: use`);
    await waitEnabled('[data-testid=play-use]').catch(async (error) => { const snap = (await playSnap()).body.result; console.log(`  diag ${label}: hint=${await page.$eval('[data-testid=play-hint]', (element) => element.textContent)} need=${snap.agent?.need} action=${JSON.stringify(snap.agent?.action)} pose=${snap.agent?.pose} pos=${JSON.stringify(snap.agent?.pos)} joined=${snap.joined}`); throw error; });
    await safeClick('[data-testid=play-use]');
    if (shots.using) {
      await waitPlay(
        (state) => (state.agent?.use_ticks_done ?? 0) >= 1 || state.agent?.outcome,
        `${label}: the use in progress`,
        8_000,
      );
      await shot(shots.using, `${label}: using the toilet`, { checkWidth });
    }
    const success = await waitPlay((state) => state.agent?.outcome === 'success', `${label}: a successful use`, 20_000).catch(async (error) => {
      const snap = (await playSnap()).body.result;
      console.log(`  diag ${label}: tick=${snap.tick} joined=${snap.joined} placement=${snap.placement} action=${JSON.stringify(snap.agent?.action ?? null)} done=${snap.agent?.use_ticks_done} total=${snap.agent?.use_ticks_total} outcome=${snap.agent?.outcome} deadline=${snap.agent?.deadline_tick} need=${snap.agent?.need} hint=${await page.$eval('[data-testid=play-hint]', (element) => element.textContent).catch(() => 'none')} pending=${await page.$eval('[data-testid=play-pending]', (element) => element.textContent).catch(() => 'none')}`);
      throw error;
    });
    const outcome = await page.$eval('[data-testid=play-outcome]', (element) => element.textContent?.trim() ?? '');
    assert(outcome.startsWith('成功'), `${label}: the result panel says ${JSON.stringify(outcome)} instead of 成功`);
    if (shots.success) await shot(shots.success, `${label}: the success panel`, { checkWidth });
    const successTick = success.body.result.tick;
    pass(
      `${label}: one-click far walk (${pathSteps} steps), ${clicks} clicks into the shack, closed the door, used, success at tick ${successTick}`,
    );
    await assertChinese(page, ['.play-feed', '.ui-card', '.ui-bottom'], `${label}: my events, card and bottom bar`);

    if (memory) {
      const walked = await centreOffset(me);
      assert(
        walked && walked.dx <= 0.15 && walked.dy <= 0.15,
        `${label}: the own body is ${JSON.stringify(walked)} from the canvas centre after the walk`,
      );
      pass(
        `follow camera: after the walk the own body is still ${(walked.dx * 100).toFixed(1)}% and ${(walked.dy * 100).toFixed(1)}% of the canvas from its centre`,
      );
      const here = (await playSnap()).body.result.agent.pos;
      const luma = await memoryLuma(here);
      assert(luma.far !== null, `${label}: no cell eight away from the human is on the canvas`);
      assert(
        luma.own > luma.far * 1.2,
        `${label}: own cell luminance ${luma.own.toFixed(1)} is not clearly above ${luma.far.toFixed(1)} eight cells away`,
      );
      await shot(shots.memory, `${label}: own cell and the cell eight away`, { checkWidth });
      pass(
        `memory shading: own cell luminance ${luma.own.toFixed(1)} vs ${luma.far.toFixed(1)} at ${luma.farCell.x},${luma.farCell.y}, outside the 9x9 window`,
      );
    }

    phase(`${label}: leave`);
    await leaveRound();
    if (checkWidth) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `${label}: the page scrolls horizontally by ${overflow}px at the end`);
    }
    return { successTick };
  } finally {
    keyboardForbidden = false;
  }
}

// Mixed stats count a human session only when an AI session overlaps it, and
// the deadline redraws before a round can outlast the parked AI's own deadline.
function ensureAiInWorld() {
  const state = cliStatus().state;
  if (state?.placement === 'inside' || state?.placement === 'waiting') return;
  const joined = run(LOO, ['join', '--sent-by', 'self', '--why', 'e2e'], { LOO_HOME: HOME }, { allowFail: true });
  const after = cliStatus().state;
  if (after?.placement !== 'inside' && after?.placement !== 'waiting') {
    throw new Error(`${AI_NICK} could not rejoin for the mixed round: ${joined.stdout}${joined.stderr ?? ''}`);
  }
}

async function parkAi() {
  const target = { x: ENTRANCE.x + 1, y: ENTRANCE.y - 1 };
  const fresh = cliStatus().state;
  if (fresh?.placement === 'inside' && fresh.deadline_tick - fresh.tick < 40) {
    run(LOO, ['leave'], { LOO_HOME: HOME });
    await sleep(800);
  }
  for (let step = 0; step < 24; step += 1) {
    const state = cliStatus().state;
    if (state?.placement === 'waiting') {
      await sleep(800);
      continue;
    }
    if (state?.placement !== 'inside') {
      run(LOO, ['join', '--sent-by', 'self', '--why', 'e2e'], { LOO_HOME: HOME });
      await sleep(800);
      continue;
    }
    const at = state.pos ? { x: state.pos.x, y: state.pos.y } : null;
    if (at && samePos(at, target)) return;
    if (at) {
      const dir = at.x < target.x ? 'E' : at.x > target.x ? 'W' : at.y > target.y ? 'N' : 'S';
      const moved = run(LOO, ['move', dir], { LOO_HOME: HOME }, { allowFail: true });
      if (moved.status === 3) await sleep(1_100);
    }
    await sleep(900);
  }
  throw new Error(`${AI_NICK} did not park at ${target.x},${target.y}; last status ${JSON.stringify(cliStatus().state ?? null).slice(0, 300)}`);
}

async function menuVsServer(label) {
  const terrain = (await getJSON('/api/terrain')).body;
  const W = terrain.width;
  const H = terrain.height;
  const now = async () => (await playSnap()).body.result;
  const usable = (state, cell) =>
    samePos(cell, state.agent.pos) ||
    (groundFree(state, terrain, cell) && findPath(state, W, H, cell) !== null);

  await joinWithRoom(label);
  let state = await now();
  const offEntrance = [];
  for (let y = state.window.origin.y; y < state.window.origin.y + state.window.height; y += 1) {
    for (let x = state.window.origin.x; x < state.window.origin.x + state.window.width; x += 1) {
      const cell = { x, y };
      if (dist(cell, ENTRANCE) < 2 || dist(cell, state.agent.pos) < 2) continue;
      if (samePos(cell, { x: ENTRANCE.x + 1, y: ENTRANCE.y - 1 })) continue;
      if (!usable(state, cell) || findPath(state, W, H, cell) === null) continue;
      offEntrance.push(cell);
    }
  }
  offEntrance.sort((a, b) => dist(a, ENTRANCE) - dist(b, ENTRANCE));
  assert(offEntrance.length > 0, 'no reachable cell two steps off the entrance');
  await goTo(offEntrance[0]);
  await parkAi();
  const aiCell = cliPos();
  assert(aiCell, `${AI_NICK} has no position`);
  state = (
    await waitPlay(
      (current) => current.agents.some((agent) => samePos(agent.pos, aiCell)),
      `${AI_NICK} in the human's window at ${aiCell.x},${aiCell.y}`,
      8_000,
    )
  ).body.result;
  const aiSeen = state.agents.find((agent) => samePos(agent.pos, aiCell));
  assert(aiSeen && aiSeen.nick === AI_NICK, `${AI_NICK} is not at ${aiCell.x},${aiCell.y} inside the human's window`);

  phase(`${label}: next to the AI`);
  const stand = neighbours(aiCell).find((cell) => usable(state, cell));
  assert(stand, `no reachable empty cell next to ${AI_NICK}`);
  await goTo(stand);
  state = await now();
  const aiLabels = await openMenuAt(aiCell);
  assert(
    aiLabels.includes('attack') && aiLabels.includes('defend') && !aiLabels.includes('move'),
    `the menu on ${AI_NICK} is ${aiLabels.join(', ')}`,
  );
  pass(`menu vs server: the menu on the AI next to the human offers ${aiLabels.join(', ')}`);

  const empty = neighbours(state.agent.pos).find((cell) => groundFree(state, terrain, cell));
  assert(empty, 'no empty ground next to the human');
  const emptyLabels = await openMenuAt(empty);
  for (const wanted of ['move', 'build-wall', 'build-door', 'build-toilet', 'defend']) {
    assert(emptyLabels.includes(wanted), `the menu on empty ground lacks ${wanted}: ${emptyLabels.join(', ')}`);
  }
  pass(`menu vs server: the menu on empty ground offers ${emptyLabels.join(', ')}`);

  await leaveRound();
  await parkAi();
  await joinWithRoom(`${label}: pillar`, MENU_ROUND_TICKS_REQUIRED);
  phase(`${label}: pillar`);
  const pillarPlans = [
    { stand: { x: 12, y: 12 }, pillar: { x: 12, y: 11 } },
    { stand: { x: 11, y: 11 }, pillar: { x: 12, y: 11 } },
    { stand: { x: 15, y: 11 }, pillar: { x: 14, y: 11 } },
    { stand: { x: 14, y: 12 }, pillar: { x: 14, y: 11 } },
  ];
  let pillarPlan = null;
  for (let guard = 0; guard < 8 && !pillarPlan; guard += 1) {
    state = await now();
    pillarPlan =
      pillarPlans.find(
        (plan) =>
          !objectAtState(state, plan.stand) &&
          !agentAtState(state, plan.stand) &&
          findPath(state, W, H, plan.stand) !== null,
      ) ?? null;
    if (pillarPlan) break;
    const here = state.agent.pos;
    const goal = pillarPlans[0].stand;
    const closer = [];
    for (let y = state.window.origin.y; y < state.window.origin.y + state.window.height; y += 1) {
      for (let x = state.window.origin.x; x < state.window.origin.x + state.window.width; x += 1) {
        const cell = { x, y };
        if (dist(cell, here) < 2 || dist(cell, goal) >= dist(here, goal)) continue;
        if (!usable(state, cell) || findPath(state, W, H, cell) === null) continue;
        closer.push(cell);
      }
    }
    closer.sort((a, b) => dist(a, goal) - dist(b, goal));
    assert(closer.length > 0, `no reachable cell in the window is closer to the pillar stands than ${here.x},${here.y}`);
    await goTo(closer[0]);
  }
  assert(pillarPlan, 'no free cell outside the shack next to a pillar is reachable');
  await goTo(pillarPlan.stand);
  state = await now();
  const pillar = state.objects.find((object) => object.kind === 'pillar' && samePos(object.pos, pillarPlan.pillar));
  assert(pillar, `no pillar at ${pillarPlan.pillar.x},${pillarPlan.pillar.y}`);
  const pillarLabels = await openMenuAt(pillar.pos);
  assert(pillarLabels.includes('demolish'), `the menu on the pillar is ${pillarLabels.join(', ')}`);
  await safeClick('[data-play-menu] [data-action="demolish"]');
  const demolish = await until(
    () =>
      page.evaluate(() => {
        const list = window.__e2e.actions.filter((action) => action.url.includes('/api/play/demolish'));
        return list.length > 0 ? list[list.length - 1] : null;
      }),
    { timeout: 6_000, interval: 50, label: 'the demolish response' },
  );
  assert(demolish.body?.ok === false, `the server accepted the pillar demolish: ${JSON.stringify(demolish.body).slice(0, 200)}`);
  const serverMessage = String(demolish.body.error?.message ?? '').replace(/\s+/g, ' ').trim();
  assert(serverMessage.length > 0, 'the server refusal carries no message');
  const rejected = await until(
    async () => {
      const bar = await actionBar();
      return bar && bar.state === 'rejected' ? bar : null;
    },
    { timeout: 4_000, interval: 50, label: 'the rejected bar after the pillar demolish' },
  );
  const expectedBar = zhReason(serverMessage);
  assert(
    rejected.text.includes(expectedBar),
    `the bar says ${JSON.stringify(rejected.text)}, not the server's ${JSON.stringify(serverMessage)} shown as ${JSON.stringify(expectedBar)}`,
  );
  pass(`menu vs server: the pillar demolish was refused by the server and the bar shows it: ${serverMessage}`);

  await leaveRound();
  await parkAi();
  await joinWithRoom(`${label}: wall`, MENU_ROUND_TICKS_REQUIRED);
  phase(`${label}: wall`);
  await walkToToiletByClicks(label);
  state = await now();
  const choices = [];
  for (const object of state.objects.filter((entry) => entry.kind === 'wall' && !entry.site)) {
    for (const cell of neighbours(object.pos)) {
      if (usable(state, cell) || samePos(cell, state.agent.pos)) choices.push({ wall: object, stand: cell });
    }
  }
  choices.sort((a, b) => dist(a.stand, state.agent.pos) - dist(b.stand, state.agent.pos));
  assert(choices.length > 0, 'no reachable cell next to a finished wall in the window');
  const { wall, stand: wallStand } = choices[0];
  await goTo(wallStand);
  const wallLabels = await openMenuAt(wall.pos);
  assert(
    wallLabels.includes('demolish') && !wallLabels.includes('build-wall'),
    `the menu on a wall is ${wallLabels.join(', ')}`,
  );
  pass(`menu vs server: the menu on a finished wall offers ${wallLabels.join(', ')} and no build-wall`);

  await leaveRound();
  run(LOO, ['leave'], { LOO_HOME: HOME }, { allowFail: true });
}

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
      '--use-angle=gl',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  page = await browser.newPage();
  await attachPage(page);
  mainPage = page;
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
  pass(`browser renderer is ${renderer}`);

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
      (name) => document.querySelector('.win[data-window="account"] .nick')?.textContent?.includes(name),
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
    await safeClick('[data-testid=play-create-open]');
    await page.waitForSelector('[data-window="create"] input[type=text]', { visible: true, timeout: 10_000 });
    await page.type('[data-window="create"] input[type=text]', HUMAN_NICK);
    await safeClick('[data-window="create"] [aria-label="颜色 4"]');
    await safeClick('[data-testid=play-create]');
    await page.waitForFunction(() => !document.querySelector('[data-window="create"]'), { timeout: 10_000 });
    await page.waitForSelector('[data-testid=play-join]', { timeout: 10_000 });
    const created = await waitPlay(() => true, 'the first play state');
    const humanId = created.body.result.me.agent_id;
    assert(created.body.result.me.nick === HUMAN_NICK, `page says the human nick is ${created.body.result.me.nick}`);
    pass(`created the human character ${HUMAN_NICK} (#${humanId}, colour 4) and /play offers 入场`);

    // --- combat session: CLI inside, visible, collision, attack ------------
    phase('spectator badge round');
    await joinWithRoom('badge round');
    // --- spectator badge ---------------------------------------------------
    phase('spectator human badge');
    const spectator = await browser.newPage();
    try {
      await spectator.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await spectator.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await spectator.waitForSelector('canvas[data-renderer="3d"]', { timeout: 10_000 });
      await spectator.waitForFunction(
        () => document.querySelector('.ui-clock .live') !== null,
        { timeout: 15_000 },
      );
      const projection = (await getJSON('/api/projection')).body.result;
      const human = projection.agents.find((agent) => agent.id === humanId);
      assert(human, `the live spectator does not show ${HUMAN_NICK}`);
      const at = await spectator.evaluate((id) => window.__looView.screenOf(id), humanId);
      assert(at, `the spectator renderer has no screen position for ${HUMAN_NICK} (#${humanId})`);
      await spectator.mouse.click(at.x, at.y);
      await spectator.waitForFunction(
        () => document.querySelector('.ui-card .tag.h')?.textContent?.includes('人'),
        { timeout: 8_000 },
      );
      const cardName = await spectator.$eval('.ui-card', (element) => element.textContent ?? '').catch(() => '');
      assert(cardName.includes(HUMAN_NICK), `the selected spectator card is not ${HUMAN_NICK}: ${cardName.slice(0, 120)}`);
      const spectatorTick = projection.tick;
      await screenshot(spectator, 'spectator-human-badge-1440.png', spectatorTick, `${HUMAN_NICK} selected, 人 badge`);
    } finally {
      await spectator.close();
    }
    await page.bringToFront();
    pass('spectator page marks the human character with the 人 badge');

    await leaveRound();
    pass('the badge round ended and the human left before the combat round');

    phase('join human (combat)');
    const joined = await joinWithRoom('combat round');
    assert(joined.body.result.agent?.need, 'the joined human has no need');
    assert(joined.body.result.agent?.deadline_tick > 0, 'the joined human has no deadline');
    await page.waitForSelector('.ui-bottom[data-mode="play"] .play-row', { visible: true, timeout: 5_000 });
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

    phase('/play requests: opened directly');
    await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ui-bottom[data-mode="play"]', { timeout: 10_000 });
    await sleep(1_500);
    const directUrls = await page.evaluate(() => window.__e2e.urls.slice());
    assert(!directUrls.some((url) => url.includes('/api/projection')), `/play requested /api/projection: ${directUrls.join(', ')}`);
    assert(!directUrls.some((url) => url.includes('/api/watch')), `/play requested /api/watch: ${directUrls.join(', ')}`);
    pass('/play made no /api/projection or /api/watch request (opened directly)');

    phase('/play requests: entered from the watch page');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.ui-clock .live') !== null, { timeout: 15_000 });
    const watchStreams = await page.evaluate(
      () => window.__e2e.sources.filter((source) => source.url.includes('/api/watch')).length,
    );
    assert(watchStreams > 0, 'the spectator page opened no /api/watch stream before the switch');
    await safeClick('[data-mode-btn="play"]');
    await page.waitForSelector('.ui-bottom[data-mode="play"]', { timeout: 10_000 });
    await page.evaluate(() => {
      window.__e2e.urls = [];
    });
    await sleep(1_500);
    const switchUrls = await page.evaluate(() => window.__e2e.urls.slice());
    assert(!switchUrls.some((url) => url.includes('/api/projection')), `/play requested /api/projection: ${switchUrls.join(', ')}`);
    assert(!switchUrls.some((url) => url.includes('/api/watch')), `/play requested /api/watch: ${switchUrls.join(', ')}`);
    const streamStates = await page.evaluate(() =>
      window.__e2e.sources.filter((source) => source.url.includes('/api/watch')).map((source) => source.readyState),
    );
    assert(
      streamStates.every((state) => state === 2),
      `the watch stream is still open after entering play (readyState ${streamStates.join(',')})`,
    );
    pass('/play made no /api/projection or /api/watch request (entered from the watch page)');

    phase('return to the play page');
    await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ui-bottom[data-mode="play"]', { timeout: 10_000 });

    // --- leave the combat session -----------------------------------------
    phase('leave combat session');
    await leaveRound();
    pass('left the combat session after the collision and attack');

    // --- clear the human's route and start a clean round ------------------
    phase('park the AI');
    await parkAi();
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
    phase('click-only round');
    await withFreshHuman(
      { username: 'play-e2e-click', nick: 'e2e-click', width: 1440, height: 900, touch: false },
      async () => {
        await clickOnlyRound({
          label: 'click-only round',
          memory: true,
          shots: {
            success: 'play-success-1440.png',
            memory: 'play-memory-1440.png',
          },
        });
        await shotSession('entry 1440', { entry: 'play-1440.png' });
        await shotSession('menu 1440', { menu: 'play-menu-1440.png' });
        await shotSession('using 1440', { using: 'play-using-1440.png' });
      },
    );

    phase('menu vs server');
    await withFreshHuman({ username: 'play-e2e-menu', nick: 'e2e-menu', width: 1440, height: 900, touch: false }, () =>
      menuVsServer('menu vs server'),
    );
    pass('menu vs server: every menu and the server refusal match');

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
      (nick) => document.querySelector('.win[data-window="leaderboard"] table')?.textContent?.includes(nick),
      { timeout: 10_000 },
      HUMAN_NICK,
    );
    const humanBadge = await page.$$eval('.win[data-window="leaderboard"] table .tag.h', (badges) => badges.map((badge) => badge.textContent?.trim()));
    assert(humanBadge.includes('人'), 'the human board row has no 人 badge');
    const boardTick = (await getJSON('/api/projection')).body.result.tick;
    await screenshot(page, 'leaderboard-human-1440.png', boardTick, '?kind=human');

    await page.goto(`${BASE}/leaderboard?kind=mixed`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (nick) => document.querySelector('.win[data-window="leaderboard"] table')?.textContent?.includes(nick),
      { timeout: 10_000 },
      HUMAN_NICK,
    );
    await screenshot(page, 'leaderboard-mixed-1440.png', boardTick, '?kind=mixed');

    await page.goto(`${BASE}/leaderboard?kind=ai`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document.querySelector('.win[data-window="leaderboard"] table') ||
        document.querySelector('.win[data-window="leaderboard"]')?.innerText.includes('暂无数据'),
      { timeout: 10_000 },
    );
    const aiBoardText = await page.$eval('.win[data-window="leaderboard"]', (element) => element.innerText);
    assert(!aiBoardText.includes(HUMAN_NICK), 'the AI board page shows the human e2e-human');
    pass('the AI board page does not show the human');

    phase('stats');
    await page.goto(`${BASE}/stats`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.win[data-window="stats"] .tiles', { timeout: 10_000 });
    await page.click('[data-scope=mixed]');
    await page.waitForFunction(
      () => document.querySelector('[data-scope=mixed]')?.getAttribute('aria-selected') === 'true',
      { timeout: 5_000 },
    );
    const mixedStats = (await getJSON('/api/stats')).body.result.mixed;
    assert(mixedStats.total_sessions > 0, 'the mixed stats total is empty');
    assert(mixedStats.human.sessions > 0, `the mixed human session count is ${mixedStats.human.sessions}`);
    assert(mixedStats.human.successes > 0, `the mixed human success count is ${mixedStats.human.successes}`);
    const cardText = await page.$$eval('.win[data-window="stats"] .even > section', (cards) => cards.map((card) => card.textContent?.replace(/\s+/g, ' ').trim()));
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
      await pressKey('ArrowRight');
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
    await pressKey('ArrowLeft');
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

    phase('touch round 390');
    await withFreshHuman(
      { username: 'play-e2e-touch', nick: 'e2e-touch', width: 390, height: 844, touch: true },
      async () => {
        await clickOnlyRound({
          label: 'touch round at 390',
          checkWidth: true,
          shots: { success: 'play-success-390.png' },
        });
        await shotSession('entry 390', { entry: 'play-390.png', checkWidth: true });
        await shotSession('menu 390', { menu: 'play-menu-390.png', checkWidth: true });
      },
    );

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
