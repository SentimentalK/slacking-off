# 第五波最终重拍（W5g 第 2 次，main @ f8e45a5）

本目录是第五波最终代码的截图、并排图与性能记录。本次（第 2 次）在 `main @ f8e45a5` 上重跑全量验证，重拍 `ui/`、`look/` 的五张、全部前后并排与原型对照。帧率与首屏本次没有重测，沿用前一次与 W5g 第 1 次的记录（见"帧率"一节）。

- 服务与数据：dev 18129（`.conductor/l5/data-dev`），official 18130（`.conductor/l5/data-off`），vite 18132（观感截图）。网页用服务端编进二进制的 `web/dist`。
- 观感截图的 vite 用的是 `.conductor/l5/vite.look.config.mjs`：与仓库 `web/vite.config.ts` 相同的插件与 `/api` 代理，另加 `server.fs.allow` 指向仓库根。原因：`e444921` 去掉了仓库配置里的 `fs.allow: ['..']`，而 `.conductor/l/scenes` 的 fixture 在 `web/` 之外，不加它会 403。仓库内的配置未改。
- 所有日志与中间 JSON 在 `.conductor/l5/final2/`（git 外）。

## 遗留项前后并排（`items/`，本次全部重做）

每张左为之前、右为之后。生成：`node web/scripts/l3-compare.mjs --out docs/screenshots/l5/items --name <文件> --left <之前> --right <之后> --labels 之前,之后`。

| 文件 | 对应遗留项 | 之前（左） | 之后（右） | 备注 |
| --- | --- | --- | --- | --- |
| `01-feed.png` | 01 观战右侧卡片 | `l3/watch-selected-1440.png` | `l5/ui/watch-selected-1440.png` | |
| `02-dusk.png` | 02 黄昏 | `l3/look/2-dusk.png` | `l5/look/overview-dusk.png` | 左侧是原两联图（之前｜之后），不是单张 |
| `03-play-camera.png` | 03 上场摄像头 | `l4/play-menu-1440.png` | `l5/play-menu-1440.png` | |
| `04-day-grass.png` | 04 白天草地 | `l3/look/1-day.png` | `l5/look/overview-day.png` | 左侧是原两联图 |
| `05-play-card.png` | 05 上场卡片 | `l4/play-using-1440.png` | `l5/play-using-1440.png` | |
| `06-leaderboard.png` | 06 排行榜 | `l3/board-1440.png` | `l5/ui/board-1440.png` | |
| `07-narrow-bottom.png` | 07 窄屏底栏 | `l3/watch-390.png` | `l5/ui/watch-390.png` | |
| `08-roof-plate.png` | 08 屋顶牌 | `l3/look/5-roof.png` | `l5/look/levels.png` | 左侧是原两联图 |
| `09-icons.png` | 09 图标 | `l3/look/4-icons.png` | `l5/look/states.png` | 左侧是原两联图 |
| `10-bottom-text.png` | 10 底栏文字 | `l3/replay-auto-1440.png` | `l5/ui/replay-auto-1440.png` | |

原型对照（左为原型，右为本轮截图），同样重做：

- `../compare-day.png`：`docs/art/prototype/forest.png` ｜ `look/near-day.png`。
- `../compare-dusk.png`：`docs/art/prototype/forest-dusk.png` ｜ `look/near-dusk.png`。
- `../ui-compare-watch.png`：`docs/art/prototype/ui-watch.png` ｜ `ui/watch-1440.png`。
- `../ui-compare-board.png`：`docs/art/prototype/ui-board.png` ｜ `ui/board-1440.png`。
- `../ui-compare-play.png`：`docs/art/prototype/ui-play.png` ｜ `play-1440.png`。

## 界面截图（`ui/`，本次重拍）

生成：`node web/scripts/ui-shots.mjs --base http://127.0.0.1:18129 --official http://127.0.0.1:18130 --out docs/screenshots/l5/ui --final 1`（stress 16 个 dev Agent 跑满 3 分 20 秒后截图），再停 stress 后 `--replay-auto 1`（同一 out）。`--final 1` 没有断言失败。

- `watch-1440.png`：观战首页 1440×900（整体参考，无对应遗留项）。
- `watch-390.png`：观战首页 390×844（遗留项 07）。
- `watch-selected-1440.png`：点选一个 Agent 后的右侧卡片（遗留项 01）。
- `settings-1440.png`、`settings-390.png`：设置窗口。
- `board-1440.png`、`board-390.png`：排行榜窗口（遗留项 06 为 1440）。
- `stats-1440.png`、`stats-390.png`：统计窗口。
- `profile-1440.png`、`profile-390.png`：档案窗口。
- `register-1440.png`、`register-390.png`：注册窗口。
- `account-1440.png`、`account-390.png`：账号窗口。
- `login-1440.png`、`login-390.png`：登录窗口。
- `replay-auto-1440.png`：空场自动回放，左上角 `● 回放`（遗留项 10）。

