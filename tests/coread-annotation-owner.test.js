// 书架批注的归属。
//
// 用户逮到的 bug：书架被 DeepSeek 批注了，可**每个**模型都以为那是自己批注的。
// 根因是一条批注只存了 'ai' 这一个值，两边的提示词都写成「你划了」——
// 书架能单独选模型，所以「AI」和「现在说话的这个 AI」根本不是一回事。
//
// 这里两边都测**真代码**：服务端直接 require，前端那半边从源码抠出来 eval。
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const { annOwner } = require(path.join(root, 'coread', 'lib', 'prompt.js'));
const CO_SRC = fs.readFileSync(path.join(root, 'js', '47-coread.js'), 'utf8');
const CHAT_SRC = fs.readFileSync(path.join(root, 'coread', 'routes', 'chat.js'), 'utf8');
const READER_SRC = fs.readFileSync(path.join(root, 'coread', 'routes', 'reader.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// ── 前端那半边：把 _crWho 抠出来跑真逻辑 ──────────────────────────
const CROSS = (() => {
  const m = CO_SRC.match(/function _crWho\(m, conf\) \{[\s\S]*?\n\}/);
  if (!m) return null;
  return new Function('state', 'return ' + m[0].replace('function _crWho', 'function'))({ userName: '小明' });
})();
test('抠得到 _crWho（抠不到就是锚点飘了，下面全是验空气）', () => {
  assert.ok(CROSS, '没抠到 _crWho(m, conf)');
});

const DS = { label: 'DeepSeek 读书搭子', modelName: 'deepseek-chat' };
const CL = { nickname: '克克', modelName: 'claude-opus-5' };

// ── 服务端（书架自己的提示词）───────────────────────────────────
test('★ 换了模型之后，前一个模型的批注不许被认领成「你」', () => {
  const byDS = { annotator: 'ai', annotator_name: 'DeepSeek 读书搭子', annotator_model: 'deepseek-chat' };
  // 现在说话的是别人
  assert.equal(annOwner(byDS, { label: '克克', modelName: 'claude-opus-5' }), 'DeepSeek 读书搭子');
  // 现在说话的正是它自己 —— 该认领就认领（写成「AI 划了」它会以为在看第三个人的字）
  assert.equal(annOwner(byDS, DS), '你');
});

test('模型名对得上就算同一个（昵称被改过也认）', () => {
  const a = { annotator: 'ai', annotator_name: '老名字', annotator_model: 'deepseek-chat' };
  assert.equal(annOwner(a, { label: '新名字', modelName: 'deepseek-chat' }), '你');
});

test('昵称对得上也算同一个（本地模型拿不到统一的 modelName）', () => {
  const a = { annotator: 'ai', annotator_name: '克克', annotator_model: 'local:sonnet' };
  assert.equal(annOwner(a, { label: '克克', isLocal: true, localModel: 'opus' }), '你');
});

test('★ 旧批注（库里没记作者）说中立的，不许瞎认领', () => {
  const old = { annotator: 'ai', annotator_name: '', annotator_model: '' };
  const who = annOwner(old, CL);
  assert.notEqual(who, '你');
  assert.match(who, /AI/);
});

test('读者那半边照旧是「读者」', () => {
  assert.equal(annOwner({ annotator: 'user' }, CL), '读者');
  assert.equal(annOwner({ annotator: 'user', annotator_name: 'DeepSeek' }, CL), '读者',
    '读者的批注不管带什么作者名都还是读者');
});

test('me 整个缺席时也不许认领（拿不到「我是谁」就无从判断）', () => {
  const byDS = { annotator: 'ai', annotator_name: 'DeepSeek', annotator_model: 'deepseek-chat' };
  assert.notEqual(annOwner(byDS, null), '你');
  assert.notEqual(annOwner(byDS, {}), '你');
});

test('空白和大小写不算两个模型', () => {
  const a = { annotator: 'ai', annotator_name: '', annotator_model: ' DeepSeek-Chat ' };
  assert.equal(annOwner(a, { modelName: 'deepseek-chat' }), '你');
});

// ── 前端（主对话的提示词）───────────────────────────────────────
test('★ 主对话这边同样不许认领书架里别人的批注', () => {
  const byDS = { who: 'ai', byName: 'DeepSeek 读书搭子', byModel: 'deepseek-chat' };
  assert.equal(CROSS(byDS, CL), '书架里的 DeepSeek 读书搭子');
  assert.equal(CROSS(byDS, { nickname: 'x', modelName: 'deepseek-chat' }), '你');
});

test('主对话这边旧批注也说中立的', () => {
  assert.equal(CROSS({ who: 'ai' }, CL), '书架里的 AI');
  assert.equal(CROSS({ who: 'ai', byName: '', byModel: '' }, CL), '书架里的 AI');
});

test('只有模型名没昵称时，说「书架里的另一个 AI」而不是拿模型名糊人脸上', () => {
  assert.equal(CROSS({ who: 'ai', byName: '', byModel: 'gpt-4o' }, CL), '书架里的另一个 AI');
});

test('用户那半边是用户的名字', () => {
  assert.equal(CROSS({ who: 'user' }, CL), '小明');
});

// ── 链路：作者信息得一路传下来，断一节就永远判中立 ──────────────
test('★ 写入时真的记下了是谁划的（不然后面全是空的，永远判中立）', () => {
  assert.match(CHAT_SRC, /INSERT INTO annotations\([^)]*annotator_name,annotator_model\)/);
  assert.match(CHAT_SRC, /cfg\.label/);
  assert.match(CHAT_SRC, /cfg\.isLocal \? 'local:'/);
  // ? 的个数必须和列数一致，否则 better-sqlite3 直接抛，整条批注都存不进去
  const ins = CHAT_SRC.match(/INSERT INTO annotations\(([^)]*)\) VALUES\(([^)]*)\)/);
  assert.ok(ins, '抠不到那条 INSERT');
  assert.equal(ins[1].split(',').length, ins[2].split(',').length, '列数和 ? 个数不一致');
});

