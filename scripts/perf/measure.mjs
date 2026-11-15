#!/usr/bin/env node
/**
 * One occupancy scenario (empty | ten | full) against a running dev server.
 *   measure.mjs --tag before --occupancy full --base http://127.0.0.1:18111
 *               --phases load,fps,drag,zoom,profile,sse,scrub --partial FILE
 *
 * Writes the summary into the partial metrics file (`partial[occupancy]`) and
 * raw samples into `.conductor/perf/<tag>/raw/<phase>-<occupancy>.json`.
 * Exits 1 when any phase failed (the error is recorded, never papered over).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "./puppeteer.mjs";
import { parseArgs, sleep, median, percentile, loadJson, writeJson } from "./util.mjs";
import { summarizeCpuProfile } from "./summarize-profile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const tag = args.tag ?? "before";
const occupancy = args.occupancy ?? "empty";
const base = (args.base ?? "http://127.0.0.1:18111").replace(/\/$/, "");
const phases = new Set((args.phases ?? "load,fps").split(",").map((s) => s.trim()));
const PERF = join(ROOT, `.conductor/perf/${tag}`);
const partialPath = args.partial ?? join(PERF, "metrics-partial.json");
const chromeVersion = args["chrome-version"] ?? "unknown";
const phaseTimeoutMs = Number(args["phase-timeout-seconds"] ?? 180) * 1000;

const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const DEBUG_PORT = tag === "after" ? 18114 : 18112;
const USER_DATA = join(ROOT, `.conductor/perf/chrome-${tag}`);
const RAW_DIR = join(PERF, "raw");
const PROFILE_DIR = join(PERF, "profiles");
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(PROFILE_DIR, { recursive: true });

/** Frames slower than this count as a dropped frame (60 Hz frame = 16.7 ms). */
const DROP_GAP_MS = 25;
const rel = (p) => p.replace(`${ROOT}/`, "");
const rawFile = (phase) => join(RAW_DIR, `${phase}-${occupancy}.json`);

// ---------------------------------------------------------------------------
// In-page instrumentation (runs before any page script).
//   * requestAnimationFrame is wrapped, so `work` is the real execution time of
//     every rAF callback (the page's own render loop included) and `gaps` are
//     the deltas between distinct frame timestamps.
//   * firstCanvasMs: end of the first rAF callback that issued >= 20 canvas
//     draw calls (drawWorld returns before drawing when it has no data yet);
//     the draw-call counters are removed again right after that frame so
//     they do not perturb the fps measurement.
// ---------------------------------------------------------------------------
const INJECT = `
(() => {
  if (window.__perfRaf) return;
  try { performance.setResourceTimingBufferSize(3000); } catch (_) {}
  const S = (window.__perfRaf = { gaps: [], work: [], firstCanvasMs: null });
  let lastTs = null;
  let draws = 0;
  const proto = CanvasRenderingContext2D.prototype;
  const originals = {};
  for (const name of ['fillRect', 'drawImage', 'fillText', 'strokeRect']) {
    const o = proto[name];
    originals[name] = o;
    proto[name] = function (a, b, c, d, e, f, g, h, i) {
      draws += 1;
      return o.call(this, a, b, c, d, e, f, g, h, i);
    };
  }
  const restore = () => { for (const k of Object.keys(originals)) proto[k] = originals[k]; };
  S.reset = () => { S.gaps = []; S.work = []; lastTs = null; };
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => orig((t) => {
    draws = 0;
    const s = performance.now();
    try { cb(t); } finally {
      const e = performance.now();
      S.work.push(e - s);
      if (lastTs !== t) {
        if (lastTs !== null) S.gaps.push(t - lastTs);
        lastTs = t;
      }
      if (S.firstCanvasMs === null && draws >= 20) {
        S.firstCanvasMs = e;
        restore();
      }
    }
  });

  const O = (window.__perfObs = { fcp: null, lcp: null, lcpSize: null, longtasks: [] });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') O.fcp = e.startTime; })
      .observe({ type: 'paint', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { O.lcp = e.startTime; O.lcpSize = e.size; } })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) O.longtasks.push({ start: e.startTime, dur: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch (_) {}

  // Replay fetch timings (used by the scrub phase).
  window.__perfFetch = [];
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!url.includes('/api/projection?tick=')) return origFetch(input, init);
    const rec = { url, start: performance.now(), end: null };
    window.__perfFetch.push(rec);
    const p = origFetch(input, init);
    p.then(() => { rec.end = performance.now(); }, () => { rec.end = performance.now(); });
    return p;
  };
})();
`;

