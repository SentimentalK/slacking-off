import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = { headed: false, gpu: false, matrix: false, ladder: false, auto: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--headed') args.headed = true;
    else if (key === '--gpu') args.gpu = true;
    else if (key === '--matrix') args.matrix = true;
    else if (key === '--ladder') args.ladder = true;
    else if (key === '--auto') args.auto = true;
    else args[key.replace(/^--/, '')] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['base', 'fixture', 'out']) {
  if (!args[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}

const WARM_MS = 5000;
const MEASURE_MS = 20000;
const CONFIGS = [
  { width: 1440, height: 900, quality: 'high' },
  { width: 1440, height: 900, quality: 'medium' },
  { width: 1440, height: 900, quality: 'low' },
  { width: 390, height: 844, quality: 'low' },
];

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
const windowArgs = [`--window-size=1440,900`];
const backgroundArgs = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
const headlessArgs = args.headed
  ? backgroundArgs
  : args.gpu
    ? ['--headless=new', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', ...backgroundArgs]
    : ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|no webgl2/i;
const fixtureParam = args.fixture.startsWith('/api/') ? args.fixture : `/@fs${args.fixture}`;

const MATRIX_LOAD_LIMIT = 8;
const MATRIX_LOAD_CHECK_MS = 60000;
const MATRIX_ATTEMPTS = 4;
const readLoad = () => readFileSync('/proc/loadavg', 'utf8').trim();
const load1 = () => Number(readLoad().split(' ')[0]);

async function waitForQuietLoad() {
  while (load1() > MATRIX_LOAD_LIMIT) {
    console.error(`load ${load1()} > ${MATRIX_LOAD_LIMIT}; pausing ${MATRIX_LOAD_CHECK_MS / 1000}s`);
    await sleep(MATRIX_LOAD_CHECK_MS);
  }
}

function matrixGroups() {
  const groups = [];
  for (const scale of [1, 0.75, 0.6]) {
    for (const grass of [1, 0.5, 0.25, 0]) {
      for (const shadow of [2048, 1024, 512, 0]) {
        groups.push({ width: 1440, height: 900, quality: 'high', scale, grass, shadow });
      }
    }
  }
  groups.push({ width: 390, height: 844, quality: 'low', scale: 0.75, grass: 0.5, shadow: 1024 });
  groups.push({ width: 390, height: 844, quality: 'low', scale: 1, grass: 0, shadow: 0 });
  return groups;
}

const groupName = (g) => `${g.width}x${g.height}-${g.quality}-${g.scale}-${g.grass}-${g.shadow}`;
const shotName = (g) => `${g.width === 1440 ? '' : `${g.width}-`}${g.scale}-${g.grass}-${g.shadow}`;

async function measureGroup(group, shotPath) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: !args.headed,
    defaultViewport: null,
    args: ['--no-sandbox', '--hide-scrollbars', ...headlessArgs, `--window-size=${group.width},${group.height}`],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: group.width, height: group.height, deviceScaleFactor: 1 });
    const query = [
      'animate=1',
      `fixture=${fixtureParam}`,
      `quality=${group.quality}`,
      ...(group.manual ? [] : [`scale=${group.scale}`, `grass=${group.grass}`, `shadow=${group.shadow}`]),
    ].join('&');
    await page.goto(`${args.base}/scene.html?${query}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__looReady === true', { timeout: 120000 });
    await sleep(WARM_MS);
    const loadBefore = load1();
    await page.evaluate(() => {
      window.__looFrames = [];
    });
    await sleep(MEASURE_MS);
    const procLoad = readLoad();
    const stamps = await page.evaluate(() => window.__looFrames ?? []);
    const intervals = [];
    for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);
    const sorted = intervals.slice().sort((a, b) => a - b);
    const frameMs = sorted.length > 0 ? percentile(sorted, 0.5) : 0;
    const p90 = sorted.length > 0 ? percentile(sorted, 0.9) : 0;
    const capture = await page.evaluate(() => window.__looCapture());
    await page.screenshot({ path: shotPath });
    const gpuName = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no webgl2';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'UNMASKED_RENDERER unavailable';
    });
    return {
      frames: stamps.length,
      median_frame_ms: Math.round(frameMs * 100) / 100,
      median_fps: frameMs > 0 ? Math.round((1000 / frameMs) * 10) / 10 : 0,
      p10_fps: p90 > 0 ? Math.round((1000 / p90) * 10) / 10 : 0,
      calls: capture.calls,
      triangles: capture.triangles,
      load1_before: loadBefore,
      load1_after: load1(),
      proc_loadavg: procLoad,
      gpu: gpuName,
    };
  } finally {
    await browser.close();
  }
}

async function runMatrix() {
  if (!args.gpu) {
    console.error('--matrix needs --gpu (real GPU only)');
    process.exit(2);
  }
  const outDir = path.dirname(args.out);
  const shotsDir = path.join(outDir, 'matrix-shots');
  mkdirSync(shotsDir, { recursive: true });
  const groups = matrixGroups();
  const records = groups.map((g) => ({ ...g, name: groupName(g), attempts: [] }));
  let gpuSeen = '';

  const measureRound = async (list) => {
    for (const rec of list) {
      for (let attempt = 1; attempt <= MATRIX_ATTEMPTS; attempt += 1) {
        await waitForQuietLoad();
        const shot = path.join(shotsDir, `${shotName(rec)}.png`);
        const m = await measureGroup(rec, shot);
        if (!gpuSeen) gpuSeen = m.gpu;
        if (SOFTWARE.test(m.gpu)) {
          console.error(`asked for a real GPU but Chrome rendered with: ${m.gpu}`);
          process.exit(1);
        }
        rec.attempts.push(m);
        console.log(JSON.stringify({ name: rec.name, attempt, ...m }));
        if (m.load1_after <= MATRIX_LOAD_LIMIT) break;
      }
    }
  };

  await measureRound(records);
  for (let round = 1; round < MATRIX_ATTEMPTS; round += 1) {
    const flagged = records.filter((r) => r.attempts[r.attempts.length - 1].load1_after > MATRIX_LOAD_LIMIT);
    if (flagged.length === 0) break;
    console.error(`${flagged.length} group(s) measured above load ${MATRIX_LOAD_LIMIT}; re-measuring after load recovers`);
    await measureRound(flagged);
  }

  const rows = records.map((r) => {
    const last = r.attempts[r.attempts.length - 1];
    return {
      name: r.name,
      viewport: `${r.width}x${r.height}`,
      quality: r.quality,
      scale: r.scale,
      grass: r.grass,
      shadow: r.shadow,
      frames: last.frames,
      median_frame_ms: last.median_frame_ms,
      median_fps: last.median_fps,
      p10_fps: last.p10_fps,
      calls: last.calls,
      triangles: last.triangles,
      load1_before: last.load1_before,
      load1_after: last.load1_after,
      proc_loadavg: last.proc_loadavg,
      load_ok: last.load1_after <= MATRIX_LOAD_LIMIT,
      attempts: r.attempts.map((a) => ({ median_fps: a.median_fps, load1_before: a.load1_before, load1_after: a.load1_after })),
      shot: path.join('matrix-shots', `${shotName(r)}.png`),
    };
  });

  const report = {
    fixture: args.fixture,
    chrome: await (async () => {
      const b = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', ...headlessArgs] });
      try {
        return await b.version();
      } finally {
        await b.close();
      }
    })(),
    gpu: gpuSeen,
    load_limit: MATRIX_LOAD_LIMIT,
    groups: rows,
  };
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  const sortedRows = rows.slice().sort((a, b) => b.median_fps - a.median_fps);
  const md = [
    '# 帧率矩阵（crowd.json：12 人在场 + 10 人排队，animate=1，预热 5 s 后采 20 s）',
    '',
    `GPU: ${gpuSeen}`,
    '',
    '| # | 视口 | 档位 | scale | grass | shadow | 中位帧时 (ms) | 中位 fps | p10 fps | 测时 load1 前→后 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...sortedRows.map((r, i) => {
      const note = r.load_ok ? (r.attempts.length > 1 ? `重测 ${r.attempts.length - 1} 次` : '') : '负载未恢复，未达标';
      return `| ${i + 1} | ${r.viewport} | ${r.quality} | ${r.scale} | ${r.grass} | ${r.shadow} | ${r.median_frame_ms} | ${r.median_fps} | ${r.p10_fps} | ${r.load1_before} → ${r.load1_after} | ${note} |`;
    }),
    '',
  ].join('\n');
  writeFileSync(path.join(outDir, 'matrix.md'), md);
  console.log(md);
}

const LADDER_LOAD_LIMIT = 4;
const CHROME_WAIT_MS = 30 * 60 * 1000;

const countOtherHeadless = () => Number(execSync("ps -eo cmd | grep -c '[c]hrome.*headless'", { encoding: 'utf8' }).trim());

async function waitForLoadAtMost(limit) {
  while (load1() > limit) {
    console.error(`load ${load1()} > ${limit}; pausing ${MATRIX_LOAD_CHECK_MS / 1000}s`);
    await sleep(MATRIX_LOAD_CHECK_MS);
  }
}

async function waitForOtherChrome() {
  const started = Date.now();
  let count = countOtherHeadless();
  while (count > 0 && Date.now() - started < CHROME_WAIT_MS) {
    console.error(`${count} other headless chrome process(es); waiting`);
    await sleep(MATRIX_LOAD_CHECK_MS);
    count = countOtherHeadless();
  }
  return count;
}

const LADDER_KNOBS = [
  { scale: 1, grass: 1, shadow: 2048 },
  { scale: 0.75, grass: 1, shadow: 2048 },
  { scale: 0.75, grass: 0.5, shadow: 1024 },
  { scale: 0.6, grass: 0.5, shadow: 1024 },
  { scale: 0.6, grass: 0.25, shadow: 512 },
  { scale: 0.75, grass: 0, shadow: 0 },
];

async function runLadder() {
  if (!args.gpu) {
    console.error('--ladder needs --gpu (real GPU only)');
    process.exit(2);
  }
  const outDir = path.dirname(args.out);
  const shotsDir = path.join(outDir, 'ladder-shots');
  mkdirSync(shotsDir, { recursive: true });
  const otherChrome = await waitForOtherChrome();
  const groups = [
    ...LADDER_KNOBS.map((k, i) => ({ name: `ladder-${i}`, width: 1440, height: 900, quality: 'high', ...k })),
    { name: 'manual-high', width: 1440, height: 900, quality: 'high', manual: true },
    { name: 'manual-medium', width: 1440, height: 900, quality: 'medium', manual: true },
    { name: 'manual-low', width: 1440, height: 900, quality: 'low', manual: true },
    { name: 'phone-low', width: 390, height: 844, quality: 'low', manual: true },
    { name: 'phone-0.75-0.5-1024', width: 390, height: 844, quality: 'low', scale: 0.75, grass: 0.5, shadow: 1024 },
  ];
  const rows = [];
  let gpuSeen = '';
  for (const g of groups) {
    const attempts = [];
    for (let attempt = 1; attempt <= MATRIX_ATTEMPTS; attempt += 1) {
      await waitForLoadAtMost(LADDER_LOAD_LIMIT);
      const m = await measureGroup(g, path.join(shotsDir, `${g.name}.png`));
      if (!gpuSeen) gpuSeen = m.gpu;
      if (SOFTWARE.test(m.gpu)) {
        console.error(`asked for a real GPU but Chrome rendered with: ${m.gpu}`);
        process.exit(1);
      }
      attempts.push({ attempt, ...m });
      console.log(JSON.stringify({ name: g.name, attempt, ...m }));
      if (m.load1_after <= LADDER_LOAD_LIMIT) break;
    }
    const last = attempts[attempts.length - 1];
    rows.push({ name: g.name, viewport: `${g.width}x${g.height}`, quality: g.quality, scale: g.manual ? 'tier' : g.scale, grass: g.manual ? 'tier' : g.grass, shadow: g.manual ? 'tier' : g.shadow, median_frame_ms: last.median_frame_ms, median_fps: last.median_fps, p10_fps: last.p10_fps, load1_before: last.load1_before, load1_after: last.load1_after, load_ok: last.load1_after <= LADDER_LOAD_LIMIT, attempts: attempts.map((a) => ({ attempt: a.attempt, median_fps: a.median_fps, load1_before: a.load1_before, load1_after: a.load1_after })) });
  }
  const report = { load_limit: LADDER_LOAD_LIMIT, other_headless_chrome_before_start: otherChrome, gpu: gpuSeen, fixture: args.fixture, groups: rows };
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# 画质阶梯与手选档帧率（1440×900 为 crowd.json 12 人在场 + 10 人排队；390×844 为 crowd.json）',
    '',
    `GPU: ${gpuSeen}`,
    `测前其他无头 Chrome 进程数：${otherChrome}${otherChrome > 0 ? '（超过 30 分钟等待后照测，结果已标注）' : ''}`,
    '',
    '| 组 | 视口 | 档位 | scale | grass | shadow | 中位帧时 (ms) | 中位 fps | p10 fps | 测时 load1 前→后 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows
      .slice()
      .sort((a, b) => b.median_fps - a.median_fps)
      .map((r) => `| ${r.name} | ${r.viewport} | ${r.quality} | ${r.scale} | ${r.grass} | ${r.shadow} | ${r.median_frame_ms} | ${r.median_fps} | ${r.p10_fps} | ${r.load1_before} → ${r.load1_after} | ${r.load_ok ? (r.attempts.length > 1 ? `重测 ${r.attempts.length - 1} 次` : '') : '负载未恢复'} |`),
    '',
  ].join('\n');
  writeFileSync(path.join(outDir, 'ladder.md'), md);
  console.log(md);
}

async function sampleFps(page, ms) {
  await page.evaluate(() => {
    window.__fpsStamps = [];
    const frame = (t) => {
      window.__fpsStamps.push(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await sleep(ms);
  const stamps = await page.evaluate(() => window.__fpsStamps ?? []);
  const intervals = [];
  for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);
  const sorted = intervals.slice().sort((a, b) => a - b);
  const med = sorted.length > 0 ? percentile(sorted, 0.5) : 0;
  const p90 = sorted.length > 0 ? percentile(sorted, 0.9) : 0;
  return {
    frames: stamps.length,
    median_frame_ms: Math.round(med * 100) / 100,
    median_fps: med > 0 ? Math.round((1000 / med) * 10) / 10 : 0,
    p10_fps: p90 > 0 ? Math.round((1000 / p90) * 10) / 10 : 0,
  };
}

async function waitForSettle(page) {
  await page.waitForFunction(
    () => (window.__looQualityLog ?? []).some((e) => e.event === 'settle'),
    { timeout: 40000, polling: 250 },
  );
  return page.evaluate(() => window.__looQualityLog ?? []);
}

async function runAuto() {
  if (!args.gpu) {
    console.error('--auto needs --gpu (real GPU only)');
    process.exit(2);
  }
  const otherChrome = await waitForOtherChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: null,
    args: ['--no-sandbox', '--hide-scrollbars', ...headlessArgs, '--window-size=1440,900'],
  });
  const runs = [];
  try {
    const context = await browser.createBrowserContext();
    for (const run of [1, 2]) {
      await waitForLoadAtMost(LADDER_LOAD_LIMIT);
      const loadBefore = load1();
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${args.base}/`, { waitUntil: 'load' });
      const log = await waitForSettle(page);
      const settle = log.filter((e) => e.event === 'settle').at(-1);
      const settledIndex = settle.to;
      const fps = await sampleFps(page, 20000);
      const shot = path.join(path.dirname(args.out), `auto-run${run}.png`);
      await page.screenshot({ path: shot });
      const gpuName = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return 'no webgl2';
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'UNMASKED_RENDERER unavailable';
      });
      if (SOFTWARE.test(gpuName)) {
        console.error(`asked for a real GPU but Chrome rendered with: ${gpuName}`);
        process.exit(1);
      }
      runs.push({ run, load1_before: loadBefore, load1_after: load1(), settled_index: settledIndex, settled_settings: LADDER_KNOBS[settledIndex], log, fps_after_settle: fps, gpu: gpuName, shot: path.basename(shot) });
      console.log(JSON.stringify({ run, settled_index: settledIndex, fps, load1_before: loadBefore, load1_after: load1() }));
      await page.close();
    }
    await context.close();
  } finally {
    await browser.close();
  }
  const report = { base: args.base, other_headless_chrome_before_start: otherChrome, load_limit: LADDER_LOAD_LIMIT, runs };
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(runs.map((r) => ({ run: r.run, settled: r.settled_index, fps: r.fps_after_settle.median_fps }))));
}

