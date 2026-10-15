// 聊天AI清专用浏览器的浏览记录（mcp-chromecare.js + social-browser.clearHistory）
// 跑法：node tests/chromecare.test.js
//
// 背景（2026-10-08）：用户要聊天AI「在她同意的情况下能清理浏览器，就和终端一样」，
// 具体是清她登录着的那个专用 Chrome 的历史记录。这一摊里会静默坏的地方：
//   ① 清多了 —— 把 Cookie 一起删了，她小红书掉登录，而「清干净了」照样报得出来；
//   ② 清的时候有小红书的活在飞 —— 关浏览器等于把那次发送拦腰砍断；
//   ③ 接线漏了 —— 工具没挂上 / 聊天档没预授权（-p 下会挂住等批准，「没报错，就是不回」）；
//   ④ 地址写成 localhost —— 这台机器上被 wslrelay 截胡，返回空，看着像服务挂了。
//
// ⚠️ clearHistory 会去探专用 Chrome 的调试端口、活着就**关掉它**。所以行为测试一律在子进程里跑，
//    换一个没人监听的端口 + 临时 profile —— 在本进程里 require 真模块直接调，
//    跑一遍测试就会把用户正开着的那个 Chrome 关掉。
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const api = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-chromecare-'));

// 子进程里跑真的 clearHistory。busy=true 时包在 withChromeBusy 里调（模拟小红书的活在飞）。
function runClear(busy) {
  const prof = fs.mkdtempSync(path.join(TMP, 'prof-'));
  const def = path.join(prof, 'Default');
  fs.mkdirSync(def, { recursive: true });
  const all = ['History', 'History-journal', 'Visited Links', 'Top Sites', 'Shortcuts',
    'Cookies', 'Cookies-journal', 'Login Data', 'Preferences'];
  for (const f of all) fs.writeFileSync(path.join(def, f), 'x');
  const code = `
    const sb = require(${JSON.stringify(path.join(ROOT, 'social-browser.js'))});
    (async () => {
      const r = ${busy ? 'await sb.withChromeBusy(() => sb.clearHistory())' : 'await sb.clearHistory()'};
      process.stdout.write(JSON.stringify(r));
    })().catch(e => { process.stdout.write(JSON.stringify({ crash: e.message })); });`;
  const p = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8', timeout: 30000,
    // 端口 1：本机上不会有 CDP 在听，chromeAlive 必然 false，绝不会碰到真的那个 Chrome
    env: { ...process.env, GRANCYAN_CHROME_PORT: '1', GRANCYAN_CHROME_DIR: prof,
      GRANCYAN_SAY_STATE: path.join(TMP, 'says.json') },
  });
  let r = null;
  try { r = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { r = { raw: p.stdout, err: p.stderr }; }
  const left = new Set(fs.readdirSync(def));
  return { r, left };
}

console.log('\n[1] clearHistory：只清记录，不碰登录');
{
  const { r, left } = runClear(false);
  t('☑ 前提：子进程真跑起来并回了结果', r && typeof r.ok === 'boolean', r);
  t('★★ 记录文件都删掉了（History / Visited Links / Top Sites / Shortcuts）',
    ['History', 'History-journal', 'Visited Links', 'Top Sites', 'Shortcuts'].every(f => !left.has(f)), [...left]);
  t('★★ Cookie 和登录一个都没动（删了她小红书就掉登录，而「清干净了」照样报得出来）',
    ['Cookies', 'Cookies-journal', 'Login Data', 'Preferences'].every(f => left.has(f)), [...left]);
  t('★ 回报里列了删掉的文件、没有删不动的', r && r.ok === true && r.removed.includes('History') && r.failed.length === 0, r);
  t('☑ 端口上没有浏览器时不去关它（wasOpen=false）', r && r.wasOpen === false, r);
}

console.log('\n[2] 小红书的活在飞的时候不许清');
{
  const { r, left } = runClear(true);
  t('★★ inFlight>0 时拒绝（这时关浏览器等于把那次发送拦腰砍断）', r && r.ok === false && /忙/.test(r.error || ''), r);
  t('★★ 拒绝时一个文件都没删', left.has('History') && left.has('Cookies'), [...left]);
}

