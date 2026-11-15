# Web perf baseline (before)

> 由 `scripts/perf.sh run --tag before` 生成（`scripts/perf/write-report.mjs`）。每个数字后的括号是来源文件与字段；原始样本在 `.conductor/perf/before/raw/*.json`。

## 1. 测量环境

- 时间：2026-11-15T05:18:52Z → 2026-11-15T05:25:48.361Z（UTC）
- 机器：Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz，12 线程，内存 14.9 GB，Linux 7.0.0-43-generic (.conductor/perf/before/metrics.json :machine.cpu)
- Chrome：Google Chrome 156.0.8078.79，有头（`DISPLAY=:0`，会话类型 wayland），视口 1440×900、DPR 1，`--ozone-platform=x11` (.conductor/perf/before/metrics.json :chrome_version)
  - 为什么必须 x11：默认走 Wayland 时本窗口收不到帧回调，5 秒内 rAF 只触发 2 次（调试时用最小 rAF 计数页实测）；x11（Xwayland）下同一页面 5 秒 678 帧。
  - 窗口节流是这台机器上的环境现象：Chrome 的 Xwayland 窗口会被合成器间歇性节流（页面几乎收不到帧回调，rAF 间隔 ≈1 s 甚至完全停摆，rAF 回调之外的定时器、DOM 更新也被一起推迟）。最小 rAF 探针（`rafprobe`，每次 run 重测，每种配置 3 个全新页面各 3 s）：vsync 开启 5 帧 / 3 s，间隔中位 1001.0 ms，最大 1001.1 ms；5 帧 / 3 s，间隔中位 1000.4 ms，最大 1001.5 ms；5 帧 / 3 s，间隔中位 1001.0 ms，最大 1001.1 ms，其中出现停摆的页面 3 (.conductor/perf/before/metrics.json :empty.rafProbe.vsyncOnThrottledPages) / 3 (.conductor/perf/before/metrics.json :empty.rafProbe.vsyncOn)；关闭 vsync 与帧率上限 1393 帧 / 3 s，间隔中位 1.9 ms，最大 17.0 ms；973 帧 / 3 s，间隔中位 2.5 ms，最大 13.5 ms；0 帧 / 3 s，间隔中位 未测到 ms，最大 5000.3 ms，出现停摆的页面 1 (.conductor/perf/before/metrics.json :empty.rafProbe.vsyncOffThrottledPages) / 3 (.conductor/perf/before/metrics.json :empty.rafProbe.vsyncOff)。（“停摆”= 探针期间没有拿到连续出帧；0 帧表示 5 s 内 rAF 一次都没触发。）
  - 所以关 vsync **没有**消除节流，只能说明节流与 vsync 设置无关。处理办法是：每个正式阶段都记录停摆次数（帧间隔 > 500 ms）——本次 empty/ten/full 静置、拖拽、缩放阶段的停摆次数分别为 0 / 0 / 0 / 0 / 0 (.conductor/perf/before/metrics.json :full.fps.stalls)；回放拖动里被节流的样本单独标出并并列报告（§7）。
  - 测量 Chrome 仍然关 vsync 与帧率上限（`--disable-gpu-vsync --disable-frame-rate-limit`）：为的是 fps 不被刷新率封顶、能随每帧成本变化。因此本报告的 **fps = 页面在无刷新率封顶时 rAF 每秒能跑多少帧**（越高说明每帧越便宜），不是屏幕实际显示帧率；前后对比同口径。frameScriptMs 不受这个影响。
