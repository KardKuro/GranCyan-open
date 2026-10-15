const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');

test('study widget is presented as a midnight study room', () => {
  assert.match(html, /id="studyModal"[\s\S]*class="cap-panel-full study-panel"/);
  assert.match(html, /class="study-room"[\s\S]*study-window[\s\S]*study-shelf[\s\S]*study-lamp/);
  assert.match(html, /MIDNIGHT STUDY/);
  assert.match(css, /\.study-room \{[^}]*overflow:hidden/);
  assert.match(css, /\.study-window \{/);
  assert.match(css, /\.study-shelf \{/);
  assert.match(css, /\.study-lamp \{/);
});

test('study room remains usable on narrow phones', () => {
  assert.match(html, /class="study-scroll"[\s\S]*class="study-room"[\s\S]*id="studyBody"/);
  assert.match(css, /\.study-scroll \{[^}]*overflow-y:auto/);
  assert.match(css, /\.study-body \{[^}]*overflow:visible/);
  assert.match(css, /@media\(max-width:560px\)\{[\s\S]*\.study-room \{ height:126px/);
  assert.match(css, /\.study-body \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.study-row-due-txt \{[^}]*text-overflow:ellipsis/);
});

test('feature guide describes the study room without dropping study behavior', () => {
  assert.match(html, /单词卡[\s\S]*深夜自习室/);
  assert.match(html, /词库与复习[\s\S]*批量导入/);
  assert.match(html, /自己刷单词[\s\S]*提前刷/);
});

// 用户：「把学习卡片改名叫单词卡，并放在更显眼的位置，不然想学习都找不到」
test('word cards have a first-level entry in the sidebar and header, not only in widgets', () => {
  const sideTop = html.slice(html.indexOf('<div class="sidebar-top">'), html.indexOf('<nav id="chatList">'));
  assert.match(sideTop, /id="studyEntryBtn"[^>]*onclick="openStudy\(\)/, 'sidebar top has the entry');
  assert.match(sideTop, /<span>单词卡<\/span>/);
  assert.match(sideTop, /id="studyEntryBadge"/);
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.match(header, /onclick="openStudy\(\)"[^>]*title="单词卡"[\s\S]*id="studyHeadBadge"/, 'header has the entry');
  assert.match(html, /<h3>📇 单词卡<\/h3>/);
  // 界面上别再剩旧名（help 和面板标题）；提示词里的旧名不动，动了会让技能 tok 集体漂
  assert.doesNotMatch(html, /学习卡片/);
  assert.match(css, /\.study-entry-badge \{/);
  assert.match(css, /#studyBody > \.study-reset-row/, 'reset row is in the width:100% list');
});