## 观感截图（`look/`）

生成：`node web/scripts/l-shots.mjs --base http://127.0.0.1:18132 --scenes /home/sentimentalk/codes/slacking-off/.conductor/l/scenes --out <dir>`。本次只把下列五张从临时目录拷回 `look/`（每张的 `.json` 同拷），其余 R-C 的文件没有覆盖。

本次重拍（第 2 次）：

- `closeup-day.png`：近景白天（`focus=16,14&zoom=0.5`），本次重拍。
- `closeup-dusk.png`：近景黄昏，本次重拍。
- `portrait-390.png`：390 宽（`quality=medium`），本次重拍。
- `low-390.png`：390 宽（`quality=low`），本次重拍。
- `play-vision.png`：上场视野（`play=1`），本次重拍。

R-C 新拍（本轮之前的最终重拍，本次未覆盖）：

- `overview-day.png`：白天全景，对应遗留项 04。
- `overview-dusk.png`：黄昏全景，对应遗留项 02。
- `levels.png`：马桶屋顶 1–5 级，对应遗留项 08。
- `states.png`：眩晕、防御、告急等状态图标，对应遗留项 09。
- `near-day.png`、`near-dusk.png`：近景（`pitch=proto`），与原型 `forest*.png` 对照。

上一次最终运行的产物（改前的画面，本次未重拍）：

- `states-overview.png`：状态总览。
- `shack-door-south.png`、`shack-door-north.png`：棚屋门（南、北）。
- `missing-wall.png`、`wall-half.png`、`upgrading.png`、`using.png`、`windup.png`、`queue.png`、`vision.png`：各 fixture 的状态图（无单独票号）。
- 各对应 `.json`：每张的 tick、calls、triangles、renderer。

## E2E 与 play（`l5/` 顶层，E2E 脚本写的）

本次 E2E 重跑覆盖的文件（mtime 为本次运行时间）：

- `play-1440.png`、`play-390.png`：上场模式，`e2e-play` 写入。
- `play-menu-1440.png`、`play-menu-390.png`：上场菜单（遗留项 03 所在）。
- `play-using-1440.png`：上场使用中的卡片（遗留项 05）。
- `play-memory-1440.png`：上场 memory 状态（按文件名归类，内容未逐张核对）。
- `play-success-1440.png`、`play-success-390.png`：上场成功状态（按文件名归类，内容未逐张核对）。
- `replay-1440.png`、`replay-390.png`：回放模式，`e2e-k` 写入。

上一轮（w5e）产物，本次未重拍：

- `icons.png`、`roof.png`、`auto-run1.png`、`auto-run2.png`。

## 数字

**E2E**（`.conductor/l5/final2/summary.txt`，三套在 `f8e45a5` 上）：

| 套件 | 退出码 | PASS | FAIL |
| --- | --- | --- | --- |
| `e2e-full` | 0 | 57 | 0 |
| `e2e-play` | 0 | 114 | 0 |
| `e2e-k` | 0 | 44 | 0 |

**逐像素**（`scripts/l-pixel.sh`，tick 12，1440×900）：`diff_pixels` 0，`diff_ratio` 0。

**构建与单测**：`cargo fmt --check` / `clippy -D warnings` / `cargo test --workspace` 全部通过，255 passed，0 failed。web：`typecheck` 通过，`npm test` 30/30，`npm run build` 通过，`check-chunks` OK。

**gzip**（`gzip-dist`，本次构建）：入口 `index-DJ0axdCc.js` raw 110677 B → gzip 38493 B；three `world3d-*.js` → gzip 169719 B；合计 4 个文件 raw 1136843 B，gzip 363935 B。

## 帧率

本次没有重测帧率与首屏。以下沿用前一次记录，按时间顺序列出。

**阶梯表（W5g 第 1 次）**：`final/ladder.json`，1440×900 为 crowd 场景（12 人在场 + 10 人排队），390×844 为同一场景；预热 5 s 后测 20 s。GPU：ANGLE Intel UHD（CML GT2），OpenGL ES 3.2。

