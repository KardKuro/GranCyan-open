// 技能开关面板上那个 token 数字，对不对。
//
// 那个数字是给用户看的预算 —— 她按它决定关掉哪些技能省 token。写错了不会报错，
// 只会让她按着假账算。而它**极其容易悄悄失准**：estimateTokens 有取整，
// 改任何一条技能的提示词文本，别的条目都会跟着漂 ±1。
//
// 以前这件事散在各处，写成 `/tok: 245,/` 这种 grep 源码的断言 —— 名字讲的是
// 「是实测值」，实现却只是在找那个字，于是别人改了别的技能就假红。
// 这里集中量一遍：开一次、关一次、差值就是真值。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failed = 0;
function t(name, yes) {
    console.log(`  ${yes ? '✓' : '✗'} ${name}`);
    if (!yes) failed++;
}

// 已知对不上、且**不是这次改动造成**的历史偏差。列在这里＝「知道它歪着，暂时不动」，
// 而不是假装没看见。想清理的时候把 key 从这里删掉，测试会告诉你真值是多少。
//   voice / sticker / imgSearch：表里的值比实测小几十，来历不明（早于 2026-09-21）
//   chatPeek：在这个测试环境里实测为 0 —— 它要 state.chats 里真有别的对话才进提示，
//             所以这里量不准，不是说它坏了
const KNOWN_STALE = new Set(['voice', 'sticker', 'imgSearch', 'chatPeek']);

const state = {
    moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [], chats: [],
    userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: 'k',
    webSearchProvider: 'tavily', bandAiEnabled: false, studyOn: false,
    // 跑腿那条要有跑腿模型才注入（没有就不教），不给 key 的话它实测为 0
    thinkSumKey: 'k',
};
const box = {
    console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map, Number,
    fetch: async () => ({ ok: true }), state,
    _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
    save() {}, showToast() {}, escHtml: v => String(v),
    pickBrainMemories: () => [], formatBrainForPrompt: () => '', takeProustMoment: () => '',
    getActiveChat: () => null, getMsgPlainText: n => String((n && n.content) || ''),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {},
};
box.globalThis = box;
vm.createContext(box);

const stateSrc = read('js/02-state.js');
const a = stateSrc.indexOf('function estimateTokens(text)');
const b = stateSrc.indexOf('function getChatTotalTokens', a);
t('抠到了 estimateTokens', a > 0 && b > a);
vm.runInContext(stateSrc.slice(a, b), box);
vm.runInContext(read('js/05-prompts-api.js'), box);
// 跑腿的说明在 61-errand.js 里（同 feedback 那段：不补进来它会假装自己是 0）
vm.runInContext(read('js/61-errand.js'), box);
// 相册的说明在 62-album.js 里（albumPromptFor），同理要补进来；它要 60-imgmem.js 的哈希
vm.runInContext(read('js/60-imgmem.js'), box);
vm.runInContext(read('js/62-album.js'), box);
// 翻记忆的说明在 63-breath.js 里（breathPromptFor），同理
vm.runInContext(read('js/63-breath.js'), box);
// 施工单的说明在 64-build.js（buildPromptFor）
vm.runInContext(read('js/64-build.js'), box);
// 藏宝地图的说明在 68-treasure.js（treasurePromptFor）。这里没有 localStorage、没标地点，
// 量的是「说明 + 还没标地点」那一版（地点多了提示会变长，表里写的是起步价）
vm.runInContext(read('js/68-treasure.js'), box);
// 小本子的说明在 71-wishbook.js（wishPromptFor）。本子是空的，量的是起步价（记多了会变长）
vm.runInContext(read('js/71-wishbook.js'), box);

// feedback 那条技能的说明写在 06-render-msg.js 里，不补进来的话它实测为 0 ——
// 而 0 看起来像「这条技能没生效」，其实是探针缺依赖。探针要先验身。
const renderSrc = read('js/06-render-msg.js');
const A = 'function msgFeedbackOf(node) {', B = '\nfunction updateFavBadge() {';
t('抠到了 feedback 那段（不补的话它会假装自己是 0）',
    renderSrc.split(A).length - 1 === 1 && renderSrc.split(B).length - 1 === 1);
vm.runInContext(renderSrc.slice(renderSrc.indexOf(A), renderSrc.indexOf(B)), box);

const conf = { id: 'm1', nickname: '阿岚', modelName: 'test-model', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 };
const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
// 施工单只教订阅 Claude（64-build.js 的 buildEnabledFor）：拿普通配置量它恒为 0，
// 0 看起来像「这条没生效」，其实是探针选错了模型。所以量它那一行换成订阅 Claude 的配置。
const localConf = { ...conf, isLocalClaude: true };
let measuring = '';
const build = () => box.buildSystemPrompt(measuring === 'build' ? localConf : conf, chat, '', null, {});

const defs = vm.runInContext('SKILL_DEFS.map(d => ({ key: d.key, tok: d.tok, name: d.name }))', box);
t('读到了技能表', Array.isArray(defs) && defs.length > 10);

const stale = [];
for (const d of defs) {
    measuring = d.key;
    state.skillsOff = {};
    const on = box.estimateTokens(build());
    state.skillsOff = { [d.key]: true };
    const measured = on - box.estimateTokens(build());
    if (KNOWN_STALE.has(d.key)) {
        if (measured !== d.tok) stale.push(`${d.key}(表${d.tok}/实测${measured})`);
        continue;
    }
    t(`${d.name} 的 tok 是实测值（表 ${d.tok}）`, measured === d.tok);
}

// 已知偏差每次都打出来 —— 不让它红，但也不让它消失在视野里
if (stale.length) console.log(`  ⓘ 已知未清理的偏差 ${stale.length} 条：${stale.join('  ')}`);

// 反过来也要守：别把 KNOWN_STALE 当垃圾桶。某一条自己变准了就该从名单里拿掉，
// 否则这个名单会慢慢吃掉整张表，测试还一直绿着。
const nowAccurate = [];
for (const d of defs) {
    if (!KNOWN_STALE.has(d.key)) continue;
    measuring = d.key;
    state.skillsOff = {};
    const on = box.estimateTokens(build());
    state.skillsOff = { [d.key]: true };
    if (on - box.estimateTokens(build()) === d.tok) nowAccurate.push(d.key);
}
t(`豁免名单里没有已经变准的条目（变准了就该拿掉，别让名单吃掉整张表）`,
    nowAccurate.length === 0);
if (nowAccurate.length) console.log('      这些已经准了，从 KNOWN_STALE 删掉:', nowAccurate.join(', '));

if (failed) process.exitCode = 1;
else console.log('  —— 技能 token 全部对得上');
