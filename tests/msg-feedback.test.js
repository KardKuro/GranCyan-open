'use strict';
// 👍 / 👎 消息反馈。
//
// 用户的要求里有一条是硬的：**这个反馈不发给任何 AI 公司**，只在本地，
// 用来塑造这个 AI 以后怎么写。所以这里除了功能，还守着那条边界。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const renderSrc = read('js/06-render-msg.js');
const promptSrc = read('js/05-prompts-api.js');
const stateSrc = read('js/02-state.js');
const cssSrc = read('css/grancyan.css');

let passed = 0, failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── 把那段真代码抠出来 ─────────────────────────────────────────────
const A = 'function msgFeedbackOf(node) {';
const B = '\nfunction updateFavBadge() {';
const nA = renderSrc.split(A).length - 1, nB = renderSrc.split(B).length - 1;
t('锚点唯一（不唯一的话抠出来的是别的段落，下面全是验空气）', nA === 1 && nB === 1, `A=${nA} B=${nB}`);
const SEG = renderSrc.slice(renderSrc.indexOf(A), renderSrc.indexOf(B));

console.log('\n[1] 点一下、再点一下');
function mkBox(chats, skillsOff) {
  const toasts = [], saves = [];
  const painted = [];
  const box = {
    console, Date, JSON, Math, String, Array, Object, Number,
    state: { chats: chats || [], skillsOff: skillsOff || {} },
    save: () => saves.push(1),
    showToast: (m, k) => toasts.push([m, k]),
    getActiveChat: () => (chats && chats[0]) || null,
    getMsgPlainText: n => String((n && n.content) || ''),
    skillOn: key => !(box.state.skillsOff && box.state.skillsOff[key]),
    document: { querySelectorAll: sel => { painted.push(sel); return []; } },
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(SEG, box, { filename: '06-render-msg.js#feedback' });
  box._log = { toasts, saves, painted };
  return box;
}
const mkChat = () => ({ id: 'c1', nodes: { 7: { id: 7, role: 'assistant', content: '一段回复' } } });

{
  const chat = mkChat(); const box = mkBox([chat]);
  vm.runInContext('toggleMsgFeedback(7, 1)', box);
  t('★ 点赞写进节点并落盘', chat.nodes[7].fb === 1 && box._log.saves.length === 1);
  t('顺手记了时刻（排序要用，没有它「最近的偏好」就无从谈起）', typeof chat.nodes[7].fbAt === 'number');
  vm.runInContext('toggleMsgFeedback(7, 1)', box);
  t('★ 再点一次＝取消，且字段是删掉不是留个 0（留 0 会被当成"给过反馈"）',
    !('fb' in chat.nodes[7]) && !('fbAt' in chat.nodes[7]));
  vm.runInContext('toggleMsgFeedback(7, -1)', box);
  t('点踩', chat.nodes[7].fb === -1);
  vm.runInContext('toggleMsgFeedback(7, 1)', box);
  t('★ 从踩直接切到赞（不用先取消）', chat.nodes[7].fb === 1);
}
{
  const box = mkBox([mkChat()]);
  vm.runInContext('toggleMsgFeedback(999, 1)', box);
  t('点到不存在的消息不炸也不乱存', box._log.saves.length === 0);
  const box2 = mkBox([]);
  vm.runInContext('toggleMsgFeedback(7, 1)', box2);
  t('没有活动对话时静静地什么都不做', box2._log.saves.length === 0);
}
{
  const box = mkBox([mkChat()]);
  // 字符串 '1' 是**故意**收下的：云同步 / 旧备份走 JSON 往返，数字可能变成字符串，
  // 那种情况下丢掉她给过的反馈比多收一个更糟。真正要挡的是别的值。
  t('只认 1 和 -1（数字或它的字符串形态），别的一律不算反馈',
    vm.runInContext('msgFeedbackOf({fb:"1"})===1 && msgFeedbackOf({fb:2})===0 && msgFeedbackOf({fb:NaN})===0 && msgFeedbackOf({fb:"good"})===0 && msgFeedbackOf(null)===0 && msgFeedbackOf({})===0', box));
}

console.log('\n[2] 收集：跨对话、有上限、新的在前');
{
  const chats = [];
  for (let c = 0; c < 3; c++) {
    const nodes = {};
    for (let i = 0; i < 4; i++) {
      const id = c * 10 + i;
      nodes[id] = { id, role: 'assistant', content: 'up' + id, fb: 1, fbAt: 1000 + id };
    }
    nodes['x' + c] = { id: 'x' + c, role: 'assistant', content: 'down' + c, fb: -1, fbAt: 500 + c };
    nodes['u' + c] = { id: 'u' + c, role: 'user', content: '我说的话', fb: 1, fbAt: 9999 };
    chats.push({ id: 'c' + c, nodes });
  }
  const box = mkBox(chats);
  const got = vm.runInContext('collectMsgFeedback(4)', box);
  t('★ 跨对话收集（只看当前对话的话，换个对话就等于失忆）',
    got.up.length === 4 && got.down.length === 3);
  t('★ 有硬上限 —— 读得越久这段越长，某天会安静地把上下文顶爆',
    got.up.length === 4, `拿到 ${got.up.length} 条`);
  t('★ 新的在前（偏好会变，旧的不该压着新的）', got.up[0] === 'up23', got.up.join(','));
  t('★ 自己说的话不算反馈素材（点赞的是 AI 的回复）',
    !got.up.some(s => s.includes('我说的话')) && !got.down.some(s => s.includes('我说的话')));
}
{
  const chat = { id: 'c', nodes: {
    1: { id: 1, role: 'assistant', content: '[[MARK: 只有标签]] [[SONG: x]]', fb: 1, fbAt: 2 },
    2: { id: 2, role: 'assistant', content: '甲'.repeat(300), fb: 1, fbAt: 1 },
  } };
  const got = vm.runInContext('collectMsgFeedback(4)', mkBox([chat]));
  t('★ 剥掉标签之后是空的那条整个丢掉（喂一行空白给模型没有意义）',
    !got.up.some(s => s.includes('MARK')), JSON.stringify(got.up));
  t('★ 每条也有长度上限', got.up.every(s => s.length <= 91), JSON.stringify(got.up.map(s => s.length)));
}

console.log('\n[3] 进提示词的方式');
{
  const chat = { id: 'c', nodes: {
    1: { id: 1, role: 'assistant', content: '她喜欢的写法', fb: 1, fbAt: 2 },
    2: { id: 2, role: 'assistant', content: '她不喜欢的写法', fb: -1, fbAt: 1 },
  } };
  const box = mkBox([chat]);
  const p = vm.runInContext('feedbackPromptFor()', box);
  t('赞和踩都进了 volatile', p.volatile.includes('她喜欢的写法') && p.volatile.includes('她不喜欢的写法'));
  t('★ 提示词里写明了「不会发给任何 AI 公司」—— 这是用户要的那条边界',
    /不会发给任何 AI 公司/.test(p.stable), p.stable);
  t('交代了这不是评分/考核，也别在回复里提这件事',
    /不是评分|不是考核|考核/.test(p.stable) && /别在回复里提/.test(p.stable));

  // ⚠️ stable 段不能跟着「此刻有没有反馈」变 —— 变了就等于第一次点赞
  //   把后面所有历史的提示词缓存全打穿（缓存那条记忆记着这个坑）。
  const empty = vm.runInContext('feedbackPromptFor()', mkBox([{ id: 'c', nodes: {} }]));
  t('★ 一条反馈都没有时 stable 一字不差，只有 volatile 是空的',
    empty.stable === p.stable && empty.volatile === '', JSON.stringify(empty.volatile));
}
{
  const chat = { id: 'c', nodes: { 1: { id: 1, role: 'assistant', content: 'x', fb: 1, fbAt: 1 } } };
  const off = vm.runInContext('feedbackPromptFor()', mkBox([chat], { feedback: true }));
  t('★ 关掉这个技能之后整段消失（说明和内容都不留）',
    off.stable === '' && off.volatile === '');
}

console.log('\n[4] 按钮');
{
  const box = mkBox([mkChat()]);
  const on = vm.runInContext('msgFeedbackHtml({id:7, fb:1})', box);
  const off = vm.runInContext('msgFeedbackHtml({id:7})', box);
  t('给过反馈的那个按钮带 on（看不出来的话她会重复点）',
    /data-fb="1"[^>]*>/.test(on) && on.includes('msg-fb-btn on'), on);
  t('没给过反馈时两个都不亮', !off.includes(' on"'), off);
  t('★ 按钮上就写清楚了去向（这是唯一会被她读到的地方）',
    /不会发给任何 AI 公司/.test(off));
  t('两个按钮都在，且都调同一个函数',
    (off.match(/toggleMsgFeedback\(7,/g) || []).length === 2);
}
t('渲染时 AI 消息那一排真的挂了这两个按钮',
  /\$\{msgFeedbackHtml\(m\)\}/.test(renderSrc));
t('样式里 on 状态和踩的红色都在', /\.msg-fb-btn\.on/.test(cssSrc) && /\.msg-fb-btn\.on\[data-fb="-1"\]/.test(cssSrc));

console.log('\n[5] 接进系统提示 + token 实测');
{
  const state = {
    moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [], chats: [],
    userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: 'k',
    webSearchProvider: 'tavily', bandAiEnabled: false, studyOn: false,
    // 跟 tests/skill-tok.test.js 量同一份提示词：estimateTokens 有取整，整份提示词长一点短一点，
    // 这里的差值就会漂 ±1。环境不一样的话两边永远有一边假红（2026-10-04 加相册时踩到）。
    thinkSumKey: 'k',
  };
  const promptBox = {
    console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map, Number,
    fetch: async () => ({ ok: true }), state,
    _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
    save() {}, showToast() {}, escHtml: v => String(v),
    pickBrainMemories: () => [], formatBrainForPrompt: () => '', takeProustMoment: () => '',
    getActiveChat: () => null, getMsgPlainText: n => String((n && n.content) || ''),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {}
  };
  promptBox.globalThis = promptBox;
  vm.createContext(promptBox);
  const tokenStart = stateSrc.indexOf('function estimateTokens(text)');
  const tokenEnd = stateSrc.indexOf('function getChatTotalTokens', tokenStart);
  vm.runInContext(stateSrc.slice(tokenStart, tokenEnd), promptBox, { filename: '02-state.js#estimateTokens' });
  vm.runInContext(promptSrc, promptBox, { filename: '05-prompts-api.js' });
  vm.runInContext(SEG, promptBox, { filename: '06-render-msg.js#feedback' });
  // 同 skill-tok：跑腿、相册的说明不在 05 里，不补进来提示词就短一截
  for (const f of ['js/61-errand.js', 'js/60-imgmem.js', 'js/62-album.js', 'js/68-treasure.js', 'js/71-wishbook.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), promptBox, { filename: f });
  }

  const conf = { id: 'm1', nickname: '阿岚', modelName: 'test-model', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 };
  const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
  const build = () => promptBox.buildSystemPrompt(conf, chat, '', null, {});
  promptBox.state.skillsOff = {};
  const withFb = build();
  promptBox.state.skillsOff = { feedback: true };
  const withoutFb = build();
  t('★ 说明真的进了系统提示（挂错地方的话面板开着也没用）',
    withFb.includes('[她的反馈]') && !withoutFb.includes('[她的反馈]'));
  const measured = promptBox.estimateTokens(withFb) - promptBox.estimateTokens(withoutFb);
  const def = vm.runInContext("SKILL_DEFS.find(d => d.key === 'feedback')", promptBox);
  t('技能表里登记了这一项', !!def);
  // ±1 容差：这里的桩和 skill-tok 的不一样（少装几个文件），estimateTokens 带 Math.ceil，
  // 同一段提示词在两个桩里能差 1（2026-10-09 拆塔罗后就是一边 116 一边 117）。精确到个位由 skill-tok 守。
  t('feedback 的 tok 等于关掉它实测的差值（±1）', def && Math.abs(def.tok - measured) <= 1,
    `表中 ${def && def.tok}，实测 ${measured}`);
  t('技能表的说明也写明了不发给 AI 公司', def && /不发给任何 AI 公司/.test(def.desc));
}

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed ? 1 : 0);
