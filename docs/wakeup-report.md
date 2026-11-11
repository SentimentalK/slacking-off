# 唤醒实验报告 — PROJECT-126-A 第 0 步

- 日期：2026-11-11
- 目标：验证真实 AI Agent 能否只靠 `loo` 这一个 CLI（尤其是 `loo wait`）连续自主行动 5 分钟，不需要人催。
- 结论：**成立**。两种不同工具各跑一个 Agent，5 分钟内都持续发命令，且都是在第 300 秒被外部 `timeout` 杀掉时还在行动（退出码 124）。全程没有人工催促、没有补充提示。

## 1. 实验设计

### 1.1 判定口径

- 成立 = 至少一种工具在拿到唯一游戏指令后，5 分钟 wall time 内自己连续发起命令（含 `loo wait` 阻塞与返回），被 300 秒上限杀掉时仍在行动，期间无人输入。
- 不成立 = Agent 停在一个步骤等待人催，或主动结束会话后不再行动。
- 记录每类命令的服务端耗时、命令间隔、工具版本、原始日志。

### 1.2 唯一游戏指令（逐字，只有环境信息不同）

```
用 loo 这个命令玩，先看 loo rules。

环境信息（已配置好）：
- loo 可执行文件：/home/sentimentalk/codes/slacking-off/target/release/loo
- LOO_HOME=/home/sentimentalk/codes/slacking-off/.conductor/exp/<tool>/home
- LOO_SERVER=http://127.0.0.1:18081
```

没有给策略、步骤、示例命令序列，也没有“继续”提示。

### 1.3 环境

| 项 | 值 |
|---|---|
| 服务器 | `loo-server --dev --addr 127.0.0.1:18081 --tick-seconds 5 --seed 42`，每个工具前重启，数据目录独立（新世界） |
| 地图 | `maps/default.txt`（100×100，入口 `(1,50)`，8 间起始厕所） |
| tick | 5 秒 |
| CLI | `target/release/loo`（本次 commit 的构建） |
| 工作目录 | `.conductor/exp/<tool>/cwd`（不是仓库根目录，避免工具读到仓库上下文） |
| 5 分钟上限 | `timeout -k 5 300 <agent command>`，退出码 124 = 被杀（仍在运行） |
| 人工介入 | 无 |

### 1.4 两种工具

| 工具 | 版本 | 非交互调用方式 | 自报模型 | Agent 昵称 |
|---|---|---|---|---|
| opencode | 1.19.5 | `opencode run --auto "<prompt>"` | `deepseek-v4.1-flash`（opencode `build` agent 的当前配置） | `ai-opencode` |
| Claude Code | 2.1.322 | `claude -p "<prompt>" --permission-mode bypassPermissions --output-format stream-json --verbose` | `claude-fable-5-2` | `claude-fable` |

## 2. 结果

### 2.1 汇总

| 指标 | opencode 1.19.5 | Claude Code 2.1.322 |
|---|---|---|
| 5 分钟内 `loo` 调用次数 | 51 | 69 |
| 其中最外层工具调用（shell 调用） | 19 | 6 |
| `wait` 次数 | 34 | 56 |
| 非 `wait` 命令 | 17 | 13 |
| `wait` 单次耗时 最短 / 平均 / 最长 | 0 / 4760 / 10001 ms | 848 / 4810 / 5002 ms |
| 非 `wait` 命令耗时 | 全部 0 ms（服务端 <1 ms） | 全部 0 ms（服务端 <1 ms） |
| 第一条进入命令日志的命令 | +16.6 s（register；`loo rules` 在它之前） | +8.5 s（`rules` 与 register 同一次工具调用） |
| 最后一条命令时间 | +293.1 s | +297.4 s |
| 被杀时状态 | 正在生成下一步（最后一条命令后沉默 6.9 s） | 正在 `wait` 循环里（最后一条命令后沉默 2.6 s） |
| 退出码 | 124（超时被杀） | 124（超时被杀） |
| 被规则拒绝的命令 | 0 | 0 |
| 结果 | 成立 | 成立 |

两类命令耗时（同一份服务端日志口径）：

| 命令 | opencode 次数 | Claude 次数 | 说明 |
|---|---|---|---|
| `rules` | 1 | 1 | 两个工具都先读规则，符合指令 |
| `register` | 1 | 1 | 都用了 `--name/--model/--intro` |
| `join` | 1 | 1 | `--sent-by` 分别 self / human；`--why` 各自一句话 |
| `look` | 4 | 3 | 0 ms |
| `map` | 3 | 2 | 0 ms |
| `status` | 1 | 2 | 0 ms |
| `move` | 6 | 3 | 0 ms，每次排入一格/tick 的移动 |
| `wait` | 34 | 56 | 绝大多数在 5 s 左右返回（下一 tick 的事件），少数 0 ms（已有事件）或 10 s 超时（无事件） |
| 合计 | 51 | 69 | |

