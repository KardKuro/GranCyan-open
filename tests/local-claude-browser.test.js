// 本地 Claude 的「浏览器」开关：让AI操作那个专用 Chrome
// 跑法：node tests/local-claude-browser.test.js
//
// 背景（2026-09-05）：用户想「让 GranCyan 的克可以变成普通的 cc，能直接查 chrome」。
// claude-in-chrome 是 Claude Code 客户端自带的能力、不是 MCP，spawn 出来的 claude -p
// 继承不到；能走的是 playwright MCP + --cdp-endpoint 接管那个**已经登录着的**专用 Chrome。
//
// 这一摊里「零报错就会坏」的地方有四类，下面按类守：
//   ① 配置组合串台 —— 聊天档和电脑操控档共用一个配置文件的话，会拿到对方的 server；
//   ② CDP 端点写错 —— 端口对不上 / 用了 localhost（这台机器上被 wslrelay 截胡），
//      症状是「浏览器工具不见了」，看着像 MCP 坏了；
//   ③ 护栏名单写错 —— 少个前缀 CLI 就匹配不上，禁用**静默失效**，而测试照样绿；
//   ④ 接线漏了 —— 配置对、护栏对，但根本没传给 CLI。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const api = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8').replace(/\r\n/g, '\n');
const chats = fs.readFileSync(path.join(ROOT, 'js', '03-chats-models.js'), 'utf8').replace(/\r\n/g, '\n');
const sb = require(path.join(ROOT, 'social-browser.js'));

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// ── 把真源码抠出来跑 ──────────────────────────────────────────
// 复刻一份的话，改坏了源码测试照样绿 —— 那是这一套测试最没意义的写法。
// ⚠️ tail 不是可有可无的：`const` / `let` 声明**不会**挂到 vm 的 context 上
//    （只有 var 和函数声明会）。不追这一段的话，BROWSER_DENY 这类常量取到的是
//    undefined —— 而那看着完全像「源码里没有这个东西」，会把人引去查源码。
function loadSeg(fromMarker, toMarker, extraCtx, tail) {
  const a = server.indexOf(fromMarker);
  const b = server.indexOf(toMarker, a + 1);
  if (a < 0 || b < 0 || b <= a) throw new Error(`抠不到源码片段：${fromMarker} → ${toMarker}（server.js 结构变了？）`);
  const ctx = Object.assign({ JSON, String, Object, Array, console, Map, RegExp }, extraCtx || {});
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(server.slice(a, b) + (tail || ''), ctx);
  return ctx;
}

// 沙箱里写出来的配置文件不许落进真的 tmp（会跟运行中的 exe 抢同一个文件名）
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mcp-test-'));
const written = new Map();
const ctx = loadSeg('const _mcpConfigPaths = new Map();', 'function noteArtifact', {
  path,
  process: { execPath: 'C:/fake/electron.exe' },
  __dirname: 'C:/fake/app',
  fs: { writeFileSync: (p, s) => written.set(p, s) },
  // require 只放行这一个：真的去拿 social-browser 导出的端口，
  // 自己造一个数的话，「两边端口对不上」这件事就永远测不出来了。
  require: (m) => {
    if (m === './social-browser') return sb;
    if (m === 'os') return { tmpdir: () => TMPDIR };
    throw new Error('沙箱里不该 require ' + m);
  },
}, '\n;globalThis.__exp = { mcpConfigFile, githubMcpConfig, BROWSER_DENY, BROWSER_TOOL_PREFIX, GH_TOOL_PREFIX };');
const { mcpConfigFile, githubMcpConfig, BROWSER_DENY, BROWSER_TOOL_PREFIX, GH_TOOL_PREFIX } = ctx.__exp;
const readCfg = (p) => JSON.parse(written.get(p)).mcpServers;

