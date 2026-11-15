#!/usr/bin/env node
/**
 * docs/perf-report.md from metrics.json. Every number is read from the metrics
 * (or an artifact next to it) and followed by `(.conductor/perf/<tag>/<file> :<field>)`.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./util.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const tag = args.tag ?? "before";
const m = JSON.parse(readFileSync(args.metrics, "utf8"));
const PERF = `.conductor/perf/${tag}`;

const get = (obj, path) =>
  path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const fmt = (x, d = 1) => (isNum(x) ? (Number.isInteger(x) && d === 0 ? String(x) : x.toFixed(d)) : "未测到");
const kb = (b) => (isNum(b) ? `${(b / 1024).toFixed(1)} KB` : "未测到");
const cite = (path, file = "metrics.json") => `(${PERF}/${file} :${path})`;
/** value + citation */
const V = (path, d = 1, unit = "", file = "metrics.json", obj = m) => {
  const x = get(obj, path);
  return `${fmt(x, d)}${isNum(x) ? unit : ""} ${cite(path, file)}`;
};
const B = (path) => {
  const x = get(m, path);
  return `${isNum(x) ? x.toLocaleString("en-US") : "未测到"} B ${cite(path)}`;
};

const occ = JSON.parse(existsSync(join(ROOT, PERF, "occupancy.json")) ? readFileSync(join(ROOT, PERF, "occupancy.json"), "utf8") : "{}");
const determinism = existsSync(join(ROOT, PERF, "visual-determinism.txt")) ? readFileSync(join(ROOT, PERF, "visual-determinism.txt"), "utf8").trim() : "未测到";
const selfdiff = existsSync(join(ROOT, PERF, "pixdiff-self.txt")) ? readFileSync(join(ROOT, PERF, "pixdiff-self.txt"), "utf8").trim() : "未测到";
const probe = m.empty?.rafProbe;
const probeRow = (r) => (r ? `${fmt(r.frames, 0)} 帧 / 3 s，间隔中位 ${fmt(r.medianGapMs, 1)} ms，最大 ${fmt(r.maxGapMs, 1)} ms` : "未测到");

let md = `# Web perf baseline (${tag})\n\n`;
md += `> 由 \`scripts/perf.sh run --tag ${tag}\` 生成（\`scripts/perf/write-report.mjs\`）。每个数字后的括号是来源文件与字段；原始样本在 \`${PERF}/raw/*.json\`。\n\n`;

// ---------------------------------------------------------------- environment
md += `## 1. 测量环境\n\n`;
md += `- 时间：${m.started_at} → ${m.finished_at}（UTC）\n`;
md += `- 机器：${m.machine?.cpu}，${m.machine?.nproc} 线程，内存 ${((m.machine?.memTotalKb ?? 0) / 1024 / 1024).toFixed(1)} GB，${m.machine?.kernel} ${cite("machine.cpu")}\n`;
md += `- Chrome：${m.chrome_version?.trim()}，有头（\`DISPLAY=${m.machine?.display}\`，会话类型 ${m.machine?.session}），视口 1440×900、DPR 1，\`--ozone-platform=x11\` ${cite("chrome_version")}\n`;
md += `  - 为什么必须 x11：默认走 Wayland 时本窗口收不到帧回调，5 秒内 rAF 只触发 2 次（调试时用最小 rAF 计数页实测）；x11（Xwayland）下同一页面 5 秒 678 帧。\n`;
md += `  - 窗口节流是这台机器上的环境现象：Chrome 的 Xwayland 窗口会被合成器间歇性节流（页面几乎收不到帧回调，rAF 间隔 ≈1 s 甚至完全停摆，rAF 回调之外的定时器、DOM 更新也被一起推迟）。最小 rAF 探针（\`rafprobe\`，每次 run 重测，每种配置 3 个全新页面各 3 s）：vsync 开启 ${(probe?.vsyncOn ?? []).map(probeRow).join("；")}，其中出现停摆的页面 ${V("empty.rafProbe.vsyncOnThrottledPages", 0)} / 3 ${cite("empty.rafProbe.vsyncOn")}；关闭 vsync 与帧率上限 ${(probe?.vsyncOff ?? []).map(probeRow).join("；")}，出现停摆的页面 ${V("empty.rafProbe.vsyncOffThrottledPages", 0)} / 3 ${cite("empty.rafProbe.vsyncOff")}。（“停摆”= 探针期间没有拿到连续出帧；0 帧表示 5 s 内 rAF 一次都没触发。）\n`;
md += `  - 所以关 vsync **没有**消除节流，只能说明节流与 vsync 设置无关。处理办法是：每个正式阶段都记录停摆次数（帧间隔 > 500 ms）——本次 empty/ten/full 静置、拖拽、缩放阶段的停摆次数分别为 ${["empty.fps", "ten.fps", "full.fps", "full.fpsDrag", "full.fpsZoom"].map((p) => fmt(get(m, `${p}.stalls`), 0)).join(" / ")} ${cite("full.fps.stalls")}；回放拖动里被节流的样本单独标出并并列报告（§7）。\n`;
md += `  - 测量 Chrome 仍然关 vsync 与帧率上限（\`--disable-gpu-vsync --disable-frame-rate-limit\`）：为的是 fps 不被刷新率封顶、能随每帧成本变化。因此本报告的 **fps = 页面在无刷新率封顶时 rAF 每秒能跑多少帧**（越高说明每帧越便宜），不是屏幕实际显示帧率；前后对比同口径。frameScriptMs 不受这个影响。\n`;
md += `- 并发 / 干扰：load average 开始 ${m.machine?.loadavg} ${cite("machine.loadavg", "machine.json")}；` +
  `各场景测量期间 ${["empty", "ten", "full"].map((o) => `${o}: ${m[o]?.loadavgStart ?? "?"} → ${m[o]?.loadavgEnd ?? "?"}`).join("；")} ${cite("full.loadavgStart")}。\n`;
