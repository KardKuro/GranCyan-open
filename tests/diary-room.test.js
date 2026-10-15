// 日记本面板的样子（2026-10-10 推翻重做：书架 + 摊开的本子，开关收进齿轮抽屉）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');
const diary = fs.readFileSync(path.join(root, 'js', '19-diary.js'), 'utf8');
const lightGen = fs.readFileSync(path.join(root, 'scripts', 'gen-light-patch.js'), 'utf8');

// 跑真的 19-diary.js，DOM 只给 diaryBody / diarySettingsModels 两个节点
function boot(S) {
  const nodes = { diaryBody: { innerHTML: '' }, diarySettingsModels: { innerHTML: '' }, diaryModal: { classList: { contains: () => false } } };
  const ctx = vm.createContext({
    state: S, save() {}, showToast() {}, confirm: () => true, console,
    escHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { getElementById: id => nodes[id] || null, addEventListener() {}, querySelector: () => null },
  });
  vm.runInContext(diary, ctx);
  return { ctx, nodes };
}

test('settings live in a drawer behind the header button, ids kept', () => {
  assert.match(html, /id="diaryModal"[\s\S]*id="diaryGear"[\s\S]*id="diarySettings"[\s\S]*id="diaryFeatureToggle"[\s\S]*id="diaryDevViewToggle"[\s\S]*id="diarySettingsModels"[\s\S]*id="diaryBody"/);
  assert.match(css, /\.diary-settings \{[^}]*grid-template-rows:0fr/);
  assert.match(css, /\.diary-settings\.open \{[^}]*grid-template-rows:1fr/);
  assert.doesNotMatch(html, /THE QUIET ATTIC/);
  assert.match(html, /日记本[\s\S]*一排书脊/);
});