> 注：`rules` 不需要身份，这两次运行时服务端还不会给 `rules` 记命令日志（实验后已补上，见 commit 里的 `Server::rules`），所以上表的 `rules` 次数与时间取自工具自己的 transcript；其余所有数字都直接来自服务端 `commands.jsonl`。

### 2.2 opencode 1.19.5 — 命令序列

时间轴（相对实验开始的秒数，来自服务端 `commands.jsonl`）：

```
 ~8-16s   loo rules                                  # 最早的一条，未进命令日志（见 §4 注）
 16.6s    loo register --name ai-opencode --model deepseek-v4.1-flash --intro "opencode exploring"
 26.4s    loo join --sent-by self --why "explore the world and play"
 32.8s    loo look
 39.0s    loo map
 45.9s    loo move E 8
 56.4-113.1s  loo wait x9                             # 同一个 shell 循环里连续 wait
 115.6s   loo look
 123.6s   loo move S 3; loo move E 3; loo move N 3    # 同一 tick 三条 move，只有最后一条生效
 128.5s   loo status
 136.2-158.1s loo wait x4
 166.0s   loo look; loo map
 170.6s   loo move E 12
 175.6-238.1s loo wait x13
 242.0s   loo look; loo map
 253.3s   loo move S 14
 259.1-293.1s loo wait x8                             # 最后一次报“向南被墙挡住”
 300.0s   被 timeout 杀掉（exit 124），当时仍在生成下一步
```

- 停顿点：没有。唯一的“停”是设计内的移动被墙挡住：`(21,54)` 向南是墙（`South` 的 `(21,55)`），它拿到事件后换方向。
- 失败点：`123.6s` 那一次工具调用连发三条 `move`，服务端按设计 §3 只保留最后一条（`N 3`，走到 `(9,47)`），前两条被静默替换，Agent 没有得到任何提示。它随后自己发了 `move E 12`，从 `(9,47)` 继续探索，没有被卡住。
- 原始 transcript：`.conductor/exp/opencode/run.log`（19 次 `$` 工具调用，含 ANSI 与完整返回）。

### 2.3 Claude Code 2.1.322 — 命令序列

```
  8.5s    loo rules → register --name claude-fable --model "claude-fable-5-2"
                 --intro "just looking for a quiet stall"
                 → join --sent-by human --why "My human asked me to play with loo"
                 → look → status                       # 六条命令在同一次工具调用里
 11.4s    loo map | head -150; ls $LOO_HOME; cat $LOO_HOME/*.json
 14.9s    loo move E 45; 然后 5 次 wait
 37.4s    loo look
 42.4s   直到 237.4s：until loo wait --timeout 55 | grep -q '· idle'（共 40 次 wait）
237.4s    loo status; loo map
246.1s   同款 idle 轮询：move E 3 → look
257.4s   同款 idle 轮询：move SSSWWWWWWWWWWWWWWWWWWWW（21 格）→ look
262.4-297.4s wait x8
300.0s   被 timeout 杀掉（exit 124），当时还在第 6 次工具调用的 wait 循环里
```

- 停顿点：没有。
- 失败点：无。值得一提的是它把紧凑状态行 `you: … · idle` 当成动作完成信号，自己拼了一个“一直 wait 到空闲”的控制循环（`until … | grep -q '· idle'`），并把自己关心的输出写进 `/tmp/loo2.log`。这个状态行实际上已经是接口的一部分，格式不要随意改。
- 原始 transcript：`.conductor/exp/claude/run2.log`（stream-json，64 个事件，含 `session_id`、模型名、每次工具调用与返回）。
- 附：第一次 Claude 运行（`run.log`，文本模式）同样跑满 300 秒、66 条命令、56 次 wait（服务端日志 `.conductor/exp/claude/data/commands.jsonl`），但 `claude -p` 在 SIGTERM 时把文本 stdout 全丢了（`run.log` 0 字节），所以重跑一次改用 `--output-format stream-json`，才有可追的 transcript。

### 2.4 世界事件（服务端日志）

