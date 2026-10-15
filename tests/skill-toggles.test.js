// 技能开关：把用不上的常驻技能说明从系统提示里摘掉
// 跑法：node tests/skill-toggles.test.js
//
// 背景（2026-08-19）：每个技能都是一段**常驻**系统提示，不管用不用每轮都付钱。
// 实测用户的系统提示 4060 token，其中一千七百多是这些技能说明的固定开销。
// 和聊天历史不一样 —— 历史长了还有裁剪兜着，这些是雷打不动的。
//
// 这个测试守三件事：
//   1) 关掉一个技能，它那段真的从提示里消失了（不是只改了个变量）；
//   2) 关一个不许误伤别的（对照组：其余每一段都必须还在，逐条查）；
//   3) 默认（skillsOff 为空 / 为坏数据）必须是**全开** —— 默认关的话，
//      老用户升级后会静默少掉一堆能力，而且没有任何提示。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')));

const ctx = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map,
  fetch: async () => ({ ok: true }),
  state: {
    memories: [], userName: '小明', bandAiEnabled: false,
    webSearchApiKey: 'k', webSearchProvider: 'tavily', studyOn: false,
    skillsOff: {},
  },
  _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  save() {}, showToast() {}, escHtml: s => String(s),
  estimateTokens: s => {
    const str = String(s || '');
    const cjk = (str.match(/[一-鿿]/g) || []).length;
    return cjk + Math.ceil((str.length - cjk) / 4);
  },
  pickBrainMemories: () => [],
  formatBrainForPrompt: () => '',
  takeProustMoment: () => '\n\n[忽然想起] 那天凌晨三点的屏幕光',
  stickerTagForApi: s => String(s || ''),
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  window: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('05-prompts-api.js'), ctx);

const conf = { id: 'm1', nickname: '克克', modelName: 'claude-opus-5',
               apiBase: 'https://api.anthropic.com/v1/messages', maxTokens: 200000, maxReplyTokens: 4096 };
const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
const build = () => ctx.buildSystemPrompt(conf, chat, '你好', null, {});

// 每个技能在提示里的「指纹」：关掉后这段字必须消失。
// 用技能自己的标题行，不用 [[指令]] —— 指令名可能在别的段里被提到（比如
// 普鲁斯特那段就提了 [[BRAIN_ADD]]），拿它当判据会漏报。
const FINGERPRINT = {
  sticker:    '[表情包技能]',
  imgSearch:  '[图片搜索技能]',
  voice:      '[语音消息技能]',
  dial:       '[来电技能]',
  haunt:      '[鬼味界面技能]',
  glitch:     '[崩坏关键词技能]',
  quote:      '[引用消息技能]',
  math:       '[数学公式]',
  endChat:    '[结束对话技能]',
  memSkill:   '[记忆技能]',
  brainSkill: '[高级记忆技能]',
  proust:     '[普鲁斯特池]',
};

console.log('\n[1] 默认必须全开（默认关 = 老用户静默少功能）');
{
  ctx.state.skillsOff = {};
  const p = build();
  let allOn = true;
  for (const [k, fp] of Object.entries(FINGERPRINT)) {
    if (!p.includes(fp)) { allOn = false; t(`默认开着：${k}`, false, `找不到 ${fp}`); }
  }
  if (allOn) t('默认状态下 12 段技能全在', true);

  // 坏数据也得当成全开，不能因为存了个 null 就把功能全关了
  for (const bad of [null, undefined, 'x', 0]) {
    ctx.state.skillsOff = bad;
    t(`skillsOff = ${JSON.stringify(bad)} → 仍然全开`, build().includes('[表情包技能]'));
  }
  ctx.state.skillsOff = {};
}

console.log('\n[2] 关一个就少一段，而且不许误伤别人（逐条对照）');
{
  const keys = Object.keys(FINGERPRINT);
  let ok = true;
  for (const k of keys) {
    ctx.state.skillsOff = { [k]: true };
    const p = build();
    if (p.includes(FINGERPRINT[k])) {
      ok = false; t(`关掉 ${k} → 它那段消失`, false, `${FINGERPRINT[k]} 还在`);
    }
    // 对照组：其余每一段都必须原样还在。
    // 没有这一圈的话，「skillOn 写成恒假、整片提示全没了」也能让上面那句变绿。
    for (const other of keys) {
      if (other === k) continue;
      if (!p.includes(FINGERPRINT[other])) {
        ok = false; t(`关 ${k} 时误伤了 ${other}`, false, `${FINGERPRINT[other]} 不见了`);
      }
    }
  }
  if (ok) t(`12 个技能逐个关，各关各的、互不误伤（${keys.length}×${keys.length} 组）`, true);
}

console.log('\n[3] 关掉的东西真的省到了 token');
{
  ctx.state.skillsOff = {};
  const full = ctx.estimateTokens(build());
  ctx.state.skillsOff = { dial: true, haunt: true, glitch: true, proust: true };
  const lean = ctx.estimateTokens(build());
  t('关掉 4 段后提示变短', lean < full, `${full} → ${lean}`);
  // 别只查「变短了」：少一个字也算变短。这四段实测一千出头，给个宽松下限。
  t('省下来的量对得上数量级（≥600 token）', full - lean >= 600, `实际省了 ${full - lean}`);

  // SKILL_DEFS 是 const 声明，落在 vm 的全局词法环境里、不挂到 ctx 上，只能求值拿
  const SKILL_DEFS = vm.runInContext('SKILL_DEFS', ctx);
  const defs = SKILL_DEFS.map(d => d.key);
  t('SKILL_DEFS 覆盖了所有有指纹的技能',
    Object.keys(FINGERPRINT).every(k => defs.includes(k)),
    Object.keys(FINGERPRINT).filter(k => !defs.includes(k)).join(','));
  t('skillsOffTokens 报的是被关掉的那几段', (() => {
    ctx.state.skillsOff = { dial: true };
    const dial = SKILL_DEFS.find(d => d.key === 'dial');
    return ctx.skillsOffTokens() === dial.tok;
  })());
}

console.log('\n[4] setSkillOn 的读写往返');
{
  ctx.state.skillsOff = {};
  ctx.setSkillOn('dial', false);
  t('关掉后 skillOn 返回 false', ctx.skillOn('dial') === false);
  t('关掉后落在 skillsOff 里（这就是要存盘的东西）', ctx.state.skillsOff.dial === true);
  ctx.setSkillOn('dial', true);
  t('再打开后 skillOn 返回 true', ctx.skillOn('dial') === true);
  // 开着的不留痕：否则 skillsOff 会慢慢长成一份 false 的名单，云同步也跟着背
  t('开着的不在 skillsOff 里留 false', !('dial' in ctx.state.skillsOff));
}

console.log('\n[5] 持久化三道关都在（漏一道 = 刷新即失，零报错）');
{
  const save = fs.readFileSync(path.join(ROOT, 'js', '02-state.js'), 'utf8');
  const load = fs.readFileSync(path.join(ROOT, 'js', '01-core.js'), 'utf8');
  const boot = fs.readFileSync(path.join(ROOT, 'js', '14-boot-brain-hub.js'), 'utf8');
  t('① _doSave 写 kuro_skillsOff', /idbSet\('kuro_skillsOff'/.test(save));
  t('② loadStateFromDB 读 kuro_skillsOff', /skillsOff:\s*await g\('kuro_skillsOff'/.test(load));
  t('③ 启动时赋值给 state.skillsOff', /state\.skillsOff\s*=/.test(boot));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