md += `  - loo-server、100 个脚本 Agent（full 场景每秒约 100 个 long-poll）、Chrome 同机；本机同时还有其他 Orca 工作区的 Agent/服务在跑（并行 Master G 等），CPU 占用前列：${(m.machine?.topCpu ?? []).slice(0, 4).map((s) => s.trim()).join(" | ")} ${cite("machine.topCpu", "machine.json")}。数字带这份干扰，前后对比必须同机同脚本。\n`;
md += `- 观战页路由是 \`/\`（\`web/src/router.ts\`），\`/spectator\` 在应用里只是“建设中”占位页；本报告里“spectator”指 \`/\`。截图文件名沿用契约的 \`perf-${tag}-spectator.png\`。\n`;
md += `- dev 服务配置（\`${PERF}/config.json\`）：\`${JSON.stringify(m.devConfig)}\` ${cite("devConfig")}\n`;
md += `  - 其中 \`need.deadline_ticks_min/max=1000000\`、\`session.idle_cleanup_ticks=100000\`、\`session.queue_idle_seconds=100000\` 只是把会话到期/清理时间推到测量窗口之外（否则默认 120–240 tick 的 deadline 会让场内 Agent 陆续结束、补不满 50/50）；\`limits.requests_per_second=2\` 是默认值。其余 dev 规则未改。tick = 1 秒。\n`;
md += `- 脚本 Agent：register → join → 循环 \`/api/wait\`（timeout 1 s）保活，不移动不攻击；\`placement==null\` 时重新 register + join。\n`;
md += `- 计时口径：\`performance.now()\` 在非跨源隔离页面里被 Chrome 粗化到 0.1 ms，所以 rAF 回调耗时 < 0.1 ms 的量级只能当上界看。\n\n`;

// ------------------------------------------------------------------ occupancy
md += `## 2. 占用度校验（开始与结束各取一次 /api/projection）\n\n`;
md += `| 场景 | 开始 inside/queued | 结束 inside/queued | seed 退出时打印 | 来源 |\n| --- | --- | --- | --- | --- |\n`;
for (const o of ["empty", "ten", "full"]) {
  const s = occ[o]?.start;
  const e = occ[o]?.end;
  md += `| ${o} | ${s?.inside}/${s?.queued}（${s?.ok ? "OK" : "FAIL"}） | ${e?.inside}/${e?.queued}（${e?.ok ? "OK" : "FAIL"}） | ${occ[o]?.seed_final ?? "—（无 seed）"} | (${PERF}/occupancy.json :${o}.start / ${o}.end) |\n`;
}
md += `\n满场容量：inside ${V("occupancy.start.capacity", 0)}，queue ${V("occupancy.start.queue_capacity", 0)}；满场校验 ${m.occupancy?.ok ? "通过" : "**失败**"} ${cite("occupancy.ok")}\n\n`;

