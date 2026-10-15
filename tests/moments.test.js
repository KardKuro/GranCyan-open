'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stateSrc = read('js/02-state.js');
const coreSrc = read('js/01-core.js');
const bootSrc = read('js/14-boot-brain-hub.js');
const momentsSrc = read('js/51-moments.js');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  console.log('\n[1] state 初值与完整持久化往返');
  const initEnd = stateSrc.indexOf('let _saveTimer');
  const initBox = { nextId: (() => { let n = 0; return () => ++n; })(), isMobileLayout: () => false };
  vm.createContext(initBox);
  vm.runInContext(stateSrc.slice(0, initEnd) + '\nthis.__state = state;', initBox, { filename: '02-state.js#initial' });
  t('★ state 初值包含空 moments 数组', Array.isArray(initBox.__state.moments) && initBox.__state.moments.length === 0);

  const payload = [{
    id: 731,
    author: 'user',
    ts: 1788220800123,
    text: '窗边刚刚落了一阵雨。',
    images: [],
    likes: [],
    comments: []
  }];
  const store = new Map();
  const state = new Proxy({
    chats: [], configs: [], memories: [], recentMemos: [], trash: [], moments: payload
  }, { get: (target, key) => key in target ? target[key] : undefined });
  const saveBox = {
    console,
    state,
    idbSet: async (key, value) => { store.set(key, value); },
    showToast: () => {},
    musicVisNorm: value => value || 'aurora',
    musicLyricStyleNorm: value => value || 'scroll',
    clearTimeout: () => {},
    setTimeout: () => 1
  };
  vm.createContext(saveBox);
  // 从 SAVE SECTION 标记起切，不是从 `async function _doSave()` 起 ——
  // _doSave 依赖它上面那个模块级基线变量（configs 版本号用），从函数那行起切
  // 会把声明切掉，跑起来是 ReferenceError 而不是断言红（2026-09-22 栽过）。
  const saveStart = stateSrc.indexOf('// ── SAVE SECTION ──');
  if (saveStart < 0) throw new Error('02-state.js 里的 SAVE SECTION 标记没了 —— 切片锚点失效');
  const saveEnd = stateSrc.indexOf('// TOKEN ESTIMATION', saveStart);
  vm.runInContext(stateSrc.slice(saveStart, saveEnd), saveBox, { filename: '02-state.js#_doSave' });
  await vm.runInContext('_doSave()', saveBox);

  const loadBox = {
    console,
    idbGet: async key => store.has(key) ? store.get(key) : null,
    idbSet: async (key, value) => { store.set(key, value); },
    localStorage: { getItem: () => null }
  };
  vm.createContext(loadBox);
  const loadStart = coreSrc.indexOf('async function loadStateFromDB()');
  const loadEnd = coreSrc.indexOf('// STATE', loadStart);
  vm.runInContext(coreSrc.slice(loadStart, loadEnd), loadBox, { filename: '01-core.js#loadStateFromDB' });
  const saved = await vm.runInContext('loadStateFromDB()', loadBox);

  const bootBox = { saved, state: {} };
  vm.createContext(bootBox);
  const bootStart = bootSrc.indexOf('  state.lifeReceipts');
  const bootEnd = bootSrc.indexOf('  state.bubbleThemes', bootStart);
  vm.runInContext(bootSrc.slice(bootStart, bootEnd), bootBox, { filename: '14-boot-brain-hub.js#moments-assign' });
  t('★ 持久化四道关完整往返后 moments 一字不差', same(bootBox.state.moments, payload), JSON.stringify(bootBox.state.moments));

  console.log('\n[2] 作者身份、删卡降级与排序');
  const elements = {
    momentsList: { innerHTML: '' },
    momentsModal: { classList: { add() {}, remove() {} } },
    momentsInput: { value: '' }
  };
  let next = 40;
  let nextCalls = 0;
  let saves = 0;
  const box = {
    console,
    Date,
    state: { moments: [], chars: [], configs: [], userName: '小明', userAvatar: '' },
    nextId: () => { nextCalls++; return ++next; },
    save: () => { saves++; },
    document: { getElementById: id => elements[id] || null },
    showToast: () => {}
  };
  vm.createContext(box);
  vm.runInContext(momentsSrc, box, { filename: '51-moments.js' });

  box.state.configs = [
    { id: 1, nickname: '阿岚', avatar: 'avatar-a' },
    { id: 2, nickname: '小克', avatar: 'avatar-b' }
  ];
  box.state.configs.reverse();
  const reordered = vm.runInContext("momentsAuthorInfo('阿岚')", box);
  t('★ 卡片重排后仍按名字找到原作者', reordered.name === '阿岚' && reordered.avatar === 'avatar-a');

  box.state.configs = box.state.configs.filter(card => card.nickname !== '阿岚');
  box.state.moments = [{ id: 8, author: '阿岚', ts: 100, text: '名字应该留下来', images: [], likes: [], comments: [] }];
  let renderError = null;
  try { vm.runInContext('momentsRender()', box); } catch (error) { renderError = error; }
  t('★ 作者卡删除后渲染不崩且动态仍显示原作者名',
    !renderError && elements.momentsList.innerHTML.includes('阿岚') && elements.momentsList.innerHTML.includes('名字应该留下来'));

  box.state.moments = [
    { id: 1, author: 'user', ts: 100, text: 'old' },
    { id: 2, author: 'user', ts: 300, text: 'new' },
    { id: 3, author: 'user', ts: 200, text: 'middle' }
  ];
  const order = vm.runInContext('momentsSorted().map(item => item.id)', box);
  t('★ 动态按 ts 倒序', same(Array.from(order), [2, 3, 1]), JSON.stringify(order));

  console.log('\n[3] 共享 ID 分配器');
  box.state.moments = [{ id: 40, author: 'user', ts: 1, text: 'existing' }];
  const made = vm.runInContext("momentsAddUser('  新动态  ', 500)", box);
  const ids = box.state.moments.map(item => item.id);
  t('★ 用户发布使用 nextId 且不会与已有 moment id 撞',
    nextCalls === 1 && made.id === 41 && new Set(ids).size === ids.length
      && made.author === 'user' && made.text === '新动态' && made.ts === 500
      && same(made.images, []) && same(made.likes, []) && same(made.comments, []) && saves === 1);

  const idBox = {
    state: {
      chats: [{ id: 3, nodes: { 7: { id: 7 } } }],
      configs: [{ id: 11 }],
      moments: [{ id: 87 }]
    }
  };
  vm.createContext(idBox);
  const counterStart = coreSrc.indexOf('let _nodeIdCounter = 0;');
  const counterEnd = coreSrc.indexOf('function dedupeChatIds()', counterStart);
  vm.runInContext(coreSrc.slice(counterStart, counterEnd), idBox, { filename: '01-core.js#reseedIdCounter' });
  const afterRestart = vm.runInContext('reseedIdCounter(); nextId()', idBox);
  t('★ 重启播种包含 moment id，下一号不会碰已有动态', afterRestart === 88, String(afterRestart));

  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
