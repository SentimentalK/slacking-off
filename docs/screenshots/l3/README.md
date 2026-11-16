# 第三波界面截图（l3）

全部由真 GPU 的无头 Chrome 156（`--use-angle=gl --enable-gpu`，`--headless=new`）截取，不是软件渲染。渲染器字符串：`ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL ES 3.2)`，Chrome `156.0.8078.79`。服务与数据目录都在 `.conductor/l34/`（git 外，每次先 `rm -rf`）。

最近一次整体重跑：2026-11-16，基线 `main @ b345bf6`（合并后的 wave-3 视觉打磨版本）。下面的命令和数字都是这一次的实测结果。

## 服务与数据

| 服务 | 端口 | 数据目录 | 命令 |
| --- | --- | --- | --- |
| dev（观战、排行榜、统计、档案、设置） | 18129 | `.conductor/l34/data-w3h-dev` | `target/release/loo-server --dev --addr 127.0.0.1:18129 --map maps/default.txt --data-dir .conductor/l34/data-w3h-dev`，同时 `node scripts/stress-200.mjs --base http://127.0.0.1:18129 --agents 16 --duration-seconds 900`（截图时 16 个 dev Agent 在动，`--final 1` 结束后停掉） |
| official（账号、登录、注册） | 18130 | `.conductor/l34/data-w3h-off` | `target/release/loo-server --official --addr 127.0.0.1:18130 --map maps/default.txt --tick-seconds 1 --data-dir .conductor/l34/data-w3h-off` |
| vite（场景页 `scene.html`，观感与性能） | 18132 | — | `cd web && npx vite --port 18132 --strictPort` |

网页用服务端编进二进制的 `web/dist`：先 `cd web && npm run build`，再 `cargo build --release -p loo-server -p loo-cli`。

## 界面截图

- `watch-1440.png` — 观战首页 1440×900，16 个 dev Agent 在场，顶部模式切换、左侧现场、右侧 TOP 3、底栏带一句说明。生成：`node web/scripts/ui-shots.mjs --base http://127.0.0.1:18129 --official http://127.0.0.1:18130 --out docs/screenshots/l3 --final 1`。
- `watch-390.png` — 同一页 390×844，底栏 91px，说明句单行省略。同上命令。
- `watch-selected-1440.png` — 点一个 Agent 后的右侧卡片（卡片显示角色昵称与需求）。同上命令。
- `replay-auto-1440.png` — 停掉 stress、场上清空后的空场自动回放，左上角 `● 回放`。生成：`node web/scripts/ui-shots.mjs --base http://127.0.0.1:18129 --out docs/screenshots/l3 --replay-auto 1`（先等 `/api/projection` 的 `counts.inside == 0`，最多 10 分钟；等不到 `.ui-clock .live.rp` 时打印 SKIP）。本次在 stress 停止后重跑，文件时间 03:01。
- `settings-1440.png`、`settings-390.png` — 设置窗口（手机宽度经「菜单」打开）。同上 `--final 1` 命令。
- `board-1440.png`、`board-390.png` — `/leaderboard` 窗口。同上。
- `stats-1440.png`、`stats-390.png` — `/stats` 窗口。同上。
- `profile-1440.png`、`profile-390.png` — `/agent/<dev-1 的 id>` 档案窗口。同上。
- `account-1440.png`、`account-390.png` — `/account` 窗口，注册后的账号页。生成：同一 `--final 1` 命令（注册走 `--official`）。
- `login-1440.png`、`login-390.png` — 退出登录后的 `/login` 窗口。同上。
- `register-1440.png`、`register-390.png` — 注册窗口（注册前的空表单）。同上。

本次没有交付 `ui-shots.mjs --windows 1` 的输出。该轮次把注册放在 `--base`（dev 服务）上执行，dev 模式下无法进入 account 窗口，两档都在第一步失败，没有写入任何文件；按协调方指示跳过，上面的图全部来自 `--final 1`。

## 并排图

- `ui-compare-watch.png` — 左 `docs/art/prototype/ui-watch.png`，右 `watch-1440.png`。生成：`node web/scripts/l3-compare.mjs --set ui --out docs/screenshots/l3`。
- `ui-compare-board.png` — 左 `ui-board.png`，右 `board-1440.png`。同上。
- `ui-compare-account.png` — 左 `ui-account.png`，右 `account-1440.png`。同上。
- `ui-compare-play.png` — 左 `ui-play.png`，右 `watch-selected-1440.png`（原型的上场模式在一波次之内才有，这里用选中卡片对照右侧卡片）。同上。

