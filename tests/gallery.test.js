'use strict';
// 画板（js/53-gallery.js）：[[GALLERY: 注脚]] 挂画、第一批画只挂一次、blocks 路径不重复挂、历史回填自咬合。
//
// 跑的是真的 04-memory.js / 05-prompts-api.js / 53-gallery.js，存储换成内存版 idb。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

const idb = new Map();
const docListeners = {};
let sets = 0;
const state = {
  moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [],
  userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: 'k',
  webSearchProvider: 'tavily', bandAiEnabled: false, studyOn: false,
};
const box = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map, Number, Promise,
  state,
  idbGet: async k => (idb.has(k) ? idb.get(k) : null),
  idbSet: async (k, v) => { sets++; idb.set(k, v); },
  save() {}, showToast() {}, nextId: () => 1,
  escHtml: v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); } },
  window: {}, _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  fetch: async () => ({ ok: true }),
  pickBrainMemories: () => [], formatBrainForPrompt: () => '', takeProustMoment: () => '',
};
box.globalThis = box;
vm.createContext(box);
const stateSrc = read('js/02-state.js');
const a = stateSrc.indexOf('function estimateTokens(text)');
const b = stateSrc.indexOf('function getChatTotalTokens', a);
vm.runInContext(stateSrc.slice(a, b), box);
vm.runInContext(read('js/04-memory.js'), box, { filename: '04-memory.js' });
vm.runInContext(read('js/05-prompts-api.js'), box, { filename: '05-prompts-api.js' });
vm.runInContext(read('js/53-gallery-seed.js') + '\nglobalThis.GALLERY_SEED = GALLERY_SEED;', box, { filename: '53-gallery-seed.js' });
vm.runInContext(read('js/53-gallery.js'), box, { filename: '53-gallery.js' });
const items = () => vm.runInContext('_galleryItems', box);
const reload = () => vm.runInContext('_galleryItems = null', box);

