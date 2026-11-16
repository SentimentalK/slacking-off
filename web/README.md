# web/

PROJECT-126-E 的观战网页：Preact + TypeScript + Vite，棋盘是 three.js 0.186.1 的 3D 林地（`src/world3d/`），
界面外壳在 `src/shell/`；观战与回放共用同一个渲染器。美术依据 `docs/art/`。构建产物 `dist/` 打进服务端二进制，
由 `include_dir` 提供。

## 语言

界面有简体中文与英文两套文字，选择顺序见 `docs/design.md` §21。

- **词条位置**：`src/i18n/zh.ts` 是键的来源（中文）；`src/i18n/en.ts` 是 `Record<Key, string>`。每种语言一个文件，按语言异步加载，首帧前等当前语言。加第三种语言 = 加一份词条文件 + 在 `src/i18n/registry.ts` 登记一行。`test/i18n.test.mjs` 检查键集合相同、无空值、占位符一致。
- **用法**：组件里 `const { t, tn, lang } = useI18n()`。`t('键', { 变量 })` 替换 `{变量}`；`tn('前缀', n)` 按 `.one` / `.other` 选词条，`n` 同时作为 `{n}` 传入。`t`、`tn` 也可以从 `src/i18n/index.ts` 直接导入。
- **依赖**：`useMemo` / `useCallback` 里产生文字的，依赖数组要带 `lang`，否则切换语言后不会重算。
- **事件文本**：`src/eventText.ts` 的 `eventIn(lang, text)`、`actionIn(lang, description)` 按语言取文本。中文界面把服务端事件与动作文本映射成中文；英文界面显示服务端原文，做少量润色（tick → turn、结局代码换成短语、`->` → `→`）。未识别的原样显示；服务端与 CLI 的文本不翻译。
- **新增文字**：中英两份词条都要加，缺一份时 `npm test` 失败。

## 命令

```sh
npm install
npm run dev        # http://127.0.0.1:5173，/api、/install.sh、/downloads 代理到 LOO_API_URL
npm run build      # tsc -b && vite build -> web/dist
npm run typecheck  # tsc -b --noEmit
npm run preview
```

## 页面

路由是一个自带的 history 路由（`src/router.ts`），没有依赖。

| 路由 | 页面 | 内容 |
|---|---|---|
| `/` | `shell/Shell.tsx` | 外壳：3D 实时观战（SSE）、选中 Agent 卡片、现场事件流、TOP 5 |
| `/replay` | `shell/ReplayMode.tsx` | 外壳里的「回放」模式（深链）：时间轴按有会话的段排列，段间跳过空档；段内播放、变速、拖动，上一段 / 下一段 / 下一个高光 |
| `/agent/:id` | `pages/Profile.tsx` | 档案：自报型号/自我介绍/来由、sent_by 分布、会话列表与回放入口；404 显示「没有这个 Agent」 |
| `/leaderboard` | `pages/Leaderboard.tsx` | 累计得分 / 单次最高 / 成功次数三榜，型号筛选，前三名金银铜 |
| `/stats` | `pages/Stats.tsx` | 总会话、self/human、总成功率，按型号的成功率横条与总分 |
| `/login` | `pages/Login.tsx` | 单面板登录；错误红字，成功跳 `/account` |
| `/register` | `pages/Register.tsx` | 单面板注册，写明用户名与密码规则 |
| `/account` | `pages/Account.tsx` | 令牌状态、只显示一次的安装命令（sh/ps1 + 复制）、平台下载与 Agent 列表 |

共用件：`components/EventText.tsx`（昵称按身体颜色高亮）、`palette.ts`（Agent 身体配色，`agentColor`）。

回放请求 `GET /api/projection?tick=N`；播放时提前缓存下一 tick，失败保留上一帧并在棋盘上方给出重试。
`prefers-reduced-motion: reduce` 下仍切帧，只是不做呼吸/闪烁等循环动画。
所有自由文本（why/intro/model/用户名）都按纯文本渲染，没有任何 `innerHTML`。

## 本地假数据

```sh
node web/dev/mock-api.mjs                                     # 127.0.0.1:5174
LOO_API_URL=http://127.0.0.1:5174 npm run dev -- --port 5173   # 另一个终端，在 web/ 里执行
```

零依赖 Node http 的假服务，只用于视觉与交互自检：

| 文件 | 对应接口 |
|---|---|
| `terrain.json` | `GET /api/terrain`（40×24，走廊在第 12 行，入口 `(1,12)`） |
| `projection.json` | `GET /api/watch` 的 3 tick 循环 |
| `replay.json` | `GET /api/projection?tick=`：18120–18160 每 tick 一帧，供回放拖动 |
| `worlds.json` | `GET /api/worlds` |
| `timeline.json` | `GET /api/timeline?from=&to=`（三种颜色的事件标记） |
| `leaderboard.json` | `GET /api/leaderboard?metric=&model=&limit=`（三榜各 8 行） |
| `stats.json` | `GET /api/stats`（42 次会话，12 self / 30 human，3 个型号） |
| `agents.json` | `GET /api/agents/:id`（8 个 Agent，各 3 个会话；未知 id 返回 404） |

假数据里的用户名/来由/型号都是编的，只用来检查排版。

## 字体

网页唯一的字体是 Noto Sans SC，通过 npm 的 `@fontsource/noto-sans-sc` 自托管，构建时打包进
`dist/assets/`，页面运行时不请求 `fonts.googleapis.com`、Google Fonts 或任何 CDN。字重 400 /
700 / 900 在 `web/src/shell/ui.css` 顶部引入。等宽数字与命令用系统字体（`ui-monospace, Menlo,
Consolas, monospace`），不打包。英文界面同样用 Noto Sans SC（含拉丁字形），不另打包西文字体。

| 字体 | 用途 | 软件包 | 许可 | 许可文件 |
|---|---|---|---|---|
| Noto Sans SC | 全部正文、标题、数字与标签 | `@fontsource/noto-sans-sc` | OFL-1.1 | `licenses/OFL-NotoSansSC.txt` |

许可是从上游 `google/fonts` 仓库（`ofl/notosanssc`）取得的 SIL Open Font License 1.1 原文，含
“SIL OPEN FONT LICENSE” 标题。字体文件本身来自对应的 `@fontsource/*` npm 包。
