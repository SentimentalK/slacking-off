# 网页性能：测量与修复（PROJECT-126-H）

测量脚本：`scripts/perf.sh`（一条命令重跑、前后两组数字）。
原始输出：`.conductor/perf/{before,after}/`（JSON/CSV/cpuprofile/SSE 原始流/截图，gitignored）。
本报告的每个数字都带 `(文件 :字段)`；重算见 §12。

## 1. 结论

| 指标（满场 50 在场 + 50 排队，1440×900） | 修复前 | 修复后 | 变化 |
| --- | --- | --- | --- |
| 首屏传输合计 | 1,006,187 B | 787,329 B | **−21.7%** |
| 首屏可交互（首个 canvas 非空帧） | 395.4 ms | 244.3 ms | **−38.2%** |
| FCP / LCP | 340 / 444 ms | 212 / 276 ms | −37.6% / −37.8% |
| SSE 单条 `tick` 事件（中位） | 371,931 B | 16,715 B | **−95.5%** |
| SSE JSON.parse（中位） | 4.22 ms | 0.19 ms | −95.4% |
| 满场静置 rAF 中位 | 333.33 fps | 434.78 fps | +30.4% |
| 满场拖拽 / 缩放 rAF 中位 | 344.83 / 526.32 fps | 416.67 / 588.24 fps | +20.8% / +11.8% |
| 满场 rAF 回调耗时 p50 / p95 | 1.9 / 2.6 ms | 1.4 / 2.0 ms | −26% / −23% |
| 回放拖动 p50 / p95 | 142.2 / 190.2 ms | 142.2 / 163.8 ms | 回放代码未改（§6），差异是同一实现的测量噪声 |

来源：首屏 `(.conductor/perf/before/metrics.json :full.load.transferTotal / :full.load.interactiveMs / :full.load.fcp / :full.load.lcp)`、`(.conductor/perf/after/metrics.json :full.load.*)`；SSE `(:full.sse.bytesMedian / :full.sse.parseMsMedian)`；fps `(:full.fps.* / :full.fpsDrag.* / :full.fpsZoom.*)`；回放 `(:full.scrub.*)`。

改动两处、跳过两处（见 §8–§10）：

1. **SSE objects 增量**：2996 个物件里几乎都是墙/门/马桶，跨 tick 不变；现在只有首帧（或重连/断号）发全量，连续 tick 只发变化的物件和消失的位置。客户端合并后拿到的仍是完整投影。
2. **静态资源 gzip**：`web/dist` 构建时生成 `.gz` 并嵌入二进制；请求带 `Accept-Encoding: gzip` 时就发压缩体。CSS 286,180→124,026 B，JS 82,605→26,309 B，HTML 900→696 B。
3. （跳过）渲染器整盘重绘：测量证明不是瓶颈（§9.1），不改。
4. （跳过）回放拖动请求合并：实现后 p50 142→154 ms、p95 190→173 ms，没有可见改善（§9.5），已 revert，只保留测量结论。

## 2. 测量方法与口径

