// 富文本渲染的两类静默故障，都只能靠肉眼发现（零报错、断言不覆盖就会悄悄回归）：
//   1. 塞进正文的块级产物没用空行包裹 → marked 把紧跟的正文当 HTML 吞掉，**加粗** 露星号
//   2. AI 用中文输入法打出全角冒号 [[TAG：]] → 每条正则都匹配不上，标签原样露成一行文字
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const api = read('js/05-prompts-api.js');
const media = read('js/12-math-media.js');
const music = read('js/24-music.js');
const memory = read('js/04-memory.js');

// CommonMark：行首 <div> 开启 HTML block，一路吞到空行为止。单个 \n 不够，必须 \n\n。
//
// 判据取反面，不逐个枚举已知的块——枚举必漏，点歌那个「找歌中」占位符就是这么漏掉的
// （枚举版测试当时还是全绿的）。改成扫描每个「标签 → HTML」转换器的函数体，
// 禁止任何裸返回的 <div> 模板；将来新加标签漏了包裹，这条会直接判红。
test('标签转换器里不存在没有空行包裹的块级产物', () => {
  const bodyOf = (src, name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `源码里找不到 ${name}`);
    const rest = src.slice(i);
    // 到下一个顶层函数为止。必须认得 `async function`——只找 `\nfunction ` 会跨过它，
    // 把后面整片 UI 代码圈进来，判成一堆假阳性。
    const re = /\n(?:async )?function /g;
    re.lastIndex = 1;
    const m = re.exec(rest);
    return m ? rest.slice(0, m.index) : rest;
  };
  for (const [name, src] of [
    ['stickerTagToHtml', media], ['memCmdToHtml', api],
    ['musicTagToHtml', music], ['processAiCommands', memory],
  ]) {
    const naked = [...bodyOf(src, name).matchAll(/`<div\b/g)];
    assert.equal(naked.length, 0,
      `${name} 里有 ${naked.length} 处裸 <div> 模板，必须写成 \`\\n\\n<div…\\n\\n\``);
  }
});

