// 打包后把 dist 里的原生模块换成 Electron ABI 那份，并**验到位**。
//
// electron-packager 拷进去的是 node_modules 里的 Node ABI 版本，
// Electron 加载不了 → server.js 的 try/catch 静默回退 node:sqlite。
// 见 scripts/prep-native.js 顶部的完整说明。
//
// 这个脚本的每一条失败路径都是 exit 1，**一条都不许静默跳过**：
// 当初这个 bug 能活这么久，就是因为唯一的症状是一行看起来无关痛痒的警告。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const outDir = process.argv[2] || 'dist';
const APP = path.join(ROOT, outDir, 'Grancyan-win32-x64', 'resources');

// 见 prep-native.js 里同名函数的注释：报错里有两个 NODE_MODULE_VERSION，
// 第 1 个才是文件自己的，取反了会让整套校验反过来。
function abiOf(file) {
  try { process.dlopen({ exports: {} }, path.resolve(file)); return Number(process.versions.modules); }
  catch (e) {
    const m = /NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(e.message);
    return m ? Number(m[1]) : null;
  }
}

function die(msg) { console.error('[abi] ✗ ' + msg); process.exit(1); }

const ver = fs.readFileSync(path.join(ROOT, 'node_modules/electron/dist/version'), 'utf8').trim();
const abi = Number(require(path.join(ROOT, 'node_modules/node-abi')).getAbi(ver, 'electron'));
const srcDir = path.join(ROOT, 'build-native', `electron-abi${abi}`);

if (!fs.existsSync(APP)) { console.log(`[abi] 没找到 ${outDir}/Grancyan-win32-x64/resources，跳过（打包失败了？）`); process.exit(0); }
if (!fs.existsSync(srcDir)) die(`没有 ${path.relative(ROOT, srcDir)}，先跑 node scripts/prep-native.js`);

// 递归找 dist 里所有 .node（asar.unpacked 下层级不定，写死路径迟早失效）
const found = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.node')) found.push(p);
  }
})(APP);

let fixed = 0, checked = 0;
for (const src of fs.readdirSync(srcDir)) {
  if (!src.endsWith('.node')) continue;
  const srcPath = path.join(srcDir, src);
  const srcAbi = abiOf(srcPath);
  if (srcAbi !== abi) die(`${src} 源文件是 ABI ${srcAbi}，Electron ${ver} 要 ${abi}——重跑 prep-native.js`);

  const targets = found.filter(f => path.basename(f) === src);
  if (!targets.length) die(`dist 里没找到 ${src}，打包配置变了？（扫到的 .node：${found.map(f => path.basename(f)).join(', ') || '无'}）`);

  for (const t of targets) {
    fs.copyFileSync(srcPath, t);
    const got = abiOf(t);              // 拷完再量一次，别信 copyFileSync 没报错就当成了
    if (got !== abi) die(`${path.relative(ROOT, t)} 替换后仍是 ABI ${got}`);
    console.log(`[abi] ✓ ${path.relative(ROOT, t)} → ABI ${got}`);
    fixed++;
  }
  checked++;
}

// dist 里剩下的 .node 也要挨个查——可能是别的原生依赖悄悄进来了。
//
// 但**先分清两种原生模块**，不然全是误报：
//   N-API（node_api）    ABI 稳定，一份通吃所有 Node / Electron，不用重编
//   V8/NAN 直接绑定      锁死 NODE_MODULE_VERSION，换运行时就必须重编
// 判据是文件里有没有 napi 的注册符号——符号名在 PE 里是明文，搜得到。
// 光靠 dlopen 分不出来：N-API 模块在当前 node 下**加载成功**，
// abiOf 就会返回当前 node 的 ABI，看起来像"锁死在 137"，实际上它到哪都能跑。
// （@napi-rs/canvas 就是这么被误报的。）
const NAPI_MARKS = ['napi_register_module_v1', 'napi_module_register',
                    'node_api_module_get_api_version_v1'];
const isNapi = f => { const b = fs.readFileSync(f); return NAPI_MARKS.some(s => b.includes(s)); };

for (const f of found) {
  if (isNapi(f)) { console.log(`[abi] · ${path.basename(f)} 是 N-API，跨运行时通用，跳过`); continue; }
  const got = abiOf(f);
  if (got !== null && got !== abi) {
    die(`${path.relative(ROOT, f)} 是 ABI ${got} 的 V8 绑定模块，但没有对应的 Electron 版本可换。`
      + `把它加进 scripts/prep-native.js 的 MODULES 里`);
  }
}

if (!checked) die(`${path.relative(ROOT, srcDir)} 里一个 .node 都没有`);
console.log(`[abi] 全部就位：${fixed} 个文件，ABI ${abi}（Electron ${ver}）`);
