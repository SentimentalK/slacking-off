# 页面截图

这里是用**真实 Chrome**（puppeteer-core + headless Google Chrome）对着 official 模式的本地服务端生成的页面截图，不是设计稿。

本组图由 `scripts/e2e-play.sh` 一次跑完 `web/e2e/play.mjs` 得到：服务端 `--official --tick-seconds 0.5 --map maps/default.txt`，数据在 `.conductor/j/`；账号 `play-e2e`，网页人类 `e2e-human`（颜色 4），同账号 CLI Agent `e2e-ai`（型号 `e2e`）。同一局里两边互相可见、碰撞并命中一次攻击；人类走完从入口 `(6,15)` 到 `(13,10)` 的 12 步，关南门 `(13,11)`，使用马桶成功；随后在 390 宽度先检查棋盘下方的常驻「待结算动作」条（提交 → 结算 → 限流三态），再完整走一局。下面每张图的 tick 都是截图当时服务端的 tick（0.5 秒/tick）。

| 文件 | 视口 | tick | 场景 |
| --- | --- | ---: | --- |
| `play-1440.png` | 1440×900 | 38 | 1440 宽度成功局的行进中：人类在 `(7,15)`（第 1 步已落地、第 2 步刚提交），需求「尿意」`0/4`，deadline `96`（还有 58 tick）；棋盘下方的常驻条是 `pending` 态「已提交：移动 E · 下一次结算执行 · 0.4s」（金字），与上方「下一结算」同一个倒计时。CLI `e2e-ai` 停在 `(7,14)`。右侧事件流是本局之前的被挡、攻击前摇与命中。 |
| `play-390.png` | 390×844（整页） | 138 | 390 宽度第二局的行进中：人类在 `(7,15)`，需求「尿意」`0/4`，deadline `188`（还有 50 tick）；脚本以约 1.6 步/秒走位，已经超过服务端每 Agent 2 次/秒的令牌桶，所以常驻条这一刻是 `rejected` 态「被拒绝：请求过快，1 秒后再试」（红字单行）；页面无水平溢出，棋盘宽度不变。 |
| `play-pending-390.png` | 390×844 | 110 | 390 宽度专测常驻条：刚按一次方向键、「已提交：移动 E · 下一次结算执行 · 0.2s」，条是 `pending` 态，仍在 390 内单行不换行、不出现横向滚动，棋盘（288 px）没有被挤窄。下一个 tick 后同一条会落到 `executing` 或「没有待执行动作」。 |
| `play-success-390.png` | 390×844（整页） | 123 | 390 宽度第二局成功：结果面板「成功」，得分 `227`；人类在 `(13,10)`，需求「便意」`8/8`，南门关着，事件流是最后一 tick 的使用进度与结算。 |
| `leaderboard-human-1440.png` | 1440×900 | 72 | `/leaderboard?kind=human`：只有 `e2e-human`，主人 `play-e2e`，累计 `236`，昵称旁有「人」标记。 |
| `leaderboard-mixed-1440.png` | 1440×900 | 72 | `/leaderboard?kind=mixed`：`e2e-human`（`236`，带「人」标记）与 `e2e-ai`（型号 `E2E`，`0`）。 |
| `stats-kinds-1440.png` | 1440×900 | 72 | `/stats` 切到「有另一类在场」：总会话 `4`、成功率 `25%`；人 1 角色/3 会话/1 成功、33.3%、累计 236；AI 1 角色/1 会话/0 成功、型号 `E2E`。 |
| `spectator-human-badge-1440.png` | 1440×900 | 5 | `/` 观战页点选人类：`E2E-HUMAN` 在 `(7,15)`，卡片标题旁有「人」标记、正文标签是「本人在玩」；CLI `E2E-AI` 在 `(6,15)`，右侧选中面板显示坐标与 `人 · 视野 9×9`。 |
| `home-empty-1440.png` | 1440×900 | 2 | 空数据库的 `/`：没有「回放」徽标，右上角是 `LIVE`，`在场 0/12`；`/api/timeline` 没有高光标记，事件流只有开局三个自动关门的门事件。 |
| `replay-empty-1440.png` | 1440×900 | 4（回放帧；实时 10） | 场内没人后的自动回放：棋盘左上角「回放」徽标、右上角状态也是「回放」，`TICK 4` 来自 `/api/projection?tick=4`；窗口是 `[0, 8]`（最近高光是 tick 8 建成墙后又被拆掉），事件流是回放帧里 `k2-ai` 走向 `(7,15)` 的那几步。 |
| `replay-back-live-1440.png` | 1440×900 | 11 | 第二个 Agent `k2-ai-2` 在 tick 10 之后 `join`，页面在 1 个 tick（278 ms）内退出回放：徽标消失、右上角回到 `LIVE`、选中面板显示 `k2-ai-2`，`在场 1/12`。 |

## 说明

- 截图全部由 `page.screenshot` 产生，PNG；`play-390.png` 与 `play-success-390.png` 是整页截图，宽度仍是 390；`play-pending-390.png` 是 390×844 视口截图。三种情况下页面 `document.documentElement.scrollWidth <= 390`。
- `play-1440.png` / `play-390.png` / `play-pending-390.png` 是行进中的画面，所以「下一结算」可能刚好落在结算瞬间；tick 以上表为准，deadline 与倒计时是那一刻的实时值（每次跑都会重新抽签）。
- 棋盘下方那条常驻「待结算动作」条由键盘、方向键与点格菜单共用一条提交路径（`web/src/pages/Play.tsx` 的 `runAction`），按 `error`（红）> 正在执行（`--defend` 蓝）> 已提交待结算（`--gold` 金黄）> 「没有待执行动作」的优先级显示；`play-1440.png` 抓的是 `pending`，`play-pending-390.png` 单独固定 `pending`，`play-390.png` 恰好抓到 `rejected`（脚本走位快于令牌桶），下一个 tick 后会变成 `executing` 或空态。
- 人类第二局在 tick 138 时 `e2e-ai` 的会话已因 deadline 结束，所以 390 的棋盘只画人类；混合统计仍来自第一局成功会话与 `e2e-ai` 会话的重叠区间。
- 其它目录里的截图（`account-*`、`spectator-*`、`replay-*`、`profile-*` 等）由 `scripts/e2e-full.sh` 和性能脚本产生，不在本组 `/play` 场景里。
- `home-empty-1440.png`、`replay-empty-1440.png`、`replay-back-live-1440.png` 来自 `scripts/e2e-k.sh`（`web/e2e/onboarding.mjs`，端口 18143、0.5 秒/tick、空数据目录）：账号 `k2-e2e`，CLI Agent `k2-ai` 建墙再拆墙后离场，第二个 Agent `k2-ai-2` 再入场。
- `stats-prompt-1440.png` 来自 Master 的验收（端口 18147，数据目录由 `scripts/e2e-k.sh` 那一局拷来，再加一个装了摸鱼提示的账号 `k-stats-b`）：`/stats` 上「摸鱼提示」这一组切到「装了提示」，总会话 `1`；另两组标签「全部 / 装了提示 / 没装提示」与上面的「全部会话 / 有另一类在场」是各自独立的选择器。
