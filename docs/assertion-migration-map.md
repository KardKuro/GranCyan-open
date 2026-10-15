# 断言迁移表（server.js 拆分 · Phase 0 产物）

对应 `docs/server-split-plan.md` 的 Phase 0 第 2 步。方案原文说"分区表 A–AG"，
但那张表实际没有作为独立表格留在 `server-split-plan.md` 里——文档只在"侦察结论摘要"
和各 Phase 条目里零散点了字母（D/E/F/G、Y/Z、AD，以及 Phase 1–4 每条前面的字母）。
本表里的分区号，凡是方案原文明确写出的字母，照抄；凡是方案没写、需要我自己按
server.js 实际代码位置判定的，标"（推断）"。目标文件名同理：方案给了具体文件名的照抄
（`cli-common.js`/`resume-store.js`/`agent-runs.js`/`local-claude.js`/`local-gpt.js`/
`engawa-client.js`/`social-fetch.js`/`doctor-registry.js`/`kernel.js`），其余 Phase 1–2
条目只给了功能名没给文件名，本表按功能名拟了一个 `server/xxx.js`，标"（拟名，方案未定）"。

## 总数核对

对 `tests/` 下所有文件（不限 `.test.js`）粗粒度 grep 字符串 `server.js`，命中 **26 个文件**，
与方案摘要里"26 个测试文件正则断言 server.js 源码文本"的数字**吻合**。
但逐个打开后发现，这 26 个文件里真正"读 server.js 源码做正则/字符串断言"的只是一部分，
其余是别的读法，混在一起数出来的：

| 类别 | 文件数 | 文件 |
|---|---|---|
| 真·源码断言（readFileSync + 正则/字符串，含 vm 抽段执行） | **14** | agent-run-resume / band-diagnostics / cloud-profile-retry / code-workbench / engawa / ipa-lookup / local-claude-resume / local-gpt-memory / local-gpt-proxy / music-lyrics / social / version-consistency / video（均 `.test.js`）+ 下方"特殊读法"里的 fault-inject-restore.test.js（读 server.js 只为构造/校验备份，不断言其内容） |
| 冒烟脚本：真 `spawn(node, ['server.js'])` 起服务再打 HTTP，不读源码文本 | 7 | browser-engawa.js / browser-sticker-cloud-warn.js / browser-ludo.js / browser-music-lyrics.js / browser-tombstone.js / browser-multiselect.js / browser-chat-peek.js（后两个提到 server.js 只是"先手动起服务"的跑法说明，不 spawn） |
| 故障注入辅助（非 `.test.js`，不进 `node --test`） | 1 | fault-inject.js —— `CASES_5`（约 20 条）以 `file: S`（`S = server.js`）为锚点原地改写又改回，是**除测试断言外最大的迁移负担**，见下方"特殊读法清单" |
| 误检出（字符串命中但不构成"读 server.js 内容"的断言） | 2 | origin-guard.test.js（只在注释里提了一句"server.js 用的"，实际读的是 `origin-guard.js` 自己）；pack-ignore.test.js（把 `/server.js` 当一个**路径字符串样本**去测打包 ignore 规则会不会误伤它，从没 `readFileSync` server.js 本身） |
| 说明性提及（脚本注释里写"先跑 GRANCYAN_PORT=3099 node server.js"） | 1 | measure-help-open.js |

合计 14+8+1+2+1 = 26，与总数对上。**真正需要在拆分时逐条搬家的，是前两类共 22 个
（14 个源码断言 + 8 个 spawn 冒烟——冒烟测试不用改断言，但要注意 spawn 的仍是
server.js 这一个入口，拆分不影响它们，只在此提醒"别漏了它们也要跑一遍"）。**

另外确认一个和方案文字对不上的地方：方案 Phase 1 第 5 条写"AA 桌面偷看（⚠️ chat-peek
测试用 vm 从源码抽段跑…）"。实际查了 `tests/chat-peek.test.js` 和
`tests/chat-peek-failclosed.test.js`——这两个测试测的是**翻看别的对话**功能
（`js/28-chat-peek.js`，前端），跟 server.js 里 line 4567 那个**偷看屏幕/截图**功能
（AA 分区）完全是两回事，只是中文名字都带"看"字。这两个 chat-peek 测试完全不碰
server.js（已用 grep 核实，26 个命中里没有它们）。也就是说：
**AA 桌面偷看目前在 tests/ 里没有任何针对 server.js 那段代码的正则或 vm 抽段测试**，
Phase 1 第 5 步"迁断言"这一步在 AA 身上其实无断言可迁——搬的时候只能靠 mount 守护
（真实 HTTP 命中 `/api/screen-peek` 之类的路由）兜底，这点需要维护者/施工者知道，
不是我漏查了。