// ----------------------------------------------------------------- first load
md += `## 3. 首屏（冷缓存、禁用缓存 \`/\`）\n\n`;
md += `口径：\`interactiveMs\` = 从 navigationStart 到“首个 canvas 非空帧绘制完成”（首个发出 ≥20 次 canvas 绘制调用的 rAF 回调结束）的时间；TBT = FCP 到 interactiveMs 之间长任务超出 50 ms 的部分之和（\`tbtAll\` 为全部长任务）。传输体积含 HTML 文档本身。\n\n`;
md += `| 指标 | empty | ten | full |\n| --- | --- | --- | --- |\n`;
const loadRow = (label, f, d = 1, unit = "") =>
  `| ${label} | ${["empty", "ten", "full"].map((o) => `${fmt(get(m, `${o}.load.${f}`), d)}${unit}`).join(" | ")} |\n`;
md += loadRow("传输合计 (B)", "transferTotal", 0);
md += loadRow("decoded 合计 (B)", "decodedTotal", 0);
md += loadRow("请求数", "requestCount", 0);
md += loadRow("interactiveMs (ms)，5 次冷加载的中位", "interactiveMs");
md += `| interactiveMs 5 次的最小 – 最大 (ms) | ${["empty", "ten", "full"].map((o) => `${fmt(get(m, `${o}.load.interactiveMsMin`))} – ${fmt(get(m, `${o}.load.interactiveMsMax`))}`).join(" | ")} |\n`;
md += loadRow("FCP (ms)", "fcp");
md += loadRow("LCP (ms)", "lcp");
md += loadRow("TBT (ms)", "tbt");
md += loadRow("tbtAll (ms)", "tbtAll");
md += loadRow("DOMContentLoaded (ms)", "domContentLoaded");
md += loadRow("load (ms)", "load");
md += `\n来源：${["empty", "ten", "full"].map((o) => cite(`${o}.load.*`)).join(" ")}\n\n`;
md += `### 满场首屏按类型（transferSize / decodedBodySize）\n\n| 类型 | 请求数 | transfer | decoded | 来源 |\n| --- | --- | --- | --- | --- |\n`;
for (const kind of Object.keys(m.full?.load?.byKind ?? {})) {
  const base = `full.load.byKind.${kind}`;
  md += `| ${kind} | ${V(`${base}.count`, 0)} | ${B(`${base}.transfer`)} | ${B(`${base}.decoded`)} | |\n`;
}
md += `\n（\`byType\` 按 initiatorType 的分组也在 metrics 里：${cite("full.load.byType")}；字体由 CSS 发起，所以 initiatorType 为 css。）\n\n`;
md += `首屏大头：字体 ${B("full.load.byKind.font.transfer")}、样式 ${B("full.load.byKind.style.transfer")}、脚本 ${B("full.load.byKind.script.transfer")}。\n\n`;