- 并发 / 干扰：load average 开始 3.58 4.23 4.11 1/3394 1510600 (.conductor/perf/before/machine.json :machine.loadavg)；各场景测量期间 empty: 3.58 4.23 4.11 7/3406 1510653 → 4.58 4.33 4.15 30/3337 1514059；ten: 3.76 4.15 4.09 1/3361 1515314 → 4.36 4.26 4.13 19/3330 1516746；full: 3.05 3.68 3.92 2/3460 1535044 → 4.97 4.38 4.16 1/3465 1547243 (.conductor/perf/before/metrics.json :full.loadavgStart)。
  - loo-server、100 个脚本 Agent（full 场景每秒约 100 个 long-poll）、Chrome 同机；本机同时还有其他 Orca 工作区的 Agent/服务在跑（并行 Master G 等），CPU 占用前列：57.1 MainThread | 26.0 chrome | 11.7 orca-ide | 7.1 echolet (.conductor/perf/before/machine.json :machine.topCpu)。数字带这份干扰，前后对比必须同机同脚本。
- 观战页路由是 `/`（`web/src/router.ts`），`/spectator` 在应用里只是“建设中”占位页；本报告里“spectator”指 `/`。截图文件名沿用契约的 `perf-before-spectator.png`。
- dev 服务配置（`.conductor/perf/before/config.json`）：`{"need":{"deadline_ticks_min":1000000,"deadline_ticks_max":1000000},"session":{"idle_cleanup_ticks":100000,"queue_idle_seconds":100000},"limits":{"requests_per_second":2}}` (.conductor/perf/before/metrics.json :devConfig)
  - 其中 `need.deadline_ticks_min/max=1000000`、`session.idle_cleanup_ticks=100000`、`session.queue_idle_seconds=100000` 只是把会话到期/清理时间推到测量窗口之外（否则默认 120–240 tick 的 deadline 会让场内 Agent 陆续结束、补不满 50/50）；`limits.requests_per_second=2` 是默认值。其余 dev 规则未改。tick = 1 秒。
- 脚本 Agent：register → join → 循环 `/api/wait`（timeout 1 s）保活，不移动不攻击；`placement==null` 时重新 register + join。
- 计时口径：`performance.now()` 在非跨源隔离页面里被 Chrome 粗化到 0.1 ms，所以 rAF 回调耗时 < 0.1 ms 的量级只能当上界看。

## 2. 占用度校验（开始与结束各取一次 /api/projection）

| 场景 | 开始 inside/queued | 结束 inside/queued | seed 退出时打印 | 来源 |
| --- | --- | --- | --- | --- |
| empty | 0/0（OK） | 0/0（OK） | —（无 seed） | (.conductor/perf/before/occupancy.json :empty.start / empty.end) |
| ten | 10/0（OK） | 10/0（OK） | inside=10 queued=0 | (.conductor/perf/before/occupancy.json :ten.start / ten.end) |
| full | 50/50（OK） | 50/50（OK） | inside=50 queued=50 | (.conductor/perf/before/occupancy.json :full.start / full.end) |

满场容量：inside 50 (.conductor/perf/before/metrics.json :occupancy.start.capacity)，queue 50 (.conductor/perf/before/metrics.json :occupancy.start.queue_capacity)；满场校验 通过 (.conductor/perf/before/metrics.json :occupancy.ok)

## 3. 首屏（冷缓存、禁用缓存 `/`）

口径：`interactiveMs` = 从 navigationStart 到“首个 canvas 非空帧绘制完成”（首个发出 ≥20 次 canvas 绘制调用的 rAF 回调结束）的时间；TBT = FCP 到 interactiveMs 之间长任务超出 50 ms 的部分之和（`tbtAll` 为全部长任务）。传输体积含 HTML 文档本身。

| 指标 | empty | ten | full |
| --- | --- | --- | --- |
| 传输合计 (B) | 941711 | 1006187 | 1006187 |
| decoded 合计 (B) | 934811 | 998687 | 998687 |
| 请求数 | 23 | 25 | 25 |
| interactiveMs (ms)，5 次冷加载的中位 | 291.2 | 331.9 | 298.4 |
| interactiveMs 5 次的最小 – 最大 (ms) | 246.5 – 305.7 | 298.0 – 435.5 | 259.6 – 333.6 |
| FCP (ms) | 284.0 | 284.0 | 256.0 |
| LCP (ms) | 284.0 | 368.0 | 344.0 |
| TBT (ms) | 0.0 | 0.0 | 0.0 |
| tbtAll (ms) | 88.0 | 95.0 | 58.0 |
| DOMContentLoaded (ms) | 104.0 | 170.7 | 126.4 |
| load (ms) | 162.0 | 223.0 | 183.5 |

