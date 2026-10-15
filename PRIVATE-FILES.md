# 不进版本库的文件 / 需要自己填的配置

克隆下来之后这些是缺的。**缺了大多不会报错**——功能会安静地降级或干脆不出现，所以先看这份清单，别对着代码找 bug。

规则本体在 `.gitignore`，这里补的是「是什么 / 怎么来 / 缺了会怎样」。

## 部署配置：`js/00-config.js`（在版本库里，默认全空）

前端（桌面 exe、浏览器、安卓 APK 共用）唯一要自己填的文件：

```js
var GRANCYAN_CONFIG = {
    supabaseUrl: '',      // https://<你的项目>.supabase.co
    supabaseAnonKey: '',  // 项目的 anon（public）key
    sharePageUrl: '',     // 分享对话的查看页地址（以 / 结尾）
};
```

- **全部留空 = 纯本机模式**：不弹登录墙，云同步、云端表情收藏、分享链接、藏宝地图上云都不出现，其余功能照常。
- 想多设备同步：建一个自己的 Supabase 项目，在 SQL Editor 里跑 `docs/shares.sql`、`docs/letters.sql`
  （以及 chats / profiles 两张表和 stickers / avatars 两个 Storage 桶），然后填上 `supabaseUrl` + `supabaseAnonKey`。
  anon key 本来就是给前端公开用的，不是密钥；真正的权限靠表上的 RLS。
- 分享对话：另外部署一个只调 `get_share(id)` 的静态查看页（比如 GitHub Pages），把地址填进 `sharePageUrl`。
  不填的话点「分享」只会提示未配置。
- 可选 `buildCwd`：施工单（`js/64-build.js`）让 Claude Code 去哪个目录改代码；不填 = 电脑端 server 自己的项目目录。

## 需要你自己准备的

### `key.pem` + `cert.pem` —— 本地自签 TLS 证书

给手机端走 `https://` 用。**缺了不报错**：server 打一句警告后退化成纯 HTTP，局域网 `http://` 照常可用。手机上 https 连不上就是这个。

同目录有 `key.pem.example` / `cert.pem.example`，里面是验证过的生成命令和排错。

### `.mcp-token`

MCP 远程操控的令牌。**等同于这台电脑的 shell 密码**，绝不能进版本库。远程操控默认不挂，只有设了 `EXEC_MCP=on` 才会启用并生成它（也可以用 `EXEC_MCP_TOKEN` 指定）。

### `.env` —— 本地私有配置（server.js 启动时读项目根目录的 `.env`）

`server.js` 顶部有一个十几行的最小实现（不引 dotenv）。规则：**真实环境变量优先**，文件里的只在该变量没设时兜底。
下面这些都是可选的，缺了对应功能安静降级：

```
# server 监听地址。默认 0.0.0.0（手机 App 要从局域网连过来）；
# 只在这台电脑上用的话设 127.0.0.1，局域网里就连不上了（手机端功能跟着失效）
GRANCYAN_HOST=0.0.0.0
# 端口（默认 3000 / 3443）
GRANCYAN_PORT=3000
GRANCYAN_PORT_TLS=3443

# 云同步中转（和 js/00-config.js 填同一个 Supabase 项目）
SUPABASE_URL=https://<你的项目>.supabase.co
SUPABASE_ANON_KEY=eyJ...

# 檐廊 sky_tonight 的观测点（坐标属于「住哪儿」，刻意不写进代码）
ENGAWA_LAT=…
ENGAWA_LON=…
ENGAWA_TZ_OFFSET=8

# 电脑操控 / 终端 / MCP 远程操控的默认工作目录（不设 = 当前用户主目录）
GRANCYAN_AGENT_CWD=…
GRANCYAN_TERMINAL_CWD=…
EXEC_MCP_CWD=…

# 外部工具位置（不设就去 PATH 上找 / 当作没装）
EXEC_MCP=on                  # 打开 MCP 远程操控（默认关，见 README）

# 订阅 GPT 没有 Codex 登录时，用你自己的 OpenAI 兼容端点（Responses API）
GRANCYAN_GPT_BASE_URL=…
GRANCYAN_GPT_API_KEY=…

# 手环数据（默认关）：手机上 Gadgetbridge 自动导出库的路径；拉下来的库放 GRANCYAN_BAND_DIR（默认 ~/.grancyan/band）
GRANCYAN_BAND_DB_REMOTE=…
GRANCYAN_BAND_DIR=…
GRANCYAN_ADB=…               # adb.exe（手环数据）
# 思考翻译：主模型拒翻时的备用 Ollama 模型（不设 = 拒翻就保留原文）
GRANCYAN_TRANSLATE_FALLBACK=…
GRANCYAN_VOICE_DIR=…         # 本地情绪声音引擎目录，见 scripts/voice/README.md
GRANCYAN_VOICE_PY=…
NURSERY_HOME=…               # 育儿室引擎（默认找和本项目并排的 llm-nursery）
GRANCYAN_STROLL_HOME=…       # 散步引擎和日志目录（散步看板）
GRANCYAN_STROLL_LOGS=…
GRANCYAN_XIAOQIAN_ZILIAO=…   # 本地微调模型的查资料目录
GRANCYAN_SAVE_DIR=…          # 「保存图片」落盘目录（默认 ~/Pictures/GranCyan）
GRANCYAN_GEMINI_LANE_PORT=…  # Gemini 专用代理端口（默认 10888）

# 小红书散步：校验专用浏览器里登的是不是你的号（填 uid，不填 = 不校验，按「判不出」处理）
GRANCYAN_XHS_ME=…
# 公开评论里绝不能出现的词（逗号分隔：你的名字、昵称等）。项目名本身已内置
GRANCYAN_SAY_FORBIDDEN=…

# Nominatim 要求 User-Agent 能认出调用方
NOMINATIM_UA=…
```

