/* CC 记忆索引不许在 UI 线程上做同步 IO。
 *
 * 2026-08-28：修完手环那条（每 2 分钟卡一次）之后，应用内的卡顿记录器又逮到
 * 一次 **1170ms** 的事件循环停摆。源头是 `readCcMemories()` —— 同步 readdir +
 * 逐个 readFileSync 整个 CC 记忆目录。实测 112 个文件 217 KB：
 * **冷缓存 1745ms，热了才 17ms**。
 *
 * 所以它只在「开机后第一次聊天」或「那些文件被系统缓存挤掉之后」各犯一次 ——
 * 比手环那条轻，够不上 Windows 判「未响应」的 5 秒门槛，外部监控看不见，
 * 只有应用内的仪器看得见。但同一个病：同步 IO 跑在 Electron 主进程上。
 *
 * 改法是**陈旧优先**，不是单纯改异步：
 *   · 有缓存就立刻给（哪怕过期），过期的那次在后台刷；
 *   · 只有彻底没货时才等，而那一次被开机预热吃掉。
 * 于是正常路径上一次都不等。
 *
 * 跑法：node tests/cc-memory-async.test.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
// 注释里当然会提到 readFileSync（讲的就是为什么不能用）。只看代码。
const NL = String.fromCharCode(10);
const CODE = SRC.split(NL).filter(l => !l.trim().startsWith('//')).join(NL);

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

console.log('\nCC 记忆索引不许冻住窗口:');

// ── 读取本身是异步的 ──
const fresh = CODE.slice(CODE.indexOf('async function readCcMemoriesFresh'),
                         CODE.indexOf('function refreshCcMemories'));
t('☑ 前提：确实切出了那个函数（切空的话下面几条全是假绿）', fresh.length > 200, fresh.length);
t('★★ 读记忆目录用异步 fsp，没有一处同步 IO（同步=Electron 主线程冻住）',
  !/readFileSync|readdirSync/.test(fresh) && /await fsp\.(readdir|readFile)/.test(fresh),
  (fresh.match(/.*(readFileSync|readdirSync).*/) || [])[0]);

// ── 陈旧优先：过期不等 ──
const reader = CODE.slice(CODE.indexOf('async function readCcMemories('),
                          CODE.indexOf('refreshCcMemories();' + NL + NL));
t('☑ 前提：切出了 readCcMemories 本体', reader.length > 100, reader.length);
t('★★ 缓存过期时**返回旧的、后台刷新**，不是站在那儿等（等就是把冻住换个地方发生）',
  /if \(_ccMemCache\.items\.length\) \{ refreshCcMemories\(\); return _ccMemCache\.items; \}/.test(reader));
t('★ 只有彻底没货才等（否则第一次仍然会冻）',
  /return await refreshCcMemories\(\);/.test(reader));
t('★★ 开机就预热，把「第一次必须等」从聊天请求上挪走',
  /^refreshCcMemories\(\);$/m.test(CODE));

// ── 并发去重 ──
// ⚠️ 不去重的话，缓存刚过期时涌进来的几个请求会各开一轮 112 次文件读，
//   比不改还糟 —— 而且症状是「偶尔特别卡」，最难查的那种。
t('★★ 后台刷新同一时刻只跑一个（不去重的话缓存过期瞬间会并发开好几轮全目录扫描）',
  /if \(!_ccMemRefreshing\)/.test(CODE) && /_ccMemRefreshing = null;/.test(CODE));

// ── 调用点全都 await 了 ──
// 漏一个的话，注入的是一个 Promise 对象 —— 系统提示里会出现 "[object Promise]"，
// 而且不报错。
const callsites = [...CODE.matchAll(/(?<!\w)(ccMemoryPrompt|readCcMemories)\s*\(/g)];
const missed = [];
for (const m of callsites) {
    const line = CODE.slice(CODE.lastIndexOf(NL, m.index) + 1, CODE.indexOf(NL, m.index));
    if (/async function|^function/.test(line.trim())) continue;      // 定义那行
    if (!/await\s+(ccMemoryPrompt|readCcMemories)\s*\(/.test(line)) missed.push(line.trim());
}
t('★★ 每个调用点都 await 了（漏一个就把 Promise 拼进系统提示，变成 "[object Promise]" 且不报错）',
  missed.length === 0, missed);
t('☑ 对照：确实数到了调用点（数到 0 的话上面那条什么都没守）',
  callsites.length >= 4, callsites.length);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