来源：(.conductor/perf/before/metrics.json :empty.load.*) (.conductor/perf/before/metrics.json :ten.load.*) (.conductor/perf/before/metrics.json :full.load.*)

### 满场首屏按类型（transferSize / decodedBodySize）

| 类型 | 请求数 | transfer | decoded | 来源 |
| --- | --- | --- | --- | --- |
| document | 1 (.conductor/perf/before/metrics.json :full.load.byKind.document.count) | 900 B (.conductor/perf/before/metrics.json :full.load.byKind.document.transfer) | 600 B (.conductor/perf/before/metrics.json :full.load.byKind.document.decoded) | |
| script | 1 (.conductor/perf/before/metrics.json :full.load.byKind.script.count) | 82,605 B (.conductor/perf/before/metrics.json :full.load.byKind.script.transfer) | 82,305 B (.conductor/perf/before/metrics.json :full.load.byKind.script.decoded) | |
| style | 1 (.conductor/perf/before/metrics.json :full.load.byKind.style.count) | 286,180 B (.conductor/perf/before/metrics.json :full.load.byKind.style.transfer) | 285,880 B (.conductor/perf/before/metrics.json :full.load.byKind.style.decoded) | |
| font | 18 (.conductor/perf/before/metrics.json :full.load.byKind.font.count) | 621,296 B (.conductor/perf/before/metrics.json :full.load.byKind.font.transfer) | 615,896 B (.conductor/perf/before/metrics.json :full.load.byKind.font.decoded) | |
| api | 3 (.conductor/perf/before/metrics.json :full.load.byKind.api.count) | 14,306 B (.conductor/perf/before/metrics.json :full.load.byKind.api.transfer) | 13,406 B (.conductor/perf/before/metrics.json :full.load.byKind.api.decoded) | |
| image | 1 (.conductor/perf/before/metrics.json :full.load.byKind.image.count) | 900 B (.conductor/perf/before/metrics.json :full.load.byKind.image.transfer) | 600 B (.conductor/perf/before/metrics.json :full.load.byKind.image.decoded) | |

（`byType` 按 initiatorType 的分组也在 metrics 里：(.conductor/perf/before/metrics.json :full.load.byType)；字体由 CSS 发起，所以 initiatorType 为 css。）

首屏大头：字体 621,296 B (.conductor/perf/before/metrics.json :full.load.byKind.font.transfer)、样式 286,180 B (.conductor/perf/before/metrics.json :full.load.byKind.style.transfer)、脚本 82,605 B (.conductor/perf/before/metrics.json :full.load.byKind.script.transfer)。

### 静态资源响应头（是否压缩）

证据：对 `/` 及首屏加载的每个同源静态资源，用原始 HTTP（`Accept-Encoding: gzip, br`，不自动解压）各请求一次，共 22 (.conductor/perf/before/metrics.json :full.load.compression.checked)，其中带 `Content-Encoding` 的 0 (.conductor/perf/before/metrics.json :full.load.compression.withEncoding)。