- 机器：Intel Core i7-10750H，12 线程，14.9 GB，Linux 7.0.0-43-generic `(.conductor/perf/before/metrics.json :machine.cpu)`；Chrome `Google Chrome 156.0.8078.79`，有头（`DISPLAY=:0`，`--ozone-platform=x11`），视口 1440×900、DPR 1 `(:chrome_version)`。
- 前后两次用**同一脚本、同一机器、同一 Chrome 版本**；只改被测代码。
- 代码基线：`b6d17d5`（G 的 rules/限流/退出码 + I 的稀缺世界已合入）。此前在 `aa7910f` 上量过的第一版基线保留在 `.conductor/perf/before-aa7910f/`（结论一致：首屏 1,006,187 B、SSE 371,931 B）。
- **地图固定为生产地图**：I 把仓库默认世界改成 48×32 / 12 在场 / 队列 10，但线上仍是 130×100 / 50 / 50。为了让"修复前后"是同一压力场景，测量用 `--map .conductor/perf/map-prod.txt`（`git show aa7910f:maps/default.txt`，sha256 `cc3c9e05…`），并用 dev 配置覆盖 `max_on_field=50`、`session.queue_capacity=50`；`need.deadline_ticks_*`、`session.queue_idle_seconds`、`session.idle_cleanup_ticks` 推到测量窗口之外，防止掉人。**这是测量配置，不是新默认。** `(.conductor/perf/before/config.json, :full... )`
- 满场是真实造出来的：`scripts/perf/seed.mjs` 注册 100 个 dev Agent，join 后各自走到唯一停靠格并循环 `/api/wait` 保活；开始与结束各校验一次 `/api/projection`：`inside=50, queued=50, agents=50, queue=50` `(.conductor/perf/before/occupancy.json :full.start / :full.end)`。
- 首屏：冷缓存（`Network.setCacheDisabled` + 清缓存），每场景 5 次取中位；`interactiveMs` = navigationStart → 首个非空 canvas 帧；FCP/LCP/TBT 来自 PerformanceObserver。
- FPS：包裹 `requestAnimationFrame`，量每个回调的实际执行耗时（`frameScriptMs`）；fps = 相邻帧时间戳差。**本机 Xwayland 窗口会被合成器间歇节流到 ~1 Hz**，所以关掉 vsync/帧率上限（`--disable-gpu-vsync --disable-frame-rate-limit`），fps 表示"每秒能画多少帧（每帧多便宜）"，不是屏幕刷新率；这是同口径的前后对比。每次 run 都跑 rAF 探针并记录停摆样本 `(:empty.rafProbe, :full.fps.stalls)`。
- 干扰：server、100 个脚本 Agent（每秒约 100 个 long-poll）、Chrome 同机；测量期间并行 Master/其他工作区仍有负载，记录在 `(:machine.loadavgStart / :machine.topCpu)`。前后两次的负载区间相近。

## 3. 首屏

| 指标 · 满场 | before | after | 来源 |
| --- | --- | --- | --- |
| 传输合计 (B) | 1,006,187 | 787,329 | `:full.load.transferTotal` |
| decoded 合计 (B) | 998,687 | 999,215 | `:full.load.decodedTotal` |
| 请求数 | 25 | 25 | `:full.load.requestCount` |
| interactiveMs | 395.4 | 244.3 | `:full.load.interactiveMs` |
| FCP / LCP (ms) | 340 / 444 | 212 / 276 | `:full.load.fcp / .lcp` |
| TBT (ms) | 0 | 0 | `:full.load.tbt` |

按类型（满场，transfer B）：

| 类型 | before | after | 说明 |
| --- | --- | --- | --- |
| font | 621,296（18 个） | 621,296（18 个） | woff2 已压缩；§10 |
| style | 286,180 | 124,026 | gzip |
| script | 82,605 | 26,309 | gzip |
| document | 900 | 696 | gzip |
| image | 900 | 696 | gzip（SVG） |
| api | 14,306 | 14,306 | JSON，未改 |

来源 `(:full.load.byKind)`。压缩前后 22 个同源静态资源里，带 `Content-Encoding` 的从 0 个变为 4 个（CSS/JS/HTML/SVG；字体不加）`(:full.load.compression)`。响应头证据：`.conductor/perf/after/raw/load-full.json :headers`，以及 `crates/server/src/http.rs::accepts_gzip` 的单元测试。

## 4. FPS / 每帧脚本耗时

口径见 §2；静置 10 s，拖拽/缩放各 8 s。