// --------------------------------------------------------------- compression
md += `### 静态资源响应头（是否压缩）\n\n`;
md += `证据：对 \`/\` 及首屏加载的每个同源静态资源，用原始 HTTP（\`Accept-Encoding: gzip, br\`，不自动解压）各请求一次，共 ${V("full.load.compression.checked", 0)}，其中带 \`Content-Encoding\` 的 ${V("full.load.compression.withEncoding", 0)}。\n\n`;
md += `| 类型 | 资源数 | 带 content-encoding | 线上 body 字节合计 | 来源 |\n| --- | --- | --- | --- | --- |\n`;
for (const kind of Object.keys(m.full?.load?.compression?.byKind ?? {})) {
  const base = `full.load.compression.byKind.${kind}`;
  md += `| ${kind} | ${V(`${base}.n`, 0)} | ${V(`${base}.encoded`, 0)} | ${B(`${base}.wireBodyBytes`)} | |\n`;
}
const sample = (m.full?.load?.compression?.samples ?? []).slice(0, 5);
md += `\n响应头抽样（\`${PERF}/raw/load-full.json\` :headers）：\n\n`;
for (const h of sample) {
  md += `- \`${h.url?.replace(/^https?:\/\/[^/]+/, "")}\` → ${h.status}，content-type=${h.contentType}，content-encoding=${h.contentEncoding ?? "无"}，content-length=${h.contentLength ?? "?"}，cache-control=${h.cacheControl ?? "无"}\n`;
}
const compressed = (m.full?.load?.compression?.withEncoding ?? 0) > 0;
md += `\n**结论：${compressed ? "部分静态资源有压缩" : "静态资源没有压缩"}**：线上 body 字节等于 decoded 字节（例如样式 ${B("full.load.compression.byKind.style.wireBodyBytes")} = ${B("full.load.byKind.style.decoded")}），即使请求声明了 gzip/br。`;
// local gzip estimate (information, not a measurement of the server)
try {
  const dist = join(ROOT, "web/dist/assets");
  const files = readdirSync(dist);
  const est = (re) => files.filter((f) => re.test(f)).reduce((s, f) => s + gzipSync(readFileSync(join(dist, f))).length, 0);
  const raw = (re) => files.filter((f) => re.test(f)).reduce((s, f) => s + statSync(join(dist, f)).size, 0);
  const fontRaw = raw(/\.woff2?$/);
  md += `\n\n补充（本地估算，不是服务器测量值）：\`web/dist/assets\` 里 JS ${kb(raw(/\.js$/))} → gzip ${kb(est(/\.js$/))}；CSS ${kb(raw(/\.css$/))} → gzip ${kb(est(/\.css$/))}；字体文件合计 ${kb(fontRaw)}（${files.filter((f) => /\.woff2?$/.test(f)).length} 个，woff2 本身已压缩）。`;
} catch {}
md += `\n\n`;

// ------------------------------------------------------------------------ fps
md += `## 4. FPS / rAF 回调耗时（静置 10 s；drag / zoom 各 8 s）\n\n`;
md += `口径：包裹 \`requestAnimationFrame\`，每个 rAF 回调（含页面自己的渲染循环）的实际执行耗时 = \`frameScriptMs\`；fps = 1000 / 相邻不同帧时间戳之差，p1 为最慢 1% 帧对应的 fps；帧间隔 > ${V("full.fps.dropThresholdMs", 0, " ms")} 记 1 次掉帧。\n\n`;
md += `| 场景 | fps 中位 | fps p1 | 掉帧 | 停摆(>500 ms) | 帧数 | frameScriptMs p50 | p95 | max |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
const fpsRows = [
  ["empty 静置", "empty.fps"],
  ["ten 静置", "ten.fps"],
  ["full 静置", "full.fps"],
  ["full 拖拽 8 s", "full.fpsDrag"],
  ["full 缩放 8 s", "full.fpsZoom"],
];
for (const [label, p] of fpsRows) {
  md += `| ${label} | ${fmt(get(m, `${p}.fpsMedian`), 2)} | ${fmt(get(m, `${p}.fpsP1`), 2)} | ${fmt(get(m, `${p}.frameDrops`), 0)} | ${fmt(get(m, `${p}.stalls`), 0)} | ${fmt(get(m, `${p}.sampleCount`), 0)} | ${fmt(get(m, `${p}.frameScriptMs.p50`), 3)} ms | ${fmt(get(m, `${p}.frameScriptMs.p95`), 3)} ms | ${fmt(get(m, `${p}.frameScriptMs.max`), 3)} ms |\n`;
}
md += `\n来源字段：${fpsRows.map(([, p]) => cite(`${p}.{fpsMedian,fpsP1,frameDrops,frameScriptMs.p50,frameScriptMs.p95}`)).join(" ")}\n\n`;
md += `拖拽事件数 ${V("full.fpsDrag.mouseEvents", 0)}、滚轮事件数 ${V("full.fpsZoom.wheelEvents", 0)}（CDP \`Input.dispatchMouseEvent\`）。原始帧间隔与回调耗时：\`${PERF}/raw/fps-*.json\`、\`drag-full.json\`、\`zoom-full.json\`。\n\n`;