---

## 主表

| 测试文件 | 断言组描述 | 盯的分区 | 拆分后目标文件 | 风险标注 |
|---|---|---|---|---|
| agent-run-resume.test.js ⚠️正在被改 | 断线不丢活：detachedAt/重挂/停止/清单四个路由、事件全走 send()、孤儿回收、产物白名单、509→409 设备号顶号、硬上限、销账时机（8 大段，约 60+ 条） | E 电脑操控/agent-run（大部分）；其中 `claudeCli` 切片专挑 `/api/local-claude`~`/api/local-gpt` 之间那段，属于 F | E→`server/local-ai/agent-runs.js`；F→`server/local-ai/local-claude.js` | ⚠️ 跨边界：本文件几乎每条断言都在同一个 `server` 全文字符串上跑正则，E 和 F 的断言混在一个文件里没有物理分隔，迁移时要把"纯 E（_agentRuns/产物/孤儿回收/realpathSafe）"和"E+F 混合（proc.stdout 事件循环那一段、claudeCli 切片）"分开建两个 `srcOf()`；`claudeCli` 变量本身就是手工切出的 F 段落，边界字符串 `"app.post('/api/local-claude'"`/`"app.post('/api/local-gpt'"` 拆分后要么继续在合并后的全文里查（用 `srcOf` 拼接），要么改成只在 `local-claude.js` 一个文件里查（去掉终止 marker） |
| band-diagnostics.test.js | 六种手环故障各自留 stage/msg/hint、状态查询顺序、warn 与 fail 分离、接口透传、前端展示 | S 手环（自封） | `server/band.js`（拟名，方案未定；Phase 1.3 只给了功能名） | 低风险，S 段自封，Phase 1 步骤 3 已规划为第一个"doctor 注册制实战"对象——doctor 提供器要随迁 |
| cloud-profile-retry.test.js | 前端 cloudRetry/cloudError（js/01-core.js，vm 抽段，不涉及 server.js） + server 端 `/api/cloud-profile` GET/POST 的 `validateStatus`/状态透传 | I 云同步（cloud-profile 部分） | `server/cloud-sync.js`（拟名；方案原文"I 云同步"包含 cloud-profile + cloud-chats + cloud-file） | 低风险，`server.slice(indexOf("app.get('/api/cloud-profile'"), indexOf('// 云端文件中转'))` 是自封切片，边界注释"// 云端文件中转"本身就是 cloud-chats/cloud-file 的分界——三者若真的分成一个文件（I 整体搬），此切片继续有效；若 cloud-profile 单独搬走而 cloud-chats/file 留守，终止 marker 会失效，需要注意 |
| code-workbench.test.js | 3 条散落在 server.js 里的断言：① `taskkill.exe` 杀子进程、② GPT 侧"等代理探测期间客户端已取消"、③ `agentImageFiles`/`materializeImages` 图片素材化 | ①行877 = E（agent-runs.js，orphan/kill 逻辑）；②行1713 = G（local-gpt.js）；③行1256 = F（local-claude.js） | E→`agent-runs.js`；F→`local-claude.js`；G→`local-gpt.js` | 一个测试文件、三条独立断言分别命中 E/F/G 三个不同目标文件——不是单条正则跨边界（每条本身只在自己的区内），但迁移时这一个文件要同时改三处 `srcOf()` 调用，容易漏改其中一条 |
| engawa.test.js | 篇幅最大，内容涵盖：贴纸/说话块回填格式、`carryHasResult` 跨文件契约（server.js 与 js/05-prompts-api.js）、全角冒号、推荐流是谁的（server 侧接线 3 条 + social-browser.js 2 条）、`engawaParseSse`/`engawaSessionDead` 两个函数各自用**函数体正则**（非 marker-to-marker）抠出来跑、ENOENT 分岔、`xhsFeed` 整个异步函数抠出来跑（约 597 行处）、收件箱 HTML 展示 | 绝大部分 Y+Z（engawa 客户端 + 小红书/B站抓取），一处 `carryHasResult` 契约测试命中 D/cli-common 的 `CARRY_RESULT_RE`/`carryHasResult` | Y→`server/engawa-client.js`；Z→`server/social-fetch.js`；`carryHasResult` 那一处→`cli-common.js`（推断，与 local-claude-resume.test.js 的段落有重叠，见下） | ⚠️ 两处需要留意：(1) 行 163-179 用 `srv.match(/const CARRY_RESULT_RE = [\s\S]*?\nfunction carryHasResult\(text\) \{[^\n]*\n/)` 抠 `carryHasResult`，与 `local-claude-resume.test.js` 用 `'const CARRY_RESULT_RE'→'function sanitizeText'` 抠的是**同一段源码的不同边界**——两个测试各自独立定义了对同一段代码的抽取范围，搬到新文件后两处都要跟着改，且如果新文件里这段代码的相对位置变了（比如 `sanitizeText` 挪到了别处），engawa.test.js 这条不受影响但 local-claude-resume.test.js 那条会抠空；(2) 行 108 `allowed: [...ENGAWA_TOOLS, ...SOCIAL_TOOLS]` 那条断言正则同时含 `ENGAWA_TOOLS`（Y 所有）和 `SOCIAL_TOOLS`（Z 所有）两个标识符（这条实际在 social.test.js 里，见下一行，本行是笔误提醒—— engawa.test.js 本身没有这条，只是提醒两个文件常被一起改） |
| ipa-lookup.test.js | `ipaLookupForm`~`fetchIpaDe` 之间整段 vm 抽出跑（词形处理/出网 mock），另外对 `/api/ipa` 路由切片单独断言缓存写入/版本号逻辑 | P 音标 IPA（自封） | `server/ipa.js`（拟名） | 低风险但**读法特殊**：`from = SRC.indexOf('function ipaLookupForm')`，`to = SRC.indexOf("app.get('/api/ipa'")`——vm 段和路由段虽然一起在 P 区，但两者的分界 marker 本身就是"定义结束/路由开始"，只要 P 整体搬成一个文件，两段还挨着，marker 继续有效；若 P 被进一步拆成"纯函数" + "路由"两个文件，这条会直接抠空 |
| local-claude-resume.test.js | 会话续传的核心机制：vm 抽段①`const VOL_BLOCK_RE`→`function rememberSession`（哈希/剥壳/sysKey），vm 抽段②`const CARRY_RESULT_RE`→`function sanitizeText`（GAZE/SAY 结果补发），另有大量直接对 `server` 全文的正则断言，横跨 Claude 和 GPT 两条 resume 路径 | D/resume-store 边界（推断） + F（local-claude）+ G（local-gpt）| `resume-store.js`（`_resumeSessions`/`rememberSession`/`consumeResumeSession`/`loadResumeSessions`/`saveResumeSessions`，均在 361-448 行，方案明确点名）；`cli-common.js`（D 段"prompt 拼装、carry-over"，`carryOverBlock`/`makeCarryTagWatcher` 在 483-523 行，方案点名"D 段…carry-over"）；`local-claude.js`（F，调用点）；`local-gpt.js`（G，调用点） | ⚠️⚠️ 本文件是全表**风险最高**的一个，见下方"跨边界断言清单"逐条列出——两段 vm 抽段的起止 marker 本身就横跨"函数定义所在的未来文件"边界，且至少 2 条正则断言（`&&` 拼接 Claude/GPT 两套正则、以及 `.match(/g)` 统计跨文件出现次数 ≥4）显式耦合了 F 和 G |
| local-gpt-memory.test.js | GPT CLI 启动参数（禁插件/shell snapshot）、思考摘要请求头、Plus 登录优先走官方 Codex、`/api/gpt-ratelimit` 额度接口、非 JSON stdout 处理、工具事件仅电脑操控模式输出 | 主体 G（local-gpt）；`/api/gpt-ratelimit` 那一条命中 AB（限速查询） | G→`local-gpt.js`；AB→`server/rate-limit.js`（拟名，方案 Phase 2 明确列了 AB 但未给文件名） | 一个文件同时命中 G 和 AB 两个目标文件（各自的断言组是独立的 `test()` 调用，不是同一条正则跨边界），迁移时按 G/AB 拆成两处 `srcOf()` |
| local-gpt-proxy.test.js | 代理端口探测复用、代理环境变量注入 Codex 子进程 | kernel（`outboundProxyPort` 定义，行50-66，方案点名 kernel.js） + G（调用点 `gptProxyPort`/env 注入） | kernel→`server/kernel.js`；G→`local-gpt.js` | ⚠️ 跨边界：4 条断言全部对同一个 `source` 全文做 `assert.match`，其中 `outboundProxyPort` 的**定义**属于 kernel.js，`gptProxyPort`/`env[key] = proxyUrl` 是 G 里的**调用点**，虽然是 4 条独立 `assert.match` 不是单条正则揉在一起，但整个文件的 4 条断言拆开后要分别指向 kernel.js 和 local-gpt.js 两个 `srcOf()` |
| music-lyrics.test.js | K 音乐相关端点参数与返回字段 | K 音乐（自封） | `server/music.js`（拟名） | 低风险，Phase 1 步骤 1 已规划为第一个搬家对象（"真端点测试"） |
| social.test.js ⚠️正在被改 | 大部分断言在 social-browser.js（不深究，另一会话正在改）；命中 server.js 的只有 6 条：`SOCIAL_TOOLS` 定义、`/api/engawa` 分流拦截、`allowed` 词表、代理开关、"推荐流解析出 0 条"、"挂载失败不影响其它功能" | Z（SOCIAL_TOOLS 自身）+ Y（ENGAWA_TOOLS，出现在同一条断言里）+ AF（挂载失败兜底，推断） | Z→`social-fetch.js`；Y→`engawa-client.js`；AF 挂载胶水大概率留在 server.js（"/api/engawa 薄路由…只做分流"，方案原文） | ⚠️ 跨边界：第 108 行 `/allowed: \[\.\.\.ENGAWA_TOOLS, \.\.\.SOCIAL_TOOLS\]/` 单条正则同时含 Y 的 `ENGAWA_TOOLS` 和 Z 的 `SOCIAL_TOOLS` 两个标识符，方案 Phase 4 明确说这两个未来"各归各家"——这条断言现在验证的正是"两家汇合处那一行词表"，属于典型的"调用/汇总端跨两个分区"，需要在 `/api/engawa` 薄路由（若留在 server.js）里保留一条组合断言，同时在 Y、Z 各自文件里各补一条"自己的 TOOLS 集合内容对"的断言 |
| version-consistency.test.js | 主页文件名相关：`res.sendFile(...index.html...)`（根路由）+ `exists(path.join(ROOT, 'index.html'))`（doctor 自检项 1） | A 中间件段（根路由，行124，方案明确"server.js 保留 A 段"） + AD runDoctor（doctor 自检项，行5074） | A→继续留在 server.js；AD→Phase 0.5 改造成 `server/doctor-registry.js`，但这一条具体检查项的**代码位置**尚未定（是留在 server.js 内联注册，还是整条挪进 registry） | ⚠️ 中等风险：两条断言目前都在 server.js 全文里，且都不搬家（A 明确不动，AD 只改"取状态的接口"不改"检查内容"——Phase 0.5 原话"检查内容一字不改，只改取状态的接口"）。理论上这条测试**行为上应保持全绿**，但 Phase 0.5 doctor 注册制改造完成后，这条 `exists(path.join(ROOT, 'index.html'))` 字符串字面量所在的**代码形状**可能变化（比如从直接调用变成 `registry.push({ check: () => exists(...) })`），届时若形状变了但内容没变，这条正则要跟着微调，不算"迁移"但算"Phase 0.5 影响半径"里要盯的一条 |
| video.test.js | 前端纯函数（js/30-video.js，vm 抽段，不涉及 server.js）+ server 端 `/api/video-frames` ffmpeg 兜底路由整段行为测试（含真 handler 抠出来注入假 fs/spawn 跑清理时序） | N+O 视频抽帧/图片代理（自封） | `server/video.js`（拟名；N/O 是否分成两个文件方案未定） | 低风险，切片 `server.slice(indexOf("app.post('/api/video-frames'"), indexOf("app.post('/api/sticker-save-url'"))` 自封，但**终止 marker 是下一个路由**（属于 H+Q 表情包区），若 H+Q 先于 N+O 搬走、两区顺序对调，这个 indexOf 找不到 `/api/sticker-save-url'` 会直接切到文件尾——建议 Phase 1 第 4 步动手前把这条终止 marker 改成更靠近视频路由自身结尾的锚点 |

