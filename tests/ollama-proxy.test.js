// 本地 Ollama 中转（小千）的回归测试。跑法：node tests/ollama-proxy.test.js
//
// 用户要在手机上也能跟小千聊（2026-09-24）。模型 API 地址填 `/api/ollama/v1`，
// 由 GranCyan server 转给电脑上的 Ollama。这份守的都是静默失效：
//
//   · 中转攒完整段才吐 —— 看着能用，但流式变成一口气蹦出来，还得干等
//   · 请求体在路上被改掉 / 丢字段 —— 模型名、stream 不对，回来的东西就不对
//   · 她点了停止上游还在跑 —— 显卡白白生成到底，下一句要排队
//   · 管理接口（pull/delete）被顺手放出去 —— 局域网里谁都能删她的模型
//   · 注册在 express.json 之前 / 跨站闸之前 —— 前者 body 恒为空只会报 400，后者别的网站能借她的浏览器用
//   · 前端不给相对路径补 SERVER_BASE —— 手机上请求打到 grancyan.app 假域名自己身上，永远连不上

const fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- 假 Ollama：chat 分两帧吐，中间停 300ms；记下收到了什么、连接什么时候断 ----
  const seen = [];
  let upstreamClosedEarly = false;
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      seen.push({ method: req.method, url: req.url, body: raw });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'xiaoqian' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const slow = JSON.parse(raw).model === 'slow';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"小明"}}]}\n\n');
        let finished = false;
        res.on('close', () => { if (!finished) upstreamClosedEarly = true; });
        await wait(slow ? 3000 : 300);
        if (res.destroyed) return;
        res.write('data: {"choices":[{"delta":{"content":"早呀"}}]}\n\ndata: [DONE]\n\n');
        finished = true;
        return res.end();
      }
      res.writeHead(404); res.end('fake: no such route');
    });
  });
  const fakePort = await listen(fake);
  process.env.GRANCYAN_OLLAMA = `http://127.0.0.1:${fakePort}/`;

  const express = require(path.join(ROOT, 'node_modules/express'));
  const proxy = require(path.join(ROOT, 'server/ollama-proxy.js'));
  const app = express();
  app.use(express.json());
  proxy.registerOllamaProxy(app);
  const appPort = await listen(http.createServer(app));
  const base = `http://127.0.0.1:${appPort}/api/ollama/v1`;

  console.log('\n[1] 流式逐帧透传，不攒');
  const t0 = Date.now();
  const r = await fetch(base + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'xiaoqian', stream: true, messages: [{ role: 'user', content: '早' }] }),
  });
  t('状态 200', r.status === 200, r.status);
  t('Content-Type 是 SSE', /event-stream/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  const reader = r.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now() - t0;
  t('第一帧在上游第二帧之前就到了（<250ms）', firstAt < 250 && /小明/.test(Buffer.from(first.value).toString()), firstAt + 'ms');
  let rest = '';
  for (;;) { const c = await reader.read(); if (c.done) break; rest += Buffer.from(c.value).toString(); }
  t('后面的帧和 [DONE] 都到了', /早呀/.test(rest) && /\[DONE\]/.test(rest), rest);

  console.log('\n[2] 请求体原样转给 Ollama 的 /v1');
  const chatCall = seen.find(s => s.url === '/v1/chat/completions');
  const fwd = chatCall && JSON.parse(chatCall.body);
  t('打的是 /v1/chat/completions', !!chatCall);
  t('model / stream / messages 原样', fwd && fwd.model === 'xiaoqian' && fwd.stream === true && fwd.messages[0].content === '早', fwd);
  t('没指定思考 → 补 reasoning_effort:none（不然先想几千帧才开口）', fwd && fwd.reasoning_effort === 'none', fwd);
  const lastBody = async (extra) => {
    await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'xiaoqian', stream: true, messages: [], ...extra }) }).then(x => x.text());
    return JSON.parse(seen.filter(s => s.url === '/v1/chat/completions').pop().body);
  };
  t('「不开思考」发的 low 也归 none', (await lastBody({ reasoning_effort: 'low' })).reasoning_effort === 'none');
  t('「全开思考」的 high 原样放行', (await lastBody({ reasoning_effort: 'high' })).reasoning_effort === 'high');
  const sysMsgs = (await lastBody({ messages: [{ role: 'system', content: '你是克克' }, { role: 'user', content: '早' }] })).messages;
  t('小千：GranCyan 的 system 去掉，留给 Modelfile 那句', sysMsgs.length === 1 && sysMsgs[0].role === 'user', sysMsgs);
  const VOL = '【本轮实时信息（系统给你的，不是用户说的话）】\n当前模型：claude-opus\n【实时信息结束，以下是用户这一轮说的话】\n\n';
  const volStr = (await lastBody({ messages: [{ role: 'user', content: VOL + '早' }] })).messages;
  t('挪到用户消息前的实时段也剥掉（字符串）', volStr[0].content === '早', volStr);
  const volArr = (await lastBody({ messages: [{ role: 'user', content: [{ type: 'text', text: VOL }, { type: 'text', text: '早' }] }] })).messages;
  t('实时段剥掉（数组，空段整块丢）', volArr[0].content.length === 1 && volArr[0].content[0].text === '早', JSON.stringify(volArr));

  console.log('\n[3] models 列表');
  const m = await fetch(base + '/models');
  const mj = await m.json();
  t('GET models 转发并原样返回', m.status === 200 && mj.data?.[0]?.id === 'xiaoqian', mj);

  console.log('\n[4] 坏请求和管理接口');
  const nb = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  t('没有 model → 400', nb.status === 400, nb.status);
  const before = seen.length;
  for (const p of ['/pull', '/delete', '/../api/tags']) {
    await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"x"}' });
  }
  t('pull / delete / 路径穿越一条都没转给 Ollama', seen.length === before, seen.slice(before));

  console.log('\n[5] 她点了停止：上游跟着掐');
  const ctl = new AbortController();
  const sr = await fetch(base + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
    body: JSON.stringify({ model: 'slow', stream: true, messages: [] }),
  });
  await sr.body.getReader().read();
  ctl.abort();
  await wait(400);
  t('客户端断开后上游连接被关', upstreamClosedEarly);

  console.log('\n[6] Ollama 没开');
  await new Promise(r => fake.close(r));
  fake.closeAllConnections?.();
  const dead = await fetch(base + '/models');
  const dj = await dead.json().catch(() => ({}));
  t('502 + 说人话', dead.status === 502 && /Ollama/.test(dj.error?.message || ''), dj);

  console.log('\n[7] server.js 里的注册位置');
  const srv = read('server.js');
  const iJson = srv.indexOf("app.use(express.json(");
  const iGate = srv.indexOf("app.use('/api', (req, res, next) => {");
  const iReg = srv.indexOf("require('./server/ollama-proxy').registerOllamaProxy(app)");
  t('注册了', iReg > 0);
  t('在 express.json 之后（不然 body 恒为空）', iJson > 0 && iReg > iJson, { iJson, iReg });
  t('在跨站闸之后（不然别的网站能借她的浏览器用）', iGate > 0 && iReg > iGate, { iGate, iReg });

  console.log('\n[8] 前端：相对路径补 SERVER_BASE');
  const api = read('js/05-prompts-api.js');
  const a = api.indexOf('const base = (conf.apiBase');
  const b = api.indexOf(': `${resolvedBase}/chat/completions`;', a);
  t('拼 url 那段找得到', a > 0 && b > a);
  const snippet = api.slice(a, b + ': `${resolvedBase}/chat/completions`;'.length);
  const urlFor = (apiBase, isAnthropic = false) => vm.runInNewContext(
    `const SERVER_BASE = 'http://192.168.1.5:3000'; const conf = { apiBase: ${JSON.stringify(apiBase)} }; const isAnthropic = ${isAnthropic};\n${snippet}\nurl`);
  t('/api/ollama/v1 → 电脑 server', urlFor('/api/ollama/v1') === 'http://192.168.1.5:3000/api/ollama/v1/chat/completions', urlFor('/api/ollama/v1'));
  t('绝对地址原样', urlFor('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
  t('空地址退回 OpenAI', urlFor('') === 'https://api.openai.com/v1/chat/completions');
  t('Anthropic 相对端点也补', urlFor('/x/v1/messages', true) === 'http://192.168.1.5:3000/x/v1/messages');

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('挂了：', e); process.exit(1); });
