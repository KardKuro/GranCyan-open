// 故障注入器的**自愈**到底有没有落到磁盘上
// 跑法：node tests/fault-inject-restore.test.js
//
// 背景（2026-08-24，Codex 九审）：注入器会原地改生产源码再改回来，靠 process.on('exit')
// 还原。Windows 上 `Stop-Process` 不走信号 → 处理器一行不跑 → 仓库停在「安全判据被削弱」
// 的版本上。我加了开跑前的自愈，但**加错了顺序**：
//     ORIG = 读文件      ← 拍的是残留版
//     healResidue()      ← 改好了
//     process.exit()     ← exit 钩子拿 ORIG 盖回去 → 残留原样复活
// 终端上印着「已还原」，磁盘上一个字节没变。**这是一句会骗过我自己的假话** ——
// 比不自愈更糟，因为我会信它。
//
// ⚠️ 这个测试自己已经假绿过两次，两次都是别人/后来的我逮到的：
//   一、受害者用**临时文件** —— 而 exit 钩子只还原 ORIG 里那五个真文件，临时文件它压根不碰，
//       于是把顺序改回错版，断言照样全绿（我自己手工验证时逮到的，第九次「验了零件没验路」）。
//   二、`scene()` 的 finally 在断言**之前**就把 BAK 删了，于是「备份目录用完就撤」这条
//       无论子进程干了什么都会绿 —— 它验的是测试自己的清理（Codex 十审逮到的）。
//   现在：受害者是 FILES 名单里的 origin-guard.js；目录是否还在，在 finally **之前**就取好。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const INJ = path.join(ROOT, 'tests', 'fault-inject.js');
const BAK = path.join(ROOT, 'tests', '.fault-inject-bak');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// 注入器名单 —— manifest 必须**恰好覆盖**它，所以副本得做全套。
//
// ⚠️ 这份名单**从 fault-inject.js 里解出来，不许在这儿手抄一份**。
//   手抄的代价 2026-08-28 刚付过：给注入表加了第 6 个文件（js/41-code-workbench.js），
//   这里还写着 5 个，manifest 校验立刻判「没有恰好覆盖」，一口气红 10 条 ——
//   而真正坏掉的东西一个都没有，纯粹是两份名单对不上。
//   更糟的是它红得**不像名单问题**：报出来是「撤副本失败」「manifest 已作废」，
//   看着像还原机制自己坏了，查错方向完全被带偏。
const injectSrc = fs.readFileSync(path.join(ROOT, 'tests', 'fault-inject.js'), 'utf8');
const alias = {};
// 常量名放宽到多字符：单字母迟早不够用（ST = 02-state.js 就撞上了）。
// 失配的表现是「FILES 里的 X 找不到声明」——看着像名单写错，其实是这条正则太窄。
for (const m of injectSrc.matchAll(/^const (\w+) = path\.join\(ROOT, (.+?)\);$/gm)) {
    alias[m[1]] = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
}
const FILES = injectSrc.match(/^const FILES = \[([^\]]+)\];/m)[1]
    .split(',').map(s => s.trim())
    .map(k => {
        if (!alias[k]) throw new Error(`FILES 里的 ${k} 在 fault-inject.js 里找不到对应的 path.join 声明`);
        return path.join(ROOT, ...alias[k]);
    });
