#!/usr/bin/env node
/**
 * Contract §5 visual fixture screenshots.
 * data.tar -> fresh data dir -> loo-server (tick 120 s, frozen) -> Chrome
 * 1440x900 DPR1, prefers-reduced-motion: reduce, fonts.ready + 2 rAF -> PNG.
 * Each page is captured CAPTURES times (fresh loads); the most frequent layout variant is the reference shot
 * and all variants are kept under .conductor/perf/visual/variants-<tag>/.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import puppeteer from "./puppeteer.mjs";
import { parseArgs, sleep } from "./util.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const tag = args.tag ?? "before";
const meta = JSON.parse(readFileSync(args.meta, "utf8"));
const port = Number(args.port ?? 18113);
const debugPort = Number(args["debug-port"] ?? (tag === "after" ? 18114 : 18112));
const bin = args.bin ?? join(ROOT, "target/release/loo-server");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const base = `http://127.0.0.1:${port}`;
const VIS = join(ROOT, ".conductor/perf/visual");

const extractDir = join(VIS, `extract-${tag}`);
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
execSync(`tar -xf "${args.tar}" -C "${extractDir}"`);

const configPath = join(VIS, `config-${tag}.json`);
writeFileSync(configPath, `${JSON.stringify(meta.config ?? {})}\n`);

const logFd = openSync(join(VIS, `server-${tag}.log`), "w");
const server = spawn(bin, ["--dev", "--addr", `127.0.0.1:${port}`, "--tick-seconds", String(meta.visual_tick_seconds ?? 120), "--data-dir", extractDir, "--config", configPath], {
  stdio: ["ignore", logFd, logFd],
});
let browser = null;
const cleanup = async () => {
  if (browser) await browser.close().catch(() => {});
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    for (let i = 0; i < 50 && server.exitCode === null; i += 1) await sleep(100);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
};
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

try {
  let healthy = false;
  for (let i = 0; i < 300 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${base}/healthz`)).ok;
    } catch {}
    if (!healthy) await sleep(100);
  }
  if (!healthy) throw new Error("visual server healthz timeout");

  const proj = await fetch(`${base}/api/projection`).then((r) => r.json());
  const counts = proj?.result?.counts;
  console.log(`visual world counts: ${JSON.stringify(counts)} tick=${proj?.result?.tick}`);
  if (!counts || counts.inside !== 50 || counts.queued !== 50) {
    throw new Error(`visual fixture is not the full world: ${JSON.stringify(counts)}`);
  }

  const userData = join(ROOT, `.conductor/perf/chrome-visual-${tag}`);
  mkdirSync(userData, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: userData,
    args: [`--remote-debugging-port=${debugPort}`, "--ozone-platform=x11", "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-gpu-vsync", "--disable-frame-rate-limit"],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  const shotDir = join(ROOT, "docs/screenshots");
  mkdirSync(shotDir, { recursive: true });

  async function capture(path) {
    const page = await browser.newPage();
    try {
      const client = await page.createCDPSession();
      await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await page.bringToFront();
      await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 120000 });
      await page.waitForSelector("canvas", { timeout: 60000 });
      await sleep(2500); // terrain / projection / timeline fetches + first draws
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      return Buffer.from(await page.screenshot({ type: "png" }));
    } finally {
      await page.close().catch(() => {});
    }
  }

  // The page centres its camera once, when the board first has a size; the
  // queue strip / fonts settle later and move the board by a few px, so the
  // same world can come out in more than one layout variant (page-side timing,
  // not the harness). Capture CAPTURES fresh loads, keep the most frequent
  // variant as the reference shot, and record every variant + where they differ.
  const CAPTURES = Number(args.captures ?? 5);
  const variantsDir = join(VIS, `variants-${tag}`);
  rmSync(variantsDir, { recursive: true, force: true });
  mkdirSync(variantsDir, { recursive: true });
  const report = {};

  const tick = meta.ticks?.[meta.ticks.length - 1];
  if (tick === undefined) throw new Error("meta.json has no ticks");
  const shots = [
    // the spectator page lives at "/" ("/spectator" is only a placeholder route)
    ["/", `perf-${tag}-spectator.png`],
    [`/replay?tick=${tick}`, `perf-${tag}-replay-${tick}.png`],
  ];
  for (const [path, name] of shots) {
    const variants = new Map(); // sha -> { count, buf, order }
    for (let i = 0; i < CAPTURES; i += 1) {
      const buf = await capture(path);
      const sha = createHash("sha256").update(buf).digest("hex");
      const v = variants.get(sha) ?? { count: 0, buf, order: variants.size };
      v.count += 1;
      variants.set(sha, v);
    }
    const ranked = [...variants.entries()].sort((x, y) => y[1].count - x[1].count || x[1].order - y[1].order);
    const [chosenSha, chosen] = ranked[0];
    writeFileSync(join(shotDir, name), chosen.buf);
    const files = ranked.map(([sha, v], idx) => {
      const f = join(variantsDir, `${name.replace(/\.png$/, "")}.v${idx}.png`);
      writeFileSync(f, v.buf);
      return { sha: sha.slice(0, 12), count: v.count, file: f.replace(`${ROOT}/`, "") };
    });
    for (let idx = 1; idx < files.length; idx += 1) {
      try {
        files[idx].pixdiffVsChosen = execSync(`node "${join(ROOT, "scripts/perf/pixdiff.mjs")}" "${join(ROOT, files[0].file)}" "${join(ROOT, files[idx].file)}"`, { encoding: "utf8" }).trim();
      } catch (e) {
        files[idx].pixdiffVsChosen = String(e.stdout ?? e.message).trim();
      }
    }
    report[name] = { path, captures: CAPTURES, chosenSha: chosenSha.slice(0, 12), chosenCount: chosen.count, variants: files };
    console.log(`visual shot: docs/screenshots/${name} (${chosen.count}/${CAPTURES} captures identical, ${files.length} variant(s))`);
  }
  writeFileSync(join(VIS, `variants-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`visual screenshots: ${tag} ok`);
} finally {
  await cleanup();
}