console.log('\n[1] 配置按组合走，不许串台');
{
  t('☑ 前提：真的抠到源码并跑起来了（抠不到的话下面全是空气）',
    typeof mcpConfigFile === 'function' && typeof BROWSER_DENY === 'string');

  t('★★ 一个都不要时返回 null（调用方据此不加 --mcp-config，而不是给个空配置）',
    mcpConfigFile({}) === null, mcpConfigFile({}));
  t('☑ 对照：全是假值也算「一个都不要」（browser:0 不能被当成要）',
    mcpConfigFile({ github: 0, browser: 0 }) === null);

  const pG = mcpConfigFile({ github: 1 });
  const pB = mcpConfigFile({ browser: 1 });
  const pGB = mcpConfigFile({ github: 1, browser: 1 });

  t('★★ 只要 github 时配置里没有 browser（聊天档不该白挂一个浏览器）',
    Object.keys(readCfg(pG)).join() === 'github', Object.keys(readCfg(pG)));
  t('★★ 只要 browser 时配置里没有 github（电脑操控档不该白挂 GitHub MCP）',
    Object.keys(readCfg(pB)).join() === 'browser', Object.keys(readCfg(pB)));
  t('★★ 两个都要时两个都在',
    Object.keys(readCfg(pGB)).sort().join() === 'browser,github', Object.keys(readCfg(pGB)));

  // ⚠️ 这条是「串台」的正面判据。三种组合共用一个文件名的话，上面三条**照样全绿**
  //   （每次调用都重写一遍，各自读到的都是自己刚写的），但真实运行时两档并存，
  //   后写的会把先写的盖掉 —— 那是只在她两个对话切着用时才犯的偶发 bug。
  t('★★ 三种组合落在三个不同的文件里（共用一个的话会互相覆盖，且只在并用时才犯）',
    new Set([pG, pB, pGB]).size === 3, [pG, pB, pGB]);

  t('★ 同一组合再要一次给的是同一个路径（缓存生效，不重复写盘）',
    mcpConfigFile({ github: 1 }) === pG && mcpConfigFile({ browser: 1 }) === pB);
  t('★ key 与顺序无关（{a,b} 和 {b,a} 是同一档，否则会多出一份重复配置）',
    mcpConfigFile({ browser: 1, github: 1 }) === pGB);

  t('★ githubMcpConfig() 还是原来那个意思（老调用点没被这次重构改坏）',
    githubMcpConfig() === pG && Object.keys(readCfg(githubMcpConfig())).join() === 'github');
}

console.log('\n[2] CDP 端点：连不上的话工具会整个消失，不是调用失败');
{
  const cfg = readCfg(mcpConfigFile({ browser: 1 })).browser;
  const args = cfg.args.join(' ');

  t('☑ 前提：配的就是 playwright MCP', /@playwright\/mcp/.test(args), args);
  t('★★ 接管的是已经在跑的浏览器（--cdp-endpoint），不是自己开一个干净的',
    cfg.args.includes('--cdp-endpoint'), args);

  // ⚠️ 端口必须**来自 social-browser**，不是这边自己再读一次环境变量。
  //   两边各读一次的话，她改了 GRANCYAN_CHROME_PORT 就会静默连错端口。
  //   所以这里拿真实导出值去比，而不是比字面量 9333。
  const ep = cfg.args[cfg.args.indexOf('--cdp-endpoint') + 1];
  t('★★ 端口跟 social-browser 导出的是同一个（两边各读一次环境变量就会静默错位）',
    ep === `http://127.0.0.1:${sb.CHROME_PORT}`, { ep, CHROME_PORT: sb.CHROME_PORT });
  t('☑ 前提：CHROME_PORT 真的被导出了（没导出的话上面那条比的是 undefined）',
    typeof sb.CHROME_PORT === 'number' && sb.CHROME_PORT > 0, sb.CHROME_PORT);

  // ⚠️ 这台机器上 localhost 走 ::1 会被 wslrelay 截胡，返回空 —— 看着像服务挂了。
  t('★★ 用 127.0.0.1 不用 localhost（这台机器上 localhost 会被 wslrelay 截胡）',
    ep.includes('127.0.0.1') && !/localhost/i.test(args), ep);

  t('★ 给了 CDP 超时（默认 30 秒，连不上时那段时间AI一个工具都用不了）',
    cfg.args.includes('--cdp-timeout'));
}