if (args.matrix) {
  await runMatrix();
  process.exit(0);
}
if (args.ladder) {
  await runLadder();
  process.exit(0);
}
if (args.auto) {
  await runAuto();
  process.exit(0);
}

const results = [];
let chromeVersion = '';
let gpu = '';

const ONLY = process.env.L_PERF_ONLY;
const selected = CONFIGS.filter((c) => !ONLY || `${c.width}-${c.quality}` === ONLY);
if (selected.length === 0) {
  console.error(`L_PERF_ONLY=${ONLY} matches nothing; use one of ${CONFIGS.map((c) => `${c.width}-${c.quality}`).join(', ')}`);
  process.exit(2);
}
for (const config of selected) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: !args.headed,
    defaultViewport: null,
    args: ['--no-sandbox', '--hide-scrollbars', ...headlessArgs, ...windowArgs],
  });
  try {
    chromeVersion = await browser.version();
    const page = await browser.newPage();
    await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: 1 });
    const query = [
      'animate=1',
      `fixture=${fixtureParam}`,
      `quality=${config.quality}`,
    ].join('&');
    await page.goto(`${args.base}/scene.html?${query}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__looReady === true', { timeout: 120000 });
    await sleep(WARM_MS);
    await page.evaluate(() => {
      window.__looFrames = [];
    });
    await sleep(MEASURE_MS);
    const stamps = await page.evaluate(() => window.__looFrames ?? []);
    const intervals = [];
    for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);
    const sorted = intervals.slice().sort((a, b) => a - b);
    const median = sorted.length > 0 ? percentile(sorted, 0.5) : 0;
    const p90 = sorted.length > 0 ? percentile(sorted, 0.9) : 0;
    const capture = await page.evaluate(() => window.__looCapture());
    if (!gpu) {
      gpu = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return 'no webgl2';
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'UNMASKED_RENDERER unavailable';
      });
    }
    results.push({
      width: config.width,
      height: config.height,
      quality: config.quality,
      frames: stamps.length,
      median_fps: median > 0 ? Math.round((1000 / median) * 10) / 10 : 0,
      p10_fps: p90 > 0 ? Math.round((1000 / p90) * 10) / 10 : 0,
      calls: capture.calls,
      triangles: capture.triangles,
    });
    if ((args.gpu || args.headed) && SOFTWARE.test(gpu)) {
      console.error(`asked for a real GPU but Chrome rendered with: ${gpu}`);
      process.exit(1);
    }
    console.log(JSON.stringify(results[results.length - 1]));
  } finally {
    await browser.close();
  }
}

const report = {
  mode: SOFTWARE.test(gpu) ? (args.headed ? 'headed-software' : 'headless-software') : args.headed ? 'headed-gpu' : 'headless-gpu',
  results,
  chrome: chromeVersion,
  gpu,
};
mkdirSync(path.dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