/**
 * Measurement Chrome. vsync and the frame-rate limit are OFF by default: on
 * this host Chrome's Xwayland window is throttled by the compositor to ~1 Hz
 * whenever it is not exposed (see the rafprobe phase for the evidence), which
 * would make every fps number a measurement of the compositor instead of the
 * page. Without vsync rAF runs as fast as the page allows, so fps = how many
 * frames per second the page can sustain (not capped at the refresh rate).
 */
async function launchChrome({ vsync = false } = {}) {
  mkdirSync(USER_DATA, { recursive: true });
  return puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    dumpio: false,
    userDataDir: USER_DATA,
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--window-size=1440,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--ozone-platform=x11", // Wayland gives no frame callbacks to this window (rAF stalls); Xwayland on DISPLAY=:0 does
      "--disable-dev-shm-usage",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      ...(vsync ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"]),
    ],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluateOnNewDocument(INJECT);
  await page.bringToFront();
  return { page, client };
}

function round(v, d = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d));
}

function fpsStats(gaps, work) {
  const fps = gaps.filter((g) => g > 0).map((g) => 1000 / g).sort((a, b) => a - b);
  const sortedWork = [...work].sort((a, b) => a - b);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const frameScriptMs = {
    p50: round(median(sortedWork), 4),
    p95: round(percentile(sortedWork, 95), 4),
    max: round(sortedWork.length ? sortedWork[sortedWork.length - 1] : null, 4),
    count: sortedWork.length,
  };
  return {
    fpsMedian: round(median(fps), 2),
    fpsP1: round(percentile(fps, 1), 2),
    frameDrops: gaps.filter((g) => g > DROP_GAP_MS).length,
    stalls: gaps.filter((g) => g > 500).length,
    frameGapMaxMs: round(sortedGaps.length ? sortedGaps[sortedGaps.length - 1] : null, 1),
    dropThresholdMs: DROP_GAP_MS,
    frameGapMedianMs: round(median(sortedGaps), 3),
    sampleCount: gaps.length,
    frameScriptMs,
    // legacy names kept for compare.mjs / older readers
    scriptMsMedian: frameScriptMs.p50,
    scriptMsP95: frameScriptMs.p95,
  };
}

async function gotoSpectator(page) {
  await page.goto(`${base}/`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => window.__perfRaf?.firstCanvasMs != null, { timeout: 60000 });
  await sleep(1500);
}

async function collectRaf(page) {
  return page.evaluate(() => ({ gaps: window.__perfRaf.gaps, work: window.__perfRaf.work }));
}

async function resetRaf(page) {
  await page.evaluate(() => window.__perfRaf.reset());
}

// --- helpers for response-header evidence (raw HTTP, no auto decompression) --
function headFetch(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { "accept-encoding": "gzip, br" } }, (res) => {
      let bytes = 0;
      res.on("data", (d) => (bytes += d.length));
      res.on("end", () =>
        resolve({
          url,
          status: res.statusCode,
          contentType: res.headers["content-type"] ?? null,
          contentEncoding: res.headers["content-encoding"] ?? null,
          contentLength: res.headers["content-length"] ?? null,
          cacheControl: res.headers["cache-control"] ?? null,
          etag: res.headers.etag ?? null,
          wireBodyBytes: bytes,
        }),
      );
    });
    req.on("error", (e) => resolve({ url, error: String(e) }));
  });
}

