/* 逐字歌词的浏览器冒烟：在真页面里推时间，看字有没有真的一个一个点亮。
 *
 * 为什么必须在浏览器里跑：单测那份是 vm 沙箱，验的是**解析算得对不对**。
 * 而「::after 裁出来的亮层宽度跟不跟得上」「切行时上一句的字有没有归位」
 * 「暂停之后 rAF 有没有真的停」「canvas 是不是画了东西而不是一片空白」——
 * 这几件事全在渲染层，桩里怎么摆都验不出来。canvas 那条尤其：
 * 画错了也不会报错，只是背景一片死黑，肉眼还以为是「设计如此」。
 *
 * 跑法：先 GRANCYAN_PORT=3099 node server.js，再 node tests/browser-music-lyrics.js
 */
const PORT = process.env.GC_PORT || 3099;
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const group = n => console.log('\n' + n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 真实的网易云 yrc / ytlrc / yromalrc 片段（Lemon，id=1466598056）。
// 用真数据而不是手编的：手编的样本会不自觉地避开真实数据里的怪东西
// （行尾空格、括号内的 0、逐字切分横跨假名）。
const YRC = '[830,4980](830,380,0)夢(1210,330,0)な(1540,200,0)ら(1740,430,0)ば(2170,430,0)ど(2600,250,0)れ(2850,280,0)ほ(3130,330,0)ど(3460,480,0)よ(3940,270,0)か(4210,90,0)っ(4300,200,0)た(4500,460,0)で(4960,130,0)し(5090,230,0)ょ(5320,490,0)う\n'
  + '[6370,4890](6370,280,0)未(6650,630,0)だ(7280,510,0)に(7790,170,0)あ(7960,120,0)な(8080,510,0)た(8590,520,0)の(9110,210,0)こ(9320,500,0)と(9820,170,0)を(9990,550,0)夢(10540,180,0)に(10720,150,0)み(10870,390,0)る\n'
  + '[11780,5240](11780,450,0)忘(12230,340,0)れ(12570,200,0)た(12770,810,0)物(13580,350,0)を(13930,250,0)取(14180,450,0)り(14630,370,0)に(15000,550,0)帰(15550,380,0)る(15930,150,0)よ(16080,290,0)う(16370,650,0)に';
const YTLRC = '[00:00.830]如果这一切都是梦境该有多好\n[00:06.370]至今仍能与你在梦中相遇\n[00:11.780]如同取回遗忘之物一般';
const YROMA = '[00:00.830]yu me na ra ba do re ho do yo ka tta de sho u\n[00:06.370]i ma da ni a na ta no ko to wo yu me ni mi ru\n[00:11.780]wa su re ta mo no wo to ri ni ka e ru yo u ni';

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9226, path }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

