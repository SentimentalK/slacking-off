# 第五波最终运行（wave-5 final）

本目录是第五波最终代码的截图、并排图与性能记录。基线 `main @ fb79fb2`，之后的测试修正提交为 `c36db25`、`4fece7d`（只改 `web/e2e/onboarding.mjs`，不影响界面）。

- 服务与数据：dev 18129（`.conductor/l5/data-dev`），official 18130（`.conductor/l5/data-off`），vite 18132（观感截图）。网页用服务端编进二进制的 `web/dist`。
- 观感截图的 vite 用的是 `.conductor/l5/vite.look.config.mjs`（与 `web/vite.config.ts` 相同插件，另加 `server.fs.allow` 指向仓库根，让 `.conductor/l/scenes` 的 fixture 可读；仓库内的配置未改）。`auto-shell` 的首页数据来自 18129 的 dev 服务，不经 vite。
- 所有数字与日志在 `.conductor/l5/final/`（git 外），本目录只留图与 JSON 副本。
- 负载与无头 Chrome 数写在每组 JSON 里（`load1_before` / `load1_after`、`other_headless_chrome_before`）。

## 遗留项前后并排（`items/`）

每张左为之前、右为之后。生成：`node web/scripts/l3-compare.mjs --out docs/screenshots/l5/items --name <文件> --left <之前> --right <之后> --labels 之前,之后`。

| 文件 | 对应遗留项 | 之前 | 之后 | 备注 |
| --- | --- | --- | --- | --- |
| `01-feed.png` | 01 观战右侧卡片 | `l3/watch-selected-1440.png` | `l5/ui/watch-selected-1440.png` | |
| `02-dusk.png` | 02 黄昏 | `l3/look/2-dusk.png`（两联图） | `l5/look/overview-dusk.png` | 左侧已是两联图（之前|之后），不是单张 |
| `03-play-camera.png` | 03 上场摄像头 | `l4/play-menu-1440.png` | `l5/play-menu-1440.png` | |
| `04-day-grass.png` | 04 白天草地 | `l3/look/1-day.png`（两联图） | `l5/look/overview-day.png` | 同上，左侧是两联图 |
| `05-play-card.png` | 05 上场卡片 | `l4/play-using-1440.png` | `l5/play-using-1440.png` | |
| `06-leaderboard.png` | 06 排行榜 | `l3/board-1440.png` | `l5/ui/board-1440.png` | |
| `07-narrow-bottom.png` | 07 窄屏底栏 | `l3/watch-390.png` | `l5/ui/watch-390.png` | |
| `08-roof-plate.png` | 08 屋顶牌 | `l3/look/5-roof.png`（两联图） | `l5/look/levels.png` | 同上 |
| `09-icons.png` | 09 图标 | `l3/look/4-icons.png`（两联图） | `l5/look/states.png` | 同上 |
| `10-bottom-text.png` | 10 底栏文字 | `l3/replay-auto-1440.png` | `l5/ui/replay-auto-1440.png` | |

另有四张原型对照（左 `docs/art/prototype/`，右为本轮截图）：`../compare-day.png`（forest.png | near-day）、`../compare-dusk.png`（forest-dusk.png | near-dusk）、`../ui-compare-watch.png`（ui-watch.png | watch-1440）、`../ui-compare-board.png`（ui-board.png | board-1440）、`../ui-compare-play.png`（ui-play.png | play-1440）。

## 界面截图（`ui/`）

生成：`node web/scripts/ui-shots.mjs --base http://127.0.0.1:18129 --official http://127.0.0.1:18130 --out docs/screenshots/l5/ui --final 1`（stress 跑 3 分钟后截图，16 个 dev Agent），再停 stress 后 `--replay-auto 1`（同一 out）。

- `watch-1440.png`：观战首页 1440×900（无对应遗留项，作为整体参考）。
- `watch-390.png`：观战首页 390×844（遗留项 07）。
- `watch-selected-1440.png`：点选一个 Agent 后的右侧卡片（遗留项 01）。
- `settings-1440.png`、`settings-390.png`：设置窗口。
- `board-1440.png`、`board-390.png`：排行榜窗口（遗留项 06）。
- `stats-1440.png`、`stats-390.png`：统计窗口。
- `profile-1440.png`、`profile-390.png`：档案窗口。
- `register-1440.png`、`register-390.png`：注册窗口。
- `account-1440.png`、`account-390.png`：账号窗口。
- `login-1440.png`、`login-390.png`：登录窗口。
- `replay-auto-1440.png`：空场自动回放，左上角 `● 回放`（遗留项 10）。

## 观感截图（`look/`）

生成：`node web/scripts/l-shots.mjs --base http://127.0.0.1:18132 --scenes /home/sentimentalk/codes/slacking-off/.conductor/l/scenes --out docs/screenshots/l5/look`（读取 `.conductor/l/scenes` 的 fixture）。共 21 张，无页面错误。

- `overview-day.png`：白天全景，对应遗留项 04 白天草地。
- `overview-dusk.png`：黄昏全景，对应遗留项 02 黄昏。
- `levels.png`：马桶屋顶 1–5 级，对应遗留项 08 屋顶牌。
- `states.png`：眩晕、防御、告急等状态图标，对应遗留项 09 图标。
- `closeup-day.png`、`closeup-dusk.png`、`near-day.png`、`near-dusk.png`：近景，near 两张与原型 `forest*.png` 对照。
- `states-overview.png`、`shack-door-north.png`、`shack-door-south.png`、`missing-wall.png`、`wall-half.png`、`upgrading.png`、`using.png`、`windup.png`、`queue.png`、`vision.png`、`play-vision.png`、`portrait-390.png`、`low-390.png`：其余观感的 fixture 与状态图（无单独票号）。
- `*.json`：每张的 tick、calls、triangles、renderer。