function kindOf(name, initiatorType) {
  let path = name;
  try {
    path = new URL(name).pathname;
  } catch {}
  if (/\.(woff2?|ttf|otf)$/i.test(path)) return "font";
  if (/\.(m?js)$/i.test(path)) return "script";
  if (/\.css$/i.test(path)) return "style";
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(path)) return "image";
  if (path.startsWith("/api/")) return "api";
  if (initiatorType === "navigation") return "document";
  return "other";
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------
async function loadOnce(browser, withHeaders) {
  const { page, client } = await newPage(browser);
  try {
    await client.send("Network.enable");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    await client.send("Network.clearBrowserCache");
    await page.goto(`${base}/`, { waitUntil: "load", timeout: 120000 });
    let canvasWait = null;
    try {
      await page.waitForFunction(() => window.__perfRaf?.firstCanvasMs != null, { timeout: 60000 });
    } catch (e) {
      canvasWait = String(e.message ?? e);
    }
    // Let lazily requested resources (unicode-range fonts, /api calls) land.
    await sleep(3000);

    const data = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const res = performance.getEntriesByType("resource").map((r) => ({
        name: r.name,
        initiatorType: r.initiatorType,
        transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize,
        decodedBodySize: r.decodedBodySize,
        startTime: r.startTime,
        responseEnd: r.responseEnd,
        duration: r.duration,
      }));
      return {
        nav: nav
          ? {
              transferSize: nav.transferSize,
              encodedBodySize: nav.encodedBodySize,
              decodedBodySize: nav.decodedBodySize,
              domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
              loadEventEnd: nav.loadEventEnd,
              responseEnd: nav.responseEnd,
            }
          : null,
        res,
        obs: window.__perfObs,
        firstCanvasMs: window.__perfRaf?.firstCanvasMs ?? null,
        timeOrigin: performance.timeOrigin,
      };
    });

    const entries = data.res.map((r) => ({ ...r, kind: kindOf(r.name, r.initiatorType) }));
    if (data.nav) {
      entries.unshift({
        name: `${base}/`,
        initiatorType: "navigation",
        transferSize: data.nav.transferSize,
        encodedBodySize: data.nav.encodedBodySize,
        decodedBodySize: data.nav.decodedBodySize,
        startTime: 0,
        responseEnd: data.nav.responseEnd,
        duration: data.nav.responseEnd,
        kind: "document",
      });
    }
    const byKind = {};
    const byType = {};
    let transferTotal = 0;
    let decodedTotal = 0;
    for (const r of entries) {
      const k = (byKind[r.kind] ??= { transfer: 0, decoded: 0, count: 0 });
      k.transfer += r.transferSize || 0;
      k.decoded += r.decodedBodySize || 0;
      k.count += 1;
      if (r.initiatorType !== "navigation") {
        const t = (byType[r.initiatorType || "other"] ??= { transfer: 0, decoded: 0, count: 0 });
        t.transfer += r.transferSize || 0;
        t.decoded += r.decodedBodySize || 0;
        t.count += 1;
      }
      transferTotal += r.transferSize || 0;
      decodedTotal += r.decodedBodySize || 0;
    }

    const interactiveMs = data.firstCanvasMs;
    const fcp = data.obs?.fcp ?? null;
    const longtasks = data.obs?.longtasks ?? [];
    const tbtOf = (from, to) =>
      longtasks
        .filter((t) => t.start >= from && t.start <= to)
        .reduce((s, t) => s + Math.max(0, t.dur - 50), 0);
    const tbt = fcp !== null && interactiveMs !== null ? tbtOf(fcp, interactiveMs) : null;
    const tbtAll = longtasks.reduce((s, t) => s + Math.max(0, t.dur - 50), 0);

    // Header evidence: `/` and every distinct same-origin resource, raw HTTP.
    const origin = new URL(base).origin;
    const urls = [...new Set([`${origin}/`, ...entries.filter((e) => e.name.startsWith(origin) && e.kind !== "api").map((e) => e.name)])];
    const headers = [];
    if (withHeaders) for (const u of urls) headers.push(await headFetch(u));
    const compression = { checked: headers.length, withEncoding: 0, byKind: {} };
    for (const h of headers) {
      const kind = kindOf(h.url, "");
      const k = (compression.byKind[kind] ??= { n: 0, encoded: 0, wireBodyBytes: 0 });
      k.n += 1;
      if (h.contentEncoding && h.contentEncoding !== "identity") {
        compression.withEncoding += 1;
        k.encoded += 1;
      }
      k.wireBodyBytes += h.wireBodyBytes ?? 0;
    }

    return {
      _raw: { entries, nav: data.nav, obs: data.obs, firstCanvasMs: interactiveMs },
      _headers: headers,
      transferTotal,
      decodedTotal,
      requestCount: entries.length,
      resourceRequestCount: entries.length - (data.nav ? 1 : 0),
      byType,
      byKind,
      fcp: round(fcp, 1),
      lcp: round(data.obs?.lcp ?? null, 1),
      lcpSize: data.obs?.lcpSize ?? null,
      tbt: round(tbt, 1),
      tbtAll: round(tbtAll, 1),
      tbtWindow: "longtasks with start in [FCP, interactiveMs]; tbtAll = every longtask until sampling stopped",
      longtaskCount: longtasks.length,
      domContentLoaded: round(data.nav?.domContentLoadedEventEnd ?? null, 1),
      load: round(data.nav?.loadEventEnd ?? null, 1),
      firstCanvasMs: round(interactiveMs, 1),
      interactiveMs: round(interactiveMs, 1),
      interactiveDef: "performance.now() at the end of the first rAF callback that issued >=20 canvas draw calls (origin = navigationStart)",
      canvasWaitError: canvasWait,
      _compression: compression,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** 5 cold loads (cache cleared + disabled each time); the run with the median interactiveMs is the headline. */
async function phaseLoad(browser) {
  const RUNS = 5;
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) runs.push(await loadOnce(browser, i === 0));
  const headers = runs[0]._headers;
  const compression = runs[0]._compression;
  const order = runs
    .map((r, i) => ({ i, v: r.interactiveMs ?? Infinity }))
    .sort((a, b) => a.v - b.v);
  const med = runs[order[Math.floor((RUNS - 1) / 2)].i];
  const origin = new URL(base).origin;
  writeJson(rawFile("load"), { runs: runs.map((r) => r._raw), headers, medianRunIndex: runs.indexOf(med) });
  const pick = (f) => runs.map((r) => r[f]);
  const { _raw, _headers, _compression, ...rest } = med;
  return {
    ...rest,
    runCount: RUNS,
    medianRunIndex: runs.indexOf(med),
    runs: runs.map((r) => ({ interactiveMs: r.interactiveMs, fcp: r.fcp, lcp: r.lcp, tbt: r.tbt, load: r.load, domContentLoaded: r.domContentLoaded, transferTotal: r.transferTotal, requestCount: r.requestCount })),
    interactiveMsMin: Math.min(...pick("interactiveMs").filter((v) => v !== null)),
    interactiveMsMax: Math.max(...pick("interactiveMs").filter((v) => v !== null)),
    compression: { ...compression, samples: headers.slice(0, 8) },
    compressionSamples: headers.slice(0, 8).map((h) => ({ path: h.url.replace(origin, ""), status: h.status, contentEncoding: h.contentEncoding, contentLength: h.contentLength })),
    rawPath: rel(rawFile("load")),
  };
}