if (FILES.length < 5 || !FILES.every(f => fs.existsSync(f))) {
    throw new Error('从 fault-inject.js 解出来的 FILES 不对：' + JSON.stringify(FILES));
}
// 受害者挑 origin-guard.js：它在名单里（这是关键），而且最小。
const VICTIM = path.join(ROOT, 'origin-guard.js');
const GOOD = fs.readFileSync(VICTIM, 'utf8');
// 受害者之二：验「一个文件写不动，不许放弃后面还救得回来的」
const EXTRA = path.join(ROOT, 'js', '05-prompts-api.js');
const EXTRA_GOOD = fs.readFileSync(EXTRA, 'utf8');
const EXTRA_WEAK = EXTRA_GOOD + '\n// 自愈测试留下的假残留之二\n';
const WEAK = GOOD + '\n// 自愈测试留下的假残留 —— 跑完这行必须消失\n';

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// drop     = manifest 少列一个文件（残缺 manifest）
// corrupt  = 把某份副本改成**等长**的另一份内容（长度检查抓不到，哈希才抓得到）
// readonly = 把受害者设成只读，还原时写不进去
// extraWeak = 让排在受害者**后面**的另一个文件也停在残留版（它是可写的，必须被救回来）
// extraRO  = 再把它也设成只读，验失败清单会报满两条
// cwdInBak = 让子进程的工作目录就是副本目录 —— Windows 不许删掉进程自己的 cwd，
//            于是「撤副本」这一步必然失败，正好验它不许静默吞
function scene({ manifest = true, drop = false, corrupt = false, readonly = false, extraWeak = false, extraRO = false, cwdInBak = false } = {}) {
  // ⚠️ try/finally 必须在**第一次碰生产源码之前**就开始（Codex 十一审）。
  //   上一版是先写 WEAK、先 chmod，再进 try —— 中间任何一步抛错，finally 都不会执行，
  //   真源码就永久停在残留版上了。测试本身把生产代码弄脏，是最不该有的失败方式。
  const mode0 = fs.statSync(VICTIM).mode;
  const mode1 = fs.statSync(EXTRA).mode;
  let sameLen = null;
  try {
    fs.rmSync(BAK, { recursive: true, force: true });
    fs.mkdirSync(BAK, { recursive: true });
    const mani = FILES.map((f, i) => {
      let body = fs.readFileSync(f, 'utf8');
      const rec = { file: f, bak: `${i}.bak`, sha256: sha(body) };
      if (corrupt && f === VICTIM) {
        // ⚠️ 「等长」这件事必须**自证**（Codex 十一审）：翻一个确定是 ASCII 的字节，
        //   然后当场断言字节数没变。不然哪天文件结尾变成多字节字符，这个样本会变成
        //   「长度也不一样」——生产代码就算退化回长度校验也能正确拒绝它，测试照样全绿，
        //   却不再证明 sha256 起了作用。
        const buf = Buffer.from(body, 'utf8');
        const k = buf.indexOf(0x2f);                   // '/'，注释开头，必然有
        buf[k] = 0x2a;                                 // 换成 '*'，同为 1 字节 ASCII
        const nb = buf.toString('utf8');
        sameLen = Buffer.byteLength(nb) === Buffer.byteLength(body);
        body = nb;
      }
      fs.writeFileSync(path.join(BAK, `${i}.bak`), body);
      return rec;
    });
    if (manifest) fs.writeFileSync(path.join(BAK, 'manifest.json'),
      JSON.stringify(drop ? mani.slice(0, -1) : mani));
    fs.writeFileSync(VICTIM, WEAK);                      // 磁盘上是残留版
    if (extraWeak || extraRO) fs.writeFileSync(EXTRA, EXTRA_WEAK);
    if (extraRO) fs.chmodSync(EXTRA, 0o444);

    if (readonly) fs.chmodSync(VICTIM, 0o444);           // 还原时写它必失败
    const r = cp.spawnSync(process.execPath, [INJ, '--check'], { cwd: cwdInBak ? BAK : ROOT, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''),
             after: fs.readFileSync(VICTIM, 'utf8'),     // ← 进程**已经退出**了才读
             afterExtra: fs.readFileSync(EXTRA, 'utf8'),
             bakLeft: fs.existsSync(BAK),                // ← ⚠️ 必须在 finally 清理**之前**取
             maniLeft: fs.existsSync(path.join(BAK, 'manifest.json')),
             sameLen };
  } finally {
    try { fs.chmodSync(path.join(BAK, 'manifest.json'), 0o666); } catch { }
    try { fs.chmodSync(VICTIM, mode0); } catch { }
    try { fs.chmodSync(EXTRA, mode1); } catch { }
    try { fs.writeFileSync(VICTIM, GOOD); } catch { }
    try { fs.writeFileSync(EXTRA, EXTRA_GOOD); } catch { }
    fs.rmSync(BAK, { recursive: true, force: true });
  }
}
console.log('\n── 自愈：残留 → 还原 → 进程退出 → 磁盘上剩什么 ──');
{
  const r = scene({});
  t('★★ 进程退出之后，磁盘上真的是完好版（先拍快照后自愈的话，exit 钩子会把残留盖回来 → 必红）',
    r.after === GOOD, r.after === WEAK ? '还是残留版（exit 钩子盖回去了）' : '既不是好的也不是坏的？');
  t('★ 退出码非 0 —— 提交前的 --check 必须把这种情况拦下来', r.code !== 0, String(r.code));
  t('★ 说清了还原的是哪个文件（要人去复查 git diff）', /整份还原/.test(r.out), r.out.slice(0, 200));
  t('★★ 还原成功之后副本才撤（这条以前是假绿的：finally 抢在断言前把目录删了）',
    r.bakLeft === false);
}

