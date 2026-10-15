// 版本号一处真源：package.json 的 version。其余地方都得跟它对齐。
//
// 为什么要守：2.2 之前版本号散在五个地方（package.json、package-lock 两处、
// AndroidManifest、主页文件名、目录名），升一次版要手改一圈。结果就是漂了整整
// 一个版本才被发现——目录和 html 都写着 2.1，package.json 还停在 2.0.0，
// 而且没有任何东西会报错。这个文件就是那个「会报错的东西」。
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const manifest = read('android/AndroidManifest.xml');

test('package.json 的 version 是 x.y.z', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/,
    `version 必须是完整 semver，现在是 ${pkg.version}`);
});

test('package-lock.json 两处 version 跟 package.json 一致', () => {
  // npm 会同时写顶层和 packages[""] 两处，手改 package.json 时极易只改一处。
  assert.equal(lock.version, pkg.version, 'package-lock.json 顶层 version 漂了');
  assert.equal(lock.packages[''].version, pkg.version,
    'package-lock.json 的 packages[""].version 漂了');
});

test('AndroidManifest 的 versionName 跟 package.json 一致', () => {
  const m = manifest.match(/android:versionName="([^"]+)"/);
  assert.ok(m, 'AndroidManifest.xml 里找不到 versionName');
  assert.equal(m[1], pkg.version,
    `安卓显示 ${m[1]}、桌面显示 ${pkg.version}，同一次发布会被当成两个版本`);
});

test('AndroidManifest 的 versionCode 是正整数', () => {
  // 安卓只认 versionCode 判断新旧，它必须单调递增，而且跟 versionName 没有推导关系，
  // 只能人工维护。这里只能守住格式，递增要靠发版时自己记得 +1。
  const m = manifest.match(/android:versionCode="([^"]+)"/);
  assert.ok(m, 'AndroidManifest.xml 里找不到 versionCode');
  assert.match(m[1], /^\d+$/, `versionCode 必须是纯数字，现在是 ${m[1]}`);
  assert.ok(Number(m[1]) > 0, 'versionCode 必须大于 0');
});

test('版本号没有偷偷爬回文件名里', () => {
  // 2.2 起主页固定叫 index.html。之前叫 Grancyan2.1.html，被 findDevRoot、
  // 主页路由、自检、build.ps1 和 20 多个测试引用，每升一版就要改一圈、漏一处 exe 白屏。
  const strays = fs.readdirSync(root)
    .filter(f => /^Grancyan.*\.html$/i.test(f));
  assert.deepEqual(strays, [],
    `根目录出现了带名字的 html：${strays.join(', ')}。主页应该只叫 index.html`);
  assert.ok(fs.existsSync(path.join(root, 'index.html')), 'index.html 不见了');
});

test('主页引用方都指向 index.html', () => {
  // 这三处是当年被文件名绑架的地方，回归的话这里先红。
  assert.match(read('server.js'), /res\.sendFile\(path\.join\(ROOT, 'index\.html'\)\)/);
  assert.match(read('server.js'), /exists\(path\.join\(ROOT, 'index\.html'\)\)/);
  assert.match(read('android/build.ps1'), /Copy-Item\s+"\$proj\\index\.html"/);
});

test('findDevRoot 认门牌不靠文件名', () => {
  // 认 package.json 的 name 而不是带版本号的文件名——这就是拆分的意义所在。
  const src = read('electron-main.js');
  assert.match(src, /pkg\.name === 'grancyan'/);
  assert.doesNotMatch(src, /const marker = '/,
    'marker 又变回写死的文件名了，升版本会重新开始漏引用');
});
