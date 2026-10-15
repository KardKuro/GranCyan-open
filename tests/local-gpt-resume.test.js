// 本地 GPT 的会话续传：spawn 失败不能永久丢掉已经消费的索引
// 跑法：node tests/local-gpt-resume.test.js
//
// 测试直接从 server.js 抠出通用索引函数、GPT 续传判定和 spawn error handler 执行。
// 不复刻业务逻辑，否则源码改坏后测试仍可能假绿。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ── 把真源码抠出来跑（不是复刻一份，复刻的话改坏了源码测试照样绿）──
function loadSeg(fromMarker, toMarker, extraCtx) {
  const a = server.indexOf(fromMarker);
  const b = server.indexOf(toMarker, a + 1);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`抠不到源码片段：${fromMarker} → ${toMarker}（server.js 结构变了？）`);
  }
  const ctx = Object.assign({ console, Map, String, Object, Array }, extraCtx || {});
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(server.slice(a, b), ctx);
  return ctx;
}

function runGptSeg(ctx, fromMarker, toMarker) {
  const route = server.indexOf("app.post('/api/local-gpt'");
  const a = server.indexOf(fromMarker, route);
  const b = server.indexOf(toMarker, a + 1);
  if (route < 0 || a < 0 || b < 0 || b <= a) {
    throw new Error(`抠不到 GPT 路由源码片段：${fromMarker} → ${toMarker}（server.js 结构变了？）`);
  }
  vm.runInContext(server.slice(a, b), ctx);
}

function makeEntry() {
  return {
    threadId: '12345678-full-thread-id',
    sysKey: 'stable-prompt-key',
    model: 'gpt-5',
    agent: true,
    cwd: 'D:\\workbench',
    reasoningMode: 'always',
    carry: true,
    ts: Date.now(),
    aliases: ['main-key', 'shifted-key', 'short-window-key'],
  };
}

// GPT_EFFORTS / legacyEffort 定义在路由外面，续传指纹要用。
// 和别处一样抠真源码进来，不在测试里复刻一份 —— 复刻的话源码改坏了这里照样绿。
function loadEffortTop(ctx) {
  const a = server.indexOf('const GPT_EFFORTS = [');
  const b = server.indexOf("app.post('/api/local-gpt'", a + 1);
  if (a < 0 || b < 0) throw new Error('抠不到 GPT_EFFORTS / legacyEffort（server.js 结构变了？）');
  vm.runInContext(server.slice(a, b), ctx);
}

function makeRouteCtx(entry, currentSysKey, reasoningEffort) {
  const resumeMap = new Map(entry.aliases.map(alias => [alias, entry]));
  let errorHandler = null;
  const logs = [];
  const ctx = loadSeg('function consumeResumeSession', 'function nowNote', {
    saveResumeSessions: () => {},
    chatMsgs: [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '上一轮回复' },
      { role: 'user', content: '继续' },
    ],
    model: entry.model,
    agent: entry.agent,
    agentWorkDir: entry.cwd,
    reasoningMode: entry.reasoningMode,
    reasoningEffort,
    sysP: 'current-system-prompt',
    _gptSessions: resumeMap,
    transcriptHash: () => entry.aliases[0],
    sysStableKey: () => currentSysKey,
    gptLog: message => logs.push(message),
    proc: { on: (event, handler) => { if (event === 'error') errorHandler = handler; } },
    finished: false,
    idleTimer: null,
    clearTimeout: () => {},
    cleanupImages: () => {},
    imgFiles: [],
    gptCandidates: () => ['codex'],
    exePath: 'codex',
    send: () => {},
    endStream: () => {},
  });
  loadEffortTop(ctx);
  runGptSeg(ctx, '    const effort = GPT_EFFORTS.includes(', '    const sysP =');
  runGptSeg(ctx, '    let resumeEntry = null;', '    // 只带最后一条用户消息的图片');
  runGptSeg(ctx, "    proc.on('error', err => {", "\n\n    res.on('close'");
  return { ctx, resumeMap, logs, getErrorHandler: () => errorHandler };
}

console.log('\n[1] GPT 命中续传后，spawn 失败会恢复整条索引');
{
  const entry = makeEntry();
  const { resumeMap, logs, getErrorHandler } = makeRouteCtx(entry, entry.sysKey);

  t('消费续传记录之后，entry.aliases 的每一个别名都已从索引删除',
    entry.aliases.every(alias => !resumeMap.has(alias)));

  const errorHandler = getErrorHandler();
  t('抠到了真正的 GPT spawn error handler', typeof errorHandler === 'function');
  if (errorHandler) errorHandler(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));

  t('★ spawn 失败之后，entry.aliases 的每一个别名都能重新查到续传记录',
    entry.aliases.every(alias => resumeMap.get(alias) === entry));
  t('恢复的是同一条完整记录，threadId / sysKey / model / agent / cwd / reasoningMode / carry 都没变', (() => {
    const restored = resumeMap.get(entry.aliases[1]);
    return restored === entry
      && restored.threadId === '12345678-full-thread-id'
      && restored.sysKey === 'stable-prompt-key'
      && restored.model === 'gpt-5'
      && restored.agent === true
      && restored.cwd === 'D:\\workbench'
      && restored.reasoningMode === 'always'
      && restored.carry === true;
  })());
  t('恢复日志写入 threadId 的前 8 位',
    logs.some(line => line.includes('12345678') && line.includes('续传索引放回去')));
}

console.log('\n[2] 系统提示结构变了时，旧索引必须保持作废');
{
  const entry = makeEntry();
  const { resumeMap, logs, getErrorHandler } = makeRouteCtx(entry, 'new-stable-prompt-key');

  t('确实走过“系统提示结构变了”分支并消费了旧记录',
    logs.includes('系统提示结构变了 → 本地 GPT 重开会话')
    && entry.aliases.every(alias => !resumeMap.has(alias)));

  const errorHandler = getErrorHandler();
  if (errorHandler) errorHandler(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  t('★ 系统提示结构变了而消费的记录，spawn 失败后不会被放回去',
    entry.aliases.every(alias => !resumeMap.has(alias))
    && !logs.some(line => line.includes('续传索引放回去')));
}

console.log('\n[3] 思考深度进续传指纹');
// 深度是拼在命令行上的，对一条**已经存在**的 Codex 线程不生效。
// 所以调了深度还去续传旧线程 = 「调了没反应」+ 零报错，只能靠指纹拦。
{
  // resumeEntry 是 vm 里的 let，从外面读属性读不到，得在 context 里求值
  const peek = ctx => vm.runInContext('resumeEntry', ctx);

  const oldEntry = makeEntry();            // 老条目：升级前存的，没有 effort 字段
  const a = makeRouteCtx(oldEntry, oldEntry.sysKey, undefined);
  t('老条目（没有 effort 字段）不会因为加了这个字段就集体作废',
    peek(a.ctx) === oldEntry);

  const entry2 = makeEntry();
  const b = makeRouteCtx(entry2, entry2.sysKey, 'xhigh');
  t('★ 深度和上一轮不一样时不续传（否则调了深度毫无反应且零报错）',
    peek(b.ctx) === null && entry2.aliases.every(alias => !b.resumeMap.has(alias)));

  const entry3 = makeEntry();
  entry3.effort = 'xhigh';                 // 上一轮就是用 xhigh 跑起来的
  const c = makeRouteCtx(entry3, entry3.sysKey, 'xhigh');
  t('深度没变时照常续传（别把省下来的 token 白扔）', peek(c.ctx) === entry3);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
