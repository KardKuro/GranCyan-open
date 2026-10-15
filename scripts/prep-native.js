// 为 Electron 准备原生模块（better-sqlite3），产物放 build-native/electron-abi<N>/。
//
// 为什么需要这一步：pack:exe 用的是 electron-packager，它**不会**重编原生模块
//（electron-builder 才会），只是把 node_modules 原样拷进 exe。
// 而 node_modules 里那份是给系统 Node 编的：
//   Node 24.17.0 → NODE_MODULE_VERSION 137
//   Electron 43  → NODE_MODULE_VERSION 148
// 同一个 .node 两边不通用。装错的后果不是崩溃，是 server.js 那个 try/catch
// 静默吞掉、回退 node:sqlite —— exe 照样能开，只是数据库换了个实现，
// 一行报错都没有。这就是"better-sqlite3 加载失败，回退 node:sqlite"的来历。
//
// **不动 node_modules**：编完立刻把 Node ABI 那份还原回去，
// 否则 `node server.js` 当场就挂（这个坑踩过三次）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = ['better-sqlite3'];

// 读一个 .node 的真实 ABI：拿 dlopen 去撞，从报错里把版本号抠出来。
// 不能只信目录名——目录是人写的，文件是编出来的，只有文件说了算。
// 加载成功说明它就是当前 node 的 ABI。
//
// ⚠️ 报错消息里有**两个** NODE_MODULE_VERSION，顺序千万别搞反（这里踩过）：
//   "...was compiled against a different Node.js version using
//    NODE_MODULE_VERSION 148.        ← 第 1 个：文件自己的，这才是我们要的
//    This version of Node.js requires
//    NODE_MODULE_VERSION 137."       ← 第 2 个：当前 node 的
// 取错的后果很隐蔽：缓存判定永远不成立、每次都重编，编完又把对的结果判成错的。
function abiOf(file) {
  try {
    process.dlopen({ exports: {} }, path.resolve(file));
    return Number(process.versions.modules);
  } catch (e) {
    const m = /NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(e.message);
    if (m) return Number(m[1]);
    // 能打开但不是 ABI 问题（缺依赖 DLL 之类）——当成未知，让调用方报错
    return null;
  }
}

function electronAbi() {
  const ver = fs.readFileSync(path.join(ROOT, 'node_modules/electron/dist/version'), 'utf8').trim();
  const { getAbi } = require(path.join(ROOT, 'node_modules/node-abi'));
  return { ver, abi: Number(getAbi(ver, 'electron')) };
}

function main() {
  const { ver, abi } = electronAbi();
  const outDir = path.join(ROOT, 'build-native', `electron-abi${abi}`);
  console.log(`[native] Electron ${ver} → NODE_MODULE_VERSION ${abi}（当前 node 是 ${process.versions.modules}）`);

  // 已经有并且 ABI 对得上就直接用，别每次打包都重编一遍（一次要好几分钟）
  const missing = MODULES.filter(m => {
    const f = path.join(outDir, `${m.replace(/-/g, '_')}.node`);
    if (!fs.existsSync(f)) return true;
    const got = abiOf(f);
    if (got !== abi) { console.log(`[native] ${m} 缓存的是 ABI ${got}，要 ${abi}，重编`); return true; }
    return false;
  });
  if (!missing.length) { console.log(`[native] ${outDir} 已就绪，跳过重编`); return; }

  // 先把 Node ABI 那份存起来。electron-rebuild 会就地覆盖 node_modules，
  // 不还原的话开发环境（node server.js）当场报废。
  const backups = new Map();
  for (const m of MODULES) {
    const live = path.join(ROOT, 'node_modules', m, 'build/Release', `${m.replace(/-/g, '_')}.node`);
    if (fs.existsSync(live)) backups.set(live, fs.readFileSync(live));
  }
  const restore = () => {
    for (const [f, buf] of backups) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
    if (backups.size) console.log('[native] node_modules 里的 Node ABI 那份已还原');
  };

  try {
    console.log('[native] 跑 electron-rebuild（几分钟，别急）…');
    // 用 electron-rebuild 而不是自己拼 node-gyp 参数：Electron 的 headers 里
    // config.gypi 和 common.gypi 要配套用（--devdir 会拿系统 Node 的 config.gypi
    // 导致 node.h 的 ELECTRON_ENSURE_CONFIG_GYPI 检查失败；--nodedir 又会
    // 把 node.lib 找到 Release/ 而它其实在 x64/）。这些差异 electron-rebuild 都处理好了。
    execFileSync(process.execPath, [
      path.join(ROOT, 'node_modules/electron-rebuild/lib/src/cli.js'),
      '-f', '-v', ver, '-o', MODULES.join(','),
    ], { cwd: ROOT, stdio: 'inherit' });

    fs.mkdirSync(outDir, { recursive: true });
    for (const m of MODULES) {
      const built = path.join(ROOT, 'node_modules', m, 'build/Release', `${m.replace(/-/g, '_')}.node`);
      const got = abiOf(built);
      if (got !== abi) throw new Error(`${m} 编出来是 ABI ${got}，要的是 ${abi}`);
      fs.copyFileSync(built, path.join(outDir, path.basename(built)));
      console.log(`[native] ✓ ${m} → ${path.relative(ROOT, outDir)}（ABI ${got}）`);
    }
  } finally {
    restore();
  }
}

try { main(); }
catch (e) { console.error('[native] ✗ ' + e.message); process.exit(1); }
