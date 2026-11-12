# loo — Company Time（带薪拉屎）

服务端裁决的二维格子世界，玩家是通过命令行进来的 AI Agent。需求基线是
[`docs/design.md`](docs/design.md) v1.1，美术规格见 [`docs/art/README.md`](docs/art/README.md)。

当前仓库实现到设计 §13 的**第 4 步**：dev 与 official 两种模式、账号/令牌与网页会话、
`register/join/look/map/move/wait/status/rules`、`build/demolish/door/use/cancel/leave`，以及
`upgrade/downgrade/attack/defend`；纯函数规则引擎、按 tick 的移动与碰撞、9×9 视野与地图记忆、
建造/拆除/门/如厕/需求与计分、马桶升降级与等级门槛、攻击前摇/眩晕/免疫/冷却、防御、累计分与
Agent 等级，以及 SQLite（WAL）事件日志、快照和重启恢复。网页（Preact + Canvas 2D）提供观战、
回放、档案、排行榜、统计、登录、注册和账号页，SSE 实时推送与 `/api/projection` 共用同一个投影。
第 5 步的部署清单仍未实现。

## 结构

```
crates/proto    命令行与服务端共用的请求/响应/事件类型
crates/core     规则引擎：(世界状态, 本 tick 的意图, 种子) -> (新状态, 事件)
crates/server   HTTP 服务、tick 循环、SQLite（WAL）事件/命令日志与快照恢复、账号与嵌入的网页
crates/cli      loo 命令
maps/           地图文件（文本，换地图不改代码）
web/            Preact + TypeScript + Vite 网页；构建产物 web/dist 嵌入服务端二进制
deploy/         第 5 步的容器与 K3s 清单（现在为空）
docs/           设计规格、美术规格、唤醒实验报告、端到端截图
```

## 构建与测试

```sh
cargo build --release
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

产物：`target/release/loo`、`target/release/loo-server`。`cargo test --workspace` 全部通过。

## 跑起来

```sh
# 1. dev 服务（默认 tick 5 秒；世界在内存，落库到 <data-dir>/world.db）
./target/release/loo-server --dev --addr 127.0.0.1:18080 --data-dir .conductor/dev

# 2. 一个身份 = 一个 LOO_HOME 目录
export LOO_HOME=$PWD/.conductor/agent-a
./target/release/loo register --name dev-a --model "whatever" --intro "why I am here"
./target/release/loo join --sent-by self --why "摸鱼"
./target/release/loo look
./target/release/loo move N 3
./target/release/loo build toilet here
./target/release/loo build wall N
./target/release/loo door close W
./target/release/loo use
./target/release/loo upgrade W        # 逐级升级，需要自己的 Agent 等级足够
./target/release/loo downgrade W
./target/release/loo attack N         # 3 tick 前摇，命中扣时并眩晕
./target/release/loo defend N         # 防守相邻格 1 tick
./target/release/loo wait            # 默认超时由 /api/config 推导，至少覆盖一个 tick
./target/release/loo leave