/** Evidence for the vsync-off choice: bare rAF cadence of fresh pages, vsync ON vs OFF. */
async function phaseRafProbe() {
  // Resolves even when the window is throttled so hard that rAF never fires.
  const probe = (page, ms) =>
    page.evaluate(
      (ms) =>
        new Promise((res) => {
          const ts = [];
          const start = performance.now();
          let finished = false;
          const finish = (stalled) => {
            if (finished) return;
            finished = true;
            const g = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
            res({
              frames: ts.length,
              medianGapMs: g[g.length >> 1] ?? null,
              maxGapMs: g.length ? g[g.length - 1] : performance.now() - start,
              noFrameWithin: stalled ? ms + 2000 : null,
            });
          };
          const f = (t) => {
            ts.push(t);
            if (performance.now() > start + ms) finish(false);
            else requestAnimationFrame(f);
          };
          requestAnimationFrame(f);
          setTimeout(() => finish(true), ms + 2000);
        }),
      ms,
    );
  const out = {};
  for (const [name, vsync] of [["vsyncOn", true], ["vsyncOff", false]]) {
    const b = await launchChrome({ vsync });
    out[name] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const page = await b.newPage();
        await page.bringToFront();
        await page.goto(`${base}/`, { waitUntil: "load", timeout: 30000 });
        await sleep(1500);
        out[name].push(await probe(page, 3000));
        await page.close();
      }
    } finally {
      await b.close().catch(() => {});
    }
  }
  const stalled = (r) => (r.medianGapMs ?? 0) > 500 || (r.maxGapMs ?? 0) > 900 || r.noFrameWithin !== null || r.frames < 5;
  const res = { ...out, vsyncOnThrottledPages: out.vsyncOn.filter(stalled).length, vsyncOffThrottledPages: out.vsyncOff.filter(stalled).length, pages: 3, note: "bare requestAnimationFrame loop on `/`, 3 s per fresh page; maxGap ~1000 ms = compositor-throttled window" };
  writeJson(rawFile("rafprobe"), res);
  return { ...res, rawPath: rel(rawFile("rafprobe")) };
}

