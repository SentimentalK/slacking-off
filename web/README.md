# web/

PROJECT-126-E 的观战网页：Preact + TypeScript + Vite，棋盘用 Canvas 2D（唯一渲染器 `src/render.ts`），
样式与图块只用 `docs/art/`。构建产物 `dist/` 打进服务端二进制，由 `include_dir` 提供。

## 命令

```sh
npm install
npm run dev        # http://127.0.0.1:5173，/api、/install.sh、/downloads 代理到 LOO_API_URL
npm run build      # tsc -b && vite build -> web/dist
npm run typecheck  # tsc -b --noEmit
npm run preview
```

## 本地假数据

```sh
node web/dev/mock-api.mjs                                     # 127.0.0.1:5174
LOO_API_URL=http://127.0.0.1:5174 npm run dev -- --port 5173   # 另一个终端，在 web/ 里执行
```

`web/dev/` 里的地形与投影只用于视觉自检（3 个 tick 循环），真实数据来自服务端 SSE。

## 字体

三个字体都通过 npm 的 `@fontsource/*` 自托管，不请求任何外部字体域名：

| 字体 | 用途 | 软件包 | 许可 |
|---|---|---|---|
| Silkscreen | 数字、昵称、标签、tick | `@fontsource/silkscreen` | OFL-1.1 |
| Noto Sans SC | 正文 | `@fontsource/noto-sans-sc` | OFL-1.1 |
| ZCOOL QingKe HuangYou | 标题「带薪拉屎」 | `@fontsource/zcool-qingke-huangyou` | OFL-1.1 |

三个字体均为 SIL Open Font License 1.1（OFL-1.1），许可全文随各自的 npm 包分发（包内 `LICENSE`）。