console.log('\n[3] 护栏：--disallowed-tools 是真闸，写错就静默失效');
{
  const deny = BROWSER_DENY.split(',');

  t('☑ 前提：名单不是空的', deny.length >= 4, deny.length);

  // ⚠️ 少了前缀，CLI 匹配不上任何工具 → 禁用**静默失效**，而「名单里有这几个名字」
  //   这种断言照样全绿。所以验的是全名，不是有没有出现过这个词。
  t('★★ 每一项都是带全前缀的工具全名（少了前缀 CLI 匹配不上，护栏静默失效）',
    deny.every(n => n.startsWith(BROWSER_TOOL_PREFIX + '__browser_')), deny);

  t('★★ 任意 JS 执行被禁（那等于绕开整个浏览器 UI 直接打站点 API，所有闸都白设）',
    deny.includes(`${BROWSER_TOOL_PREFIX}__browser_evaluate`)
    && deny.includes(`${BROWSER_TOOL_PREFIX}__browser_run_code_unsafe`), deny);
  t('★★ 关浏览器被禁（那关掉的正是我们费劲保住的那一个）',
    deny.includes(`${BROWSER_TOOL_PREFIX}__browser_close`));
  t('★ 上传文件被禁（能把她本机的文件送出去）',
    deny.includes(`${BROWSER_TOOL_PREFIX}__browser_file_upload`));

  // ⚠️ 对照组：全禁掉等于这个功能没做。护栏要能证明它**没有**误伤正常浏览。
  for (const ok of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_take_screenshot']) {
    t(`☑ 对照：${ok} 没被禁（全禁掉的话这个功能等于没做）`,
      !deny.includes(`${BROWSER_TOOL_PREFIX}__${ok}`));
  }
}