async function phaseFps(browser) {
  const { page } = await newPage(browser);
  try {
    await gotoSpectator(page);
    await resetRaf(page);
    await sleep(10000);
    const { gaps, work } = await collectRaf(page);
    writeJson(rawFile("fps"), { seconds: 10, gaps, work });
    return { ...fpsStats(gaps, work), seconds: 10, rawPath: rel(rawFile("fps")) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function canvasCenter(page) {
  const canvas = await page.$("canvas");
  const rect = canvas ? await canvas.boundingBox() : null;
  if (!rect) throw new Error("no canvas bounding box");
  return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
}

async function phaseDrag(browser, seconds = 8) {
  const { page, client } = await newPage(browser);
  try {
    await gotoSpectator(page);
    const { cx, cy } = await canvasCenter(page);
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });
    await resetRaf(page);
    const t0 = Date.now();
    let events = 0;
    for (let i = 0; Date.now() - t0 < seconds * 1000; i += 1) {
      const x = cx + Math.sin(i / 8) * 200;
      const y = cy + Math.cos(i / 6) * 120;
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      events += 1;
      await sleep(1000 / 60);
    }
    const { gaps, work } = await collectRaf(page);
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", buttons: 0, clickCount: 1 });
    writeJson(rawFile("drag"), { seconds, mouseEvents: events, gaps, work });
    return { ...fpsStats(gaps, work), seconds, mouseEvents: events, rawPath: rel(rawFile("drag")) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function phaseZoom(browser, seconds = 8) {
  const { page, client } = await newPage(browser);
  try {
    await gotoSpectator(page);
    const { cx, cy } = await canvasCenter(page);
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    await resetRaf(page);
    const t0 = Date.now();
    let events = 0;
    for (let i = 0; Date.now() - t0 < seconds * 1000; i += 1) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: i % 2 === 0 ? -100 : 100 });
      events += 1;
      await sleep(1000 / 30);
    }
    const { gaps, work } = await collectRaf(page);
    writeJson(rawFile("zoom"), { seconds, wheelEvents: events, gaps, work });
    return { ...fpsStats(gaps, work), seconds, wheelEvents: events, rawPath: rel(rawFile("zoom")) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function phaseProfile(browser) {
  const { page, client } = await newPage(browser);
  try {
    await gotoSpectator(page);
    const outPath = join(PROFILE_DIR, `spectator-${occupancy}.cpuprofile`);
    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", { interval: 200 });
    await client.send("Profiler.start");
    await sleep(5000);
    const { profile } = await client.send("Profiler.stop");
    writeFileSync(outPath, JSON.stringify(profile));
    const sum = summarizeCpuProfile(profile, 10);
    return { path: rel(outPath), seconds: 5, ...sum, topSelfTime: sum.top };
  } finally {
    await page.close().catch(() => {});
  }
}

function splitBlocks(buf) {
  const blocks = [];
  let rest = buf;
  for (;;) {
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    let idx = -1;
    let sepLen = 0;
    if (lf !== -1 && (crlf === -1 || lf < crlf)) {
      idx = lf;
      sepLen = 2;
    } else if (crlf !== -1) {
      idx = crlf;
      sepLen = 4;
    }
    if (idx === -1) break;
    blocks.push(rest.subarray(0, idx + sepLen));
    rest = rest.subarray(idx + sepLen);
  }
  return { blocks, rest };
}

async function phaseSse() {
  const outRaw = join(PERF, "sse-raw.txt");
  writeFileSync(outRaw, "");
  const controller = new AbortController();
  const res = await fetch(`${base}/api/watch`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  if (!res.ok) throw new Error(`SSE fetch failed ${res.status}`);
  const reader = res.body.getReader();
  const events = [];
  let comments = 0;
  let totalBytes = 0;
  let buf = Buffer.alloc(0);
  const t0 = performance.now();
  const WANT = 20;
  while (events.length < WANT && performance.now() - t0 < 120000) {
    const { value, done } = await reader.read();
    if (done) break;
    const now = performance.now();
    buf = Buffer.concat([buf, Buffer.from(value)]);
    const { blocks, rest } = splitBlocks(buf);
    buf = rest;
    for (const block of blocks) {
      totalBytes += block.length;
      writeFileSync(outRaw, block, { flag: "a" });
      const text = block.toString("utf8");
      const lines = text.split(/\r?\n/);
      let event = "message";
      let id = null;
      const data = [];
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length === 0) {
        comments += 1;
        continue;
      }
      const dataStr = data.join("\n");
      const p0 = performance.now();
      let parsed = null;
      try {
        parsed = JSON.parse(dataStr);
      } catch {}
      const parseMs = performance.now() - p0;
      events.push({
        event,
        id,
        bytes: block.length,
        dataBytes: Buffer.byteLength(dataStr),
        parseMs,
        tick: parsed?.tick ?? parsed?.result?.tick ?? null,
        arrivalMs: now - t0,
      });
      if (events.length >= WANT) break;
    }
  }
  controller.abort();
  const sortedBytes = events.map((e) => e.bytes).sort((a, b) => a - b);
  const sortedParse = events.map((e) => e.parseMs).sort((a, b) => a - b);
  const withTick = events.filter((e) => e.tick !== null);
  let tickHz = null;
  let eventHz = null;
  if (withTick.length >= 2) {
    const first = withTick[0];
    const last = withTick[withTick.length - 1];
    const dtSec = (last.arrivalMs - first.arrivalMs) / 1000;
    if (dtSec > 0) {
      tickHz = (last.tick - first.tick) / dtSec;
      eventHz = (withTick.length - 1) / dtSec;
    }
  }
  const byEvent = {};
  for (const e of events) byEvent[e.event] = (byEvent[e.event] ?? 0) + 1;
  writeJson(rawFile("sse"), { events, comments, totalBytes });
  return {
    rawPath: rel(outRaw),
    rawSamplesPath: rel(rawFile("sse")),
    count: events.length,
    comments,
    byEvent,
    bytesMedian: median(sortedBytes),
    bytesP95: percentile(sortedBytes, 95),
    bytesMax: sortedBytes.length ? sortedBytes[sortedBytes.length - 1] : null,
    bytesMin: sortedBytes.length ? sortedBytes[0] : null,
    parseMsMedian: round(median(sortedParse), 4),
    parseMsP95: round(percentile(sortedParse, 95), 4),
    tickHz: round(tickHz, 4),
    eventHz: round(eventHz, 4),
    firstEventBytes: events[0]?.bytes ?? null,
    bytesNote: "bytes = raw SSE block incl. id:/event:/data: lines and the blank-line separator",
    events,
  };
}

async function pickScrubTicks() {
  const worlds = await fetch(`${base}/api/worlds`).then((r) => r.json()).catch(() => null);
  const proj = await fetch(`${base}/api/projection`).then((r) => r.json());
  const lastTick = worlds?.result?.[0]?.last_tick ?? proj?.result?.tick ?? 30;
  const timeline = await fetch(`${base}/api/timeline?from=0&to=${lastTick}`).then((r) => r.json());
  const ticks = [...new Set((timeline?.result?.markers ?? []).map((m) => m.tick))].sort((a, b) => a - b);
  return { lastTick, highlightTicks: ticks };
}

const SCRUB_HOOKS = `
(() => {
  const root = document.querySelector('.replay-timeline');
  window.__scrub = { ev: null, dom: null };
  new MutationObserver(() => {
    const s = window.__scrub;
    if (s.ev !== null && s.dom === null) s.dom = performance.now();
  }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('pointermove', (e) => {
    if (e.buttons && e.target.closest && e.target.closest('.marker-track')) window.__scrub.ev = e.timeStamp;
  }, true);
})();
`;

const dbg = (...a) => process.env.PERF_DEBUG && console.error("[scrub]", ...a);

async function phaseScrub(browser) {
  const { lastTick, highlightTicks } = await pickScrubTicks();
  // Replay starts at the last highlight; a world with no highlight markers
  // starts at the world's last recorded tick.
  const lastHighlight = highlightTicks.length ? highlightTicks[highlightTicks.length - 1] : lastTick;
  dbg("ticks", lastTick, highlightTicks.length);
  const { page, client } = await newPage(browser);
  try {
    await page.goto(`${base}/replay?tick=${lastHighlight}`, { waitUntil: "load", timeout: 120000 });
    await page.waitForSelector(".replay-timeline .marker-track", { timeout: 60000 });
    await page.waitForFunction(() => window.__perfRaf?.firstCanvasMs != null, { timeout: 60000 });
    await sleep(1500);
    dbg("page ready");
    await page.evaluate(SCRUB_HOOKS);

    // Slot positions come from the marker bars actually rendered on the rail.
    const track = await page.$(".replay-timeline .marker-track");
    const trackBox = await track.boundingBox();
    const xs = await page.$$eval(".replay-timeline .marker-hit", (els) =>
      [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2)))].sort((a, b) => a - b),
    );
    const y = trackBox.y + trackBox.height / 2;

    // Drag pairs (press at a, move to b). With a highlight reel the pairs are
    // neighbouring marker slots; a world without markers (idle script agents
    // produce no success/attack events) falls back to the free-form tick range,
    // where pairs are spread proportionally along the rail (each lands on a
    // different tick).
    const N = 20;
    const mode = xs.length >= 3 ? "highlight-slots" : "free-range";
    const pairs = [];
    for (let i = 0; i < N; i += 1) {
      if (mode === "highlight-slots") {
        const a = (i * 2) % xs.length;
        pairs.push([xs[a], xs[(a + 1) % xs.length]]);
      } else {
        const f = 0.05 + 0.85 * (i / (N - 1));
        pairs.push([trackBox.x + trackBox.width * f, trackBox.x + trackBox.width * (f + 0.04)]);
      }
    }

    const samples = [];
    for (let i = 0; i < N; i += 1) {
      const [xa, xb] = pairs[i];
      dbg("sample", i);
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: xa, y });
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: xa, y, button: "left", buttons: 1, clickCount: 1 });
      dbg("pressed");
      await sleep(400); // let the press-seek settle (not measured)
      await page.evaluate(() => {
        window.__scrub.ev = null;
        window.__scrub.dom = null;
        window.__perfFetch.length = 0;
      });
      dbg("reset done");
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: xb, y, button: "left", buttons: 1 });
      dbg("moved");
      const r = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const S = window.__scrub;
            const deadline = performance.now() + 5000;
            let stage = 0;
            let rafFallbacks = 0;
            // rAF with a timer fallback: if the page produces no frame for
            // 500 ms the wait must not hang; the sample is flagged instead.
            const raf = (cb) => {
              let fired = false;
              const t = setTimeout(() => {
                if (fired) return;
                fired = true;
                rafFallbacks += 1;
                cb();
              }, 500);
              requestAnimationFrame(() => {
                if (fired) return;
                fired = true;
                clearTimeout(t);
                cb();
              });
            };
            const done = () => {
              raf(() => raf(() => {
                const fetches = window.__perfFetch.map((f) => (f.end === null ? null : f.end - f.start));
                resolve({ ms: performance.now() - S.ev, domMs: S.dom - S.ev, fetchMs: fetches, timeout: false, rafFallbacks });
              }));
            };
            const poll = () => {
              if (performance.now() > deadline) return resolve({ ms: null, domMs: null, fetchMs: [], timeout: true, rafFallbacks });
              if (S.ev !== null && S.dom !== null) {
                if (stage === 0) {
                  stage = 1;
                  // one frame for effects to start any projection fetch
                  return raf(() => setTimeout(poll, 0));
                }
                const pending = window.__perfFetch.some((f) => f.end === null);
                if (!pending) return done();
              }
              setTimeout(poll, 2);
            };
            poll();
          }),
      );
      dbg("settled", JSON.stringify(r));
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: xb, y, button: "left", buttons: 0, clickCount: 1 });
      samples.push({ i, from: Math.round(xa), to: Math.round(xb), ...r });
      await sleep(150);
    }

    dbg("samples done");
    const ok = samples.filter((s) => !s.timeout);
    // A sample is "stalled" when the page produced no frame for 500 ms while it
    // was being measured (rAF fallback fired): the host's compositor
    // intermittently hides/throttles the Chrome window (see rafprobe), which
    // freezes the whole page for 0.5-5 s. Those are environment artefacts, so
    // the headline p50/p95 use the clean samples; the all-sample numbers and
    // the stalled count are reported next to them.
    const clean = ok.filter((s) => (s.rafFallbacks ?? 0) === 0);
    const stalledSamples = ok.length - clean.length;
    const msAll = ok.map((s) => s.ms).sort((a, b) => a - b);
    const ms = clean.map((s) => s.ms).sort((a, b) => a - b);
    const domMs = clean.map((s) => s.domMs).sort((a, b) => a - b);
    const withFetch = clean.filter((s) => s.fetchMs.length > 0);
    const fetchAll = clean.flatMap((s) => s.fetchMs).filter((v) => v !== null).sort((a, b) => a - b);

    // Node-side network cost for distinct projection ticks (no browser involved).
    const spanTicks = (() => {
      const from = Math.max(1, lastTick - 600);
      const n = Math.min(20, lastTick - from + 1);
      return Array.from({ length: n }, (_, i) => from + Math.round((i * (lastTick - from)) / Math.max(1, n - 1)));
    })();
    const probeTicks = highlightTicks.length >= 2 ? highlightTicks.filter((_, i) => i % Math.max(1, Math.floor(highlightTicks.length / 20)) === 0).slice(0, 20) : [...new Set(spanTicks)];
    const nodeFetch = [];
    for (const t of probeTicks) {
      const s = performance.now();
      const r = await fetch(`${base}/api/projection?tick=${t}`);
      const buf = await r.arrayBuffer();
      nodeFetch.push({ tick: t, ms: performance.now() - s, bytes: buf.byteLength });
    }
    dbg("node fetch done");
    const nodeMs = nodeFetch.map((f) => f.ms).sort((a, b) => a - b);

    writeJson(rawFile("scrub"), { mode, highlightTicks, slotXs: xs, trackBox, samples, nodeFetch });
    return {
      tick: lastHighlight,
      ticks_used: [highlightTicks[0], highlightTicks[Math.floor(highlightTicks.length / 2)], lastHighlight].filter((t) => t !== undefined),
      highlightCount: highlightTicks.length,
      slotCount: xs.length,
      mode,
      samples: samples.length,
      timeouts: samples.length - ok.length,
      stalledSamples,
      cleanSamples: clean.length,
      scrubP50: round(median(ms), 2),
      scrubP95: round(percentile(ms, 95), 2),
      scrubAllP50: round(median(msAll), 2),
      scrubAllP95: round(percentile(msAll, 95), 2),
      scrubAllMax: round(msAll.length ? msAll[msAll.length - 1] : null, 2),
      scrubDomP50: round(median(domMs), 2),
      scrubDomP95: round(percentile(domMs, 95), 2),
      samplesWithNetwork: withFetch.length,
      projectionFetchP50: round(median(fetchAll), 2),
      projectionFetchP95: round(percentile(fetchAll, 95), 2),
      projectionNodeFetchCount: nodeFetch.length,
      projectionNodeFetchP50: round(median(nodeMs), 2),
      projectionNodeFetchP95: round(percentile(nodeMs, 95), 2),
      projectionBytesMedian: median(nodeFetch.map((f) => f.bytes).sort((a, b) => a - b)),
      def: "scrubMs = last pointermove event.timeStamp -> (DOM updated, all /api/projection?tick= fetches done) + 2 rAF; 20 real CDP drags (press, then move) on the replay timeline, each landing on a different tick. p50/p95 = samples where the page kept producing frames; scrubAll* = every sample incl. host-induced page stalls",
      rawPath: rel(rawFile("scrub")),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
async function withTimeout(name, fn) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`phase ${name} exceeded ${phaseTimeoutMs / 1000}s`)), phaseTimeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const partial = loadJson(partialPath);
const block = { occupancy, chromeVersion, base, errors: {} };
block.loadavgStart = readFileSync("/proc/loadavg", "utf8").trim();
const env = await fetch(`${base}/api/projection`).then((r) => r.json());
block.counts = env?.result?.counts ?? null;
block.serverTickAtStart = env?.result?.tick ?? null;

