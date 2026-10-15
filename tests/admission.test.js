// 输出准入（server/admission.js + server.js 的影子接线）的回归测试。
// 方案见 docs/output-admission.md。
//
// 这条路最值钱的一条测试不是「重试有没有成功」，而是 **canary 泄漏测试**：
// 给坏草稿塞一个绝不会自然出现的标记，拒绝它，然后逐个问每一个持久面
// ——回执、日志行、会话登记的入参、发给前端的事件——它出现了没有。
// 「UI 没显示」只证明眼睛没看见；canary 证明的是它没变成系统状态。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const A = require(path.join(root, 'server', 'admission.js'));

let failed = 0;
function check(name, yes) {
    console.log(`  ${yes ? '✓' : '✗'} ${name}`);
    if (!yes) failed++;
}

const CANARY = 'CANARY_REJECTED_DRAFT_8f1c4d2e9a7b';

// ── sanitizeCandidate ────────────────────────────────────────────
{
    const s = A.sanitizeCandidate('说点什么 [[GAZE: xhs]] 再说点 [[SAY: 你好]] 结束');
    check('宿主协议标记被剥掉（否则检测器读的是给 GranCyan 的指令，不是她看到的话）',
        !s.includes('GAZE') && !s.includes('SAY') && s.includes('说点什么') && s.includes('结束'));

    // 原文作者踩过的坑：早期实现 slice(0, 4000)，于是「很长的正常回答 + 尾部才出现的
    // 该拒内容」永远扫不到，而且完全静默。这里反着测：造一条超长的，看尾巴还在不在。
    const long = 'あ'.repeat(20000) + CANARY;
    check('不做静默截断 —— 20000 字后面的尾巴照样在扫描范围里',
        A.sanitizeCandidate(long).includes(CANARY));

    check('控制字符被清掉', !A.sanitizeCandidate('a\u0007b').includes('\u0007'));
    check('空候选归一化成空串', A.sanitizeCandidate(null) === '' && A.sanitizeCandidate('   ') === '');
}

// ── runAdmission：单向、有序、fail-open ──────────────────────────
{
    const calls = [];
    const laneA = { name: 'a', guard: () => { calls.push('a'); return null; } };
    const laneB = { name: 'b', guard: () => { calls.push('b'); return { reason: 'hit_b' }; } };
    const laneC = { name: 'c', guard: () => { calls.push('c'); return { reason: 'hit_c' }; } };

    const v = A.runAdmission([laneA, laneB, laneC], { candidateText: 'x' });
    check('返回第一个拒绝，并带上是哪条 lane 拒的', v && v.reason === 'hit_b' && v.lane === 'b');
    check('命中之后不再往下跑（单向，不回头）', calls.join(',') === 'a,b');

    check('全过返回 null', A.runAdmission([laneA], { candidateText: 'x' }) === null);

    // 检测器自己写错正则不该让她连话都说不出来 —— 这一层的正确方向是 fail-open。
    // （fail-closed 属于 isolation 层的「reset 证明不了就别重试」，是另一回事。）
    const errs = [];
    const boom = { name: 'boom', guard: () => { throw new Error('正则写炸了'); } };
    const v2 = A.runAdmission([boom, laneA], { candidateText: 'x' }, (n, e) => errs.push(n + ':' + e.message));
    check('guard 抛异常时放行而不是拒绝', v2 === null);
    check('但异常要报出来，不能静默吞掉', errs.length === 1 && errs[0].includes('boom'));

    // 没有 reason 的返回值不算拒绝（防止 guard 写成 `return {}` 就把所有回复毙掉）
    check('返回空对象不算拒绝',
        A.runAdmission([{ name: 'empty', guard: () => ({}) }], { candidateText: 'x' }) === null);
}

// ── makeReceipt：只记元数据 ─────────────────────────────────────
{
    const receipt = A.makeReceipt({
        turnId: 't1', attemptIndex: 0, provider: 'local-claude',
        rejection: { reason: 'demo_rejection', signals: ['synthetic_marker'], lane: 'demo' },
        candidateText: `坏草稿 ${CANARY} 后面还有话`,
        retryPlanned: true,
    });
    const asJson = JSON.stringify(receipt);

    // ★ 这一条是整个文件的核心
    check('★ 回执里没有候选原文（canary 不在任何字段里）', !asJson.includes(CANARY));
    check('回执里也没有原文的任何片段', !asJson.includes('坏草稿') && !asJson.includes('后面还有话'));

    check('但留了长度和 hash，够证明「当时确实拒过一个具体候选」',
        receipt.reply_chars === `坏草稿 ${CANARY} 后面还有话`.length
        && /^[0-9a-f]{64}$/.test(receipt.reply_sha256));
    check('hash 是真的 sha256（不是占位符）',
        receipt.reply_sha256 === A.sha256(`坏草稿 ${CANARY} 后面还有话`));
    check('明确标注没有持久化原文', receipt.raw_text_persisted === false
        && receipt.excluded_from_history === true && receipt.excluded_from_memory === true);
    check('记下是哪条 lane、什么理由、有没有打算重试',
        receipt.lane === 'demo' && receipt.reason === 'demo_rejection' && receipt.retry_planned === true);
}