(async () => {
  console.log('\n[1] 第一批画只挂一次');
  await box.galleryLoad();
  t('从没存过：挂上今天那两张，并且落盘', items().length === 2 && idb.has('kuro_gallery')
    && items().every(it => it.kind === 'html' && /<html|<!doctype/i.test(it.src) && it.caption), items().map(i => i.id));
  vm.runInContext('_galleryItems.length = 0', box);
  await box.gallerySave();
  reload();
  await box.galleryLoad();
  t('★ 用户全摘掉之后重开，第一批不会冒回来', items().length === 0, items().length);

  console.log('\n[2] [[GALLERY:]] 挂指令前最后一块画');
  const conf = { id: 9, name: '克克', nickname: '别存这个' };
  const raw = '先给你看个草稿\n```html\n<p>草稿</p>\n```\n这张才是正式的\n```html\n<!doctype html><html><head></head><body>月亮</body></html>\n```\n'
    + '[[GALLERY: 今晚的月亮，三个坑]]\n后面又贴了段代码\n```html\n<p>不该被挂</p>\n```';
  const cooked = box.processAiCommands(raw, {}, conf);
  await flush();
  t('★ 挂的是指令之前最后一块，不是第一块、也不是指令后面那块',
    items().length === 1 && items()[0].src.includes('月亮') && !items()[0].src.includes('草稿') && !items()[0].src.includes('不该被挂'),
    items().map(i => i.src.slice(0, 40)));
  t('作者存模型卡的 name，注脚原样', items()[0].author === '克克' && items()[0].caption === '今晚的月亮，三个坑', items()[0]);
  t('气泡里是卡片，没有裸指令', !cooked.includes('[[GALLERY') && cooked.includes('class="gallery-chat-card"')
    && cooked.includes('🖼 挂上了画板'));

  console.log('\n[3] 没画、svg、同一块两次');
  const n0 = items().length;
  const miss = box.processAiCommands('我没画东西 [[GALLERY: 想挂]]', {}, conf);
  await flush();
  t('★ 这条里没画：什么都不挂，卡片说清楚没找到', items().length === n0 && miss.includes('is-miss') && miss.includes('没找到画'));
  box.processAiCommands('```svg\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>\n```\n[[GALLERY: 圆]]\n[[GALLERY: 还是那个圆]]', {}, conf);
  await flush();
  const svgIt = items().find(it => it.caption === '圆');
  t('svg 包成一页再挂', !!svgIt && svgIt.src.includes('<svg') && /<body/.test(svgIt.src));
  t('★ 同一条消息里两个指令指着同一块：只挂一次', items().length === n0 + 1, items().map(i => i.caption));

  console.log('\n[4] blocks 路径只画卡片');
  const before = items().length;
  const setsBefore = sets;
  const blocks = [{ type: 'text', text: '```html\n<b>hi</b>\n```' }, { type: 'text', text: '[[GALLERY: 分块了]]' }, { type: 'text', text: '[[GALLERY: 空]]' }];
  box._applyGalleryToBlocks(blocks);
  await flush();
  t('★ blocks 路径不重复挂、不写盘', items().length === before && sets === setsBefore);
  t('代码块和指令被切进不同 block 时仍认得出前面有画',
    blocks[1].text.includes('🖼 挂上了画板') && !blocks[1].text.includes('[[GALLERY'), blocks[1].text);

  console.log('\n[5] 流式遮挡');
  t('写了一半的指令也藏起来', box.maskStreamingTags('画好了\n[[GALLERY: 今晚') === '画好了\n〔🖼 正在挂上画板…〕');
  t('遮挡进了总表', vm.runInContext("_STREAM_MASKS.includes('maskStreamingGallery')", box));

  console.log('\n[6] 历史回填自咬合');
  const history = box.stickerTagForApi(cooked);
  t('★ 回填成正牌 [[GALLERY: 注脚]]，没有展示形态', history.includes('[[GALLERY: 今晚的月亮，三个坑]]')
    && !history.includes('gallery-chat-card') && !history.includes('挂上了画板'), history.slice(-120));
  t('没找到画的那张卡也咬回指令', box.stickerTagForApi(miss).includes('[[GALLERY: 想挂]]'));

  console.log('\n[7] 技能开关');
  const pconf = { id: 'm1', nickname: '阿岚', modelName: 'test-model', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 };
  const chat = { id: 'c1', title: '测试', nodes: {}, headId: null };
  state.skillsOff = {};
  const full = box.buildSystemPrompt(pconf, chat, '', null, {});
  state.skillsOff = { gallery: true };
  const lean = box.buildSystemPrompt(pconf, chat, '', null, {});
  state.skillsOff = {};
  t('开着有 [画板技能]，关掉就没了', full.includes('[画板技能]') && full.includes('[[GALLERY: 一句话]]') && !lean.includes('[画板技能]'));

  console.log('\n[8] 舞台');
  const doc = box.galleryStageDoc({ kind: 'html', src: '<html><head><title>x</title></head><body>$& ok</body></html>' });
  t('$& 原样保留（函数式替换）', doc.includes('$& ok'));
  const img = box.galleryStageDoc({ kind: 'image', src: 'data:image/png;base64,AAA"x' });
  t('图片地址转义，不会逃出属性', img.includes('AAA&quot;x') && !img.includes('AAA"x'));

  console.log('\n[9] 全屏');
  const cls = new Set();
  let asked = 0, exited = 0;
  const stage = {
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    // 安卓 WebView 要不到原生全屏：promise 被拒，不许冒成未处理的错误
    requestFullscreen: () => { asked++; return Promise.reject(new Error('not supported')); },
  };
  const modal = { classList: { add() {}, remove() {}, contains: () => false } };
  box.document.getElementById = id => (id === 'galleryStage' ? stage : id === 'galleryModal' ? modal : null);
  box.document.exitFullscreen = () => { exited++; box.document.fullscreenElement = null; return Promise.resolve(); };
  const fire = (type, ev) => (docListeners[type] || []).forEach(fn => fn(ev || {}));
  const keyEsc = () => { let stopped = false; fire('keydown', { key: 'Escape', stopPropagation() { stopped = true; } }); return stopped; };

  box.galleryFullscreen(true);
  await flush();
  t('要到原生全屏之前先铺满窗口，原生那层被拒也还铺着', cls.has('is-full') && asked === 1, [...cls]);
  t('★ Esc 收回铺满，并且拦住不让它顺手关掉整个画板', keyEsc() === true && !cls.has('is-full'));
  t('没在全屏时 Esc 不拦', keyEsc() === false);

  box.galleryFullscreen(true);
  box.document.fullscreenElement = stage;
  box.galleryFullscreen(false);
  t('✕ 退出：收回铺满，也退掉原生全屏', !cls.has('is-full') && exited === 1);

  box.galleryFullscreen(true);
  box.document.fullscreenElement = null;
  fire('fullscreenchange');
  t('★ 用户自己按 Esc 退了原生全屏，铺满跟着收回（不留一个没法退的假全屏）', !cls.has('is-full'));

  box.galleryFullscreen(true);
  box.closeGallery();
  t('关画板时全屏一起收掉', !cls.has('is-full'));

  cls.add('is-empty');
  box.galleryFullscreen(true);
  t('空画板不进全屏', !cls.has('is-full'));

  console.log('\n[10] 看源码 / 复制源码');
  t('★ svg 挂上来被包过一层，源码剥回原来那块 svg', box.gallerySourceOf(svgIt) === '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
    box.gallerySourceOf(svgIt));
  const moon = items().find(it => it.caption === '今晚的月亮，三个坑');
  t('html 原样给', box.gallerySourceOf(moon) === moon.src);
  t('图片没有源码', box.gallerySourceOf({ kind: 'image', src: 'data:image/png;base64,AAA' }) === '');

  const el = () => ({ innerHTML: '', dataset: {}, classList: { add() {}, remove() {}, contains: () => false } });
  const dom = { galleryList: el(), galleryStage: el(), galleryMeta: el() };
  let loads = 0;
  dom.galleryFrame = Object.assign(el(), {});
  Object.defineProperty(dom.galleryFrame, 'srcdoc', { get() { return this._d || ''; }, set(v) { if (v) loads++; this._d = v; } });
  box.document.getElementById = id => dom[id] || null;
  const tricky = await box.galleryAdd({ kind: 'html', author: '克克', caption: '带尖括号',
    src: '<!doctype html><html><head></head><body><script>if (a < b && c) x = "</div>";<\/script></body></html>' });
  box.gallerySelect(tricky.id);
  const loads0 = loads;
  t('关着时有「源码」按钮，按钮字没被当成标签吞掉', dom.galleryMeta.innerHTML.includes('&lt;/&gt; 源码')
    && !dom.galleryMeta.innerHTML.includes('</> ') && !dom.galleryMeta.innerHTML.includes('gallery-src-code'));
  box.galleryToggleSrc();
  const shown = dom.galleryMeta.innerHTML;
  t('★ 展开后源码转义着显示，不会被当成真标签插进页面', shown.includes('gallery-src-code')
    && shown.includes('&lt;script&gt;if (a &lt; b &amp;&amp; c) x = &quot;&lt;/div&gt;&quot;;'), shown.slice(-260));
  t('★ 展开/收起不重载舞台（画接着播）', loads === loads0, [loads0, loads]);
  let copied = null;
  box.copyTextCompat = s => { copied = s; return Promise.resolve(); };
  const btn = { textContent: '', classList: { toggle() {}, remove() {} } };
  box.galleryCopySrc(btn);
  await flush();
  t('★ 复制的是原文，不是转义后的', copied === tricky.src && btn.textContent === '✓ 已复制', [copied && copied.slice(0, 40), btn.textContent]);
  box.galleryToggleSrc();
  t('再点一下收起', !dom.galleryMeta.innerHTML.includes('gallery-src-code'));
  vm.runInContext('_gallerySrcOpen = true', box);
  const pic = await box.galleryAdd({ kind: 'image', src: 'data:image/png;base64,AAA', author: '小明' });
  box.gallerySelect(pic.id);
  t('图片没有源码按钮，也不出源码框', !dom.galleryMeta.innerHTML.includes('源码'), dom.galleryMeta.innerHTML.slice(0, 200));

  console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
