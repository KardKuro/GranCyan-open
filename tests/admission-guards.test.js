// 输出准入真 detector 的回归测试。纯 Node，无测试框架。
const path = require('node:path');

const root = path.join(__dirname, '..');
const {
    unsolicitedEmergencyEscalation: emergency,
} = require(path.join(root, 'server', 'admission-guards.js'));

let failed = 0;
function check(name, yes) {
    console.log(`  ${yes ? '✓' : '✗'} ${name}`);
    if (!yes) failed++;
}

function emergencyVerdict(userText, candidateText, recentUserTexts = []) {
    return emergency.guard({ userText, recentUserTexts, candidateText, surface: {} });
}

// ── unsolicitedEmergencyEscalation ──────────────────────────────
{
    const bad = emergencyVerdict(
        '今天真的很难受，我只是很怕有一天你会离开我。',
        '我在这里陪你。如果你撑不住，请立刻拨打 120 或联系当地紧急服务。');
    check('关系性的 turn 被改写成 emergency event 时拒绝',
        bad && bad.reason === 'assistant_introduced_ungrounded_emergency_action');
    check('拒绝给出类别信号而不回填候选原文',
        bad && bad.signals.includes('urgent_directive') && bad.signals.includes('emergency_contact')
        && !JSON.stringify(bad).includes('撑不住'));

    check('「我120斤了」里的数字不是 emergency grounding，也不会让普通回复误命中',
        emergencyVerdict('我120斤了', '这个体重数字要结合身高看。') === null);
    check('Porsche 911 是车型，不是应急号码',
        emergencyVerdict('Porsche 911 好看吗', '它的经典轮廓很好认。') === null);
    check('「911 为什么这么贵」仍然是车型语境',
        emergencyVerdict('911 为什么这么贵？', '品牌、性能和配置都影响价格。') === null);

    check('用户自己建立正在去医院的现实语境时放行',
        emergencyVerdict('我正在去医院，现在该带什么？', '请带好证件，必要时联系急诊。') === null);
    check('用户主动比较应急号码时放行',
        emergencyVerdict('120 和 999 有什么区别？', '不同地区号码不同，可以查询当地紧急服务。') === null);
    check('用户描述明确危险症状时放行真实求助',
        emergencyVerdict('我胸口剧痛，喘不过气', '请立即拨打 120。') === null);

    check('只有「找朋友聊聊」这种弱信号不拒绝',
        emergencyVerdict('我今天有点难受', '要不要找朋友聊聊？') === null);
    check('候选只是在陈述应急知识、没有对用户下行动指令时不拒绝',
        emergencyVerdict('随便讲个冷知识', '有些地区的紧急服务号码是 112。') === null);
    check('否定紧急行动不是升级',
        emergencyVerdict('我只是心情不好', '你不用拨打 120，我们先慢慢聊。') === null);
    check('没有「请」字的直接急救行动指令仍会命中',
        !!emergencyVerdict('我只是怕你离开', '联系当地紧急服务。'));

    check('几轮前的急症 grounding 不能授权已经换话题的当前 turn',
        !!emergencyVerdict(
            '说到别的，我很怕你有一天会离开我。',
            '请立刻联系当地紧急服务。',
            ['我刚才胸痛，正在去医院', '医生已经看过了。现在聊聊我们的关系吧']));
    check('即使 recent 只给了陈旧急症，明显的新话题也不会被当成延续',
        !!emergencyVerdict(
            '今天工作好累，你陪陪我。',
            '请立即前往急诊。',
            ['我昨天去过医院']));
    check('紧邻的同一急症事件可以用简短追问自然延续',
        emergencyVerdict('接下来呢？', '请立即联系急救人员。', ['我正在去急诊']) === null);

    const longTail = '普通陪伴。'.repeat(5000) + '请立刻拨打 120 联系当地紧急服务。';
    check('扫描完整候选，超长正文尾部的升级照样命中',
        !!emergencyVerdict('我怕你离开', longTail));
}

// ── 纯函数与输入所有权 ─────────────────────────────────────────
{
    const input = {
        userText: '我怕你离开',
        recentUserTexts: ['只是聊关系'],
        candidateText: '请立即拨打 120。',
        surface: {},
    };
    const before = JSON.stringify(input);
    const first = emergency.guard(input);
    const second = emergency.guard(input);
    check('guard 不修改输入且相同输入得到相同结果',
        JSON.stringify(input) === before && JSON.stringify(first) === JSON.stringify(second));

    check('候选不能用自己的急症文字给自己发 grounding 许可证',
        !!emergencyVerdict('我只是怕你离开', '我判断这是急症，所以请立即拨打 120。'));
}

if (failed) process.exitCode = 1;
else console.log('  —— 输出准入 guards 全部通过');