let browser;
const run = async (name, key, fn) => {
  if (!phases.has(name)) return;
  console.log(`measure ${occupancy}: ${name}...`);
  try {
    block[key] = await withTimeout(name, fn);
  } catch (e) {
    block.errors[name] = String(e?.message ?? e);
    console.error(`measure ${occupancy}: phase ${name} FAILED: ${block.errors[name]}`);
  }
};

try {
  await run("rafprobe", "rafProbe", () => phaseRafProbe());
  const needBrowser = ["load", "fps", "drag", "zoom", "profile", "scrub"].some((p) => phases.has(p));
  if (needBrowser) browser = await launchChrome();
  await run("load", "load", () => phaseLoad(browser));
  await run("fps", "fps", () => phaseFps(browser));
  await run("drag", "fpsDrag", () => phaseDrag(browser));
  await run("zoom", "fpsZoom", () => phaseZoom(browser));
  await run("profile", "cpuProfile", () => phaseProfile(browser));
  await run("scrub", "scrub", () => phaseScrub(browser));
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  await run("sse", "sse", () => phaseSse());
} finally {
  if (browser) await browser.close().catch(() => {});
}

block.loadavgEnd = readFileSync("/proc/loadavg", "utf8").trim();
const latest = loadJson(partialPath);
latest[occupancy] = block;
writeJson(partialPath, latest);
const failed = Object.keys(block.errors);
console.log(`measure: ${occupancy} ${failed.length ? `FAILED phases: ${failed.join(",")}` : "ok"}`);
process.exit(failed.length ? 1 : 0);
