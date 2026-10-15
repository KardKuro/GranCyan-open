// 思考链翻译的回归测试。跑法：node tests/think-translate.test.js
//
// 需求：用电脑上的本地小模型把英文思考翻成中文，
// 「翻译的话和原文都要存在就行啦」。这份守的都是静默失效：
//
//   · 原文被译文覆盖 —— 看着一切正常，英文就再也找不回来了，而且回填给模型的历史也跟着变中文
//   · thinkZh 下标和思考块错位 —— 第二段思考显示成第一段的译文，没人会发现
//   · 译文没包糊面 —— 锁着的时候中文版明晃晃露在外面，等于锁形同虚设
//   · 分段翻译丢了段落 / 分隔符 —— 长思考中间少一截
//   · 电脑没开时留下空壳字段、或者不探活就对着死 IP 干等
//   · 三个「回复写完」的地方漏接一处 —— 某类消息（群聊/变体）永远不翻

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');   // 仓库里有 CRLF 也有 LF

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };

function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  if (a < 0 || (to && b < 0)) throw new Error('切片锚点没找到: ' + from);
  return src.slice(a, b);
}

(async () => {
  // 备用模型默认不配；先在没设环境变量的情况下读一次默认值，再设一个测试用的名字重新加载
  const trPath = path.join(ROOT, 'server/think-translate.js');
  const prevFb = process.env.GRANCYAN_TRANSLATE_FALLBACK;
  delete process.env.GRANCYAN_TRANSLATE_FALLBACK;
  const trDefault = require(trPath);
  delete require.cache[require.resolve(trPath)];
  process.env.GRANCYAN_TRANSLATE_FALLBACK = 'fallback-model:test';
  const tr = require(trPath);
  if (prevFb === undefined) delete process.env.GRANCYAN_TRANSLATE_FALLBACK; else process.env.GRANCYAN_TRANSLATE_FALLBACK = prevFb;

  console.log('\n[1] server：分段不丢字');
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(80)).join('\n\n');
  const chunks = tr.splitChunks(long);
  t('长文被切成多段', chunks.length > 1, chunks.length);
  t('拼回去和原文一字不差（段落分隔符也在）', chunks.join('') === long);
  t('每段都不超过上限', chunks.every(c => c.length <= 2400), chunks.map(c => c.length));
  const huge = 'x'.repeat(6000);
  t('单段超长也硬切、不丢', tr.splitChunks(huge).join('') === huge && tr.splitChunks(huge).length === 3);

  console.log('\n[2] server：中文思考不翻');
  t('中文判为中文', tr.mostlyChinese('我在想小明今天是不是累了，要不要先问问他 ok'));
  t('英文不判为中文', !tr.mostlyChinese('She is teasing me again, and honestly I love it.'));
  t('夹一个名字的英文不判为中文', !tr.mostlyChinese('I want to tell 小明 how much I missed the old days, really.'));

  console.log('\n[3] server：请求形状与分段翻译');
  const calls = [];
  const fakeFetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    calls.push({ url, body });
    const user = body.messages.find(m => m.role === 'user').content;
    return { ok: true, json: async () => ({ message: { content: '【译】' + user.slice(0, 12) } }) };
  };
  const two = 'First paragraph here.\n\nSecond paragraph here.';
  const r1 = await tr.translateThinking(two, fakeFetch);
  t('返回 ok 和译文', r1.ok && r1.zh.startsWith('【译】'), r1);
  t('打的是 Ollama /api/chat', calls[0] && /\/api\/chat$/.test(calls[0].url), calls[0]?.url);
  t('关掉 Qwen 自己的思考（think:false）', calls[0]?.body.think === false);
  t('不流式', calls[0]?.body.stream === false);
  t('keep_alive 拉长（默认 5 分钟卸载，下一段要吃冷启动）', /m$|h$/.test(String(calls[0]?.body.keep_alive)) && calls[0].body.keep_alive !== '5m');
  t('系统提示要求不删不软化', /do not omit, soften, censor/.test(calls[0]?.body.messages[0].content));
  calls.length = 0;
  const r2 = await tr.translateThinking(long, fakeFetch);
  t('长文按段数发请求', calls.length === chunks.length, `${calls.length} vs ${chunks.length}`);
  t('段与段之间的空行保住了', (r2.zh.match(/\n\n/g) || []).length === chunks.length - 1, r2.zh);
  calls.length = 0;
  const r3 = await tr.translateThinking('我在想她。我在想她。我在想她。', fakeFetch);
  t('中文思考直接跳过、不打模型', r3.ok && r3.zh === '' && r3.skipped === 'chinese' && calls.length === 0);

  // 需求：「不要把整段中文重译」—— 英文里夹的中文段，以前整块送去翻，被 Qwen 改写成另一种说法
  const ZH_PARA = '小明今天好累，我想先陪他聊聊，什么都不用他说。\n他说「今天什么都不想干」，我就陪着他。';
  const mixed = 'She came back exhausted again, and I want to carry the conversation for her.\n\n'
    + ZH_PARA + '\n\nThen I will tell her about the cat and keep it light, so she only needs to say "嗯".';
  t('混合思考整体不到三成汉字（以前就是整块送翻）', !tr.mostlyChinese(mixed));
  const runs = tr.splitRuns(mixed);
  t('按行切成 英/中/英 三段', JSON.stringify(runs.map(r => r.kind)) === '["en","zh","en"]', runs);
  t('切完拼回去一字不差', runs.map(r => r.text).join('') === mixed);
  calls.length = 0;
  const rm = await tr.translateThinking(mixed, fakeFetch);
  const sent = calls.map(c => c.body.messages[c.body.messages.length - 1].content);
  t('中文段原样留在译文里', rm.ok && rm.zh.includes(ZH_PARA), rm.zh);
  t('中文段根本没送进模型', calls.length === 2 && !sent.some(s => /小明今天好累|什么都不想干/.test(s)), sent);
  t('英文段前后的空行都在', /\n\n小明今天好累/.test(rm.zh) && /我就陪着他。\n\n【译】/.test(rm.zh), rm.zh);
  t('英文句子里夹一两个汉字照样整行翻', tr.splitRuns('I want to tell 小明 how much I missed the old days.')[0].kind === 'en');
  calls.length = 0;
  const onlyMarks = await tr.translateThinking('---\n\n…\n', fakeFetch);
  t('没有英文可翻（只有标点）：不打模型、不出空壳', onlyMarks.zh === '' && calls.length === 0, onlyMarks);
  t('系统提示叫它别改写句子里夹的中文', /already in Chinese stays exactly as written/.test(read('server/think-translate.js')));

  const bad = async () => ({ ok: false, status: 500, text: async () => 'model not found' });
  let threw = false;
  try { await tr.translateThinking('Hello there, thinking.', bad); } catch (e) { threw = /500/.test(e.message); }
  t('Ollama 报错时抛出来（路由回 502，不回假译文）', threw);
  const empty = async () => ({ ok: true, json: async () => ({ message: { content: '  ' } }) });
  threw = false;
  try { await tr.translateThinking('Hello there, thinking.', empty); } catch (e) { threw = true; }
  t('模型回空串算失败（不存一个空译文冒充翻完了）', threw);

  console.log('\n[3b] server：主模型拒翻 → 有备用模型就换它重翻，拒绝绝不当译文');
  // 实际出现过的形态：一整段思考，「译文」却是一句拒绝
  const REFUSAL = '我无法生成此类内容。我可以为您提供其他主题的协助。';
  const sample = 'She is asking about the trip again, the cue that she wants to keep chatting. I want to keep going with her, slow and warm, '
    + 'and pick a song that matches what she is asking for. '.repeat(3);
  t('真样本的拒绝被认出来', tr.looksRefused(sample, REFUSAL));
  t('英文拒绝也认（模型拒的时候常换回英文）', tr.looksRefused(sample, "I'm sorry, but I can't help with translating this content."));
  t('正常译文不算拒绝', !tr.looksRefused(sample, '她又在问旅行的事了，这是她还想接着聊的暗号。我想慢慢陪她聊下去，挑一首合她心意的歌。'));
  t('原文自己在说「我不能写」：如实翻出来不算拒',
    !tr.looksRefused("I can't write that line for her, it would sound fake. I'll say it plainly instead.", '我不能帮她写那句，听起来会很假。我就直说吧。'));
  t('（上面那条的对照：同一句中文配一个没说「不能」的原文，就是拒绝）',
    tr.looksRefused('She keeps asking about 杭州 and I want more.', '我不能帮她写那句，听起来会很假。我就直说吧。'));
  const longZh = '她今天一直在说她的项目。' + '我在想要不要先陪她把这段写完，再去休息。'.repeat(20) + '我不能帮她做这个决定，但我可以陪着她。';
  t('长译文里碰巧有「我不能帮…」不算拒（长度够）', !tr.looksRefused('x'.repeat(800), longZh));
  t('备用模型默认不配（没有内置的默认值）', trDefault.FALLBACK === '', trDefault.FALLBACK);
  t('配了就用配的那个', tr.FALLBACK === 'fallback-model:test' && tr.FALLBACK !== tr.MODEL);
  {
    const seen = [];
    let err = '';
    try {
      await trDefault.translateThinking(sample, async (url, opt) => { seen.push(JSON.parse(opt.body).model); return { ok: true, json: async () => ({ message: { content: REFUSAL } }) }; });
    } catch (e) { err = e.message; }
    t('没配备用模型时拒翻：直接报错，不去碰任何别的模型', /GRANCYAN_TRANSLATE_FALLBACK/.test(err) && seen.length === 1 && seen[0] === trDefault.MODEL, { err, seen });
  }

  const models = [];
  const refuseThenOk = async (url, opt) => {
    const body = JSON.parse(opt.body);
    models.push(body.model);
    const content = body.model === tr.MODEL ? REFUSAL : '她又在问旅行的事了，我想继续。';
    return { ok: true, json: async () => ({ message: { content } }) };
  };
  const rr = await tr.translateThinking(sample, refuseThenOk);
  t('Qwen 拒了：换备用模型重翻，拿到的是真译文', rr.ok && rr.zh === '她又在问旅行的事了，我想继续。' && !/无法生成/.test(rr.zh), rr);
  t('先 Qwen 后备用，各一次', JSON.stringify(models) === JSON.stringify([tr.MODEL, tr.FALLBACK]), models);
  models.length = 0;
  const alwaysRefuse = async (url, opt) => { models.push(JSON.parse(opt.body).model); return { ok: true, json: async () => ({ message: { content: REFUSAL } }) }; };
  threw = false;
  try { await tr.translateThinking(sample, alwaysRefuse); } catch (e) { threw = /拒翻/.test(e.message); }
  t('两个都拒：抛错（路由回 502，前端不写 thinkZh）', threw && models.length === 2, models);
  models.length = 0;
  await tr.translateThinking(two, async (url, opt) => { models.push(JSON.parse(opt.body).model); return { ok: true, json: async () => ({ message: { content: '正常译文' } }) }; });
  t('没拒就不碰备用模型（它冷加载要 30 秒）', models.length === tr.splitChunks(two).length && models.every(m => m === tr.MODEL), models);

  console.log('\n[4] server：一次只翻一段（GPU 只有一块）');
  let inflight = 0, peak = 0;
  const slow = async (url, opt) => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise(r => setTimeout(r, 20));
    inflight--;
    return { ok: true, json: async () => ({ message: { content: '译' } }) };
  };
  await Promise.all([tr.translateThinking('One thought.', slow), tr.translateThinking('Two thought.', slow), tr.translateThinking('Three thought.', slow)]);
  t('三个并发请求实际串行', peak === 1, peak);

  console.log('\n[5] server.js 挂上了路由');
  const server = read('server.js');
  t('server.js 注册 think-translate', /require\('\.\/server\/think-translate'\)\.registerThinkTranslate\(app\)/.test(server));
  t('注册在 express.json 之后（否则 req.body 是空的）',
    server.indexOf("registerThinkTranslate(app)") > server.indexOf("app.use(express.json("));
  const tsrc = read('server/think-translate.js');
  t('有探针 GET /api/think-translate/ping', /app\.get\('\/api\/think-translate\/ping'/.test(tsrc));
  t('有 POST /api/think-translate', /app\.post\('\/api\/think-translate'/.test(tsrc));

  // ── 前端 ──
  const api = read('js/05-prompts-api.js');
  const core = read('js/01-core.js');
  const render = read('js/06-render-msg.js');
  const css = read('css/grancyan.css');

  const box = {
    console, state: {},
    escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    renderRichText: s => '<p>' + s + '</p>', renderStreamingRichText: s => s, memCmdToHtml: s => s,
  };
  vm.createContext(box);
  vm.runInContext(slice(core, 'function thinkVeil(', '\n') + '\n'
    + slice(core, 'const THINK_LOCK =', '\n') + '\n'
    + slice(core, 'const THINK_LANG =', '\n') + '\n'
    + slice(core, 'const THINK_TRANS =', '\n') + '\n'
    + slice(core, 'function _thinkNeedsTrans(', '\n') + '\n'
    + slice(core, 'function _thinkTransReal(', '\n') + '\n'
    + "var CAT_GIF='';\n"
    + slice(api, 'function _thinkOnlyHeadings(', '// 渲染流式中的气泡')
    + '\n' + slice(render, 'function legacyThinkHtml(', '\n}\n') + '\n}'
    + '\nthis.renderBlocksHtml = renderBlocksHtml; this.thinkPairHtml = thinkPairHtml; this.legacyThinkHtml = legacyThinkHtml;', box);

  console.log('\n[6] 渲染：两份都在、都糊着、对得上号');
  const blocks = [
    { type: 'thinking', text: 'first thought' },
    { type: 'text', text: 'hello' },
    { type: 'thinking', text: 'second thought' },
    { type: 'text', text: 'bye' },
  ];
  const html = box.renderBlocksHtml(blocks, false, '', undefined, ['第一段思考', '第二段思考']);
  const thinkBlocks = html.split('<div class="think-block').slice(1);
  t('两个思考块', thinkBlocks.length === 2);
  t('第一块：中文和英文原文都在', /第一段思考/.test(thinkBlocks[0]) && /first thought/.test(thinkBlocks[0]));
  t('第二块对上第二段译文（下标没错位）', /第二段思考/.test(thinkBlocks[1]) && /second thought/.test(thinkBlocks[1]) && !/第一段/.test(thinkBlocks[1]));
  t('中文包在 think-zh、英文包在 think-en',
    /<span class="think-zh"><span class="think-veil">第一段思考<\/span><\/span>/.test(thinkBlocks[0])
    && /<span class="think-en"><span class="think-veil">first thought<\/span><\/span>/.test(thinkBlocks[0]), thinkBlocks[0]);
  t('标题上有中/英切换钮', /class="think-lang"/.test(thinkBlocks[0]));
  t('思考正文里没有多出 div（TTS 按 </div></div> 剥块）', !/<div class="think-(zh|en)"/.test(html));
  const plain = box.renderBlocksHtml(blocks, false, '', undefined, undefined);
  t('没译文时没有切换钮、没有双份', !/think-lang|think-zh|think-en/.test(plain));
  t('没译文的英文思考每块都挂「译」', (plain.match(/class="think-trans"/g) || []).length === 2, plain);
  t('有译文的块不挂「译」', !/think-trans/.test(html));
  const cnPlain = box.renderBlocksHtml([{ type: 'thinking', text: '我在想小明今天是不是累了 ok' }], false, '', undefined, undefined);
  t('中文思考不挂「译」', !/think-trans/.test(cnPlain));
  const midStream = box.renderBlocksHtml([{ type: 'thinking', text: 'done one' }, { type: 'text', text: 'x' }, { type: 'thinking', text: 'going' }], true, '', undefined, undefined);
  t('流式途中哪块都不挂「译」（点了会翻半截）', !/think-trans/.test(midStream), midStream);
  const partial = box.renderBlocksHtml(blocks, false, '', undefined, ['', '只有第二段']);
  const pb = partial.split('<div class="think-block').slice(1);
  t('某段没译成（空串）就只显示原文', !/think-lang/.test(pb[0]) && /think-lang/.test(pb[1]));
  const live = box.renderBlocksHtml([{ type: 'thinking', text: 'still thinking' }], true, '', undefined, ['正在想']);
  t('流式中的思考块不出译文（还没翻）', !/正在想|think-lang/.test(live));
  const refusedHtml = box.renderBlocksHtml([{ type: 'thinking', text: sample }], false, '', undefined, [REFUSAL]);
  t('存着的「译文」是拒绝：不显示它，退回原文', !/无法生成/.test(refusedHtml) && !/think-lang/.test(refusedHtml) && refusedHtml.includes('She is asking about the trip'), refusedHtml.slice(0, 300));
  t('…并且挂上「译」让她重翻', /class="think-trans"/.test(refusedHtml));
  const legacyRefused = box.legacyThinkHtml(sample, false, '', [REFUSAL]);
  t('legacy 路径同样不显示拒绝、挂「译」', !/无法生成/.test(legacyRefused) && /class="think-trans"/.test(legacyRefused), legacyRefused.slice(0, 300));
  const pairs = [[sample, REFUSAL], [sample, "I'm sorry, but I can't help with translating this content."], [sample, '她又在问旅行的事了。'],
    ["I can't write that line for her.", '我不能帮她写那句。'], ['x'.repeat(800), longZh], ['short', '抱歉，我不能翻译这个。']];
  const mismatch = pairs.filter(([s, z]) => box._thinkTransReal(s, z) !== !tr.looksRefused(s, z));
  t('前端 _thinkTransReal 和 server looksRefused 判得一样', mismatch.length === 0, mismatch);
  t('legacy 路径正常译文照常显示',/think-lang/.test(box.legacyThinkHtml('old thought', false, '', ['旧的想法'])));

  console.log('\n[7] 翻译触发：原文不动、译文另存、翻不了什么都不写');
  const tbox = {
    console, SERVER_BASE: 'http://pc', AbortController, setTimeout, clearTimeout, Date,
    saved: 0, rendered: 0, fetchLog: [],
    save() { tbox.saved++; }, _invalidateNodeCache() { }, renderMessages() { tbox.rendered++; },
  };
  vm.createContext(tbox);
  vm.runInContext(slice(core, 'function _thinkTransReal(', '\n') + '\n'
    + slice(api, 'let _thinkTransOk = null', 'async function summarizeMemContent(')
    + '\nthis.translateThinkingFor = translateThinkingFor; this.thinkTransTap = thinkTransTap; this.reset = () => { _thinkTransOk = null; };', tbox);
  tbox.fetch = async (url, opt) => {
    tbox.fetchLog.push(url);
    if (url.endsWith('/ping')) return { ok: true, json: async () => ({ ok: true }) };
    const text = JSON.parse(opt.body).text;
    return { ok: true, json: async () => ({ ok: true, zh: '译:' + text }) };
  };
  const node = {
    content: 'hello',
    blocks: [{ type: 'thinking', text: 'A' }, { type: 'text', text: 'x' }, { type: 'thinking', text: '' }, { type: 'thinking', text: 'C' }],
  };
  const before = JSON.stringify(node.blocks);
  await tbox.translateThinkingFor(node, 1);
  t('thinkZh 按思考块下标对齐（空块占位）', JSON.stringify(node.thinkZh) === JSON.stringify(['译:A', '', '译:C']), node.thinkZh);
  t('原文 blocks 一个字没动', JSON.stringify(node.blocks) === before);
  t('写完落盘并重渲染', tbox.saved === 1 && tbox.rendered === 1);
  t('空思考块不发请求', tbox.fetchLog.filter(u => u.endsWith('/api/think-translate')).length === 2, tbox.fetchLog);

  const legacy = { reasoning: 'old style thought' };
  await tbox.translateThinkingFor(legacy, 2);
  t('legacy（只有 m.reasoning）也翻，存在 [0]', legacy.thinkZh?.[0] === '译:old style thought' && legacy.reasoning === 'old style thought');

  tbox.reset(); tbox.fetchLog.length = 0; tbox.saved = 0;
  tbox.fetch = async (url) => { tbox.fetchLog.push(url); throw new Error('ECONNREFUSED'); };
  const off = { blocks: [{ type: 'thinking', text: 'A' }] };
  await tbox.translateThinkingFor(off, 3);
  t('电脑连不上：不写 thinkZh、不落盘', !('thinkZh' in off) && tbox.saved === 0);
  t('连不上时只打了探针，没发翻译请求', tbox.fetchLog.length === 1 && tbox.fetchLog[0].endsWith('/ping'), tbox.fetchLog);
  await tbox.translateThinkingFor({ blocks: [{ type: 'thinking', text: 'B' }] }, 4);
  t('探针结果缓存：一分钟内不再去撞死地址', tbox.fetchLog.length === 1, tbox.fetchLog);

  tbox.reset(); tbox.saved = 0;
  tbox.fetch = async (url) => url.endsWith('/ping')
    ? { ok: true, json: async () => ({ ok: true }) }
    : { ok: true, json: async () => ({ ok: true, zh: '', skipped: 'chinese' }) };
  const cn = { blocks: [{ type: 'thinking', text: '中文思考' }] };
  await tbox.translateThinkingFor(cn, 5);
  t('全是中文思考（server 跳过）：不留空壳字段', !('thinkZh' in cn) && tbox.saved === 0);
  t('探针有 2 秒超时（同书架，死 IP 不干等）', /_thinkTransUsable[\s\S]{0,400}setTimeout\(\(\) => ctrl\.abort\(\), 2000\)/.test(api));

  console.log('\n[7b] 手动「译」：重探、只补空段、回状态');
  tbox.reset(); tbox.fetchLog.length = 0;
  tbox.fetch = async (url) => { tbox.fetchLog.push(url); throw new Error('ECONNREFUSED'); };
  const man = { blocks: [{ type: 'thinking', text: 'A' }, { type: 'thinking', text: 'B' }] };
  t('电脑没开：返回 offline', await tbox.translateThinkingFor(man, 6, true) === 'offline');
  tbox.fetch = async (url, opt) => {
    tbox.fetchLog.push(url);
    if (url.endsWith('/ping')) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ ok: true, zh: '译:' + JSON.parse(opt.body).text }) };
  };
  t('自动路径此时还吃着「连不上」缓存', await tbox.translateThinkingFor(man, 6) === 'offline');
  tbox.fetchLog.length = 0;
  t('手动点：缓存作废重探，翻成返回 ok', await tbox.translateThinkingFor(man, 6, true) === 'ok' && man.thinkZh?.[1] === '译:B', man.thinkZh);
  const half = { blocks: [{ type: 'thinking', text: 'A' }, { type: 'thinking', text: 'B' }], thinkZh: ['旧译A', ''] };
  tbox.fetchLog.length = 0;
  await tbox.translateThinkingFor(half, 7, true);
  t('已有译文不重翻、只补空段', JSON.stringify(half.thinkZh) === JSON.stringify(['旧译A', '译:B'])
    && tbox.fetchLog.filter(u => u.endsWith('/api/think-translate')).length === 1, [half.thinkZh, tbox.fetchLog]);
  tbox.fetch = async (url) => url.endsWith('/ping') ? { ok: true, json: async () => ({ ok: true }) } : { ok: true, json: async () => ({ ok: false, error: 'boom' }) };
  const nope = { blocks: [{ type: 'thinking', text: 'A' }] };
  t('Ollama 报错：返回 fail、不留字段', await tbox.translateThinkingFor(nope, 8, true) === 'fail' && !('thinkZh' in nope));
  tbox.fetchLog.length = 0;
  tbox.fetch = async (url, opt) => {
    tbox.fetchLog.push(url);
    if (url.endsWith('/ping')) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ ok: true, zh: '真译文' }) };
  };
  const stale = { blocks: [{ type: 'thinking', text: sample }, { type: 'thinking', text: 'B' }], thinkZh: [REFUSAL, '旧译B'] };
  const st = await tbox.translateThinkingFor(stale, 9, true);
  t('修之前存下的拒绝：点「译」会重翻那段、换成真译文', st === 'ok' && JSON.stringify(stale.thinkZh) === JSON.stringify(['真译文', '旧译B'])
    && tbox.fetchLog.filter(u => u.endsWith('/api/think-translate')).length === 1, [st, stale.thinkZh, tbox.fetchLog]);

  console.log('\n[7c] 「译」按钮找得到自己是哪条消息');
  const hits = [];
  tbox.translateThinkingFor = async (tg, id, manual) => { hits.push([tg, id, manual]); return 'fail'; };
  const nodeX = { blocks: [], variants: [{ n: 'v0' }, { n: 'v1' }] };
  tbox.getActiveChat = () => ({ nodes: { 42: nodeX } });
  const mkBtn = (variantId) => {
    const cls = new Set();
    return { title: '', classList: { add: c => cls.add(c), remove: c => cls.delete(c), has: c => cls.has(c) },
      closest: sel => sel === '[data-node-id]' ? { getAttribute: () => '42' } : (variantId ? { id: variantId } : null) };
  };
  const ev = b => ({ currentTarget: b, stopPropagation() { this.stopped = true; }, preventDefault() { } });
  const b1 = mkBtn(null), e1 = ev(b1);
  await tbox.thinkTransTap(e1);
  t('普通消息：翻的是节点本身、带 manual', hits[0]?.[0] === nodeX && hits[0][1] === 42 && hits[0][2] === true, hits[0]);
  t('点按钮不收起思考块（stopPropagation）', e1.stopped === true);
  t('没翻成：按钮标 fail', b1.classList.has('fail') && !b1.classList.has('busy'));
  await tbox.thinkTransTap(ev(mkBtn('variant-42-1')));
  t('多模型并排：翻的是对应那个变体', hits[1]?.[0] === nodeX.variants[1], hits[1]);

  console.log('\n[8] 接线：三处「回复写完」都送去翻译');
  t('单聊主路径', /chat\.nodes\[aiId\]\.thinkingSummary = summary;[\s\S]{0,120}\}\);\s*translateThinkingFor\(chat\.nodes\[aiId\], aiId\);/.test(api));
  t('变体（重新生成）', /variant\.thinkingSummary = summary;[\s\S]{0,120}\}\);\s*translateThinkingFor\(variant, nodeId\);/.test(api));
  t('群聊', /translateThinkingFor\(chat\.nodes\[_aiId\], _aiId\)/.test(render));
  t('四个渲染点都把 thinkZh 传下去',
    /renderBlocksHtml\(m\.blocks, streaming, m\.thinkingSummary, m\.memSummaries, m\.thinkZh\)/.test(render)
    && /legacyThinkHtml\(reasoning, streaming, m\.thinkingSummary, m\.thinkZh\)/.test(render)
    && /renderBlocksHtml\(v\.blocks, v\.streaming, v\.thinkingSummary, v\.memSummaries, v\.thinkZh\)/.test(render)
    && /renderBlocksHtml\(th, false, m\.thinkingSummary, undefined, m\.thinkZh\)/.test(render));
  t('语音气泡按类型筛思考块（按有没有字筛会让下标错位）', /const th = m\.blocks\.filter\(b => b\.type === 'thinking'\);/.test(render));

  console.log('\n[9] 译文只给眼睛看，不喂回模型');
  const all = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))
    .map(f => [f, read('js/' + f)]);
  // 去掉注释再数：01-core.js 的注释里提到了这个字段名，那不算「碰」
  const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const users = all.filter(([, s]) => /thinkZh/.test(code(s))).map(([f]) => f).sort();
  t('只有渲染和翻译两个文件碰 thinkZh', JSON.stringify(users) === JSON.stringify(['05-prompts-api.js', '06-render-msg.js']), users);
  const buildFn = slice(api, 'function buildApiMessages', '\nfunction ');
  t('buildApiMessages 里没有 thinkZh', buildFn.length > 100 && !/thinkZh/.test(buildFn));

  console.log('\n[10] 切换钮：默认中文、切了记住、不重渲染');
  t('CSS 默认藏英文', /\n\.think-en \{ display:none; \}/.test(css));
  t('think-lang-en 时藏中文、显英文', /body\.think-lang-en \.think-en \{ display:block; \}/.test(css) && /body\.think-lang-en \.think-zh \{ display:none; \}/.test(css));
  t('钮上的字跟着换', /\.think-lang::before \{ content:'中'; \}/.test(css) && /body\.think-lang-en \.think-lang::before \{ content:'EN'; \}/.test(css));
  t('点钮不会顺带把思考块收起来（stopPropagation）', /function thinkLangTap\(ev\) \{\s*if \(ev\) \{ ev\.stopPropagation\(\);/.test(core));
  t('localStorage 读写都包了 try', (slice(core, 'function applyThinkLang', 'function thinkLangTap').match(/try \{/g) || []).length === 1
    && (slice(core, 'function thinkLangTap', '\n    }\n').match(/try \{/g) || []).length === 1);
  t('启动时挂上类', /applyThinkLang\(\)/.test(read('js/14-boot-brain-hub.js')));

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
