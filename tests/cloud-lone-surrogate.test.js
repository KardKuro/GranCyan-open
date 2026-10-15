'use strict';
/* 云端不收「半个 emoji」（落单的 UTF-16 代理对）——2026-09-30 顺着点歌同步查出来的
 *
 * 症状：电脑上的设置（记忆、模型配置、收藏……）从某天起再也推不上云，一个报错都没有
 * （syncSettingsToCloud 的失败只进 console.warn）。另一台设备永远拿不到电脑这边的改动。
 * 根因：两条收藏消息的预览是 text.slice(0, 300) + '…'，正好把 emoji 劈成两半，
 * JSON.stringify 把半个代理对写成 "\ud83d"——JS 自己认，Supabase（PostgREST）不认，
 * 整个请求体判成 PGRST102「Empty or invalid json」。1516 条里坏 2 条，拖死整包。
 *
 * 两道防线都在这里守：
 *   ① 截断的地方不劈 emoji（06-render-msg 的收藏预览）
 *   ② 推云端之前统一洗（01-core 的 stripNullBytes：\0 和落单的半个代理对），设置和对话两条路都过
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const core = read('js/01-core.js'), render = read('js/06-render-msg.js');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
// 把一个函数声明整段抠出来（按花括号配对）
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); }
  throw new Error('括号不配对 ' + name);
}
// PostgREST 那侧的判据：JSON 文本里出现落单的 \udXXX 转义就不收
const LONE_ESC = /\\u(d[89ab][0-9a-f]{2})(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/i;

console.log('\n[1] stripNullBytes 洗掉云端不收的字符');
{
  const box = {}; vm.createContext(box);
  vm.runInContext(grab(core, 'stripNullBytes'), box);
  const half = '现在，🥺'.slice(0, -1);            // 🥺 劈掉后半个
  t('（对照）劈开的 emoji 过 JSON.stringify 会留下 \\ud83e 转义', LONE_ESC.test(JSON.stringify(half)));
  const out = box.stripNullBytes({ a: half + '…', b: ['ok 😀', 'x\0y'], c: { d: '\udc00开头' }, n: 3, z: null });
  t('半个代理对换成 �', out.a === '现在，�…', out.a);
  t('完整的 emoji 原样保留', out.b[0] === 'ok 😀');
  t('\\0 照旧删掉', out.b[1] === 'xy');
  t('开头落单的后半个也换掉', out.c.d === '�开头');
  t('数字/null 原样', out.n === 3 && out.z === null);
  t('洗过之后 JSON 里再没有落单的转义', !LONE_ESC.test(JSON.stringify(out)));
  // 设置那行带着 updated_at: new Date()——拆成 {} 的话云端报 timestamp 语法错，整包照样推不上去
  const d = new Date('2026-09-30T09:00:00Z');
  const row = box.stripNullBytes({ id: 'u', settings: { s: 'a' }, updated_at: d });
  t('Date 原样留着（不被拆成 {}）', row.updated_at === d && JSON.stringify(row).includes('"2026-09-30T09:00:00.000Z"'), JSON.stringify(row));
}

console.log('\n[2] 推云端的两条路都过 stripNullBytes');
{
  const push = grab(core, 'pushCloudSettings');
  t('设置：pushCloudSettings 一进来就洗 row（中转和直连用的都是洗过的）', /row = stripNullBytes\(row\);/.test(push)
    && push.indexOf('row = stripNullBytes(row)') < push.indexOf('JSON.stringify(row)') && push.indexOf('row = stripNullBytes(row)') < push.indexOf('.upsert(row)'));
  t('对话：rawUpsertChats 推之前洗', /JSON\.stringify\(stripNullBytes\(rows\)\)/.test(grab(core, 'rawUpsertChats')));
}

console.log('\n[3] 收藏消息的预览不劈 emoji');
{
  const fn = grab(render, 'toggleFavMsg');
  const chat = { id: 1, title: 't', nodes: { n1: { role: 'assistant', content: '' } } };
  const mk = text => {
    const box = { state: { favMessages: [] }, save() {}, showToast() {}, getActiveChat: () => chat, getMsgPlainText: () => text,
      document: { querySelectorAll: () => [] }, Date, updateFavBadge() {} };
    vm.createContext(box); vm.runInContext(fn, box); box.toggleFavMsg('n1');
    return box.state.favMessages[0].text;
  };
  const t1 = mk('字'.repeat(299) + '🥺后面还有');     // 第 300 个 UTF-16 单元正好是 🥺 的前半个
  t('截在 emoji 中间时退一格：没有半个代理对', !LONE_ESC.test(JSON.stringify(t1)) && t1.endsWith('…'), JSON.stringify(t1.slice(-4)));
  t('长度不超 300 + 省略号', t1.length <= 301);
  const t2 = mk('短的 😀');
  t('短消息原样、不加省略号', t2 === '短的 😀');
  const t3 = mk('字'.repeat(310));
  t('普通长消息照旧截 300 + …', t3.length === 301 && t3.endsWith('…'));
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
