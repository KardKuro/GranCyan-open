// 小千在 GranCyan 里上网（search / read / calc）的回归测试。跑法：node tests/ollama-tools.test.js
//
// 用户要 GranCyan 里的小千也能上网。GranCyan 没有 function calling，
// 工具回合在 server/ollama-proxy.js 里替它跑。这份守的都是静默失效：
//
//   · 工具没挂上 / 挂到了别的 Ollama 模型上 —— 前者小千只会说「我没法上网」，后者别的模型莫名其妙多一堆工具
//   · 调了工具但结果没塞回去（或 tool_call_id 对不上）—— 第二轮模型看不到结果，只能瞎编
//   · 工具痕迹写进了正文 —— 回填历史时模型照着学一个假的「[搜索]」格式
//   · 工具参数和 chat.py 训练时的不一样 —— 模型按训练时的样子调，这边接不住
//   · read 能读内网 —— 一句话就能让它把 GranCyan 自己的接口、局域网设备读出来
//   · 计算器是个 eval —— 能碰到 process
//   · 模型死循环调工具 —— 一直不开口

const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const sse = (res, deltas) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

(async () => {
  // ---- 假 Ollama：按剧本回。剧本由请求里最后一条 user 决定 ----
  const seen = [];
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      const user = [...(body.messages || [])].reverse().find(m => m.role === 'user')?.content || '';
      const toolMsgs = (body.messages || []).filter(m => m.role === 'tool');
      if (user === '算一下') {
        if (!toolMsgs.length) return sse(res, [{ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'calc', arguments: '{"expr":"3847*29+1024"}' } }] }]);
        return sse(res, [{ content: '结果是 ' }, { content: toolMsgs[0].content + '。' }]);
      }
      if (user === '读内网') {
        if (!toolMsgs.length) return sse(res, [{ tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'read', arguments: { url: 'http://127.0.0.1:3000/api/configs' } } }] }]);
        return sse(res, [{ content: '读不了' }]);
      }
      if (user === '死循环') {
        if (!body.tools) return sse(res, [{ content: '好吧我直接说' }]);
        return sse(res, [{ tool_calls: [{ index: 0, id: 'c' + toolMsgs.length, type: 'function', function: { name: 'calc', arguments: '{"expr":"1+1"}' } }] }]);
      }
      return sse(res, [{ content: '早呀' }]);
    });
  });
  const fakePort = await listen(fake);
  process.env.GRANCYAN_OLLAMA = `http://127.0.0.1:${fakePort}`;

  const express = require(path.join(ROOT, 'node_modules/express'));
  const proxy = require(path.join(ROOT, 'server/ollama-proxy.js'));
  const tools = require(path.join(ROOT, 'server/ollama-tools.js'));
  const app = express();
  app.use(express.json());
  proxy.registerOllamaProxy(app);
  const appPort = await listen(http.createServer(app));
  const base = `http://127.0.0.1:${appPort}/api/ollama/v1`;

  const chat = async (model, content, stream = true) => {
    const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content }] }) });
    const text = await r.text();
    if (!stream) return { status: r.status, json: JSON.parse(text) };
    let content_ = '', reasoning = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const d = JSON.parse(line.slice(6)).choices[0].delta;
      content_ += d.content || ''; reasoning += d.reasoning_content || '';
    }
    return { status: r.status, content: content_, reasoning, done: /data: \[DONE\]/.test(text), ct: r.headers.get('content-type') };
  };

  console.log('\n[1] 工具只挂给小千');
  seen.length = 0;
  await chat('xiaoqian', '早');
  const names = (seen[0].tools || []).map(x => x.function.name).sort().join(',');
  t('xiaoqian 带上 calc/read/search', names === 'calc,read,search', names);
  seen.length = 0;
  await chat('xiaoqian:latest', '早');
  t('xiaoqian:latest 也算', !!seen[0].tools);
  seen.length = 0;
  await chat('qwen3.5:9b', '早');
  t('别的 Ollama 模型不挂工具', !seen[0].tools, seen[0]);
  seen.length = 0;
  await chat('xiaoqian-old', '早');
  t('xiaoqian-old 这种别名不误伤（只认 xiaoqian 和 xiaoqian:tag）', !seen[0].tools);

  console.log('\n[2] 工具参数和训练用的 chat.py 一致');
  const pyPath = process.env.XIAOQIAN_CHAT_PY || '';   // 训练侧 chat.py 的路径（可选）
  const py = pyPath && fs.existsSync(pyPath) ? fs.readFileSync(pyPath, 'utf8') : null;
  if (!py) console.log('  · 这台机器没有 chat.py，跳过对照');
  else for (const tl of tools.TOOLS) {
    const f = tl.function;
    t(`${f.name} 的描述和 chat.py 一字不差`, py.includes(`'description': '${f.description}'`));
    const p = Object.keys(f.parameters.properties)[0];
    t(`${f.name} 的参数名 ${p} 和 chat.py 一致`, py.includes(`'properties': {'${p}'`));
  }

  console.log('\n[3] 调了工具 → 结果塞回去 → 第二轮开口');
  seen.length = 0;
  const r1 = await chat('xiaoqian', '算一下');
  t('SSE、[DONE] 收尾', /event-stream/.test(r1.ct) && r1.done, r1);
  t('最终正文用上了工具结果', r1.content === '结果是 112587。', r1.content);
  t('一共问了两轮', seen.length === 2, seen.length);
  const second = seen[1].messages;
  const asst = second.find(m => m.role === 'assistant');
  const tool = second.find(m => m.role === 'tool');
  t('第二轮带着 assistant 的 tool_calls', asst && asst.tool_calls?.[0]?.function?.name === 'calc', asst);
  t('第二轮带着 tool 结果，tool_call_id 对得上', tool && tool.tool_call_id === 'call_a' && tool.content === '112587', tool);
  t('工具痕迹进思考块', /🧮 计算：3847\*29\+1024/.test(r1.reasoning) && /112587/.test(r1.reasoning), r1.reasoning);
  t('工具痕迹不进正文', !/🧮|计算：/.test(r1.content), r1.content);

  console.log('\n[4] 非流式请求也能用');
  const r2 = await chat('xiaoqian', '算一下', false);
  t('返回完整 JSON，content 是最终答案', r2.status === 200 && r2.json.choices[0].message.content === '结果是 112587。', r2.json);

  console.log('\n[5] read 不许读内网');
  seen.length = 0;
  const r3 = await chat('xiaoqian', '读内网');
  const tres = seen[1]?.messages.find(m => m.role === 'tool')?.content || '';
  t('arguments 是对象（Ollama 的写法）也能解析', /📖 读网页：http:\/\/127\.0\.0\.1:3000/.test(r3.reasoning), r3.reasoning);
  t('塞回去的是拒绝，不是页面内容', /不许读内网/.test(tres), tres);
  for (const u of ['http://localhost:3000/', 'http://[::1]/', 'http://192.168.1.5/', 'http://100.64.10.20/', 'http://10.0.0.1/', 'file:///C:/Windows/win.ini']) {
    const out = await tools.read(u);
    t(`${u} 被挡`, /不许读内网|只能读/.test(out), out);
  }
  // 公网域名解析到内网（DNS 换绑那一类）：用一个解析到 127.0.0.1 的名字模拟
  const looked = await new Promise(r => tools.safeLookup('localhost', {}, (err, addr) => r(err ? err.code : addr)));
  t('建连接时的 lookup：localhost 解析出回环就拒（EPRIVATE）', looked === 'EPRIVATE', looked);
  // 域名解析到本机、端口上真有服务：挡住＝拿不到它的内容（关掉 lookup 这道就会把 models 列表读出来）
  const dnsOut = await tools.read(`http://localtest.me:${appPort}/api/ollama/v1/models`);
  t('解析到 127.0.0.1 的域名读不到本机服务', !/xiaoqian|object|data/.test(dnsOut), dnsOut);
  t('公网 IP 判为非内网', !tools.isPrivateIp('8.8.8.8') && !tools.isPrivateIp('2606:4700::1'));
  t('IPv4 映射的 IPv6 回环判为内网', tools.isPrivateIp('::ffff:127.0.0.1'));
  // URL 会把 [::ffff:127.0.0.1] 规范成 [::ffff:7f00:1]；以前只认点分写法，十六进制那种直接放行
  for (const ip of ['::ffff:7f00:1', '::ffff:c0a8:1f05', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1']) {
    t(`${ip} 判为内网`, tools.isPrivateIp(ip));
  }
  t('映射的公网 IPv4 照旧按公网判', !tools.isPrivateIp('::ffff:808:808'));
  for (const u of [`http://[::ffff:127.0.0.1]:${appPort}/`, `http://[::ffff:7f00:1]:${appPort}/`, `http://[0:0:0:0:0:ffff:127.0.0.1]:${appPort}/`]) {
    const out = await tools.read(u);
    t(`${u} 被挡（读不到本机服务）`, /不许读内网/.test(out), out);
  }

  console.log('\n[6] 计算器不是 eval');
  t('3847*29+1024', tools.calc('3847*29+1024') === '112587');
  t('3.14*5^2（^ 当乘方）', tools.calc('3.14*5^2') === '78.5');
  t('factorial(10)', tools.calc('factorial(10)') === '3628800');
  for (const bad of ['process.exit()', 'constructor', '__proto__', 'this', 'globalThis', "require('fs')", '[].constructor', 'Math.PI']) {
    t(`${bad} 被拒（白名单切词就拦下，不是靠语法错误侥幸）`, tools.calc(bad) === '算不了：只能算数学式子', tools.calc(bad));
  }

  console.log('\n[7] 模型一直调工具也会收口');
  seen.length = 0;
  const r4 = await chat('xiaoqian', '死循环');
  t('最后一轮不给工具，逼它开口', r4.content === '好吧我直接说' && !seen[seen.length - 1].tools, { content: r4.content, rounds: seen.length });
  t('总轮数有上限（≤6）', seen.length <= 6, seen.length);

  console.log('\n[8] Ollama 没开');
  await new Promise(r => fake.close(r));
  fake.closeAllConnections?.();
  const dead = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'xiaoqian', stream: true, messages: [] }) });
  const dj = await dead.json().catch(() => ({}));
  t('502 + 说人话', dead.status === 502 && /Ollama/.test(dj.error?.message || ''), dj);

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('挂了：', e); process.exit(1); });
