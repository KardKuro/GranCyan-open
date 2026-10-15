'use strict';
// 编辑消息：一字没改也照样发（用户：「即使消息和原消息一样也能发，我觉得这样更好」）
//
// 以前 submitEditMessage 碰到「内容和思考链都没变」就静默关掉编辑框、什么都不做。
// 她点「提交并重新生成」就是想要一条新回复 —— 什么都没发生，看着像按钮坏了。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', '08-edit-trash.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

function run(body, thinking) {
  const calls = [];
  const chat = {
    headId: 3, isGroupChat: false,
    nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '第一句' },
      2: { id: 2, parentId: 1, role: 'assistant', content: '回' },
      3: { id: 3, parentId: 2, role: 'user', content: '帮我讲讲这题', userThinking: null, images: null }
    }
  };
  let idSeq = 100;
  const wrap = {
    querySelector: sel => (sel === '.msg-edit-body' ? { value: body } : sel === '.msg-edit-think' ? { value: thinking || '' } : null)
  };
  const box = {
    getActiveChat: () => chat, nextId: () => ++idSeq, estimateTokens: s => String(s).length,
    save: () => calls.push('save'), renderMessages: () => calls.push('render'),
    _invalidateNodeCache: () => calls.push('invalidate'),
    getActiveChatModelIds: () => ['m1'], state: { configs: [{ id: 'm1' }] },
    getMessagePath: (c, id) => [id], callAPI: (conf, p, c, id) => calls.push('callAPI:' + id),
    callAPIMulti: () => calls.push('multi'), callGroupChat: () => calls.push('group'),
    Date, console
  };
  vm.createContext(box);
  vm.runInContext(src + ';this.submitEditMessage=submitEditMessage;', box);
  box.submitEditMessage(3, { closest: () => wrap });
  return { chat, calls };
}

console.log('\n编辑消息重发');
{
  const { chat, calls } = run('帮我讲讲这题');
  const fresh = Object.values(chat.nodes).filter(n => n.id > 99);
  t('★ 一字没改也开了一条新分支', fresh.length === 1 && fresh[0].content === '帮我讲讲这题' && fresh[0].parentId === 2, fresh);
  t('★ 一字没改也重新生成了', calls.includes('callAPI:' + (fresh[0] && fresh[0].id)), calls);
  t('  视图切到新分支，旧那条还在（左右切得回去）', chat.headId === (fresh[0] && fresh[0].id) && chat.nodes[3].content === '帮我讲讲这题');
}
{
  const { chat, calls } = run('换个说法');
  const fresh = Object.values(chat.nodes).filter(n => n.id > 99);
  t('  改了内容照旧：新分支 + 重新生成', fresh.length === 1 && fresh[0].content === '换个说法' && calls.some(c => c.startsWith('callAPI:')));
}
{
  const { chat, calls } = run('   ');
  t('  清空了还是不发（空消息没意义）', Object.keys(chat.nodes).length === 3 && !calls.some(c => c.startsWith('callAPI')));
}

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
