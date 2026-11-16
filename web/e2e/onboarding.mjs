// Real-Chrome end-to-end for the empty-world replay on `/`: a fresh database
// shows no replay badge, one CLI agent leaves behind a `demolish` highlight, the
// empty spectator page loops the last replayable span, and a second agent
// walking in switches the page back to live within two ticks. The spans from
// `/api/timeline` are checked against the empty stretch between the two agents,
// and `/replay` is driven through its span navigation.
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

/** The shell's top-left clock carries `● 回放` while the page replays. */
async function replayBadge() {
  return page.evaluate(() => {
    const badge = document.querySelector('.ui-clock .live.rp');
    return badge !== null && badge.textContent.includes('回放');
  });
}

/** The shell's top-left clock reads `TICK 1234`. */
async function pageTick() {
  return page.$eval('.ui-clock .big', (element) => {
    const match = element.textContent.match(/(\d[\d,]*)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  });
}

async function pageInside() {
  return page.evaluate(() => {
    const chip = document.querySelector('.ui-navr .cnt');
    if (!chip) return null;
    const match = chip.textContent.match(/在场\s*(\d+)/);
    return match ? Number(match[1]) : null;
  });
}

/** The whole recording: `{ from, to, markers, spans }`. */
async function timeline() {
  const { body } = await getJSON('/api/timeline?from=0&to=999999');
  if (!body.ok || !Array.isArray(body.result?.spans)) {
    fail(`/api/timeline carries no spans: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result;
}

function spanOf(spans, tick) {
  return spans.find((span) => tick >= span.from && tick <= span.to) ?? null;
}

/** `/replay` keeps its tick in the numeric field next to the transport. */
async function replayPageTick() {
  const value = await page.$eval('.tick-input', (input) => input.value);
  return value === '' ? null : Number(value);
}

async function clickReplayButton(label) {
  const clicked = await page.evaluate((aria) => {
    const button = document.querySelector(`button[aria-label="${aria}"]`);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) fail(`the ${label} button is missing or disabled`);
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
  await page.waitForSelector('[data-intro]', { timeout: 15_000 });
  // A fresh database has no markers, so the first settled frame must not replay.
  await until(async () => (await pageTick()) !== null, { timeout: 10_000, label: 'first live frame' });
  await sleep(600);
  if (await replayBadge()) fail('a fresh database shows the replay badge');
  pass(`fresh database: the spectator stays live at tick ${await liveTick()} with no replay badge`);
  await screenshot('home-empty-1440.png');

  // No spans yet: `/replay` says so instead of drawing a fake rail, and only the
  // transport is disabled (the tick field still takes a jump).
  await page.goto(`${BASE}/replay`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.replay-timeline', { timeout: 10_000 });
  await until(async () => (await page.$('.timeline-empty')) !== null, {
    timeout: 10_000,
    interval: 50,
    label: 'the empty replay notice',
  });
  const notice = await page.$eval('.timeline-empty', (element) => element.textContent.trim());
  if (notice !== '没有可回放的区间') fail(`the empty replay notice reads ${notice}`);
  const emptyState = await page.evaluate(() => ({
    rail: document.querySelector('.marker-track') !== null,
    play: document.querySelector('button.transport')?.disabled ?? null,
    field: document.querySelector('.tick-input')?.disabled ?? null,
  }));
  if (emptyState.rail) fail('a world without spans still draws the rail');
  if (emptyState.play !== true) fail('the transport is not disabled without spans');
  if (emptyState.field !== false) fail('the tick field is disabled without spans');
  pass('/replay without spans shows 没有可回放的区间, no rail, and a disabled transport');

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-intro]', { timeout: 15_000 });
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

  // A tick is replayable while somebody stands in the world. One agent joined,
  // worked and left, so there is exactly one settled span, and the ticks after
  // its end hold nobody.
  const spans = body.result?.spans ?? [];
  if (spans.length === 0) fail('the timeline has replayable ticks but no spans');
  spans.forEach((span, index) => {
    if (!(span.from <= span.to)) fail(`span ${index} is inverted: ${JSON.stringify(span)}`);
    if (span.from < 0) fail(`span ${index} starts before tick 0: ${JSON.stringify(span)}`);
  });
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const next = spans[index];
    if (next.from <= previous.to) {
      fail(`spans ${index - 1} and ${index} overlap: ${JSON.stringify(spans)}`);
    }
    if (!(next.from > previous.to + 1)) {
      fail(`spans ${index - 1} and ${index} touch with no empty tick between them: ${JSON.stringify(spans)}`);
    }
  }
  pass(`spans are closed, ascending and separated: ${JSON.stringify(spans)}`);

  // The field is empty right now: its ticks must not sit in any span.
  const lastSpan = spans[spans.length - 1];
  const emptyTo = await liveTick();
  if (emptyTo <= lastSpan.to) {
    fail(`the field is empty at tick ${emptyTo} but the last span runs to ${lastSpan.to}`);
  }
  for (let probe = lastSpan.to + 1; probe <= emptyTo; probe += 1) {
    if (spanOf(spans, probe)) {
      fail(`tick ${probe} holds nobody but sits in a span: ${JSON.stringify(spans)}`);
    }
  }
  pass(`the empty ticks ${lastSpan.to + 1}..${emptyTo} are in no span`);
  return markers;
}

async function phaseReplay() {
  phase('replay');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => replayBadge(), { timeout: 3_000, interval: 50, label: 'the replay badge' });
  pass('the empty spectator page started replaying within 3s of the reload');

  const { spans } = await timeline();
  if (spans.length === 0) fail('the empty world has no replayable span to loop');
  const span = spans[spans.length - 1];
  const live = await liveTick();
  if (span.to > live) {
    fail(`the looped span [${span.from}, ${span.to}] reaches past the live tick ${live}`);
  }

  // The auto replay loops exactly this span. Sample the four-tick-per-second
  // loop until it wraps once: every tick must sit inside the span, every step
  // must be the next tick, and the wrap must go back to the span's first tick
  // instead of walking into the empty ticks after the last one.
  const samples = [];
  let wrapped = false;
  const deadline = Date.now() + 30_000;
  while (!wrapped) {
    if (Date.now() > deadline) {
      fail(`the replay never wrapped back to tick ${span.from}; samples: ${samples.slice(-12).join(',')}`);
    }
    const tick = await pageTick();
    if (tick === null) fail('the header carried no tick while replaying');
    if (samples.length > 0) {
      const previous = samples[samples.length - 1];
      if (previous === span.to && tick === span.from) {
        wrapped = true;
      } else if (tick !== previous && tick !== previous + 1) {
        fail(
          `the replay jumped from tick ${previous} to ${tick} inside span [${span.from}, ${span.to}]`,
        );
      }
    }
    if (!spanOf([span], tick)) {
      fail(`the replay showed tick ${tick}, which is not in the last span [${span.from}, ${span.to}]`);
    }
    samples.push(tick);
    await sleep(40);
  }
  pass(
    `the replay looped span [${span.from}, ${span.to}] tick by tick and wrapped back to ${span.from} after ${samples.length} samples`,
  );
  await screenshot('replay-empty-1440.png');
  pass(`replay-empty-1440.png is replay frame tick ${await pageTick()} while live is at ${await liveTick()}`);
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
  const status = (await page.$('.ui-clock .live:not(.rp)')) !== null ? 'live' : 'not live';

  if (t1 - t0 > 2) {
    fail(`the page left replay ${t1 - t0} ticks after the join (t0 ${t0}, t1 ${t1}, ${elapsed} ms)`);
  }
  if (!(inside >= 1)) {
    fail(`the page still shows ${inside} agents inside after the join`);
  }
  if (status !== 'live') {
    fail(`the page status is ${status} after the join, not live`);
  }
  pass(
    `replay switched back within ${t1 - t0} ticks (${elapsed} ms) at tick ${t1}; the page shows ${inside} inside and status=live`,
  );
  await screenshot('replay-back-live-1440.png');
}

async function phaseReplayPage() {
  phase('replay page');
  const { spans } = await timeline();
  if (spans.length < 2) {
    fail(`/replay needs at least two spans to navigate, got ${JSON.stringify(spans)}`);
  }
  const first = spans[0];
  const second = spans[1];
  const last = spans[spans.length - 1];

  // No `?tick=`: the page opens on the first tick of the last span.
  await page.goto(`${BASE}/replay`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.marker-track', { timeout: 10_000 });
  await until(async () => (await replayPageTick()) === last.from, {
    timeout: 10_000,
    interval: 50,
    label: `the default tick to be the last span start ${last.from}`,
  });
  pass(`/replay without ?tick= opens at tick ${last.from}, the first tick of the last span`);

  const segments = await page.$$eval('.span-segment', (nodes) => nodes.length);
  if (segments !== spans.length) {
    fail(`the rail drew ${segments} segment(s) for ${spans.length} span(s)`);
  }

  // 第一段 jumps to the first span's start; playback then walks one tick at a
  // time (the server ticks every 0.5s, so a step lands well inside 5s).
  await clickReplayButton('第一段');
  await until(async () => (await replayPageTick()) === first.from, {
    timeout: 5_000,
    interval: 50,
    label: `第一段 to land on tick ${first.from}`,
  });
  pass(`第一段 jumped to tick ${first.from}`);
  await screenshot('replay-spans-1440.png');
  pass(`replay-spans-1440.png shows span 1/${spans.length} at tick ${await replayPageTick()}`);

  await clickReplayButton('播放');
  let previous = await replayPageTick();
  for (let step = 1; step <= 3; step += 1) {
    const next = await until(
      async () => {
        const current = await replayPageTick();
        return current !== null && current !== previous ? current : null;
      },
      { timeout: 5_000, interval: 30, label: `playback step ${step}` },
    );
    if (next !== previous + 1) {
      fail(`playback moved from tick ${previous} to ${next}, not one tick at a time`);
    }
    previous = next;
  }
  await clickReplayButton('暂停');
  pass(`playback advanced three ticks one by one to tick ${previous}`);

  // 下一段 jumps to the next span's start, and the label names that span.
  await clickReplayButton('下一段');
  await until(async () => (await replayPageTick()) === second.from, {
    timeout: 5_000,
    interval: 50,
    label: `下一段 to land on tick ${second.from}`,
  });
  const labels = await page.$eval('.replay-timeline', (element) => element.innerText);
  if (labels.includes('高光')) fail(`the timeline still shows 高光: ${labels.slice(0, 240)}`);
  if (!labels.includes(`第 2/${spans.length} 段`)) {
    fail(`the span label is missing from ${JSON.stringify(labels.slice(0, 240))}`);
  }
  pass(`下一段 jumped to tick ${second.from} and the label reads 第 2/${spans.length} 段`);

  // A shared link to an empty tick still works: it snaps to the end of the span
  // before it instead of opening on a stretch nobody can replay.
  const gapTick = first.to + 1;
  if (spanOf(spans, gapTick)) fail(`tick ${gapTick} was meant to be empty: ${JSON.stringify(spans)}`);
  await page.goto(`${BASE}/replay?tick=${gapTick}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.marker-track', { timeout: 10_000 });
  await until(async () => (await replayPageTick()) === first.to, {
    timeout: 10_000,
    interval: 50,
    label: `?tick=${gapTick} to snap to ${first.to}`,
  });
  pass(`?tick=${gapTick} (nobody inside) snapped to tick ${first.to}, the end of the span before it`);

  // The rail and the four span buttons must fit a phone without sideways scroll.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/replay`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.marker-track', { timeout: 10_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) fail(`/replay overflows horizontally at 390px by ${overflow}px`);
  pass('/replay fits 390px without horizontal overflow');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await puppeteer.launch({
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
  page = await browser.newPage();
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
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await phaseEmptyHome();
  const markers = await phaseHistory();
  await phaseReplay(markers);
  await phaseBackLive();
  await phaseReplayPage();

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
      console.error(`  replay badge (.ui-clock .live.rp 回放) present: ${badge}`);
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