## E2E 与 play（`l5/` 顶层）

E2E 脚本自己写的截图，本轮重跑后覆盖（`e2e-play` 写 play/replay 截图，`e2e-k` 写 replay 截图）。每张一行：

- `play-1440.png`、`play-390.png`：上场模式（`e2e-play`），1440 与 390 宽。
- `play-menu-1440.png`、`play-menu-390.png`：上场菜单（遗留项 03 摄像头所在）。
- `play-using-1440.png`：上场使用中的卡片（遗留项 05）。
- `play-memory-1440.png`：上场 memory 相关状态（按文件名归类，内容未逐张核对）。
- `play-success-1440.png`、`play-success-390.png`：上场成功状态（按文件名归类，内容未逐张核对）。
- `replay-1440.png`、`replay-390.png`：回放模式（`e2e-k` 与 `e2e-play`），1440 与 390 宽。
- `icons.png`、`roof.png`、`auto-run1.png`、`auto-run2.png`：上一轮（w5e）产物，本次未重拍。

## 数字（`final/`）

**E2E**（`.conductor/l5/final/summary.txt`）：

| 套件 | 结果 | 备注 |
| --- | --- | --- |
| `e2e-full` | exit 0，52 PASS，0 FAIL | |
| `e2e-play` | exit 0，114 PASS，0 FAIL | |
| `e2e-k` | exit 0，43 PASS，0 FAIL | 最终在 `4fece7d` 上的一次。之前三次失败（空场、回放拖动）已在 `failures.md` 记录，其中两处为测试脚本问题，已由 `c36db25`、`4fece7d` 修正（只改 onboarding.mjs） |

**逐像素**（`scripts/l-pixel.sh`，tick 12，1440×900）：`diff_pixels` 0，`diff_ratio` 0。

**构建与单测**：`cargo fmt --check` / `clippy -D warnings` / `cargo test --workspace` 全部通过，255 passed，0 failed。web：`typecheck` 通过，`npm test` 28/28，`npm run build` 通过，`check-chunks` OK。

**gzip**（`gzip-dist`）：入口 `index-*.js` 110183 B → gzip 38341 B；three `world3d-*.js` 648860 B → gzip 168995 B；CSS 374701 B → gzip 155178 B；合计 4 个文件 raw 1134389 B，gzip 362964 B。

**首屏**（`l-firstpaint.mjs`，5 次，每次新建无缓存上下文，下行 10 Mbit/s，RTT 40 ms）：

| 构建 | FCP 中位 | 顶栏中位 | 场景首帧中位 | 每次负载（1 分钟） |
| --- | --- | --- | --- | --- |
| 新（`web/dist`） | 404 ms | 302 ms | 2914 ms | 3.03, 3.43, 7.40, 2.65, 2.65 |
| 基线（`baseline/dist`） | 632 ms | 610 ms | 2438 ms | 3.88, 3.89, 3.89, 3.81, 3.81 |

注意：两组负载不同。新版第 3 次运行时负载为 7.4，基线全程约 3.9。场景首帧在新版反而慢于基线（2914 对 2438 ms），本轮不把它当作改进；新版的顶栏与 FCP 更早。

**画质阶梯与手选档**（`l-perf.mjs --gpu --ladder`，crowd 场景，12 人在场 + 10 人排队，预热 5 s 后测 20 s；GPU：ANGLE Intel UHD（CML GT2），OpenGL ES 3.2）：

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

测前其他无头 Chrome 数：`ladder` 开始时 9，结束时 7（具体数见 `ladder.json` 的 `other_headless_chrome_before_start`）。运行门控按 1 分钟负载 ≤ 4 放行，无头 Chrome 数只记录不等待（协调方的放宽门控）。`ladder.md` 的表头文字"超过 30 分钟等待后照测"是脚本写死的，与本次实际门控不符，以本 README 与 JSON 为准。

**自动档**（`l-perf.mjs --gpu --auto`，crowd 场景，两次运行：第一次清空 localStorage，第二次带存档；同一 browser context）：

| 运行 | 起始档 → 落定档 | 落定后中位 fps | p10 fps | 测前负载 → 测后 | 测前其他无头 Chrome |
| --- | --- | --- | --- | --- | --- |
| 1（清空存档） | 0 → 1 | 29.5 | 27.9 | 3.79 → 3.66 | 13 |
| 2（带存档） | 1 → 1 | 29.4 | 27.9 | 3.66 → 3.50 | 13 |

落定档 1 = scale 0.75、grass 1、shadow 2048。日志：run 1 为 `start 0` → `step 1` → `start 1` → `settle 1`；run 2 为 `start 1` → `settle 1`。

**自动档，首页**（`l-perf.mjs --gpu --auto-shell`，`/`，18129 的 dev 服务，两次运行）：落定档 1，中位 fps 30.0，p10 fps 29.9，两次测前负载 3.89 与 3.98，其他无头 Chrome 16 与 15。首次尝试（vite 作为 base）失败，原因是启动 vite 时用的配置缺少 `/api` 代理，已在 `failures.md` 记录。

**其他**：`final/perf.json` 合并了以上所有 JSON（ladder、auto、auto-shell、firstpaint、firstpaint-base），每组带负载与无头 Chrome 数。