test('diary pages remain scrollable and phone-safe', () => {
  assert.match(css, /\.diary-scroll \{[^}]*overflow-y:auto/);
  assert.match(css, /#diaryBody \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.diary-shelf \{[^}]*overflow-x:auto/);
  assert.match(css, /@media\(max-width:560px\)\{[\s\S]*\.diary-entry \{ grid-template-columns:58px 1fr/);
});

test('diary paints its own dark; light patch skips it but keeps borrowed .diary-switch', () => {
  const m = lightGen.match(/const SKIP = (\/.*\/);/);
  const SKIP = eval(m[1]);
  assert.ok(SKIP.test('.diary-paper'));
  assert.ok(SKIP.test('#diaryBody'));
  assert.ok(!SKIP.test('.diary-switch'));
});

test('shelf shows only books that are switched on; picks one and opens it', () => {
  const S = { diaryEnabled: true, diaryDevView: false, diaryUnlock: {}, diaryHandover: {},
    configs: [{ id: 'a', nickname: '小克', diaryOn: true }, { id: 'b', nickname: '没开的', diaryOn: false }, { id: 'c', nickname: '小G', diaryOn: true }],
    modelDiaries: { c: [{ t: Date.now() - 1000, text: '小G 的第一页' }] } };
  const { ctx, nodes } = boot(S);
  ctx.renderDiaryPanel();
  const h = nodes.diaryBody.innerHTML;
  assert.equal((h.match(/class="diary-spine[ "]/g) || []).length, 2);
  assert.ok(!h.includes('没开的'), '没开日记的模型不上书架');
  assert.ok(nodes.diarySettingsModels.innerHTML.includes('没开的'), '但抽屉里有它的开关');
  assert.match(h, /diary-spine on[^"]*"[^>]*diarySelect\('c'\)/, '默认摊开写过字的那本');
  assert.match(h, /diary-cover/, '锁着的书画成合上的封面');
  assert.ok(!h.includes('小G 的第一页'), '锁着时正文不出现');
  ctx.diarySelect('a');
  assert.match(nodes.diaryBody.innerHTML, /这本日记还是空的|要在聊天里跟 小克 沟通/);
});

test('off switch and empty shelf both say where the switch is', () => {
  const S = { diaryEnabled: false, configs: [{ id: 'a', nickname: '小克' }], modelDiaries: {} };
  const { ctx, nodes } = boot(S);
  ctx.renderDiaryPanel();
  assert.match(nodes.diaryBody.innerHTML, /当前<b>关闭<\/b>[\s\S]*设置/);
  S.diaryEnabled = true;
  ctx.renderDiaryPanel();
  assert.match(nodes.diaryBody.innerHTML, /书架还空着/);
});

test('same-day pages share one big date in the margin', () => {
  const day = new Date(2026, 9, 10, 21, 5).getTime();
  const S = { diaryEnabled: true, diaryDevView: true, configs: [{ id: 'a', nickname: '小克', diaryOn: true }],
    modelDiaries: { a: [{ t: day, text: '一' }, { t: day + 3600e3, text: '二' }, { t: day + 86400e3, text: '三' }] } };
  const { ctx, nodes } = boot(S);
  ctx.renderDiaryPanel();
  const h = nodes.diaryBody.innerHTML;
  assert.equal((h.match(/<b>10<\/b>/g) || []).length, 1);
  assert.equal((h.match(/<b>11<\/b>/g) || []).length, 1);
  assert.equal((h.match(/diary-entry-date cont/g) || []).length, 1);
});

test('every book wears a real cover photo; neighbours never share one; spine matches the cover taken down', () => {
  // 一个没开日记的模型夹在中间：它不上架，也不该占掉一张封面
  const ids = Array.from({ length: 10 }, (_, i) => 'cfg_' + i * 7919);
  const S = { diaryEnabled: true, diaryDevView: false, diaryUnlock: {}, diaryHandover: {},
    configs: [{ id: 'off', nickname: '没开的', diaryOn: false }, ...ids.map(id => ({ id, nickname: id, diaryOn: true }))],
    modelDiaries: Object.fromEntries(ids.map(id => [id, [{ t: 1, text: '锁着的一页' }]])) };
  const { ctx, nodes } = boot(S);
  ctx.renderDiaryPanel();
  const spines = [...nodes.diaryBody.innerHTML.matchAll(/class="diary-spine[^"]*" data-bind="(\d+)"/g)].map(m => +m[1]);
  assert.equal(spines.length, 10, '每本书脊都带封面编号');
  assert.deepEqual(spines.slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8], '架上前八本按顺序把八张封面各用一次，挨着的不撞色');
  assert.ok(spines.every(n => n >= 1 && n <= 8), '编号不出界');
  ids.forEach((id, i) => {
    ctx.diarySelect(id);
    const h = nodes.diaryBody.innerHTML;
    const m = h.match(/class="diary-cover" data-bind="(\d+)"/);
    assert.ok(m, '锁着的书要带封面编号');
    assert.equal(+m[1], spines[i], `${id}：书架上那根书脊和取下来的封面是同一张`);
    assert.match(h, new RegExp(`diary-book-thumb" data-bind="${m[1]}"`), '标题旁的小封面和大封面是同一张');
  });
  for (let n = 1; n <= 8; n++) {
    assert.match(css, new RegExp(`\\[data-bind="${n}"\\] \\{ --photo:url\\(\\.\\./img/diary/b${n}\\.jpg\\)`));
    assert.ok(fs.statSync(path.join(root, 'img', 'diary', `b${n}.jpg`)).size > 10000, `b${n}.jpg 在仓库里`);
  }
  assert.match(css, /\.diary-spine \{[^}]*var\(--photo/, '书脊画的是封面照片本身，不是近似的布色');
  assert.doesNotMatch(css, /\.diary-cover:before \{[^}]*sepia/, '封面不再整体加旧，不然八本都成一个咖啡色');
  assert.match(html, /id="creditsModal"[\s\S]*metmuseum\.org[\s\S]*日记本的八张封面/);
});

test('the renovation preserves diary privacy controls', () => {
  assert.match(diary, /diaryUnlocked\(c\.id\)/);
  assert.match(diary, /diaryReturnKeyUI/);
});