---

## 跨边界断言清单

以下是本次核查中确认"同一条正则/同一次匹配横跨两个未来会分家的文件"的断言，
拆分时必须按 Phase 0 第 3 步的 `srcOf(name)` 方案拆成两条分别检查，**不能靠拼接文件糊弄**
（方案原文明令禁止：拼接会制造运行时不存在的相邻关系）。

1. **local-gpt-proxy.test.js（4 条 `assert.match`，风格上各自独立但整体分属两家）**
   - `outboundProxyPort` 的**定义**（行50-66）属于未来的 `kernel.js`。
   - `gptProxyPort`/`env[key] = proxyUrl` 的**调用点**属于未来的 `local-gpt.js`。
   - 拆法：4 条断言里前 1 条（`async function outboundProxyPort()`）改查 `srcOf('kernel')`，
     后 3 条（`gptProxyPort`/环境变量数组/`env[key] = proxyUrl`）改查 `srcOf('local-gpt')`。

2. **local-claude-resume.test.js 的两处 vm 抽段（本表风险最高项）**
   - 抽段①`const VOL_BLOCK_RE` → `function rememberSession`（server.js 399-437 行）：
     `VOL_BLOCK_RE`/`stripVolatileBlock`/`transcriptHash`/`sysStableKey` 是纯哈希/剥壳工具函数，
     `loadResumeSessions`/`_resumeSessions`（361-369 行，在这段之前）与 `rememberSession`（438 行，
     段尾）已经是 `resume-store.js` 的地界（方案明确点名 `_resumeSessions` 单例进 resume-store.js）。
     这段代码现在挨在一起、marker 抽取一次搞定；一旦 `resume-store.js`（存储/落盘）和
     `cli-common.js`（哈希/剥壳等 prompt 工具，方案原文"D 段…prompt 拼装"）真的分成两个文件，
     这个 vm 段就得改成"分别从两个 `srcOf()` 读、各自 `vm.runInContext`、再用一个共享 sandbox
     桥接" —— 不能再用单一 `fromMarker/toMarker` 一把梭。
   - 抽段②`const CARRY_RESULT_RE` → `function sanitizeText`（483-523 行）：`carryOverBlock`/
     `makeCarryTagWatcher` 落在方案点名的 `cli-common.js`（"carry-over"三个字方案原文写了）。
     这段本身不跨文件（前提是 D 段整体搬进 cli-common.js 不再拆），但**与 engawa.test.js
     行 166 那条独立的 `CARRY_RESULT_RE`→`carryHasResult` 正则**是对同一段源码的两套不同
     边界抽取——两个测试文件都要跟着 D 段搬家同步改，且互相之间没有共享 `srcOf` 调用，
     容易改一个忘另一个。
   - 直接正则断言（不经 vm，行182-190）：
     - `t('Claude 和 GPT 都从同一份落盘索引恢复', /_claudeSessions/.test(server) && /_gptSessions/.test(server))`
       —— 两个变量都在 `resume-store.js` 内（同一份 `_resumeSessions` 的两个子表），**不跨**，
       只需整体把 `server` 换成 `srcOf('resume-store')`。
     - `t('索引不落 system prompt / persona 正文', /JSON\.stringify\(\{...claude...gpt.../.test(server) && !/rememberSession\(transcriptHash\(chatMsgs\), \{[\s\S]{0,180}sysP:/.test(server))`
       —— **真跨**：前半（序列化落盘格式）在 `resume-store.js`，后半
       （`rememberSession(transcriptHash(chatMsgs), {…sysP…})` 调用点）在 `local-claude.js`（F）。
       必须拆成两条：一条查 `srcOf('resume-store')` 的序列化格式，一条查 `srcOf('local-claude')`
       里没有把 `sysP` 传进 `rememberSession`。
     - `t('消费或淘汰索引后同步落盘，重启不会复活旧会话', (server.match(/consumeResumeSession\(_(?:claude|gpt)Sessions, key, e\)/g) || []).length >= 4)`
       —— **真跨且是聚合计数**：`consumeResumeSession(_claudeSessions...)` 调用点在
       `local-claude.js`，`consumeResumeSession(_gptSessions...)` 调用点在 `local-gpt.js`，
       现在要求整个 server.js 里两种调用合计 ≥4 次。拆分后必须改成
       `(srcOf('local-claude').match(/consumeResumeSession\(_claudeSessions, key, e\)/g)||[]).length + (srcOf('local-gpt').match(/consumeResumeSession\(_gptSessions, key, e\)/g)||[]).length >= 4`
       ——这正是 Phase 0 第 3 步"一个逻辑名映射多个来源文件"要解决的典型案例，
       `srcOf(name)` 的 helper 设计时应该把这种"跨文件求和"也纳入考虑，不只是"跨文件选一个"。