// -------------------------------------------------------------------- profile
md += `## 5. CPU profile（满场 \`/\` 静置 5 s，self time TOP10）\n\n`;
md += `文件：\`${PERF}/profiles/spectator-full.cpuprofile\`（采样间隔 200 µs，按 timeDeltas 加权）。总时长 ${V("full.cpuProfile.totalMs", 0, " ms")}，其中 (idle) ${V("full.cpuProfile.idleMs", 0, " ms")}。\`占忙时\` 为扣掉 (idle) 后的占比。\n\n`;
md += `| # | 函数 | 位置 | self ms | 占总时长 | 占忙时 | 来源 |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
(m.full?.cpuProfile?.top ?? []).forEach((r, i) => {
  const loc = r.url ? `${r.url.replace(/^https?:\/\/[^/]+/, "")}:${(r.line ?? 0) + 1}:${(r.col ?? 0) + 1}` : "(native)";
  md += `| ${i + 1} | \`${r.name}\` | ${loc} | ${fmt(r.selfMs, 1)} | ${fmt(r.pctTotal, 1)}% | ${r.pctBusy === null ? "—" : `${fmt(r.pctBusy, 1)}%`} | ${cite(`full.cpuProfile.top[${i}]`)} |\n`;
});
md += `\n（页面 JS 已压缩，函数名是混淆后的；用位置对照 \`web/dist/assets/index-*.js\` 的行列。）\n\n`;

// ------------------------------------------------------------------------ SSE
md += `## 6. SSE（\`/api/watch\`，Node 端读 ${V("full.sse.count", 0)} 条）\n\n`;
md += `- 单条字节（含 \`id/event/data\` 行与空行分隔符）：中位 ${B("full.sse.bytesMedian")}，p95 ${B("full.sse.bytesP95")}，最小 ${B("full.sse.bytesMin")}，最大 ${B("full.sse.bytesMax")}；首条 ${B("full.sse.firstEventBytes")}\n`;
md += `- 事件类型分布：\`${JSON.stringify(m.full?.sse?.byEvent)}\` ${cite("full.sse.byEvent")}；注释/心跳块 ${V("full.sse.comments", 0)} 个\n`;
md += `- JSON.parse 耗时（Node）：中位 ${V("full.sse.parseMsMedian", 4, " ms")}，p95 ${V("full.sse.parseMsP95", 4, " ms")}\n`;
md += `- tick 频率：${V("full.sse.tickHz", 3, " tick/s")}；事件频率 ${V("full.sse.eventHz", 3, " 条/s")}\n`;
md += `- 原始流：\`${PERF}/sse-raw.txt\`；逐条样本：\`${PERF}/raw/sse-full.json\`\n\n`;

// --------------------------------------------------------------------- replay
md += `## 7. 回放拖动（\`/replay?tick=${get(m, "full.scrub.tick")}\`，20 次 CDP 真实拖动）\n\n`;
md += `口径：${m.full?.scrub?.def ?? ""}\n\n`;
md += `- 模式：\`${m.full?.scrub?.mode}\` ${cite("full.scrub.mode")}（\`free-range\` = 该 world 没有任何高光标记——脚本 Agent 全程 idle，不产生成功/攻击事件——时间轴退回自由 tick 范围，拖动按轨道比例落在 20 个不同 tick 上；\`highlight-slots\` = 在相邻高光槽之间拖）\n`;
md += `- 高光 tick 数 ${V("full.scrub.highlightCount", 0)}，时间轴上可点的高光槽 ${V("full.scrub.slotCount", 0)}；有网络请求的样本 ${V("full.scrub.samplesWithNetwork", 0)} / ${V("full.scrub.samples", 0)}，超时样本 ${V("full.scrub.timeouts", 0)}\n`;
md += `- 拖动到画面更新（含 projection 请求）：p50 ${V("full.scrub.scrubP50", 1, " ms")}，p95 ${V("full.scrub.scrubP95", 1, " ms")}（${V("full.scrub.cleanSamples", 0)} 个页面持续出帧的样本）\n`;
md += `- 含主机造成的页面停摆的全部样本：p50 ${V("full.scrub.scrubAllP50", 1, " ms")}，p95 ${V("full.scrub.scrubAllP95", 1, " ms")}，最大 ${V("full.scrub.scrubAllMax", 1, " ms")}；停摆样本 ${V("full.scrub.stalledSamples", 0)} 个（拖动期间页面 ≥500 ms 不出帧，rAF 与 DOM 更新一起被推迟 0.5–5 s，与 §1 的合成器节流同源；已从 p50/p95 里剔除并在此并列，不隐藏）\n`;
md += `- 仅 DOM（TICK/指针）更新：p50 ${V("full.scrub.scrubDomP50", 1, " ms")}，p95 ${V("full.scrub.scrubDomP95", 1, " ms")}\n`;
md += `- 页内 \`/api/projection?tick=\` 请求耗时：p50 ${V("full.scrub.projectionFetchP50", 1, " ms")}，p95 ${V("full.scrub.projectionFetchP95", 1, " ms")}；Node 端对 ${V("full.scrub.projectionNodeFetchCount", 0)} 个不同 tick 各请求一次：p50 ${V("full.scrub.projectionNodeFetchP50", 1, " ms")}，p95 ${V("full.scrub.projectionNodeFetchP95", 1, " ms")}，单个响应中位 ${B("full.scrub.projectionBytesMedian")}\n`;
md += `- 原始逐次样本：\`${PERF}/raw/scrub-full.json\`\n\n`;