console.log('\n[4] 接线：配置和护栏对，也得真的传给 CLI');
{
  // 抠出两个分支的源码文本来看接线。这一段是 args.push 的拼装，
  // 抠出来跑要连整个 handler 一起造，代价远大于收益 —— 所以这里退一步看源码，
  // 但**每一条都配了故障注入**（tests/fault-inject.js 第 41 组），拆掉必须真的红。
  const seg = server.slice(server.indexOf("args.push('--tools', 'default'"),
                           server.indexOf('if (resumeEntry) args.push'));
  t('☑ 前提：抠到了 args 拼装那一段', seg.length > 200 && seg.includes('--strict-mcp-config'), seg.length);

  t('★★ 电脑操控档只在 browser 开着时才挂 MCP（关着时行为一个字不变，零回归）',
    /if \(browser\) \{[^]*?--mcp-config/.test(seg));
  t('★★ 电脑操控档给了 --disallowed-tools（这一档有 bypassPermissions，唯一能拦住的就是它）',
    /if \(browser\) \{[^]*?--disallowed-tools/.test(seg));

  // ⚠️ 聊天档没有 bypassPermissions：MCP 工具不预授权的话，-p 非交互下会挂在
  //   等人批准上（同 WebFetch 那个坑）。症状是「没报错，就是不回」。
  t('★★ 聊天档把浏览器写进了 --allowed-tools（不预授权的话非交互下会挂住等批准）',
    /--allowed-tools[^]*?BROWSER_TOOL_PREFIX/.test(seg), seg.slice(-260));
  t('★★ 聊天档也给了 --disallowed-tools（护栏两档都要，不能只守一边）',
    /\} else \{[^]*?if \(browser\) args\.push\('--disallowed-tools'/.test(seg));

  // 会话续传：工具集变了还续传的话，模型会照上一轮的记忆去调一个这轮不存在的工具。
  t('★★ 续传判定把 browser 也比进去了（工具集变了不能接着上一轮的会话）',
    (server.match(/e\.agent === !!agent && !!e\.browser === !!browser/g) || []).length >= 2,
    (server.match(/!!e\.browser === !!browser/g) || []).length);
  t('★★ 存会话时真的把 browser 记下来了（不记的话上面那条永远比到 undefined）',
    /browser: !!browser, cwd: agentWorkDir/.test(server));
  t('★ 用 !!e.browser 兼容老条目（写成 e.browser === 的话升级那一刻全部会话作废一次）',
    /!!e\.browser === !!browser/.test(server) && !/[^!]e\.browser === !!browser/.test(server));

  // spawn 之前必须把 Chrome 弄活：playwright MCP 是启动时连 CDP 的，
  // 连不上不是「工具调用失败」，是工具压根不出现 —— AI只会说「我没有浏览器工具」。
  const preIdx = server.indexOf('if (browser) {\n        try {\n            const up = await require(\'./social-browser\').ensureChrome();');
  t('★★ spawn 之前先把 Chrome 弄活（MCP 起不来的话工具是「消失」不是「报错」）',
    preIdx > 0 && preIdx < server.indexOf('const exePath = await resolveClaudeExeWaiting();'),
    { preIdx, spawnIdx: server.indexOf('const exePath = await resolveClaudeExeWaiting();') });
  t('★ 拉不起来也照跑，并且明说一声（整轮失败比退化成没浏览器更糟）',
    /浏览器没起来[^]*?notice/.test(server) || /notice[^]*?浏览器没起来/.test(server));
}

console.log('\n[5] 系统提示：这一段只在浏览器开着时给');
{
  t('★★ BROWSER_NOTE 和 AGENT_SAFETY 是两段，各挂各的开关（并在一起就是骗它）',
    /\+ \(agent \? AGENT_SAFETY : ''\)\s*\n\s*\+ \(browser \? BROWSER_NOTE : ''\)/.test(server));
  const noteIdx = server.indexOf('const BROWSER_NOTE =');
  const note = server.slice(noteIdx, server.indexOf('\n\n', noteIdx + 200));
  t('☑ 前提：抠到了 BROWSER_NOTE', noteIdx > 0 && note.length > 100);
  t('★★ 明确告诉它那不是干净的新浏览器（不说的话它会以为可以随便点）',
    /不是.{0,6}干净|登录状态|她的专用浏览器|专用浏览器/.test(note));
  t('★★ 明确写了「额度闸管不到这条路」（这是它自己那道闸的全部依据）',
    /额度|绕开|闸/.test(note), note.slice(0, 120));
}

console.log('\n[6] 前端：开关独立、发得出去、看得见');
{
  t('★★ 请求体带上了 browser 字段（不带的话后端永远收不到这个开关）',
    /browser: !!\(originChat && originChat\.browserMode\)/.test(api));
  t('★★ 按 originChat 算不是 getActiveChat（组装期间她切走了就会拿错对话的授权）',
    !/browser: !!\(getActiveChat\(\)/.test(api));

  t('★★ 有独立的 toggleBrowserMode（不是挂在电脑操控里的子开关）',
    /function toggleBrowserMode\(\)/.test(chats));
  t('★★ 开关存在对话上而不是全局（跟 agentMode 一样是 per-conversation）',
    /chat\.browserMode = !chat\.browserMode/.test(chats));
  t('★★ 首次开启要确认（接管的是她登录着的浏览器，不该悄悄就开了）',
    /if \(!chat\.browserMode\) \{[^]{0,200}confirm\(/.test(chats));
  t('★ 确认文案说清了「不是干净的新窗口」和「额度闸管不到」',
    /不是干净的新窗口/.test(chats) && /管不到/.test(chats));

  // ⚠️ 浏览器档可能**单独**开（agentMode=false）。工具显示挂在 agentMode 上的话，
  //   那种组合下她一个字都看不见 —— 而AI正在她的号上点东西。
  t('★★ 浏览器工具在纯聊天档也显示（只开浏览器时 agentMode 是 false）',
    /const isWebTool = [^\n]*brLabel/.test(api), (api.match(/const isWebTool = [^\n]*/) || [])[0]);
  t('★★ 动手的那几个有单独标记（她要能一眼认出「它点了东西」）',
    /浏览器·动手/.test(api) && /click\|type\|fill_form/.test(api));
  t('★★ 工具结果也给浏览器档看（只给 agentMode 的话她只能听AI转述）',
    /j\.toolResult && \(originChat\?\.agentMode \|\| originChat\?\.browserMode\)/.test(api));
  t('★ 点击类工具能显示出点的是什么（args 里没有 url，只有 element）',
    /args\.element \|\| args\.url/.test(api));
}

console.log('\n[7] 安卓副本跟着改了（不同步的话手机上是旧的，且零报错）');
{
  for (const f of ['js/03-chats-models.js', 'js/05-prompts-api.js']) {
    const a = fs.readFileSync(path.join(ROOT, f));
    const b = fs.existsSync(path.join(ROOT, 'android', 'assets', f))
      ? fs.readFileSync(path.join(ROOT, 'android', 'assets', f)) : Buffer.alloc(0);
    t(`★★ android 副本与 ${f} 字节一致`, Buffer.compare(a, b) === 0);
  }
}

try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { }
console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
