/* 原样存的自由文本字段，读回来必须还是字符串。
 *
 * _doSave 把用户名、各家 API Key、语音模型名、头像地址这些直接 idbSet(字符串)，
 * 而 loadStateFromDB 以前一律 JSON.parse：用户名「520」读回来是数字 520，「null」变 null，
 * 「true」变布尔；之后 (state.userName || '').trim() 之类直接 TypeError。
 * 兼容：以前 stringify 过的旧值（带引号的 "\"用户\""）照样解开。
 *
 * 在 vm 里真跑 01-core.js 的 loadStateFromDB，idbGet 换成内存表。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'js', '01-core.js'), 'utf8');
function funcBody(s, sig) {
  const i = s.indexOf(sig);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

async function load(db) {
  const stubs = {
    idbGet: async k => (k in db ? db[k] : null), idbSet: async () => {},
    localStorage: { getItem: () => null }, console: { warn() {}, log() {} },
    JSON, Number, String, Array, Object, Math, Date, Promise, parseInt, parseFloat, isNaN,
  };
  const ctx = vm.createContext(new Proxy(stubs, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : (k === Symbol.unscopables ? undefined : globalThis[k])),
  }));
  vm.runInContext(funcBody(core, 'async function loadStateFromDB(') + '\nthis.__load = loadStateFromDB;', ctx);
  return ctx.__load();
}

(async () => {
  const s = await load({
    kuro_chats: '[]',
    kuro_userName: '520', kuro_errandWorker: 'null', kuro_nurseryName: 'true',
    kuro_voiceKey: '123456789', kuro_thinkSumKey: 'sk-abc', kuro_voiceModel: '1.5',
    kuro_webDockSrc: '"https://a.test/pages.json"',   // 旧版 stringify 过的
  });
  t('用户名「520」读回来还是字符串', s.userName === '520', s.userName);
  t('「null」不变成 null', s.errandWorker === 'null', s.errandWorker);
  t('「true」不变成布尔', s.nurseryName === 'true', s.nurseryName);
  t('纯数字的 Key 还是字符串', s.voiceApiKey === '123456789', s.voiceApiKey);
  t('普通 Key 照旧', s.thinkSumKey === 'sk-abc');
  t('模型名「1.5」不变成数字', s.voiceModel === '1.5', s.voiceModel);
  t('以前 stringify 过的旧值照样解开', s.webDockSrc === 'https://a.test/pages.json', s.webDockSrc);
  t('没存过的走默认值', s.userAvatar === '' && s.callBg === '');
  t('非文本字段不受影响（chats 还是数组）', Array.isArray(s.chats));

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
