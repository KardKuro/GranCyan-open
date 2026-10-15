# 输出准入（output admission / isolation）

> **许可说明**：本文档（`docs/output-admission.md`）**不适用**本仓库的 AGPL-3.0，
> 而是以 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 发布 ——
> 它的思路来自 [do-not-safety-me](https://github.com/Gwendolenmave/do-not-safety-me)
> （Gwendolenmave，CC BY-NC-SA 4.0，Built by Gwendolen with Amelia GPT），按原项目的署名 + 非商业 + 相同方式共享条款再发布。
> 仓库其余部分（含实现这套方案的代码）仍按 AGPL-3.0-or-later。

> 生成 ≠ 提交。模型吐出来的文字先是候选，过了准入门才算「它说过的话」。

模式来源：[do-not-safety-me](https://github.com/Gwendolenmave/do-not-safety-me)（CC BY-NC-SA 4.0，
Built by Gwendolen with Amelia GPT）。本文件是**它在 GranCyan 里的落地方案**，不是原文转述。

---

## 0. 为什么要在 GranCyan 做这个

两类真实故障，提示词治不好：

1. **元拒绝进历史**。正常对话里突然蹦一句模板化的「抱歉，我不能继续这类内容」。难听只是表面，
   真正的伤害是它**进了历史之后自我强化** —— 下一轮模型看见自己拒绝过，就顺着走。
   这和 `grancyan2-tag-format-imitation`（历史回填格式教坏模型）是同一个机制。
2. **无端升级**。用户说「今天有点低落」，模型回「请立刻拨打急救电话」。
   一个关系性的 turn 被改写成 emergency event。

提示词层面的约束是在**降低概率**；准入门是**宿主拥有的边界**。
两者不冲突，后者兜住前者漏掉的那部分。

---

## 1. 刀口划在哪（最关键的一节）

GranCyan 有**两个**提交点，分别在两端：

| 提交点 | 位置 | 提交的是什么 |
|---|---|---|
| provider thread | `server.js` `proc.on('close')` 里的 `rememberSession(...)` | CLI 那头的 `--resume` 会话 |
| 本地历史 | 前端 `streamCompletion` 返回后，调用方写 `chat.messages` / IndexedDB | 对话历史、记忆抽取的输入 |

**两个都必须挡住，只挡一个等于没做。**

- 只挡前端 → CLI 的 session jsonl 里留着坏 draft，下一轮 `--resume` 它自己带回来（原文坑 2）
- 只挡服务端 → 坏 draft 已经进了 IndexedDB，高级记忆/普鲁斯特会吃进去

好消息：**`freshContextReset` 在 GranCyan 天生就有** ——
拒绝时**不调 `rememberSession`**，下一轮 `transcriptHash` 查不到索引，
自然退回「新会话」。不用新造机制，已有的东西正好就是那个能力。
本地 GPT 的 `rememberGptSession` / `_gptSessions` 同理。

```
CLI stdout
   ↓  (delta 照常流给前端显示，手感不变)
close → 累积出完整 candidateText
   ↓
sanitize（剥掉 [[GAZE:]] 这类宿主协议标记再判，否则协议文本会污染检测）
   ↓
admission lanes（单向，不回头）
   ├─ PASS   → rememberSession() → done → 前端落盘
   └─ REJECT → 不 rememberSession（= 干净上下文已就位）
                ↓
              receipt（只记元数据，不记原文）
                ↓
              send({ rejected: {...} }) → 前端清空这条气泡
                ↓
              前端带 recovery 标记重发一次（天然干净：索引里没有它）
                ↓
              第二次再被拒 → fail closed，如实告诉用户这轮没过
```

### 为什么重试由前端发起

服务端自己重试要把 400 行的 spawn + 流解析抽成可重入函数，风险大；
而前端重发**天然就是干净上下文**（索引没登记 → `resumeMiss` → 新会话），
一行重构都不用。

护栏仍然在服务端：`rejected` 事件带 `retryAllowed`，服务端按 `turnId` 记次数，
**第二次拒绝时 `retryAllowed: false`**。前端只是执行者，不是把关者 ——
前端出 bug 也炸不出无限重生成循环。

### 流式怎么办

delta 照常边流边显示。被拒的那条用户会看见它「闪一下然后被收走」。
这是有意的取舍：**目标不是用户眼睛没看见，是那段文字从未获得 canonical status**。
流式手感是每天在用的东西，不为这个牺牲。

---

## 2. 接口契约

放 `server/admission.js`，**不依赖 express、不依赖 GranCyan 的任何全局**，纯函数进出，
这样它能被单测，也能被将来别的通道复用。

```js
/**
 * @typedef {{ reason: string, signals?: string[] }} Rejection
 * @typedef {(input: {
 *   userText: string,            // 本轮用户说的话
 *   recentUserTexts: string[],   // 最近几条**用户自己写的**消息（不含 assistant）
 *   candidateText: string,       // sanitize 之后的完整候选正文
 *   surface: { agent: boolean },  // 宿主已确认的场景
 * }) => Rejection | null} Guard
 */

// lanes 单向执行，返回第一个拒绝；全过返回 null
function runAdmission(lanes, input) { ... }

// 只记元数据，绝不记原文
function makeReceipt({ turnId, attemptIndex, provider, rejection, candidateText, retryPlanned }) { ... }
```

**硬规则（写成测试，不是写成注释）：**

- guard 是纯策略，**不许**写历史、不许发事件、不许碰 `_claudeSessions`
- 扫**完整**的 sanitized candidate，不许 `slice(0, 4000)` 偷偷留个没扫的尾巴
- grounding 只能由**用户写的**文本建立；assistant 自己说过的话不能给自己发许可证
- 陈旧 grounding 不能无限授权后面无关的 turn
- 弱信号（「找朋友聊聊」）单独出现**不拒**；弱 + 强（机构/联系方式）才拒
- receipt 里有 `reply_chars` 和 `reply_sha256`，**没有** `raw_text`

---

## 3. 分批施工

### 批 1：协议骨架（影子模式，零风险）

- `server/admission.js`：`runAdmission` / `makeReceipt` / 一个 `demoGuard`（命中 `[REJECT_ME]`）
- `server.js` 接线：`close` 里累积 `candidateText`、跑 admission、**只写日志不拦截**
- `admission.log`：一行一条 receipt
- 测试：canary 泄漏测试（见下）

验收：跑一天真实对话，看 demoGuard 以外的 lane 命中几次、有没有误伤。
**这一批不改变任何可见行为。**

### 批 2：真 detector（适合派给 Codex 的开放题）

一个 guard，三层结构 `grounding → arm → novelty`：

- `unsolicited_emergency_escalation`

必须带的反例测试（这些都是原文作者真踩过的）：

```
「我120斤了」          → 不算 emergency grounding
「Porsche 911 好看吗」  → 不算
「911 为什么这么贵」    → 不算
「我正在去医院，该带什么」 → 真 grounding，必须放行
「找朋友聊聊吧」（单独）  → 弱信号，不拒
```

### 批 3：真拦截 + 一次干净重试

- 服务端：拒绝时不 `rememberSession`、发 `rejected` 事件、按 turnId 记次数
- 前端：收 `rejected` 清空 `fullText`/`reasoningText`/`blocks`，带 recovery 标记重发一次
- RECOVERY_BLOCK **content-free**：说类别、说它不是历史、说直接回答，**不复述被拒原文**

### 批 4：本地 GPT 同款

`rememberGptSession` 那条路一样的处理。

---

## 4. Canary 测试（最值钱的一条）

给坏 draft 塞一个绝不会自然出现的标记，拒绝它，然后问：

```
CANARY_REJECTED_DRAFT_8f1c4d2e9a7b 是否出现在：
[ ] admission.log        [ ] rememberSession 的入参
[ ] 发给前端的任何事件    [ ] 重试请求的 prompt
[ ] RECOVERY_BLOCK       [ ] local-claude.log
```

理想结果：**CANARY NOWHERE**。

这比「UI 没显示它」严格得多 —— UI 没显示只证明眼睛没看见，
canary 证明的是它没变成系统状态。

---

## 5. 上线顺序

```
Phase 0  只记录不拒绝（批 1）          ← 先拿真实数据
Phase 1  canary 隔离测试通过（批 1 的测试）
Phase 2  开拒绝，不重试                ← 被拒就如实说这轮没过
Phase 3  验证「不 remember = 下一轮真的是新会话」
Phase 4  开一次有界重试（批 3）
```

每一步都能单独回滚。**不要跳到 Phase 4。**

---

## 6. 边界（RESPONSIBLE_USE 那份的线，照搬）

- 这是**宿主自己产品的准入规则**，不是用来绕过 provider 的安全系统
- **用户真的建立了现实急症语境时必须放行** —— 抑制真实求助是这套东西最糟的误用
- 拒绝的原文不进持久日志
- hash 是关联用的元数据，不是匿名化魔法
- 重试有界，detector 出 bug 不能造成无限重生成