| 类型 | 资源数 | 带 content-encoding | 线上 body 字节合计 | 来源 |
| --- | --- | --- | --- | --- |
| other | 1 (.conductor/perf/before/metrics.json :full.load.compression.byKind.other.n) | 0 (.conductor/perf/before/metrics.json :full.load.compression.byKind.other.encoded) | 600 B (.conductor/perf/before/metrics.json :full.load.compression.byKind.other.wireBodyBytes) | |
| script | 1 (.conductor/perf/before/metrics.json :full.load.compression.byKind.script.n) | 0 (.conductor/perf/before/metrics.json :full.load.compression.byKind.script.encoded) | 82,305 B (.conductor/perf/before/metrics.json :full.load.compression.byKind.script.wireBodyBytes) | |
| style | 1 (.conductor/perf/before/metrics.json :full.load.compression.byKind.style.n) | 0 (.conductor/perf/before/metrics.json :full.load.compression.byKind.style.encoded) | 285,880 B (.conductor/perf/before/metrics.json :full.load.compression.byKind.style.wireBodyBytes) | |
| font | 18 (.conductor/perf/before/metrics.json :full.load.compression.byKind.font.n) | 0 (.conductor/perf/before/metrics.json :full.load.compression.byKind.font.encoded) | 615,896 B (.conductor/perf/before/metrics.json :full.load.compression.byKind.font.wireBodyBytes) | |
| image | 1 (.conductor/perf/before/metrics.json :full.load.compression.byKind.image.n) | 0 (.conductor/perf/before/metrics.json :full.load.compression.byKind.image.encoded) | 600 B (.conductor/perf/before/metrics.json :full.load.compression.byKind.image.wireBodyBytes) | |

响应头抽样（`.conductor/perf/before/raw/load-full.json` :headers）：

- `/` → 200，content-type=text/html; charset=utf-8，content-encoding=无，content-length=600，cache-control=no-cache
- `/assets/index-19D2lH2X.js` → 200，content-type=text/javascript; charset=utf-8，content-encoding=无，content-length=82305，cache-control=public, max-age=31536000, immutable
- `/assets/index-D4vi3jWZ.css` → 200，content-type=text/css; charset=utf-8，content-encoding=无，content-length=285880，cache-control=public, max-age=31536000, immutable
- `/assets/zcool-qingke-huangyou-116-400-normal-BZhzVL1t.woff2` → 200，content-type=font/woff2，content-encoding=无，content-length=47160，cache-control=public, max-age=31536000, immutable
- `/assets/silkscreen-latin-400-normal-CtPo2yA5.woff2` → 200，content-type=font/woff2，content-encoding=无，content-length=8404，cache-control=public, max-age=31536000, immutable

**结论：静态资源没有压缩**：线上 body 字节等于 decoded 字节（例如样式 285,880 B (.conductor/perf/before/metrics.json :full.load.compression.byKind.style.wireBodyBytes) = 285,880 B (.conductor/perf/before/metrics.json :full.load.byKind.style.decoded)），即使请求声明了 gzip/br。

补充（本地估算，不是服务器测量值）：`web/dist/assets` 里 JS 80.4 KB → gzip 25.3 KB；CSS 279.2 KB → gzip 120.9 KB；字体文件合计 10467.0 KB（373 个，woff2 本身已压缩）。

## 4. FPS / rAF 回调耗时（静置 10 s；drag / zoom 各 8 s）

口径：包裹 `requestAnimationFrame`，每个 rAF 回调（含页面自己的渲染循环）的实际执行耗时 = `frameScriptMs`；fps = 1000 / 相邻不同帧时间戳之差，p1 为最慢 1% 帧对应的 fps；帧间隔 > 25 ms (.conductor/perf/before/metrics.json :full.fps.dropThresholdMs) 记 1 次掉帧。

| 场景 | fps 中位 | fps p1 | 掉帧 | 停摆(>500 ms) | 帧数 | frameScriptMs p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| empty 静置 | 476.19 | 175.44 | 0 | 0 | 4340 | 1.300 ms | 2.100 ms | 5.100 ms |
| ten 静置 | 416.67 | 107.53 | 0 | 0 | 3709 | 1.500 ms | 2.300 ms | 12.400 ms |
| full 静置 | 526.32 | 92.59 | 0 | 0 | 3737 | 1.100 ms | 1.900 ms | 5.300 ms |
| full 拖拽 8 s | 454.55 | 91.74 | 0 | 0 | 3152 | 1.300 ms | 2.100 ms | 6.400 ms |
| full 缩放 8 s | 555.56 | 106.38 | 0 | 0 | 3900 | 1.100 ms | 2.100 ms | 7.200 ms |