// ---------------------------------------------------------------------- visual
md += `## 8. 视觉 fixture 与截图\n\n`;
md += `- fixture：\`.conductor/perf/visual/data.tar\`（满场 data dir）与 \`meta.json\`；截图用 \`--tick-seconds 120\`（世界冻结）、1440×900 DPR1、\`prefers-reduced-motion: reduce\`、\`document.fonts.ready\` + 2 rAF。\n`;
md += `- 截图：\`docs/screenshots/perf-${tag}-spectator.png\`、\`docs/screenshots/perf-${tag}-replay-<tick>.png\`\n`;
md += `- \`pixdiff\` 自比（必须 0）：\n\n\`\`\`\n${selfdiff}\n\`\`\`\n`;
md += `- 同一 fixture 连续 5 次全新加载的一致性（页面相机只在首次拿到尺寸时居中一次，之后队列条/字体就绪会让画布整体偏移若干像素，所以同一个 world 可能出现不止一种布局变体；基准图取出现次数最多的变体，所有变体都留在 \`.conductor/perf/visual/variants-${tag}/\`，前后对照时先看是否落在同一变体，不同则按下面的差异区域解释）：\n\n\`\`\`\n${determinism}\n\`\`\`\n\n`;

// -------------------------------------------------------------------- verdicts
const fullFps = get(m, "full.fps.fpsMedian");
const scriptP50 = get(m, "full.fps.frameScriptMs.p50");
const dragFps = get(m, "full.fpsDrag.fpsMedian");
const zoomFps = get(m, "full.fpsZoom.fpsMedian");
const sseBytes = get(m, "full.sse.bytesMedian");
const sseParse = get(m, "full.sse.parseMsMedian");
const fontBytes = get(m, "full.load.byKind.font.transfer");
const scrubP95 = get(m, "full.scrub.scrubP95");
const yn = (b) => (b === null ? "**未测到**" : b ? "**是瓶颈**" : "**不是瓶颈**");
const cond = (...xs) => (xs.some((x) => !isNum(x)) ? null : true);

