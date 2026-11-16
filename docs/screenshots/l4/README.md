# 上场模式截图（l4）

全部由 `bash scripts/e2e-play.sh`（`web/e2e/play.mjs`）在真 GPU 的无头 Chrome 里整页截图；除注明 390 的为 1440×900，390 的是 `page.emulate` 触屏 390×844。

- play-1440.png — 桌面回合走到半路，镜头跟随自己 — 1440 回合（`roundAt`），一次点击远走之后、进棚屋之前
- play-memory-1440.png — 自己所在格与八格外的格子（视野外的格子显示记忆） — 纯点击回合（`clickOnlyRound`），成功之后
- play-menu-1440.png — 点门格后弹出的菜单 — `menu 1440` 回合，走到马桶后点门格、菜单出现时
- play-using-1440.png — 关门后正在使用厕所 — `using 1440` 回合，使用进行中
- play-success-1440.png — 使用成功的结果面板 — 纯点击回合，成功后
- play-390.png — 390 宽入场后的画面 — `entry 390` 回合（触屏），刚入场时
- play-menu-390.png — 390 宽的门格菜单 — `menu 390` 回合（触屏），菜单出现时
- play-success-390.png — 390 宽的成功结果面板 — "touch round at 390"（触屏，全程 `touchscreen.tap`），成功后
- ui-compare-play.png — 左原型 `docs/art/prototype/ui-play.png`，右 `play-1440.png` — `node web/scripts/l3-compare.mjs --out docs/screenshots/l4 --name ui-compare-play.png --left docs/art/prototype/ui-play.png --right docs/screenshots/l4/play-1440.png`
