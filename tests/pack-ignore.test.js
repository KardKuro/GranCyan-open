/* pack:exe 的 ignore 规则：.gitignore 里排掉的构建产物，打包时也必须排掉。
 *
 * 为什么要守：2026-08-16 发 2.3.0 时发现新 exe 的 asar 里套了一整份**旧的打包产物**
 * （`dist-new/`，480 MB，含一个 225 MB 的旧 exe 和一个 133 MB 的旧 asar），
 * zip 因此从 188 MB 涨到 376 MB。根因是 ignore 正则写的 `^/dist($|/)`——
 * `dist` 后面必须紧跟结尾或斜杠，所以 `dist-new` 和 `dist_build` 全漏了。
 *
 * 这类漏洞**不会报错**：打出来的包能跑，只是大一倍，不专门去量根本不会发现。
 * 更坏的情况是嵌进去的旧产物里裹着当时还没排除的敏感文件（见 PRIVATE-FILES.md）——
 * 那就从"浪费空间"变成"分发泄露"。
 *
 * ⚠️ 规则必须**从 package.json 里读出来**，不能手抄进测试：手抄一遍就是在测另一个东西。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

// 从 pack:exe 脚本里把 --ignore="..." 全抠出来，转成真正的 RegExp
function packIgnoreRegexes() {
  const script = pkg.scripts['pack:exe'];
  assert.ok(script, 'package.json 里没有 pack:exe');
  const out = [];
  const re = /--ignore="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(script)) !== null) out.push(new RegExp(m[1]));
  return out;
}

const ignores = packIgnoreRegexes();
const blocked = p => ignores.some(re => re.test(p));

test('从 pack:exe 里真的抠出了 ignore 规则', () => {
  // 对照组：抠不出来的话，下面每条"该挡的挡住了"都会变成假绿
  assert.ok(ignores.length >= 10, `只抠出 ${ignores.length} 条规则，正则大概坏了`);
});

// 「不进版本库」≠「不进安装包」。这两个必须打进 exe，否则包是坏的：
//   node_modules —— 运行时依赖
//   stickers     —— 内置表情素材（build.ps1 也会把它同步进 APK）
// ⚠️ stickers-fav/ 长得像但**不是**一路人：那是用户在 App 里上传/收藏的私人表情，
//    属于个人数据，必须排除。名字相近的两个目录一个必发一个必排，别看走眼。
// 例外只能显式写在这里并说明理由，不许靠"忘了加规则"来实现。
const MUST_SHIP = new Set(['node_modules', 'stickers']);

// .gitignore 里"整个目录"至少有三种写法：`dist/`、`stickers-fav/*`、以及光秃秃的 `dist`。
// 2026-08-22 之前这里只认第一种，于是 stickers-fav/（12 MB 私人收藏）一路漏进了 asar ——
// 而测试**全绿**，因为它压根没把这条当成目录，也就没生成任何断言。漏检比断言失败更危险。
//
// ⚠️ 所以这里**不枚举写法**：枚举一定还会漏第四种。判据改成落到磁盘上问一句
// "它现在是不是一个真目录" —— 而这恰好就是风险本身的定义：能被打进包的，
// 只可能是此刻真实存在于磁盘上的目录。不存在的目录漏了也无害。
function gitignoreEntries() {
  const out = [];
  for (const line of gitignore.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith('!')) continue;
    const p = l.replace(/\/\*+$/, '').replace(/^\//, '').replace(/\/$/, '');
    if (!p || /[*?\[\]]/.test(p)) continue;      // 还带通配的（*.log）不是具体目录
    out.push({ p, slashy: /\/\**$/.test(l) });   // slashy：写法本身就说明它是目录（`dist/`、`x/*`）
  }
  return out;
}
function gitignoredDirs(base) {
  const dirs = new Set();
  for (const { p } of gitignoreEntries()) {
    let st;
    try { st = fs.statSync(path.join(base, p)); } catch { continue; }
    if (st.isDirectory()) dirs.add(p);
  }
  return [...dirs];
}

// ⚠️ 新克隆下来时 dist/、tests/out/ 这些产物目录**都还不存在**，直接问本仓库的磁盘
//   会得到一张几乎是空的表 —— 下面的断言要么红（「没解析出目录」），要么变成零断言假绿。
//   所以判据（「是不是真目录」）不动，换的是被问的那块磁盘：在临时目录里搭一台
//   「跑过一阵子的开发机」——
//     ① 本仓库里此刻真实存在的、被 .gitignore 点名的目录，照样建一个（保留「问磁盘」那条防线：
//        `dist` 这种不带斜杠的写法只要真成了目录，一样会被抓到）；
//     ② 写法上就是目录的条目（`xxx/`、`xxx/*`）全部建出来 —— 它们迟早会在某台机器上长出来。
//   文件条目（key.pem、*.db…）不建：它们不是目录，建了反而会把文件当目录测。
const SIM_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'grancyan-pack-ignore-'));
process.on('exit', () => { try { fs.rmSync(SIM_ROOT, { recursive: true, force: true }); } catch { } });
for (const { p, slashy } of gitignoreEntries()) {
  let realDir = false;
  try { realDir = fs.statSync(path.join(root, p)).isDirectory(); } catch { }
  if (realDir || slashy) fs.mkdirSync(path.join(SIM_ROOT, p), { recursive: true });
}

test('判据本身：只认磁盘上真的目录（不存在的、是文件的都不算）', () => {
  // 对照组：上面搭的是模拟机。这里单独验 gitignoredDirs 的判据没被模拟机掩盖 ——
  // 一个空目录里什么都不该被认出来；文件条目建成文件也不该被认成目录。
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'grancyan-pack-ignore-empty-'));
  try {
    assert.deepEqual(gitignoredDirs(empty), [], '空目录里认出了目录 —— 判据不再看磁盘了');
    fs.writeFileSync(path.join(empty, 'key.pem'), 'x');
    fs.mkdirSync(path.join(empty, 'dist'));
    assert.deepEqual(gitignoredDirs(empty), ['dist'], '文件被认成了目录，或者真目录没认出来');
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('从 .gitignore 里真的解析出了目录（含 `xxx/*` 写法）', () => {
  // 对照组：解析器一旦漏了某种写法，下一条测试对那个目录就是"零断言通过"
  const dirs = gitignoredDirs(SIM_ROOT);
  assert.ok(dirs.includes('dist'), '`dist/` 写法没认出来');
  assert.ok(dirs.includes('stickers-fav'), '`stickers-fav/*` 写法没认出来 —— 就是这个漏洞放走了私人收藏');
  assert.ok(dirs.includes('tests/out'), '带斜杠的多级目录没认出来');
  // 反向：这些不是目录，不该被当成目录
  for (const notDir of ['*.log', 'key.pem', 'scripts/ombre-memories.json']) {
    assert.ok(!dirs.includes(notDir.replace(/\/$/, '')), `${notDir} 被误认成目录`);
  }
});

test('.gitignore 里的目录，除了要随包发的那两个，打包时都得排掉', () => {
  // 从 .gitignore 推导而不是手抄清单：以后新增 dist_v3/ 这种会自动被守住
  const dirs = gitignoredDirs(SIM_ROOT);
  assert.ok(dirs.length >= 5, '.gitignore 里没解析出目录，这条测试等于没跑');
  for (const d of dirs) {
    if (MUST_SHIP.has(d)) {
      assert.ok(!blocked(`/${d}/whatever.bin`), `${d}/ 是运行时要用的，不该被排除`);
    } else {
      assert.ok(blocked(`/${d}/whatever.bin`), `pack:exe 没排掉 ${d}/ —— 它会被整个打进 asar`);
    }
  }
});

test('三个 dist 变体都挡住（这次真踩了 dist-new）', () => {
  for (const p of ['/dist/x.exe', '/dist-new/x.exe', '/dist_build/x.exe', '/dist', '/dist-new']) {
    assert.ok(blocked(p), `${p} 没被挡住`);
  }
});

test('但不能误伤名字相近的正常文件', () => {
  // 只测"该挡的挡住了"证明不了规则没有过度匹配
  for (const p of ['/district/data.json', '/js/distinct.js', '/dist-newer-notes.md', '/js/dist-new.js']) {
    assert.ok(!blocked(p), `${p} 被误伤了`);
  }
});

test('敏感文件仍然排除（别在改 dist 规则时把这些碰掉）', () => {
  for (const p of ['/key.pem', '/cert.pem', '/grancyan.keystore', '/.mcp-token',
                   '/coread.db', '/Gadgetbridge.db', '/app.log']) {
    assert.ok(blocked(p), `${p} 会被打进包里`);
  }
  // 对照组：正常源码不能被这些规则挡住，否则打出来的包是坏的
  for (const p of ['/js/24-music.js', '/index.html', '/server.js', '/css/grancyan.css']) {
    assert.ok(!blocked(p), `${p} 被误挡，打出来的包会缺文件`);
  }
});

// ⚠️ 2026-08-22 加：dist 被锁时会改用 `pack:exe:alt` 打到 dist-new。
// 那个脚本是复制出来的 —— 忽略列表一旦漂了，就是一条绕过全部安全检查的后门，
// 而且**静默**：包能跑、功能正常，只是里面多了私钥。
// 所以这里钉死：两条命令除了输出目录，必须逐字相同。
test('pack:exe:alt 和正牌只差输出目录，忽略列表一个字都不能少', () => {
  const scripts = pkg.scripts;
  assert.ok(scripts['pack:exe:alt'], 'pack:exe:alt 不见了');
  const norm = s => s.replace(/dist-new/g, 'dist')          // --out= 和传给后处理脚本的那个
                     .replace(/(slim-dist\.js|fix-native-abi\.js) dist/g, '$1');
  assert.equal(norm(scripts['pack:exe:alt']), norm(scripts['pack:exe']));
});

test('两条命令都排除了 .env（观测坐标这类"住哪儿"的东西不能跟着分发）', () => {
  const scripts = pkg.scripts;
  for (const name of ['pack:exe', 'pack:exe:alt']) {
    assert.ok(/--ignore="\^\/\\\.env\$"/.test(scripts[name]) || scripts[name].includes('\.env$'),
      `${name} 没排除 .env`);
  }
});
