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
| `stats-kinds-1440.png` | 1440×900 | 72 | 统计窗口（`/stats`，叠在观战外壳上）切到「有另一类在场」：总会话 `4`、成功率 `25%`；人 1 角色/3 会话/1 成功、33.3%、累计 236；AI 1 角色/1 会话/0 成功、型号 `E2E`。 |
| `spectator-human-badge-1440.png` | 1440×900 | 5 | `/` 观战页点选人类：`E2E-HUMAN` 在 `(7,15)`，卡片标题旁有「人」标记、正文标签是「本人在玩」；CLI `E2E-AI` 在 `(6,15)`，右侧选中面板显示坐标与 `人 · 视野 9×9`。 |
| `home-empty-1440.png` | 1440×900 | 3 | 空数据库的 `/`（观战外壳）：左上时钟是 `● LIVE`，没有「● 回放」，顶栏 `在场 0/12`；`/api/timeline` 没有高光标记、也没有可回放区间，事件流只有开局三个自动关门的门事件。同一刻的 `/replay` 只写「没有可回放的区间」，不画轨道，「播放」禁用、tick 输入仍可用。 |
| `replay-empty-1440.png` | 1440×900 | 3（回放帧；实时 12） | 场内没人后 `/` 的自动回放：循环最后一段可回放区间 `[3, 8]`（`k2-ai` 从入场到离场），4 tick/s；`TICK 3` 就是这段的第一个 tick，播到 8 之后回到 3，不会跳进空 tick。观战外壳左上时钟是 `● 回放`（`.ui-clock .live.rp`），事件流是回放帧里的入场与需求。 |
| `replay-back-live-1440.png` | 1440×900 | 13 | 第二个 Agent `k2-ai-2` 在 tick 12 `join`，页面在 1 个 tick（170 ms）内退出回放：左上时钟的 `● 回放` 消失、回到 `● LIVE`，选中卡片显示 `k2-ai-2`，顶栏 `在场 1/12`。 |
| `replay-1440.png` | 1440×900 | 3 | `scripts/e2e-full.sh`（端口 18086、1 秒/tick）的 `/replay?tick=3`：这一刻只有一段可回放区间 `[1, 3]`，轨道是一块金色实心段，标签 `第 1/1 段 · TICK 3 · 本段 3/3`，左右端读 `1` / `3`；`上一段`、`下一段` 因为只有一段而禁用。 |
| `replay-spans-1440.png` | 1440×900 | 3 | 同一个 `/replay` 的分段轨道：两段可回放区间 `[3, 8]` 与 `[12, 13]`（9–11 无人），画成两块金色实心段、段间 3px 缝隙，红色 demolish 高光落在第一段末尾；按「第一段」后 tick 跳到 3，标签 `第 1/2 段 · TICK 3 · 本段 1/6`，左右端读 `3` / `13`，指针停在这段开头，`上一段` 禁用。 |

## 说明

- 观战外壳（`/`）改版后，上面凡是写「右上角」「左上角」状态的，指的是 `web/src/shell/` 里的时钟 `.ui-clock`（左上）与顶栏计数 `.ui-navr .cnt`（右上）；排行榜、统计、档案、账号、登录、注册都是叠在观战外壳上的窗口（`.win[data-window]`），不再是整页。`/play` 与 `/replay` 仍是旧整页。

- 截图全部由 `page.screenshot` 产生，PNG；`play-390.png` 与 `play-success-390.png` 是整页截图，宽度仍是 390；`play-pending-390.png` 是 390×844 视口截图。三种情况下页面 `document.documentElement.scrollWidth <= 390`。
- `play-1440.png` / `play-390.png` / `play-pending-390.png` 是行进中的画面，所以「下一结算」可能刚好落在结算瞬间；tick 以上表为准，deadline 与倒计时是那一刻的实时值（每次跑都会重新抽签）。
- 棋盘下方那条常驻「待结算动作」条由键盘、方向键与点格菜单共用一条提交路径（`web/src/pages/Play.tsx` 的 `runAction`），按 `error`（红）> 正在执行（`--defend` 蓝）> 已提交待结算（`--gold` 金黄）> 「没有待执行动作」的优先级显示；`play-1440.png` 抓的是 `pending`，`play-pending-390.png` 单独固定 `pending`，`play-390.png` 恰好抓到 `rejected`（脚本走位快于令牌桶），下一个 tick 后会变成 `executing` 或空态。
- 人类第二局在 tick 138 时 `e2e-ai` 的会话已因 deadline 结束，所以 390 的棋盘只画人类；混合统计仍来自第一局成功会话与 `e2e-ai` 会话的重叠区间。
- 其它目录里的截图（`account-*`、`spectator-*`、`replay-*`、`profile-*` 等）由 `scripts/e2e-full.sh` 和性能脚本产生，不在本组 `/play` 场景里。
- `home-empty-1440.png`、`replay-empty-1440.png`、`replay-back-live-1440.png`、`replay-spans-1440.png` 来自 `scripts/e2e-k.sh`（`web/e2e/onboarding.mjs`，端口 18143、0.5 秒/tick、空数据目录）：账号 `k2-e2e`，CLI Agent `k2-ai` 建墙再拆墙后离场，第二个 Agent `k2-ai-2` 再入场；`replay-1440.png` 来自 `scripts/e2e-full.sh`（端口 18086、1 秒/tick）。
- `/replay` 的时间轴只铺可回放的 tick：`/api/timeline` 的 `spans` 决定轨道，每个可回放 tick 占一个位置，区间之间是 3px 缝隙；指针位置是当前 tick 的累计偏移，点击/拖动按偏移 seek，左右键移到相邻可回放 tick（跨段直接到下一段开头或上一段末尾），播放每次前进一个可回放 tick 并在最后一段播完时停下。
- `stats-prompt-1440.png` 来自 Master 的验收（端口 18147，数据目录由 `scripts/e2e-k.sh` 那一局拷来，再加一个装了摸鱼提示的账号 `k-stats-b`）：`/stats` 上「摸鱼提示」这一组切到「装了提示」，总会话 `1`；另两组标签「全部 / 装了提示 / 没装提示」与上面的「全部会话 / 有另一类在场」是各自独立的选择器。

