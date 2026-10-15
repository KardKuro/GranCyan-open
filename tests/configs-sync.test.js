// configs 跨设备同步的行为保护。跑法：node tests/configs-sync.test.js
// 这里故意执行生产代码切片，不拿源码正则冒充行为验证。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

let failed = 0;
function t(name, yes, detail) {
  console.log(`  ${yes ? '✓' : '✗'} ${name}`);
  if (!yes) {
    failed++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

function between(src, from, to, file) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`切片锚点没找到: ${file} / ${from}`);
  return src.slice(a, b);
}

const stateSrc = read('js/02-state.js');
const coreSrc = read('js/01-core.js');
const bootSrc = read('js/14-boot-brain-hub.js');
const db = new Map();
const writes = [];
const state = { chats: [], configs: [], configsVer: -1 };
const box = {
  console: { log() {}, warn() {}, error() {} },
  state,
  idbSet: async (key, value) => { writes.push([key, value]); db.set(key, value); },
  idbGet: async key => db.has(key) ? db.get(key) : null,
  localStorage: { getItem: () => null },
  showToast() {},
  musicVisNorm: value => value || {},
  musicLyricStyleNorm: value => value || {},
  setTimeout: () => 1,
  clearTimeout() {},
};
box.globalThis = box;
vm.createContext(box);

const saveSection = between(
  stateSrc,
  '// ── SAVE SECTION ──',
  'function estimateTokens(text)',
  'js/02-state.js'
);
vm.runInContext(saveSection, box, { filename: 'js/02-state.js#SAVE_SECTION' });

const loadFn = between(
  coreSrc,
  'async function loadStateFromDB() {',
  'function nextId()',
  'js/01-core.js'
);
vm.runInContext(loadFn, box, { filename: 'js/01-core.js#loadStateFromDB' });

const bootAssign = between(
  bootSrc,
  '  if (saved.chats)   state.chats   = saved.chats;',
  '  state.memories       = saved.memories;',
  'js/14-boot-brain-hub.js'
);

const cloudAccept = between(
  coreSrc,
  '                    const _cloudCfgVer = Number(s.configsVer) || 0;',
  '                    // 云端记忆与本地按条目合并',
  'js/01-core.js'
);
vm.runInContext(`async function __acceptCloud(s) {\n${cloudAccept}\n}`, box,
  { filename: 'js/01-core.js#configs-cloud-accept' });

(async () => {
  console.log('\n[configs-sync] 三道持久化门 + 首次本地修改');
  const local = [{ id: 1, nickname: '本地 Claude', maxTokens: 32000, thinkingMode: 'always' }];
  db.set('kuro_chats', '[]');
  db.set('kuro_configs', JSON.stringify(local));
  db.set('kuro_configsVer', '7');

  box.saved = await box.loadStateFromDB();
  t('loadStateFromDB 真从 kuro_configsVer 读回版本号', box.saved.configsVer === 7, box.saved.configsVer);

  vm.runInContext(bootAssign, box, { filename: 'js/14-boot-brain-hub.js#configs-boot' });
  t('启动赋值块把 configsVer 落进 state', state.configsVer === 7, state.configsVer);
  t('启动赋值块把 configs 一起落进 state', state.configs[0]?.maxTokens === 32000);

  state.configs[0].maxTokens = 64000;
  await box._doSave();
  t('启动后第一次本地改 configs，configsVer 会 +1', state.configsVer === 8, state.configsVer);
  t('_doSave 把新 configs 写进 IDB', JSON.parse(db.get('kuro_configs'))[0].maxTokens === 64000);
  t('_doSave 把同一版 configsVer 写进 IDB', db.get('kuro_configsVer') === '8', db.get('kuro_configsVer'));

  console.log('\n[configs-sync] 平局裁决必须对称');
  const A = [
    { id: 2, nickname: 'Gemini', apiKey: '', maxTokens: 8000 },
    { id: 1, nickname: 'Claude', apiKey: 'sk-a', maxTokens: 32000 },
  ];
  const B = [
    { id: 1, nickname: 'Claude', apiKey: '', maxTokens: 8000 },
    { id: 3, nickname: 'GPT', apiKey: 'sk-b', maxTokens: 128000 },
    { id: 2, nickname: 'Gemini', apiKey: 'gm-key', maxTokens: 1000000 },
  ];
  const ab = box._mergeConfigs(A, B);
  const ba = box._mergeConfigs(B, A);
  t('_mergeConfigs(A, B) 与 _mergeConfigs(B, A) 完全相等',
    JSON.stringify(ab) === JSON.stringify(ba), { ab, ba });
  t('对称合并保住两端独有配置，并按 id 排序',
    JSON.stringify(ab.map(c => c.id)) === '[1,2,3]', ab.map(c => c.id));
  t('同 id 时填得更满的配置获胜', ab.find(c => c.id === 2)?.apiKey === 'gm-key');

  console.log('\n[configs-sync] 全新设备接收云端 0 版并立即落盘');
  state.configs = [{ id: 1, nickname: '工厂配置', apiKey: '', maxTokens: 8000 }];
  state.configsVer = -1;
  writes.length = 0;
  const cloud = [{ id: 9, nickname: '云端 Gemini', apiKey: 'gm-live', maxTokens: 1000000 }];
  await box.__acceptCloud({ configs: cloud, configsVer: 0 });
  await Promise.resolve();

  t('本地 -1 时云端 0 版能被接受',
    state.configsVer === 0 && state.configs[0]?.apiKey === 'gm-live',
    { ver: state.configsVer, configs: state.configs });
  const cfgWrite = writes.find(([key]) => key === 'kuro_configs');
  const verWrite = writes.find(([key]) => key === 'kuro_configsVer');
  t('接受云端后真的调用 idbSet 写 kuro_configs',
    !!cfgWrite && JSON.parse(cfgWrite[1])[0].apiKey === 'gm-live', cfgWrite);
  t('接受云端后真的调用 idbSet 写 kuro_configsVer',
    !!verWrite && verWrite[1] === '0', verWrite);

  console.log(`\n${failed ? '❌' : '✅'} 通过 ${12 - failed} / 失败 ${failed}\n`);
  if (failed) process.exitCode = 1;
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
