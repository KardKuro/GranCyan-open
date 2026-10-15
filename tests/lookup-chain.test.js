'use strict';
// 查询类指令当轮续写 + [[LISTEN]] 按需听歌（用户）
//
//   ① [[LISTEN]]：平时 volatile 里只有「有歌在放」，不带歌名；写了才摊开歌名/进度/歌词窗口，只摊一次
//   ② 流式遮罩和回填：裸 [[LISTEN]] 不漏进气泡；提示块回填历史时咬回 [[LISTEN]]
//   ③ 续写：这一轮新置的待看标记 → 立刻从这条 AI 消息后面再请求一次（depth+1）；
//      陈标记、她已经接话（headId 变了）、到三跳上限 → 都不续
//
// 歌词全用编的句子，不放真歌词。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const music = fs.readFileSync(path.join(ROOT, 'js/24-music.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'js/05-prompts-api.js'), 'utf8');
const mem = fs.readFileSync(path.join(ROOT, 'js/04-memory.js'), 'utf8');
const render = fs.readFileSync(path.join(ROOT, 'js/06-render-msg.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
function slice(src, a, b) {
  t(`锚点唯一：${a.slice(0, 30)}`, src.split(a).length === 2 && src.split(b).length >= 2);
  const i = src.indexOf(a);
  return src.slice(i, src.indexOf(b, i));
}

(async () => {
  // ── ① [[LISTEN]] ──
  console.log('\n[1] [[LISTEN]] 按需摊开');
  const listenSrc = slice(music, 'const MUSIC_LISTEN_LABEL', 'function toggleMusic(');
  const maskSrc = slice(music, 'function maskStreamingMusic(', '// ── 系统提示');
  const env = { state: { musicOn: true }, now: null, audio: null, lyric: null };
  const M = new Function('env', `
    const state = env.state;
    const musicEnabled = () => !!state.musicOn;
    const musicEarsOn = () => true;
    const _mFmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    let _mNow, _mAudio, _mLyric;
    function sync() { _mNow = env.now; _mAudio = env.audio; _mLyric = env.lyric; }
    ${listenSrc}
    ${maskSrc}
    return { sync, musicPromptFor, musicProcessListen, musicListenPending, _applyMusicListenToBlocks,
             maskStreamingMusic, musicLyricContext, MUSIC_LISTEN_LABEL };`)(env);
  const conf = { id: 7 };
  env.now = { id: 1, name: '测试之歌', artist: '某歌手', feat: { hint: '约 130 BPM（偏快）' } };
  env.audio = { currentTime: 25, duration: 200, paused: false };
  env.lyric = { lines: [
    { t: 0, txt: '编的第一句' }, { t: 10, txt: '编的第二句' }, { t: 20, txt: '编的第三句', tr: 'third' },
    { t: 30, txt: '编的第四句' }, { t: 40, txt: '编的第五句' }, { t: 50, txt: '编的第六句' },
  ] };
  M.sync();

  let v = M.musicPromptFor(conf).volatile;
  t('没要听：只报有歌在放', v.includes('[有歌在放]') && v.includes('[[LISTEN]]'), v);
  t('没要听：不带歌名、不带歌词', !v.includes('测试之歌') && !v.includes('编的'), v);
  t('stable 里不出现歌名（缓存）', !M.musicPromptFor(conf).stable.includes('测试之歌'));

  const out = M.musicProcessListen('嗯我看看\n[[LISTEN]]', conf);
  t('[[LISTEN]] 换成提示块', !out.includes('[[LISTEN]]') && out.includes(M.MUSIC_LISTEN_LABEL), out);
  t('[[LISTEN]] 置位', M.musicListenPending(7));
  v = M.musicPromptFor(conf).volatile;
  t('要听：歌名歌手进度', v.includes('测试之歌') && v.includes('某歌手') && v.includes('0:25 / 3:20'), v);
  t('要听：听感', v.includes('130 BPM'), v);
  t('要听：▶ 指着第三句，带翻译', v.includes('▶ 编的第三句（third）'), v);
  t('要听：前后各两句', v.includes('编的第一句') && v.includes('编的第五句') && !v.includes('编的第六句'), v);
  t('只摊一次：标记被消费', !M.musicListenPending(7));
  t('下一轮回到只报有歌在放', !M.musicPromptFor(conf).volatile.includes('测试之歌'));

  env.audio = { currentTime: 0, duration: 200, paused: false };
  env.lyric = { lines: [{ t: 5, txt: '前奏后第一句' }, { t: 9, txt: '前奏后第二句' }] };
  M.sync();
  t('前奏里：没有 ▶，说还在前奏', /前奏/.test(M.musicLyricContext(0)) && !M.musicLyricContext(0).includes('▶'), M.musicLyricContext(0));
  env.lyric = null; M.sync();
  M.musicProcessListen('[[LISTEN]]', conf);
  v = M.musicPromptFor(conf).volatile;
  t('没歌词：照样给歌名，不报歌词', v.includes('测试之歌') && !v.includes('歌词'), v);

  env.now = null; M.sync();
  M.musicProcessListen('[[LISTEN]]', conf);
  t('没在放歌：明说没有', M.musicPromptFor(conf).volatile.includes('现在没有歌在放'));

  // 「AI 点歌」开关关着也得能听（用户：exe 存档清过，开关回到默认关，AI 连「有歌在放」都看不到）
  env.state.musicOn = false;
  env.now = { id: 1, name: '测试之歌', artist: '某歌手' }; M.sync();
  let off = M.musicPromptFor(conf);
  t('点歌关着：照样报有歌在放', off.volatile.includes('[有歌在放]'), off.volatile);
  t('点歌关着：stable 照样教 [[LISTEN]]/[[LYRICS]]', off.stable.includes('[[LISTEN]]') && off.stable.includes('[[LYRICS: 歌名 歌手]]'), off.stable.slice(0, 300));
  t('点歌关着：不教 [[MUSIC:]]/[[PLAYLIST:]]', !off.stable.includes('`[[MUSIC: 歌名 歌手]]`') && !off.stable.includes('[[PLAYLIST:'), off.stable.slice(0, 300));
  M.musicProcessListen('[[LISTEN]]', conf);
  t('点歌关着：[[LISTEN]] 照样置位', M.musicListenPending(7));
  off = M.musicPromptFor(conf);
  t('点歌关着：[[LISTEN]] 照样摊开歌名', off.volatile.includes('测试之歌'), off.volatile);
  env.state.musicOn = true;
  t('点歌开着：stable 两半都在', /`\[\[MUSIC: 歌名 歌手\]\]`/.test(M.musicPromptFor(conf).stable) && M.musicPromptFor(conf).stable.includes('[[LISTEN]]'));
  env.now = null; M.sync();

  const blocks = [{ type: 'text', text: 'a [[LISTEN]] b' }, { type: 'thinking', text: '[[LISTEN]]' }];
  M._applyMusicListenToBlocks(blocks, conf);
  t('blocks 路径也换掉并置位', !blocks[0].text.includes('[[LISTEN]]') && M.musicListenPending(7));
  t('blocks 路径不碰思考块', blocks[1].text === '[[LISTEN]]');
  M.musicPromptFor(conf);   // 消费掉

  // ── ② 遮罩 / 回填 / 接线 ──
  console.log('\n[2] 遮罩、回填、接线');
  t('流式：完整标签藏住', !M.maskStreamingMusic('好\n[[LISTEN]]').includes('[[LISTEN'));
  for (const p of ['[[L', '[[LIS', '[[LISTEN', '[[LISTEN]'])
    t(`流式：半截 ${p} 藏住`, !M.maskStreamingMusic('好\n' + p).includes('[['), M.maskStreamingMusic('好\n' + p));
  t('流式：普通 [[ 开头的别的指令不被误吞', M.maskStreamingMusic('x [[MOMENTS]]').includes('[[MOMENTS]]'));
  const block = M.musicProcessListen('[[LISTEN]]', conf); M.musicPromptFor(conf);
  const reRow = api.split('\n').find(l => l.includes('🎧 听了听正在放的歌<\\/span>'));
  t('回填正则存在', !!reRow);
  const re = new RegExp(reRow.trim().replace(/^\.replace\(\//, '').replace(/\/g,$/, ''), 'g');
  t('回填：提示块咬回 [[LISTEN]]', block.replace(re, '[[LISTEN]]').trim() === '[[LISTEN]]', block.replace(re, '[[LISTEN]]'));
  t('processAiCommands 接了', mem.includes('musicProcessListen(text, conf)'));
  t('callAPI / streamVariant 的 blocks 路径都接了', api.split('_applyMusicListenToBlocks(blocks, conf)').length === 3);
  t('群聊 blocks 路径接了', render.includes('_applyMusicListenToBlocks(blocks, conf)'));
  t('渲染兜底：老消息裸标签变胶囊', api.includes("\\[\\[LISTEN\\]\\]/gi, () => pill('🎧"));
  t('buildSystemPrompt 把 conf 传给 musicPromptFor', api.includes('musicPromptFor(conf)'));
  const gateRow = (api.match(/[^\n]*\n\s*const musicPrompt = musicPromptFor\(conf\)/) || [''])[0].split('\n')[0];
  t('buildSystemPrompt 不拿「AI 点歌」开关挡整块（否则开关一关 AI 就听不见）',
    gateRow.includes('musicEarsOn()') && !gateRow.includes('musicEnabled()'), gateRow);

  // ── ③ 续写 ──
  console.log('\n[3] 当轮续写');
  const chainSrc = slice(api, 'const LOOKUP_CHAIN_MAX', 'async function streamVariant(');
  const pend = {};
  const calls = [];
  const C = new Function('pend', 'calls', `
    const musicListenPending = id => !!pend.listen;
    const chatsPeekPending = id => !!pend.chats;
    const chatReadPending = id => pend.read || null;
    const diaryReadPending = id => !!pend.diary;
    const momentsViewPending = id => !!pend.moments;
    const getMessagePath = (chat, id) => ['path-to-' + id];
    let prompts = [];
    async function callAPI(conf, p, chat, parent, depth) {
      prompts.push(lookupChainPromptFor());
      calls.push({ p, parent, depth });
    }
    ${chainSrc}
    return { lookupChainReasons, lookupChainContinue, lookupChainPromptFor, prompts: () => prompts };`)(pend, calls);
  const chat = { headId: 5, nodes: { 5: { id: 5 } } };

  await C.lookupChainContinue(conf, chat, 5, [], 0, []);
  t('没查东西：不续', calls.length === 0);

  pend.listen = true;
  await C.lookupChainContinue(conf, chat, 5, [], 0, []);
  t('查了歌：从这条 AI 消息后面续一轮', calls.length === 1 && calls[0].parent === 5 && calls[0].p[0] === 'path-to-5', calls);
  t('续写深度 +1', calls[0].depth === 1, calls);
  t('续写那次的提示词里有「接着说」和查的东西', /接着说/.test(C.prompts()[0]) && C.prompts()[0].includes('正在放的歌'), C.prompts());
  t('提示只给一次', C.lookupChainPromptFor() === '');

  calls.length = 0;
  await C.lookupChainContinue(conf, chat, 5, [], 0, C.lookupChainReasons(conf, []));
  t('陈标记（拼提示词前就挂着）不续', calls.length === 0);

  pend.listen = false; pend.chats = true;
  await C.lookupChainContinue(conf, chat, 5, [], 0, ['正在放的歌']);
  t('陈的是别的、新置的是目录：照续', calls.length === 1, calls);

  calls.length = 0;
  await C.lookupChainContinue(conf, { ...chat, headId: 9 }, 5, [], 0, []);
  t('她已经接话（headId 变了）：不续', calls.length === 0);
  await C.lookupChainContinue(conf, { ...chat, ended: true }, 5, [], 0, []);
  t('对话结束了：不续', calls.length === 0);
  await C.lookupChainContinue(conf, chat, 5, [], 3, []);
  t('到三跳上限：不续', calls.length === 0);
  await C.lookupChainContinue(conf, chat, 5, [], 2, []);
  t('第三跳还能续', calls.length === 1 && calls[0].depth === 3, calls);

  pend.chats = false; calls.length = 0;
  await C.lookupChainContinue(conf, chat, 5, [{ kind: 'say' }], 0, []);
  t('檐廊只说了一句（写操作）：不续', calls.length === 0);
  await C.lookupChainContinue(conf, chat, 5, [{ kind: 'gaze' }], 0, []);
  t('檐廊看了一眼：续', calls.length === 1);

  t('callAPI 收尾接了续写，且带上陈标记快照',
    /await lookupChainContinue\(conf, chat, aiId, gazeResults, chainDepth, staleLookups\);/.test(api)
    && /const staleLookups = lookupChainReasons\(conf, \[\]\);/.test(api));
  t('陈标记快照在 buildApiMessages 之后取（先消费再看剩下的）',
    api.indexOf('const staleLookups') > api.indexOf('const messages = await buildApiMessages(path, conf, false, chat);'));
  t('buildSystemPrompt 注入续写提示', api.includes('vol += lookupChainPromptFor()'));

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