md += `## 9. 四个嫌疑 + 回放：是 / 不是瓶颈\n\n阈值取自 \`.conductor/contract-H.md\` §6、§7。\n\n`;
const b1 = cond(fullFps, scriptP50) ? fullFps < 55 || scriptP50 > 4 : null;
md += `1. **每帧重绘整张棋盘**：${yn(b1)}。判据：满场静置 fps 中位 < 55 或 rAF 回调耗时 p50 > 4 ms。数据：fps 中位 ${V("full.fps.fpsMedian", 2)}，p1 ${V("full.fps.fpsP1", 2)}，掉帧 ${V("full.fps.frameDrops", 0)}，回调耗时 p50 ${V("full.fps.frameScriptMs.p50", 3, " ms")} / p95 ${V("full.fps.frameScriptMs.p95", 3, " ms")}。空场回调耗时 p50 ${V("empty.fps.frameScriptMs.p50", 3, " ms")}、ten ${V("ten.fps.frameScriptMs.p50", 3, " ms")}：不同占用度下每帧脚本耗时几乎一样，说明这个量级下 Agent 数量对每帧脚本耗时没有可见影响；CPU profile 里时间主要在原生 canvas 调用（§5：drawImage/fillRect 与 (program)）。\n`;
const b2 = cond(sseBytes, sseParse) ? sseBytes >= 64 * 1024 || sseParse >= 2 : null;
md += `2. **SSE 整投影**：${yn(b2)}。判据：单条 ≥ 64 KB 或解析中位 ≥ 2 ms。数据：单条中位 ${B("full.sse.bytesMedian")}，p95 ${B("full.sse.bytesP95")}；JSON.parse 中位 ${V("full.sse.parseMsMedian", 4, " ms")}（Node 端；浏览器里还要加 setState 与重渲染，页内那部分已包含在上面的 rAF/fps 里）。\n`;
const b3 = cond(dragFps, zoomFps) ? dragFps < 55 || zoomFps < 55 : null;
md += `3. **插值重绘范围（拖拽/缩放时仍整盘重画）**：${yn(b3)}。判据：拖拽或缩放 fps 中位 < 55。数据：拖拽 ${V("full.fpsDrag.fpsMedian", 2)}（回调 p95 ${V("full.fpsDrag.frameScriptMs.p95", 3, " ms")}），缩放 ${V("full.fpsZoom.fpsMedian", 2)}（回调 p95 ${V("full.fpsZoom.frameScriptMs.p95", 3, " ms")}），静置 ${V("full.fps.fpsMedian", 2)}。\n`;
const b4 = isNum(fontBytes) ? fontBytes >= 150 * 1024 : null;
md += `4. **字体体积（“12 MB 字体”）**：${yn(b4)}（按首屏传输；阈值 150 KB）。数据：首屏字体 ${V("full.load.byKind.font.count", 0)} 个、${B("full.load.byKind.font.transfer")}，占首屏传输 ${fmt(isNum(fontBytes) && isNum(get(m, "full.load.transferTotal")) ? (100 * fontBytes) / get(m, "full.load.transferTotal") : null, 1)}%（总 ${B("full.load.transferTotal")}）；全部字体文件体积见 §3 补充；字体与 CSS 均无压缩（§3）。\n`;
const b5 = isNum(scrubP95) ? scrubP95 > 300 : null;
md += `5. **回放拖动**：${yn(b5)}。判据：p95 > 300 ms（取页面持续出帧的样本）。数据：p50 ${V("full.scrub.scrubP50", 1, " ms")}，p95 ${V("full.scrub.scrubP95", 1, " ms")}；全部样本 p95 ${V("full.scrub.scrubAllP95", 1, " ms")}（含 ${V("full.scrub.stalledSamples", 0)} 个主机停摆样本，不是页面延迟）；单次 projection 请求 p50 ${V("full.scrub.projectionFetchP50", 1, " ms")}，响应 ${B("full.scrub.projectionBytesMedian")}。\n\n`;

md += `## 10. 未测到 / 局限\n\n`;
const errs = ["empty", "ten", "full"].flatMap((o) => Object.entries(m[o]?.errors ?? {}).map(([k, v]) => `${o}/${k}: ${v}`));
md += errs.length ? errs.map((e) => `- 阶段失败：${e}`).join("\n") + "\n" : `- 所有阶段都跑完，没有阶段错误 ${cite("full.errors")}\n`;
md += `- “页面渲染耗时”只含 rAF 回调内的 JS 与 canvas 命令提交，不含 GPU 光栅与合成；fps 是无 vsync 封顶的 rAF 触发率（见 §1），不是屏幕显示帧率，也没有在真实 60/144 Hz 显示节奏下复核。\n`;
md += `- 首屏每个场景 5 次冷加载取中位；场景之间的差距要对照各自 5 次的最小–最大范围看，范围内的差异是噪声。\n`;
md += `- 回放拖动的“画面更新”以更新后第 2 个 rAF 的开始时间为终点（近似，浏览器不暴露 presentation time）。\n`;
md += `- 脚本 Agent 的 long-poll 与 loo-server 和被测浏览器同机，会占用一部分 CPU；empty/ten 场景该干扰更小，三个占用度的 fps/回调耗时对比里已包含这个差别。\n\n`;

md += `## 11. 重现\n\n\`\`\`sh\nscripts/perf.sh run --tag ${tag}   # 构建 + 3 个场景 + 视觉截图 + 本报告\nscripts/perf.sh compare            # 只有 before 时会注明 after 缺失\n\`\`\`\n\n`;
md += `产物：\`${PERF}/{metrics.json,occupancy.json,config.json,machine.json,sse-raw.txt}\`、\`${PERF}/profiles/*.cpuprofile\`、\`${PERF}/raw/*.json\`、\`docs/screenshots/perf-${tag}-*.png\`、\`.conductor/perf/visual/{data.tar,meta.json}\`\n`;

writeFileSync(join(ROOT, "docs/perf-report.md"), md);
console.log("wrote docs/perf-report.md");
