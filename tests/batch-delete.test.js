/* 批量删消息不许连带抹掉后面的对话。
 *
 * 以前 deleteSelectedMessages 删完勾选的节点后跑一遍「清理孤儿」：父节点不在了的一律删。
 * 于是 20 句里只勾第 3 句，第 4～20 句全被抹掉，不进回收站、不弹确认；
 * headId 指着第 20 句（没被勾，所以没挪），随即也被清掉，整个对话看着是空的。
 * 单条删（deleteSingleMessage）一直是把子节点接回父节点的，批量删漏了这一步。
 *
 * 这里在 vm 里真跑 08-edit-trash.js 的那个函数，不是正则看源码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', '08-edit-trash.js'), 'utf8');
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

// 线性对话 m1 ← m2 ← … ← mN，head = mN
function linear(n) {
  const nodes = {};
  for (let i = 1; i <= n; i++) nodes['m' + i] = { id: 'm' + i, parentId: i > 1 ? 'm' + (i - 1) : null, content: 'c' + i };
  return { id: 'chat1', title: 't', nodes, headId: 'm' + n };
}
function run(chat, selected) {
  const sb = {
    state: { selectedMessageIds: new Set(selected), trash: [] },
    getActiveChat: () => chat,
    pruneDeadFavs() {}, exitSelectMode() {}, save() {}, renderChatList() {}, renderMessages() {},
    Date, Math,
  };
  vm.createContext(sb);
  vm.runInContext(funcBody(src, 'deleteSelectedMessages'), sb);
  vm.runInContext('deleteSelectedMessages()', sb);
  return sb.state;
}
// 从 head 往上走到根，得到可见路径
function pathOf(chat) {
  const out = []; let cur = chat.headId;
  while (cur) { const n = chat.nodes[cur]; if (!n) { out.push('!' + cur); break; } out.unshift(cur); cur = n.parentId; }
  return out;
}

t('funcBody 切得出函数', funcBody(src, 'deleteSelectedMessages').length > 100);

console.log('\n【一】删中间一句');
{
  const chat = linear(20);
  const st = run(chat, ['m3']);
  const p = pathOf(chat);
  t('后面 17 句都还在', Object.keys(chat.nodes).length === 19, Object.keys(chat.nodes).length);
  t('head 没挪', chat.headId === 'm20', chat.headId);
  t('路径 = m1 m2 m4 … m20，无断链', p.length === 19 && p[2] === 'm4' && !p.some(x => x[0] === '!'), p);
  t('被删那句进了回收站', st.trash.length === 1 && st.trash[0].message.id === 'm3');
}

console.log('\n【二】删连续几句（含 head）');
{
  const chat = linear(6);
  run(chat, ['m5', 'm6']);
  t('head 退到 m4', chat.headId === 'm4', chat.headId);
  t('路径 m1..m4', pathOf(chat).join() === 'm1,m2,m3,m4', pathOf(chat));
}
{
  const chat = linear(8);
  run(chat, ['m3', 'm4', 'm6']);
  t('跳着删三句：路径 m1 m2 m5 m7 m8', pathOf(chat).join() === 'm1,m2,m5,m7,m8', pathOf(chat));
}

console.log('\n【三】删第一句（根）');
{
  const chat = linear(4);
  run(chat, ['m1']);
  t('m2 成了新根', !!chat.nodes.m2 && chat.nodes.m2.parentId === null, chat.nodes.m2);
  t('路径 m2 m3 m4', pathOf(chat).join() === 'm2,m3,m4', pathOf(chat));
}

console.log('\n【四】分支：另一条分支不受影响');
{
  const chat = linear(4);
  chat.nodes.b3 = { id: 'b3', parentId: 'm2', content: 'branch' };   // m2 下面的另一个回答
  chat.nodes.b4 = { id: 'b4', parentId: 'b3', content: 'branch2' };
  run(chat, ['m2']);
  t('两条分支的第三句都接到 m1', !!chat.nodes.m3 && !!chat.nodes.b3 && chat.nodes.m3.parentId === 'm1' && chat.nodes.b3.parentId === 'm1');
  t('分支节点一个没少', !!chat.nodes.b4 && !!chat.nodes.m4);
  t('当前路径 m1 m3 m4', pathOf(chat).join() === 'm1,m3,m4', pathOf(chat));
}

console.log('\n【五】全删');
{
  const chat = linear(3);
  run(chat, ['m1', 'm2', 'm3']);
  t('head 为空', chat.headId === null, chat.headId);
  t('节点清空', Object.keys(chat.nodes).length === 0);
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
