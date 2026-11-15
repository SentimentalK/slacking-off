#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const before = load(join(ROOT, ".conductor/perf/before/metrics.json"));
const after = load(join(ROOT, ".conductor/perf/after/metrics.json"));

const get = (m, path) => path.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), m);
const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

let md = "# Perf compare (before vs after)\n\n";
if (!before) md += "**before metrics missing** (`.conductor/perf/before/metrics.json`)\n\n";
if (!after) md += "**after metrics missing** (`.conductor/perf/after/metrics.json`): only the before side is shown\n\n";
if (!before && !after) {
  console.log(md);
  process.exit(0);
}
if (before && after && before.chrome_version !== after.chrome_version) {
  md += `**warning: Chrome differs** (before ${before.chrome_version}, after ${after.chrome_version})\n\n`;
}

const rows = [
  ["首屏 transfer 合计 (B) · full", "full.load.transferTotal"],
  ["首屏 interactiveMs · full", "full.load.interactiveMs"],
  ["FCP ms · full", "full.load.fcp"],
  ["LCP ms · full", "full.load.lcp"],
  ["TBT ms · full", "full.load.tbt"],
  ["请求数 · full", "full.load.requestCount"],
  ["fps 中位 · empty", "empty.fps.fpsMedian"],
  ["fps 中位 · ten", "ten.fps.fpsMedian"],
  ["fps 中位 · full", "full.fps.fpsMedian"],
  ["fps p1 · full", "full.fps.fpsP1"],
  ["掉帧数 · full", "full.fps.frameDrops"],
  ["rAF 回调耗时 p50 ms · full", "full.fps.frameScriptMs.p50"],
  ["rAF 回调耗时 p95 ms · full", "full.fps.frameScriptMs.p95"],
  ["fps 中位 · drag", "full.fpsDrag.fpsMedian"],
  ["fps 中位 · zoom", "full.fpsZoom.fpsMedian"],
  ["SSE 单条字节中位", "full.sse.bytesMedian"],
  ["SSE 解析 ms 中位", "full.sse.parseMsMedian"],
  ["回放 scrub p50 ms", "full.scrub.scrubP50"],
  ["回放 scrub p95 ms", "full.scrub.scrubP95"],
];
md += "| Metric | before | after |\n| --- | --- | --- |\n";
for (const [label, path] of rows) {
  md += `| ${label} | ${fmt(get(before, path))} | ${fmt(get(after, path))} |\n`;
}
console.log(md);