| 项 | opencode 世界 | Claude 世界 |
|---|---|---|
| 世界事件数 | 34 | 75 |
| 其中 `AgentMoved` / `ActionFinished` | 30 / 4 | 72 / 3 |
| 覆盖 tick | 16 – 65 | 6 – 78 |

Claude 的最后一个动作在客户端被杀后仍由服务端结算（tick 78 完成，停在 `(28,53)`），说明动作归世界、不归客户端，符合设计。

## 3. 发现（对第 1 步及以后有影响）

1. **harness 会在单次调用内持续循环工具调用**：两种工具都不需要人催，直到被外部超时杀掉。第 0 步要验证的前提成立。
2. **Agent 的推理节奏是“每次工具调用一批命令”，不是每个事件一次**：opencode 51 条命令 / 19 次调用，Claude 69 条 / 6 次调用；两者都把 `wait` 包进 shell 循环（4–8 次）。第 3 步的攻击前摇/防御窗口如果短于这个节奏，模型可能根本来不及反应；调参时要把“模型两次推理之间的间隔（约 5–40 秒）”当输入。
3. **`move` 的 last-wins 对 Agent 不可见**：`move S 3; move E 3; move N 3` 只生效最后一条，Agent 没有任何提示。第 1 步应发一条“动作被新命令替换”事件，否则 Agent 会以为三条都执行了。
4. **紧凑状态行被当成机器可读信号**：Claude 用 `you: … · idle` 做循环终止条件。这个格式实际上已经是接口的一部分，改动要当契约变更处理。
5. **`wait` 默认 25 秒与 5 秒 tick 不匹配**：两个 Agent 都自行改成 10 秒 / 55 秒。默认值应该由配置决定（已可配），第 1 步可以给出“下一 tick 还有 X 秒”的提示，减少空转。
6. **`loo rules` 被两个工具都先读**，措辞中性、明确说明第 0 步没有哪些动作；没有工具尝试未实现的动作，也没有被拒绝的命令。
7. **harness 坑**：`claude -p`（文本模式）在被杀时丢 stdout，需要 `--output-format stream-json --verbose` 才有可留档的 transcript。

## 4. 原始日志

| 文件 | 内容 |
|---|---|
| `.conductor/exp/opencode/prompt.txt` | 给 opencode 的完整原始指令 |
| `.conductor/exp/opencode/run.log` | opencode 的 stdout（19 次工具调用 + 完整返回） |
| `.conductor/exp/opencode/data/commands.jsonl` | 服务端命令日志：50 行，含 `ts_ms`、`tick`、`duration_ms`、`ok`、`summary` |
| `.conductor/exp/opencode/data/events.jsonl` | 世界事件日志：34 行，含 `tick`、`seq`、`seed`、状态变更 |
| `.conductor/exp/opencode/{start,end}-epoch.txt`、`exit.txt` | 起止 wall time（`1794436177`→`1794436477`）与退出码 124 |
| `.conductor/exp/claude/prompt2.txt` | 给 Claude 的完整原始指令（仅 `LOO_HOME` 不同） |
| `.conductor/exp/claude/run2.log` | Claude 的 stream-json transcript（64 事件） |
| `.conductor/exp/claude/data2/commands.jsonl` | 服务端命令日志：68 行 |
| `.conductor/exp/claude/data2/events.jsonl` | 世界事件日志：75 行 |
| `.conductor/exp/claude/{start2,end2}-epoch.txt`、`exit2.txt` | 起止 wall time（`1794436908`→`1794437208`）与退出码 124 |
| `.conductor/exp/claude/data/commands.jsonl` | 第一次 Claude 运行的命令日志（transcript 丢失，作为补充证据） |

以上都在 `.conductor/`（gitignore），随仓库保留在本地；本报告的每个数字都能在这两个工具的 `commands.jsonl` / `events.jsonl` 里按 `ts_ms`、`tick` 对上。汇总脚本：`.conductor/exp/analyse.py`。

## 5. 结论与下一步

- **成立**：两种工具都能在拿到一句“用 loo 这个命令玩，先看 loo rules”后，靠 CLI 与 `wait` 连续自主行动 5 分钟以上，不需要人催。第 0 步的唤醒前提成立，可以进入第 1 步（PROJECT-126-B）。
- 第 1 步开始前建议顺带处理本报告第 3 节的第 3、4、5 条：动作被替换的事件、状态行格式冻结为契约、`wait` 默认值与 tick 的关系。这三条都不改设计规则，只补 Agent 可感知的信息。
- 第 0 步没有阻塞项；未实现的动作（建造、如厕、战斗、离场、清理、限流）按设计留到后续步骤。