console.log('\n[3] 接线：配置、预授权、两档都挂');
{
  const fnSeg = server.slice(server.indexOf('function mcpConfigFile('), server.indexOf('function githubMcpConfig'));
  t('☑ 前提：抠到了 mcpConfigFile', fnSeg.length > 200);
  t('★★ chromecare 指向 mcp-chromecare.js、用 Electron 自己当 node（exe 里没有 node）',
    /want\.chromecare\)[^]*?process\.execPath[^]*?'mcp-chromecare\.js'[^]*?ELECTRON_RUN_AS_NODE/.test(fnSeg));
  t('★★ 服务端地址用 127.0.0.1 不用 localhost（这台机器上 localhost 会被 wslrelay 截胡）',
    /GRANCYAN_SERVER: `http:\/\/127\.0\.0\.1:/.test(fnSeg) && !/GRANCYAN_SERVER: `[^`]*localhost/.test(fnSeg));

  const seg = server.slice(server.indexOf("args.push('--tools', 'default'"), server.indexOf('if (resumeEntry) args.push'));
  t('★★ 电脑操控档开浏览器时挂上了 chromecare',
    /if \(browser\) \{[^]*?mcpConfigFile\(\{ browser: 1, chromecare: 1 \}\)/.test(seg));
  t('★★ 聊天档跟着浏览器开关挂 chromecare',
    /mcpConfigFile\(\{ github: 1, browser: browser \? 1 : 0, chromecare: browser \? 1 : 0 \}\)/.test(seg));
  t('★★ 聊天档把 chromecare 写进了 --allowed-tools（不预授权的话 -p 下挂住等批准）',
    /--allowed-tools[^]*?\(browser \? `[^`]*\$\{CHROMECARE_TOOL_PREFIX\}/.test(seg));
  t('★ 前缀和 server 名对得上（对不上的话预授权静默失效）',
    /const CHROMECARE_TOOL_PREFIX = 'mcp__chromecare';/.test(server) && /mcpServers\.chromecare = /.test(fnSeg));

  const noteIdx = server.indexOf('const BROWSER_NOTE =');
  const note = server.slice(noteIdx, server.indexOf('\n\n', noteIdx + 200));
  t('★★ 系统提示写了「先问她，她说好了再动」（这条就是她要的那道同意）',
    // 只认「清理」那一句里的先问：BROWSER_NOTE 前面本来就有「写要先问她」，宽了会被它蒙混过去（故障注入逮到的）
    /清理浏览器[^']*先问她，她说好了再动/.test(note) && /clear_history/.test(note), note.slice(-300));
  t('★ 系统提示说了清完这一轮浏览器工具会断（不说的话它清完接着点，全是报错）',
    /断/.test(note));

  t('★★ 前端把清记录显示出来（纯聊天档也要看得见它动了她的浏览器）',
    /mcp__chromecare__clear_history/.test(api) && /🧹 浏览器·清浏览记录/.test(api));
}

console.log('\n[4] mcp-chromecare.js 端到端：协议对、转发对、结果说人话');
(async () => {
  let hits = [];
  let reply = { ok: true, wasOpen: true, removed: ['History', 'Visited Links'], failed: [] };
  const srv = http.createServer((req, res) => {
    hits.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const callMcp = async () => {
    const p = spawn(process.execPath, [path.join(ROOT, 'mcp-chromecare.js')], {
      env: { ...process.env, GRANCYAN_SERVER: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', c => out += c);
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clear_history', arguments: {} } },
    ];
    p.stdin.end(lines.map(x => JSON.stringify(x)).join('\n') + '\n');
    await new Promise(r => p.on('close', r));
    const msgs = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    return Object.fromEntries(msgs.map(m => [m.id, m]));
  };

  const m = await callMcp();
  t('☑ 前提：initialize 回了 serverInfo', m[1] && m[1].result && m[1].result.serverInfo.name === 'chromecare', m[1]);
  t('★★ 通知没有被回复（回了对面会当协议错误）', !Object.keys(m).includes('undefined'));
  const tool = m[2] && m[2].result.tools.find(x => x.name === 'clear_history');
  t('★★ tools/list 里有 clear_history', !!tool, m[2]);
  t('★ 工具描述里写了「只在用户同意之后才调」', tool && /同意/.test(tool.description));
  t('★★ 真的转发到 POST /api/social-browser/clear-history', hits.includes('POST /api/social-browser/clear-history'), hits);
  const text = m[3] && m[3].result && m[3].result.content[0].text;
  t('★ 结果说清了：关了浏览器、删了什么、登录没动', /关掉/.test(text) && /History/.test(text) && /登录没动/.test(text), text);

  reply = { ok: false, wasOpen: true, removed: ['History'], failed: ['Visited Links'] };
  const m2 = await callMcp();
  const text2 = m2[3] && m2[3].result.content[0].text;
  t('★★ 删不动的如实说没清干净（不装作清好了）', /没清干净/.test(text2) && /Visited Links/.test(text2) && !/清干净了，/.test(text2), text2);

  reply = { ok: false, error: '浏览器正忙着（有一条小红书的活在跑），等它跑完再清' };
  const m3 = await callMcp();
  const text3 = m3[3] && m3[3].result.content[0].text;
  t('★ 服务端拒绝时把原因原样递给它', /没清成/.test(text3) && /正忙/.test(text3), text3);

  srv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  console.log(`\n${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
