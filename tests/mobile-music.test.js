const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const music = fs.readFileSync(path.join(root, 'js', '24-music.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'android', 'src', 'com', 'grancyan', 'app', 'CoreadServer.java'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'grancyan.css'), 'utf8');

test('Android music uses the built-in localhost proxy', () => {
  assert.match(music, /function musicApiBase\(\)/);
  assert.match(music, /http:\/\/localhost:8080/);
  for (const route of ['search', 'url', 'pick', 'lyric']) {
    assert.match(music, new RegExp(`musicApiBase\\(\\).*api/music/${route}`));
    assert.match(android, new RegExp(`/api/music/${route}`));
  }
  assert.match(android, /Access-Control-Allow-Origin/);
  assert.match(android, /for \(int attempt = 0; attempt < 2; attempt\+\+\)/);
});

test('AI external citations render as compact black pills', () => {
  assert.match(css, /\.bubble\.ai a\[href\^="http"\]:not\(\[class\]\)/);
  assert.match(css, /border-radius:999px/);
  assert.match(css, /background:rgba\(0,0,0,\.72\)/);
});

// 2026-09-30 起面板换成用户画的稿（唱片 + 频谱圈），原来的「唱片室」那两条在这里退役，
// 新面板的测试在 tests/music-player-v3.test.js。
test('cover spins with the record without jumping back on repaint', () => {
  // 面板播放/暂停都会整块重画：旋转角度必须从当前播放时间接上，不然每重画一次封面就跳回 0°
  assert.match(music, /vinylPhase[\s\S]*--vinyl-phase:/);
  assert.match(css, /\.mz-platter \{[^}]*transform:rotate\(var\(--vinyl-phase/);
  assert.match(css, /@keyframes mzSpin \{ from\{transform:rotate\(var\(--vinyl-phase/);
  // 相位的周期必须和动画一圈的时长一致，否则接上的角度是错的
  const period = +(music.match(/currentTime\) \|\| 0\) % (\d+)\) \/ \1 \* 360/) || [])[1];
  const anim = +(css.match(/\.mz-stage\.is-playing \.mz-platter \{ animation:mzSpin (\d+)s/) || [])[1];
  assert.ok(period && period === anim, `相位周期 ${period}s 和动画 ${anim}s 要一致`);
});
