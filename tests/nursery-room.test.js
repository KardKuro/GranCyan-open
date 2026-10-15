const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');

test('nursery artwork is the first child of its only vertical scroller', () => {
  assert.match(html, /class="nursery-scroll">\s*<div class="nursery-room"[\s\S]*?<div id="nurseryBody"/);
  assert.match(css, /\.nursery-scroll\s*\{[^}]*overflow-y:auto/);
  assert.match(css, /\.nurse-body\s*\{[^}]*flex:none[^}]*overflow:visible/);
});

test('nursery keeps every care control while gaining room furniture', () => {
  for (const token of ["nurseryMamaSay()", "nurseryMama('hug')", "nurseryMama('soothe')", "nurseryMama('touch')", "nurseryShow('album')", "nurseryShow('log')", "nurseryShow('help')"]) {
    assert.match(fs.readFileSync(path.join(root, 'js', '21-nursery.js'), 'utf8'), new RegExp(token.replace(/[()?'']/g, '\\$&')));
  }
  for (const cls of ['nursery-moon-window', 'nursery-copybook', 'nursery-mobile', 'nursery-crib', 'nursery-nightlight']) assert.match(html, new RegExp(cls));
  assert.match(html, /id="nurseryCopybook" class="nursery-copybook"><\/div>/);
  const js = fs.readFileSync(path.join(root, 'js', '21-nursery.js'), 'utf8');
  assert.match(js, /function _nurseWriteCopybook\(text\)/);
  assert.match(js, /find\(s => \/\^最近在说/);
  assert.match(js, /slice\(0, 48\)/);
  assert.match(js, /classList\.toggle\('medium'/);
  assert.match(js, /classList\.toggle\('long'/);
});

test('feature guide explains the scroll-away midnight nursery', () => {
  assert.match(html, /育儿室 \/ Cookie[\s\S]*深夜婴儿房[\s\S]*田字格[\s\S]*随内容一起滑出屏幕/);
});