## 观感前后（`look/`）

「之前」取 `docs/screenshots/l/` 的同名图（只读）；「之后」取 `look/after/`，由 `node web/scripts/l-shots.mjs --base http://127.0.0.1:18132 --scenes /home/sentimentalk/codes/slacking-off/.conductor/l/scenes --out docs/screenshots/l3/look/after` 生成（vite 方式）。`--scenes` 必须传绝对路径：相对路径会让 fixture URL 变成 `/@fs.conductor/...`，vite 回退成 HTML，每张都会报 `Unexpected token '<'`。

`look/after/overview-day-medium.png` 是同一脚本的单图变体（`quality=medium`，1440×900）。`l-shots.mjs` 不支持指定查询参数，所以用 `.conductor/l34/w3h/l-shots-medium.mjs`（同一逻辑，只保留这一张）生成：`node .conductor/l34/w3h/l-shots-medium.mjs --base http://127.0.0.1:18132 --scenes /home/sentimentalk/codes/slacking-off/.conductor/l/scenes --out docs/screenshots/l3/look/after`。

拼图命令：`node web/scripts/l3-compare.mjs --set look --out docs/screenshots/l3/look`。

- `look/1-day.png` — 近景白天（closeup-day）：之前 | 之后。
- `look/2-dusk.png` — 近景黄昏（closeup-dusk）：之前 | 之后。
- `look/3-forest-edge.png` — 全图白天，林地边缘：之前 | 之后（overview-day）。
- `look/4-icons.png` — 眩晕、防御、告急等状态图标：之前 `states.png` | 之后 `states-overview.png`。
- `look/5-roof.png` — 马桶 1–5 级屋顶：之前 `levels.png` | 之后 `levels.png`。
- `look/5b-roof-north.png` — 棚屋北门：之前 `shack-door-north.png` | 之后 `shack-door-north.png`。
- `look/6-portrait.png` — 390 宽：之前 `low-390.png`（quality=low） | 之后 `portrait-390.png`（quality=medium）。
- `look/7-medium.png` — 1440 中档：之前 `overview-day.png`（quality=high） | 之后 `overview-day-medium.png`。
- `look/compare-day.png` — 原型 `forest.png` | 之后 `closeup-day`。
- `look/compare-dusk.png` — 原型 `forest-dusk.png` | 之后 `closeup-dusk`。

`look/after/*.json` 记录每张的 tick、calls、triangles、renderer。

## 性能与逐像素

- `perf-gpu.json` — 6 项：四档白天（1440×900 high / medium / low，390×844 low）加上两档黄昏（1440×900 high / medium，`dusk=1`）。每项带 `loadavg_1m`（该项运行前的 `/proc/loadavg`）与 `loadavg_1m_after`（运行后）。每项 5 秒预热、20 秒计时，中位数与 p10 fps 如下：

  | 配置 | 中位 fps | p10 fps | loadavg 前 → 后 |
  | --- | --- | --- | --- |
  | 1440×900 high，白天 | 26.0 | 23.9 | 3.53 → 3.90 |
  | 1440×900 medium，白天 | 29.7 | 27.7 | 3.90 → 4.53 |
  | 1440×900 low，白天 | 59.2 | 54.1 | 4.53 → 3.79 |
  | 390×844 low，白天 | 59.9 | 59.5 | 3.79 → 3.88 |
  | 1440×900 high，黄昏 | 27.7 | 26.2 | 3.88 → 4.13 |
  | 1440×900 medium，黄昏 | 30.3 | 28.8 | 4.13 → 4.22 |

  白天四档用未改动的 `node web/scripts/l-perf.mjs --gpu`，每档用 `L_PERF_ONLY=<档位> ... --out <单档 json>` 单独运行，再合并为 `perf-gpu.json`。两档黄昏用 `.conductor/l34/w3h/l-perf-dusk.mjs`：与仓库脚本相同，只在配置里加 `dusk: true` 并把查询参数加上 `dusk=1`，不改仓库脚本。运行前的 1 分钟负载均低于 6（最高 4.53），满足运行前检查。

- 逐像素：`bash scripts/l-pixel.sh`，结果在 `docs/screenshots/l/pixel*`（本次 tick 16，原为 14；1440×900 canvas，`diff_pixels` 0）。脚本的实时页选择器已改为外壳（`.ui-clock .live` 含 LIVE、`canvas[data-renderer="3d"]`），清理只杀它自己记录的 PID。
