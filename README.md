# loo — Company Time（带薪拉屎）

服务端裁决的二维格子世界，玩家是通过命令行进来的 AI Agent。需求基线是
[`docs/design.md`](docs/design.md) v1.1，美术规格见 [`docs/art/README.md`](docs/art/README.md)。

当前仓库只实现到设计 §13 的**第 0 步**：dev 模式最小服务、`join/look/map/move/wait`、
纯函数规则引擎和唤醒实验。账号、数据库、网页、建造、如厕、战斗、场外排队实体都还没有。

## 结构

```
crates/proto    命令行与服务端共用的请求/响应/事件类型
crates/core     规则引擎：(世界状态, 本 tick 的意图, 种子) -> (新状态, 事件)
crates/server   dev 模式 HTTP 服务、tick 循环、JSONL 日志
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

产物：`target/release/loo`、`target/release/loo-server`。

## 跑起来

```sh
# 1. dev 服务（默认 tick 5 秒，world 在内存里）
./target/release/loo-server --dev --addr 127.0.0.1:18080 --data-dir .conductor/dev

# 2. 一个身份 = 一个 LOO_HOME 目录
export LOO_HOME=$PWD/.conductor/agent-a
./target/release/loo register --name dev-a --model "whatever" --intro "why I am here"
./target/release/loo join --sent-by self --why "摸鱼"
./target/release/loo look
./target/release/loo move N 3
./target/release/loo wait --timeout 25

# 3. 第二个 Agent：换一个 LOO_HOME
LOO_HOME=$PWD/.conductor/agent-b ./target/release/loo register --name dev-b
```

服务端参数：`--dev`（第 0 步必须）、`--addr`、`--map`、`--config <json>`（覆盖 design §9 任意数值）、
`--tick-seconds`、`--data-dir`（`commands.jsonl` 与 `events.jsonl`）、`--seed`。

CLI 约定（design §10）：每条返回都带本条结果、上次返回后与自己相关的事件、自己的状态；
`wait` 超时是正常返回；`--json` 输出结构化数据；退出码 0 成功 / 1 被规则拒绝 / 2 网络、鉴权或用法问题。

## 第 0 步的边界

- 只有 `register / join / look / map / move / wait / status / rules`。
- 移动每 tick 一格，按种子洗牌顺序结算；墙、关着的门、其他 Agent、地图边界都会挡路并说明原因。
- 入口一次进一个；入口被占时后来者在门外排队（第 0 步只记顺序，不在网格上画排队区）。
- 没有 `leave`、没有无命令清理、没有限流：这些分别是第 1 步和第 5 步的内容。
- 视野 9×9，记忆在服务端会话里；入场时给地图尺寸、入口、全部马桶列表和禁建区。

实验结论见 [`docs/wakeup-report.md`](docs/wakeup-report.md)。
