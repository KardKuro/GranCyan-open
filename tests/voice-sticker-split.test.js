'use strict';
// AI 语音里的表情包：单独站在语音条下面，不埋在「看文字」展开的正文里。
//
// 用户的口径：「语音（文字）/ 表情包（单独在语音条下面而不是展开下面）/
// 语音（文字），如果中间有卡片间隔，就让语音拆成好几个」。
//
// 拆是在**合成那一刻**拆的（_synthVoiceParts，一段文字跑一次 Edge-TTS），
// 不是在渲染好的 HTML 上切 —— 语音气泡里是播放器不是文本，切下去会把播放器劈成两半，
// 而且共用一份音频的话，第二个语音条点下去还是从头把整条重放一遍，等于没拆。
//
// 这份测试跑的是**真函数**（vm 里加载 js/10-stickers-voice.js），不是源码正则：
// 源码正则会被「注释里写着同样的字符串」和「别处有一模一样的代码」骗过去。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

// ── 把 10-stickers-voice.js 整个跑起来 ────────────────────────────────
// 它顶层只碰 document（几个 addEventListener 和两个 IIFE），给个惰性桩就够。
// 表情标签→图片和 marked 渲染是别的文件的事，这里替成形状一致的假的：
// 断言看的是「表情有没有自己成一个气泡」「展开正文里还有没有表情」，不是图片长什么样。
const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub, set: () => true });
const ctx = {
  console,
  document: {
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById() { return null; }, body: stub, createElement() { return stub; },
  },
  window: { addEventListener() {} },
  navigator: { mediaDevices: {} },
  escHtml: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  stickerTagToHtml: tag => `<img class="sticker-msg" alt="${tag}">`,
  renderRichText: s => `<p>${s}</p>`,
  isMobileLayout: () => false,
  state: {},
  SERVER_BASE: '',
};
vm.createContext(ctx);
vm.runInContext(read('js/10-stickers-voice.js'), ctx, { filename: '10-stickers-voice.js' });
const { _splitVoiceSegs, renderVoiceSegs, _firstVoicePart, renderVoiceBubble } = ctx;

// ── 切段：正文按表情标记断开 ──────────────────────────────────────────
const three = _splitVoiceSegs('今天好累啊\n\n[[STICKER:摸头]]\n\n但是看到你就好了');
t('文字—表情—文字 切成 3 段', three && three.length === 3, three && three.map(s => s.type));
t('中间那段是表情，标签原样留着', !!three && three[1].type === 'sticker' && three[1].tag === '[[STICKER:摸头]]');
t('两头是文字', !!three && three[0].type === 'text' && three[2].type === 'text');

const tail = _splitVoiceSegs('晚安啦 [[GIF:https://x/y.gif|sleepy cat]]');
t('表情在末尾也拆（语音条 + 表情）', !!tail && tail.length === 2 && tail[1].type === 'sticker');
t('GIF_SEARCH 同样算隔断', (_splitVoiceSegs('前 [[GIF_SEARCH:开心]] 后') || []).length === 3);

t('没有表情的正文不拆', _splitVoiceSegs('就是一句普通的话') === null);
// 纯表情消息本来就不该变成语音条，拆了会留一个空的播放器
t('一段文字都没有的纯表情不拆', _splitVoiceSegs('[[STICKER:笑]]') === null);

// ── 渲染：一段文字一个语音条，表情自己一个气泡 ─────────────────────────
const m = {
  id: 7, role: 'ai', audioDur: 5, audio: 'data:audio/mp3;base64,AA',
  voiceParts: [
    { type: 'text', raw: '今天好累啊', dur: 2, audio: 'data:audio/mp3;base64,AA' },
    { type: 'sticker', tag: '[[STICKER:摸头]]' },
    { type: 'text', raw: '但是看到你就好了', dur: 3, audio: 'data:audio/mp3;base64,BB' },
  ],
};
const segs = renderVoiceSegs(m);
t('渲染成 3 个气泡', !!segs && segs.length === 3, segs && segs.length);
t('第 1 个是语音条', !!segs && /class="voice-msg"/.test(segs[0].html));
t('第 2 个是表情气泡（走 bubble-sticker 那条，没有背景没有内边距）',
  !!segs && segs[1].type === 'sticker' && /sticker-msg/.test(segs[1].html));
t('第 3 个也是语音条', !!segs && /class="voice-msg"/.test(segs[2].html));

