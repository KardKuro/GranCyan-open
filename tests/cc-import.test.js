// 导入 claude.ai 老对话（js/60-cc-import.js）回归测试。
// 跑法：node tests/cc-import.test.js
//
// 这个功能出错全是**静默**的：导进来的对话看着好好的，但
//   - 分支串错了父亲 / 兄弟顺序反了 → 左右切分支切到的不是那一条
//   - 自己造了 id → 和计数器撞号，被 mergeCloudChats 按 id 吞掉一整段
//   - 再导一次翻倍 / 删掉的又导回来
//   - 思考链塞进了正文 → 接着聊时模型把当时的思考当成自己说过的话
//   - 图片没了不吭声
// 每一条都单独钉住。样本是按官方导出格式手造的（tests/fixtures/claude-export-sample.json）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SAMPLE = () => JSON.parse(read('tests/fixtures/claude-export-sample.json'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')));
const group = n => console.log('\n' + n);

// 沙箱：60-cc-import.js 整个 + 02-state.js 里的墓碑那一段（同 chat-tombstone.test.js 的切法）
function box(initState) {
  let counter = 5000;
  const ctx = {
    console, Date, Math, JSON, Object, Number, String, Array, Map, Set, Infinity, setTimeout,
    setImmediate, clearImmediate, Buffer,   // JSZip 在 node 里要这几个
    state: Object.assign({ chats: [], deletedChats: {} }, initState || {}),
    estimateTokens: s => Math.ceil(String(s || '').length / 4),
    escHtml: s => String(s),
    reseeded: 0,
  };
  ctx.nextId = () => ++counter;
  ctx.reseedIdCounter = () => {
    ctx.reseeded++;
    let mx = counter;
    for (const c of ctx.state.chats) {
      mx = Math.max(mx, parseInt(c.id) || 0);
      for (const k in (c.nodes || {})) mx = Math.max(mx, parseInt(k) || 0);
    }
    counter = mx;
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const st = read('js/02-state.js');
  const from = st.indexOf('const TOMBSTONE_TTL_DAYS'), to = st.indexOf('async function _doSave');
  if (from < 0 || to < 0) throw new Error('02-state.js 墓碑段切不出来，锚点变了');
  vm.runInContext(st.slice(from, to), ctx, { filename: '02-tombstone-slice.js' });
  vm.runInContext(read('js/60-cc-import.js'), ctx, { filename: '60-cc-import.js' });
  return ctx;
}
const path2 = (chat, id) => { const p = []; let c = id; while (c != null && chat.nodes[c]) { p.unshift(chat.nodes[c]); c = chat.nodes[c].parentId; } return p; };
const byCc = (chat, u) => Object.values(chat.nodes).find(n => n.ccUuid === u);

// ══════════════════════════════════════════════════════════
group('[1] 认文件');
{
  const b = box();
  t('官方 conversations.json（数组）认得出', b.ccDetectExport(SAMPLE()).length === 3);
  t('单个对话对象也认', b.ccDetectExport(SAMPLE()[0]).length === 1);
  t('{conversations:[...]} 也认', b.ccDetectExport({ conversations: SAMPLE() }).length === 3);
  let msg = '';
  try { b.ccDetectExport([{ title: 'x', mapping: {} }]); } catch (e) { msg = e.message; }
  t('ChatGPT 的导出：说清楚是 ChatGPT 的', /ChatGPT/.test(msg), msg);
  msg = '';
  try { b.ccDetectExport({ conversations_url: 'https://storage.example.com/a.zip', projects_url: 'https://storage.example.com/b.zip' }); } catch (e) { msg = e.message; }
  t('新版先寄来的「下载链接清单」：告诉她点 conversations 那个链接', /链接清单/.test(msg) && /conversations/.test(msg), msg);
  msg = '';
  try { b.ccDetectExport({ foo: 1 }); } catch (e) { msg = e.message; }
  t('别的 JSON：认不出就说认不出', /认不出/.test(msg), msg);
}

// ══════════════════════════════════════════════════════════
group('[2] 分支结构 → GranCyan 的节点树');
const b2 = box();
b2.state.chats = [];
const items2 = b2.ccPlanImport(SAMPLE(), b2.state.chats, b2.state.deletedChats, {});
const r2 = b2.ccApplyImport(items2, {});
const chat = b2.state.chats.find(c => c.importedFrom.uuid === 'c0a1e7f2-1111-4a6b-9c1d-000000000001');
{
  t('导入前重播种了计数器', b2.reseeded >= 1);
  t('建了 2 个对话（空对话跳过）', r2.created === 2 && b2.state.chats.length === 2, r2);
  t('11 条里空回复那条被跳过，剩 10 个节点', Object.keys(chat.nodes).length === 10, Object.keys(chat.nodes).length);
  t('跳过的计数对得上', r2.stats.dropped === 1, r2.stats.dropped);
  const ids = Object.keys(chat.nodes).map(Number);
  t('节点 id 全是数字（renderBrainMemList 那类裸插值吃不了字符串）', ids.every(Number.isInteger));
  t('节点 id 和 key 一致', Object.entries(chat.nodes).every(([k, n]) => String(n.id) === k));
  t('对话 id 也是计数器发的', Number.isInteger(chat.id) && chat.id > 5000);
  const a2 = byCc(chat, 'm-0002'), a3 = byCc(chat, 'm-0003'), u1 = byCc(chat, 'm-0001'), u9 = byCc(chat, 'm-0009');
  t('重新生成的两条回复是同一个父亲下的兄弟', a2.parentId === u1.id && a3.parentId === u1.id);
  t('兄弟按时间先后发号（左右切分支的顺序 = 网页上的先后）', a2.id < a3.id);
  t('编辑过的第一句是另一个根（父亲是哨兵 uuid → null）', u1.parentId === null && u9.parentId === null && u1.id < u9.id);
  const a8 = byCc(chat, 'm-0008'), u6 = byCc(chat, 'm-0006');
  t('空回复被跳过后，它的兄弟照样挂在原来的父亲上', a8.parentId === u6.id);
  t('停在最晚写下的那条叶子上', chat.headId === byCc(chat, 'm-0011').id, chat.headId);
  const p = path2(chat, chat.headId).map(n => n.ccUuid);
  t('主线路径对', JSON.stringify(p) === JSON.stringify(['m-0001', 'm-0003', 'm-0004', 'm-0005', 'm-0006', 'm-0008', 'm-0010', 'm-0011']), p);
  const roles = path2(chat, chat.headId).map(n => n.role);
  t('主线 user / ai 严格交替', roles.every((r, i) => r === (i % 2 ? 'ai' : 'user')), roles);
  t('role 用的是 GranCyan 的 ai，不是 assistant', Object.values(chat.nodes).every(n => n.role === 'user' || n.role === 'ai'));
  t('时间戳是原来的时间（毫秒）', u1.timestamp === Date.parse('2026-01-12T14:03:11.200Z'), u1.timestamp);
}

// ══════════════════════════════════════════════════════════
group('[3] 各种块：能保的保，保不了的明说');
{
  const a2 = byCc(chat, 'm-0002');
  t('思考进 blocks 的 thinking 块', a2.blocks[0].type === 'thinking' && /她第一次来/.test(a2.blocks[0].text));
  t('思考**不**进 content（接着聊时会被当成它说过的话发给模型）', a2.content === '小明你好！', a2.content);
  t('reasoning 也有一份（换窗/其它功能读这个）', /她第一次来/.test(a2.reasoning || ''));
  t('claude.ai 自己的思考概括当标题', a2.thinkingSummary === '想着怎么打招呼');
  t('模型名：claude-opus-4-5-20251101 → Claude Opus 4.5', a2.modelNickname === 'Claude Opus 4.5', a2.modelNickname);
  t('AI 节点 modelId 为空（不冒认现在的哪个配置）', a2.modelId === null);
  t('统计：思考 1 段', r2.stats.thinking === 1, r2.stats.thinking);

  const u4 = byCc(chat, 'm-0004');
  const notes = (u4.files || []).find(f => f.name === 'notes.txt');
  t('文字附件原样进 node.files（接着聊时模型读得到）', notes && notes.content === '第一行\n第二行：重要的事');
  const cat = (u4.files || []).filter(f => f.name === 'cat.png');
  t('图片：files 和 files_v2 里同一张只算一次', cat.length === 1, cat.length);
  t('图片没有本体 → 留一张写明的卡片，不是悄悄消失', cat[0] && cat[0].missing === true && /不含图片本体/.test(cat[0].content));
  t('统计：缺 1 个图片/文件', r2.stats.filesMissing === 1, r2.stats.filesMissing);

  const a5 = byCc(chat, 'm-0005');
  t('搜索调用折成一行说明', /🔎 搜了：东京 天气 今天/.test(a5.content));
  t('搜索结果原文不导', !/很长很长的网页原文/.test(JSON.stringify(a5)));
  t('正文在', /东京今天晴。/.test(a5.content));
  t('引用来源附在后面', /来源/.test(a5.content) && /https:\/\/weather\.example\.jp\/tokyo/.test(a5.content));
  t('那句「not supported on your device」不会漏进来', !/not supported/.test(JSON.stringify(chat)));
  const bad = b2.ccMessageToNode({ sender: 'assistant', content: [{ type: 'text', text: '看这个', citations: [
    { details: { url: 'javascript:alert(1)', title: '坏' } }, { details: { url: 'https://ok.example/a', title: '好' } }] }] }, {}, b2.ccNewStats());
  t('引用链接只收 http(s)（javascript: 不拼进 markdown 链接）', !/javascript:/.test(bad.content) && /https:\/\/ok\.example\/a/.test(bad.content), bad.content);
  t('统计：工具结果 2 段没导', r2.stats.toolResults === 2, r2.stats.toolResults);

  const a8 = byCc(chat, 'm-0008');
  t('artifact 正文整段保留', a8.content.includes('<pre>```不是围栏```</pre>'));
  t('正文自带 ``` 时围栏加长，不会被提前合上', /````html\n<h1>小明<\/h1>/.test(a8.content), a8.content.slice(0, 80));
  t('artifact 修改留成 diff', a8.content.includes('- <h1>小明</h1>') && a8.content.includes('+ <h1>阿明</h1>'));
  t('不认识的块：原处留提示 + 计数', /mystery_block/.test(a8.content) && r2.stats.unknownTypes.mystery_block === 1);
  t('统计：2 个 artifact', r2.stats.artifacts === 2, r2.stats.artifacts);
  t('blocks 里相邻的文字段并成一块（不碎成好几个气泡段）', a8.blocks.filter(x => x.type === 'text').length === 1, a8.blocks.length);

  const u10 = byCc(chat, 'm-0010');
  t('语音笔记的文字留下', /谢谢你呀/.test(u10.content));
}

// ══════════════════════════════════════════════════════════
group('[4] 来源标记 & 老格式');
{
  t('对话挂 importedFrom（claude.ai 时期）', chat.importedFrom.from === 'claude.ai' && chat.importedFrom.createdAt === Date.parse('2026-01-12T14:03:11.123Z'));
  t('标题用原标题', chat.title === '初见');
  const old = b2.state.chats.find(c => c.importedFrom.uuid === 'c0a1e7f2-2222-4a6b-9c1d-000000000002');
  t('没标题的用第一句话当标题', old.title === '老格式：没有父指针的一条', old.title);
  t('老格式（没有父指针）标成 linear', old.importedFrom.mode === 'linear');
  const p = path2(old, old.headId).map(n => n.ccUuid);
  t('老格式按顺序串成一条线', JSON.stringify(p) === JSON.stringify(['old-1', 'old-2', 'old-3']), p);
  t('content[] 为空时退回 message.text', path2(old, old.headId)[1].content === '这是回复');
  t('新对话 activeModelIds 是 []（不是 null —— null 会变成全模型一起答）', Array.isArray(chat.activeModelIds) && chat.activeModelIds.length === 0);
}

// ══════════════════════════════════════════════════════════
group('[5] 不撞号');
{
  const b = box();
  // 已有一个对话，id 和消息 id 都很大
  b.state.chats = [{ id: 9000, title: '已有', nodes: { 9001: { id: 9001, parentId: null, role: 'user', content: 'x', timestamp: 1 } }, headId: 9001 }];
  const r = b.ccApplyImport(b.ccPlanImport(SAMPLE(), b.state.chats, {}, {}), {});
  const all = [];
  for (const c of b.state.chats) { all.push(c.id); all.push(...Object.keys(c.nodes).map(Number)); }
  t('所有对话 id + 节点 id 全局不重复', new Set(all).size === all.length);
  t('新号都在已有最大号之后（先 reseed 再发）', b.state.chats.filter(c => c.importedFrom).every(c => c.id > 9001));
  t('原来的对话一个字没动', b.state.chats[0].title === '已有' && Object.keys(b.state.chats[0].nodes).length === 1 && r.created === 2);
}

// ══════════════════════════════════════════════════════════
group('[6] 重复导入不翻倍 / 增量补新消息');
{
  const b = box();
  b.ccApplyImport(b.ccPlanImport(SAMPLE(), b.state.chats, {}, {}), {});
  const n0 = b.state.chats.length;
  const nodes0 = b.state.chats.reduce((s, c) => s + Object.keys(c.nodes).length, 0);
  const plan = b.ccPlanImport(SAMPLE(), b.state.chats, {}, {});
  t('再导一次：全是「已有」/「空」', plan.every(i => i.status === 'same' || i.status === 'empty'), plan.map(i => i.status));
  const r = b.ccApplyImport(plan, {});
  t('再导一次：一个都不建', r.created === 0 && r.updated === 0 && b.state.chats.length === n0);
  t('再导一次：节点数不变', b.state.chats.reduce((s, c) => s + Object.keys(c.nodes).length, 0) === nodes0);

  const twice = b.ccPlanImport([...SAMPLE(), ...SAMPLE()], [], {}, {});
  t('两份导出时间段重叠：同一个对话只算一次', twice.length === 3, twice.length);

  // 她后来在网页上接着聊了两句，又导出了一次
  const s2 = SAMPLE();
  const base = { attachments: [], files: [] };
  s2[0].chat_messages.push(
    Object.assign({ uuid: 'm-0012', parent_message_uuid: 'm-0011', sender: 'human', text: '我又来啦', created_at: '2026-02-01T10:00:00Z', content: [{ type: 'text', text: '我又来啦' }] }, base),
    Object.assign({ uuid: 'm-0013', parent_message_uuid: 'm-0012', sender: 'assistant', text: '欢迎回来', created_at: '2026-02-01T10:00:05Z', content: [{ type: 'text', text: '欢迎回来' }] }, base));
  const plan2 = b.ccPlanImport(s2, b.state.chats, {}, {});
  const it = plan2.find(i => i.uuid === s2[0].uuid);
  t('后来接着聊过的：状态是「补新消息」，+2 条', it.status === 'update' && it.added === 2, [it.status, it.added]);
  const c = b.state.chats.find(x => x.importedFrom.uuid === s2[0].uuid);
  const before = Object.keys(c.nodes).length;
  const r2b = b.ccApplyImport(plan2, {});
  t('补进原来那个对话，不新建', r2b.created === 0 && r2b.updated === 1 && b.state.chats.length === n0);
  t('只多了那 2 条', Object.keys(c.nodes).length === before + 2);
  t('新消息接在原来的节点上', byCc(c, 'm-0012').parentId === byCc(c, 'm-0011').id);
  t('停的位置挪到最新那条', c.headId === byCc(c, 'm-0013').id);

  // 另一种情况：她已经在 GranCyan 里接着这个对话聊了 → 不许把她挪走
  const b3 = box();
  b3.ccApplyImport(b3.ccPlanImport(SAMPLE(), b3.state.chats, {}, {}), {});
  const c3 = b3.state.chats.find(x => x.importedFrom.uuid === s2[0].uuid);
  const mine = 99999;
  c3.nodes[mine] = { id: mine, parentId: c3.headId, role: 'user', content: '在 GranCyan 里接着说', timestamp: Date.now() };
  c3.headId = mine;
  b3.ccApplyImport(b3.ccPlanImport(s2, b3.state.chats, {}, {}), {});
  t('她在本地接着聊过：新消息作为分支挂上，当前位置不动', c3.headId === mine && !!byCc(c3, 'm-0013'));
}

// ══════════════════════════════════════════════════════════
group('[7] 导进来又删掉的，再导不复活');
{
  const b = box();
  b.ccApplyImport(b.ccPlanImport(SAMPLE(), b.state.chats, {}, {}), {});
  const c = b.state.chats.find(x => x.importedFrom.uuid === SAMPLE()[0].uuid);
  // 批量删的接线：先打墓碑（这时对话还在 state.chats 里）再删本地 —— 不传 cc 也要自己找到
  b.markChatDeleted(c.id);
  b.state.chats = b.state.chats.filter(x => x !== c);
  t('墓碑上记了 claude.ai uuid（批量删那条路：自己去找）', b.state.deletedChats[String(c.id)].cc === SAMPLE()[0].uuid);
  const plan = b.ccPlanImport(SAMPLE(), b.state.chats, b.state.deletedChats, {});
  const it = plan.find(i => i.uuid === SAMPLE()[0].uuid);
  t('再导：状态是「删过」', it.status === 'deleted', it.status);
  const r = b.ccApplyImport(plan, {});
  t('默认不导回来', r.created === 0 && !b.state.chats.some(x => x.importedFrom && x.importedFrom.uuid === SAMPLE()[0].uuid));
  const r2 = b.ccApplyImport(b.ccPlanImport(SAMPLE(), b.state.chats, b.state.deletedChats, {}), { includeDeleted: true });
  t('勾了「也导回来」才导回来，而且拿的是新号', r2.created === 1 && b.state.chats.some(x => x.importedFrom.uuid === SAMPLE()[0].uuid && x.id !== c.id));

  // 单个删的接线：先删本地再打墓碑 → 必须显式传
  const b2_ = box();
  b2_.markChatDeleted(777, false, 'u-explicit');
  t('单个删那条路：显式传进来的 cc 记得上', b2_.state.deletedChats['777'].cc === 'u-explicit');
  b2_.markChatDeleted(778);
  t('普通对话的墓碑不带 cc（形状和以前一样）', !('cc' in b2_.state.deletedChats['778']));

  const m1 = b.mergeTombstones({ 5: { at: 1, cloud: 'pending', cc: 'U5' } }, { 5: { at: 2, cloud: 'done' } });
  t('墓碑合并：本机带 cc、云端不带 → cc 留着', m1['5'].cc === 'U5' && m1['5'].cloud === 'done');
  const m2 = b.mergeTombstones({ 6: { at: 1, cloud: 'done' } }, { 6: { at: 2, cloud: 'pending', cc: 'U6' } });
  t('墓碑合并：云端带 cc、本机不带 → cc 收进来（另一台删的也挡得住）', m2['6'].cc === 'U6');
  const old = Date.now() - 400 * 864e5;
  b.state.deletedChats = { 1: { at: old, cloud: 'done', cc: 'U1' }, 2: { at: old, cloud: 'done' } };
  b.pruneTombstones();
  t('过期清理：带 cc 的不清（那份 zip 半年后还在她硬盘里）', !!b.state.deletedChats['1']);
  t('过期清理：普通墓碑照常清', !b.state.deletedChats['2']);
}

// ══════════════════════════════════════════════════════════
group('[8] 脏数据不挂、不丢');
{
  const b = box();
  const cyc = { uuid: 'cyc', name: '成环', created_at: '2026-01-01T00:00:00Z', chat_messages: [
    { uuid: 'A', parent_message_uuid: 'B', sender: 'human', text: '甲', created_at: '2026-01-01T00:00:01Z', content: [] },
    { uuid: 'B', parent_message_uuid: 'A', sender: 'assistant', text: '乙', created_at: '2026-01-01T00:00:02Z', content: [] },
    { uuid: 'C', parent_message_uuid: 'C', sender: 'human', text: '自己指自己', created_at: '2026-01-01T00:00:03Z', content: [] },
    { uuid: 'B', parent_message_uuid: 'A', sender: 'assistant', text: '重复的 B', created_at: '2026-01-01T00:00:04Z', content: [] },
  ] };
  let r, threw = null;
  try { r = b.ccApplyImport(b.ccPlanImport([cyc], [], {}, {}), {}); } catch (e) { threw = e.message; }
  t('父子成环：不死循环、不抛', !threw, threw);
  const c = b.state.chats[0];
  t('成环的那几条都导进来了（没丢）', c && Object.keys(c.nodes).length === 3, c && Object.keys(c.nodes).length);
  t('同一个 uuid 出现两次只收一次', c && Object.values(c.nodes).filter(n => n.ccUuid === 'B').length === 1);
  t('没有指向不存在节点的 parentId', c && Object.values(c.nodes).every(n => n.parentId === null || c.nodes[n.parentId]));
  t('headId 指向真实存在的节点', c && !!c.nodes[c.headId]);

  const leaf = { uuid: 'L', name: '有 leaf', created_at: '2026-01-01T00:00:00Z', current_leaf_message_uuid: 'L2', chat_messages: [
    { uuid: 'L1', parent_message_uuid: 'root', sender: 'human', text: '问', created_at: '2026-01-01T00:00:01Z', content: [] },
    { uuid: 'L2', parent_message_uuid: 'L1', sender: 'assistant', text: '旧答', created_at: '2026-01-01T00:00:02Z', content: [] },
    { uuid: 'L3', parent_message_uuid: 'L1', sender: 'assistant', text: '新答', created_at: '2026-01-01T00:00:03Z', content: [] },
  ] };
  const b4 = box();
  b4.ccApplyImport(b4.ccPlanImport([leaf], [], {}, {}), {});
  const c4 = b4.state.chats[0];
  t('导出里带了 current_leaf_message_uuid 就停在那条（网页上当时看的那个分支）', c4.nodes[c4.headId].ccUuid === 'L2');
}

// ══════════════════════════════════════════════════════════
group('[9] zip：在 vm 里用真 JSZip 解一次');
(async () => {
  const b = box();
  vm.runInContext(read('js/lib/jszip.min.js'), b, { filename: 'jszip.min.js' });
  const JSZip = b.JSZip || (b.module && b.module.exports);
  t('JSZip 在沙箱里加载出来', typeof JSZip === 'function');
  if (typeof JSZip === 'function') {
    b.JSZip = JSZip;
    const zip = new JSZip();
    zip.file('data-2026-10-03/conversations.json', read('tests/fixtures/claude-export-sample.json'));
    zip.file('data-2026-10-03/users.json', '[]');
    zip.file('data-2026-10-03/files/f-img-0001/cat.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    const u8 = await zip.generateAsync({ type: 'uint8array' });
    const file = Object.assign(u8, { name: 'claude-export.zip' });
    const got = await b._ccReadFile(file);
    t('zip 里套着一层目录也找得到 conversations.json', got.texts.length === 1 && JSON.parse(got.texts[0]).length === 3);
    const map = await b._ccLoadImages([got.zip], b.ccDetectExport(JSON.parse(got.texts[0])));
    t('zip 里真有图片本体时按 file_uuid 对上', map.has('f-img-0001') && /^data:image\/png;base64,/.test(map.get('f-img-0001')));
    const bb = box();
    bb.ccApplyImport(bb.ccPlanImport(SAMPLE(), [], {}, { fileMap: map }), { ctx: { fileMap: map } });
    const u4 = byCc(bb.state.chats.find(c => c.importedFrom.uuid === SAMPLE()[0].uuid), 'm-0004');
    t('对上了就带图，不再出「没有本体」的卡片', (u4.images || []).length === 1 && !(u4.files || []).some(f => f.missing));

    const z2 = new JSZip();
    z2.file('projects.json', '[]');
    const u82 = Object.assign(await z2.generateAsync({ type: 'uint8array' }), { name: 'projects.zip' });
    let msg = '';
    try { await b._ccReadFile(u82); } catch (e) { msg = e.message; }
    t('选错了 zip（项目那份）：说清楚换哪个', /没有 conversations\.json/.test(msg) && /projects\.json/.test(msg), msg);
  }

  // ══════════════════════════════════════════════════════════
  group('[10] 接线');
  const html = read('index.html');
  t('index.html 引了脚本', html.includes('<script src="./js/60-cc-import.js"></script>'));
  t('侧栏菜单有入口', /onclick="openCcImport\(\);toggleFooterMenu\(\)"/.test(html));
  t('有导入面板和顶栏时期标记', html.includes('id="ccImportModal"') && html.includes('id="ccImportBody"') && html.includes('id="ccEraBadge"'));
  const cm = read('js/03-chats-models.js');
  t('单个删：把 claude.ai uuid 显式交给墓碑（这条路是先删本地再打墓碑）', cm.includes('markChatDeleted(id, false, chatToDelete?.importedFrom?.uuid)'));
  t('对话列表挂 claude.ai 标记', /c\.importedFrom \? `<span class="cc-badge"/.test(cm));
  const et = read('js/08-edit-trash.js');
  const iMark = et.indexOf('goneIds.forEach(id => markChatDeleted(id))'), iFilter = et.indexOf('state.chats = state.chats.filter(c => !state.selectedChatIds.has(c.id))');
  t('批量删：仍然是先打墓碑再删本地（markChatDeleted 才找得到 importedFrom）', iMark > 0 && iFilter > iMark);
  const css = read('css/grancyan.css');
  t('标记有样式', css.includes('.cc-badge'));
  t('android 副本与 js/ 一致', ['js/60-cc-import.js', 'js/02-state.js', 'js/03-chats-models.js', 'index.html', 'css/grancyan.css']
    .every(f => fs.existsSync(path.join(ROOT, 'android/assets', f)) && read('android/assets/' + f) === read(f)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log('  ✗ 跑到一半炸了：' + e.message); process.exit(1); });
