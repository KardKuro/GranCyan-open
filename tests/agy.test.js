// 订阅 Gemini（server/agy.js + gemini.js 里 via:'sub' 那个岔口）的回归测试。
//
// 和 gemini.test.js 一个思路：测行为，不 grep 源码。这条路错了也很安静 ——
// 系统提示没喂进去它照样回话（只是变回编程助手的口气）、附图没落盘它照样回话（只是瞎编）、
// 走订阅的请求漏到 key 那条路上，她看到的是「还没有 API key」。
const path = require('node:path');

const root = path.join(__dirname, '..');
const agy = require(path.join(root, 'server', 'agy.js'));
const gem = require(path.join(root, 'server', 'gemini.js'));

let failed = 0;
function check(name, yes) {
  console.log(`  ${yes ? '✓' : '✗'} ${name}`);
  if (!yes) failed++;
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';

// ── agyModel：深度下拉 → 三档 flash ──────────────────────────
console.log('agyModel');
check('深 → high', agy.agyModel('high') === 'gemini-3.8-flash-high');
check('浅 / 不看思考 → low', agy.agyModel('low') === 'gemini-3.8-flash-low' && agy.agyModel('minimal') === 'gemini-3.8-flash-low');
check('自动（空）/ 中 → medium', agy.agyModel('') === 'gemini-3.8-flash-medium' && agy.agyModel('medium') === 'gemini-3.8-flash-medium');
check('认不得的值不报错，落到 medium', agy.agyModel('xhigh') === 'gemini-3.8-flash-medium');

// ── buildPrompt ──────────────────────────────────────────────
console.log('buildPrompt');
{
  const b = agy.buildPrompt([
    { role: 'user', content: '早', images: [PNG] },
    { role: 'assistant', content: '早呀' },
    { role: 'user', content: '看这个', images: [PNG, JPG] },
  ], '你是克克');
  check('系统提示进了 <system_prompt>', /<system_prompt>\n你是克克\n<\/system_prompt>/.test(b.text));
  check('历史两轮都在 <history> 里', /<history>[\s\S]*早[\s\S]*早呀[\s\S]*<\/history>/.test(b.text));
  check('最后一条用户消息单独放 <current_user_message>', /<current_user_message>\n看这个/.test(b.text));
  check('只有最后一条的图落盘（2 张），历史那张不看', b.images.length === 2);
  check('图按 mime 起扩展名', b.images[0].name === 'img-1.png' && b.images[1].name === 'img-2.jpg');
  check('提示里点了附图的名字', b.text.includes('img-1.png') && b.text.includes('img-2.jpg'));
  check('历史里的图留一句「带过 N 张图」', b.text.includes('[这条带过 1 张图]'));
  check('当前那条不在 <history> 里重复出现', !/<history>[\s\S]*看这个[\s\S]*<\/history>/.test(b.text));
}
{
  const b = agy.buildPrompt([{ role: 'system', content: '别混进来' }, { role: 'user', content: 'hi' }], '');
  check('没系统提示就不写空的 <system_prompt>', !b.text.includes('<system_prompt>'));
  check('messages 里混进来的 system 不当历史', !b.text.includes('别混进来'));
}
{
  const b = agy.buildPrompt([{ role: 'user', content: '讲个故事' }, { role: 'assistant', content: '从前有座山' }], '');
  check('最后是 assistant（续写）→ 交代接着往下说', b.text.includes('从前有座山') && b.text.includes('接着上面你已经说的往下说'));
}
check('全空 → empty', agy.buildPrompt([], '').empty === true);
check('坏的 data URL 不落盘', agy.buildPrompt([{ role: 'user', content: 'x', images: ['http://不是dataurl'] }], '').images.length === 0);

// ── createAgyParser ──────────────────────────────────────────
console.log('createAgyParser');
function runParser(lines, cut) {
  const events = []; let textDone = 0, activity = 0;
  const p = agy.createAgyParser({ emit: e => events.push(e), onTextDone: () => textDone++, onActivity: () => activity++ });
  const raw = lines.map(o => JSON.stringify(o)).join('\n') + '\n';
  if (cut) { for (let i = 0; i < raw.length; i += cut) p.feed(raw.slice(i, i + cut)); } else p.feed(raw);
  return { events, textDone, activity, state: p.state() };
}
const step = (o) => ({ event: 'step_update', step_update: { conversation_id: 'c', ...o } });
const resp = [
  { event: 'init', conversation_id: 'c', init: { model: 'gemini-3.8-flash-low' } },
  step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
  step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你好' }),
  step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '，在呢\n', usage: { input_tokens: 100, output_tokens: 7, cache_read_tokens: 30 } }),
];
{
  const r = runParser(resp);
  const text = r.events.filter(e => e.delta).map(e => e.delta).join('');
  check('正文按 text_delta 拼起来，DONE 那帧带的尾巴也算', text === '你好，在呢\n');
  check('正文 DONE 回调一次（拿来起「安静 1.5s 就收」的计时）', r.textDone === 1);
  check('usage 从 step 里拿到', r.state.usage && r.state.usage.in === 100 && r.state.usage.out === 7 && r.state.usage.cached === 30);
  check('没有误报 error', !r.events.some(e => e.error));
}
{
  const r = runParser(resp, 7);
  check('NDJSON 在任意位置被切断也拼得回来', r.events.filter(e => e.delta).map(e => e.delta).join('') === '你好，在呢\n');
}
{
  const r = runParser([
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1, output_tokens: 1 } }),
  ]);
  check('只有 usage 没有字的 DONE（工具调用前那一步）不算正文完了', r.textDone === 0 && !r.state.sawText);
}
{
  const r = runParser([
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: 'C:\\tmp\\x\\img-1.jpg' } } }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: {} } }),
  ]);
  check('看附图 → 思考链里报一句，不当正文', r.events.some(e => e.thinking && e.thinking.includes('img-1.jpg')) && !r.events.some(e => e.delta));
  check('交代过别用的工具它还是用了 → notice', r.events.some(e => e.notice && e.notice.includes('run_command')));
  check('工具步也算活动（打断「安静就收」的计时）', r.activity === 2);
}
{
  const r = runParser([{ event: 'result', result: { status: 'ERROR', error: 'Waiting for authentication timed out', usage: {} } }]);
  check('ERROR 的 result → error，而且翻成「去登录」', r.events.some(e => e.error && e.error.includes('登录')));
}
{
  const r = runParser([{ event: 'result', result: { status: 'SUCCESS', response: 'x', usage: { input_tokens: 9, output_tokens: 3 } } }]);
  check('SUCCESS 的 result 不报错，usage 以它为准', !r.events.some(e => e.error) && r.state.usage.in === 9);
}
check('不是 JSON 的行（stderr 混进来）直接跳过', runParser([]).events.length === 0 && (() => {
  const ev = []; const p = agy.createAgyParser({ emit: e => ev.push(e) });
  p.feed('error: something\n{bad json\n'); return ev.length === 0;
})());

