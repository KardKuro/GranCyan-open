// MCP 远程操控（mcp-exec.js）必须是显式开启的。跑法：node tests/exec-mcp-optin.test.js
//
// 那条路由等于把这台电脑的 shell 暴露出去，所以：
//   · 没设 EXEC_MCP=on → 一条 /mcp 路由都不注册、也不生成 .mcp-token
//   · 设了 → 路由挂上，但启动日志里不出现 token 的任何一部分
//   · server.js 走的是带开关的入口，不是直接 mountExecMcp

const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };

const { maybeMountExecMcp, execMcpEnabled } = require('../mcp-exec');

function fakeApp() {
  const routes = [];
  return { routes, get: (p) => routes.push('GET ' + p), post: (p) => routes.push('POST ' + p), use: (p) => routes.push('USE ' + p) };
}
function withLogs(fn) {
  const out = [], orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { return { ret: fn(), out: out.join('\n') }; } finally { console.log = orig; }
}

console.log('\n[1] 开关的判法');
t('不设 = 关', execMcpEnabled({}) === false);
t('空串 / off / 0 = 关', !execMcpEnabled({ EXEC_MCP: '' }) && !execMcpEnabled({ EXEC_MCP: 'off' }) && !execMcpEnabled({ EXEC_MCP: '0' }));
t('on / 1 / true = 开', execMcpEnabled({ EXEC_MCP: 'on' }) && execMcpEnabled({ EXEC_MCP: '1' }) && execMcpEnabled({ EXEC_MCP: 'TRUE' }));

console.log('\n[2] 默认不挂');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mcp-off-'));
  const app = fakeApp();
  const { ret } = withLogs(() => maybeMountExecMcp(app, dir, {}));
  t('★ 没设 EXEC_MCP：不挂（返回 false）', ret === false);
  t('★ 没设 EXEC_MCP：一条路由都没注册', app.routes.length === 0, app.routes);
  t('★ 没设 EXEC_MCP：不生成 .mcp-token', !fs.existsSync(path.join(dir, '.mcp-token')));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] 显式开启才挂，而且日志里没有 token');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mcp-on-'));
  const app = fakeApp();
  const prevTok = process.env.EXEC_MCP_TOKEN;
  delete process.env.EXEC_MCP_TOKEN;
  try {
    const { ret, out } = withLogs(() => maybeMountExecMcp(app, dir, { EXEC_MCP: 'on' }));
    t('EXEC_MCP=on：挂上了', ret === true && app.routes.some(r => /\/mcp\/:token\/sse/.test(r)), app.routes);
    const tok = fs.readFileSync(path.join(dir, '.mcp-token'), 'utf8').trim();
    t('token 生成了', tok.length >= 32);
    t('★ 启动日志里不出现 token 的任何前缀', !out.includes(tok.slice(0, 4)), out);
  } finally {
    if (prevTok !== undefined) process.env.EXEC_MCP_TOKEN = prevTok;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n[4] server.js 接线');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
t('★ server.js 用的是带开关的 maybeMountExecMcp', /require\('\.\/mcp-exec'\)\.maybeMountExecMcp\(app, ROOT, process\.env\)/.test(server));
t('server.js 不再直接调 mountExecMcp', !/require\('\.\/mcp-exec'\)\.mountExecMcp\(/.test(server));
t('README 写了 EXEC_MCP 这个开关', /EXEC_MCP=on/.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