来源字段：(.conductor/perf/before/metrics.json :empty.fps.{fpsMedian,fpsP1,frameDrops,frameScriptMs.p50,frameScriptMs.p95}) (.conductor/perf/before/metrics.json :ten.fps.{fpsMedian,fpsP1,frameDrops,frameScriptMs.p50,frameScriptMs.p95}) (.conductor/perf/before/metrics.json :full.fps.{fpsMedian,fpsP1,frameDrops,frameScriptMs.p50,frameScriptMs.p95}) (.conductor/perf/before/metrics.json :full.fpsDrag.{fpsMedian,fpsP1,frameDrops,frameScriptMs.p50,frameScriptMs.p95}) (.conductor/perf/before/metrics.json :full.fpsZoom.{fpsMedian,fpsP1,frameDrops,frameScriptMs.p50,frameScriptMs.p95})

拖拽事件数 422 (.conductor/perf/before/metrics.json :full.fpsDrag.mouseEvents)、滚轮事件数 199 (.conductor/perf/before/metrics.json :full.fpsZoom.wheelEvents)（CDP `Input.dispatchMouseEvent`）。原始帧间隔与回调耗时：`.conductor/perf/before/raw/fps-*.json`、`drag-full.json`、`zoom-full.json`。

## 5. CPU profile（满场 `/` 静置 5 s，self time TOP10）

文件：`.conductor/perf/before/profiles/spectator-full.cpuprofile`（采样间隔 200 µs，按 timeDeltas 加权）。总时长 5003 ms (.conductor/perf/before/metrics.json :full.cpuProfile.totalMs)，其中 (idle) 46 ms (.conductor/perf/before/metrics.json :full.cpuProfile.idleMs)。`占忙时` 为扣掉 (idle) 后的占比。

| # | 函数 | 位置 | self ms | 占总时长 | 占忙时 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `(program)` | (native) | 1997.4 | 39.9% | 40.3% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[0]) |
| 2 | `drawImage` | (native) | 991.8 | 19.8% | 20.0% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[1]) |
| 3 | `fillRect` | (native) | 726.5 | 14.5% | 14.7% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[2]) |
| 4 | `rn` | /assets/index-19D2lH2X.js:241:3511 | 288.0 | 5.8% | 5.8% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[3]) |
| 5 | `yn` | /assets/index-19D2lH2X.js:241:4761 | 259.3 | 5.2% | 5.2% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[4]) |
| 6 | `Sn` | /assets/index-19D2lH2X.js:241:5582 | 244.9 | 4.9% | 4.9% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[5]) |
| 7 | `t` | /assets/index-19D2lH2X.js:241:30471 | 82.4 | 1.6% | 1.7% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[6]) |
| 8 | `$` | /assets/index-19D2lH2X.js:241:4674 | 59.9 | 1.2% | 1.2% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[7]) |
| 9 | `(idle)` | (native) | 45.9 | 0.9% | — | (.conductor/perf/before/metrics.json :full.cpuProfile.top[8]) |
| 10 | `xn` | /assets/index-19D2lH2X.js:241:5236 | 39.9 | 0.8% | 0.8% | (.conductor/perf/before/metrics.json :full.cpuProfile.top[9]) |

（页面 JS 已压缩，函数名是混淆后的；用位置对照 `web/dist/assets/index-*.js` 的行列。）

## 6. SSE（`/api/watch`，Node 端读 20 (.conductor/perf/before/metrics.json :full.sse.count) 条）

