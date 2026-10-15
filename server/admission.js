// 输出准入（output admission / isolation）—— 方案见 docs/output-admission.md
//
// 一句话：**生成 ≠ 提交**。模型吐出来的文字先是 candidate，过了这里才允许变成
// 「它说过的话」（= 进 rememberSession 的 CLI 会话 + 进前端历史 + 进记忆抽取）。
//
// 这个文件是**纯策略层**，故意不 require express、不碰 _claudeSessions、不发事件、
// 不写日志文件。理由有两条：
//   1. 能单测。判断逻辑埋在 400 行的路由回调里就一条测试都写不了（gemini.js 刚踩过）。
//   2. 出错的方向是安全的。一个不能写状态的模块，最坏也只是判错，不会把坏 draft
//      顺手提交进去 —— 而「检测器自己写历史」正是原文点名的反模式。
//
// 硬规则（下面每一条在 tests/admission.test.js 里都有对应断言，不是注释里的愿望）：
//   - 扫**完整**的 sanitized candidate，不许偷偷截断留个没扫的尾巴
//   - grounding 只能由**用户写的**文本建立，assistant 不能给自己发许可证
//   - receipt 只记元数据，绝不记原文
//   - lanes 单向执行，不回头，不循环

'use strict';

const crypto = require('node:crypto');

// 宿主协议标记。判之前要剥掉，否则模型写的 [[GAZE: 120]] 这类东西会被当成正文语义，
// 而它其实是给 GranCyan 看的指令（想想 `[[SAY: 打 120 吗]]` 会把急救检测器怎么带偏）。
//
// ⚠️ **故意不写成清单。** 第一版我手抄了 6 个（GAZE/SAY/NURSE/SILENT/MOOD 等），
//    测试里那条反向断言当场逮出前端实际有 **44 个** —— 而且这个数字还会继续涨。
//    手抄的清单漏一个的后果是「检测器读到协议文本」，没有任何报错。
//    所以这里认的是**形状**：`[[大写开头的标识符 …]]`，新增标记自动覆盖。
//    （宁可多剥一点：剥多了最坏是检测器少看到几个字，剥漏了才会判错。）
const PROTOCOL_TAG_RE = /\[\[[A-Z][A-Z_0-9]*\b[^\]]*\]\]/g;

/**
 * 判之前的归一化。**不做截断** —— 原文作者踩过的坑：早期实现 slice(0,4000)，
 * 于是「正常的长回答 + 尾部才出现的该拒内容」永远扫不到，而且静默。
 */
function sanitizeCandidate(raw) {
    return String(raw || '')
        .replace(PROTOCOL_TAG_RE, ' ')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .replace(/\r\n?/g, '\n')
        .trim();
}

/**
 * @typedef {{ reason: string, signals?: string[] }} Rejection
 * @typedef {{
 *   userText: string,           // 本轮用户说的话
 *   recentUserTexts: string[],  // 最近几条**用户自己写的**消息（绝不含 assistant 的）
 *   candidateText: string,      // sanitize 之后的完整候选正文
 *   surface: { agent?: boolean },  // 宿主已经确认的场景
 * }} GuardInput
 * @typedef {{ name: string, guard: (input: GuardInput) => Rejection | null }} Lane
 */

/**
 * 单向跑完所有 lane，返回第一个拒绝；全过返回 null。
 *
 * **不回头**是有意的：原文第 11 节的 ping-pong —— 后一个 guard 修完的结果又送回
 * 前一个 guard，两个门来回触发，调用次数没有上界。这里连「重跑」的入口都不提供。
 *
 * guard 自己抛异常 = 检测器有 bug，这时候**放行**而不是拒绝：
 * 一个写错的正则不该让她连话都说不了（fail-open 是这一层的正确方向，
 * fail-closed 属于 isolation 层的「reset 证明不了就别重试」，两回事，别混）。
 */
function runAdmission(lanes, input, onGuardError) {
    for (const lane of lanes || []) {
        let r = null;
        try {
            r = lane.guard(input);
        } catch (e) {
            if (onGuardError) onGuardError(lane.name, e);
            continue;
        }
        if (r && r.reason) return { ...r, lane: lane.name };
    }
    return null;
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 拒绝回执。**只有元数据** —— 长度和 hash 足够证明「当时确实拒过一个具体候选」、
 * 足够做重复/关联调试，而不需要把她的私人对话长期写进日志。
 *
 * ⚠️ hash 不是匿名化魔法：低熵文本（「好」「嗯」）照样能被猜出来。
 * 所以这东西的定位是关联用的指纹，不是脱敏方案。
 */
function makeReceipt(input) {
    const text = input.candidateText || '';
    return {
        type: 'model_output_rejected',
        schema_version: 1,
        ts: new Date().toISOString(),
        turn_id: input.turnId || '',
        attempt_index: input.attemptIndex || 0,
        provider: input.provider || '',
        lane: (input.rejection && input.rejection.lane) || '',
        reason: (input.rejection && input.rejection.reason) || '',
        signals: [...((input.rejection && input.rejection.signals) || [])],
        reply_chars: text.length,
        reply_sha256: sha256(text),
        raw_text_persisted: false,
        excluded_from_history: true,
        excluded_from_memory: true,
        retry_planned: !!input.retryPlanned,
    };
}

/**
 * 协议自测用的假 guard。**先用它把隔离协议跑通，再上真 detector** ——
 * 原文的建议，理由很实际：真 detector 的命中是概率性的，拿它调协议
 * 等于同时调试两个不确定的东西。
 */
const demoGuard = {
    name: 'demo',
    guard: ({ candidateText }) =>
        candidateText.includes('[REJECT_ME]')
            ? { reason: 'demo_rejection', signals: ['synthetic_marker'] }
            : null,
};

module.exports = {
    PROTOCOL_TAG_RE,
    sanitizeCandidate,
    runAdmission,
    makeReceipt,
    sha256,
    demoGuard,
};