| 场景 | fps 中位 before→after | fps p1 before→after | 掉帧 before→after | 回调 p50 before→after | 回调 p95 before→after |
| --- | --- | --- | --- | --- | --- |
| empty | 303.03 → 588.24 | 79.37 → 109.89 | 0 → 0 | 2.0 → 1.0 ms | 3.9 → 1.3 ms |
| ten | 303.03 → 416.67 | 75.19 → 126.58 | 0 → 0 | 2.1 → 1.5 ms | 4.0 → 2.0 ms |
| full 静置 | 333.33 → 434.78 | 81.30 → 161.29 | 1 → 0 | 1.9 → 1.4 ms | 2.6 → 2.0 ms |
| full 拖拽 | 344.83 → 416.67 | — | — | 1.8 → 1.4 ms | 2.4 → 2.2 ms |
| full 缩放 | 526.32 → 588.24 | — | — | 1.1 → 1.0 ms | 2.9 → 2.2 ms |

来源 `(.conductor/perf/{before,after}/metrics.json :empty.fps / :ten.fps / :full.fps / :full.fpsDrag / :full.fpsZoom)`。

- 三个占用度的回调耗时几乎一样，说明成本在地面/物件/Agent 的固定绘制量，不在人数；满场与空场的差 <0.5 ms。
- 修复后 full 的 fps 与帧耗时有改善，主要来自 SSE 解析与每 tick 的 Preact 更新变便宜（payload 小 95%），不是渲染器代码变化。
- 无 vsync 封顶时 CPU 一直有活干，(program)/drawImage/fillRect 占忙时的比例在前后两份 profile 里基本一样 `(:full.cpuProfile)`；因此 profile 不是"卡"的主因证据，帧耗时才是。

## 5. SSE

| 指标 · 满场 | before | after |
| --- | --- | --- |
| 单条 tick 事件中位 | 371,931 B | 16,715 B |
| 最小 / 最大 | 62 / 371,931 B | 62 / 371,931 B（首帧全量） |
| JSON.parse 中位 / p95 | 4.22 / 7.28 ms | 0.19 / 0.40 ms |
| tick 频率 | 1.006 Hz | 1.035 Hz |

来源 `(:full.sse.bytesMedian, .bytesMin, .bytesMax, .parseMsMedian, .parseMsP95, .tickHz)`；原始流 `.conductor/perf/{before,after}/sse-raw.txt`。

协议（`crates/proto/src/lib.rs`）：

- `Projection` 新增 `objects_mode`（`full` | `delta`）与 `objects_removed`；**全量时两个键都不序列化**，所以 `/api/projection?tick=` 的响应与修复前逐字节一致（`curl … | grep -c objects_mode` = 0）。
- 一个 SSE 连接上：首帧、`Last-Event-ID` 重连、broadcast lag 跳号都发全量；只有 `prev.tick + 1 == tick` 发 delta（`crates/server/src/http.rs::FrameEncoder`）。每个连接只保存当前世界的最新对象表，内存随世界规模增长，不存历史。
- 客户端 `web/src/api.ts::mergeFrame` 用上一帧完整投影合并 `objects`/`objects_removed`，按 y、x 排序后交给页面；断线/重连清空缓存并强制要全量；若异常收到没有基线的 delta，则直接重连而不是渲染半张棋盘。
- 正确性测试：`crates/server/tests/sse_delta.rs`（墙/门/马桶三类变化、空变化、全量键省略）；`cargo test --workspace` 全绿。端到端等值断言：P1 Worker 的 `.conductor/p1/verify-delta.mjs` 对每个 tick 比较 delta 合并结果与 `/api/projection?tick=N`，逐字段相等。

## 6. 回放拖动

| 指标 · 20 次真实拖动 | before | after |
| --- | --- | --- |
| p50 / p95 | 142.2 / 190.2 ms | 142.2 / 163.8 ms |
| 单次 `/api/projection?tick=` 响应 | 371,936 B，页内 p50 58.4 ms | 371,936 B，页内 p50 25.9 ms |
| DOM 更新（指针/TICK） | 2.9 / 5.1 ms | 同（未改） |

