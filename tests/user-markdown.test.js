const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const render = fs.readFileSync(path.join(root, 'js', '06-render-msg.js'), 'utf8');
const input = fs.readFileSync(path.join(root, 'js', '09-appearance-input.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');

test('normal and expanded user messages share Markdown rendering', () => {
  assert.equal((render.match(/renderUserText\(m\.content\)/g) || []).length, 2);
});

test('user Markdown escapes HTML and blocks unsafe links and remote images', () => {
  assert.match(input, /function renderUserText[\s\S]*escHtml\(raw \|\| ''\)/);
  assert.match(input, /querySelectorAll\('img'\)[\s\S]*replaceWith/);
  assert.match(input, /\^\(https\?:\|mailto:\)/);
  assert.match(input, /noopener noreferrer/);
});

// 上一版把表情包当成「用户正文里的 Markdown 远程图片」清洗掉了，气泡里只剩 alt 那行字。
// 判据取反面：清洗那一刻表情包必须还是占位符，所以 stickerTagToHtml 只许在还原时调用，
// 绝不能在喂给 marked 之前就把标签变成 <img>，两个出口也都必须经过还原。
test('app-generated stickers survive the user-image sanitizer', () => {
  const fn = input.match(/function renderUserText\([\s\S]*?\n\}/)[0];
  assert.match(fn, /\\\[\\\[\[A-Z0-9_\]\+:[\s\S]*?keep/);          // 富媒体标签先抠成占位符
  assert.doesNotMatch(fn, /marked\.parse\(\s*stickerTagToHtml/);   // 别把表情 HTML 直接喂 marked
  assert.equal((fn.match(/stickerTagToHtml\(/g) || []).length, 1); // 只在还原处调用一次
  assert.match(fn, /const restore = [\s\S]*?stickerTagToHtml/);
  assert.doesNotMatch(fn, /return (html|tpl\.innerHTML);/);        // 两个 return 都得走 restore
});

// 占位符要是固定字面量，正文里手打（或 AI 原样吐出）一串同形文本就会被还原逻辑撞上：
// 下标越界的被吞成空，撞上真实下标的被换成别处的内容。所以必须每次现摇。
test('all rich-text placeholders use a per-call random nonce', () => {
  assert.match(input, /function _placeholderNonce\(\)[\s\S]{0,200}Math\.random\(\)/);
  for (const name of ['renderUserText', 'renderRichText']) {
    const fn = input.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
    assert.match(fn, /const nonce = _placeholderNonce\(\)/, `${name} 得用现摇的 nonce`);
    assert.match(fn, /new RegExp\(nonce/, `${name} 还原也得用同一个 nonce`);
    // 反面判据：函数体里不许再出现写死的 'zZ…' 前缀，写死了就是可被撞上的
    assert.doesNotMatch(fn, /'zZ/, `${name} 里还留着写死的占位符前缀`);
  }
});

test('user Markdown has compact bubble styling', () => {
  assert.match(css, /\.bubble\.user p[\s\S]*\.bubble\.user strong[\s\S]*\.bubble\.user code/);
});
