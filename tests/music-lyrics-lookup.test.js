'use strict';
// [[LYRICS: 歌名 歌手]] 想查哪首就看哪首的完整歌词（用户）
//
//   ① 取歌词：搜歌 → 名字歌手对得上的优先 → 翻唱没词就往下试；不带歌名＝正在放的那首
//   ② 标签 → 提示块（写查到的是哪首），歌词挂 state 等下一次拼提示词摊开，只摊一次
//   ③ 遮罩 / 回填历史咬回 [[LYRICS: 查的词]] / 接线 / 续写理由
//
// 歌词全用编的句子，不放真歌词；fetch 全是桩。
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
  const listenSrc = slice(music, 'const MUSIC_LISTEN_LABEL', 'function toggleMusic(');
  const maskSrc = slice(music, 'function maskStreamingMusic(', '// ── 系统提示');
  const parseSrc = slice(music, '// LRC 风格的行级歌词', 'function _mSetLyric(');
  const fracSrc = slice(music, 'function _mFrac(', '\n');
  const normSrc = slice(music, 'function musicSearchNorm(', '\n');

  // 编的曲库：id → 网易云 /api/music/lyric 的回包
  const LY = {
    101: { lyric: '[00:01.00]编的第一句\n[00:05.00]编的第二句\n[00:09.00]编的第一句\n', tlyric: '[00:05.00]second made-up\n' },
    102: { lyric: '', yrc: '' },                                              // 翻唱：一个字都没有
    103: { lyric: '[00:00.00]纯音乐，请欣赏', pureMusic: true },
    104: { lyric: '没有时间轴的第一行\n没有时间轴的第二行' },
    105: { yrc: '[1000,2000](1000,500,0)逐(1500,500,0)字(2000,1000,0)编\n[3000,1000](3000,1000,0)第二行编', ytlrc: '[00:01.00]word by word\n' },
    106: { lyric: '[00:01.00]' + '很长的编的一句'.repeat(1200) },
  };
  const SEARCH = {
    // 排第一的是别人唱的同名歌（有词）；对得上的两首里第一首没词（翻唱/伴奏常这样），第二首才有
    '编的歌 某歌手': [{ id: 104, name: '编的歌', artist: '别人' }, { id: 102, name: '编的歌', artist: '某歌手' }, { id: 101, name: '编的歌', artist: '某歌手' }],
    '冷门编曲': [{ id: 102, name: '冷门编曲', artist: '谁' }],
    // 名字里写着「原唱 某歌手」的翻唱排在前面，歌手栏真对上的在后面
    '某曲 某歌手': [{ id: 104, name: '某曲 (原唱 某歌手)', artist: '翻唱者' }, { id: 101, name: '某曲', artist: '某歌手' }],
    '编出来的歌名': [{ id: 101, name: '另一首沾边的歌', artist: '谁' }],
    '安静的编曲': [{ id: 103, name: '安静的编曲', artist: '某乐队' }],
    '无轴之歌': [{ id: 104, name: '无轴之歌', artist: '谁' }],
    '逐字之歌': [{ id: 105, name: '逐字之歌', artist: '谁' }],
    '超长之歌': [{ id: 106, name: '超长之歌', artist: '谁' }],
  };
  const env = { state: { musicOn: true }, now: null, lyric: null, pure: null, fetches: [], down: false };
  const fetch = async url => {
    env.fetches.push(url);
    if (env.down) throw new Error('Failed to fetch');
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/music/lyric') {
      const j = LY[u.searchParams.get('id')];
      return { ok: !!j, json: async () => j || {} };
    }
    return { ok: true, json: async () => ({ songs: SEARCH[u.searchParams.get('q')] || [] }) };
  };
  const M = new Function('env', 'fetch', `
    const state = env.state;
    const musicEnabled = () => !!state.musicOn;
    const musicEarsOn = () => env.ears !== false;
    const musicApiBase = () => '';
    const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const _mFmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    async function musicSearch(q, limit) {
      const r = await fetch('/api/music/search?q=' + encodeURIComponent(q) + '&limit=' + limit);
      return (await r.json()).songs || [];
    }
    let _mNow, _mAudio, _mLyric;
    function sync() { _mNow = env.now; _mLyric = env.lyric; _mLyPureId = env.pure; _mAudio = null; }
    ${fracSrc}
    ${normSrc}
    ${parseSrc}
    ${listenSrc}
    ${maskSrc}
    return { sync, musicLyricsLookup, musicLyricsPrefetch, musicLyricsPending, musicProcessLyrics,
             _applyMusicLyricsToBlocks, musicPromptFor, maskStreamingMusic, MUSIC_LYRICS_LABEL, MUSIC_LYRICS_CHARS };`)(env, fetch);
  const conf = { id: 7 };
  M.sync();

  // ── ① 取歌词 ──
  console.log('\n[1] 取歌词');
  let r = await M.musicLyricsLookup('编的歌 某歌手');
  t('名字歌手都对得上的优先（不拿排第一的别人那首），没词就往下一首对得上的试', r.artist === '某歌手' && /^编的第一句/.test(r.text || ''), r);
  t('整首都在，翻译挂括号', r.text === '编的第一句\n编的第二句（second made-up）\n编的第一句', r.text);
  r = await M.musicLyricsLookup('某曲 某歌手');
  t('歌手栏真对上的优先于名字里带「原唱 某歌手」的翻唱', r.artist === '某歌手' && !r.loose, r);
  r = await M.musicLyricsLookup('编出来的歌名');
  t('一首都对不上：给最接近的但标 loose', r.loose === true && r.name === '另一首沾边的歌', r);
  r = await M.musicLyricsLookup('冷门编曲');
  t('只有翻唱且没词：说没有歌词', r.none && !r.text && r.name === '冷门编曲', r);
  r = await M.musicLyricsLookup('安静的编曲');
  t('纯音乐认得出', r.pure === true, r);
  r = await M.musicLyricsLookup('无轴之歌');
  t('没时间轴的歌词按行原样给', r.text === '没有时间轴的第一行\n没有时间轴的第二行', r.text);
  r = await M.musicLyricsLookup('逐字之歌');
  t('逐字歌词拼成整行、配逐字翻译', r.text === '逐字编（word by word）\n第二行编', r.text);
  r = await M.musicLyricsLookup('超长之歌');
  t('太长截断并标出来', r.cut === true && r.text.length === M.MUSIC_LYRICS_CHARS, { cut: r.cut, len: r.text && r.text.length });
  r = await M.musicLyricsLookup('根本不存在');
  t('搜不到：明说', /没搜到/.test(r.err || ''), r);

  // 不带歌名＝正在放的
  r = await M.musicLyricsLookup('');
  t('没歌在放：明说', /没有歌在放/.test(r.err || ''), r);
  env.now = { id: 101, name: '编的歌', artist: '某歌手' };
  env.lyric = { lines: [{ t: 0, txt: '她手贴的第一句' }, { t: 3, txt: '她手贴的第二句', tr: 'pasted' }] };
  M.sync(); env.fetches.length = 0;
  r = await M.musicLyricsLookup('');
  t('正在放：直接用面板上那份（含她手贴的），不联网', r.text === '她手贴的第一句\n她手贴的第二句（pasted）' && env.fetches.length === 0, r);
  env.lyric = null; M.sync();
  r = await M.musicLyricsLookup('');
  t('正在放但面板还没词：按 id 现取', r.text && r.text.startsWith('编的第一句'), r);
  env.now = { id: 103, name: '安静的编曲', artist: '某乐队' }; env.pure = '103'; M.sync(); env.fetches.length = 0;
  r = await M.musicLyricsLookup('');
  t('正在放的是纯音乐：不联网直接说', r.pure && env.fetches.length === 0, r);
  env.now = { id: 1, name: 'x', _resume: true }; env.pure = null; M.sync();
  t('重启后装回来还没按 ▶ 的不算在放', /没有歌在放/.test((await M.musicLyricsLookup('')).err || ''));
  env.now = null; M.sync();

  // ── ② 预取 → 提示块 → 摊开一次 ──
  console.log('\n[2] 预取、提示块、摊开');
  const reply = '我去看看那首\n[[LYRICS: 编的歌 某歌手]]';
  await M.musicLyricsPrefetch(reply, conf);
  t('预取后挂上待看', M.musicLyricsPending(7));
  const out = M.musicProcessLyrics(reply, conf);
  t('标签换成提示块', !out.includes('[[LYRICS') && out.includes(M.MUSIC_LYRICS_LABEL), out);
  t('提示块写了查的词和查到的哪首，但不带歌词', out.includes('编的歌 某歌手') && out.includes('→ 编的歌 - 某歌手') && !out.includes('编的第一句'), out);
  let v = M.musicPromptFor(conf).volatile;
  t('volatile 摊开整首', v.includes('[你刚翻的歌词]') && v.includes('《编的歌》 - 某歌手') && v.includes('编的第二句（second made-up）'), v);
  t('附了「别整首贴给她」', v.includes('别整首贴给她'), v);
  t('stable 里不带歌词（缓存）', !M.musicPromptFor(conf).stable.includes('编的第一句'));
  t('只摊一次', !M.musicLyricsPending(7) && !M.musicPromptFor(conf).volatile.includes('编的第一句'));
  t('stable 教了 [[LYRICS: 歌名 歌手]] 和不带歌名的写法', /\[\[LYRICS: 歌名 歌手\]\]/.test(M.musicPromptFor(conf).stable) && M.musicPromptFor(conf).stable.includes('`[[LYRICS]]`'));

  await M.musicLyricsPrefetch('[[LYRICS: 安静的编曲]] [[LYRICS: 根本不存在]] [[LYRICS: 冷门编曲]]', conf);
  v = M.musicPromptFor(conf).volatile;
  t('一轮最多两首，第三首说没查', v.includes('纯音乐，没有歌词') && v.includes('没搜到') && /最多查 2 首/.test(v), v);

  await M.musicLyricsPrefetch('[[LYRICS: 编出来的歌名]]', conf);
  v = M.musicPromptFor(conf).volatile;
  t('对不上的那首摊开时明说多半不是', v.includes('多半不是你要的那首') && !v.includes('按网易云搜到的这首给的'), v);

  env.down = true;
  await M.musicLyricsPrefetch('[[LYRICS: 编的歌 某歌手]]', conf);
  v = M.musicPromptFor(conf).volatile;
  t('断网：明说没查到，不炸', v.includes('没查到') && v.includes('Failed to fetch'), v);
  env.down = false;

  // 「AI 点歌」开关只管点歌，翻歌词照查（用户）；只有听的总闸关了才不查
  env.state.musicOn = false;
  await M.musicLyricsPrefetch('[[LYRICS: 编的歌 某歌手]]', conf);
  t('点歌关着：照样查、照样挂', M.musicLyricsPending(7));
  v = M.musicPromptFor(conf).volatile;
  t('点歌关着：照样摊开歌词', v.includes('编的第一句'), v);
  env.state.musicOn = true;
  env.ears = false;
  env.fetches.length = 0;
  await M.musicLyricsPrefetch('[[LYRICS: 编的歌 某歌手]]', conf);
  t('听的总闸关了：不查也不挂（没人消费，挂了就是陈标记）', !M.musicLyricsPending(7) && env.fetches.length === 0);
  env.ears = true;

  await M.musicLyricsPrefetch('[[LYRICS: 编的歌 某歌手]]', conf);
  const blocks = [{ type: 'text', text: 'a [[LYRICS: 编的歌 某歌手]] b' }, { type: 'thinking', text: '[[LYRICS: x]]' }];
  M._applyMusicLyricsToBlocks(blocks, conf);
  t('blocks 路径也换掉', !blocks[0].text.includes('[[LYRICS') && blocks[0].text.includes('→ 编的歌'));
  t('blocks 路径不碰思考块', blocks[1].text === '[[LYRICS: x]]');
  M.musicPromptFor(conf);

  // ── ③ 遮罩 / 回填 / 接线 ──
  console.log('\n[3] 遮罩、回填、接线');
  t('流式：完整标签藏住', !M.maskStreamingMusic('好\n[[LYRICS: 编的歌]]').includes('[['));
  for (const p of ['[[LY', '[[LYRIC', '[[LYRICS', '[[LYRICS:', '[[LYRICS: 编的', '[[LYRICS: 编的歌]'])
    t(`流式：半截 ${p} 藏住`, !M.maskStreamingMusic('好\n' + p).includes('[['), M.maskStreamingMusic('好\n' + p));
  t('流式：[[LISTEN]] 照旧', !M.maskStreamingMusic('[[LISTEN]]').includes('[['));

  const reRow = api.split('\n').find(l => l.includes('📜 翻了翻歌词<\\/span>'));
  t('回填正则存在', !!reRow);
  const reSrc = reRow.trim().replace(/^\.replace\(\//, '').replace(/\/g,$/, '');
  const fnRow = api.split('\n')[api.split('\n').indexOf(reRow) + 1].trim().replace(/\)$/, '');
  const restore = new Function('s', `return s.replace(new RegExp(${JSON.stringify(reSrc)}, 'g'), ${fnRow});`);
  await M.musicLyricsPrefetch('[[LYRICS: 编的歌 某歌手]]', conf);
  t('回填：咬回 [[LYRICS: 查的词]]（不带查到的那首、不带歌词）', restore(M.musicProcessLyrics('[[LYRICS: 编的歌 某歌手]]', conf)).trim() === '[[LYRICS: 编的歌 某歌手]]',
    restore(M.musicProcessLyrics('[[LYRICS: 编的歌 某歌手]]', conf)));
  t('回填：不带歌名的咬回 [[LYRICS]]', restore(M.musicProcessLyrics('[[LYRICS]]', conf)).trim() === '[[LYRICS]]');
  t('回填：查的词里有 & < 也能原样咬回', restore(M.musicProcessLyrics('[[LYRICS: A & <B>]]', conf)).trim() === '[[LYRICS: A & <B>]]');
  M.musicPromptFor(conf);

  t('processAiCommands 接了', mem.includes('musicProcessLyrics(text, conf)'));
  t('callAPI / streamVariant / 群聊都在 processAiCommands 前预取',
    api.split('await musicLyricsPrefetch(').length === 3 && render.includes('await musicLyricsPrefetch(fullText, conf)'));
  t('预取在 processAiCommands 之前', api.indexOf('await musicLyricsPrefetch(finalText') < api.indexOf('chat.nodes[aiId].content = processAiCommands(finalText'));
  t('callAPI / streamVariant / 群聊的 blocks 路径都接了',
    api.split('_applyMusicLyricsToBlocks(blocks, conf)').length === 3 && render.includes('_applyMusicLyricsToBlocks(blocks, conf)'));
  t('渲染兜底：老消息裸标签变胶囊', api.includes("pill('📜 翻了翻歌词'"));
  t('续写理由里有歌词', api.includes("musicLyricsPending(id)) out.push('那首歌的歌词')"));

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