来源 `(:full.scrub.scrubP50 / .scrubP95 / .projectionFetchP50 / .projectionBytesMedian)`。

- 拖动延迟的地板是"每个落点拉一整帧 371 KB 投影 + 服务器按 tick 构造投影"；DOM 本身 3 ms 就更新了。
- 试过把连续 pointermove 合并成「最多 1 个在飞 + 只取最新 tick」并对相邻 tick 预取：41 次 move 的请求从 ~41 降到 22，但 p50 142→154 ms、p95 190→173 ms，没有可见改善（预取还和拖动请求争带宽）。按契约 §6.4 的默认（p95>300 ms 才改）**revert**，记录在 `.conductor/perf/after/report-with-r1.md`。
- 上表 after 的 163.8 ms 来自**同一个未改动的 Replay.tsx**：它只说明两次测量之间有 ~10–15% 的噪声，不是本票带来的改善。
- 要真正把拖动做到"瞬时"，需要缩小 `/api/projection?tick=` 的单帧体积（例如回放也用增量/紧凑编码）。这会改回放接口语义，超出本票合同（Conductor 要求该接口保持全量），列为后续。

## 7. 视觉一致性

- 同一 fixture（`.conductor/perf/visual/data.tar`，满场 50/50，`--tick-seconds 120` 冻结）、1440×900、DPR1、`prefers-reduced-motion: reduce`、`document.fonts.ready` + 2 rAF。
- 截图：`docs/screenshots/perf-before-spectator.png` / `perf-after-spectator.png`、`perf-before-replay-213.png` / `perf-after-replay-213.png`（截图已删除）。
- 逐像素：观战页 `diff_pixels=0 / 1,296,000`，回放页 `diff_pixels=0 / 1,296,000`（`node scripts/perf/pixdiff.mjs <a> <b>`）。**外观未变。**
- 观战页在这台机器上有两种相机居中变体（首帧尺寸竞态，与本次改动无关）：base 变体在 before/after 都是多数（4/5、3/5），另一种变体两边的差异都是 `312,528` 像素、bbox `{0,174–959,784}`，即整块画布偏移；变体文件在 `.conductor/perf/visual/variants-*/`。对照用的是各自 run 的多数变体。

## 8. 改了哪些文件

- SSE：`crates/proto/src/lib.rs`、`crates/server/src/projection.rs`、`crates/server/src/http.rs`（SSE 段）、`crates/server/tests/sse_delta.rs`、`web/src/types.ts`、`web/src/api.ts`。Worker commit `5bded1c`，合并 `20fc500`。
- gzip：`web/scripts/gzip-dist.mjs`、`web/package.json`、`crates/server/src/http.rs`（静态段）。Worker commit `c9c2fb5`，合并 `52f09b6`。
- 测量：`scripts/perf.sh`、`scripts/perf/**`、`docs/perf-report.md`、`docs/screenshots/perf-*.png`。基线 commit `4931925`；本轮的 map/config/fixture-reuse 改动随最终提交。
  - `perf.sh` 新增：`PERF_MAP`（固定测量地图）、`max_on_field/queue_capacity` 覆盖、`PERF_REUSE_VISUAL=1`（after 复用 before 的冻结世界，保证同 tick 截图）。
- Master 小修：`web/src/api.ts` 在收到无基线 delta 时强制重连（不渲染半张棋盘）。
- 未改：`web/src/render.ts`、`web/src/pages/Spectator.tsx`、`web/src/pages/Replay.tsx`、`crates/server/src/lib.rs`、`docs/design.md`、美术/地图/规则。

## 9. 嫌疑逐条裁定（数据先行）

