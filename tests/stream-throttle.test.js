/* 流式三件套（2026-09-27）：
 *
 * 一、流式重画 O(n²)：以前每来一个 token 就 renderLiveBubble → 整条消息 markdown 全量重解析 +
 *     innerHTML 重画。现在同一个气泡最多每 LIVE_BUBBLE_MIN_MS 画一次，尾随那次拿最新内容；
 *     流结束时调用方带 immediate=true 再调一次，撤掉挂着的定时器、立刻画终稿（不丢尾巴、
 *     也不会让晚到的定时器在终稿之后用旧的流式内容盖回去）。多模型并排按 elId 各算各的。
 * 二、生成中按 Enter 还会发：handleSend 以前不看这个对话是不是正在流。
 * 三、停止只停当前对话：给 AbortController 挂归属（gcChat），abortChatStreams(chat) 只停这个对话的。
 *     （stopGeneration 本体在 01-core.js，接线见本文件末尾那条说明）
 *
 * 都在 vm 里真跑 05-prompts-api.js 切出来的函数，时钟和定时器是假的，能精确推进。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const api = fs.readFileSync(path.join(__dirname, '..', 'js', '05-prompts-api.js'), 'utf8');
const render = fs.readFileSync(path.join(__dirname, '..', 'js', '06-render-msg.js'), 'utf8');
function funcBody(s, sig) {
  const i = s.indexOf(sig);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
const slice = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); return i >= 0 && j > i ? s.slice(i, j) : ''; };
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

// 假时钟 + 假定时器：advance(ms) 按时间顺序触发到期的回调
function fakeTime() {
  let now = 1000000, seq = 0;
  const timers = new Map();
  return {
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
function proxyCtx(stubs) {
  return vm.createContext(new Proxy(stubs, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : (k === Symbol.unscopables ? undefined : globalThis[k])),
    set: (o, k, v) => { o[k] = v; return true; },
  }));
}

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('\n【一】renderLiveBubble 节流');
  const throttleSrc = slice(api, 'const LIVE_BUBBLE_MIN_MS', 'function _paintLiveBubble(');
  t('切得出节流那段', throttleSrc.length > 200 && /function renderLiveBubble\(/.test(throttleSrc), throttleSrc.length);
  function makeThrottle() {
    const tm = fakeTime();
    const paints = [];
    const ctx = proxyCtx({
      Date: tm.Date, setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, Map,
      _paintLiveBubble: (elId, txt, think, streaming, blocks) => paints.push({ elId, txt, streaming, at: tm.Date.now() }),
    });
    vm.runInContext(throttleSrc + '\nthis.__r = renderLiveBubble; this.__MS = LIVE_BUBBLE_MIN_MS;', ctx);
    return { tm, paints, r: ctx.__r, MS: ctx.__MS, ctx };
  }
  {
    const { tm, paints, r, MS } = makeThrottle();
    t('节流间隔 ≥ 60ms', MS >= 60, MS);
    // 200 个 token，每 5ms 一个 = 1 秒
    let txt = '';
    for (let i = 0; i < 200; i++) {
      txt += 'x';
      r('bubble-1', txt, '', true, [{ type: 'text', text: txt }]);
      if (i === 0) t('第一个 token 立刻画（首字不延迟）', paints.length === 1 && paints[0].txt === 'x', paints.length);
      tm.advance(5);
    }
    const inStream = paints.length;
    t('1 秒 200 个 token 只画了 ≤ 1000/60+2 次（以前是 200 次）', inStream <= Math.ceil(1000 / MS) + 2 && inStream >= 5, inStream);
    const gaps = paints.slice(1).map((p, i) => p.at - paints[i].at);
    t('任意两次重画间隔都 ≥ 节流间隔', gaps.every(g => g >= MS), gaps);
    const parsed = paints.reduce((s, p) => s + p.txt.length, 0);
    t('累计重解析的字数远小于逐 token 全量重画（O(n²) → 线性量级）', parsed * 5 < 200 * 201 / 2, { parsed, naive: 200 * 201 / 2 });
    tm.advance(200);
    t('不带 immediate 也不会停在旧内容：尾随那次画的是最新全文', paints[paints.length - 1].txt.length === 200, paints[paints.length - 1].txt.length);
  }
  {
    const { tm, paints, r, ctx } = makeThrottle();
    r('bubble-2', 'a', '', true, []);          // 立刻画
    tm.advance(10);
    r('bubble-2', 'ab', '', true, []);         // 排进窗口
    t('窗口内的 token 排了一个定时器', tm.pending() === 1 && paints.length === 1);
    r('bubble-2', 'abc', '', true, [], true);  // 流结束
    t('流结束 immediate=true：同步立刻画终稿', paints.length === 2 && paints[1].txt === 'abc', paints.map(p => p.txt));
    t('挂着的那次定时器被撤掉了', tm.pending() === 0, tm.pending());
    tm.advance(500);
    t('之后不会再有晚到的流式重画盖掉终稿', paints.length === 2, paints.map(p => p.txt));
    t('节流状态清掉了（不留尸体）', vm.runInContext('_liveBubbleThrottle.size', ctx) === 0);
    r('bubble-2', 'final', '', false, []);
    t('streaming=false 直接画、不节流', paints.length === 3 && paints[2].streaming === false);
  }
  {
    const { tm, paints, r } = makeThrottle();
    r('variant-9-0', 'A', '', true, []);
    r('variant-9-1', 'B', '', true, []);
    t('多模型并排：每个 variant 的气泡各自节流，互不吞', paints.map(p => p.elId).join() === 'variant-9-0,variant-9-1', paints.map(p => p.elId));
    r('variant-9-0', 'AA', '', true, []);
    r('variant-9-1', 'BB', '', true, []);
    tm.advance(100);
    t('两个 variant 的尾随重画都到了，各是各的最新', paints.filter(p => p.txt === 'AA').length === 1 && paints.filter(p => p.txt === 'BB').length === 1, paints.map(p => p.txt));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n【二】调用方在流结束时都立刻补画终稿');
  function makeCallCtx(result) {
    const live = [];
    let id = 100;
    const stubs = {
      nextId: () => ++id,
      renderMessages() {}, renderLiveBubble: (...a) => live.push(a), save() {}, _doSave() {}, createBackup() {},
      _invalidateNodeCache() {}, _debouncedSidebarUpdate() {}, updateInputHint() {},
      buildApiMessages: async () => [], lookupChainReasons: () => [],
      // 流了一堆 token，最后一个 token 之后才返回（返回值是完整终稿）
      streamCompletion: async (conf, msgs, onUpdate) => {
        let s = '';
        for (const ch of result.fullText) { s += ch; onUpdate(s, '', [{ type: 'text', text: s }]); }
        return result;
      },
      processAiCommands: (txt) => txt, estimateTokens: s => (s || '').length, extractSuggestionTags: (txt) => txt,
      proustDropSilent: () => false,
      tryExtractMemories() {}, summarizeThinking: async () => '', translateThinkingFor() {},
      triggerMemSummaries() {}, lookupChainContinue: async () => {}, clearAgentRunRefs() {},
      _aiVoiceWanted: false, _aiDialReason: null, appendWarnBlock() {},
      console: { log() {}, warn() {}, error() {} },
    };
    const ctx = proxyCtx(stubs);
    vm.runInContext([funcBody(api, 'async function callAPI('), funcBody(api, 'async function streamVariant(')].join('\n')
      + '\nthis.__callAPI = callAPI; this.__streamVariant = streamVariant;', ctx);
    return { ctx, live };
  }
  const R = { fullText: '你好呀小明', reasoningText: '', blocks: [{ type: 'text', text: '你好呀小明' }], error: null, aborted: false };
  {
    const { ctx, live } = makeCallCtx(R);
    const chat = { nodes: { 1: { id: 1, role: 'user', content: 'hi' } }, headId: 1 };
    await ctx.__callAPI({ apiKey: 'k', id: 7, nickname: 'A' }, [{ content: 'hi' }], chat, 1);
    const last = live[live.length - 1] || [];
    t('callAPI：最后一次 renderLiveBubble 带 immediate=true', last[5] === true, last.map(String));
    t('callAPI：终稿画的是完整全文', last[1] === '你好呀小明' && last[0] === 'bubble-' + chat.headId, last.slice(0, 2));
    t('callAPI：流式途中的调用不带 immediate（走节流）', live.slice(0, -1).every(a => !a[5]) && live.length === 6, live.length);
  }
  {
    const { ctx, live } = makeCallCtx(R);
    const chat = { nodes: { 1: { id: 1, role: 'ai', variants: [{ content: '', streaming: true }, { content: '', streaming: true }] } } };
    await ctx.__streamVariant({ apiKey: 'k', nickname: 'A' }, [{ content: 'hi' }], chat, 1, 1);
    const last = live[live.length - 1] || [];
    t('streamVariant：终稿立刻画到自己那个 variant 气泡', last[0] === 'variant-1-1' && last[1] === '你好呀小明' && last[5] === true, last.map(String));
  }
  {
    const { ctx, live } = makeCallCtx({ ...R, fullText: '半截', blocks: [{ type: 'text', text: '半截' }], error: '网断了' });
    const chat = { nodes: { 1: { id: 1, role: 'user', content: 'hi' } }, headId: 1 };
    await ctx.__callAPI({ apiKey: 'k', id: 7, nickname: 'A' }, [{ content: 'hi' }], chat, 1);
    const last = live[live.length - 1] || [];
    t('callAPI 出错分支同样先撤节流、补画（晚到定时器不会盖掉 ⚠️）', last[5] === true && last[1] === '半截', last.map(String));
  }
  // 另外两条流：resumeAgentRun（05）和群聊（06）—— 依赖太多，钉源码形状
  const resumeSrc = funcBody(api, 'async function resumeAgentRun(');
  t('resumeAgentRun：streamCompletion 返回后立刻 immediate 补画',
    /\}, runId, chat\);\s*(\/\/[^\n]*\n\s*)*renderLiveBubble\('bubble-' \+ aiId, fullText, reasoningText, true, blocks, true\);/.test(resumeSrc));
  const groupSrc = funcBody(render, 'async function callGroupChat(');
  t('群聊：streamCompletion 返回后立刻 immediate 补画',
    /\}, undefined, chat\);[^\n]*\n\s*(\/\/[^\n]*\n\s*)*renderLiveBubble\('bubble-' \+ aiId, fullText, reasoningText, true, blocks, true\);/.test(groupSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n【三】生成中按 Enter 不发送');
  const ownSrc = funcBody(api, 'function _streamBelongsTo(') + '\n' + funcBody(api, 'function chatIsGenerating(')
    + '\n' + funcBody(api, 'function abortChatStreams(');
  function makeSendCtx(ctrls, active, input) {
    const seen = { toast: [], typing: 0, stop: 0 };
    const ctx = proxyCtx({
      document: { getElementById: (id) => (id === 'userInput' ? input : null), querySelector: () => null },
      _pendingImgs: [], _pendingFiles: [], _streamControllers: new Set(ctrls),
      getActiveChat: () => active,
      showToast: (m) => seen.toast.push(m),
      popTypingNote: () => { seen.typing++; throw new Error('STOP'); },   // 走到这里 = 真要发了
      stopGeneration: () => { seen.stop++; },
    });
    vm.runInContext(ownSrc + '\n' + funcBody(api, 'function handleSend('), ctx);
    return { ctx, seen };
  }
  const chatA = { id: 11, nodes: {} }, chatB = { id: 22, nodes: {} };
  const ctl = (chat) => ({ gcChat: chat, aborted: false, abort() { this.aborted = true; } });
  {
    const input = { value: '再说一句' };
    const { ctx, seen } = makeSendCtx([ctl(chatA)], chatA, input);
    let err = null;
    try { vm.runInContext('handleSend()', ctx); } catch (e) { err = e.message; }
    t('当前对话在生成：Enter（handleSend()）被拦下，没走到发送', err === null && seen.typing === 0, { err, typing: seen.typing });
    t('给了「还在生成」提示', seen.toast.some(m => /还在生成/.test(m)), seen.toast);
    t('输入框里的字原样留着', input.value === '再说一句');
    t('不顺手触发停止', seen.stop === 0);
  }
  {
    const { ctx, seen } = makeSendCtx([ctl(chatB)], chatA, { value: '在 A 里说话' });
    try { vm.runInContext('handleSend()', ctx); } catch (e) {}
    t('对照组：生成中的是别的对话 → 当前对话照常发', seen.typing === 1 && !seen.toast.length, seen);
  }
  {
    const { ctx, seen } = makeSendCtx([], chatA, { value: 'hi' });
    try { vm.runInContext('handleSend()', ctx); } catch (e) {}
    t('对照组：没有流在跑 → 照常发', seen.typing === 1);
  }
  {
    const { ctx, seen } = makeSendCtx([ctl({ id: 11 })], chatA, { value: 'hi' });
    try { vm.runInContext('handleSend()', ctx); } catch (e) {}
    t('云同步把对话对象换了个壳（同 id）也认得是同一个对话', seen.typing === 0 && seen.toast.length === 1);
  }
  {
    const { ctx, seen } = makeSendCtx([ctl({ id: 'dream' })], chatA, { value: 'hi' });
    try { vm.runInContext('handleSend()', ctx); } catch (e) {}
    t('对照组：梦境这类不属于任何真实对话的流不挡发送', seen.typing === 1);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n【四】只停当前对话的流');
  {
    const a1 = ctl(chatA), a2 = ctl({ id: 11 }), b1 = ctl(chatB), orphan = ctl(null);
    const set = new Set([a1, a2, b1, orphan]);
    const ctx = proxyCtx({ _streamControllers: set });
    vm.runInContext(ownSrc, ctx);
    const n = vm.runInContext('abortChatStreams', ctx)(chatA);
    t('当前对话的两条（多模型并排的两个 variant）都停了', a1.aborted && a2.aborted && n === 2, n);
    t('后台对话 B 的流没动', !b1.aborted && set.has(b1));
    t('不属于任何对话的流也没动', !orphan.aborted && set.has(orphan));
    t('停掉的从集合里摘掉了（按钮状态才对得上）', !set.has(a1) && !set.has(a2) && set.size === 2, set.size);
    t('chatIsGenerating 跟着变', vm.runInContext('chatIsGenerating', ctx)(chatA) === false && vm.runInContext('chatIsGenerating', ctx)(chatB) === true);
  }
  t('两个 AbortController 创建点都挂了归属（本地通道 + 通用 API）',
    (api.match(/const ctrl = new AbortController\(\);\s*\n\s*ctrl\.gcChat = originChat \|\| null;/g) || []).length === 2);

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
