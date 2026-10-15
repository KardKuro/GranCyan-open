// Gemini 直连（server/gemini.js + 前端那条分支）的回归测试。
//
// 这条路的特点是**错了很安静**：模型照样回话，只是回错了地方 ——
// 思考被当成正文发出去、图片静默丢掉、预算被思考吃光而报成「模型坏了」。
// 所以下面每一条测的都是「行为」，不是「源码里有没有这行字」：
// 断言写成正则去 grep 源码的话，改个变量名就绿、逻辑反了也绿。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const gem = require(path.join(root, 'server', 'gemini.js'));

let failed = 0;
function check(name, yes) {
  console.log(`  ${yes ? '✓' : '✗'} ${name}`);
  if (!yes) failed++;
}

// 把一串事件喂给 parser，收集它吐出来的东西。
// chunks 故意允许在任意位置切断 —— 真实的 SSE 就是这么到的。
function runParser(chunks, opts = {}) {
  const events = [];
  const saved = [];
  const p = gem.createStreamParser({
    model: opts.model || 'gemini-3.6-flash',
    webSearch: !!opts.webSearch,
    emit: e => events.push(e),
    saveImage: (mime, b64) => {
      if (opts.saveThrows) throw new Error('磁盘满了');
      saved.push({ mime, b64 });
      return 'fake-id.png';
    },
  });
  for (const c of chunks) p.feed(c);
  return { events, saved, state: p.state() };
}
const sse = obj => `data: ${JSON.stringify(obj)}\n\n`;
const part = (parts, extra = {}) => ({ candidates: [{ content: { parts }, ...extra }] });

// ── buildContents：整形对不对 ──────────────────────────────────
{
  const c = gem.buildContents([
    { role: 'system', content: '系统提示不该进 contents' },
    { role: 'assistant', content: '历史被裁剪后剩下的开头' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '第一句' },
    { role: 'assistant', content: '第二句' },
    { role: 'user', content: '' },
  ]);
  check('system 消息不进 contents', !JSON.stringify(c).includes('系统提示不该进'));
  check('开头的 model 消息被丢掉（否则 Gemini 400）', c[0] && c[0].role === 'user');
  check('相邻同角色合并成一段', c.length === 2 && c[1].role === 'model' && c[1].parts.length === 2);
  check('空消息不产生空 parts', !c.some(x => !x.parts.length));

  const withImg = gem.buildContents([
    { role: 'user', content: '看图', images: ['data:image/png;base64,AAAA', '不是 data url'] },
  ]);
  const ps = withImg[0].parts;
  check('图片转成 inline_data 并带上 mime', ps.some(x => x.inline_data
    && x.inline_data.mime_type === 'image/png' && x.inline_data.data === 'AAAA'));
  check('认不出来的图安静跳过而不是塞个坏 part', ps.length === 2);
}

// ── buildThinkingConfig：合法值不能漏 ────────────────────────────
{
  // 这一条守的是一个真实的 400：thinking_level 只认 minimal/low/medium/high，
  // 传 'none'/'off'/'auto' 都是硬报错。任何时候**都不允许**把外面来的字符串
  // 原样塞进 thinkingLevel —— 所以反着断言：枚举一批非法输入，逐个确认没漏进去。
  for (const bad of ['none', 'off', 'auto', '', undefined, 'HIGH', 'bogus', 'medium ']) {
    const cfg = gem.buildThinkingConfig(bad);
    const lvl = cfg.thinkingLevel;
    check(`非法/空深度 ${JSON.stringify(bad)} 不会漏进 thinkingLevel`,
      lvl === undefined || gem.THINK_LEVELS.includes(lvl));
  }
  // 「不想」**不传 level**。minimal 在枚举里合法，但 gemini-3.8-flash 实测回
  // 400「Thinking level MINIMAL is not supported for this model」（2026-09-21
  // 打包后端到端逮到的）。硬传 = 给她一个必 400 的下拉选项，而且报错像功能坏了。
  // ⚠️ 单元测试碰不出这个：它只验我发了什么，验不了 Google 认不认。
  for (const off of ['off', 'minimal']) {
    const c = gem.buildThinkingConfig(off);
    check(`深度选「${off}」时只关思考链显示，不硬传 level（有模型不认 minimal）`,
      c.includeThoughts === false && c.thinkingLevel === undefined);
  }
  for (const lv of ['low', 'medium', 'high']) {
    const c = gem.buildThinkingConfig(lv);
    check(`深度 ${lv} 原样传下去且要思考链`, c.thinkingLevel === lv && c.includeThoughts === true);
  }
  check('没选深度时不传 level 但仍要思考链（否则思考是空的）', (() => {
    const c = gem.buildThinkingConfig('');
    return c.thinkingLevel === undefined && c.includeThoughts === true;
  })());
}