1. **每帧重绘整张棋盘：不是瓶颈。** 满场 rAF 回调 p50 1.4 ms、p95 2.0 ms，空场 1.0 ms；拖拽 1.4 ms、缩放 1.0 ms `(:full.fps.frameScriptMs, :empty.fps.frameScriptMs)`。整盘重绘只在相机/尺寸变化时才有额外成本，60 Hz 下预算 16.7 ms，余量 >10 倍。跳过，不改渲染器。
2. **SSE 推送整投影：是瓶颈。** 371,931 B/tick、解析 4.22 ms（`(:full.sse.*)`）。已修（§5），修后 16,715 B / 0.19 ms。
3. **插值重绘范围：不是瓶颈。** 拖拽/缩放时的帧耗时与静置同量级（1.4/1.0 vs 1.4 ms），无掉帧 `(:full.fpsDrag, :full.fpsZoom, :full.fps.frameDrops)`。
4. **字体体积（“约 12 MB”）：按首屏传输是瓶颈，但外观不变前提下已到下限。** 浏览器只抓用到的 18 个子集 = 621,296 B（dist 里全部字体 10.2 MB 不会被下载）`(:full.load.byKind.font)`。子集化会让任意昵称缺字回退系统字体；延迟加载会让首屏标题字体可见 swap——两者都改变外观，票面禁止。**待用户决定：是否接受换字体/回退以继续压缩首屏；当前不做。**
5. **回放拖动：不是瓶颈到 300 ms 阈值，但仍有 142 ms 地板。** 见 §6；尝试的合并请求方案被数据否掉并 revert。

## 10. 未测到 / 局限

- fps 是"无刷新率封顶的 rAF 触发率"，不是屏幕显示帧率：本机 Xwayland 合成器会间歇把窗口节流到 1 Hz（rAF 探针 `(:empty.rafProbe)`），在真实 60/144 Hz 显示节奏下的复核需要在用户机器上做（待用户审核，见 §11）。
- 首屏是 localhost，不含真实网络 RTT/TLS；传输体积与 interactiveMs 是本地口径，真实网络下 gzip 的相对收益会更大。
- after 的 empty 首屏 FCP/LCP 采样缺失（`None`），只报 interactiveMs 与 ten/full 的 FCP/LCP。
- `tools/verify.py` 的 CI 项不适用：本分支只做本地 commit，不 push（`origin/main [gone]`），CI 由 Conductor 合并后统一跑。
- 真机长时间拖拽的手感、低端设备上的帧率：静态截图与本地脚本不能证明，**待用户审核**。

## 11. 待用户审核

1. 打开观战页（`/`）满场世界，缩放、拖拽、看几秒；打开 `/replay` 拖动时间轴，确认"卡"的感觉消失。审核方法：对比 `docs/screenshots/perf-before-*` 与 `perf-after-*` 的同一 tick，并在真实浏览器里操作。
2. 是否接受为继续压缩首屏而更换字体或允许缺字回退（§9.4）。目前保持外观不变，621 KB 字体未动。

## 12. 重现

```sh
# 测量地图固定为生产世界（I 改默认世界之前的 maps/default.txt）
git show aa7910f:maps/default.txt > .conductor/perf/map-prod.txt
PERF_MAP=$PWD/.conductor/perf/map-prod.txt scripts/perf.sh run --tag before   # ~8 分钟
PERF_MAP=$PWD/.conductor/perf/map-prod.txt PERF_REUSE_VISUAL=1 scripts/perf.sh run --tag after
scripts/perf.sh compare        # 两列表格
node scripts/perf/pixdiff.mjs docs/screenshots/perf-before-spectator.png docs/screenshots/perf-after-spectator.png
(cd web && npm run build && npm run typecheck)
cargo test --workspace
scripts/e2e-full.sh
```

产物：`.conductor/perf/<tag>/{metrics.json,occupancy.json,config.json,machine.json,map.txt,raw/*.json,profiles/*.cpuprofile,sse-raw.txt}`、`.conductor/perf/visual/{data.tar,meta.json}`、`docs/screenshots/perf-<tag>-*.png`。
