'use strict';

// Output-admission detectors deliberately use combinations of signals. A phone
// number, an apology, or a suggestion to talk to somebody is never sufficient
// on its own: those single-token rules are exactly the false-positive factory
// this layer is meant to avoid.

function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function recentBeforeCurrent(input) {
    const current = text(input && input.userText);
    const recent = Array.isArray(input && input.recentUserTexts)
        ? input.recentUserTexts.map(text).filter(Boolean)
        : [];

    // The server currently supplies a chat-message slice that may already end
    // with userText. Do not mistake that duplicate for an earlier turn.
    while (recent.length && recent[recent.length - 1] === current) recent.pop();
    return recent;
}

const EMERGENCY_WORD_RE = /(?:急诊|急救|救护车|紧急服务|急救电话|报警|医院|emergency\s+(?:room|department|services?)|ambulance|hospital|crisis\s+(?:line|hotline))/i;
const SEVERE_EVENT_RE = /(?:胸(?:口)?(?:剧)?痛|呼吸(?:非常)?困难|喘不过气|失去意识|昏迷|大出血|血止不住|心脏骤停|过量服药|药物过量|自杀|想死|伤害自己|伤害他人|severe\s+chest\s+pain|can(?:not|'t)\s+breathe|unconscious|heavy\s+bleeding|overdos(?:e|ed)|suicid(?:e|al)|kill\s+myself|hurt\s+myself)/i;
const EMERGENCY_NUMBER_RE = /(?:120|119|110|112|911|999)/g;
const CALL_CONTEXT_RE = /(?:拨打|致电|打给|联系|呼叫|急救|报警|求救|号码|电话|call|dial|contact|phone|emergency)/i;
const QUESTION_CONTEXT_RE = /(?:区别|不同|哪个|如何|怎么|是什么|为什么|用途|国家|地区|vs\.?|versus|difference|which|what|how)/i;

function hasSemanticEmergencyNumber(value) {
    const s = text(value);
    const numbers = s.match(EMERGENCY_NUMBER_RE) || [];
    if (!numbers.length) return false;
    if (CALL_CONTEXT_RE.test(s)) return true;
    // Comparing two emergency codes is a real request for emergency knowledge;
    // a single weight (120) or car model (911) remains ordinary text.
    return new Set(numbers).size >= 2 && QUESTION_CONTEXT_RE.test(s);
}

function hasEmergencyGrounding(value) {
    const s = text(value);
    return !!s && (EMERGENCY_WORD_RE.test(s)
        || SEVERE_EVENT_RE.test(s)
        || hasSemanticEmergencyNumber(s));
}

function continuesEmergencyEvent(current, previous) {
    if (!hasEmergencyGrounding(previous)) return false;
    const s = text(current);
    if (!s) return false;

    // Generic continuations are licensed only by the immediately preceding
    // user turn. More specific medical continuations may be longer, but still
    // need that adjacent grounding. Older entries never grant permission.
    if (/^(?:现在)?(?:该|要)?怎么办[？?。!！]*$|^(?:然后|接下来|现在)呢[？?。!！]*$/i.test(s)) return true;
    return /(?:症状|伤口|出血|流血|疼|痛|呼吸|心跳|头晕|救护车|医生|护士|急诊|医院|检查|药).{0,16}(?:还|仍|又|继续|没|怎么办|如何|怎样|呢)|(?:还|仍|又|继续|现在).{0,16}(?:症状|伤口|出血|流血|疼|痛|呼吸|心跳|头晕|救护车|医生|护士|急诊|医院|检查|药)/i.test(s);
}

const URGENT_DIRECTIVE_RE = /(?:请|务必|必须|应当|应该|需要|建议(?:你)?|立刻|立即|马上|赶紧|尽快).{0,28}(?:拨打|致电|联系|呼叫|前往|去|寻求)|(?:拨打|致电|联系|呼叫|前往|去|寻求).{0,20}(?:120|119|110|112|911|999|急诊|急救|救护车|紧急服务|急救电话)|(?:call|dial|contact|go\s+to|seek).{0,36}(?:emergency|ambulance|hospital|crisis|120|119|110|112|911|999)|(?:you\s+(?:must|should|need\s+to)|please|immediately).{0,36}(?:call|dial|contact|go|seek)/i;
const NEGATED_DIRECTIVE_RE = /(?:不用|不必|无需|不要|没必要|并非要|不是让你).{0,12}(?:拨打|致电|联系|去医院|前往医院|去急诊|寻求急救)|(?:do\s+not|don't|need(?:n't|\s+not)|not\s+necessary\s+to).{0,20}(?:call|dial|contact|go|seek)/i;

function emergencyCandidateSignals(value) {
    const s = text(value);
    const signals = [];
    if (hasSemanticEmergencyNumber(s)) signals.push('emergency_contact');
    if (EMERGENCY_WORD_RE.test(s) || SEVERE_EVENT_RE.test(s)) signals.push('emergency_category');
    if (URGENT_DIRECTIVE_RE.test(s) && !NEGATED_DIRECTIVE_RE.test(s)) signals.push('urgent_directive');
    if (/(?:朋友|家人|信任的人|身边的人|someone\s+you\s+trust|friend|family)/i.test(s)) signals.push('social_support');
    return signals;
}

const unsolicitedEmergencyEscalation = {
    name: 'unsolicited_emergency_escalation',
    guard(input) {
        const current = text(input && input.userText);
        const recent = recentBeforeCurrent(input);
        const previous = recent[recent.length - 1] || '';

        // grounding: only user-authored text may establish the event. A prior
        // event is usable solely when the current turn continues it directly.
        if (hasEmergencyGrounding(current) || continuesEmergencyEvent(current, previous)) return null;

        const signals = emergencyCandidateSignals(input && input.candidateText);

        // arm: this must be advice directed at the user, not a bare fact or a
        // number appearing in prose.
        if (!signals.includes('urgent_directive')) return null;

        // novelty: the directive must introduce a strong emergency category.
        // social_support is intentionally weak and cannot reject by itself.
        if (!signals.includes('emergency_contact') && !signals.includes('emergency_category')) return null;

        return {
            reason: 'assistant_introduced_ungrounded_emergency_action',
            signals: signals.filter(s => s !== 'social_support'),
        };
    },
};

module.exports = {
    unsolicitedEmergencyEscalation,
};