3. **social.test.js 行108**：`/allowed: \[\.\.\.ENGAWA_TOOLS, \.\.\.SOCIAL_TOOLS\]/`
   同时含 Y（`engawa-client.js` 的 `ENGAWA_TOOLS`）和 Z（`social-fetch.js` 的 `SOCIAL_TOOLS`）。
   拆法：若 `/api/engawa` 薄路由留在 server.js（方案 Phase 4 原文"薄路由 require 两边只做分流"），
   这一整行拼接词表大概率也留在 server.js 里，那么这条断言其实**不用拆**，继续查 server.js 全文
   即可；但要另外在 Y、Z 各自文件里各补一条"自己的 TOOLS 集合定义还在"的断言，防止将来
   有人把某一家的 TOOLS 改了名、这条组合断言却因为死记着旧写法而假绿（比如把
   `ENGAWA_TOOLS` 改成 `ENGAWA_TOOL_NAMES` 之后，这条正则一样会因为 `SOCIAL_TOOLS` 那半
   还在而继续通过，实际上 Y 那半已经查不到了但没人发现）。

---

## 特殊读法清单

不是简单 `fs.readFileSync(server.js) + assert.match` 的读法，逐个说明迁移时要注意什么。

1. **local-claude-resume.test.js —— vm 双段抽取**（详见上方"跨边界断言清单"第2条）。
   `loadSeg(fromMarker, toMarker, extraCtx)` 这个 helper 本身写得很通用（接受额外 context），
   拆分后可以复用，但两个 marker 对必须分别改成指向各自新文件里的新 marker，且如果两段
   分家到不同文件，`loadSeg` 要么改成接受"文件内容"参数而不是自己再读一次 server.js，
   要么每个文件各调一次（推荐后者，改动面小）。

