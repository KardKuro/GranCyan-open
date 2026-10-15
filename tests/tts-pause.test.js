'use strict';
// 朗读的暂停 / 继续（用户提的：「语音没法暂停」）
//
// 原来只有「停止」：再点一次是 pause() + src='' + 对象置 null —— 那是**销毁**。
// 念到一半想停一下，再点就得重新请求一次 TTS、从头念，而且完全不报错，
// 看起来就像「暂停功能坏了」。
//
// 这份测试守三件事：暂停真的保住了播放位置、按钮文案和实际状态一致、
// 浏览器合成那条路暂停太久不会假装在播。
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
const src = read('js/07-band-tts.js');
const render = read('js/06-render-msg.js');

function sandbox(opts = {}) {
  const calls = [];
  const revoked = [];
  // opts.holdPlay：把 play() 的 promise 扣住不结算，交给测试自己决定什么时候
  // resolve / reject —— 「音频已经建好、play() 晚一步才失败」那段窗口只能这么造。
  const playCtl = [];
  class FakeAudio {
    constructor(s) { this.src = s; this.paused = true; this.currentTime = 0; calls.push('new'); }
    play() {
      this.paused = false; calls.push('play');
      if (!opts.holdPlay) return Promise.resolve();
      return new Promise((res, rej) => playCtl.push({ res, rej, audio: this }));
    }
    pause() { this.paused = true; calls.push('pause'); }
  }
  const btns = {};
  const gone = new Set();
  const synth = {
    speaking: false, paused: false, _n: 0, _all: [], _last: null,
    speak(u) { this.speaking = true; this.paused = false; this._last = u; this._all.push(u); calls.push('synth.speak'); },
    pause() { this.paused = true; calls.push('synth.pause'); },
    resume() { this.paused = false; calls.push('synth.resume'); },
    cancel() { this.speaking = false; this.paused = false; calls.push('synth.cancel'); },
    getVoices: () => []
  };
  const box = {
    state: { ttsVoice: 'v', ttsRate: 0 },
    showToast: () => {}, SERVER_BASE: opts.noServer ? '' : 'http://127.0.0.1:3000',
    document: {
      getElementById: (id) => {
        if (!id.startsWith('tts-btn-')) return null;
        // 这条消息已经不在视图里了（切走 / 被删 / 分支换掉）—— 真 DOM 就是返回 null
        if (gone.has(id)) return null;
        if (!btns[id]) btns[id] = { textContent: '🔊 朗读' };
        return btns[id];
      }
    },
    Audio: FakeAudio,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => revoked.push(u) },
    getActiveChat: () => ({ nodes: { 1: { content: '第一条' }, 2: { content: '第二条' } } }),
    getMsgPlainText: (n) => n.content,
    SpeechSynthesisUtterance: function (txt) { this.text = txt; },
    fetch: () => opts.ttsFail
      ? Promise.reject(new Error('no server'))
      : Promise.resolve({ ok: true, blob: () => Promise.resolve({ size: 9999 }) }),
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout, clearTimeout, Math, Date, JSON, console, Object, Array, String,
    Number, Boolean, RegExp, Set, Promise, parseInt, isNaN
  };
  box.window = box;
  box.speechSynthesis = synth;
  vm.createContext(box);
  vm.runInContext(src
    + ';this.toggleSpeak=toggleSpeak;this._ttsState=_ttsState;this.ttsSyncBtn=ttsSyncBtn;'
    + 'this.TTS_LABEL=TTS_LABEL;this.__pausedAt=()=>_ttsPausedAt;this.__setPausedAt=(v)=>{_ttsPausedAt=v};'
    + 'this.__audio=()=>_ttsAudio;', box);
  box.__calls = calls; box.__btns = btns; box.__synth = synth; box.__revoked = revoked;
  box.__play = playCtl;
  // 模拟「重画之后这条消息不在视图里了」：真 DOM 里 getElementById 就是返回 null
  box.__gone = (id) => gone.add('tts-btn-' + id);
  // ⚠️ 懒创建的假按钮：没被 getElementById 摸过的话 btns 里还没有它，
  //    直接读会得到 undefined —— 那是**测试自己的**毛病，不是代码没设文案。
  //    统一走一次 getElementById，跟真实 DOM 的行为对齐。
  box.__btn = (id) => box.document.getElementById('tts-btn-' + id).textContent;
  return box;
}
const wait = () => new Promise(r => setTimeout(r, 30));
function funcBody(src2, name) {
  const i = src2.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < src2.length; j++) {
    const c = src2[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src2.slice(i, j + 1); }
  }
  return '';
}