// ── createStreamParser：思考和正文不能串 ────────────────────────
{
  const { events, state } = runParser([
    sse(part([{ text: '我先想想', thought: true }])),
    sse(part([{ text: '天是蓝的' }])),
    sse(part([{ text: '，因为散射' }], { finishReason: 'STOP' })),
  ]);
  const deltas = events.filter(e => e.delta).map(e => e.delta).join('');
  const thinks = events.filter(e => e.thinking).map(e => e.thinking).join('');
  check('thought part 进思考链', thinks === '我先想想');
  check('普通 part 进正文', deltas === '天是蓝的，因为散射');
  // 这条是整个文件里最重要的一条：看反了不会报错，只会把模型的内心独白当回复发给她。
  check('模型的内心独白绝不会混进正文', !deltas.includes('我先想想'));
  check('有正文时 sawText 为真', state.sawText === true);
  check('STOP 不产生 notice', !events.some(e => e.notice));
}

// ── 跨 chunk 切断的行要能拼回来 ─────────────────────────────────
{
  const whole = sse(part([{ text: '一二三四五' }]));
  const cut = Math.floor(whole.length / 2);
  const { events } = runParser([whole.slice(0, cut), whole.slice(cut)]);
  check('一行被切成两个 chunk 仍能正确解析', events.some(e => e.delta === '一二三四五'));
  // 半行还没收完时绝不能先吐一个残缺的事件出去
  const { events: partial } = runParser([whole.slice(0, cut)]);
  check('只收到半行时不吐任何事件', partial.length === 0);
}

// ── 空正文：要能说清是「预算被吃光」还是别的 ─────────────────────
{
  // 实测过的真实形状：思考占满 maxOutputTokens，正文一个字都没排上，finishReason=MAX_TOKENS。
  const { events, state } = runParser([
    sse(part([{ text: '长长的思考…', thought: true }], { finishReason: 'MAX_TOKENS' })),
  ]);
  check('只有思考没有正文时 sawText 为假', state.sawText === false);
  check('MAX_TOKENS 被记下来（末尾要靠它说人话）', state.lastFinish === 'MAX_TOKENS');
  check('MAX_TOKENS 本身不当成异常 notice', !events.some(e => e.notice));

  const safety = runParser([sse(part([], { finishReason: 'SAFETY' }))]);
  check('SAFETY 这类掐断会明确说出来', safety.events.some(e => e.notice && e.notice.includes('SAFETY')));
}

// ── 出图 ────────────────────────────────────────────────────────
{
  const { events, saved, state } = runParser([
    sse(part([{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }])),
  ]);
  check('inlineData 落盘并发文件名（不是把 base64 塞进历史）',
    saved.length === 1 && saved[0].b64 === 'QUJD'
    && events.some(e => Array.isArray(e.geminiImages) && e.geminiImages[0] === 'fake-id.png'));
  check('出图也算有产出', state.sawText === true);
  check('事件里不含 base64 原文', !JSON.stringify(events).includes('QUJD'));

  // 蛇形的 inline_data 也要认：REST 文档两种拼写都出现过，只认一种就会静默丢图
  const snake = runParser([sse(part([{ inline_data: { mime_type: 'image/png', data: 'WFla' } }]))]);
  check('snake_case 的 inline_data 同样认得', snake.saved.length === 1);

  const broken = runParser([sse(part([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]))], { saveThrows: true });
  check('存不下来时说一声而不是安静吞掉',
    broken.events.some(e => e.notice && e.notice.includes('存不下来')));
}

