// Real-Chrome end-to-end for the empty-world replay on `/`: a fresh database
// shows no replay badge, one CLI agent leaves behind a `demolish` highlight, the
// empty spectator page replays the window around it, and a second agent walking
// in switches the page back to live within two ticks.
//
// `scripts/e2e-k.sh` starts the official server and passes `BASE`, `ROOT` and
// `LOO`. Every successful step prints `PASS: ...`; a failure exits non-zero and
// prints what the page and the API said at that moment.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT || path.resolve(HERE, '../..');
const BASE = (process.env.BASE || 'http://127.0.0.1:18143').replace(/\/+$/, '');
const LOO = process.env.LOO || path.join(ROOT, 'target/release/loo');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const K = path.join(ROOT, '.conductor/k/k2');
const HOME1 = process.env.HOME_DIR || path.join(K, 'home');
const HOME2 = process.env.HOME_DIR2 || path.join(K, 'home2');
const SHOTS = path.join(ROOT, 'docs/screenshots');

const USERNAME = 'k2-e2e';
const PASSWORD = 'k2-password-1';
const NICK1 = 'k2-ai';
const NICK2 = 'k2-ai-2';

/** Same width the page uses, only to keep the tick samples off the wrap edge. */
const REPLAY_WINDOW_TICKS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let currentPhase = 'startup';
let browser = null;
let page = null;
let pageErrors = [];

