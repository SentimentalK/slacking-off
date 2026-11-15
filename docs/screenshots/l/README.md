# 3D 观战画面截图（l）

fixture 位于 `.conductor/l/scenes/`（git 外，只读）。每张 `*.png` 旁边都有同名 `*.json`，记录 `tick`、`calls`、`triangles`。无特别说明的截图都是 1440×900、`quality=high`、`still=1`，由 `l-shots.mjs` 在真 GPU 的无头 Chrome（`--use-angle=gl --enable-gpu`）里整页截图（含页面暗角层），渲染器字符串记在同名 json 的 `renderer`；脚本遇到软件渲染直接报错。逐像素三张（pixel-*）仍由软件渲染的 `__looView.capture()` 画布导出。`levels.json` 是手写 fixture（在 shacks.json 上改等级并加两间棚屋），只用来看 1–5 级外观，其余 fixture 都由 `cargo run -p loo-server --example scenes` 用真实规则生成。

- shack-door-south.png — 棚屋南门，棚屋在 (13,10)，镜头聚焦该格 — `l-shots.mjs`：shacks.json，`focus=13,10&zoom=0.4`
- shack-door-north.png — 棚屋北门，棚屋在 (13,21)，镜头聚焦该格 — `l-shots.mjs`：shacks.json，`focus=13,21&zoom=0.4`
- missing-wall.png — 缺一段墙的局面，聚焦 (30,19) — `l-shots.mjs`：missing-wall.json，`focus=30,19&zoom=0.4`
- wall-half.png — 半成的墙，独立墙、门与工地同框，聚焦 (38,9) — `l-shots.mjs`：wall-half.json，`focus=38,9&zoom=0.45`
- upgrading.png — 厕所升级中，聚焦 (13,10) — `l-shots.mjs`：upgrading.json，`focus=13,10&zoom=0.4`
- using.png — 有人正在使用厕所，聚焦 (13,10) — `l-shots.mjs`：using.json，`focus=13,10&zoom=0.4`
- windup.png — 攻击前摇，聚焦 (18,12) — `l-shots.mjs`：windup.json，`focus=18,12&zoom=0.35`
- queue.png — 门外排队道，聚焦 (6,15) — `l-shots.mjs`：crowd.json，`focus=6,15&zoom=0.45`
- states.png — 眩晕、防御、被中断、告急与攻击者同框 — `l-shots.mjs`：states.json，`focus=37.25,13.75&zoom=0.69`
- levels.png — 马桶 1–5 级：(37,8) 1、(37,24) 2、(13,10) 3、(13,21) 4、(30,19) 5，悬停 (13,10) 淡出其屋顶 — `l-shots.mjs`：levels.json，`focus=24,16&zoom=0.75&hover=13,10`
- overview-day.png — 全图，白天 — `l-shots.mjs`：crowd.json
- overview-dusk.png — 全图，黄昏 — `l-shots.mjs`：crowd.json，`dusk=1`
- closeup-day.png — 近景，白天，约 24×15 格，含两间棚屋与排队道入口，与原型尺度相近 — `l-shots.mjs`：crowd.json，`focus=16,14&zoom=0.5`
- closeup-dusk.png — 近景，黄昏，构图同 closeup-day — `l-shots.mjs`：crowd.json，`focus=16,14&zoom=0.5&dusk=1`
- low-390.png — 390×844 手机宽度，`quality=low` — `l-shots.mjs`：crowd.json，`quality=low`
- compare-day.png — 左：原型 `docs/art/prototype/forest.png`，右：实现 `closeup-day.png` — `l-compare.mjs`
- compare-dusk.png — 左：原型 `docs/art/prototype/forest-dusk.png`，右：实现 `closeup-dusk.png` — `l-compare.mjs`
- pixel-live.png — 观战页实时 canvas（`__looView.capture()`，tick 10），1440×900 视口下 canvas 为 960×554 — `scripts/l-pixel.sh`（live 服务 18135 + vite 18136）
- pixel-replay.png — 同一 tick 由 `scene.html?api=1&tick=10&still=1&quality=high` 绘制的画面 — `scripts/l-pixel.sh`
- pixel-diff.png — 两者逐像素比较，任一通道不同的像素涂红；本次无红色像素 — `scripts/l-pixel.sh`
- pixel.json — 逐像素结果：tick 10，960×554，`diff_pixels` 0 — `scripts/l-pixel.sh`