(async () => {
  // 先确认服务器活着——不查的话页面根本没加载，下面每条都会以「元素不存在」为由红，
  // 看起来像功能坏了。（127.0.0.1 不能写成 localhost：这台机器上会被 wslrelay 截胡。）
  await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, r => {
      r.statusCode === 200 ? res() : rej(new Error('server 返回 ' + r.statusCode));
      r.resume();
    }).on('error', () => rej(new Error(`连不上 127.0.0.1:${PORT}，先跑 GRANCYAN_PORT=${PORT} node server.js`)));
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9226',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
    '--user-data-dir=' + require('os').tmpdir() + '\\gc-lyric-smoke',
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(250);
    try { targets = await get('/json/list'); } catch {}
  }
  if (!targets) { console.error('Chrome 没起来'); chrome.kill(); process.exit(1); }

  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  let msgId = 0;
  const pending = new Map();
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const id = ++msgId;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result && r.result.result.value;
  };

  // 等 js/ 全部加载 + boot 跑完。固定睡 2.5s 在机器忙的时候不够（10-14 实测 state 还没定义就开测了）
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { if (await evalJs(`typeof state !== 'undefined' && typeof openMusic === 'function'`)) break; } catch {}
  }
  await sleep(500);

  try {
    // ── 装一首假歌，把播放器换成可控的桩 ──
    // 不真放歌：headless 没有音频设备，而且网易云的地址随时会失效——
    // 那样的话这个测试会因为"外网今天不给面子"而红，跟代码对错无关。
    await evalJs(`(() => {
      _mNow = { id: 'test', name: '冒烟测试', artist: '—', cover: '' };
      _mAudio = { currentTime: 0, paused: false, duration: 300,
                  play: () => {}, pause: () => {}, addEventListener: () => {} };
      // 显式复位这三个开关：下面会调 musicToggleLyricOpt，它会 save() 进 IndexedDB，
      // 而 Chrome 的 user-data-dir 是复用的——不复位的话上一轮的值会被读回来，
      // 这几条断言就变成每跑一次翻一次红绿（查起来像"偶发 bug"，其实是测试自己不幂等）。
      state.musicLyricTrans = true;
      state.musicLyricRoma  = false;
      state.musicVis = 'aurora';
      openMusic();
      _mSetLyric(_mParseWordLyric(${JSON.stringify(YRC)}), true);
      _mAttachAlt(_mLyric.lines, ${JSON.stringify(YTLRC)}, 'tr');
      _mAttachAlt(_mLyric.lines, ${JSON.stringify(YROMA)}, 'ro');
      _mPaintLyric();
      return 1;
    })()`);

    group('[1] 逐字 DOM 结构');
    const lineCount = await evalJs(`document.querySelectorAll('#musicLyric .music-ly-line').length`);
    ok(lineCount === 3, `画出 3 行歌词`, lineCount);
    const w0 = await evalJs(`document.querySelectorAll('#mLy0 .ly-w').length`);
    ok(w0 === 16, `第一行切成 16 个字 span`, w0);
    const dataC = await evalJs(`[...document.querySelectorAll('#mLy0 .ly-w')].map(e=>e.dataset.c).join('')`);
    ok(dataC === '夢ならばどれほどよかったでしょう', 'data-c 拼回整句（亮层内容靠它）', dataC);
    const txt = await evalJs(`document.querySelector('#mLy0 .ly-main').textContent`);
    ok(txt === '夢ならばどれほどよかったでしょう', '底层文字也是整句', txt);

    group('[2] 翻译与罗马音');
    ok(await evalJs(`!!document.querySelector('#mLy0 .ly-tr')`), '翻译行渲染出来了（默认开）');
    const trTxt = await evalJs(`document.querySelector('#mLy0 .ly-tr').textContent`);
    ok(trTxt === '如果这一切都是梦境该有多好', '翻译配到了正确的那一句', trTxt);
    ok(!(await evalJs(`!!document.querySelector('#mLy0 .ly-ro')`)), '罗马音默认关，不渲染');
    await evalJs(`musicToggleLyricOpt('musicLyricRoma', false)`);
    const roTxt = await evalJs(`(document.querySelector('#mLy0 .ly-ro')||{}).textContent`);
    ok(/^yu me na ra ba/.test(roTxt || ''), '打开后罗马音出现且配对正确', roTxt);
    ok(await evalJs(`state.musicLyricRoma === true`), '开关写进了 state（要能落盘）');

    group('[3] 逐字点亮真的在推进');
    // 第一行第 0 个字：830ms 起、380ms 长。推到 1020ms 正好是一半。
    await evalJs(`_mAudio.currentTime = 1.02; _mSyncLyricLine(1.02); _mSyncWords(1.02); 1`);
    ok(await evalJs(`document.querySelector('#mLy0').classList.contains('on')`), '当前行拿到 .on');
    const p0 = await evalJs(`+document.querySelectorAll('#mLy0 .ly-w')[0].style.getPropertyValue('--p')`);
    ok(p0 > 0.4 && p0 < 0.6, `第 0 字点亮到一半（--p=${p0}）`, p0);
    const p1 = await evalJs(`+document.querySelectorAll('#mLy0 .ly-w')[1].style.getPropertyValue('--p')`);
    ok(p1 === 0, '还没唱到的字 --p=0', p1);
    // 亮层是 ::after 用 width:calc(var(--p)*100%) 裁出来的，量它的实际宽度——
    // 只看 --p 的话，CSS 那边写错了照样是绿的。
    const litW = await evalJs(`(() => {
      const el = document.querySelectorAll('#mLy0 .ly-w')[0];
      const after = getComputedStyle(el, '::after');
      // offsetWidth 而不是 getBoundingClientRect：后来加的 Luminous 会把 ly-now 放大 1.13 倍，
      // 包围盒跟着变宽，::after 的 width 却是按没放大的盒子算的，比值永远差一截
      return { w: parseFloat(after.width), full: el.offsetWidth };
    })()`);
    ok(litW.full > 0 && litW.w > 0 && Math.abs(litW.w / litW.full - p0) < 0.06,
       `亮层宽度 ≈ --p × 字宽（${litW.w.toFixed(1)}px / ${litW.full.toFixed(1)}px）`, litW);

    await evalJs(`_mAudio.currentTime = 3.0; _mSyncLyricLine(3.0); _mSyncWords(3.0); 1`);
    const lit = await evalJs(`[...document.querySelectorAll('#mLy0 .ly-w')].map(e=>+e.style.getPropertyValue('--p'))`);
    ok(lit.slice(0, 6).every(v => v === 1), 't=3.0s 时前 6 个字全亮', lit.slice(0, 8));
    ok(lit.slice(8).every(v => v === 0), '后面的字仍然全暗', lit.slice(8));

    group('[4] 切行时上一句要归位');
    await evalJs(`_mAudio.currentTime = 7.0; _mSyncLyricLine(7.0); _mSyncWords(7.0); 1`);
    ok(await evalJs(`document.querySelector('#mLy1').classList.contains('on')`), '.on 移到了第二行');
    ok(!(await evalJs(`document.querySelector('#mLy0').classList.contains('on')`)), '第一行的 .on 摘掉了');
    // seek 回退之后，前面几句不能停在「已唱完」的样子——靠 :not(.on) 挡住亮层
    const hiddenAfter = await evalJs(`getComputedStyle(document.querySelectorAll('#mLy0 .ly-w')[0], '::after').display`);
    ok(hiddenAfter === 'none', '非当前行的亮层被 CSS 挡掉（seek 回退不会留下假的已唱痕迹）', hiddenAfter);

    group('[4b] Luminous 字效：唱到的字真的在放大，切翻译也不丢');
    await evalJs(`_mAudio.currentTime = 1.02; _mSyncLyricLine(1.02); _mSyncWords(1.02); 1`);
    // 放大是走 transition 的（0.18s）。刚 toggle 完 class 就读 computed transform
    // 拿到的是插值起点 matrix(1,0,0,1,0,0)，看着像 CSS 根本没生效——等它跑完再量。
    await sleep(320);
    const lum = await evalJs(`(() => {
      const ws = [...document.querySelectorAll('#mLy0 .ly-w')];
      const now = ws.filter(e => e.classList.contains('ly-now'));
      const cs = getComputedStyle(ws[0]);
      return { nowCount: now.length, nowIsFirst: now[0] === ws[0],
               transform: cs.transform, doneCount: ws.filter(e => e.classList.contains('ly-done')).length };
    })()`);
    ok(lum.nowCount === 1 && lum.nowIsFirst, '正在唱的字有且只有一个带 ly-now', lum);
    // 量真实 transform 矩阵，不是量 class：CSS 选择器写错了 class 照样在
    ok(/^matrix\(1\.1/.test(lum.transform), `当前字真的被放大了（${lum.transform}）`, lum.transform);
    await evalJs(`_mAudio.currentTime = 3.0; _mSyncWords(3.0); 1`);
    const done = await evalJs(`[...document.querySelectorAll('#mLy0 .ly-w')].filter(e=>e.classList.contains('ly-done')).length`);
    ok(done >= 5, `唱过的字带上了余晖 class（${done} 个）`, done);
    // 切翻译会整块重建歌词 DOM，class 全没了。靠 _mPaintLyric 把 _mWordCur 重置成 -1，
    // 让下一次 _mSyncWords 重新 toggle 一遍——不重置的话 cur 没变就不会重画，
    // 当前这个字会一直停在没高亮的样子，直到唱到下一个字才恢复。
    await evalJs(`musicToggleLyricOpt('musicLyricTrans', true); _mTick(); 1`);
    const afterToggle = await evalJs(`(() => {
      const ws = [...document.querySelectorAll('#mLy0 .ly-w')];
      return { wordCur: _mWordCur, now: ws.filter(e => e.classList.contains('ly-now')).length,
               done: ws.filter(e => e.classList.contains('ly-done')).length };
    })()`);
    ok(afterToggle.now === 1 && afterToggle.done >= 5,
      '重建 DOM 后字效立刻恢复（不是等到下一个字）', afterToggle);
    await evalJs(`musicToggleLyricOpt('musicLyricTrans', true); _mTick(); 1`);   // 切回来

    group('[4c] Tilt 错落排版：量真实的缩进和字号');
    await evalJs(`state.musicLyricStyle='tilt'; _mPaintLyric(); _mAudio.currentTime=1.02;
                  _mSyncLyricLine(1.02); _mSyncWords(1.02); 1`);
    await sleep(650);   // 等段浮起动画跑完再量
    const tilt = await evalJs(`(() => {
      const box = document.getElementById('musicLyric');
      const cur = document.getElementById('mLy0');
      const segs = [...cur.querySelectorAll('.ly-seg')];
      const ws = [...cur.querySelectorAll('.ly-w')];
      const cs = segs.map(s => {
        const st = getComputedStyle(s);
        return { ml: parseFloat(st.marginLeft), fs: parseFloat(st.fontSize),
                 italic: st.fontStyle === 'italic', big: s.classList.contains('ly-seg-tilt'), tf: st.transform,
                 left: s.getBoundingClientRect().left };
      });
      return {
        boxTilt: box.classList.contains('ly-tilt'),
        segCount: segs.length,
        wordCount: ws.length,
        // 段里的字拼起来要等于整句——DOM 顺序错了这里就对不上
        joined: ws.map(w => w.dataset.c).join(''),
        segs: cs,
        // 非当前句必须收成一行：缩进归零、不斜
        otherFlat: (() => {
          const o = document.getElementById('mLy1');
          const s = o && o.querySelector('.ly-seg');
          if (!s) return null;
          const st = getComputedStyle(s);
          return { ml: parseFloat(st.marginLeft), italic: st.fontStyle === 'italic',
                   dir: getComputedStyle(o.querySelector('.ly-main')).flexDirection };
        })(),
      };
    })()`);
    ok(tilt.boxTilt, '歌词框挂上了 ly-tilt');
    ok(tilt.segCount >= 2, `当前句拆成了 ${tilt.segCount} 段`, tilt.segCount);
    ok(tilt.wordCount === 16, `逐字 span 一个不少（${tilt.wordCount}/16）`, tilt.wordCount);
    ok(tilt.joined === '夢ならばどれほどよかったでしょう',
      '段内的字拼回整句（DOM 顺序没乱，逐字点亮才不会串段）', tilt.joined);
    // 真的错落：至少两段的左边缘不一样
    const lefts = tilt.segs.map(s => Math.round(s.left));
    ok(new Set(lefts).size >= 2, `各段左边缘确实错开了（${lefts.join(' / ')}px）`, lefts);
    ok(tilt.segs.some(s => s.ml > 4), `有段真的缩进了（marginLeft ${tilt.segs.map(s=>s.ml.toFixed(0)).join('/')}px）`, tilt.segs.map(s=>s.ml));
    // 放大段：字号要明显更大；日文不能斜（宋体斜体是系统层硬拉的伪斜体）
    ok(!tilt.segs.some(s => s.italic), '日文段一段都不斜', tilt.segs.map(s=>s.italic));
    const it = tilt.segs.filter(s => s.big);
    if (it.length) {
      const other = tilt.segs.filter(s => !s.big);
      ok(it.length === 1, '最多一段放大', it.length);
      ok(!other.length || it[0].fs > other[0].fs * 1.2,
        `放大段真的放大了（${it[0].fs.toFixed(1)}px vs ${other.length?other[0].fs.toFixed(1):'—'}px）`, tilt.segs.map(s=>s.fs));
    } else {
      ok(true, '这一句没抽到放大段（72% 概率才有，正常）');
    }
    ok(tilt.segs.some(s => s.tf && s.tf !== 'none'), '段带了微角度', tilt.segs.map(s=>s.tf));
    ok(tilt.otherFlat && tilt.otherFlat.ml === 0 && !tilt.otherFlat.italic && tilt.otherFlat.dir === 'row',
      '非当前句收成一行（不然整屏全是斜的没法读）', tilt.otherFlat);
    // 逐字点亮在 tilt 下照常работа
    const tiltLit = await evalJs(`(() => {
      const ws = [...document.querySelectorAll('#mLy0 .ly-w')];
      return { p0: +ws[0].style.getPropertyValue('--p'),
               now: ws.filter(e => e.classList.contains('ly-now')).length,
               nowIsFirst: ws[0].classList.contains('ly-now') };
    })()`);
    ok(tiltLit.p0 > 0.4 && tiltLit.p0 < 0.6, `Tilt 下逐字点亮照常（--p=${tiltLit.p0}）`, tiltLit);
    ok(tiltLit.now === 1 && tiltLit.nowIsFirst, 'Tilt 下当前字标记也对', tiltLit);
    // 切回经典
    await evalJs(`state.musicLyricStyle='scroll'; _mPaintLyric(); _mTick(); 1`);
    ok(await evalJs(`!document.getElementById('musicLyric').classList.contains('ly-tilt')
                     && document.querySelectorAll('#mLy0 .ly-seg').length === 0`),
       '切回经典滚动，段结构清干净了');

    group('[5] rAF 生命周期（暂停/关面板不能空转）');
    await evalJs(`_mAudio.paused = false; _mLyricLoopSync(); 1`);
    await sleep(120);
    ok(await evalJs(`_mRaf !== 0`), '播放中 rAF 在跑');
    await evalJs(`_mAudio.paused = true; _mLyricLoopSync(); 1`);
    await sleep(120);
    ok(await evalJs(`_mRaf === 0`), '暂停后 rAF 停了');
    await evalJs(`_mAudio.paused = false; _mLyricLoopSync(); 1`);
    await sleep(60);
    await evalJs(`closeMusic(); 1`);
    await sleep(120);
    ok(await evalJs(`_mRaf === 0 && _mVisRaf === 0`), '关掉面板后两个 rAF 都停了');

    group('[6] 沉浸背景真的画了东西');
    await evalJs(`openMusic(); musicToggleLyricsFull(true); 1`);
    await sleep(500);
    ok(await evalJs(`document.getElementById('musicVis').classList.contains('on')`), '全屏模式下画布启用');
    const px = await evalJs(`(() => {
      const cv = document.getElementById('musicVis');
      if (!cv.width || !cv.height) return { err: 'canvas 尺寸为 0' };
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0, maxc = 0;
      for (let i = 0; i < d.length; i += 4) {
        const m = Math.max(d[i], d[i+1], d[i+2]);
        if (m > 24) lit++;
        if (m > maxc) maxc = m;
      }
      return { lit, total: d.length / 4, maxc, w: cv.width, h: cv.height };
    })()`);
    ok(!px.err && px.lit > px.total * 0.2, `画布上有大片着色像素（${px.lit}/${px.total}）`, px);
    ok(px.maxc > 40 && px.maxc < 210, `最亮处既不是全黑也没过曝（${px.maxc}）——底色必须压得住歌词`, px.maxc);
    // 几何模式：不能只验"画了东西"，得验真的有线条。
    // 极光是几团弥散的光晕，几何是带边的图形——如果 geo 分支根本没接上，
    // 画出来的还是极光，像素数照样过关，所以这里量的是**边缘强度**。
    await evalJs(`state.musicVis='geo'; _mVisSync(); 1`);
    await sleep(400);
    const geoPx = await evalJs(`(() => {
      const cv = document.getElementById('musicVis');
      if (!cv.width || !cv.height) return { err: 'canvas 尺寸为 0' };
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      // 横向一阶差分：线框会留下一圈陡变，弥散光晕不会
      let edges = 0, maxc = 0;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 1; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4, j = i - 4;
          const a = Math.max(d[i], d[i+1], d[i+2]), b = Math.max(d[j], d[j+1], d[j+2]);
          if (Math.abs(a - b) > 12) edges++;
          if (a > maxc) maxc = a;
        }
      }
      return { edges, total: cv.width * cv.height, maxc };
    })()`);
    ok(!geoPx.err && geoPx.edges > 200, `几何模式画出了真的线条（陡变像素 ${geoPx.edges}）`, geoPx);
    ok(geoPx.maxc > 40 && geoPx.maxc < 210, `几何模式也压得住亮度（${geoPx.maxc}）`, geoPx.maxc);
    // 对照组：同一把尺子量极光，边缘应该明显更少——证明上面量到的确实是几何而不是"任何画面都过"
    await evalJs(`state.musicVis='aurora'; _mVisSync(); 1`);
    await sleep(400);
    const auroraEdges = await evalJs(`(() => {
      const cv = document.getElementById('musicVis');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let edges = 0;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 1; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4, j = i - 4;
          const a = Math.max(d[i], d[i+1], d[i+2]), b = Math.max(d[j], d[j+1], d[j+2]);
          if (Math.abs(a - b) > 12) edges++;
        }
      }
      return edges;
    })()`);
    ok(geoPx.edges > auroraEdges * 3,
      `几何的边缘远多于极光（${geoPx.edges} vs ${auroraEdges}）——两个模式真的不一样`,
      { geo: geoPx.edges, aurora: auroraEdges });

    // 轮换一圈回到关：现在是四档，不再是"点一下就关"
    const cycle = await evalJs(`(() => {
      state.musicVis = 'aurora';
      const seen = [];
      for (let i = 0; i < 4; i++) { musicCycleVis(); seen.push(state.musicVis); }
      return seen;
    })()`);
    ok(JSON.stringify(cycle) === JSON.stringify(['fluid', 'geo', 'off', 'aurora']),
      '背景四档轮换一圈回到原点', cycle);
    await evalJs(`state.musicVis='off'; _mVisSync(); 1`);
    await sleep(200);
    ok(await evalJs(`_mVisRaf === 0`), '关掉背景后 rAF 停了');

    group('[6b] 封面流体：真挂上了模糊层，且压得住');
    // 同源 data: URI 封面——真封面跨域会 taint canvas，验不了降采样这条路
    const cover = `(() => {
      const c = document.createElement('canvas'); c.width = c.height = 600;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 600);       // 白底：最危险的一类
      x.fillStyle = '#e33'; x.fillRect(0, 0, 300, 300);
      return c.toDataURL('image/png');
    })()`;
    const small = await evalJs(`(async () => {
      const u = await _mDownscale(${cover}, 384);
      if (!u) return { err: '降采样返回 null（同源图不该失败）' };
      const im = new Image(); im.src = u;
      await im.decode();
      return { w: im.naturalWidth, h: im.naturalHeight, isJpeg: u.startsWith('data:image/jpeg') };
    })()`);
    ok(!small.err && small.w === 384 && small.h === 384,
      `模糊源被缩到 384px（${small.w}×${small.h}）——大图纹理分块上传才是栅格闪烁的根`, small);
    ok(small.isJpeg, '降采样输出 jpeg（png 会让 dataURL 大好几倍）', small);

    await evalJs(`state.musicVis='fluid'; _mNow = _mNow || { id: 1, name: 't', artist: 'a' };
                  _mNow.cover = ${cover}; _mFluidUrl = null; _mVisSync(); 1`);
    await sleep(1200);
    const fluid = await evalJs(`(() => {
      const box = document.getElementById('musicFluid');
      const layer = box.querySelector('.music-fluid-layer');
      const img = box.querySelector('.music-fluid-img');
      if (!img) return { err: '没有挂上封面层' };
      const cs = getComputedStyle(img);
      return {
        boxOn: box.classList.contains('on'),
        layerOn: layer.classList.contains('on'),
        layers: box.children.length,
        filter: cs.filter,
        objectFit: cs.objectFit,
        raf: _mVisRaf,
        w: img.getBoundingClientRect().width,
      };
    })()`);
    ok(!fluid.err && fluid.boxOn && fluid.layerOn, 'fluid 层挂上并淡入完成', fluid);
    ok(fluid.filter === 'blur(40px)', `模糊真的生效（${fluid.filter}）`, fluid.filter);
    ok(fluid.w > 100, '封面层铺满了面板（不是 0 宽的隐形层）', fluid.w);
    ok(fluid.raf === 0, 'fluid 模式下 canvas 的 rAF 没有空转', fluid.raf);
    // 换歌只该留一层：不修剪的话每换一首多压一张模糊图，越堆越卡
    await evalJs(`(() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d'); x.fillStyle = '#08f'; x.fillRect(0,0,64,64);
      _mFluidSet(c.toDataURL('image/png')); return 1;
    })()`);
    await sleep(2200);
    const layersAfter = await evalJs(`document.getElementById('musicFluid').children.length`);
    ok(layersAfter === 1, `换封面后旧层被清掉（还剩 ${layersAfter} 层）`, layersAfter);

    // ── 坏封面不许把好封面一起带走（Codex 逮到的第 1 条）──
    // A 正常 → B 是坏图。B 的 onerror 摘掉自己之后，decode 的 reject 仍会调 reveal；
    // 修之前 reveal 里的 while 会因为「wrap 已经不在 box 里」而一路删到空，
    // 于是 A 也没了，背景变成一片死黑。整个过程零报错。
    // ⚠️ 坏图必须用**真的 404 URL**，不能用畸形的 data URI：
    // 畸形 dataURI 的 img.decode() 在 Chrome 里既不 resolve 也不 reject，永远挂着，
    // reveal 压根不会跑——这条测试就变成了"什么都没测"（第一版就是这样，对照组逮出来的）。
    const broken = await evalJs(`(async () => {
      const box = document.getElementById('musicFluid');
      // 用 DOM 引用认层，不比 src：_mDownscale 会把 png 转成 jpeg，
      // 拿原 URL 去比对永远匹配不上，断言就恒真了（同一个假绿，踩了两次）
      const goodLayer = box.querySelector('.music-fluid-layer');
      _mFluidSet(location.origin + '/no-such-cover-' + Date.now() + '.jpg');
      // 等 onerror 真的落地（_mFluidUrl 被清空），而不是拍脑袋 sleep 一个数——
      // 固定等待会让这条断言随机红绿，查起来像"偶发 bug"其实是测试自己不稳。
      for (let i = 0; i < 100 && _mFluidUrl !== null; i++) await new Promise(r => setTimeout(r, 50));
      const errored = _mFluidUrl === null;
      await new Promise(r => setTimeout(r, 2000));   // 再跨过 1600ms 那个修剪定时器
      return {
        layers: box.children.length,
        errored,
        stillHasGood: !!goodLayer && goodLayer.parentNode === box,
        fluidUrl: _mFluidUrl,
      };
    })()`);
    ok(broken.layers >= 1 && broken.stillHasGood,
      `坏封面没把好封面带走（还剩 ${broken.layers} 层，好层还在）`, broken);
    ok(broken.fluidUrl === null,
      '加载失败后 _mFluidUrl 被清空（否则同一首歌永远不再重试）', broken.fluidUrl);

    // ── 换歌卡在 rAF 那一帧里（Codex 逮到的第 2 条）──
    // reveal 里第一次代际检查通过后要等一整帧才真正淡入。修之前 rAF 回调里
    // 没有第二次检查，在这个窗口换歌，旧封面照样会淡进来盖住新歌。
    const raced = await evalJs(`(async () => {
      const box = document.getElementById('musicFluid');
      box.innerHTML = ''; _mFluidUrl = null;
      const mk = (c, n) => { const cv = document.createElement('canvas'); cv.width = cv.height = n;
        const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0,0,n,n); return cv.toDataURL('image/png'); };
      const A = mk('#f00', 40), B = mk('#0f0', 40);
      // 先把页面上其它 rAF 源全停掉（歌词逐字 + 画布流光）。
      // 不停的话 held 里混进来的可能是它们的回调，"等到 held 非空"就等错了东西——
      // A 的 reveal 其实还没排上，切 B 之后它会被 rAF **外面**那次代际检查撤掉，
      // 于是就算把要守的"rAF 内第二次检查"删掉，三条断言照样全绿。（Codex 二审逮到的）
      // musicVis 要先切走：留在 'fluid' 的话 _mVisSync 自己会按 _mNow.cover 再补拉
      // 一趟 _mFluidSet（上一段刚把 _mFluidUrl 清成 null，幂等挡不住）。
      _mAudio.paused = true; state.musicVis = 'off';
      _mLyricLoopSync(); _mVisSync();
      await new Promise(r => setTimeout(r, 300));
      box.innerHTML = '';                // 清掉遗留的层，aLayer 只可能是 A 的

      // 页面上有常驻的动画循环（14-boot-brain-hub 的 tick）每帧都在排 rAF，
      // 所以"扣住第一个进来的"根本分不出那是不是 A 的淡入帧——
      // 扣错了的话，A 的 reveal 会晚一步、被 rAF **外面**那次代际检查撤掉，
      // 于是就算把要守的"rAF 内第二次检查"删掉，断言照样全绿。（Codex 二审逮到的）
      // 改成按调用栈认领：只有 24-music.js 里的 reveal 才是我们要的那一帧，
      // 别人的照常放行，页面不至于因为被扣住而僵掉。
      // 认领条件要精确到**函数**，不能只认文件：24-music.js 里还有别的地方排 rAF
      // （_mVisFrame、musicToggleLyricsFull 里的 _mTick…）。只认文件的话，
      // 抢先被扣住的可能是它们，而 A 真正的 reveal 反倒被放行、在 rAF 外面那次
      // 代际检查处撤走——删掉要守的第二次检查，断言照样全绿。（Codex 三审逮到的）
      const realRaf = window.requestAnimationFrame;
      let captured = null, capStack = '';
      window.requestAnimationFrame = cb => {
        const st = (new Error()).stack || '';
        // ⚠️ 这段是模板字符串，别在这里写 /at reveal\\b/ 那种正则——模板里的 \\b
        // 会被当成退格符 U+0008，正则永远匹配不上，captured 一直是 null（踩过）。
        if (!captured && st.includes('at reveal (') && st.includes('24-music.js')) {
          captured = cb; capStack = st; return 0;
        }
        return realRaf(cb);
      };
      _mFluidSet(A);
      for (let i = 0; i < 120 && !(box.children.length && captured); i++) {
        await new Promise(r => setTimeout(r, 25));
      }
      // 拿元素引用，不拿 src：降采样把 png 转成了 jpeg，比 src 永远比不中
      const aLayer = box.querySelector('.music-fluid-layer');
      const heldA = captured ? 1 : 0;
      const held = captured ? [captured] : [];
      _mFluidSet(B);                     // 就在这一帧的缝里换歌
      window.requestAnimationFrame = realRaf;
      held.forEach(cb => cb());          // 放行 A 那一帧
      await new Promise(r => setTimeout(r, 300));
      return { heldA, hasA: !!aLayer, capFrame: capStack.replace(/\\s+/g, ' ').slice(0, 220),
               aStillThere: !!aLayer && aLayer.parentNode === box,
               aFadedIn: !!aLayer && aLayer.classList.contains('on') };
    })()`);
    ok(raced.hasA && raced.heldA === 1 && /reveal/.test(raced.capFrame),
      `扣住的确实是 A 的 reveal 那一帧（${raced.capFrame}）——测试本身有效`, raced);
    ok(!raced.aFadedIn, '在 rAF 窗口里换歌，旧封面不会淡进来', raced);
    ok(!raced.aStillThere, '被取代的那层自己撤走了，没有留在 DOM 里', raced);

    await evalJs(`_mFluidSet(null); state.musicVis='off'; _mVisSync(); 1`);

    group('[7] TTML（浏览器才有 DOMParser，单测那边验不了）');
    const ttml = await evalJs(`(() => {
      const x = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
        + '<p begin="00:00:01.000" end="00:00:03.000">'
        + '<span begin="00:00:01.000" end="00:00:02.000">Hel</span>'
        + '<span begin="00:00:02.000" end="00:00:03.000">lo</span></p>'
        + '<p begin="4s" end="6s">plain line</p></div></body></tt>';
      const r = _mParseTtml(x);
      return r.map(l => ({ t: l.t, end: l.end, txt: l.txt, n: l.words.length }));
    })()`);
    ok(ttml.length === 2, 'TTML 解析出 2 行', ttml);
    ok(ttml[0].txt === 'Hello' && ttml[0].n === 2, '第一行逐字切成 2 段并拼回 Hello', ttml[0]);
    ok(ttml[0].t === 1 && ttml[0].end === 3, '时钟写法 00:00:01.000 → 1s', ttml[0]);
    ok(ttml[1].t === 4 && ttml[1].end === 6, '偏移写法 4s / 6s 也认', ttml[1]);
    const sniff = await evalJs(`(() => {
      const x = '<tt><body><div><p begin="1s" end="2s">hi</p></div></body></tt>';
      const r = _mSniffLyric(x); return r ? r.length : 0;
    })()`);
    ok(sniff === 1, '格式嗅探认得出 TTML', sniff);

    group('[9] 封面取色：任何封面都必须压成深色');
    // 白底封面是最危险的一类：不压的话整块屏幕会被刷成灰白，歌词直接看不见。
    // 用 data: URI 造图——同源，不会 taint canvas，验的是取色算法本身。
    const mkImg = (r, g, b) => `(() => {
      const c = document.createElement('canvas'); c.width = c.height = 8;
      const x = c.getContext('2d'); x.fillStyle = 'rgb(${r},${g},${b})';
      x.fillRect(0, 0, 8, 8); return c.toDataURL();
    })()`;
    const tintOf = async (r, g, b) => evalJs(`(async () => {
      _mCoverTint(${mkImg(r, g, b)});
      for (let i = 0; i < 40 && !_mTint; i++) await new Promise(r => setTimeout(r, 25));
      return _mTint ? _mTint[0] : null;
    })()`);
    const white = await tintOf(255, 255, 255);
    ok(white && Math.max(...white) <= 130, `纯白封面被压成深色 rgb(${white})`, white);
    const neon = await tintOf(255, 40, 200);
    ok(neon && Math.max(...neon) <= 130, `亮粉封面也压得住 rgb(${neon})`, neon);
    ok(neon && neon[0] > neon[1] && neon[2] > neon[1], '压暗之后仍保留色相（不是压成灰）', neon);
    // 最狠的一条：白封面 + 流光全开，量整块画布最亮的像素
    await evalJs(`state.musicVis='aurora'; openMusic(); musicToggleLyricsFull(true); _mVisSync(); 1`);
    await evalJs(`_mCoverTint(${mkImg(255, 255, 255)}); 1`);
    await sleep(600);
    const maxWhite = await evalJs(`(() => {
      const cv = document.getElementById('musicVis');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i], d[i+1], d[i+2]);
      return m;
    })()`);
    ok(maxWhite < 190, `白封面下画布最亮像素仍是深色（${maxWhite}/255）`, maxWhite);
    await evalJs(`_mTint = null; _mApplyTint(); musicToggleLyricsFull(false); 1`);

    group('[8] 没有歌词时不炸');
    await evalJs(`_mSetLyric([], false); _mPaintLyric(); 1`);
    ok(await evalJs(`!!document.querySelector('.music-ly-none')`), '空歌词显示「没有歌词」');
    await evalJs(`_mSyncLyricLine(5); _mSyncWords(5); _mTick(); 1`);
    ok(true, '空歌词下推时间不抛异常');

    const errs = await evalJs(`(window.__smokeErrors || []).length`);
    ok(!errs, '页面上没有未捕获异常', errs);
  } catch (e) {
    fail++;
    console.log('  ✗ 冒烟过程中抛异常: ' + e.message);
  }

  ws.close();
  chrome.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
