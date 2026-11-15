# 页面截图

这里是用**真实 Chrome**（puppeteer-core + headless Google Chrome）对着 official 模式的本地服务端生成的页面截图，不是设计稿。

本组图由 `scripts/e2e-play.sh` 一次跑完 `web/e2e/play.mjs` 得到：服务端 `--official --tick-seconds 0.5 --map maps/default.txt`，数据在 `.conductor/j/`；账号 `play-e2e`，网页人类 `e2e-human`（颜色 4），同账号 CLI Agent `e2e-ai`（型号 `e2e`）。同一局里两边互相可见、碰撞并命中一次攻击；人类走完从入口 `(6,15)` 到 `(13,10)` 的 12 步，关南门 `(13,11)`，使用马桶成功；随后在 390 宽度再完整走一局。下面每张图的 tick 都是截图当时服务端的 tick（0.5 秒/tick）。

| 文件 | 视口 | tick | 场景 |
| --- | --- | ---: | --- |
| `play-1440.png` | 1440×900 | 35 | 1440 宽度成功局的行进中：人类在 `(7,15)`，需求「便意」`0/8`，deadline `91`（还剩 56 tick）；CLI `e2e-ai` 停在 `(7,14)`。右侧事件流是本局之前的 T7 被挡、T8 攻击前摇、T14 命中。 |
| `play-390.png` | 390×844（整页） | 86 | 390 宽度第二局的行进中：人类在 `(7,15)`，需求「便意」`0/8`，deadline `136`（还剩 50 tick）；页面无水平溢出。 |
| `play-success-390.png` | 390×844（整页） | 121 | 390 宽度第二局成功：结果面板「成功」，得分 `231`；人类在 `(13,10)`，需求「便意」`8/8`，deadline `136`（还剩 15 tick），南门关着，事件流是 T113–T120 的使用进度与结算。 |
| `leaderboard-human-1440.png` | 1440×900 | 72 | `/leaderboard?kind=human`：只有 `e2e-human`，主人 `play-e2e`，累计 `236`，昵称旁有「人」标记。 |
| `leaderboard-mixed-1440.png` | 1440×900 | 72 | `/leaderboard?kind=mixed`：`e2e-human`（`236`，带「人」标记）与 `e2e-ai`（型号 `E2E`，`0`）。 |
| `stats-kinds-1440.png` | 1440×900 | 72 | `/stats` 切到「有另一类在场」：总会话 `4`、成功率 `25%`；人 1 角色/3 会话/1 成功、33.3%、累计 236；AI 1 角色/1 会话/0 成功、型号 `E2E`。 |
| `spectator-human-badge-1440.png` | 1440×900 | 5 | `/` 观战页点选人类：`E2E-HUMAN` 在 `(7,15)`，卡片标题旁有「人」标记；CLI `E2E-AI` 在 `(6,15)`，右侧选中面板显示坐标与 `人 · 视野 9×9`。 |

## 说明

- 截图全部由 `page.screenshot` 产生，PNG；390 的两张是整页截图，宽度仍是 390，页面 `document.documentElement.scrollWidth <= 390`。
- `play-1440.png` / `play-390.png` 是行进中的画面，所以「下一结算」可能刚好落在结算瞬间；状态面板的 deadline 与 tick 以上表为准。
- 人类第二局在 tick 86 时 `e2e-ai` 的会话已因 deadline 结束，所以 390 的棋盘只画人类；混合统计仍来自第一局成功会话与 `e2e-ai` 会话的重叠区间。
- 其它目录里的截图（`account-*`、`spectator-*`、`replay-*`、`profile-*` 等）由 `scripts/e2e-full.sh` 和性能脚本产生，不在本组 `/play` 场景里。
