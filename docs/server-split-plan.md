# server.js 拆分方案（2026-08-26 · v2，已吸收 Codex 第一轮审查）

目标：server.js 瘦成**装配层**——只剩中间件、装配顺序、监听与兜底。零行为变更：拆的是文件边界，不是逻辑。
行数不作硬验收指标（v1 写 <500 行经审查核算不可达，Q/T/A/C/AC/AE/AF/AG 留守就已 ~555 行）；
验收看的是「每步稳定态」四件套：全套测试绿 + `node server.js` 能起 + mount 守护通过 + doctor 输出与基线一致。

## 侦察结论摘要

- 33 个逻辑分区（A–AG），关键簇：
  - **D+E+F+G（250–1921，约 1670 行）**：本地 Claude/GPT CLI 通道 + agent-run，模块级闭包深度共享
    `_agentRuns`、`resume-sessions.json` 单例、prompt 拼装工具簇。
  - **Y+Z（3972–4591）**：engawa MCP 客户端与小红书/B站直连抓取，共享 `/api/engawa` 一个端点。
  - **AD runDoctor（5065–5163）**：横切读 S/W/X/Y 私有状态；检查了 CLAUDE_EXE 却没检查 GPT exe（不对称）。
- 测试形态（已按 docs/assertion-migration-map.md 精确化）：无测试 `require('../server')`；
  **14 个 `*.test.js` 真的对 server.js 做源码正则断言**（迁移主对象）；8 个 browser-\* 冒烟真的
  `spawn(node,['server.js'])`（不受拆分影响，只要入口不变）；
  **`tests/fault-inject.js` 单列**：它在 server.js 源码文本里打约 20 个锚点做故障注入，
  不跑在 `node --test` 里——每挪一块必须人工核对它的锚点跟着搬，这是最大的隐性迁移成本。
- 裸奔分区：B、C、H、I 的 cloud-chats/file、J、L、M、Q、R、T、U、V、W、X、AB、AC/AD。

## 硬约束

1. server.js 保持入口身份，只瘦不换名。
2. 每挪一块，同步迁移对应源码正则断言的目标文件；红的测试就是「断言没跟上」的清单——
   但**正则断言不算运行时兜底**，运行时靠 mount 守护（见 Phase 0.5）。
3. 开工前先把当前未提交改动落地、跑出绿基线。工作区不干净不动手。
4. 可能有并发会话在改：逐文件 `git add`，一步一 commit，绝不整目录 add。
5. 改文件用 Edit 工具（保 CRLF），提交前 `git diff --stat -w` 复查。
6. **模块顶层零副作用**（Codex 阻断 #2）：抽出的模块顶层只允许定义，不读 env、不起定时器、
   不摸文件系统；所有初始化收进 `mount()`/`init()`，并在 server.js 里**原执行位置**调用。
   `.env` 由 A 段加载在先，任何模块把 env 缓存成常量都必须发生在 init 时而非 require 时。
   对 D、W、X、Y、resume-store 各配一条初始化时序测试。
7. **可变共享状态一律走 getter/稳定对象，禁止解构快照**（Codex 阻断 #3）：
   `outboundAgent` 本来就是函数、保持函数形态传递；`_proxyState` 等可变状态经
   `proxyRuntime` 稳定对象暴露。配测试：挂载完成后改变代理状态，已挂载路由必须看到新值。

## 形态

沿用项目已有的 mount 模式（social-browser / code-workbench / terminal 就是这么挂的）：

- 新目录 `server/`，每块一个文件，导出 `mount(app, deps)`；require 与 mount 都发生在原执行位置。
- server.js 保留：A 段中间件（顺序不动）、AC 双协议监听、AG 兜底、装配顺序本身。
- 共享内核 `server/kernel.js`：ROOT、proxyRuntime（含 outboundAgent）、PROXY_PORTS——
  遵守硬约束 7 的暴露方式。

## 分阶段

### Phase 0 — 准备（不动业务代码）
1. 落地未提交改动，全套 `tests/*.test.js` 跑绿，记基线；**存一份 doctor 输出作为基线对照物**。
2. 断言迁移表：grep 出 26 个正则断言测试各盯 server.js 哪一段，做成清单。
3. tests 加 helper `srcOf(name)`：**支持一个逻辑名映射多个来源文件**（Codex 建议 #10），
   跨「定义—调用」两端的断言拆成两条分别打两个文件，**禁止拼接文件跑跨边界正则**
   （拼接会制造运行时不存在的相邻关系，测试变绿保障变弱）。

### Phase 0.5 — 基础设施（动代码，但不搬任何业务块）（Codex 阻断 #1、#6）
1. **doctor 注册制改造先行**：`server/doctor-registry.js`，各分区的检查项改为注册进来，
   **检查内容一字不改**，只改取状态的接口。改完 doctor 输出必须与 Phase 0 基线逐行一致。
   此后每个分区搬迁时随身携带自己的检查提供器。
2. **mount 守护测试**：起真服务后，对每个已迁移模块至少命中一条真实 HTTP 路由
   （POST 路由必须带 JSON body 并断言 `req.body` 生效），外加重复挂载/漏挂载检查。
   从 Phase 1 第一步就开始跑，不等到最后。防「源码断言全绿但 mount 忘了调、生产 404」。

