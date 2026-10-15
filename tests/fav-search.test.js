// 收藏消息搜索：输入框、过滤语义、显示安全与安卓副本回归。
// 跑法：node tests/fav-search.test.js
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

const html = read('index.html');
const render = read('js/06-render-msg.js');

console.log('\n[收藏搜索 UI]');
const favPanel = html.slice(html.indexOf('<div id="favModal"'), html.indexOf('<!-- ── 模型日记本'));
t('收藏面板有独立搜索框并接到 setFavSearch',
  /id="favSearchInput"[^>]*oninput="setFavSearch\(this\.value\)"/.test(favPanel));
t('搜索框在会被重画的 favList 外面',
  favPanel.indexOf('id="favSearchInput"') >= 0
  && favPanel.indexOf('id="favSearchInput"') < favPanel.indexOf('id="favList"'));
t('Esc 只清搜索，不顺手关掉整个 Hub',
  /onkeydown="if\(event\.key==='Escape'\)\{event\.stopPropagation\(\);clearFavSearch\(\)\}"/.test(favPanel));

console.log('\n[过滤语义]');
const searchStart = render.indexOf("let _favSearch = '';");
const searchEnd = render.indexOf('\nfunction favGroupList()', searchStart);
const searchSrc = render.slice(searchStart, searchEnd);
let renders = 0;
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const api = new Function('escHtml', 'renderFavList', 'document',
  searchSrc + '\nreturn { setFavSearch, favSearchHit, favHi, clearFavSearch };')(
    escHtml, () => { renders++; }, { getElementById: () => null });

const fav = { text: '凌晨修好了滚动定位', model: 'Claude Opus', chatTitle: '夜航开发', group: '灵感' };
api.setFavSearch('CLAUDE 定位');
t('多词按 AND 搜索，且能跨正文 / 模型字段命中', api.favSearchHit(fav));
t('缺一个词就不命中', !api.favSearchHit({ ...fav, text: '凌晨修好了天气' }));
api.setFavSearch('夜航 灵感');
t('对话名和分组名也能搜索', api.favSearchHit(fav));
t('输入会立即重画收藏列表', renders === 2);

console.log('\n[显示与安全]');
api.setFavSearch('<script>');
const hi = api.favHi('别执行 <script>，只显示它');
t('原文先转义再高亮，不会把收藏内容插成 HTML',
  !hi.includes('<script>') && hi.includes('<mark class="mem-hit">&lt;script&gt;</mark>'));
t('搜索结果显示命中数和无结果提示',
  /找到 \$\{entries\.length\} 条/.test(render) && /没有收藏匹配/.test(render));
t('过滤后仍传 state.favMessages 的原始下标',
  /\.map\(\(f, i\) => \(\{ f, i \}\)\)[\s\S]{0,240}favSearchHit\(f\)/.test(render)
  && /entries\.map\(\(\{ f, i \}\)/.test(render));

console.log('\n[桌面与安卓副本]');
t('收藏搜索的 HTML 与 JS 已同步进安卓包',
  fs.readFileSync(path.join(ROOT, 'index.html')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/index.html')))
  && fs.readFileSync(path.join(ROOT, 'js/06-render-msg.js')).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js/06-render-msg.js'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