// ── demoGuard：协议自测用 ───────────────────────────────────────
{
    check('demoGuard 命中合成标记', !!A.demoGuard.guard({ candidateText: '好的 [REJECT_ME] 好的' }));
    check('demoGuard 不误伤正常文本', A.demoGuard.guard({ candidateText: '好的好的' }) === null);
}

// ── 接线：刀口必须在 rememberSession 之前 ───────────────────────
// 这不是风格问题。rememberSession 是 provider thread 的提交点 ——
// 登记了，下一轮 --resume 就把坏 draft 带回来（前端删得再干净也没用）。
// 准入跑在它后面 = 整件事白做，而且零报错。
{
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

    const iShadow = server.indexOf('shadowAdmission({');
    const iRemember = server.indexOf('rememberSession(chatMsgs');
    check('server.js 真的接上了准入', iShadow > 0);
    check('★ 准入跑在 rememberSession 之前（顺序反了等于没做，且零报错）',
        iShadow > 0 && iRemember > 0 && iShadow < iRemember);

    check('候选全文有被累积（否则只判得到空串，永远不命中）',
        /candidateText \+= d\.text/.test(server));

    // 影子模式的保证：这一批不改变任何可见行为。命中时只能写日志，
    // 不许 send 事件、不许跳过 rememberSession。
    const shadowFn = server.slice(server.indexOf('function shadowAdmission'),
        server.indexOf('// npm 自更新会把那个'));
    check('影子模式不往前端发任何事件', !/\bsend\s*\(/.test(shadowFn));
    check('影子模式落盘的是 receipt 不是原文',
        /JSON\.stringify\(receipt\)/.test(shadowFn) && !/candidateText\s*\+\s*'\\n'/.test(shadowFn));

    // grounding 只能由用户写的文本建立：assistant 自己说过的话不能给自己发许可证。
    const recentFn = server.slice(server.indexOf('function recentUserTexts'),
        server.indexOf('function shadowAdmission'));
    check('★ recentUserTexts 只取 user 的消息（assistant 不能给自己发许可证）',
        /role === 'user'/.test(recentFn) && !/m\.role === 'assistant'/.test(recentFn));

    // 行为：本轮这条不能重复出现在 recentUserTexts 里。重复的话，「上一轮说过」
    // 和「这一轮正在说」就是同一个东西，detector 里「陈旧 grounding 不授权新 turn」
    // 那条判据当场失效 —— 而且完全静默。
    {
        const fn = new Function('chatMsgs', `${recentFn}\nreturn recentUserTexts(chatMsgs);`);
        const got = fn([
            { role: 'user', content: '上一轮' },
            { role: 'assistant', content: '回复' },
            { role: 'user', content: '本轮' },
        ]);
        check('★ 本轮这条不会重复混进 recentUserTexts（否则陈旧 grounding 判据失效）',
            Array.isArray(got) && !got.includes('本轮') && got.includes('上一轮'));
    }
}

// ── lanes 接线 ──────────────────────────────────────────────────
{
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

    const lanesBlock = server.slice(server.indexOf('const ADMISSION_LANES'),
        server.indexOf('const ADMISSION_LOG'));
    check('真 detector 已经接进 lanes（不接的话写了也白写）',
        lanesBlock.includes('unsolicitedEmergencyEscalation'));
}

// ── 协议标记清单要和前端对齐 ────────────────────────────────────
// 前端加了新标记而 admission 这边没跟上 → 检测器读到的是协议文本而不是她看到的话。
// 这种漏没有任何报错，所以反着断言：枚举前端实际解析的标记，逐个确认能被剥掉。
{
    const front = fs.readFileSync(path.join(root, 'js', '05-prompts-api.js'), 'utf8');
    const tags = [...new Set((front.match(/\[\[([A-Z_]{3,})\b/g) || []).map(x => x.slice(2)))];
    check('确实从前端抓到了标记清单（抓空的话这条断言等于没测）', tags.length >= 3);
    const missed = tags.filter(t => A.sanitizeCandidate(`前 [[${t}: 参数]] 后`).includes(t));
    check(`前端所有协议标记都剥得掉（实测 ${tags.length} 个：${tags.join('/')}）`, missed.length === 0);
    if (missed.length) console.log('      漏掉的:', missed.join(', '));
}

if (failed) process.exitCode = 1;
else console.log('  —— 输出准入 全部通过');
