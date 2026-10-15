// findDevRoot 认项目根靠的是「package.json 的 name 是 grancyan + 旁边有 index.html」。
// 认错的代价是 ROOT 退化成只读 asar，手环/表情/育儿室存档全静默失效——这个项目踩过。
// 所以这里不只是匹配源码文本，而是把真实的 isProjectRoot 抠出来实际跑一遍。
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');

// 从真实源码里取函数体，而不是在测试里复制一份逻辑——复制的话源码改坏了测试照样绿。
function loadIsProjectRoot(warnings) {
  const m = source.match(/function isProjectRoot\(dir\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'electron-main.js 里找不到 isProjectRoot');
  const consoleStub = { warn: (...a) => warnings.push(a.join(' ')), log: () => {} };
  return new Function('fs', 'path', 'console', `${m[0]}\nreturn isProjectRoot;`)(fs, path, consoleStub);
}

// 全套测试会被反复跑，每次都往 %TEMP% 扔目录的话迟早堆成山，收工时一并清掉。
const madeDirs = [];
process.on('exit', () => {
  for (const d of madeDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理失败无所谓 */ }
  }
});

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grancyan-root-'));
  madeDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('真正的项目根认得出来', () => {
  const warnings = [];
  const isProjectRoot = loadIsProjectRoot(warnings);
  const dir = makeDir({
    'index.html': '<html></html>',
    'package.json': JSON.stringify({ name: 'grancyan', version: '2.2.0' }),
  });
  assert.equal(isProjectRoot(dir), true);
  assert.deepEqual(warnings, [], '正常路径不该打扰用户');
});

test('没有 index.html 的目录安静地不认，不刷警告', () => {
  const warnings = [];
  const isProjectRoot = loadIsProjectRoot(warnings);
  const dir = makeDir({ 'package.json': JSON.stringify({ name: 'grancyan' }) });
  assert.equal(isProjectRoot(dir), false);
  assert.deepEqual(warnings, [], '走错门是常态，不该每层目录都喊一句');
});

test('别人家的 package.json 不认', () => {
  const warnings = [];
  const isProjectRoot = loadIsProjectRoot(warnings);
  const dir = makeDir({
    'index.html': '<html></html>',
    'package.json': JSON.stringify({ name: 'some-other-app' }),
  });
  assert.equal(isProjectRoot(dir), false);
  assert.deepEqual(warnings, []);
});

// 下面三条是核心：有 index.html 说明这**多半就是**项目根，
// 此时门牌读不动是最危险的失败——必须喊出来，而且绝不能崩。
test('package.json 是损坏的 JSON：警告 + 返回 false，不抛', () => {
  const warnings = [];
  const isProjectRoot = loadIsProjectRoot(warnings);
  const dir = makeDir({ 'index.html': '<html></html>', 'package.json': '{ 这不是 json' });
  assert.equal(isProjectRoot(dir), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /package\.json 读不动/);
});

test('package.json 内容是合法 JSON 的 null：警告 + 返回 false，不抛 TypeError', () => {
  // JSON.parse('null') 不抛异常，直接返回 null。少了结构校验的话，
  // 后面读 .name 会在 try 外面抛 TypeError；findDevRoot 是模块顶层执行的，
  // 那等于 exe 起不来，而且一句警告都没有。
  const warnings = [];
  const isProjectRoot = loadIsProjectRoot(warnings);
  const dir = makeDir({ 'index.html': '<html></html>', 'package.json': 'null' });
  assert.equal(isProjectRoot(dir), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /package\.json 读不动/);
});

test('package.json 是标量而不是对象：同样警告 + false', () => {
  for (const scalar of ['123', '"grancyan"', 'true']) {
    const warnings = [];
    const isProjectRoot = loadIsProjectRoot(warnings);
    const dir = makeDir({ 'index.html': '<html></html>', 'package.json': scalar });
    assert.equal(isProjectRoot(dir), false, `内容 ${scalar} 应该不认`);
    assert.equal(warnings.length, 1, `内容 ${scalar} 应该警告`);
  }
});

test('findDevRoot 仍然跳过 asar 内路径', () => {
  // 包内也有 package.json 和 index.html，不跳的话第一轮就命中只读的 app.asar。
  assert.match(source, /!dir\.includes\('\.asar'\)\s*&&\s*isProjectRoot\(dir\)/);
});

