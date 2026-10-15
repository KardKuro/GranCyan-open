/* 生成途中页面被关 / App 被杀：streaming:true 已经落盘，重开后不许永远卡在「思考中」。
 *
 * handleSend 的 save() 是防抖的，callAPI 同步就建了 streaming:true 的空节点，
 * 所以 IndexedDB 里存的几乎一定是生成中状态。以前启动时没人清它：没有 controller、停止键不出、
 * 气泡永远是思考猫，还会被云同步推到别的设备上一起卡。
 *
 * 在 vm 里真跑 01-core.js 的 clearStaleStreaming + 05 的 appendWarnBlock；
 * 另外确认启动流程真的调用了它（这一条只能看源码：14-boot 的启动函数依赖整页环境）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'js', '01-core.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'js', '05-prompts-api.js'), 'utf8');
const boot = fs.readFileSync(path.join(__dirname, '..', 'js', '14-boot-brain-hub.js'), 'utf8');
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

const ctx = vm.createContext({ Object, Array });
vm.runInContext(funcBody(api, 'appendWarnBlock') + '\n' + funcBody(core, 'clearStaleStreaming'), ctx);
const run = chats => vm.runInContext('clearStaleStreaming', ctx)(chats);
const text = n => (n.blocks || []).map(b => b.text).join('|') + '#' + (n.content || '');

{
  const chats = [{
    id: 1, nodes: {
      1: { id: 1, role: 'user', content: 'hi' },
      2: { id: 2, role: 'ai', content: '', blocks: [{ type: 'thinking', text: '嗯…' }], streaming: true },
      3: { id: 3, role: 'ai', content: 'x', variants: [{ content: '半截', streaming: true }, { content: 'ok' }] },
    },
  }, {
    id: 2, agentRunId: 'r1', agentRunClaimed: false,
    nodes: { 5: { id: 5, role: 'ai', content: '', streaming: true } },
  }];
  const n = run(chats);
  t('数出 3 条（节点 + 变体 + 可接回的）', n === 3, n);
  t('卡住的节点解除生成中', chats[0].nodes[2].streaming === false);
  t('而且留了一句提示，不是只剩 💭 的空气泡', /没收完/.test(text(chats[0].nodes[2])), text(chats[0].nodes[2]));
  t('变体也解除', chats[0].nodes[3].variants[0].streaming === false && /没收完/.test(text(chats[0].nodes[3].variants[0])));
  t('好的变体不动', !chats[0].nodes[3].variants[1].blocks);
  t('电脑上还能接回的：只清标志不加提示（找回时整条覆写）', chats[1].nodes[5].streaming === false && !chats[1].nodes[5].blocks);
  t('没东西可清时返回 0', run(chats) === 0);
  t('脏数据不抛', run([null, {}, { nodes: { a: null } }]) === 0);
}

{
  const i = boot.indexOf('clearStaleStreaming(state.chats)');
  const j = boot.indexOf('state.activeChatId = saved.activeChatId');
  t('启动流程调用了它，而且在恢复上次对话之前', i > 0 && j > i, [i, j]);
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
