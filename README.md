# GranCyan

> A self-hosted, multi-model AI chat app (desktop / Android / browser). Bring your own API key; everything stays local by default.

多模型 AI 聊天应用。一份代码，三个形态：

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| 本机开发 | `node server.js` | 监听 `:3000`（HTTP）/ `:3443`（HTTPS） |
| 桌面 exe | `npm run pack:exe` | Electron 壳内嵌 server，双击即用 |
| 安卓 APK | `android/build.ps1` | WebView 加载 `android/assets/` 里的前端副本，连电脑上的 server |

后端是单文件 Express（`server.js`），前端是一串裸 `<script>`（`js/01-core.js` … `js/71-*.js`，编号有空号）。

## 下载

不想自己构建的话，去 [Releases](https://github.com/KardKuro/GranCyan-open/releases) 下打好的包：

- **Windows**：`GranCyan-*-win-x64.zip`，解压到一个你有写权限的文件夹（别放 `C:\Program Files`），双击 `Grancyan.exe`。不用装 Node。
  - 聊天记录和设置存在 `%APPDATA%\Grancyan`；表情收藏、书架等文件存在解压目录的 `resources\app` 里。**升级时先把这些文件拷出来**，别直接删旧文件夹。
  - 包没有代码签名，第一次打开 Windows 可能弹 SmartScreen，点「更多信息 → 仍要运行」。
- **安卓**：`GranCyan-*.apk`。它只是前端，要连一台开着 GranCyan 的电脑：
  1. 手机和电脑连同一个局域网，电脑上开着 exe（或 `node server.js`）。
  2. 手机 App 里 设置 → 服务器地址 填 `http://电脑的局域网IP:3000`。
  3. 电脑上 设置 里能看到「配对码」，填到手机的同一栏。
  - 也可以用数据线 + `adb reverse tcp:3000 tcp:3000`，服务器地址留空。

## 能做什么

- **对话** —— 多模型切换、流式 Markdown、富文本 blocks 渲染、思考链展示、消息编辑/回收站/多选
- **记忆** —— 本地记忆库 + 高级记忆检索（向量粗召回 + 权重重排），可选跨设备云同步
- **主动能力** —— 没有 function calling，全部走 `[[指令]]` 文本协议：搜索、发图/贴纸、点歌、看天气、偷看屏幕、操控电脑（长跑任务可断线重挂）
- **房间** —— 日记、梦、学习/背单词、大富翁、育儿室、番茄钟、共读（coread）
- **感官** —— TTS 语音、语音输入、摄像头/通话、手环体征（Gadgetbridge，可选，默认关）
- **其它** —— 终端、外观预设与手势、文档解析（epub/docx/pdf）、建议气泡

## 跑起来

需要 **Node.js 20 或更新**（`better-sqlite3` 的要求；22 / 24 LTS 都行）。

```bash
npm i
node server.js          # 然后开 http://127.0.0.1:3000
```

或者 `npm run pack:exe` 打一个桌面 exe（产物在 `dist/`），双击运行，server 内嵌在里面。

- **默认是纯本机模式**：不需要账号，聊天、记忆、设置都存在本机（浏览器 IndexedDB + 项目目录 / `~/.grancyan/`），不会上传到任何地方。
- **可选：云同步。** 想多设备同步就建一个自己的 Supabase 项目，把地址和 anon key 填进 `js/00-config.js`（电脑端 server 另外在 `.env` 里填 `SUPABASE_URL` / `SUPABASE_ANON_KEY`）。留空就不出现登录和同步。细节见 `PRIVATE-FILES.md`。
- server 默认监听 `0.0.0.0`（手机 App 要从局域网连过来）。只在本机用的话设 `GRANCYAN_HOST=127.0.0.1`（环境变量或 `.env`）。端口用 `GRANCYAN_PORT` / `GRANCYAN_PORT_TLS` 改。
- 装了 WSL 的 Windows 上，用 `localhost` 测本地端点可能被 wslrelay 截胡返回空回复，一律用 `127.0.0.1`。

## 接模型

**主要方式：填你自己的 API key。** 在 设置中心 → 模型 & API 里新建一个模型，填 API 地址、模型名和 key。支持 Anthropic、OpenAI、Gemini，以及任何 OpenAI 兼容接口（DeepSeek、本地 Ollama 等）。key 存在本机，只发给你填的那个地址。

**可选：「订阅 Claude」/「订阅 GPT」/「订阅 Gemini」。** 这几项是让电脑上的 server 去调用**你自己在这台电脑上已经登录好的官方命令行工具**：

- 订阅 Claude → 官方 `claude`（Claude Code CLI），先自己装好并登录
- 订阅 GPT → 官方 `codex`（Codex CLI），先自己装好并 `codex login`；没登录的话也可以在 `.env` 里配自己的 OpenAI 兼容端点：`GRANCYAN_GPT_BASE_URL`（Responses API 地址）+ `GRANCYAN_GPT_API_KEY`。两样都没有时会直接报错，不会走任何默认中转。
- 订阅 Gemini → 官方 `agy`（Google Antigravity CLI），需要有 Google AI Pro 订阅的账号，先自己装好并跑一次 `agy` 登录。会话栏开 ✦ Gemini 后点「🔑 走 key」切成「💳 走订阅」。只有 Gemini 3.8 Flash 三档（深度下拉对应 low/medium/high），没有「自己联网」，第一个字要等十来秒（server 会预热一个进程）。agy 在系统临时目录下的一次性空目录里跑，读不到你项目里或家目录里的 `AGENTS.md`。需要代理才连得上 Google 的话，在 `.env` 里设 `GRANCYAN_AGY_PROXY=http://127.0.0.1:端口`；agy 不在默认位置时用 `GRANCYAN_AGY_BIN` 指定。

GranCyan 只是以子进程方式启动这些 CLI，**不读取、不保存、不转发你的登录凭据**；用量算在你自己的账号上，使用时请遵守对应服务的条款。

## 可选功能（默认关）

| 功能 | 怎么开 | 说明 |
| --- | --- | --- |
| MCP 远程操控 | 环境变量 `EXEC_MCP=on` | 在 `/mcp/<token>/…` 挂一个能在这台电脑上执行命令的 MCP 端点（给 claude.ai 等远程客户端用）。token 存在 `.mcp-token`（或用 `EXEC_MCP_TOKEN` 指定），**等同这台电脑的 shell 密码**。不设就完全不挂这条路由，也不生成 token。 |
| 手环数据（Gadgetbridge） | 电脑端设 `GRANCYAN_BAND_DB_REMOTE`，界面里打开 手环数据 → 自动同步 | server 用 adb 从手机拉 Gadgetbridge 自动导出的数据库。`GRANCYAN_BAND_DB_REMOTE` 填手机上导出文件的路径（如 `/storage/emulated/0/Gadgetbridge/Gadgetbridge.db`），拉下来的文件存在 `~/.grancyan/band/`（可用 `GRANCYAN_BAND_DIR` 改）。adb 位置用 `GRANCYAN_ADB` 指定。不配就不会调用 adb。 |

其余可选配置（TLS 证书、各类外部工具路径等）见 `PRIVATE-FILES.md`。

## 打包

```bash
npm run pack:exe        # 产物在 dist/，之后会自动跑 scripts/slim-dist.js 瘦身
```

```powershell
powershell -File android/build.ps1
```

样式改动需要 `npm run watch`（Tailwind 监听 `input.css` → `output.css`）。

## 目录

```
server.js            后端全部（API、代理、SSE、SQLite）
electron-main.js     Electron 主进程
index.html           单页外壳
js/                  前端，文件名编号 = 加载顺序 = 依赖顺序
css/ img/            静态资源
android/             安卓工程；assets/ 是构建产物
coread/              共读模块
scripts/             一次性脚本（记忆导入、行尾恢复、打包瘦身）
tests/               node tests/<名>.test.js
docs/                杂项笔记
AGENTS.md            改这个项目之前先读
```

## 改之前要知道的

这几条都会**静默失败**——不报错，东西就是没生效：

- **前端不是 ESM。** 所有 `js/*.js` 共享同一个全局词法作用域，编号就是依赖顺序。顶层立即执行的代码不能引用后面文件里的东西。
- **`android/assets/` 是构建产物。** 只改 `js/`，`build.ps1` 会重新生成安卓副本；手改 assets 必被下次构建覆盖。
- **新增 `[[指令]]` 要配套改三处**：解析、展示、系统提示里的说明。漏一处就是静默 bug。
- **`state` 新字段要过三道白名单**：`02-state.js` 默认值、`_doSave` 的 `idbSet`、`01-core.js` 云同步 push/merge、`14-boot-brain-hub.js` 启动赋值。漏一道 → 刷新即丢。
- **提示词缓存分 stable / volatile。** 每条消息都变的数据（时间戳、搜索结果）必须进 volatile，进 stable 等于缓存全废。
- **电脑操控模式下客户端断开 ≠ 停止。** 进程继续跑，靠 runId 重挂；新增下行 SSE 事件必须走 `send()`。

完整版见 [AGENTS.md](AGENTS.md)。

## 测试

```bash
node tests/prompt-cache.test.js     # 单条
node scripts/run-tests.js           # 全套
```

前端有改动就跑全套——里面有几条专门守「桌面 `js/` 与 `android/assets/js/` 逐字节一致」。

## License

Copyright (C) 2026 KardKuro

本项目以 [GNU Affero General Public License v3.0](LICENSE)（或任何更新版本，`AGPL-3.0-or-later`）发布。
简单说：可以用、改、再发布；改过的版本如果拿去给别人用（包括通过网络提供服务），要以同样的许可公开源码。完整条款见 [LICENSE](LICENSE)。

例外：[`docs/output-admission.md`](docs/output-admission.md) 的思路来自 [do-not-safety-me](https://github.com/Gwendolenmave/do-not-safety-me)（Gwendolenmave），
这一份文档按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 发布，不适用 AGPL。

---

私人项目，没有对外支持计划。