(async () => {
  console.log('\n【一】暂停是暂停，不是销毁');

  {
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    t('★ 点一下开始念', S._ttsState(1) === 'playing', S._ttsState(1));
    const audio1 = S.__audio();

    S.toggleSpeak(1);
    t('★ 再点变成暂停', S._ttsState(1) === 'paused', S._ttsState(1));
    // ⚠️ 关键：暂停之后音频对象**还在**，src 也没被清空。
    //    原来这里是 pause()+src=''+null，位置全丢，继续等于从头。
    t('★ 音频对象没被丢掉', S.__audio() === audio1 && !!S.__audio());
    t('★ src 也没被清空', !!S.__audio().src, S.__audio().src);

    S.toggleSpeak(1); await wait();
    t('★ 三点回到播放', S._ttsState(1) === 'playing');
    t('★ 全程只 new 过一个 audio（没重新请求 TTS）',
      S.__calls.filter(c => c === 'new').length === 1, S.__calls.join(' → '));
    t('★ 调用序列就是 播-停-播', S.__calls.join(',').includes('play,pause,play'), S.__calls.join(' → '));
  }

  console.log('\n【二】按钮文案必须跟状态一致（它是唯一的状态显示）');

  {
    const S = sandbox();
    t('★ 一开始是「朗读」', S.__btn(1) === S.TTS_LABEL.idle, S.__btn(1));
    S.toggleSpeak(1); await wait();
    t('★ 念着的时候显示「暂停」', S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));
    S.toggleSpeak(1);
    t('★ 停下之后显示「继续」', S.__btn(1) === S.TTS_LABEL.paused, S.__btn(1));
    S.toggleSpeak(1); await wait();
    t('★ 再点回到「暂停」', S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));
  }

  {
    // ⚠️ 消息列表一重画，按钮就是新元素、文案回到「朗读」，而音频还在响。
    //    她看到「朗读」，点一下反而从头念一遍，旧的那路也还在放。
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    S.__btns['tts-btn-1'].textContent = '🔊 朗读';     // 模拟重画
    S.ttsSyncBtn();
    t('★ 重画之后文案被补回「暂停」', S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));

    S.toggleSpeak(1);                                   // 停一下
    S.__btns['tts-btn-1'].textContent = '🔊 朗读';
    S.ttsSyncBtn();
    t('★ 暂停中重画，补回的是「继续」', S.__btn(1) === S.TTS_LABEL.paused, S.__btn(1));
  }

  {
    const S = sandbox();
    S.ttsSyncBtn();
    t('★ 没在念的时候同步不炸也不乱改', S.__btn(1) === S.TTS_LABEL.idle);
  }

  t('★ 渲染完会调一次同步（不然重画就丢状态）',
    /ttsSyncBtn\(\)/.test(render), false);

  console.log('\n【三】换一条要真的停掉上一条');

  {
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    const a1 = S.__audio();
    S.toggleSpeak(2); await wait();
    t('★ 上一条的音频被释放了', a1.src === '' && a1.paused, { src: a1.src, paused: a1.paused });
    t('★ 上一条的按钮回到「朗读」', S.__btn(1) === S.TTS_LABEL.idle, S.__btn(1));
    t('★ 新的那条在念', S._ttsState(2) === 'playing');
    t('★ objectURL 被回收（不然一直攒着）', S.__revoked.length >= 1, S.__revoked);
  }

  {
    // 暂停中切到别条，也要把暂停那条真的释放掉
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    S.toggleSpeak(1);                     // 暂停
    const a1 = S.__audio();
    S.toggleSpeak(2); await wait();
    t('★ 暂停中的那条切走时也被释放', a1.src === '', a1.src);
    t('★ 而且状态归零', S._ttsState(1) === 'idle');
  }

  console.log('\n【四】浏览器合成那条路：停久了别假装在播');

  {
    const S = sandbox({ ttsFail: true });
    S.toggleSpeak(1); await wait();
    t('★ 拿不到服务端 TTS 就回退浏览器合成', S.__synth.speaking === true, S.__calls.join(' → '));
    t('★ 文案是「暂停」', S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));

    S.toggleSpeak(1);
    t('★ 停一下走的是 synth.pause', S.__synth.paused === true);
    t('★ 文案变「继续」', S.__btn(1) === S.TTS_LABEL.paused);

    S.toggleSpeak(1);
    t('★ 马上继续走的是 synth.resume', S.__synth.paused === false
      && S.__calls.includes('synth.resume'), S.__calls.join(' → '));
  }

  {
    // ⚠️ Chrome 上 speechSynthesis 暂停十几秒后 utterance 会被系统回收，
    //    resume() 调了没声音也不报错 —— 按钮显示「播放中」，其实什么都没有。
    const S = sandbox({ ttsFail: true });
    S.toggleSpeak(1); await wait();
    S.toggleSpeak(1);                       // 暂停
    S.__setPausedAt(Date.now() - 60000);    // 假装停了一分钟
    S.__calls.length = 0;
    S.toggleSpeak(1); await wait();
    t('★ 停太久 → 不 resume，重新念一遍（有声音好过假装在播）',
      !S.__calls.includes('synth.resume') && S.__calls.includes('synth.cancel'),
      S.__calls.join(' → '));
    t('★ 而且确实又念起来了', S.__synth.speaking === true);
  }

  console.log('\n【五】加载中重复点击（Codex 四审逮到的）');

  {
    // ⚠️ 「正在取音频」原来只活在按钮文案里、不在状态机里。
    //    请求还没回来时再点一下，_ttsState 说 idle，于是又发一个请求 ——
    //    两个回调的 nodeId 都对得上，各自 new 一个 Audio 同时播，
    //    后一个覆盖 _ttsAudio，前一个变成控制不了也回收不掉的野音频。
    const S = sandbox();
    vm.runInContext('fetch = () => new Promise(r => { this.__resolve = r; });', S);
    S.toggleSpeak(1);
    t('⚑ 取音频的过程也是一种状态', S._ttsState(1) === 'loading', S._ttsState(1));
    t('⚑ 按钮显示「加载…」', S.__btn(1) === S.TTS_LABEL.loading, S.__btn(1));

    S.toggleSpeak(1);                     // 加载中再点
    t('⚑ 加载中再点 = 取消，不是再发一个请求', S._ttsState(1) === 'idle', S._ttsState(1));
    S.__resolve({ ok: true, blob: () => Promise.resolve({ size: 9999 }) });
    await wait();
    t('⚑ 取消之后回来的那份不会自己播起来',
      S.__calls.filter(c => c === 'new').length === 0, S.__calls.join(' → '));
    t('⚑ 按钮回到「朗读」', S.__btn(1) === S.TTS_LABEL.idle, S.__btn(1));
  }

  {
    // ⚑⚑ 守卫**必须**认 token，不能认 nodeId。
    //    上面那一段（点开→取消）用 nodeId 当判据也照样绿 —— 因为取消那条路顺手
    //    把 _ttsNodeId 也置空了，两个判据在那里恰好同真同假，是第二道防线盖住了。
    //    真正能把它们分开的是「点开→取消→再点开同一条」：nodeId 前后完全一样，
    //    认 nodeId 的话第一次请求回来照样播，和第二次的声音叠在一起，
    //    而 _ttsAudio 只留得住后一个 —— 前一个变成停不掉也回收不掉的野音频。
    const S = sandbox();
    vm.runInContext('__rs = []; fetch = () => new Promise(r => { this.__rs.push(r); });', S);
    const ok = () => ({ ok: true, blob: () => Promise.resolve({ size: 9999 }) });
    S.toggleSpeak(1);                     // 第一次请求
    S.toggleSpeak(1);                     // 取消
    S.toggleSpeak(1);                     // 再点同一条 → 第二次请求
    t('⚑ 确实发了两次请求', S.__rs.length === 2, S.__rs.length);
    S.__rs[0](ok()); await wait();
    t('⚑⚑ 取消掉的那次回来了也不许播（同一条消息，只有 token 分得开）',
      S.__calls.filter(c => c === 'new').length === 0, S.__calls.join(' → '));
    S.__rs[1](ok()); await wait();
    t('⚑ 后点的那次正常播', S.__calls.filter(c => c === 'new').length === 1, S.__calls.join(' → '));
  }

  {
    // ⚑⚑ Codex 六审：token 守卫只挡住了「拿到 blob 那一刻」，
    //    **挡不住 play() 之后的晚到回调**（play 的 promise、onerror、onended）。
    //    它们捕获的是 nodeId，而这个场景里前后两次的 nodeId 一模一样。
    //    真实窗口：音频已经建好、play() 还没结果时她停掉又重念同一条；
    //    旧的那次这时才失败 → 把新那次的按钮打回「朗读」，
    //    再把**旧文本**丢给浏览器合成 → 两路叠播，按钮却显示空闲。
    const S = sandbox({ holdPlay: true });
    vm.runInContext('__rs = []; fetch = () => new Promise(r => { this.__rs.push(r); });', S);
    const ok = () => ({ ok: true, blob: () => Promise.resolve({ size: 9999 }) });
    S.toggleSpeak(1);
    S.__rs[0](ok()); await wait();
    t('⚑ 第一次已经在播（play 的 promise 还挂着）', S._ttsState(1) === 'playing', S._ttsState(1));
    S.ttsStopSpeaking();                  // 停掉
    S.toggleSpeak(1);                     // 重新念同一条
    S.__rs[1](ok()); await wait();
    t('⚑ 第二次也播起来了', S._ttsState(1) === 'playing', S._ttsState(1));
    S.__play[0].rej(new Error('late play failure'));   // 旧那次现在才失败
    await wait();
    t('⚑⚑ 旧请求的 play 失败不许把新请求的按钮打回「朗读」',
      S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));
    t('⚑⚑ 也不许拿旧文本去浏览器合成（那会变成两路叠播）',
      S.__synth.speaking === false, S.__calls.join(' → '));
    t('⚑ 新那一路还在播', S._ttsState(1) === 'playing', S._ttsState(1));
  }

  {
    // 七审：暂停后「继续」的 play Promise 也会晚到，窗口跟首次 play 完全一样。
    const S = sandbox({ holdPlay: true });
    S.toggleSpeak(1); await wait();
    S.__play[0].res(); await wait();             // 首次播放已经成功
    S.toggleSpeak(1);                            // pause
    S.toggleSpeak(1);                            // resume，第二个 play Promise 挂住
    S.ttsStopSpeaking();
    S.toggleSpeak(1); await wait();              // 同一 nodeId 开始第三路
    const newest = S.__audio();
    S.__play[1].rej(new Error('late resume failure'));
    await wait();
    t('⚑⚑ 暂停后继续的旧 play 失败，不许停掉同 nodeId 的新音频',
      S.__audio() === newest && S._ttsState(1) === 'playing', S.__calls.join(' → '));
    t('⚑⚑ 旧 resume Promise 也不许把新按钮打回「朗读」',
      S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));
  }

  {
    // 七审：浏览器 utterance 的 onend/onerror 同样会在 cancel 后晚到。
    const S = sandbox({ ttsFail: true });
    S.toggleSpeak(1); await wait();
    const old = S.__synth._last;
    S.ttsStopSpeaking();
    S.toggleSpeak(1); await wait();
    const newest = S.__synth._last;
    old.onerror(new Error('late utterance error'));
    t('⚑⚑ 旧 utterance 的回调不许重置同 nodeId 的新朗读',
      newest !== old && S._ttsState(1) === 'playing' && S.__btn(1) === S.TTS_LABEL.playing,
      { 状态: S._ttsState(1), 按钮: S.__btn(1) });
  }

  {
    // ⚑⚑ Codex 五审复现的：后端回 200 但音频是空的（blob < 200 字节）。
    //    原来的写法是「先清 _ttsLoading，再验 blob」，于是那一 throw 落进 catch 时
    //    守卫 `_ttsLoading !== nodeId` 成立、直接 return —— 不回退浏览器合成，
    //    按钮永久停在「加载…」，内部状态却是 idle。他跑出来的是：
    //      state=idle / button=⏳ 加载… / loading=null / audio=false
    //    我原来的测试只喂过正常的 blob，所以覆盖不到这条。
    const S = sandbox();
    vm.runInContext('fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({ size: 12 }) });', S);
    S.toggleSpeak(1); await wait();
    t('⚑⚑ 空音频要回退到浏览器合成，不能卡在「加载…」',
      S.__synth.speaking === true, { 状态: S._ttsState(1), 按钮: S.__btn(1) });
    t('⚑⚑ 按钮不许停在「加载…」', S.__btn(1) !== S.TTS_LABEL.loading, S.__btn(1));
    t('⚑ 而且状态和按钮对得上',
      S._ttsState(1) === 'playing' && S.__btn(1) === S.TTS_LABEL.playing,
      { 状态: S._ttsState(1), 按钮: S.__btn(1) });
  }

  {
    // HTTP 错误那条路本来就该回退，一并守住（别让 token 那个改动把它弄坏）
    const S = sandbox();
    vm.runInContext('fetch = () => Promise.resolve({ ok: false, status: 502 });', S);
    S.toggleSpeak(1); await wait();
    t('⚑ 服务端 502 也回退浏览器合成', S.__synth.speaking === true, S.__btn(1));
  }

  console.log('\n【六】切对话 / 删消息 / 重新生成都要叫停');

  {
    // ⚑⚑⚑ 这一段守的是**保证**，下面那份入口清单只是提前量。
    //   枚举入口这条路本身就是错的：我数了七个以为齐了，Codex 六审又找出三个，
    //   顺着 activeChatId 还能再找出两个（回收站恢复对话、建群聊）。
    //   真正的判据只有一个 —— 重画完，承载暂停按钮的那条消息还在不在视图里。
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    const a1 = S.__audio();
    t('⚑ 前提：确实在播', S._ttsState(1) === 'playing' && !a1.paused);
    S.__gone(1);                      // 这条消息被切走了 / 删了 / 换分支了
    S.ttsSyncBtn();                   // renderMessages() 末尾会调它
    t('⚑⚑⚑ 消息不在视图里了 → 自己停掉，不管是从哪个入口走的',
      a1.paused === true, S.__calls.join(' → '));
    t('⚑⚑⚑ 而且释放了 src（不然那段音频永远回收不掉）', a1.src === '', a1.src);
    t('⚑⚑⚑ 内部状态也回到空闲', S._ttsState(1) === 'idle', S._ttsState(1));
  }

  {
    // 反面对照：消息还在视图里的时候，重画**不许**把她正在听的停掉。
    // 只测「该停的停了」的话，一个「每次重画都停」的实现也能全绿。
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    const a1 = S.__audio();
    S.ttsSyncBtn();
    t('⚑ 消息还在 → 重画不许打断', a1.paused === false && S._ttsState(1) === 'playing', S.__calls.join(' → '));
    t('⚑ 而且把按钮文案补回「暂停」', S.__btn(1) === S.TTS_LABEL.playing, S.__btn(1));
  }

  {
    // 浏览器合成那一路也归同一条判据管（它没有 _ttsAudio，走的是 speechSynthesis）
    const S = sandbox({ ttsFail: true });
    S.toggleSpeak(1); await wait();
    t('⚑ 前提：回退到浏览器合成了', S.__synth.speaking === true);
    S.__gone(1);
    S.ttsSyncBtn();
    t('⚑⚑⚑ 合成那一路也要停', S.__synth.speaking === false, S.__calls.join(' → '));
  }

  {
    // 真走 renderMessages 的空对话提前 return：建群聊会把 activeChatId 切到 nodes={} 的新会话。
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    const a1 = S.__audio();
    S.__gone(1);
    const oldGet = S.document.getElementById;
    const win = { innerHTML: '', querySelector: () => null };
    S.document.getElementById = id => id === 'chatWindow' ? win : oldGet(id);
    S.getActiveChat = () => ({ headId: null, nodes: {} });
    S.state.memories = []; S.state.configs = [];
    // _emptyAurora / _emptyAuroraStop：空页面极光（06-render-msg.js），沙箱里没 WebGL，给个空壳
    // escHtml / _emptyEchoName：空页面猫背后那行回声大字（2026-10-14），这里只要不炸
    vm.runInContext('let _emptyStateRendered=false; let _emptyAuroraStop=null; function _emptyAurora(){} function applyChatEndedState(){} function _applyChatMode(){};'
      + 'function escHtml(s){return String(s)} function _emptyEchoName(){return "GranCyan"};'
      + funcBody(render, 'renderMessages') + ';this.__renderMessages=renderMessages;', S);
    S.__renderMessages();
    t('⚑⚑⚑ 空对话提前 return 也必须经过 TTS 同步并停掉已离开视图的朗读',
      a1.paused === true && a1.src === '' && S._ttsState(1) === 'idle', S.__calls.join(' → '));
  }

  {
    // ⚠️ 不叫停的话音频接着放，而承载暂停按钮的那条消息已经从视图里没了 ——
    //    她既停不掉也释放不掉，只能刷新页面。
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    const a1 = S.__audio();
    S.ttsStopSpeaking();
    t('⚑ 对外的停止入口能真的停掉', S._ttsState(1) === 'idle' && a1.paused);
    t('⚑ 而且释放了 src', a1.src === '', a1.src);
    t('⚑ 按钮回到「朗读」', S.__btn(1) === S.TTS_LABEL.idle);
  }

  {
    const S = sandbox();
    S.toggleSpeak(1); await wait();
    S.toggleSpeak(1);                     // 暂停中
    S.ttsStopSpeaking();
    t('⚑ 暂停中也停得掉（不然它一直占着不释放）', S._ttsState(1) === 'idle');
  }

  // ⚠️ 光用「文件里出现过 ttsStopSpeaking」或者「出现了两次」证明不了
  //    调用落在**正确的函数**里 —— 挪到隔壁函数、或者放在 return 之后，
  //    这两种断言都照样绿。（Codex 五审指出的）
  //    所以按大括号配平切出函数体，逐个函数点名查。
  const chats = read('js/03-chats-models.js');
  const trash = read('js/08-edit-trash.js');
  const api = read('js/05-prompts-api.js');
  const tts = read('js/07-band-tts.js');
  const rmsg = read('js/06-render-msg.js');

  // 会让「正在朗读的那条消息」从视图里消失、或者内容被换掉的入口，一个都不能漏
  // ⚠️ 后面三条是 Codex 六审补的 —— 我上一轮枚举了七个就以为齐了，
  //    而这个清单本身就是断言，漏掉的入口在测试里完全看不见（全绿）。
  const gates = [
    ['切对话', chats, 'switchChat'],
    ['新建对话', chats, 'createNewChat'],
    ['删除对话', chats, 'deleteChat'],
    ['重新生成', trash, 'regenerate'],
    ['删单条消息', trash, 'deleteSingleMessage'],
    ['批量删消息', trash, 'deleteSelectedMessages'],
    ['切换 variant', api, 'chooseVariant'],
    ['切分支', rmsg, 'switchBranch'],
    ['编辑重发', trash, 'submitEditMessage'],
    ['批量删对话', trash, 'deleteSelectedChats']
  ];
  for (const [name, src2, fn] of gates) {
    const body = funcBody(src2, fn);
    t('⚑ ' + name + '（' + fn + '）里叫了停',
      !!body && /ttsStopSpeaking\(\)/.test(body), body ? '有函数体但没调' : '找不到这个函数');
  }
  t('⚑ funcBody 本身是可信的（找得到、切得出、认得出没有的情况）',
    funcBody(tts, 'ttsStopSpeaking').includes('_ttsStopAll')
    && funcBody(tts, '压根不存在的函数名') === '');

  console.log('\n【七】源码层面');

  {
    // 文案散在各处的话，总有一条路忘了更新，症状是「点了没反应」
    // ⚠️ 别把 ⏳ 也算进来 —— 手环那个刷新按钮的「⏳ 同步中…」会被误伤，
    //    而它跟朗读一点关系都没有。只认朗读按钮自己的那几个图标。
    const lits = (src.match(/textContent = '(?:🔊|⏸|▶|⏹)[^']*'/g) || []);
    t('★ 朗读按钮的文案只从 TTS_LABEL 出，不散写字面量', lits.length === 0, lits);
    t('★ 三种文案都定义了',
      /idle:.*朗读/.test(src) && /playing:.*暂停/.test(src) && /paused:.*继续/.test(src));
  }

  {
    // 守的是「朗读用的那个 _ttsAudio，只有 _ttsStopAll 能清它的 src」——
    // 暂停那条路要是清了，再点「继续」就没得放，只能重新请求一次从头念。
    // ⚠️ 原来这里数的是全文 `.src = ''` 的出现次数（要求恰好 1 次）。
    //    那是个会误伤的代理判据：试听有自己的 _ttsPreviewAudio，清自己的 src 完全正当，
    //    加进来就把这条撞红了。改成只盯 _ttsAudio 这一个对象。
    const body = src.split(/\r?\nfunction /).find(f => f.startsWith('_ttsStopAll('));
    const clears = (src.match(/_ttsAudio\.src = ''/g) || []).length;
    t('★ 朗读用的 _ttsAudio，只有 _ttsStopAll 会清空它的 src（暂停那条路绝不能碰）',
      !!body && /_ttsAudio\.src = ''/.test(body) && clears === 1, { clears });
  }

  console.log('\n' + (fail ? '✗ ' + fail + ' 条没过' : '✓ 全过') + '（共 ' + (pass + fail) + ' 条）');
  process.exit(fail ? 1 : 0);
})();
