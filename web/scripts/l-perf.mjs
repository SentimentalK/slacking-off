import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = { headed: false, gpu: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--headed') args.headed = true;
    else if (key === '--gpu') args.gpu = true;
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

const results = [];
let chromeVersion = '';
let gpu = '';

const ONLY = process.env.L_PERF_ONLY;
const selected = CONFIGS.filter((c) => !ONLY || `${c.width}-${c.quality}` === ONLY);
if (selected.length === 0) {
  console.error(`L_PERF_ONLY=${ONLY} matches nothing; use one of ${CONFIGS.map((c) => `${c.width}-${c.quality}`).join(', ')}`);
  process.exit(2);
}
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|no webgl2/i;
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
      `fixture=/@fs${args.fixture}`,
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