- 单条字节（含 `id/event/data` 行与空行分隔符）：中位 371,931 B (.conductor/perf/before/metrics.json :full.sse.bytesMedian)，p95 371,931 B (.conductor/perf/before/metrics.json :full.sse.bytesP95)，最小 62 B (.conductor/perf/before/metrics.json :full.sse.bytesMin)，最大 371,931 B (.conductor/perf/before/metrics.json :full.sse.bytesMax)；首条 62 B (.conductor/perf/before/metrics.json :full.sse.firstEventBytes)
- 事件类型分布：`{"hello":1,"tick":19}` (.conductor/perf/before/metrics.json :full.sse.byEvent)；注释/心跳块 2 (.conductor/perf/before/metrics.json :full.sse.comments) 个
- JSON.parse 耗时（Node）：中位 2.4155 ms (.conductor/perf/before/metrics.json :full.sse.parseMsMedian)，p95 2.9993 ms (.conductor/perf/before/metrics.json :full.sse.parseMsP95)
- tick 频率：1.031 tick/s (.conductor/perf/before/metrics.json :full.sse.tickHz)；事件频率 1.089 条/s (.conductor/perf/before/metrics.json :full.sse.eventHz)
- 原始流：`.conductor/perf/before/sse-raw.txt`；逐条样本：`.conductor/perf/before/raw/sse-full.json`

## 7. 回放拖动（`/replay?tick=212`，20 次 CDP 真实拖动）

口径：scrubMs = last pointermove event.timeStamp -> (DOM updated, all /api/projection?tick= fetches done) + 2 rAF; 20 real CDP drags (press, then move) on the replay timeline, each landing on a different tick. p50/p95 = samples where the page kept producing frames; scrubAll* = every sample incl. host-induced page stalls

- 模式：`free-range` (.conductor/perf/before/metrics.json :full.scrub.mode)（`free-range` = 该 world 没有任何高光标记——脚本 Agent 全程 idle，不产生成功/攻击事件——时间轴退回自由 tick 范围，拖动按轨道比例落在 20 个不同 tick 上；`highlight-slots` = 在相邻高光槽之间拖）
- 高光 tick 数 0 (.conductor/perf/before/metrics.json :full.scrub.highlightCount)，时间轴上可点的高光槽 0 (.conductor/perf/before/metrics.json :full.scrub.slotCount)；有网络请求的样本 20 (.conductor/perf/before/metrics.json :full.scrub.samplesWithNetwork) / 20 (.conductor/perf/before/metrics.json :full.scrub.samples)，超时样本 0 (.conductor/perf/before/metrics.json :full.scrub.timeouts)
- 拖动到画面更新（含 projection 请求）：p50 142.3 ms (.conductor/perf/before/metrics.json :full.scrub.scrubP50)，p95 181.7 ms (.conductor/perf/before/metrics.json :full.scrub.scrubP95)（20 (.conductor/perf/before/metrics.json :full.scrub.cleanSamples) 个页面持续出帧的样本）
- 含主机造成的页面停摆的全部样本：p50 142.3 ms (.conductor/perf/before/metrics.json :full.scrub.scrubAllP50)，p95 181.7 ms (.conductor/perf/before/metrics.json :full.scrub.scrubAllP95)，最大 182.2 ms (.conductor/perf/before/metrics.json :full.scrub.scrubAllMax)；停摆样本 0 (.conductor/perf/before/metrics.json :full.scrub.stalledSamples) 个（拖动期间页面 ≥500 ms 不出帧，rAF 与 DOM 更新一起被推迟 0.5–5 s，与 §1 的合成器节流同源；已从 p50/p95 里剔除并在此并列，不隐藏）
- 仅 DOM（TICK/指针）更新：p50 2.9 ms (.conductor/perf/before/metrics.json :full.scrub.scrubDomP50)，p95 5.1 ms (.conductor/perf/before/metrics.json :full.scrub.scrubDomP95)
- 页内 `/api/projection?tick=` 请求耗时：p50 33.1 ms (.conductor/perf/before/metrics.json :full.scrub.projectionFetchP50)，p95 62.7 ms (.conductor/perf/before/metrics.json :full.scrub.projectionFetchP95)；Node 端对 20 (.conductor/perf/before/metrics.json :full.scrub.projectionNodeFetchCount) 个不同 tick 各请求一次：p50 23.6 ms (.conductor/perf/before/metrics.json :full.scrub.projectionNodeFetchP50)，p95 53.6 ms (.conductor/perf/before/metrics.json :full.scrub.projectionNodeFetchP95)，单个响应中位 371,936 B (.conductor/perf/before/metrics.json :full.scrub.projectionBytesMedian)
- 原始逐次样本：`.conductor/perf/before/raw/scrub-full.json`

