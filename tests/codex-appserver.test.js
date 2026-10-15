'use strict';
// 订阅 GPT 流式通道（server/codex-appserver.js，2026-10-07）。
// 守三件事：
//   1. 她的 config.toml 里有不认得的配置就不走 app-server（宁可不流式，不悄悄带进她的新东西）
//   2. 认得的那几项真的被压掉（priority 档、MCP、notify、hooks、elevated 沙箱）
//   3. 装成 exec 进程的那层翻译对：增量、补尾巴、用量、失败、审批请求、进程退出码
// 第 3 条用一个假的 app-server（node 跑的 JSON-RPC 脚本）真起进程测。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const m = require('../server/codex-appserver');

let fail = 0;
function t(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-app-'));
const home = cfg => { const d = fs.mkdtempSync(path.join(tmp, 'home-')); if (cfg != null) fs.writeFileSync(path.join(d, 'config.toml'), cfg); return d; };

// 一份典型的 ~/.codex/config.toml 的结构（值是假的）
const HER = `approvals_reviewer = "user"
approval_policy = "never"
sandbox_mode = "danger-full-access"
service_tier = "priority"
model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
notify = [ "x.exe", "turn-ended" ]
[mcp_servers]

[mcp_servers.freeride]
url = "https://example/mcp"
enabled = false

[mcp_servers.freeride.http_headers]
X-FreeRide-Version = "1"

[mcp_servers.node_repl]
command = 'C:\\x\\node_repl.exe'

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\x\\.codex'

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[projects.'c:\\projects\\grancyan']
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.6-sol" = 3

[windows]
sandbox = "elevated"

[desktop]
followUpQueueMode = "queue"

[features]
hooks = true
js_repl = false

[shell_environment_policy.set]
A = "b"

[marketplaces.openai-bundled]
source_type = "local"

[hooks.state.'C:\\x\\hooks.json:stop:0:0']
trusted_hash = "sha256:x"

[sandbox_workspace_write]
network_access = true

[plugins."browser@openai-bundled"]
enabled = true
`;

console.log('\n[1] 读她的配置：认得的放行，不认得的退回 exec');
{
  const s = m.scanCodexConfig(HER);
  t('MCP 名字都认出来了（含 [x.env] 这种子表不重复算）', ['freeride', 'node_repl', 'openaiDeveloperDocs'].every(n => s.mcp.includes(n)) && s.mcp.length === 3, s.mcp);
  t('features / windows 的子键记下来了', ['features.hooks', 'features.js_repl', 'windows.sandbox'].every(k => s.sub.includes(k)), s.sub);
  t('她现在这份配置放行', m.codexAppConfigCheck(home(HER), null).ok, m.codexAppConfigCheck(home(HER), null).reason);
  t('没有 config.toml 也放行（GPT 用隔离的家时）', m.codexAppConfigCheck(home(null), null).ok);
  // 顶层键只能写在第一张表之前（写在文件末尾的话按 TOML 它属于最后那张表）
  const r1 = m.codexAppConfigCheck(home('developer_instructions = "x"\n' + HER), null);
  t('★ 多一个没见过的顶层键 → 不走', !r1.ok && /developer_instructions/.test(r1.reason), r1);
  const r2 = m.codexAppConfigCheck(home(HER.replace('js_repl = false', 'js_repl = false\nmemories = true')), null);
  t('★ [features] 里多一个开关 → 不走', !r2.ok && /features\.memories/.test(r2.reason), r2);
  const r3 = m.codexAppConfigCheck(home('features.memories = true\n'), null);
  t('★ 点号写法的 features.x 也认得出', !r3.ok && /features\.memories/.test(r3.reason), r3);
  const r4 = m.codexAppConfigCheck(home('[profiles.fast]\nmodel = "x"\n'), null);
  t('★ 新的表也不走', !r4.ok && /profiles/.test(r4.reason), r4);
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-')); fs.mkdirSync(path.join(cwd, '.codex')); fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), 'x=1');
  t('工作目录里有 .codex/config.toml → 不走', !m.codexAppConfigCheck(home(HER), cwd).ok);
}

console.log('\n[2] 参数翻译：该压的压掉');
{
  const exec = ['exec', 'resume', 'THREAD1', '--json', '--ignore-user-config', '--skip-git-repo-check',
    '--disable', 'plugins', '--config', 'model_reasoning_effort="high"', '--config', 'model_reasoning_summary="detailed"',
    '--config', 'mcp_servers.freeride.url="https://x"', '--sandbox', 'workspace-write', '--cd', 'D:\\x', '--color', 'never',
    '--image', 'a.png', '--image', 'b.png', '--model', 'gpt-x', '-'];
  const r = m.translateExecArgs(exec, ['freeride', 'node_repl', 'openaiDeveloperDocs']);
  const L = r.launch.join(' ');
  t('续传的线程号', r.resumeId === 'THREAD1');
  t('图片 / 模型 / 沙箱 / 目录', r.images.join() === 'a.png,b.png' && r.model === 'gpt-x' && r.sandbox === 'workspace-write' && r.cwd === 'D:\\x', r);
  t('深度和摘要单独拿出来（每轮 turn/start 要显式给）', r.effort === 'high' && r.summary === 'detailed', r);
  t('★ 档位压回 default（她的是 priority）', L.includes('service_tier="default"'));
  t('★ notify 清空', L.includes('notify=[]'));
  t('★ hooks 关掉', /--disable hooks/.test(L));
  t('★ 沙箱用 unelevated', L.includes('windows.sandbox="unelevated"'));
  t('★ 她的 MCP 逐个关掉', L.includes('mcp_servers.node_repl.enabled=false') && L.includes('mcp_servers.openaiDeveloperDocs.enabled=false'));
  t('路由自己配了的 MCP（freeride）不反手关掉', !L.includes('mcp_servers.freeride.enabled=false'));
  t('exec 专属的参数没带过去', !/--json|--ignore-user-config|--skip-git-repo-check|--color| - ?$/.test(L), L);
  t('路由给的 --config/--disable 原样带过去', L.includes('--disable plugins') && L.includes('model_reasoning_effort="high"'));
  t('第一个参数是 app-server', r.launch[0] === 'app-server');
}

console.log('\n[3] 条目翻译成 exec 的样子');
{
  t('正文', JSON.stringify(m.mapItem({ type: 'agentMessage', id: 'a', text: 'hi' })) === JSON.stringify({ id: 'a', type: 'agent_message', text: 'hi' }));
  t('思考摘要按段拼回去', m.mapItem({ type: 'reasoning', id: 'r', summary: ['**甲**', '**乙**'] }).text === '**甲**\n\n**乙**');
  const c = m.mapItem({ type: 'commandExecution', id: 'c', command: 'ls', aggregatedOutput: 'x', status: 'completed', exitCode: 2 });
  t('命令：退出码非 0 算 failed', c.type === 'command_execution' && c.status === 'failed' && c.aggregated_output === 'x', c);
  t('她自己那条消息不回显', m.mapItem({ type: 'userMessage', id: 'u' }) === null);
}

// ── 假的 app-server：node 跑，文件名就叫 app-server（launch 第一个参数就是它） ──
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
const mode = process.env.FAKE_MODE || 'ok';
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
const got = [];
rl.on('line', l => {
  const m = JSON.parse(l); got.push(m);
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: m.params.threadId || 'T-NEW' } } });
  if (m.id != null && !m.method) { out({ method: 'test/echo', params: { reply: m } }); return; }   // 我们给它的审批回包，回显给测试看
  if (m.method === 'turn/start') {
    out({ id: m.id, result: {} });
    out({ method: 'test/echo', params: { turnStart: m.params } });
    const tid = m.params.threadId;
    if (mode === 'approval') out({ id: 99, method: 'item/commandExecution/requestApproval', params: {} });
    out({ method: 'item/started', params: { threadId: tid, item: { type: 'agentMessage', id: 'msg1', text: '' } } });
    out({ method: 'item/agentMessage/delta', params: { threadId: tid, itemId: 'msg1', delta: '你好' } });
    out({ method: 'item/agentMessage/delta', params: { threadId: 'OTHER', itemId: 'x', delta: '别的线程' } });
    out({ method: 'item/agentMessage/delta', params: { threadId: tid, itemId: 'msg1', delta: ' 小明' } });
    out({ method: 'error', params: { threadId: tid, willRetry: true, error: { message: 'stream disconnected' } } });
    out({ method: 'item/completed', params: { threadId: tid, item: { type: 'agentMessage', id: 'msg1', text: '你好 小明！' } } });
    out({ method: 'thread/tokenUsage/updated', params: { threadId: tid, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 1 } } } });
    out({ method: 'thread/tokenUsage/updated', params: { threadId: tid, tokenUsage: { last: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 3, reasoningOutputTokens: 0 } } } });
    if (mode === 'fail') out({ method: 'turn/completed', params: { threadId: tid, turn: { status: 'failed', error: { message: '额度用完了' } } } });
    else if (mode !== 'hang') out({ method: 'turn/completed', params: { threadId: tid, turn: { status: 'completed' } } });
  }
});
rl.on('close', () => process.exit(0));
`;
const fakeDir = fs.mkdtempSync(path.join(tmp, 'fake-'));
fs.writeFileSync(path.join(fakeDir, 'app-server'), FAKE);

function runFake(mode, execArgs, prompt = 'hi') {
  return new Promise(res => {
    const proc = m.spawnCodexApp(process.execPath, execArgs, { cwd: fakeDir, env: { ...process.env, FAKE_MODE: mode }, windowsHide: true }, { mcp: [] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.stdin.write(prompt); proc.stdin.end();
    const timer = mode === 'hang' ? setTimeout(() => require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' }), 1500) : null;
    proc.on('close', code => {
      clearTimeout(timer);
      res({ code, err, pid: proc.pid, lines: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) });
    });
  });
}

(async () => {
  console.log('\n[4] 真起一个假的 app-server 跑一轮');
  const r = await runFake('ok', ['exec', '--json', '--config', 'model_reasoning_effort="low"', '--config', 'model_reasoning_summary="detailed"', '--model', 'gpt-x', '-'], '讲个故事');
  const types = r.lines.map(l => l.type);
  t('有 pid（taskkill /T 要用）', typeof r.pid === 'number');
  t('先吐 thread.started 带线程号（续传索引靠它）', types[0] === 'thread.started' && r.lines[0].thread_id === 'T-NEW', r.lines[0]);
  const deltas = r.lines.filter(l => l.type === 'item.delta');
  t('★ 增量按顺序吐出来', deltas.map(d => d.delta).join('') === '你好 小明' && deltas.every(d => d.item_id === 'msg1'), deltas);
  t('别的线程的增量不混进来', !deltas.some(d => d.delta === '别的线程'));
  t('完整那条照常吐（路由拿它补尾巴「！」）', r.lines.some(l => l.type === 'item.completed' && l.item.type === 'agent_message' && l.item.text === '你好 小明！'));
  const retry = r.lines.find(l => l.type === 'error');
  t('★ 会重试的错误带 Reconnecting 前缀（路由不会当成这轮失败）', retry && /^Reconnecting/.test(retry.message), retry);
  const usage = r.lines.find(l => l.type === 'turn.completed');
  t('★ 一轮里多次请求的用量加起来', usage && usage.usage.input_tokens === 120 && usage.usage.cached_input_tokens === 70 && usage.usage.output_tokens === 8, usage);
  t('正常结束退出码 0', r.code === 0, r.code);

  console.log('\n[5] 失败 / 审批 / 被掐');
  const f = await runFake('fail', ['exec', '--json', '-']);
  t('★ failed → turn.failed 带原因、退出码非 0', f.lines.some(l => l.type === 'turn.failed' && l.error.message === '额度用完了') && f.code === 1, { code: f.code, lines: f.lines.map(l => l.type) });
  const a = await runFake('approval', ['exec', '--json', '-']);
  t('审批请求被回绝而不是挂着（照样跑完）', a.code === 0 && /拒绝了服务端请求/.test(a.err), a.err);
  const h = await runFake('hang', ['exec', '--json', '-']);
  t('★ 被 taskkill 掐掉（没走到 turn/completed）退出码非 0', h.code !== 0, h.code);

  // turn/start 的参数要从假服务端那儿看：它把收到的 turn/start 回显成一条通知 —— 这里换个法子，直接读 FAKE 收到的
  console.log('\n[6] turn/start 显式带了深度和摘要');
  {
    const { spawn } = require('node:child_process');
    // 起一个会把 turn/start 参数写到文件的假服务端
    const dir = fs.mkdtempSync(path.join(tmp, 'fake2-'));
    fs.writeFileSync(path.join(dir, 'app-server'), FAKE.replace("out({ method: 'test/echo', params: { turnStart: m.params } });",
      "require('fs').writeFileSync(require('path').join(process.cwd(), 'turn.json'), JSON.stringify(m.params));"));
    await new Promise(res => {
      const p = m.spawnCodexApp(process.execPath, ['exec', '--json', '--config', 'model_reasoning_effort="high"', '--config', 'model_reasoning_summary="detailed"', '--image', 'x.png', '-'],
        { cwd: dir, env: process.env, windowsHide: true }, { mcp: [] });
      p.stdin.end('看图'); p.on('close', res);
    });
    const ts = JSON.parse(fs.readFileSync(path.join(dir, 'turn.json'), 'utf8'));
    t('★ effort / summary 每轮显式给（-c 在 app-server 下不管用）', ts.effort === 'high' && ts.summary === 'detailed', ts);
    t('提示词和图片都进了 input', ts.input[0].text === '看图' && ts.input[1].type === 'localImage' && ts.input[1].path === 'x.png', ts.input);
  }

  console.log('\n[7] 路由接线');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  t('路由按检查结果二选一', /appCheck\.ok\s*\n?\s*\? spawnCodexApp\(/.test(src));
  t('GRANCYAN_GPT_STREAM=0 能退回 exec', src.includes("process.env.GRANCYAN_GPT_STREAM === '0'"));
  t('★ 路由认 item.delta，完整那条只补尾巴', src.includes("j.type === 'item.delta'") && /item\.text\.startsWith\(sent\)\s*\?\s*item\.text\.slice\(sent\.length\)/.test(src));

  fs.rmSync(tmp, { recursive: true, force: true });
  if (fail) { console.error(`\n❌ ${fail} 条失败`); process.exit(1); }
  console.log('\n✅ codex-appserver 全部通过');
})();