// 这条是「拆」的意义所在：第二个语音条播的是它自己那段，不是从头重放整条
t('每个语音条播自己那一段音频',
  !!segs && /playVoiceMsg\(7, this, 0\)/.test(segs[0].html) && /playVoiceMsg\(7, this, 2\)/.test(segs[2].html));
t('时长各算各的（不是整条的 5″）',
  !!segs && /2″/.test(segs[0].html) && /3″/.test(segs[2].html) && !/5″/.test(segs.map(s => s.html).join('')));

// 展开区的 id 撞了的话，点第二条「看文字」会展开第一条的正文
const ids = segs.flatMap(s => [...s.html.matchAll(/id="(voiceText-[^"]+)"/g)].map(x => x[1]));
t('两个展开区的 DOM id 不重复', ids.length === 2 && new Set(ids).size === 2, ids);
t('表情不再出现在展开正文里',
  !segs.filter(s => s.type === 'text').some(s => /STICKER:|GIF:/.test(s.html)));

// 整条消息级的东西（未接来电横幅、听感提示）只能印一次
const m2 = { ...m, missedCall: true, dialReason: '想你了', voiceEmo: { hint: '声音有点闷' } };
const segs2 = renderVoiceSegs(m2);
const count = (arr, re) => arr.map(s => (s.html.match(re) || []).length).reduce((a, b) => a + b, 0);
t('未接来电横幅只印一次', count(segs2, /voice-missed/g) === 1, count(segs2, /voice-missed/g));
t('听感提示只印一次', count(segs2, /voice-emo/g) === 1, count(segs2, /voice-emo/g));

// ── 不该拆的照旧走单气泡 ──────────────────────────────────────────────
t('只有一段文字时不拆', renderVoiceSegs({ id: 8, role: 'ai', voiceParts: [{ type: 'text', raw: 'x', dur: 1 }] }) === null);
t('老消息（没有 voiceParts）不拆，走原来的单气泡', renderVoiceSegs({ id: 9, role: 'ai', audio: 'x' }) === null);
// 单气泡那条路不许带 part 后缀，否则老消息的 toggle 全找不到自己的展开区
t('单气泡的展开区 id 仍是 voiceText-<id>',
  /id="voiceText-9"/.test(renderVoiceBubble({ id: 9, role: 'ai', audioDur: 2 })));

// 思考链/心境批注挂在第一个文字气泡上（06-render-msg 用这个下标决定挂哪）
t('第一个文字段的下标：文字开头时是 0', _firstVoicePart(m) === 0);
t('第一个文字段的下标：表情开头时是 1',
  _firstVoicePart({ voiceParts: [{ type: 'sticker' }, { type: 'text' }] }) === 1);

// ── 渲染层的接线 ─────────────────────────────────────────────────────
const rm = read('js/06-render-msg.js');
// 语音走 voiceSegs 那条自己的路；_splitStickerBubbles 仍然不许碰语音（它切的是渲染好的 HTML）
t('语音的拆分走 renderVoiceSegs，不走 _splitStickerBubbles',
  /const segs = voiceSegs \|\| \(\(!streaming && !m\.audio\) \? _splitStickerBubbles/.test(rm));
t('思考链和心境批注在拆开后只挂第一个文字气泡',
  /voiceSegs\.findIndex\(s => s\.type === 'text'\)/.test(rm) && /voiceSegs\.unshift\(/.test(rm));

// TTS 清洗规则两边共用：拆出来的每一段和整条走的必须是同一套
const tts = read('js/07-band-tts.js');
t('getTtsCleanText 和 cleanTtsText 共用一套清洗规则',
  /function getTtsCleanText\(node\) \{\s*return cleanTtsText\(getMsgPlainText\(node\)\);/.test(tts));
const sv = read('js/10-stickers-voice.js');
t('分段合成用的是 cleanTtsText，不是自己另写一套', /cleanTtsText\(s\.text\)/.test(sv));
// 800 字是整条的预算：按段各切 800，带表情的消息会偷偷变成三倍长
t('800 字预算是整条共享的，不是每段一份', /budget -= clean\.length/.test(sv));

// ── 上游：提示词得允许模型这么写 ────────────────────────────────────
// 2026-09-04 实栽在这：拆分代码全对、测试全绿，但语音技能的提示词里写着
// 「发语音时正文里不要写 …、表情包标签」，听话的模型（deepseek 尤其照做）
// 压根不会产出带表情的语音正文 —— 功能永远等不到输入，界面上一点异常都没有。
// 下面这几条只盯**语音技能那一段**，不是全文件（别处提到表情标签是正常的）。
const api = read('js/05-prompts-api.js');
const voiceSkill = api.slice(api.indexOf('[语音消息技能]'), api.indexOf("if (skillOn('dial')"));
t('语音技能这段确实抓到了', voiceSkill.length > 100 && voiceSkill.length < 2000, voiceSkill.length);
t('禁止名单里不能再有「表情包标签」（有的话模型就不发了）',
  !/不要写[^\n]*表情包标签/.test(voiceSkill));
t('提示词明确告诉模型语音里可以夹表情', /\[\[STICKER:/.test(voiceSkill) && /\[\[GIF_SEARCH:/.test(voiceSkill));
t('并且说清了会拆成好几条，别让模型以为是一整条',
  /断成好几条|拆成好几条/.test(voiceSkill));
// 念出来的东西里不许有标签残留（cleanTtsText 得把 [[...]] 剥掉）
t('TTS 清洗会剥掉所有 [[...]] 标签，表情不会被念出来',
  /\.replace\(\/\\\[\\\[\.\*\?\\\]\\\]\/g, ''\)/.test(read('js/07-band-tts.js')));

// ── 安卓副本 ─────────────────────────────────────────────────────────
// android/assets 是 build.ps1 的产物，手改必被覆盖；但反过来，改了 js/ 忘了拷过去，
// APK 里就是旧代码 —— 手机上「表情还埋在展开里」而电脑上好好的，零报错。
// 这三个文件原先一条守卫都没有（守卫是逐文件写死的，只盖了 css/index.html/几个 js）。
for (const f of ['js/05-prompts-api.js', 'js/06-render-msg.js', 'js/07-band-tts.js',
                 'js/10-stickers-voice.js', 'js/12-math-media.js', 'js/37-forge.js']) {
  t('android 副本与 ' + f + ' 一致', read(f) === read('android/assets/' + f));
}

// ── 退路：拆不成的时候必须整条回老路，不能把内容吃掉 ──────────────────
// 这一节全是 Codex 2026-09-04 审出来的，四条当时一条都没覆盖。
// 前两条是行为测试（真的跑 _synthVoiceParts，把 TTS 那几个换成桩）。
function withStubs(over) {
  ctx.getMsgPlainText = over.plain;
  ctx.cleanTtsText = s => String(s).replace(/\[\[.*?\]\]/g, '').trim();
  ctx._blobToDataUrl = async () => 'data:audio/mp3;base64,AA';
  ctx._audioDuration = async () => 2;
  ctx._ttsBlob = over.tts || (async () => ({}));
}

(async () => {
  // 某一段炸了 → 整条回老路。以前这里让异常冒到 _maybeAiVoice 的 catch，
  // 那个 catch 只打日志，于是老路那句根本不执行，整条消息彻底没有语音。
  let n = 0;
  withStubs({
    plain: () => '前半句[[STICKER:摸头]]后半句',
    tts: async () => { if (++n === 2) throw new Error('TTS 500'); return {}; },
  });
  t('某一段合成失败 → 返回 null 让调用方整条走老路（不是抛出去）',
    (await ctx._synthVoiceParts({})) === null);

  // 预算不够时，以前是 slice 截断 + break，剩下的表情和尾句全留在 segs 里没进 parts，
  // 而渲染完全以 voiceParts 为准 —— 它们会从界面上凭空消失。
  withStubs({ plain: () => '[[STICKER:a]]' + 'x'.repeat(900) + '[[STICKER:b]]尾句' });
  t('预算念不完 → 整条不拆，不会把后面的表情和尾句吃掉',
    (await ctx._synthVoiceParts({})) === null);

  // 正常长度照旧要拆，别为了修上面那条把功能焊死
  withStubs({ plain: () => '今天好累[[STICKER:摸头]]但看到你就好了' });
  const ok = await ctx._synthVoiceParts({});
  t('长度在预算内 → 正常拆成 3 段', Array.isArray(ok) && ok.length === 3, ok && ok.length);
  t('拆出来的文字段带着音频和时长',
    !!ok && ok.filter(p => p.type === 'text').every(p => p.audio && p.dur));

  // 收藏里没有这个表情时 stickerTagToHtml 原样吐回标签，
  // 让它成气泡的话，透明无内边距的表情气泡里会浮着一行裸的 [[STICKER:xxx]]
  const realTagToHtml = ctx.stickerTagToHtml;
  const missSegs = tagText => {
    ctx.stickerTagToHtml = tag => tag;          // 模拟收藏里找不到：原样吐回标签
    const r = renderVoiceSegs({ id: 7, role: 'ai', voiceParts: [
      { type: 'text', raw: 'a', dur: 1 }, { type: 'sticker', tag: tagText },
      { type: 'text', raw: 'b', dur: 1 }] });
    ctx.stickerTagToHtml = realTagToHtml;
    return r;
  };
  // 早先这里写的是「解析不出图就整条不拆」，Codex 二审指出那会丢音频：
  // voiceParts 已经合成好了，而 m.audio 只存第一段，退回单气泡等于只听得到前半句。
  const miss = missSegs('[[STICKER:不存在]]');
  t('表情解析不出图 → 语音段照拆（不能退回单气泡，那样只听得到前半句）',
    !!miss && miss.length === 3, miss && miss.length);
  t('解析不出的表情换成中性占位，不让裸标签浮在透明气泡里',
    !!miss && /\[表情包\]/.test(miss[1].html) && !/\[\[STICKER:/.test(miss[1].html));
  // [[STICKER:<3]] 这种名字原样吐回来也带着尖括号 —— 判据不能只看「有没有 <」
  const lt = missSegs('[[STICKER:<3]]');
  t('名字里带尖括号的未解析标签同样算失败，不许原样插进 HTML',
    !!lt && /\[表情包\]/.test(lt[1].html) && !/<3/.test(lt[1].html));

  // ── 存储/上下文侧的连带（这几处不在 10-stickers-voice.js 里）──────────
  // GIF 搜索结果固化：content 换成 [[GIF:url]] 了，voiceParts 里的标签副本也得跟着换，
  // 不然重开一次缓存空了，会拿同一个关键词重搜，可能换成另一张图
  const media = read('js/12-math-media.js');
  const persistGif = media.slice(media.indexOf('function _persistGifResult'));
  t('GIF 固化会同步 voiceParts 里的标签副本',
    /node\.voiceParts\.forEach\(p => \{ if \(p\.type === 'sticker'\) p\.tag = fix\(p\.tag\); \}\)/
      .test(persistGif.slice(0, persistGif.indexOf('\nfunction '))));

  // 换窗（forge）克隆语音消息时漏带 voiceParts 的话，拆开的语音会退化成单气泡，
  // 而 audio 还在、看着像正常语音，不会有任何报错
  // 只搜「有没有这句」会假绿 —— Codex 二审逮到我第一版把它写进了 if (isUser) 分支，
  // 语句在、但 AI 的语音永远走不到那里。所以要验它**不在**用户分支里。
  const forge = read('js/37-forge.js');
  const cloneFn = forge.slice(forge.indexOf('if (first && step.gapNote)'), forge.indexOf('c.nodes[id] = node;'));
  const userBranch = cloneFn.slice(cloneFn.indexOf('if (isUser) {'), cloneFn.indexOf('} else {'));
  t('换窗克隆：抓到了 isUser 分支', userBranch.length > 50 && userBranch.length < 1500, userBranch.length);
  t('换窗克隆：语音不锁在 isUser 分支里（AI 自己也会发语音条）', !/n\.audio/.test(userBranch));
  t('换窗克隆：带上 voiceParts', /if \(n\.voiceParts\) node\.voiceParts = _forgeClone\(n\.voiceParts\)/.test(cloneFn));

  // 发给模型的时长要算总数：m.audioDur 只是第一段
  t('喂给模型的语音时长是各段总和，不是第一段',
    /m\.voiceParts\?\.length[\s\S]{0,120}reduce\(\(t, p\) => t \+ \(p\.dur \|\| 0\), 0\)/.test(api));

  // 表情包技能关掉时，语音提示词不许再教模型写 [[STICKER:]]（两侧解析都不查开关）
  t('表情那句挂在 skillOn(sticker) 上，不绕过开关',
    /if \(skillOn\('voice'\) && skillOn\('sticker'\)\) base \+=/.test(api));

  console.log('');
  console.log(pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exit(1);
})();