## 8. 视觉 fixture 与截图

- fixture：`.conductor/perf/visual/data.tar`（满场 data dir）与 `meta.json`；截图用 `--tick-seconds 120`（世界冻结）、1440×900 DPR1、`prefers-reduced-motion: reduce`、`document.fonts.ready` + 2 rAF。
- 截图：`docs/screenshots/perf-before-spectator.png`、`docs/screenshots/perf-before-replay-<tick>.png`
- `pixdiff` 自比（必须 0）：

```
diff_pixels=0 total_pixels=1296000 bbox=null
diff_pixels=0 total_pixels=1296000 bbox=null
```
- 同一 fixture 连续 5 次全新加载的一致性（页面相机只在首次拿到尺寸时居中一次，之后队列条/字体就绪会让画布整体偏移若干像素，所以同一个 world 可能出现不止一种布局变体；基准图取出现次数最多的变体，所有变体都留在 `.conductor/perf/visual/variants-before/`，前后对照时先看是否落在同一变体，不同则按下面的差异区域解释）：

```
perf-before-spectator.png: 3/5 fresh loads identical to the reference shot; 2 layout variant(s)
  variant x2 (.conductor/perf/visual/variants-before/perf-before-spectator.v1.png) vs reference: diff_pixels=310724 total_pixels=1296000 bbox={"minX":0,"minY":174,"maxX":959,"maxY":784}
perf-before-replay-212.png: 5/5 fresh loads identical to the reference shot; 1 layout variant(s)
```

## 9. 四个嫌疑 + 回放：是 / 不是瓶颈

阈值取自 `.conductor/contract-H.md` §6、§7。