test('★ cfg 必须在 buildSystem 之前拿到（顺序错了 me 就是 undefined，判断整片失效）', () => {
  const iCfg = CHAT_SRC.indexOf('const cfg = modelCfg();');
  const iSys = CHAT_SRC.indexOf('buildSystem(db, {');
  assert.ok(iCfg > 0 && iSys > 0, '锚点没了');
  assert.ok(iCfg < iSys, `cfg 在第 ${iCfg} 字节、buildSystem 在第 ${iSys} 字节 —— 顺序反了`);
  assert.equal((CHAT_SRC.match(/const cfg = modelCfg\(\);/g) || []).length, 1, 'cfg 声明了两次会 SyntaxError');
  assert.match(CHAT_SRC, /annotations, me: cfg/);
  // 读批注的 SELECT 也得带上这两列，否则 annOwner 拿到的永远是 undefined
  assert.match(CHAT_SRC, /SELECT annotator,annotator_name,annotator_model,/);
});

test('★ pulse 把作者递给主对话（这一节断了，那边只能判中立）', () => {
  assert.match(READER_SRC, /byName: String\(a\.annotator_name/);
  assert.match(READER_SRC, /byModel: String\(a\.annotator_model/);
});

test('★ 老库要能自己长出这两列（CREATE TABLE IF NOT EXISTS 不改已存在的表）', () => {
  assert.match(SERVER_SRC, /ALTER TABLE annotations ADD COLUMN/);
  assert.match(SERVER_SRC, /annotator_name.*annotator_model|annotator_name', 'annotator_model/s);
  // 建表语句里也要有，新库才不用靠 ALTER 补
  const create = SERVER_SRC.match(/CREATE TABLE IF NOT EXISTS annotations\([\s\S]*?\);/);
  assert.ok(create, '抠不到建表语句');
  assert.match(create[0], /annotator_name TEXT/);
  assert.match(create[0], /annotator_model TEXT/);
});