// div 由函数调用拼进来时上面扫不到，这两处单独钉住
test('点歌卡片的三个插入点都用空行包裹', () => {
  assert.equal((music.match(/'\\n\\n' \+ musicCardHtml/g) || []).length, 2);
  assert.doesNotMatch(music, /(?<!\\n)'\\n' \+ musicCardHtml/);
  assert.match(media, /const html = `\\n\\n<div class="msg-img-wrap"/);
});

test('全角冒号的标签在渲染和回填两条路上都被掰回半角', () => {
  const norm = memory.match(/function normalizeStickerTags\([\s\S]*?\n\}/)[0];
  // 渲染路和指令处理路共用 normalizeStickerTags
  assert.match(norm, /replace\(\/\\\[\\\[\(\[A-Z0-9_\]\+\)\\s\*：\/g, '\[\[\$1:'\)/);
  // 反面判据：原来开头那句 indexOf('表情') 早退会把不含「表情」二字的 [[QUOTE：]] 直接放走，
  // 所以归一化必须排在早退之前——顺序反了这个 bug 就原封不动回来了。
  assert.ok(norm.indexOf('：') < norm.indexOf("indexOf('表情')"),
    '全角归一化必须排在 indexOf(\'表情\') 早退之前');
  // 回填给 API 的路：历史就是教材，这里漏掉模型下一轮会照着继续写全角
  assert.match(api, /function stickerTagForApi\([\s\S]{0,400}replace\(\/\\\[\\\[\(\[A-Z0-9_\]\+\)\\s\*：\/g, '\[\[\$1:'\)/);
});

// ── 记忆块的概括贴在谁头上 ──────────────────────────────────
// 用户截图逮到：DeepSeek 概括出来的标题和块里的正文**对不上**，
// 「💾 存储记忆：喜欢的颜色」底下写的却是别的事 —— 标题和正文连错了线。
//
// 根因是两个序列不是同一个序列：
//   · 概括按**文档顺序**算（triggerMemSummaries 一个正则扫全文）；
//   · 块按**语句书写顺序**取下标（memCmdToHtml 先把全文 MEM_ADD 贴完，再 BRAIN_ADD…）。
//   · 而且 pill() 还被 VITALS / HEARTBEAT / DIARY / END_CHAT / CHATS 调用，
//     这些压根没被概括，却照样吃掉一个下标，把后面全顶偏。
//
// ⚠️ 这条**必须跑真函数**。写成「源码里有没有 memSummaries[c]」是廉价断言：
//   把查表键改错照样绿，而症状是零报错的错位 —— 正是最难被发现的那种。
test('每个记忆块贴的是它自己的概括（不是隔壁那条的）', () => {
  const vm = require('node:vm');
  // 源码是 CRLF，收尾要写 \r?\n 才认得出来
  const fnSrc = api.match(/function memCmdToHtml\(html, memSummaries\)\s*\{[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(fnSrc, '抠不到 memCmdToHtml，这条测试作废');
  const escSrc = read('js/09-appearance-input.js').match(/function escHtml\(str\)\s*\{[\s\S]*?\r?\n\}/)[0];
  const sb = { console, String, Array, Object, JSON, RegExp, Number };
  vm.createContext(sb);
  vm.runInContext(escSrc + '\n' + fnSrc[0], sb);

  // 跟她截图同形状：两条高级记忆 + 一条普通记忆，中间夹一个**不被概括**的 VITALS。
  // 夹这一条是关键 —— 下标制下它会白吃一个位置，把后面全顶偏。
  const raw = [
    '[[BRAIN_ADD: 7|0.6|0.5|情感|色号清单最深处灰紫]]',
    '[[BRAIN_ADD: 6|0.3|0.4|情感|虫子学新增设定标记液]]',
    '[[VITALS: 心率88 体温37.1]]',
    '[[MEM_ADD: 小明最近在学画水彩]]',
  ].join('\n\n');

  const OPS = ['MEM_ADD', 'MEM_DEL', 'RECENT_MEM_ADD', 'RECENT_MEM_DEL', 'SELF_MEM_SET',
               'BRAIN_ADD', 'BRAIN_PIN', 'BRAIN_RESOLVE', 'BRAIN_DEL'];
  const ops = [];
  raw.replace(/\[\[([A-Z_]+):\s*([^\]]+?)\s*\]\]/g, (_, t, c) => { if (OPS.includes(t)) ops.push(c.trim()); return ''; });
  assert.equal(ops.length, 3, 'VITALS 不该进概括名单');
  // 概括用「正文头 6 个字」冒充，贴错了一眼看得出来
  const tag = s => 'SUM{' + s.slice(0, 6) + '}';   // ⚠️ 别用尖括号：label 正则是 [^<]*，会被截断
  const map = {};
  const put = (k, v) => { const s = String(k || '').trim(); if (s && v && !map[s]) map[s] = v; };
  ops.forEach(c => { const body = c.split('|').pop(); put(c, tag(body)); put(c.split('|').slice(4).join('|'), tag(body)); });

  const out = sb.memCmdToHtml(raw, map);
  const blocks = [...out.matchAll(/<span class="think-label">([^<]*)<\/span><\/div><div class="think-body">([\s\S]*?)<\/div>/g)];
  assert.equal(blocks.length, 4, '四个块都该渲染出来');

  const wrong = [];
  let withSum = 0;
  for (const [, label, body] of blocks) {
    const i = label.indexOf('：');             // 概括自己可能含全角冒号，只切第一个
    const sum = i < 0 ? '' : label.slice(i + 1).trim();
    if (!sum) continue;
    withSum++;
    if (sum !== tag(body)) wrong.push(`[${label}] 底下是「${body.slice(0, 12)}…」`);
  }
  // ⚠️⚠️ 这条断言是上一条的**命根子**。少了它，一个「一个概括都不贴」的实现
  //   照样能让「没有贴错」成立 —— 2026-08-24 我就是这么写出一条假绿的：
  //   拿修复前的源码跑，4 条全过，因为老代码把 map 当数组索引、查不到、干脆什么都不贴。
  //   「没贴错」和「贴对了」是两回事，必须两条一起钉。
  assert.equal(withSum, 3, '三条记忆命令都该拿到自己的概括（VITALS 不算）');
  assert.deepEqual(wrong, [], '有块贴了别人的概括');

  // 反面判据：没被概括的块**不许**顶走别人的标签（VITALS 这里必须是光标签）
  const vitals = blocks.find(b => b[1].includes('生命体征'));
  assert.ok(vitals && !vitals[1].includes('：'), 'VITALS 没被概括过，不该带概括');

  // 老消息存的是数组（下标制）。那些是**已经发生的历史**，保持原样显示，
  // 别为了让它「看起来对」而把她的标签整段抹掉。
  const legacy = sb.memCmdToHtml(raw, ops.map(c => tag(c.split('|').pop())));
  assert.match(legacy, /：SUM{/, '老数组格式的消息仍要显示概括');
});
