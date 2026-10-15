/* 停止键只停**当前对话**。
 *
 * 以前 stopGeneration 把全局 _streamControllers 一锅端：后台另一个对话正生成着也被掐断，
 * 回来一看被贴上「已停止生成」；电脑操控的活也只认一个全局 _agentRunId，两个对话同时跑会喊停错的那个。
 * updateStreamUI 也按「全局有没有流」切 ⏹/＋ —— 后台对话在生成时，当前对话连发送键都被藏了。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'js', '01-core.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'js', '05-prompts-api.js'), 'utf8');
function funcBody(s, name) {
  const i = s.indexOf('function ' + name + '(');
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

function setup() {
  const A = { id: 1, nodes: { 10: { id: 10, streaming: true, content: '' } } };
  const B = { id: 2, nodes: { 20: { id: 20, streaming: true, content: '半句' } } };
  const mk = (chat, runId) => { const c = { aborted: false, gcChat: chat, gcRunId: runId, abort() { this.aborted = true; } }; return c; };
  const cA = mk(A, 'runA'), cB = mk(B, 'runB');
  const posted = [];
  const els = { plus: { style: { display: '' } }, stop: { style: { display: 'none' } } };
  const ctx = vm.createContext({
    Object, Array, Set, console,
    _streamControllers: new Set([cA, cB]),
    _agentRunId: 'runB',      // 全局那个被后开跑的 B 覆盖了
    SERVER_BASE: 'http://127.0.0.1:3000',
    fetch: (u) => { posted.push(u); return Promise.resolve(); },
    getActiveChat: () => A,
    appendWarnBlock: (n, w) => { n.content = (n.content ? n.content + '\n\n' : '') + w; },
    save() { }, renderMessages() { }, renderChatList() { }, updateStreamUI() { }, showToast() { },
    document: { querySelector: () => els.plus, getElementById: () => els.stop },
  });
  vm.runInContext(
    ['_streamBelongsTo', 'chatIsGenerating', 'abortChatStreams'].map(n => funcBody(api, n)).join('\n')
    + '\n' + funcBody(core, 'stopGeneration')
    + '\nthis._updateStreamUI = ' + funcBody(core, 'updateStreamUI').replace('function updateStreamUI', 'function'),
    ctx);
  return { ctx, A, B, cA, cB, posted, els };
}

(async () => {
  let e = setup();
  vm.runInContext('stopGeneration()', e.ctx);
  t('当前对话的流被停', e.cA.aborted);
  t('后台对话的流不动', !e.cB.aborted);
  t('停掉的从集合里摘掉，后台的还在', !e.ctx._streamControllers.has(e.cA) && e.ctx._streamControllers.has(e.cB));
  t('只喊停当前对话的电脑操控活', e.posted.length === 1 && /agent-run\/runA\/stop$/.test(e.posted[0]), e.posted);
  t('全局 _agentRunId（B 的）没被清掉', vm.runInContext('_agentRunId', e.ctx) === 'runB');
  t('当前对话的节点收尾', e.A.nodes[10].streaming === false && /已停止生成/.test(e.A.nodes[10].content));
  t('后台对话的节点不被贴「已停止」', e.B.nodes[20].streaming === true && e.B.nodes[20].content === '半句');

  e = setup();
  e.ctx._streamControllers.delete(e.cB); e.ctx._streamControllers.delete(e.cA);
  e.A.agentRunId = 'runB'; e.ctx._agentRunId = 'runB';
  vm.runInContext('stopGeneration()', e.ctx);
  t('流已断、活还在跑：全局 runId 属于当前对话时照样喊停', e.posted.length === 1 && /runB\/stop$/.test(e.posted[0]), e.posted);
  e = setup();
  e.ctx._streamControllers.clear(); e.A.agentRunId = 'runA';
  vm.runInContext('stopGeneration()', e.ctx);
  t('全局 runId 是别的对话的：不去喊停它', e.posted.length === 0, e.posted);

  e = setup();
  e.ctx._streamControllers.delete(e.cA);    // 只剩后台 B 在生成
  vm.runInContext('_updateStreamUI()', e.ctx);
  t('后台对话在生成：当前对话的 ＋ 还在、⏹ 不出', e.els.plus.style.display === '' && e.els.stop.style.display === 'none');
  e.ctx._streamControllers.add(e.cA);
  vm.runInContext('_updateStreamUI()', e.ctx);
  t('当前对话在生成：换成 ⏹', e.els.plus.style.display === 'none' && e.els.stop.style.display === 'grid');

  const render = fs.readFileSync(path.join(__dirname, '..', 'js', '06-render-msg.js'), 'utf8');
  t('renderMessages 里刷 ⏹/＋（换对话后按钮跟着对话走）', /updateStreamUI\(\)/.test(funcBody(render, 'renderMessages')));
  t('拿到 runId 时挂到流上', /ctrl\.gcRunId = j\.runId/.test(api));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
