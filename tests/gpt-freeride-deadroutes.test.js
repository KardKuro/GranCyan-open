'use strict';
// 1) 本地 GPT 默认不注入 FreeRide MCP，GRANCYAN_GPT_FREERIDE=1 才注入。
// 2) 死接口 /api/search、/api/chat-stream（开放转发口）已删，且没有调用方。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\r\n').join('\n');

let fail = 0;
function t(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function sourceBetween(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('切不出源码片段：' + from + ' → ' + to);
  return src.slice(a, b);
}

// ── FreeRide ──
{
  const fnSrc = sourceBetween(serverSrc, 'function gptFreerideArgs(env)', '\nfunction buildLocalGptPrompt');
  const box = {};
  vm.createContext(box);
  vm.runInContext(fnSrc + '\nthis.f = gptFreerideArgs;', box);
  const off = box.f({});
  const offOther = box.f({ GRANCYAN_GPT_FREERIDE: 'true' });
  const on = box.f({ GRANCYAN_GPT_FREERIDE: '1' });
  t('默认不注入 FreeRide', Array.isArray(off) && off.length === 0, off);
  t('只有 =1 才算开（"true" 不算）', offOther.length === 0, offOther);
  t('GRANCYAN_GPT_FREERIDE=1 时注入 freeride url 配置', on.join(' ').includes('mcp_servers.freeride.url='), on);

  // 真正的 spawn 参数要经过这个开关，而不是在别处又写死一份
  const spawnPart = sourceBetween(serverSrc, "'--disable', 'shell_snapshot',", "'--config', 'model_verbosity=");
  t('spawn 参数经 gptFreerideArgs(process.env) 注入', spawnPart.includes('...gptFreerideArgs(process.env)'), spawnPart);
  const literal = serverSrc.split('mcp_servers.freeride.url').length - 1;
  t('mcp_servers.freeride 只在开关函数里出现一次（没有写死的无条件注入）', literal === 1 && fnSrc.includes('mcp_servers.freeride.url'), literal);
}

// ── 死接口 ──
{
  for (const route of ['/api/search', '/api/chat-stream']) {
    const re = new RegExp(`app\\.(post|get|all|use)\\(\\s*['"\`]${route.replace(/[/-]/g, '\\$&')}['"\`]`);
    t(`server.js 不再注册 ${route}`, !re.test(serverSrc));
  }
  t('只给 chat-stream 用的 RPM 队列一起删了', !/function enqueueRequest|function drainQueue|const requestQueue/.test(serverSrc));
  t('outboundAgent 回落用的 agent 还在', /const agent = new https\.Agent/.test(serverSrc) && /if \(!p\) return agent;/.test(serverSrc));

  // 调用方扫描：前端、coread、安卓源码（不含 assets 构建产物）、electron 主进程
  const hits = [];
  const scanned = { n: 0 };
  function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'lib') walk(p); continue; }
      if (!/\.(js|html|java|kt|mjs)$/.test(e.name)) continue;
      scanned.n++;
      const s = fs.readFileSync(p, 'utf8');
      if (/\/api\/search\b|\/api\/chat-stream\b/.test(s)) hits.push(path.relative(ROOT, p));
    }
  }
  for (const d of ['js', 'coread', path.join('android', 'src')]) walk(path.join(ROOT, d));
  for (const f of ['index.html', 'electron-main.js']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) { scanned.n++; if (/\/api\/search\b|\/api\/chat-stream\b/.test(fs.readFileSync(p, 'utf8'))) hits.push(f); }
  }
  t('扫描确实扫到了文件（对照：非空）', scanned.n > 20, scanned.n);
  t('前端/coread/安卓源码/electron 没有调用这两个接口', hits.length === 0, hits);
  // 对照组：同一个扫描函数能认出真在用的接口
  const ctl = fs.readFileSync(path.join(ROOT, 'js', '03-chats-models.js'), 'utf8');
  t('对照：扫描判据能命中真实存在的 /api/ 调用', /\/api\/cc-memory\b/.test(ctl));
}

if (fail) { console.error(`\n${fail} 项失败`); process.exit(1); }
console.log('\ngpt-freeride-deadroutes: 全部通过');