console.log('\n── 副本本身不可信的时候：宁可停下，也不拿它盖源码；而且证据要留着 ──');
for (const [why, opt, hint] of [
  ['没有 manifest（拷到一半被杀）', { manifest: false }, /manifest 却没有/],
  [`manifest 少列了一个文件（还原 ${FILES.length - 1} 个、删掉副本，剩下那个原样留在注入版）`, { drop: true }, /恰好覆盖/],
  ['副本被**等长**改坏（长度检查放行，哈希才抓得到）', { corrupt: true }, /sha256 对不上/],
]) {
  const r = scene(opt);
  t(`★★ ${why} → 拒绝还原`, r.after === WEAK, r.after === GOOD ? '它还是拿不可信的副本盖了源码' : '?');
  t('★ 退出码 2（要人工介入，不是「再跑一遍就好了」）', r.code === 2, String(r.code));
  t('★★ 而且**副本留着** —— 这时候删掉等于把唯一的证据和唯一的自愈依据一起扔了', r.bakLeft === true);
  t('★ 报错说清了是哪种不对', hint.test(r.out), r.out.slice(0, 300));
  // ⚠️ 「等长」这个前提必须自证，否则哪天它不再等长，这条就退化成一条什么都没验的绿灯。
  if (r.sameLen !== null) t('★★ 而且那份坏副本**确实是等长的**（不等长的话长度校验也能拒，就证明不了 sha256 在起作用）',
    r.sameLen === true);
}

console.log('\n── 写不进去的时候：能救的都要救，失败清单一次报全 ──');
{
  // 受害者只读 → 写不动；同时另一个文件也停在残留版，它**必须**被还原。
  const r = scene({ readonly: true, extraWeak: true });
  t('★★ 写不动的那个原样留着（没硬来）', r.after === WEAK, '?');
  // ⚠️ EXTRA 必须**真的被弄脏过**，不然这条什么都没验（上一版 extraRO:false 就是这样的假绿）。
  t('★★ 而排在它后面、写得动的那个**被救回来了**（旧版遇到第一个失败就 bail，后面的根本没被尝试）',
    r.afterExtra === EXTRA_GOOD, '第二个文件没被还原');
  t('★ 退出码 2 且副本留着', r.code === 2 && r.bakLeft === true, `code=${r.code} bak=${r.bakLeft}`);
  t('★ 报错里点名了是哪个文件没救回来', /origin-guard/.test(r.out), r.out.slice(0, 300));
}
{
  // 两个都只读 → 两个都救不回来，清单要报两条
  const r = scene({ readonly: true, extraRO: true });
  t('★★ 两个都写不动 → 两个都原样留着，一个都不许硬来',
    r.after === WEAK && r.afterExtra === EXTRA_WEAK, '?');
  t('★★ 失败清单报的是 2 个，不是遇到第一个就跑了', /有 2 个文件没能还原/.test(r.out), r.out.slice(0, 300));
}

// ⚠️ 撤副本这一步失败**不许静默吞**（Codex 十一审）：manifest 是完整性标记，它还留着的话，
//   下一轮会把这份**过期**副本认成「上轮没善终」，拿旧内容盖掉开发者之后写的新代码。
console.log('\n── 收工撤副本这一步自己失败了 ──');
{
  const r = scene({ cwdInBak: true });
  t('★ 还原本身是成功的（残留没了）', r.after === GOOD, '?');
  // ⚠️ 退出码这条单看是**假绿**：这个场景里 healed === 1，本来就会退 1。
  //   真正守住行为的是下面两条 —— 有没有喊人、以及 manifest 到底还在不在。
  t('★★ 撤副本失败 → 喊人去删（旧版一句空 catch 吞掉，什么都不说）',
    /必须人工删掉|副本目录删不掉/.test(r.out) && r.code !== 0, r.out.slice(0, 300));
  // ⚠️⚠️ 这条才是「先作废 manifest 再删目录」那个顺序的真正判据。
  //   目录删不掉是可以接受的，manifest 还留着**不行** —— 它是完整性标记，
  //   留着就等于告诉下一轮「这份副本可信」，于是拿旧内容盖掉之后写的新代码。
  //   顺序反过来（先删目录、失败了就再也走不到 unlink）时，这条必红。
  t('★★ 副本目录还在，但 manifest 已经作废了（下一轮只会停下来喊人，不会拿它覆盖）',
    r.bakLeft === true && r.maniLeft === false, `bak=${r.bakLeft} mani=${r.maniLeft}`);
}

console.log('\n── 干净的时候不许乱动 ──');
{
  fs.rmSync(BAK, { recursive: true, force: true });
  const r = cp.spawnSync(process.execPath, [INJ, '--check'], { cwd: ROOT, encoding: 'utf8' });
  t('★ 没有残留 → 退出码 0', r.status === 0, String(r.status) + ' ' + (r.stdout || '').slice(0, 200));
  t('★ 而且顺带体检了注入表的锚点（找不到 = 残留或锚点过期，两种都得人看）',
    /锚点全对得上/.test(r.stdout || ''), (r.stdout || '').slice(0, 200));
  t('★★ --check 不留下备份目录（留下的话下一轮会把它当成「上一轮没善终」）', !fs.existsSync(BAK));
}

// 收尾体检：这个测试自己动过生产源码，跑完必须一个字节不差地还回去。
t('★★ 测试自己没把 origin-guard.js 弄脏（它动过真源码，收尾必须还原）',
  fs.readFileSync(VICTIM, 'utf8') === GOOD, '⚠ origin-guard.js 被这个测试弄脏了，去 git checkout');

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