### Phase 1 — 有测试兜底的自封叶子
每步 = 挪块（含 doctor 提供器）→ 迁断言 → **核对 fault-inject.js 锚点** → mount 守护加一条
→ 全套测试 → commit。（fault-inject 不在 node --test 里，漏了不会红，只能靠这条流程卡住。）
模板规则（Codex 二轮定稿，样板见 server/music.js）：`mount()` 开头必须校验全部必需依赖，
漏传要在启动时就炸——挂载探针只走校验分支，逮不住漏传；单文件源码断言一律用
`readSingleSrc()`（多文件条目会当场炸，防静默取 `[0]`）。
三轮补充：函数形态的依赖用 `typeof !== 'function'` 校验（truthy 挡不住误传
`outboundAgent()` 的 Promise）；搬迁时 grep 一遍块内用户可见文案里的 `server.js`
字样，提示改到新文件名（band 踩过：故障提示让用户去改 server.js 里已搬走的常量）。

**欠账（三轮 Codex 建议 #3，Phase 5 前清）**：cloud 的 17 条测试只守到校验分支，
带合法凭据后的转发（URL/请求头/body/httpsAgent/状态码透传）零动态覆盖——
需给 axios/outboundAgent 注入记录型 stub，成功与非 2xx 路径各守一条。
1. K 音乐（自封，真端点测试）
2. P 音标 IPA
3. S 手环（doctor 注册制在这里第一次实战——它的检查项必须随迁，输出对基线）
4. N+O 视频抽帧 + 存图/图片代理
5. I 云同步（cloud-profile 有测试；顺手给 cloud-chats/cloud-file 补最小冒烟——管数据的裸奔最危险）

（v1 曾把 AA 桌面偷看排在这里，迁移表核实 chat-peek 系列测试测的是前端 `js/28-chat-peek.js`，
与 AA 无关——**AA 实际裸奔**，降级到 Phase 2。）

### Phase 2 — 裸奔叶子（先补最小测试，再挪）
B 搜索、J 图搜、L TTS、M STT、R 文档、**H+Q 表情包（列表+上传/删除并成一个 stickers 模块）**、
**T 私人记忆读取**、AB 限速查询、V 散步、**AA 桌面偷看（自 Phase 1 降级，实际无测试）**。
（H/Q/T 为 v2 补录，Codex 阻断 #5；AA 降级为迁移表核实结果。）
原则：挪之前每条至少补「路由通 + 一个参数校验分支」的最小测试。

**U brain-inbox 单列**：跨设备记忆同步，坏了 = 静默丢记忆。先补测试，测试没到位就不挪。

### Phase 3 — 大簇整体搬（绝不拆半）
D+E+F+G 一次性搬进 `server/local-ai/`：
- `cli-common.js`：D 段 exe 探测、日志、prompt 拼装、carry-over。
- `resume-store.js`：`_resumeSessions` 单例。验收条件写死（Codex 建议 #9）：
  **同一对象、同一 debounce timer、序列化时读取最新的 claude/gpt 两个子表、
  载入失败与退出行为与现状一字不差**；配一条 Claude/GPT 交错更新测试。
- `agent-runs.js`：E 段 `_agentRuns` + noteArtifact 工具簇 + 四个 agent-run 路由。
- `local-claude.js` / `local-gpt.js`：F/G 路由，显式依赖注入。
- **`claudeOnce` 归属开工前定**（Codex 阻断 #7）：它定义在 E/F 交界（server.js:1181），
  先画出它的完整依赖图（日志？exe 解析？运行态？），随真实依赖所有者迁移并只从那里
  唯一导出——AF 注入 social-browser 的必须是同一个活实例，禁止为解循环依赖复制第二份。
搬运铁律：`_agentRuns` 和它的读写方永远在同一次 commit 里到位。

### Phase 4 — 血统分家
- Y → `server/engawa-client.js`，**对外只暴露语义方法**（Codex 建议 #8）：
  `ensureReady()` / `callWithRetry()` / `getStatus()`，连接状态机留在 client 内部，
  禁止逐项导出 `_engawaSession/_engawaStarting` 这类可变字段（解构即快照，会拿旧值）。
- Z 的抓取 → `server/social-fetch.js`；`/api/engawa` 薄路由 require 两边只做分流，
  SOCIAL_TOOLS/ENGAWA_TOOLS 各归各家。
- `_xhsTokens` 归 social-fetch 导出活实例，AF 注入点改从那里拿。
- X 育儿室 → 独立小模块（doctor 提供器与 init 时序随迁，tick 定时器在 init 里起）。

### Phase 5 — 收尾核对
1. 对照断言迁移表清点：26 个测试全部指向新家，没有「为了绿而砍掉后半截断言」的（抽查）。
2. doctor 输出与 Phase 0 基线最后对一次。
3. ~~顺手补 GPT exe 检查~~ **移出本方案**（Codex 阻断 #4：这是行为变更，混进拆分会污染 bisect）。
   拆分全部完成后作为独立 feature 单独提交、单独验证。

## 止损点

每个 Phase 结束都可以永久停。最坏只做 Phase 0–1：server.js 瘦约 1200 行，
且断言迁移表 + doctor 注册制 + mount 守护三件基础设施已到手，后面任何时候续做不重付学费。

## 明确不做

- 不换框架、不改路由路径、不动 A 段中间件顺序、不合并「看起来重复」的逻辑
  （重构收敛引入回归是六轮互审实测过的头号来源）。
- C（chat-stream 限速队列）暂不挪：裸奔 + 主聊天路径，等它有测试再说。
- GPT exe doctor 检查：拆分期内不做（见 Phase 5.3）。

## 审查记录

- 2026-08-26 Codex（gpt-5.6-sol，medium）第一轮：7 阻断 + 3 建议，v2 全部吸收。
  唯一部分收的是阻断 #5 的行数指标——不凑数字，改为放弃行数作硬验收（理由见开头）。
- 第二轮复审待定：开工 Phase 0.5 前建议再过一次（届时连同 doctor-registry 的实际 diff 一起审更值）。
