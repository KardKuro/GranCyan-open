// 分享对话（js/59-share.js + docs/shares.sql + 单独部署的查看页，本地路径由环境变量 GRANCYAN_SHARE_VIEWER 指过来）。
// 快照的内容用真函数进沙箱验；权限这种跑不起来的，验 SQL 里那几道闸还在。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const src = read('js/59-share.js');
let n = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

function box(extra) {
  const b = Object.assign({ state: { userName: '小明' }, Math, JSON, Array, String,
    getMsgPlainText: m => m.content || '',
    getComputedStyle: () => ({ getPropertyValue: () => ' #c6ff00 ' }), document: { documentElement: {} } }, extra || {});
  vm.createContext(b);
  vm.runInContext(src.replace(/^const /gm, 'var '), b);
  return b;
}

t('快照：用户/AI 分开，名字取昵称，[[指令]] 剥掉，图片写成 [图片]，空消息丢掉', () => {
  const b = box();
  const p = b._sharePayload({ title: '晚上聊天' }, [
    { role: 'user', content: '你好呀', timestamp: 1 },
    { role: 'ai', content: '在呢[[MEM_ADD:小明喜欢猫]]\n\n\n\n抱抱', modelNickname: '克克', timestamp: 2 },
    { role: 'ai', content: '', images: ['data:x', 'data:y'], modelNickname: '克克', timestamp: 3 },
    { role: 'ai', content: '[[MUSIC:x]]', timestamp: 4 },
    { role: 'system', content: '提示词不许进快照' },
  ]);
  assert.strictEqual(p.title, '晚上聊天');
  assert.strictEqual(p.accent, '#c6ff00');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.msgs)), [
    { r: 'u', n: '小明', t: '你好呀', ts: 1 },
    { r: 'a', n: '克克', t: '在呢\n\n抱抱', ts: 2 },
    { r: 'a', n: '克克', t: '[图片][图片]', ts: 3 },
  ]);
});
t('快照：多版本的 AI 回复取当前选中的那个版本的昵称', () => {
  const b = box({ getMsgPlainText: m => m.variants ? m.variants[m.chosenVariant].content : m.content });
  const p = b._sharePayload({}, [{ role: 'ai', variants: [{ content: 'a', modelNickname: 'A' }, { content: 'b', modelNickname: 'B' }], chosenVariant: 1 }]);
  assert.deepStrictEqual([p.msgs[0].n, p.msgs[0].t], ['B', 'b']);
});
t('快照只带白名单字段（不带头像、思考链、配置）', () => {
  const b = box();
  const p = b._sharePayload({ title: 'x', systemPrompt: 'secret' }, [{ role: 'ai', content: 'hi', reasoning: '想法', avatar: 'data:big', modelNickname: 'K' }]);
  assert.deepStrictEqual(Object.keys(p).sort(), ['accent', 'msgs', 'title', 'user', 'v']);
  assert.deepStrictEqual(Object.keys(p.msgs[0]).sort(), ['n', 'r', 't', 'ts']);
});
t('id：12 位、只有字母数字（查看页和 SQL 的 check 都按这个认）', () => {
  const b = box({ crypto: require('crypto').webcrypto, Uint8Array });
  for (let i = 0; i < 50; i++) assert.ok(/^[A-Za-z0-9]{12}$/.test(b._shareId()));
});
t('写入带 user_id，链接指向配置里的查看页（没配就不发请求）；撤回按 id 删且先验 id', () => {
  assert.ok(src.includes('GRANCYAN_CONFIG.sharePageUrl'));
  assert.ok(!/https?:\/\/[^'"]*github\.io/.test(src), '查看页地址不许硬编码');
  assert.ok(/async function _shareCreate\(nodes, label\) \{\n  if \(!SHARE_PAGE\) \{ showToast\(SHARE_OFF_MSG/.test(src));
  assert.ok(src.includes(".from('shares').insert({ id, user_id: currentUser.id,"));
  assert.ok(src.includes("if (!/^[A-Za-z0-9]{6,32}$/.test(id)) return;\n  if (!confirm("));
  assert.ok(src.includes(".from('shares').delete().eq('id', id)"));
});
t('入口：对话栏的「🔗 分享」、多选托盘的「分享」、脚本挂上了', () => {
  assert.ok(read('js/03-chats-models.js').includes('onclick="openShareModal()"'));
  const html = read('index.html');
  assert.ok(html.includes('onclick="shareSelectedMessages()"'));
  assert.ok(html.includes('<script src="./js/59-share.js"></script>'));
});
t('权限：匿名访客读不了整张表，只能走 get_share 拿一条；登录用户只碰自己的', () => {
  const sql = read('docs/shares.sql');
  assert.ok(sql.includes('alter table public.shares enable row level security;'));
  assert.ok(sql.includes('revoke all on public.shares from anon;'));
  assert.ok(!/for select to (anon|public)/.test(sql), '不许给匿名开 select');
  for (const op of ['select', 'insert', 'delete']) assert.ok(new RegExp(`for ${op} to authenticated (using|with check) \\(user_id = auth\\.uid\\(\\)\\)`).test(sql), op);
  assert.ok(sql.includes('security definer') && sql.includes('where s.id = sid'));
  assert.ok(sql.includes('grant execute on function public.get_share(text) to anon, authenticated;'));
});
t('查看页：只调 get_share、渲染前过 DOMPurify、不让搜索引擎收录', () => {
  const dir = process.env.GRANCYAN_SHARE_VIEWER;   // 查看页仓库的本地目录（可选）
  const p = dir ? path.join(dir, 'index.html') : '';
  if (!p || !fs.existsSync(p)) return;   // 没有查看页仓库就跳过
  const h = fs.readFileSync(p, 'utf8');
  assert.ok(h.includes("'/rest/v1/rpc/get_share'"));
  assert.ok(!h.includes('/rest/v1/shares'), '查看页不许直接读表');
  assert.ok(h.includes('DOMPurify.sanitize(marked.parse('));
  assert.ok(h.includes('<meta name="robots" content="noindex, nofollow">'));
});
t('安卓副本一致', () => {
  for (const f of ['js/59-share.js', 'js/03-chats-models.js', 'css/grancyan.css', 'index.html']) assert.strictEqual(read('android/assets/' + f), read(f), f);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log('  ✓ ' + name); }
    catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
  }
  console.log(n + '/' + tests.length + ' 条通过');
})();