| 组 | 视口 | scale / grass / shadow | 中位 fps | p10 fps | 测时负载 1 分钟 前→后 |
| --- | --- | --- | --- | --- | --- |
| phone-low（手选 low） | 390×844 | tier | 59.9 | 59.5 | 3.62 → 3.64 |
| phone-0.75-0.5-1024 | 390×844 | 0.75 / 0.5 / 1024 | 59.9 | 59.5 | 3.63 → 3.79 |
| manual-low | 1440×900 | tier | 47.8 | 45.7 | 4.16 → 3.76 |
| ladder-5 | 1440×900 | 0.75 / 0 / 0 | 41.5 | 39.4 | 3.43 → 3.86 |
| ladder-4 | 1440×900 | 0.6 / 0.25 / 512 | 37.6 | 35.8 | 3.54 → 3.33 |
| ladder-3 | 1440×900 | 0.6 / 0.5 / 1024 | 36.6 | 34.5 | 3.71 → 3.65 |
| ladder-2 | 1440×900 | 0.75 / 0.5 / 1024 | 31.6 | 29.9 | 3.71 → 3.30 |
| ladder-1 | 1440×900 | 0.75 / 1 / 2048 | 28.9 | 26.9 | 3.63 → 3.60 |
| manual-medium | 1440×900 | tier | 26.5 | 25.5 | 3.90 → 3.93 |
| manual-high | 1440×900 | tier | 23.1 | 21.8 | 3.87 → 3.89 |
| ladder-0 | 1440×900 | 1 / 1 / 2048 | 22.8 | 21.3 | 4.05 → 3.69 |

测前其他无头 Chrome 数：ladder 开始 9，结束 7（以 `ladder.json` 的 `other_headless_chrome_before_start` 为准）。门控按 1 分钟负载 ≤ 4 放行，无头 Chrome 数只记录不等待。`ladder.md` 的表头文字"超过 30 分钟等待后照测"是脚本写死的，与实际门控不符，以 JSON 为准。

**自动档（改判定之后，W5g 最终）**：`final/auto-ladder-r4.json`、`final/auto-ladder-r5.json`，crowd 场景，两次干净会话（每次清空 localStorage 后开始，第二次在同一 context 中重开）。判定为去掉最慢 10% 的平均帧间隔。两次都落定第 3 级 `{scale 0.75, grass 0.5, shadow 1024}`。

| 运行 | 起始档 → 落定档 | 落定后中位 fps | p10 fps | 测前负载 → 测后 | 测前其他无头 Chrome |
| --- | --- | --- | --- | --- | --- |
| r4 第 1 次 | 0 → 2 | 30.9 | 19.1 | 3.33 → 3.77 | 21 |
| r4 第 2 次 | 1 → 2 | 31.8 | 30.3 | 3.77 → 3.82 | 13 |
| r5 第 1 次 | 0 → 2 | 32.1 | 30.1 | 3.99 → 4.78 | 13 |
| r5 第 2 次 | 1 → 2 | 16.7 | 14.5 | 3.61 → 3.83 | 13 |

说明：r4 第 1 次的 p10 为 19.1，说明测时有一段卡顿。r5 第 2 次的 16.7 fps 对应 `final/auto-ladder-load.txt` 中的 `gpu_busy=1`，即同机另一工作区的 GPU 进程正忙，这一读数不作为画质结论。其余三次在 30–32 fps 之间。

**自动档（改判定之前，对照保留）**：`final/auto.json`，crowd 场景，改判定前的结果，保留作对照。两次都落定第 1 级 `{scale 0.75, grass 1, shadow 2048}`，中位 fps 29.5 与 29.4，p10 27.9。改判定后档位从第 1 级改为第 3 级，说明判定修正生效。

**自动档，首页**（`final/auto-shell.json`，`/`，18129 的 dev 服务，W5g 第 1 次）：落定第 1 级，中位 fps 30.0，p10 29.9，两次测前负载 3.89 与 3.98。它是改判定之前的结果，本次未重测。

**首屏**（`final/firstpaint.json` 与 `firstpaint-base.json`，W5g 第 1 次）：新版 FCP 中位 404 ms、顶栏 302 ms、场景首帧 2914 ms；基线 632、610、2438 ms。两组负载不同（新版 2.65–7.40，基线 3.8–3.9），场景首帧仍是新版慢，未解释。

**合并**：`final/perf.json` 合并了上面的 ladder、auto、auto-shell、firstpaint、firstpaint-base。

## 黄昏（四轮并排图位置）

每轮的并排图都在 `dusk/round-N/`。左右分别对应：

- 第 1 轮 `dusk/round-1/`：`compare-day.png`、`compare-dusk.png`（参考图 `ref-dusk.png`）。
- 第 2 轮 `dusk/round-2/`：`compare-day.png`、`compare-dusk.png`，区域亮度见 `regions.md`。
- 第 3 轮 `dusk/round-3/`：`compare-day.png`、`compare-dusk.png`，近景 `near-day.png`、`near-dusk.png`，总览 `overview-dusk.png`，区域见 `regions-near.json`、`regions.md`。
- 第 4 轮 `dusk/round-4/`（W5g 最新一轮，灯池与对比加强）：`compare-day.png`、`compare-dusk.png`，总览 `overview-day.png`、`overview-dusk.png`，区域见 `regions-near.json`、`regions.md`。第 4 轮的区域比值普遍低于原型（道路 −30%、草地 −29%、树冠 −50%、屋顶 −42%、角色 −36%），已在 `regions.md` 写明代价。