// ── 流中途插进来的错误 ──────────────────────────────────────────
{
  const { events } = runParser([
    sse(part([{ text: '开了个头' }])),
    sse({ error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } }),
  ]);
  check('流开始之后的报错也认（否则是半句话 + 一个正常的 done）',
    events.some(e => e.error && e.error.includes('503')));
}

// ── explainError：三种 429 要分流到三句不同的话 ──────────────────
{
  const q = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } });
  const chat = gem.explainError(429, q, 'gemini-3.6-flash', false);
  const image = gem.explainError(429, q, 'gemini-3.1-flash-image', false);
  const search = gem.explainError(429, q, 'gemini-3.6-flash', true);
  check('三种 429 给的是三句不同的话',
    new Set([chat, image, search]).size === 3);
  check('出图的 429 不会把人指去「换 Flash」（它本来就是 flash-image）',
    !image.includes('换成 Flash'));
  check('联网的 429 指向那个开关而不是模型', search.includes('自己联网') || search.includes('google_search'));

  const region = gem.explainError(400,
    JSON.stringify({ error: { message: 'User location is not supported for the API use.' } }), 'x', false);
  check('地区被拒会直说「换节点」而不是报成 key 坏了',
    region.includes('节点') && !region.toLowerCase().includes('api key'));

  const gone = gem.explainError(404,
    JSON.stringify({ error: { message: 'This model models/gemini-2.5-flash is no longer available to new users.' } }),
    'gemini-2.5-flash', false);
  check('下架模型的 404 点名是哪个模型', gone.includes('gemini-2.5-flash'));
}

// ── 前后端的耦合点 ──────────────────────────────────────────────
// 服务端发什么事件名、前端认什么事件名，是两个文件里各写一次的同一个约定。
// 改了一边忘了另一边 → 图片静默消失，没有任何报错。
{
  const front = fs.readFileSync(path.join(root, 'js', '05-prompts-api.js'), 'utf8');
  check('前端认得出图事件 geminiImages', front.includes('j.geminiImages'));
  check('前端会把 Gemini 走到 /api/local-gemini', front.includes('/api/local-gemini'));
  check('前端把 Gemini 一起放进那条流式分支', /conf\.isLocalClaude \|\| conf\.isLocalGpt \|\| conf\.isGemini/.test(front));

  const bar = fs.readFileSync(path.join(root, 'js', '03-chats-models.js'), 'utf8');
  // 下拉里列出来的每一个深度值，都必须是服务端认得的 —— 列一个 'none' 上去就是一个必 400 的选项
  // 只看 Gemini 那个下拉的那一段：两个下拉的标签前缀是一样的（🧠 深度：），
  // 整文件抓会把本地 GPT 的 none/xhigh/max 一起捞进来，断言就永远是红的。
  const gSeg = bar.slice(bar.indexOf('setGeminiThinking(this.value)'));
  const gBlock = gSeg.slice(0, gSeg.indexOf('].map'));
  const vals = (gBlock.match(/\['([a-z]*)', '🧠[^']*'\]/g) || [])
    .map(x => x.match(/\['([a-z]*)'/)[1]).filter(Boolean);
  check('Gemini 深度下拉里没有服务端不认的值',
    vals.length > 0 && vals.every(v => gem.THINK_LEVELS.includes(v)));

  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  check('server.js 真的挂上了这个模块', server.includes("require('./server/gemini')"));
  // Codex 的 effort 是拼进命令行的，传错值它 exit 0 + 空日志（静默不生效）。
  // 所以 UI 里能选的每一个值，都必须落在 server 的白名单里。
  const gptVals = (bar.match(/\['(none|minimal|low|medium|high|xhigh|max|ultra)', '🧠 深度：[^']*'\]/g) || [])
    .map(x => x.match(/\['([a-z]*)'/)[1]);
  const allow = (server.match(/const GPT_EFFORTS = \[([^\]]*)\]/) || [, ''])[1];
  check('本地 GPT 深度下拉里的值 server 全都认',
    gptVals.length >= 5 && gptVals.every(v => allow.includes(`'${v}'`)));
}

if (failed) process.exitCode = 1;
else console.log('  —— Gemini 全部通过');