## 波次 5 清点

W5f（删除像素界面）对 `docs/screenshots/` 下全部 131 张 PNG 做了清点。

- 生成脚本：对每个文件名做 `grep -rn "<文件名>" web/e2e web/scripts scripts`；脚本用模板拼名的（`${w}`、`perf-${tag}-*`、`l-shots` 的命名表）按模板对应。
- 没有任何脚本写入其路径的，逐张看图（缩略图与原图抽查）。
- 结论：没有"无脚本生成且为 2D 像素棋盘"的图，因此本次没有删除截图。2D 旧画面只有两类，二者都仍由脚本生成，按"仍被生成的保留"处理：`perf-{before,after}-{spectator,replay-213}.png`（4 张，`scripts/perf.sh` 的 tag 命名）与根目录 `replay-1440.png`（`flow.mjs` 全量验证会重拍，重拍后为 3D）。前 4 张的 2D 内容已无法由当前代码重现，是否删除待定。
- `l3/`、`l4/`、`l5/play-*`、`l5/icons.png`、`l5/roof.png`、`l5/dusk/round-*/ref-dusk.png` 是旧波次的副本；当前没有脚本写入这些路径，但看图都是 3D 林地或窗口，按规则保留。

| 文件 | 生成脚本 | 2D/3D | 处置 |
| --- | --- | --- | --- |
| `account-1440.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `account-390.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `home-empty-1440.png` | web/e2e/onboarding.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/account-1440.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/account-390.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/board-1440.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/board-390.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/login-1440.png` | web/scripts/ui-shots.mjs（--windows） | 3D 背景上的窗口（或纯色背景窗口） | 保留：脚本仍生成 |
| `l3/login-390.png` | web/scripts/ui-shots.mjs（--windows） | 3D 背景上的窗口（或纯色背景窗口） | 保留：脚本仍生成 |
| `l3/look/1-day.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/2-dusk.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/3-forest-edge.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/4-icons.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/5b-roof-north.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/5-roof.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/6-portrait.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/7-medium.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/after/closeup-day.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/closeup-dusk.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/levels.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/low-390.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/missing-wall.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/overview-day-medium.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/overview-day.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/overview-dusk.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/play-vision.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/portrait-390.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/queue.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/shack-door-north.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/shack-door-south.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/states-overview.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/states.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/upgrading.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/using.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/vision.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/wall-half.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/after/windup.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l3/look/compare-day.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/look/compare-dusk.png` | web/scripts/l3-compare.mjs（look） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/profile-1440.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/profile-390.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/register-1440.png` | web/scripts/ui-shots.mjs（--final） | 3D 背景上的窗口（或纯色背景窗口） | 保留：脚本仍生成 |
| `l3/register-390.png` | web/scripts/ui-shots.mjs（--final） | 3D 背景上的窗口（或纯色背景窗口） | 保留：脚本仍生成 |
| `l3/replay-auto-1440.png` | web/scripts/ui-shots.mjs（--replay-auto） | 3D（林地） | 保留：脚本仍生成 |
| `l3/settings-1440.png` | web/scripts/ui-shots.mjs（--final） | 3D（林地） | 保留：脚本仍生成 |
| `l3/settings-390.png` | web/scripts/ui-shots.mjs（--final） | 3D（林地） | 保留：脚本仍生成 |
| `l3/stats-1440.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/stats-390.png` | web/scripts/ui-shots.mjs（--windows） | 3D（林地） | 保留：脚本仍生成 |
| `l3/ui-compare-account.png` | web/scripts/l3-compare.mjs（ui） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/ui-compare-board.png` | web/scripts/l3-compare.mjs（ui） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/ui-compare-play.png` | web/scripts/l3-compare.mjs（ui） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/ui-compare-watch.png` | web/scripts/l3-compare.mjs（ui） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l3/watch-1440.png` | web/scripts/ui-shots.mjs（--final） | 3D（林地） | 保留：脚本仍生成 |
| `l3/watch-390.png` | web/scripts/ui-shots.mjs（--final） | 3D（林地） | 保留：脚本仍生成 |
| `l3/watch-selected-1440.png` | web/scripts/ui-shots.mjs（--final） | 3D（林地） | 保留：脚本仍生成 |
| `l4/play-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-390.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-memory-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-menu-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-menu-390.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-success-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-success-390.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/play-using-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l4/ui-compare-play.png` | web/scripts/l3-compare.mjs（ui） | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-1/compare-day.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-1/compare-dusk.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-1/ref-dusk.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/dusk/round-2/compare-day.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-2/compare-dusk.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-2/ref-dusk.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/dusk/round-3/compare-day.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-3/compare-dusk.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l5/dusk/round-3/near-day.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l5/dusk/round-3/near-dusk.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l5/dusk/round-3/overview-dusk.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l5/icons.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-390.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-memory-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-menu-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-menu-390.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-success-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-success-390.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/play-using-1440.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l5/replay-1440.png` | web/e2e/onboarding.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l5/replay-390.png` | web/e2e/onboarding.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l5/roof.png` | 无（未写入其路径） | 3D（林地） | 保留：无脚本，看图为 3D/窗口，不属 2D 棋盘 |
| `l/closeup-day.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/closeup-dusk.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/compare-day.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `l/compare-dusk.png` | web/scripts/l-compare.mjs | 对比图（左右并排） | 保留：脚本仍生成 |
| `leaderboard-1440.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `leaderboard-human-1440.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `leaderboard-mixed-1440.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/levels.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/low-390.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/missing-wall.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `login-1440.png` | web/scripts/ui-shots.mjs（--windows / --final） | 3D 背景上的窗口（或纯色背景窗口） | 保留：脚本仍生成 |
| `l/overview-day.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/overview-dusk.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/pixel-diff.png` | web/scripts/l-pixel.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/pixel-live.png` | web/scripts/l-pixel.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/pixel-replay.png` | web/scripts/l-pixel.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/queue.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/shack-door-north.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/shack-door-south.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/states.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/upgrading.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/using.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/wall-half.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `l/windup.png` | web/scripts/l-shots.mjs | 3D（林地） | 保留：脚本仍生成 |
| `perf-after-replay-213.png` | scripts/perf.sh（visual-screenshots） | 2D（旧像素棋盘） | 保留：脚本仍生成；内容为 2D 旧画面，待决（不在本次删除） |
| `perf-after-spectator.png` | scripts/perf.sh（visual-screenshots） | 2D（旧像素棋盘） | 保留：脚本仍生成；内容为 2D 旧画面，待决（不在本次删除） |
| `perf-before-replay-213.png` | scripts/perf.sh（visual-screenshots） | 2D（旧像素棋盘） | 保留：脚本仍生成；内容为 2D 旧画面，待决（不在本次删除） |
| `perf-before-spectator.png` | scripts/perf.sh（visual-screenshots） | 2D（旧像素棋盘） | 保留：脚本仍生成；内容为 2D 旧画面，待决（不在本次删除） |
| `play-1440.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `play-390.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `play-pending-390.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `play-success-390.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `profile-1440.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `register-1440.png` | web/scripts/ui-shots.mjs（--windows / --final） | 3D 背景上的窗口（或纯色背景窗口） | 保留：脚本仍生成 |
| `replay-1440.png` | web/e2e/flow.mjs；web/e2e/onboarding.mjs | 2D（旧像素棋盘） | 保留：flow.mjs 全量验证会重拍（当前内容为 2D 旧画面，重拍后为 3D） |
| `replay-back-live-1440.png` | web/e2e/onboarding.mjs | 3D（林地） | 保留：脚本仍生成 |
| `replay-empty-1440.png` | web/e2e/onboarding.mjs | 3D（林地） | 保留：脚本仍生成 |
| `replay-spans-1440.png` | web/e2e/onboarding.mjs | 3D（林地） | 保留：脚本仍生成 |
| `spectator-1440.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `spectator-390.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `spectator-human-badge-1440.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `stats-1440.png` | web/e2e/flow.mjs | 3D（林地） | 保留：脚本仍生成 |
| `stats-kinds-1440.png` | web/e2e/play.mjs | 3D（林地） | 保留：脚本仍生成 |
| `stats-prompt-1440.png` | 无（Master 验收时手工拷入） | 窗口（纯色背景，无场景） | 保留：无脚本；内容是统计窗口，不是 2D 棋盘 |
