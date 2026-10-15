/* id 计数器重播种要把「还可能被引用的号」全算进去。
 *
 * 对话、消息、配置、记忆全从同一个 nextId() 取号，重启后按现存数据的最大 id 重播种。
 * 以前只看 chats / configs / moments，漏了：
 *   - 墓碑（state.deletedChats 的键）：新建 id=N 的对话 → 删掉 → 重启 → 计数器退回 N-1 →
 *     再新建又是 N → 被 isChatDeleted 当成已删，永远不上云、别的设备 merge 也挡掉，零报错；
 *   - 记忆类（memories / recentMemos / brainMemories / groupBoard）：撞号后
 *     filter(m => m.id !== id) 一删删两条，只有一条进回收站；
 *   - 回收站里的单条消息 / 记忆：恢复时保留原 id，号被别人用了就撞上。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', '01-core.js'), 'utf8');
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

function nextAfterReseed(state) {
  const ctx = vm.createContext({ state, parseInt, Math, Object, Array });
  vm.runInContext('var _nodeIdCounter = 0;\n' + funcBody(src, 'nextId') + '\n' + funcBody(src, 'reseedIdCounter') + '\nreseedIdCounter();', ctx);
  return vm.runInContext('nextId()', ctx);
}
const base = () => ({ chats: [{ id: 10, nodes: { 11: {}, 12: {} } }], configs: [{ id: 3 }], moments: [] });

t('对照组：只有对话时发 13', nextAfterReseed(base()) === 13);

const cases = [
  ['墓碑里删掉的对话 id', s => { s.deletedChats = { 50: { at: 1 } }; }, 51],
  ['普通记忆', s => { s.memories = [{ id: 60 }]; }, 61],
  ['最近记忆', s => { s.recentMemos = [{ id: 61 }]; }, 62],
  ['高级记忆', s => { s.brainMemories = [{ id: 70 }]; }, 71],
  ['群聊留言板', s => { s.chats[0].groupBoard = [{ id: 80 }]; }, 81],
  ['回收站里的单条消息', s => { s.trash = [{ type: 'message', message: { id: 90 } }]; }, 91],
  ['回收站里的记忆', s => { s.trash = [{ type: 'memory', memoryData: { id: 95 } }]; }, 96],
  ['回收站里的整段对话', s => { s.trash = [{ type: 'chat', chatData: { id: 97, nodes: {} } }]; }, 98],
];
for (const [name, mut, want] of cases) {
  const s = base(); mut(s);
  const got = nextAfterReseed(s);
  t(`${name}：下一个号不撞（${want}）`, got === want, got);
}
{
  const s = base(); s.trash = [null, {}, { type: 'fav' }]; s.memories = [null]; s.deletedChats = { abc: 1 };
  t('脏数据不抛、不影响', nextAfterReseed(s) === 13);
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