2. **engawa.test.js —— 三种不同的抽取写法混用**：
   - marker-to-marker 但只取到"下一行"（`carryHasResult` 那条，`[^\n]*\n` 只吃一行，
     实际上抠出来的可能是不完整的函数体——需要确认这个"半吊子"抽取配合它自己的
     `vm.runInContext(seg[0] + '\nthis.f = carryHasResult;', box)` 为什么能跑通，
     大概率是因为 `carryHasResult` 函数体本身就写在一行内，迁移时如果这个函数被
     reformat 成多行，这条会直接抠空，需要留意）。
   - 单函数体正则抓取（`engawaParseSse`/`engawaSessionDead`，`/function xxx\(...\)[\s\S]*?\n\}/`）：
     这种写法比 marker-to-marker 更抗"搬家"——只要函数整体不拆散，搬到哪个文件都能抠到，
     风险低于 marker 那种。
   - 整个异步函数体抓取后当场跑（`xhsFeed`，`/async function xhsFeed\(limit\) \{[\s\S]*?\n\}/`）：
     同上，风险较低，但 `xhsFeed` 内部 `require: () => ({ xhsExploreFeeds: async () => browserResult })`
     这种手写桩要求 `xhsFeed` 函数体里对 `require('./social-browser')` 之类的调用写法保持稳定
     （xhsFeed 若从 server.js 搬进 `social-fetch.js`，对 `require` 路径没有变化就不影响此桩，
     但如果搬家时顺手把 `require` 调用换成了顶层 `import`/预先注入的依赖，这个桩会失效）。

