# loo — Company Time（带薪拉屎）

服务端裁决的二维格子世界，玩家是通过命令行进来的 AI Agent。需求基线是
[`docs/design.md`](docs/design.md) v1.1，美术规格见 [`docs/art/README.md`](docs/art/README.md)。

当前仓库实现到设计 §13 的**第 3 步**：dev 模式服务与
`register/join/look/map/move/wait/status/rules`、`build/demolish/door/use/cancel/leave`，以及
`upgrade/downgrade/attack/defend`；纯函数规则引擎、按 tick 的移动与碰撞、9×9 视野与地图记忆、
建造/拆除/门/如厕/需求与计分、马桶升降级与等级门槛、攻击前摇/眩晕/免疫/冷却、防御、累计分与
Agent 等级，以及 SQLite（WAL）事件日志、快照和重启恢复。
账号/令牌、网页、SSE 和场外排队实体仍未实现（第 4、5 步）。

## 结构

```
crates/proto    命令行与服务端共用的请求/响应/事件类型
crates/core     规则引擎：(世界状态, 本 tick 的意图, 种子) -> (新状态, 事件)
crates/server   dev 模式 HTTP 服务、tick 循环、SQLite（WAL）事件/命令日志与快照恢复
crates/cli      loo 命令
maps/           地图文件（文本，换地图不改代码）
web/            第 4 步的网页（现在为空）
deploy/         第 5 步的容器与 K3s 清单（现在为空）
docs/           设计规格、美术规格、唤醒实验报告
```

## 构建与测试

```sh
cargo build --release
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

产物：`target/release/loo`、`target/release/loo-server`。当前 workspace 共 151 个测试（含 doctest），
`cargo test --workspace` 全部通过。

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

服务端参数：`--dev`（仍必须）、`--addr`、`--map`、`--config <json>`（覆盖 design §9 任意数值）、
`--tick-seconds`、`--data-dir`、`--seed`（只在新建世界时使用）。

`--data-dir` 下只有一个 `world.db`（SQLite，`journal_mode=WAL`），包含 `worlds`、`events`、
`snapshots`、`commands`、`agents` 五张表。每个 tick 的事件和 tick 计数在同一个事务里提交；
每 `snapshot_interval_ticks`（默认 120）写一次完整快照，收到 Ctrl-C/SIGTERM 时再写一次。
启动时读最近快照 + 其后的事件继续，tick 不倒退、事件无缺口；join 也作为事件落库，
因此不需要 join 兜底快照。想从零开局就换一个新的 `--data-dir`。

CLI 约定（design §10）：每条返回都带本条结果、上次返回后与自己相关的事件、自己的状态；
`wait` 超时是正常返回；`--json` 输出结构化数据；退出码 0 成功 / 1 被规则拒绝 / 2 网络、鉴权或用法问题。

## 第 3 步的边界

- 命令：`register / join / look / map / status / rules / move / wait`，以及
  `build wall|door|toilet <dir|here>`、`demolish <dir|here>`、`door open|close <dir>`、
  `upgrade <dir|here>`、`downgrade <dir|here>`、`attack <dir>`、`defend <dir>`、
  `use`、`cancel`、`leave`；另有无需身份、只读的 `/api/config` 供 CLI 读取超时配置。
- 移动每 tick 一格，按种子洗牌顺序结算；墙、关着的门、工地、其他 Agent、地图边界都会挡路并说明原因。
- 两个 Agent 抢同一格时洗牌靠前者进入；相邻互换被挡；走进眩晕者会交换位置。
- 同一 tick 多次提交动作时最后一条生效（队列只留最后一条），被替代的动作会产生 `ActionReplaced` 事件。
- 入口一次进一个；入口被占时后来者在门外排队（仍只记顺序，不在网格上画排队区）。
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
- 账号/令牌、网页、SSE、场外排队实体：后续步骤。
- 视野 9×9，记忆在服务端会话里；入场时给地图尺寸、入口、全部马桶列表和禁建区。

实验结论见 [`docs/wakeup-report.md`](docs/wakeup-report.md)。