1. **每帧重绘整张棋盘**：**不是瓶颈**。判据：满场静置 fps 中位 < 55 或 rAF 回调耗时 p50 > 4 ms。数据：fps 中位 526.32 (.conductor/perf/before/metrics.json :full.fps.fpsMedian)，p1 92.59 (.conductor/perf/before/metrics.json :full.fps.fpsP1)，掉帧 0 (.conductor/perf/before/metrics.json :full.fps.frameDrops)，回调耗时 p50 1.100 ms (.conductor/perf/before/metrics.json :full.fps.frameScriptMs.p50) / p95 1.900 ms (.conductor/perf/before/metrics.json :full.fps.frameScriptMs.p95)。空场回调耗时 p50 1.300 ms (.conductor/perf/before/metrics.json :empty.fps.frameScriptMs.p50)、ten 1.500 ms (.conductor/perf/before/metrics.json :ten.fps.frameScriptMs.p50)：不同占用度下每帧脚本耗时几乎一样，说明这个量级下 Agent 数量对每帧脚本耗时没有可见影响；CPU profile 里时间主要在原生 canvas 调用（§5：drawImage/fillRect 与 (program)）。
2. **SSE 整投影**：**是瓶颈**。判据：单条 ≥ 64 KB 或解析中位 ≥ 2 ms。数据：单条中位 371,931 B (.conductor/perf/before/metrics.json :full.sse.bytesMedian)，p95 371,931 B (.conductor/perf/before/metrics.json :full.sse.bytesP95)；JSON.parse 中位 2.4155 ms (.conductor/perf/before/metrics.json :full.sse.parseMsMedian)（Node 端；浏览器里还要加 setState 与重渲染，页内那部分已包含在上面的 rAF/fps 里）。
3. **插值重绘范围（拖拽/缩放时仍整盘重画）**：**不是瓶颈**。判据：拖拽或缩放 fps 中位 < 55。数据：拖拽 454.55 (.conductor/perf/before/metrics.json :full.fpsDrag.fpsMedian)（回调 p95 2.100 ms (.conductor/perf/before/metrics.json :full.fpsDrag.frameScriptMs.p95)），缩放 555.56 (.conductor/perf/before/metrics.json :full.fpsZoom.fpsMedian)（回调 p95 2.100 ms (.conductor/perf/before/metrics.json :full.fpsZoom.frameScriptMs.p95)），静置 526.32 (.conductor/perf/before/metrics.json :full.fps.fpsMedian)。
4. **字体体积（“12 MB 字体”）**：**是瓶颈**（按首屏传输；阈值 150 KB）。数据：首屏字体 18 (.conductor/perf/before/metrics.json :full.load.byKind.font.count) 个、621,296 B (.conductor/perf/before/metrics.json :full.load.byKind.font.transfer)，占首屏传输 61.7%（总 1,006,187 B (.conductor/perf/before/metrics.json :full.load.transferTotal)）；全部字体文件体积见 §3 补充；字体与 CSS 均无压缩（§3）。
5. **回放拖动**：**不是瓶颈**。判据：p95 > 300 ms（取页面持续出帧的样本）。数据：p50 142.3 ms (.conductor/perf/before/metrics.json :full.scrub.scrubP50)，p95 181.7 ms (.conductor/perf/before/metrics.json :full.scrub.scrubP95)；全部样本 p95 181.7 ms (.conductor/perf/before/metrics.json :full.scrub.scrubAllP95)（含 0 (.conductor/perf/before/metrics.json :full.scrub.stalledSamples) 个主机停摆样本，不是页面延迟）；单次 projection 请求 p50 33.1 ms (.conductor/perf/before/metrics.json :full.scrub.projectionFetchP50)，响应 371,936 B (.conductor/perf/before/metrics.json :full.scrub.projectionBytesMedian)。

## 10. 未测到 / 局限

- 所有阶段都跑完，没有阶段错误 (.conductor/perf/before/metrics.json :full.errors)
- “页面渲染耗时”只含 rAF 回调内的 JS 与 canvas 命令提交，不含 GPU 光栅与合成；fps 是无 vsync 封顶的 rAF 触发率（见 §1），不是屏幕显示帧率，也没有在真实 60/144 Hz 显示节奏下复核。
- 首屏每个场景 5 次冷加载取中位；场景之间的差距要对照各自 5 次的最小–最大范围看，范围内的差异是噪声。
- 回放拖动的“画面更新”以更新后第 2 个 rAF 的开始时间为终点（近似，浏览器不暴露 presentation time）。
- 脚本 Agent 的 long-poll 与 loo-server 和被测浏览器同机，会占用一部分 CPU；empty/ten 场景该干扰更小，三个占用度的 fps/回调耗时对比里已包含这个差别。

## 11. 重现

```sh
scripts/perf.sh run --tag before   # 构建 + 3 个场景 + 视觉截图 + 本报告
scripts/perf.sh compare            # 只有 before 时会注明 after 缺失
```

产物：`.conductor/perf/before/{metrics.json,occupancy.json,config.json,machine.json,sse-raw.txt}`、`.conductor/perf/before/profiles/*.cpuprofile`、`.conductor/perf/before/raw/*.json`、`docs/screenshots/perf-before-*.png`、`.conductor/perf/visual/{data.tar,meta.json}`
