import { execSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = { runs: '5' };
  for (let i = 0; i < argv.length; i += 1) args[argv[i].replace(/^--/, '')] = argv[++i];
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['dist', 'out']) {
  if (!args[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}
const RUNS = Number(args.runs);
const DIST = path.resolve(args.dist);
const OUT = path.resolve(args.out);
const WEB = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const STATIC_PORT = 18126;
const API_PORT = 18127;
const VIEWPORT = { width: 1440, height: 900 };
const NETWORK = {
  offline: false,
  latency: 40,
  downloadThroughput: (10 * 1000 * 1000) / 8,
  uploadThroughput: (5 * 1000 * 1000) / 8,
};
const LOAD_LIMIT = 8;
const LOAD_WAIT_MS = 5 * 60 * 1000;
const LOAD_WAIT_MAX_MS = 60 * 60 * 1000;
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|no webgl2/i;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x) => Math.round(x * 10) / 10;
const loadavg1 = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

async function waitForLoad() {
  const started = Date.now();
  while (loadavg1() > LOAD_LIMIT) {
    if (Date.now() - started >= LOAD_WAIT_MAX_MS) {
      throw new Error(`load stayed above ${LOAD_LIMIT} for 60 min; not measuring`);
    }
    console.error(`load ${loadavg1()} > ${LOAD_LIMIT}; waiting 5 min before the next run`);
    await sleep(LOAD_WAIT_MS);
  }
}

function startApi() {
  const child = spawn(process.execPath, [path.join(WEB, 'dev/mock-api.mjs')], {
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForApi() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/terrain`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`mock api did not answer on ${API_PORT}`);
}

function serveStatic() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const proxied = httpRequest(
        { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxied.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(proxied);
      return;
    }
    let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    const ext = path.extname(file);
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const gz = `${file}.gz`;
    const useGz = acceptsGzip && existsSync(gz);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...(useGz ? { 'content-encoding': 'gzip' } : {}),
      vary: 'Accept-Encoding',
    });
    res.end(readFileSync(useGz ? gz : file));
  });
}

const MARKS_SCRIPT = `(() => {
  const marks = {};
  window.__fpMarks = marks;
  const tick = () => {
    const now = performance.now();
    if (marks.topbar === undefined) {
      const el = document.querySelector('.ui-brand');
      if (el && el.getBoundingClientRect().height > 0) marks.topbar = now;
    }
    if (marks.scene === undefined && window.__looView && window.__looView.tick() > 0) marks.scene = now;
    if (marks.topbar === undefined || marks.scene === undefined) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
const backgroundArgs = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const staticServer = serveStatic();
const api = startApi();
let browser = null;
const runs = [];
let gpu = '';
let chrome = '';
try {
  await waitForApi();
  await new Promise((resolve) => staticServer.listen(STATIC_PORT, '127.0.0.1', resolve));
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--hide-scrollbars',
      '--headless=new',
      '--use-angle=gl',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      ...backgroundArgs,
    ],
  });
  chrome = await browser.version();

  for (let run = 1; run <= RUNS; run += 1) {
    await waitForLoad();
    const load = loadavg1();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', NETWORK);
      await page.evaluateOnNewDocument(MARKS_SCRIPT);
      await page.goto(`http://127.0.0.1:${STATIC_PORT}/`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(
        () => window.__fpMarks && window.__fpMarks.topbar !== undefined && window.__fpMarks.scene !== undefined,
        { timeout: 120000 },
      );
      const result = await page.evaluate(() => {
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return {
          fcp: fcp ? fcp.startTime : null,
          topbar: window.__fpMarks.topbar,
          scene: window.__fpMarks.scene,
          renderer: (() => {
            const gl = document.createElement('canvas').getContext('webgl2');
            if (!gl) return 'no webgl2';
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'UNMASKED_RENDERER unavailable';
          })(),
        };
      });
      if (!gpu) gpu = result.renderer;
      if (SOFTWARE.test(gpu)) {
        console.error(`asked for a real GPU but Chrome rendered with: ${gpu}`);
        process.exit(1);
      }
      const entry = {
        run,
        loadavg1: load,
        fcp: round1(result.fcp),
        topbar: round1(result.topbar),
        scene: round1(result.scene),
      };
      runs.push(entry);
      console.log(JSON.stringify(entry));
    } finally {
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => staticServer.close(resolve));
  api.kill('SIGTERM');
}

const report = {
  dist: DIST,
  runs,
  median: {
    fcp: round1(median(runs.map((r) => r.fcp))),
    topbar: round1(median(runs.map((r) => r.topbar))),
    scene: round1(median(runs.map((r) => r.scene))),
  },
  conditions: { viewport: VIEWPORT, network: NETWORK, cache: 'fresh browser context per run, cache disabled' },
  chrome,
  gpu,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.median));