桌面 exe 被拷到项目目录外时，可以用 `GRANCYAN_DEV_PARENTS`（分号分隔的父目录）告诉它去哪找项目根。

⚠️ 两处 MCP 脚本是独立进程，**不经过** server.js，所以 `.env` 喂不到它们，得自己 export 或在 MCP 客户端配置里传：

- `mcp-exec.js` 读 `EXEC_MCP_TOKEN`、`EXEC_MCP_CWD`
- `mcp-github.js` 读 `GITHUB_TOKEN`

各模型的 API key 是在应用界面里填的，不从文件读。

## 会自己长出来的

### `android/grancyan.keystore` + `android/keystore.pass` —— 安卓签名密钥和它的密码

`android/build.ps1` 首次打包时自动 `keytool -genkeypair` 生成，不用手动准备。

密码不写在脚本里，按这个顺序找：环境变量 `GRANCYAN_KEYSTORE_PASS` → `android/keystore.pass` →
两个都没有、keystore 也还没生成时，随机生成一个写进 `android/keystore.pass`。
keystore 已经在、却两处都找不到密码时，脚本直接报错停下（不会悄悄换一把新钥匙）。
两个文件都在 `.gitignore` 里。

⚠️ **但生成之后必须两个一起另外备份。** 丢了任何一个就等于换了签名，装在手机上的旧版 APK 没法覆盖升级，只能卸载重装（聊天记录跟着没）。

### `coread.db` / `coread.db-shm` / `coread.db-wal`

伴读书架的阅读进度和笔记，首次用到时自建。属于个人数据。

### `nursery-saves/`

育儿室（llm-nursery）的存档目录，运行时自建。

### `stickers-fav/`

应用内上传/收藏的表情包。版本库里只留一个 `README.txt` 占位。
自带表情库在 `stickers/`（作者手绘，进版本库），那个是源码资产，两者是分开的。

## 纯私人数据，本来就不该有

### `Gadgetbridge.db`

手环健康数据，从手机的 Gadgetbridge 拉过来的。默认不启用；设了 `GRANCYAN_BAND_DB_REMOTE` 后存在 `~/.grancyan/band/`（不在项目目录里）。没有它，手环相关功能不出数据，其余一切正常。

### `scripts/ombre-memories.json`

从 Ombre-Brain 导出的私人记忆明文。可由 `scripts/ombre-import.js --src <buckets 目录>` 重新生成——前提是你有源数据。

---

## 打包时也一并排除

`package.json` 的 `pack:exe` 里有对应的 `--ignore`，确保这些不会被裹进分发的 exe：
`^/(key|cert)\.pem$`、`^/grancyan\.keystore$`、`^/Gadgetbridge\.db$`、`^/coread\.db(-wal|-shm)?$`、`^/\.mcp-token$`、`^/nursery-saves($|/)`。
