// 小千查资料的回归测试。跑法：node tests/xiaoqian-ziliao.test.js
//
// 2026-09-25：小千（本地 9B）问到铜锣湾、乌鲁木齐中路这类事会现编，训进去又会串（张明远被套成店长）。
// 改成问到就把资料附在问题前面。这份守的都是静默失效：
//
//   · 资料塞进了 system —— 小千照固定 SYSTEM 训的，差一个字就跑偏，而且看起来「能用」
//   · 资料写回了前端传来的历史数组 —— 一轮轮堆进上下文，几轮后把 8192 撑爆，开始失忆
//   · 没命中也附东西 / 「你好呀」也附 —— 她会在闲聊里突然讲六四
//   · 图片消息（content 是数组）被压成字符串 —— 图丢了，不报错
//   · 关键词表坏了 / 目录不在（别的电脑）—— 必须照常聊，不许 500

const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ziliao-'));
  fs.writeFileSync(path.join(dir, '关键词.json'), JSON.stringify({
    _说明: '不是资料',
    'A.md': ['铜锣湾', '林荣基'],
    'B.md': ['乌鲁木齐', '11月27'],
    'C.md': ['香港'],
    'D.md': ['书店'],
  }));
  fs.writeFileSync(path.join(dir, 'A.md'), '铜锣湾资料正文');
  fs.writeFileSync(path.join(dir, 'B.md'), '白纸资料正文');
  fs.writeFileSync(path.join(dir, 'C.md'), '香港资料正文');
  fs.writeFileSync(path.join(dir, 'D.md'), '书店资料正文');
  process.env.GRANCYAN_XIAOQIAN_ZILIAO = dir;
  const Z = require(path.join(ROOT, 'server/xiaoqian-ziliao.js'));

  console.log('\n[1] 命中规则');
  t('没关键词 → 不附', Z.lookup('你好呀', dir).length === 0);
  t('命中一份', Z.lookup('上海乌鲁木齐路怎么了', dir).map(d => d.file).join() === 'B.md');
  t('全角数字、空格也认（２０２２年１１月 27 号）', Z.lookup('2022年１１月 27号凌晨上海', dir).map(d => d.file).join() === 'B.md',
    Z.lookup('2022年１１月 27号凌晨上海', dir).map(d => d.file));
  const top = Z.lookup('香港铜锣湾书店林荣基', dir).map(d => d.file);
  t('最多两份，命中多的在前', top.length === 2 && top[0] === 'A.md', top);
  t('_说明 不当资料', !Z.lookup('不是资料', dir).length);

  console.log('\n[2] 附在最后一句 user 前面，不碰 system、不改原数组');
  const orig = [
    { role: 'system', content: 'SYS 原文' },
    { role: 'user', content: '铜锣湾书店是怎么回事' },
    { role: 'assistant', content: '……' },
    { role: 'user', content: '林荣基后来呢' },
  ];
  const snapshot = JSON.stringify(orig);
  const r = Z.attach(orig, dir);
  t('system 一字不差', r.messages[0].content === 'SYS 原文');
  t('只改最后一句 user', r.messages[1].content === '铜锣湾书店是怎么回事' && /铜锣湾资料正文[\s\S]*林荣基后来呢$/.test(r.messages[3].content),
    r.messages[3].content);
  t('传进来的数组没被改', JSON.stringify(orig) === snapshot);
  t('used 报了文件名', r.used.join() === 'A.md');
  t('没命中原样返回', Z.attach([{ role: 'user', content: '你好呀' }], dir).messages[0].content === '你好呀');

  const img = [{ role: 'user', content: [{ type: 'text', text: '这是铜锣湾吗' }, { type: 'image_url', image_url: { url: 'data:x' } }] }];
  const ri = Z.attach(img, dir).messages[0].content;
  t('图片消息：还是数组、图还在、资料在最前', Array.isArray(ri) && ri.length === 3 && ri[2].type === 'image_url' && /铜锣湾资料正文/.test(ri[0].text), ri);

  console.log('\n[3] 目录坏了照常聊');
  t('目录不存在 → 不附不抛', Z.attach([{ role: 'user', content: '铜锣湾' }], path.join(dir, 'nope')).used.length === 0);
  fs.writeFileSync(path.join(dir, '关键词.json'), '{坏的');
  t('关键词表坏了 → 不附不抛', Z.lookup('铜锣湾', dir).length === 0);
  fs.writeFileSync(path.join(dir, '关键词.json'), JSON.stringify({ 'A.md': ['铜锣湾'], 'GONE.md': ['铜锣湾'] }));
  t('表里有、文件没了 → 跳过那份', Z.lookup('铜锣湾', dir).map(d => d.file).join() === 'A.md');

  console.log('\n[4] 走真中转：Ollama 收到的带资料，前端看到「查资料」');
  const seen = [];
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  process.env.GRANCYAN_OLLAMA = `http://127.0.0.1:${await listen(fake)}`;
  const express = require(path.join(ROOT, 'node_modules/express'));
  const proxy = require(path.join(ROOT, 'server/ollama-proxy.js'));
  const app = express(); app.use(express.json()); proxy.registerOllamaProxy(app);
  const appSrv = http.createServer(app);
  const base = `http://127.0.0.1:${await listen(appSrv)}/api/ollama/v1`;
  const ask = async (model, content) => {
    const res = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content }] }) });
    return res.text();
  };
  const out = await ask('xiaoqian', '铜锣湾书店是什么');
  const up = seen.at(-1).messages;
  t('Ollama 收到资料', /铜锣湾资料正文/.test(up.at(-1).content), up.at(-1).content);
  t('资料也没进 system（GranCyan 的 system 整个去掉，交给 Modelfile）', !up.some(m => m.role === 'system'), up);
  t('前端流里有「📚 查资料」思考帧', /reasoning_content[^\n]*📚 查资料：A\.md/.test(out), out);
  t('资料正文不进前端正文', !/铜锣湾资料正文/.test(out));
  await ask('xiaoqian', '你好呀');
  t('「你好呀」原样转', seen.at(-1).messages.at(-1).content === '你好呀');
  await ask('qwen3:4b', '铜锣湾书店是什么');
  t('别的模型不附资料', seen.at(-1).messages.at(-1).content === '铜锣湾书店是什么');

  for (const srv of [fake, appSrv]) { srv.closeAllConnections?.(); srv.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