// ── gemini.js 的岔口：via:'sub' 必须走 agy、不碰 key ─────────────
console.log('gemini.js 岔口');
function fakeApp() {
  const routes = {};
  return { routes, get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } };
}
function fakeRes() {
  const out = [];
  return {
    out, writableEnded: false,
    setHeader() {}, flushHeaders() {}, on() {},
    write(s) { out.push(s); }, end() { this.writableEnded = true; },
    json(o) { out.push(JSON.stringify(o)); },
  };
}
(async () => {
  const app = fakeApp();
  gem.mount(app, { ROOT: path.join(root, '_tmp'), outboundAgent: async () => null });
  const origRun = agy.runTurn, origWarm = agy.prewarm;
  const calls = []; const warms = [];
  agy.runTurn = (o) => { calls.push(o); o.send({ delta: 'hi' }); o.finish(); };
  agy.prewarm = (m) => warms.push(m);
  const savedKey = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    const res = fakeRes();
    await app.routes['POST /api/local-gemini']({ body: { via: 'sub', messages: [{ role: 'user', content: 'x' }], systemPrompt: 's', thinkingLevel: 'high' } }, res);
    check('via:sub → 交给 agy.runTurn', calls.length === 1 && calls[0].thinkingLevel === 'high' && calls[0].systemPrompt === 's');
    check('没 key 也不报「还没有 API key」', !res.out.join('').includes('API key'));
    check('出口照样是 SSE + done', res.out.join('').includes('"delta":"hi"') && res.out.join('').includes('"done":true'));

    const res2 = fakeRes();
    await app.routes['POST /api/local-gemini']({ body: { messages: [{ role: 'user', content: 'x' }] } }, res2);
    check('不带 via → 还是走 key 那条（没 key 就报 key）', calls.length === 1 && res2.out.join('').includes('API key'));

    const res3 = fakeRes();
    await app.routes['POST /api/local-gemini']({ body: { via: 'sub', webSearch: true, messages: [{ role: 'user', content: 'x' }] } }, res3);
    check('订阅 + 自己联网 → 说一声这条路没有联网', res3.out.join('').includes('自己联网'));

    app.routes['POST /api/agy-prewarm']({ body: { thinkingLevel: 'low' } }, fakeRes());
    check('预热接口按深度挑模型', warms[0] === 'gemini-3.8-flash-low');
  } finally {
    agy.runTurn = origRun; agy.prewarm = origWarm;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }

  // ── 预热进程的工作目录：规则文件在、不在项目里 ─────────────────
  console.log('工作目录');
  check('GEMINI.md 交代了别用工具、按 <system_prompt> 说话', agy.RULES_MD.includes('不要调用任何工具') && agy.RULES_MD.includes('<system_prompt>'));

  console.log(failed ? `\n✗ ${failed} 条失败` : '\n✓ 全部通过');
  process.exit(failed ? 1 : 0);
})();