3. **ipa-lookup.test.js —— vm 单段抽取 + 独立路由切片**：`ipaLookupForm`~`fetchIpaDe` 送进 vm，
   `/api/ipa` 路由单独 `SRC.slice()` 出来做纯字符串正则（不跑，只看形状）。两段目前紧挨着，
   P 区整体搬家不受影响；如果两段分家（一个纯函数文件、一个路由文件），要拆成两次
   `srcOf()` 调用。

4. **cloud-profile-retry.test.js / band-diagnostics.test.js / music-lyrics.test.js / video.test.js**：
   都是"字符串 `.indexOf`/`.slice` 切出自己关心的一段再做正则"，没有 vm 执行，风险最低——
   只要各自的分区整体搬进同一个新文件，切片的起止 marker 大概率继续有效（除了 video.test.js
   那条已经点名的"终止 marker 依赖下一个分区"的例外，见主表）。

5. **fault-inject-restore.test.js —— 读 server.js 只为基础设施自检，不断言其内容**：
   `FILES` 数组（`social-browser.js`/`js/40-engawa.js`/`origin-guard.js`/`server.js`/
   `js/05-prompts-api.js`）是"故障注入器要能完整备份/还原的文件清单"，测试本身验的是
   "备份-还原-自愈"这套机制对**任意**一个受害文件成立（受害者选的是 `origin-guard.js`，
   `server.js` 只是陪跑凑数）。**这个测试不需要因为 server.js 拆分而修改**——除非
   `fault-inject.js` 自己的 `FILES` 常量因为下面第 6 条的原因要改（改了 `FILES` 的话，
   这个测试的 `FILES` 常量抄的是同一份字面量，要同步改）。