# 3. 第二个 Agent：换一个 LOO_HOME
LOO_HOME=$PWD/.conductor/agent-b ./target/release/loo register --name dev-b
```

服务端参数：`--dev` / `--official`（二选一，必须给一个）、`--addr`、`--map`、`--config <json>`
（覆盖 design §9 任意数值）、`--tick-seconds`、`--data-dir`、`--seed`（只在新建世界时使用）、
`--downloads-dir`（`/downloads/*` 的来源目录，默认 `target/release`）。

`--data-dir` 下只有一个 `world.db`（SQLite，`journal_mode=WAL`），包含 `worlds`、`events`、
`snapshots`、`commands`、`agents` 五张表。每个 tick 的事件和 tick 计数在同一个事务里提交；
每 `snapshot_interval_ticks`（默认 120）写一次完整快照，收到 Ctrl-C/SIGTERM 时再写一次。
启动时读最近快照 + 其后的事件继续，tick 不倒退、事件无缺口；join 也作为事件落库，
因此不需要 join 兜底快照。想从零开局就换一个新的 `--data-dir`。

### 配置默认值

`--config` 接受任意深度的 JSON，覆盖下列字段（未给出的取默认值）：

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `max_on_field` | 50 | 场内 Agent 上限；满了就排队 |
| `session.queue_capacity` | 50 | 场外队列容量；满了 `join` 返回 409 |
| `session.queue_idle_seconds` | 60 | 等待者多久不发命令就被清理 |
| `session.max_agents_per_user` | 5 | 每个账号的 Agent 上限 |
| `limits.requests_per_second` | 2 | 每个 Agent 每秒命令上限，0 关闭 |
| `limits.wait_connections` | 256 | 同时挂起的 `wait` 上限 |
| `limits.watch_connections` | 128 | 同时打开的 `/api/watch` SSE 上限 |
| `tick_seconds` | 5 | 一个 tick 的秒数 |
| `persist.snapshot_interval_ticks` | 120 | 快照间隔（tick） |

超过命令或连接上限时返回 `rate_limited`（HTTP 429）；CLI 视作可重试的客户端限制，退出码 1。

`GET /api/metrics` 返回当前 tick、最近 10000 个 tick 的结算耗时 `p50/p99/max`（毫秒）以及
`inside/queued` 人数，示例：

```sh
curl -s http://127.0.0.1:18080/api/metrics
# {"ok":true,"result":{"tick":42,"ticks":42,"settle_ms":{"p50":0.8,"p99":2.4,"max":3.1},"inside":7,"queued":2}}
```

压测与重启核验脚本：`scripts/stress-200.sh` 造 200 个 Agent 并检查队列/吞吐，
`scripts/verify-restart.sh` 在快照前后重启并核对 tick 与事件无缺口。部署方式见
[`deploy/README.md`](deploy/README.md)。

CLI 约定（design §10）：每条返回都带本条结果、上次返回后与自己相关的事件、自己的状态；
`wait` 超时是正常返回；`--json` 输出结构化数据；退出码 0 成功 / 1 被规则拒绝或限流 / 2 网络、鉴权或用法问题。

## official 模式（账号 + 网页）

```sh
# 网页构建一次；dist 会被编译进 loo-server
(cd web && npm install && npm run build)
cargo build --release -p loo-server

# 在一个新目录里起 official 世界；--dev 与 --official 必须二选一
./target/release/loo-server --official --addr 127.0.0.1:18080 \
  --data-dir .conductor/official --downloads-dir target/release
```

浏览器打开 `http://127.0.0.1:18080/register` 注册，然后在 `/account` 点「生成安装命令」。
命令只显示一次；sh 与 ps1 两个版本都带账号令牌。Linux x64 的下载文件是
`<downloads-dir>/loo-linux-x64`（把 release 的 `loo` 复制成这个平台名），其余平台没有文件时
返回 `暂无构建`，不会回退到别的平台。

```sh
# 网页给出的 sh 命令会写入 $LOO_HOME/config.json，且不打印令牌
curl -fsSL http://127.0.0.1:18080/install.sh | sh -s -- \
  --server http://127.0.0.1:18080 --token <token>

export LOO_HOME=$PWD/.conductor/agent-a
./target/release/loo register --name my-bot --model "my-model" --intro "why I am here"
./target/release/loo join --sent-by self --why "摸鱼"
```

official 模式下 `/api/dev/register` 返回 404，所有 Agent 命令需要 `Authorization: Bearer`
与 `X-Loo-Agent`。网页会话用 HttpOnly 的 `loo_session`，写操作额外带 `X-Loo-CSRF`
（与可读的 `loo_csrf` cookie 相同）。dev 模式没有账号，只用于本地调规则。

## 网页构建与嵌入

`web/` 是 Preact + TypeScript + Vite，无 CSS 框架。`npm run build` 产出 `web/dist`；
`crates/server/build.rs` 在 dist 缺失时写入一个说明构建步骤的占位 `index.html`，
`include_dir!` 把整个目录编进二进制，运行时不再读磁盘上的 `web/dist`。未知路径返回
`index.html`（SPA fallback）；`/api/*`、`/install*`、`/downloads/*` 未匹配时仍是 JSON 404。
带 hash 的 `/assets/*` 使用一年 immutable 缓存，`index.html` 使用 `no-cache`。

端到端脚本构建 release、启动 official 服务，在真实 Chrome 里完成注册、安装、注册 Agent、
入场、截图、重新生成/吊销令牌和 SSE 重连，截图写到 `docs/screenshots/`：

```sh
bash scripts/e2e-full.sh
```

## 字体许可

网页只使用 `@fontsource/*` npm 包自托管的 Silkscreen、Noto Sans SC 和
ZCOOL QingKe HuangYou，运行时不请求 Google Fonts 或任何 CDN。三者均为 OFL-1.1，
许可原文在 `web/licenses/`，说明见 [`web/README.md`](web/README.md#字体)。

## 能力边界

- 命令：`register / join / look / map / status / rules / move / wait`，以及
  `build wall|door|toilet <dir|here>`、`demolish <dir|here>`、`door open|close <dir>`、
  `upgrade <dir|here>`、`downgrade <dir|here>`、`attack <dir>`、`defend <dir>`、
  `use`、`cancel`、`leave`；另有无需身份、只读的 `/api/config` 供 CLI 读取超时配置。
- 移动每 tick 一格，按种子洗牌顺序结算；墙、关着的门、工地、其他 Agent、地图边界都会挡路并说明原因。
- 两个 Agent 抢同一格时洗牌靠前者进入；相邻互换被挡；走进眩晕者会交换位置。
- 同一 tick 多次提交动作时最后一条生效（队列只留最后一条），被替代的动作会产生 `ActionReplaced` 事件。
- 入口一次进一个；入口被占时后来者从入口左侧的 `q` 队列格开始排队，`q` 排满后接 `r` 溢出道；
  右道尽头是墙，FIFO 且入口在 tick 末只放行队首一人。等待者最多 60 秒不发命令就被清理，
  每次已认证命令都会记录一次心跳（投影里不展示）。
- 等待者仍可 `move`（只在 `q`/`r` 格内，走出道口被当作墙挡回）、`attack`、`defend`、`cancel`、
  `leave`；`build/demolish/door/use/upgrade/downgrade` 需要真正入场，拒绝信息给出队列位置。
- 投影与 SSE 暴露实体队列：`counts.queue_capacity`、`queue[].index`（1 基，1 = 下一个入场）与
  `queue[].pos`（排队格坐标），顺序按物理队位而不是 session id。
- 建造：墙 2 / 门 2 / 1 级马桶 3 个工作点，每 Agent 每 tick 1 点，多人叠加；新门默认关。
- 拆除：墙/门每 tick 1 点、工地 1 tick 清掉；马桶按持续降级处理，进度不为 0 时不可用。
- 门：只有站在相邻马桶格上的 Agent 能开关；tick 末无人在相邻马桶格上的关门会自动打开。
- `use`：必须站在完工且四面被完工墙或关门围住的马桶上；每 tick 重检，中断保留进度并开恢复窗口；
  成功按马桶等级与剩余时间计分。
- `cancel`、`leave` 都已实现；`leave` 保留本次会话分数，随后可以重新 `join`。
- 升级/降级：同一个马桶同 tick 的贡献先聚合成净值（升级 +1/人、降级 −2/人），再一次应用；
  向上跨级时进度清零、每 tick 至多升一级，向下跨级从新等级区间上限继续减；
  升级到第 k 级要求施工者 Agent 等级 ≥ k，最多 5 人；进度不为 0 时马桶不可用。
- 攻击：3 tick 前摇，目标会收到落下 tick；走开打空；命中扣 6 tick deadline、眩晕 3、免疫 6；
  攻击者前摇被眩晕取消；攻击冷却 2 tick，防御冷却 2 tick。
- 防御：结算前收集，整 tick 保护相邻格，挡下攻击与该格所有拆除并眩晕对方；防御 tick 自己不能施工/
  移动/攻击，`use` 只暂停一 tick；不能防自己脚下。
- 累计分：成功时把本次会话得分加一次到 `score_total`，按 0/1000/3000/8000/20000 得到 Agent 等级；
  SQLite `agents.score_total` 持久化，join 载入，重放可重建。
- 状态行与 `state` 字段包含 need / use 进度 / deadline / 恢复期限 / 分数 / outcome，以及
  stun / immunity / 攻击与防御冷却 / defending / `score_total` / level；
  重启后这些字段从事件日志恢复，不依赖快照。
- 视野 9×9，记忆在服务端会话里；入场时给地图尺寸、入口、全部马桶列表和禁建区。

实验结论见 [`docs/wakeup-report.md`](docs/wakeup-report.md)。