// ---- 兜底扫描：exe 被拷到项目外时唯一的活路 ----
// 原来这里写死过一个带版本号的路径，目录一改名就成死路径，而且失败得毫无声响。
// 现在改成扫 GRANCYAN_DEV_PARENTS 列出的父目录下所有 GranCyan* 目录，所以它有了真逻辑，得测。
// 注入假 fs 来跑真源码：不这么做就只能测源码文本，改坏了照样绿。
function loadFindDevRoot({ dirs = {}, roots = {}, dirname = 'X:\\nowhere\\deep\\enough', parents } = {}) {
  process.env.GRANCYAN_DEV_PARENTS = (parents || Object.keys(dirs)).join(';');
  const isSrc = source.match(/function isProjectRoot\(dir\) \{[\s\S]*?\n\}/);
  const fdSrc = source.match(/function findDevRoot\(\) \{[\s\S]*?\n\}/);
  assert.ok(isSrc && fdSrc, 'electron-main.js 里找不到 isProjectRoot / findDevRoot');
  const fsStub = {
    existsSync: p => Object.keys(roots).some(r => p === path.join(r, 'index.html')),
    readFileSync: p => {
      const owner = Object.keys(roots).find(r => p === path.join(r, 'package.json'));
      if (!owner) throw new Error('ENOENT');
      return JSON.stringify({ name: roots[owner] });
    },
    readdirSync: base => {
      if (!(base in dirs)) throw new Error(`ENOENT: ${base}`);
      return dirs[base];
    },
  };
  const consoleStub = { warn: () => {}, log: () => {} };
  return new Function('fs', 'path', 'console', '__dirname',
    `${isSrc[0]}\n${fdSrc[0]}\nreturn findDevRoot;`)(fsStub, path, consoleStub, dirname);
}

test('兜底：从自身位置往上找不到时，扫 GRANCYAN_DEV_PARENTS 下的 GranCyan*', () => {
  const findDevRoot = loadFindDevRoot({
    dirs: { 'X:\\projects': ['llm-nursery', 'GranCyan', 'relay'] },
    roots: { 'X:\\projects\\GranCyan': 'grancyan' },
  });
  assert.equal(findDevRoot(), 'X:\\projects\\GranCyan');
});

test('兜底：多份并存时挑排序最大的那个（新版本优先）', () => {
  // 倒序是刻意的——2.2 和 2.1 并存时该进 2.2，而不是看目录项返回顺序碰运气。
  const findDevRoot = loadFindDevRoot({
    dirs: { 'X:\\projects': ['GranCyan2.1', 'GranCyan2.2'] },
    roots: { 'X:\\projects\\GranCyan2.1': 'grancyan', 'X:\\projects\\GranCyan2.2': 'grancyan' },
  });
  assert.equal(findDevRoot(), 'X:\\projects\\GranCyan2.2');
});

test('兜底：名字像但门牌不对的目录会被跳过，继续找真的', () => {
  const findDevRoot = loadFindDevRoot({
    dirs: { 'X:\\projects': ['GranCyan', 'GranCyan历史版本'] },
    // 历史版本目录排序更大会先被试到，但它的 name 不是 grancyan，必须跳过
    roots: { 'X:\\projects\\GranCyan历史版本': 'grancyan-archive', 'X:\\projects\\GranCyan': 'grancyan' },
  });
  assert.equal(findDevRoot(), 'X:\\projects\\GranCyan');
});

test('兜底：盘/目录不存在时不抛，接着试下一个', () => {
  // 列出的父目录不一定都在这台机器上。readdirSync 会抛 ENOENT，没接住的话
  // findDevRoot 在模块顶层直接炸 —— exe 起不来，一句话都没有。
  const findDevRoot = loadFindDevRoot({
    parents: ['X:\\projects', 'Y:\\old'],
    dirs: { 'Y:\\old': ['GranCyan'] },   // 只有它存在，X:\projects 会抛
    roots: { 'Y:\\old\\GranCyan': 'grancyan' },
  });
  assert.equal(findDevRoot(), 'Y:\\old\\GranCyan');
});

test('没配 GRANCYAN_DEV_PARENTS：不去扫任何盘，直接 null', () => {
  const findDevRoot = loadFindDevRoot({ parents: [], dirs: { 'X:\\projects': ['GranCyan'] }, roots: { 'X:\\projects\\GranCyan': 'grancyan' } });
  assert.equal(findDevRoot(), null);
});

test('兜底：全都找不到时返回 null，不抛', () => {
  const findDevRoot = loadFindDevRoot({ dirs: {}, roots: {} });
  assert.equal(findDevRoot(), null);
});

test('兜底路径里不许再写死版本号（只看代码，注释不算）', () => {
  // 这正是这轮要根治的毛病：写死 GranCyan2.1，改名后静默失效。
  // 注意断言前要把注释剥掉——上面那段注释本身就在讲 GranCyan2.1/2.2，
  // 不剥的话这条永远红，而红的原因跟它想守的东西毫无关系。
  // 剥注释是**有意**放过它们：注释里怎么写都不影响运行时行为。
  const fd = source.match(/function findDevRoot\(\) \{[\s\S]*?\n\}/)[0];
  const codeOnly = fd.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /GranCyan\d/i,
    'findDevRoot 的代码里又出现带版本号的目录名了——目录一改名它就是死路径');
});