6. **fault-inject.js（非 `.test.js`，不进 `node --test`，要靠人手动跑）—— 最大的隐性迁移负担**：
   `CASES_5`（约 20 条，2026-08-24 那批 GAZE/SAY 补发相关注入）全部以
   `file: S`（`S = path.join(ROOT, 'server.js')`）为锚点，逐条 `from`→`to` 原地改写
   server.js 源码再改回来，锚点覆盖 `carryOverBlock`/`CARRY_TAG_RE`/`carryWatch.feed`/
   `gptCarryWatch`/`meMatch`/`resumeEntry.carry` 等——**正是上面"local-claude-resume 的
   vm 抽段"所覆盖的同一批代码**，D+E+F+G 一旦搬家，这 20 条注入点的 `file: S` 必须逐条
   改成指向正确的新文件（`cli-common.js`/`local-claude.js`/`local-gpt.js` 视具体锚点而定）。
   这个脚本**不是自动测试**（跑法注释写着"不是 .test.js，不会被 node --test 带上"），
   Phase 3 D+E+F+G 搬家那一步收尾时必须有人手动跑一遍
   `node tests/fault-inject.js`，否则锚点失配会安静地打印"⚠ 注入点没匹配上，跳过"、
   `bad++`，最终報 `❌ 有 N 条没守住`——不是静默失败，但**只有手动跑才会暴露**，
   建议 Phase 3 收尾清单里显式加一条"跑 fault-inject.js 且 bad === 0"。
   另外 `CASES_1`~`CASES_4`、`CASES_6` 的 `file` 都是 `social-browser.js`/`origin-guard.js`
   （F/O 变量），不涉及 server.js，不受这次拆分影响。

---

## 附：8 个 browser-*.js 冒烟脚本（spawn 真进程，不读源码文本）

`browser-engawa.js`、`browser-ludo.js` 用 `spawn(process.execPath, ['server.js'], …)`
真起一个 server 再用 CDP/HTTP 打；`browser-sticker-cloud-warn.js`、`browser-music-lyrics.js`、
`browser-tombstone.js`、`browser-multiselect.js`、`browser-chat-peek.js`
在注释里写"先手动 `GRANCYAN_PORT=3099 node server.js`，再跑这个脚本"（不是脚本自己 spawn，
是要求人先手动起）。这 7 个都不读 server.js 的源码文本、不做正则断言，**server.js 拆分对它们
没有断言层面的影响**——只要 `node server.js` 拆分后依然能被启动、依然监听同一端口、路由
路径不变（方案硬约束"不改路由路径"），这些冒烟脚本原样能跑。真正的风险在 mount 遗漏
（某个分区忘了在 server.js 里 `require` 并 `mount()`），那属于方案里 Phase 0.5 "mount 守护测试"
要挡的范畴，不是这张断言迁移表要管的。