function phase(name) {
  currentPhase = name;
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function until(condition, { timeout = 10_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await condition();
    if (last) return last;
    await sleep(interval);
  }
  fail(`timeout after ${timeout}ms waiting for ${label}; last=${JSON.stringify(last).slice(0, 300)}`);
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

/** `LOO_HOME` holds one identity: a second directory is a second agent. */
function loo(home, args, options) {
  return run(LOO, args, { LOO_HOME: home, LOO_SERVER: BASE }, options);
}

async function getJSON(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { headers: { accept: 'application/json' } });
  const body = await response.json();
  return { status: response.status, body };
}

async function projection() {
  const { body } = await getJSON('/api/projection');
  if (!body.ok || !body.result) {
    fail(`/api/projection failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result;
}

async function liveTick() {
  return (await projection()).tick;
}

async function screenshot(name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, type: 'png' });
  const { size } = fs.statSync(file);
  if (size < 5_000) fail(`${name} looks blank (${size} bytes)`);
  pass(`screenshot ${name} (${Math.round(size / 1024)} KB)`);
}

async function replayBadge() {
  return (await page.$('.replay-badge')) !== null;
}

/** The header chip reads `TICK 1,234`. */
async function pageTick() {
  return page.$eval('.chip.mono', (element) => {
    const match = element.textContent.match(/(\d[\d,]*)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  });
}

async function pageInside() {
  return page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll('.chip')).find((element) =>
      element.textContent.includes('在场'),
    );
    if (!chip) return null;
    const match = chip.textContent.match(/在场\s*(\d+)/);
    return match ? Number(match[1]) : null;
  });
}

// --- accounts --------------------------------------------------------------

/** Register the account, take a plaintext token, and seed a `LOO_HOME` with it. */
async function seedAccountToken() {
  const registered = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const registerBody = await registered.json();
  if (registered.status !== 200 || !registerBody.ok) {
    fail(`register failed: ${registered.status} ${JSON.stringify(registerBody).slice(0, 300)}`);
  }
  const cookies = registered.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  const csrf = cookies
    .map((cookie) => cookie.split('='))
    .find(([name]) => name === 'loo_csrf');
  if (!csrf) fail(`register did not set a loo_csrf cookie (${cookies.join(' | ')})`);

  const minted = await fetch(`${BASE}/api/account/token`, {
    method: 'POST',
    headers: {
      cookie: cookies.join('; '),
      'x-loo-csrf': csrf[1],
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const mintedBody = await minted.json();
  if (minted.status !== 200 || !mintedBody.ok || !mintedBody.result?.token) {
    fail(`token minting failed: ${minted.status} ${JSON.stringify(mintedBody).slice(0, 300)}`);
  }
  pass(`account ${USERNAME} registered and its token minted`);
  return mintedBody.result.token;
}

function writeHome(home, token) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ server: BASE, token }, null, 2),
    'utf8',
  );
}

// --- isolates --------------------------------------------------------------

async function buildableNeighbour(pos, grid) {
  const projectionNow = await projection();
  const offsets = [
    { dir: 'E', dx: 1, dy: 0 },
    { dir: 'N', dx: 0, dy: -1 },
    { dir: 'S', dx: 0, dy: 1 },
    { dir: 'W', dx: -1, dy: 0 },
  ];
  for (const offset of offsets) {
    const x = pos.x + offset.dx;
    const y = pos.y + offset.dy;
    if (grid.rows[y]?.[x] !== '.') continue;
    if (projectionNow.objects.some((object) => object.pos.x === x && object.pos.y === y)) continue;
    if (projectionNow.agents.some((agent) => agent.pos.x === x && agent.pos.y === y)) continue;
    return { ...offset, target: { x, y } };
  }
  return null;
}

async function objectAt(target) {
  const current = await projection();
  return current.objects.find((object) => object.pos.x === target.x && object.pos.y === target.y) ?? null;
}

// --- phases ----------------------------------------------------------------

async function phaseEmptyHome() {
  phase('empty home');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-intro', { timeout: 15_000 });
  // A fresh database has no markers, so the first settled frame must not replay.
  await until(async () => (await pageTick()) !== null, { timeout: 10_000, label: 'first live frame' });
  await sleep(600);
  if (await replayBadge()) fail('a fresh database shows the replay badge');
  pass(`fresh database: the spectator stays live at tick ${await liveTick()} with no replay badge`);
  await screenshot('home-empty-1440.png');
}

async function phaseHistory() {
  phase('history');
  const token = await seedAccountToken();
  writeHome(HOME1, token);

  const registered = loo(HOME1, [
    'register',
    '--name',
    NICK1,
    '--model',
    'e2e',
    '--intro',
    'replay e2e',
  ]);
  if (!/created|attached/.test(registered.stdout)) {
    fail(`loo register printed neither created nor attached:\n${registered.stdout}`);
  }
  pass(`CLI agent ${NICK1} registered`);

  loo(HOME1, ['join', '--sent-by', 'self', '--why', 'replay e2e']);
  pass(`CLI agent ${NICK1} joined the world`);

  const statusBody = JSON.parse(loo(HOME1, ['status', '--json']).stdout);
  const pos = statusBody.state?.pos;
  if (!pos) fail(`loo status carried no position: ${JSON.stringify(statusBody).slice(0, 300)}`);

  const grid = await (await fetch(`${BASE}/api/terrain`)).json();
  // The entrance row is a no-build corridor, so walk in until a `.` cell is
  // within reach; `here` is illegal for a wall and the queue lane is no-build.
  let site = await buildableNeighbour(pos, grid);
  for (let step = 0; !site && step < 10; step += 1) {
    loo(HOME1, ['move', 'E']);
    await sleep(800);
    const walked = JSON.parse(loo(HOME1, ['status', '--json']).stdout).state?.pos;
    if (!walked) fail('loo status lost the position while walking in');
    const reached = await buildableNeighbour(walked, grid);
    if (reached) {
      site = reached;
      pass(`walked east to (${walked.x}, ${walked.y}) to find a buildable neighbour`);
      break;
    }
  }
  if (!site) fail('no buildable cell is reachable from the entrance');

  loo(HOME1, ['build', 'wall', site.dir]);
  pass(`build wall ${site.dir} queued from (${pos.x}, ${pos.y}) to (${site.target.x}, ${site.target.y})`);

  loo(HOME1, ['wait', '--timeout', '2']);
  await until(
    async () => {
      const object = await objectAt(site.target);
      return object && object.kind === 'wall' && !object.site ? object : null;
    },
    { timeout: 10_000, interval: 100, label: 'the wall to finish' },
  );
  pass('the wall finished');

  loo(HOME1, ['demolish', site.dir]);
  loo(HOME1, ['wait', '--timeout', '2']);
  await until(async () => (await objectAt(site.target)) === null, {
    timeout: 10_000,
    interval: 100,
    label: 'the wall to come down',
  });
  pass('the wall was demolished');

  loo(HOME1, ['leave']);
  await until(async () => (await projection()).counts.inside === 0, {
    timeout: 10_000,
    interval: 100,
    label: 'an empty field',
  });
  pass('the field is empty again');

  const { body } = await getJSON('/api/timeline?from=0&to=999999');
  if (!body.ok) fail(`/api/timeline failed: ${JSON.stringify(body).slice(0, 300)}`);
  const markers = body.result?.markers ?? [];
  if (markers.length === 0) fail('the timeline has no markers after a build and a demolish');
  if (!markers.some((marker) => marker.kind === 'demolish')) {
    fail(`the timeline has no demolish marker: ${JSON.stringify(markers).slice(0, 300)}`);
  }
  pass(`the timeline carries ${markers.length} marker(s), including demolish`);
  return markers;
}

async function phaseReplay(markers) {
  phase('replay');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.replay-badge', { timeout: 3_000 });
  pass('the empty spectator page started replaying within 3s of the reload');

  // The window is `[to - 120, to]` and wraps every 30s; start the two samples
  // away from the wrap so a fresh cycle cannot hide the advance.
  const highlight = Math.max(...markers.map((marker) => marker.tick));
  const windowTo = Math.min(highlight, await liveTick());
  const windowFrom = Math.max(0, windowTo - REPLAY_WINDOW_TICKS);
  const wrapFloor = windowTo - 8;
  if (wrapFloor > windowFrom) {
    await until(async () => (await pageTick()) < wrapFloor, {
      timeout: 10_000,
      interval: 100,
      label: 'the replay to pass the window end',
    });
  }

  const firstTick = await pageTick();
  await sleep(1_000);
  const secondTick = await pageTick();
  const live = await liveTick();
  if (firstTick === null || secondTick === null) {
    fail(`the header carried no tick (${firstTick}, ${secondTick})`);
  }
  if (!(secondTick > firstTick)) {
    fail(`the replay did not advance: ${firstTick} then ${secondTick} (live ${live})`);
  }
  if (secondTick > live) {
    fail(`the replayed tick ${secondTick} is ahead of the live tick ${live}`);
  }
  pass(`replay advanced from tick ${firstTick} to ${secondTick} while live is at ${live}`);
  await screenshot('replay-empty-1440.png');
}

async function phaseBackLive() {
  phase('back live');
  const home1 = JSON.parse(fs.readFileSync(path.join(HOME1, 'config.json'), 'utf8'));
  writeHome(HOME2, home1.token);
  const registered = loo(HOME2, [
    'register',
    '--name',
    NICK2,
    '--model',
    'e2e',
    '--intro',
    'replay e2e two',
  ]);
  if (!/created|attached/.test(registered.stdout)) {
    fail(`the second loo register failed:\n${registered.stdout}`);
  }
  pass(`second CLI agent ${NICK2} registered`);

  if (!(await replayBadge())) fail('the replay badge is gone before the second agent joined');

  // `t0` is taken right before `join`: registration time is not switch latency.
  const t0 = await liveTick();
  const startedAt = Date.now();
  loo(HOME2, ['join', '--sent-by', 'self', '--why', 'replay e2e two']);
  await until(async () => !(await replayBadge()), {
    timeout: 10_000,
    interval: 50,
    label: 'the replay badge to disappear',
  });
  const elapsed = Date.now() - startedAt;
  const t1 = await liveTick();
  const inside = await pageInside();

  if (t1 - t0 > 2) {
    fail(`the page left replay ${t1 - t0} ticks after the join (t0 ${t0}, t1 ${t1}, ${elapsed} ms)`);
  }
  if (!(inside >= 1)) {
    fail(`the page still shows ${inside} agents inside after the join`);
  }
  pass(
    `replay switched back within ${t1 - t0} ticks (${elapsed} ms) at tick ${t1}; the page shows ${inside} inside`,
  );
  await screenshot('replay-back-live-1440.png');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await phaseEmptyHome();
  const markers = await phaseHistory();
  await phaseReplay(markers);
  await phaseBackLive();

  console.log('PASS: onboarding replay checks completed');
}

try {
  await main();
} catch (error) {
  console.error(`FAIL [${currentPhase}]: ${error.message}`);
  if (page) {
    try {
      const badge = await replayBadge();
      const ticks = await pageTick();
      const live = await liveTick().catch(() => null);
      console.error(`  .replay-badge present: ${badge}`);
      console.error(`  page tick: ${ticks}; live tick: ${live}`);
    } catch (probeError) {
      console.error(`  probe failed: ${probeError.message}`);
    }
  }
  if (pageErrors.length > 0) console.error(`  page errors: ${pageErrors.join(' | ')}`);
  process.exit(1);
} finally {
  if (browser) await browser.close();
}
