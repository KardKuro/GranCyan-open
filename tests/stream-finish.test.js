/* 流结束后的两条收尾路：
 *
 * 一、多模型并排（streamVariant）：以前 `const { fullText } = await streamCompletion(...)`，
 *     紧接着 `fullText = extractSuggestionTags(...)` —— 每个变体一成功就抛 TypeError，
 *     指令不执行、save 不跑，而且 forEach 不 await，是一条没人接的 rejection。
 * 二、按停止（callAPI / streamVariant 拿到 aborted:true）：以前照常走成功分支，
 *     stopGeneration 写的「已停止」被整份 blocks 盖掉（只流出思考就停 → 只剩 💭 的空气泡），
 *     还会拿半截回复去抽记忆、做当轮续写（她刚按停止它又自己开口）。
 *
 * 在 vm 里真跑 05-prompts-api.js 的 callAPI / streamVariant；它们调用的一大堆可选钩子
 * 都是 `typeof X === 'function'` 守着的，沙箱里不给就等于没装。必需的依赖给桩，
 * 关心的几个（抽记忆、续写）给探针。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const api = fs.readFileSync(path.join(__dirname, '..', 'js', '05-prompts-api.js'), 'utf8');
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
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

function makeCtx(result) {
  const calls = { memories: 0, chain: 0, saves: 0 };
  let id = 100;
  const stubs = {
    nextId: () => ++id,
    renderMessages() {}, renderLiveBubble() {}, save() { calls.saves++; }, _doSave() { calls.saves++; }, createBackup() {},
    _invalidateNodeCache() {}, _debouncedSidebarUpdate() {}, updateInputHint() {},
    buildApiMessages: async () => [], lookupChainReasons: () => [],
    streamCompletion: async (conf, msgs, onUpdate) => { onUpdate(result.fullText, result.reasoningText, result.blocks); return result; },
    processAiCommands: (txt) => txt, estimateTokens: s => (s || '').length,
    extractSuggestionTags: (txt) => txt,
    proustDropSilent: () => false,
    tryExtractMemories() { calls.memories++; }, summarizeThinking: async () => '', translateThinkingFor() {},
    triggerMemSummaries() {}, lookupChainContinue: async () => { calls.chain++; },
    clearAgentRunRefs() {}, _aiVoiceWanted: false, _aiDialReason: null,
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Promise, Array, Object, String, setTimeout,
  };
  const ctx = vm.createContext(new Proxy(stubs, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : (k === Symbol.unscopables ? undefined : globalThis[k])),
    set: (o, k, v) => { o[k] = v; return true; },
  }));
  vm.runInContext([funcBody(api, 'function appendWarnBlock('), funcBody(api, 'async function callAPI('),
    funcBody(api, 'async function streamVariant(')].join('\n') + '\nthis.__callAPI = callAPI; this.__streamVariant = streamVariant;', ctx);
  return { ctx, calls };
}
const text = n => (n.blocks || []).map(b => b.text).join('|');

(async () => {
  console.log('\n【一】多模型并排：成功的变体能收尾');
  {
    const { ctx, calls } = makeCtx({ fullText: '你好', reasoningText: '', blocks: [{ type: 'text', text: '你好' }], error: null, aborted: false });
    const chat = { nodes: { 1: { id: 1, role: 'ai', variants: [{ content: '', streaming: true }] } } };
    let err = null;
    try { await ctx.__streamVariant({ apiKey: 'k', nickname: 'A' }, [{ content: 'hi' }], chat, 1, 0); } catch (e) { err = e.message; }
    t('不抛', err === null, err);
    t('变体正文写进去了', chat.nodes[1].variants[0].content === '你好', chat.nodes[1].variants[0].content);
    t('save 跑了', calls.saves > 0);
  }

  console.log('\n【二】callAPI 按停止');
  {
    const { ctx, calls } = makeCtx({ fullText: '', reasoningText: '我在想…', blocks: [{ type: 'thinking', text: '我在想…' }], error: null, aborted: true });
    const chat = { nodes: { 1: { id: 1, role: 'user', content: 'hi' } }, headId: 1 };
    await ctx.__callAPI({ apiKey: 'k', id: 7, nickname: 'A' }, [{ content: 'hi' }], chat, 1);
    const ai = chat.nodes[chat.headId];
    t('气泡上有「已停止」提示（只流出思考就停也不是空气泡）', /已停止/.test(text(ai)), text(ai));
    t('不再是生成中', ai.streaming === false);
    t('半截回复不抽记忆', calls.memories === 0, calls.memories);
    t('不当轮续写', calls.chain === 0, calls.chain);
  }
  {
    const { ctx, calls } = makeCtx({ fullText: '完整回复', reasoningText: '', blocks: [{ type: 'text', text: '完整回复' }], error: null, aborted: false });
    const chat = { nodes: { 1: { id: 1, role: 'user', content: 'hi' } }, headId: 1 };
    await ctx.__callAPI({ apiKey: 'k', id: 7, nickname: 'A' }, [{ content: 'hi' }], chat, 1);
    const ai = chat.nodes[chat.headId];
    t('对照组：正常结束没有「已停止」', !/已停止/.test(text(ai)), text(ai));
    t('对照组：正常结束照常抽记忆、走续写', calls.memories === 1 && calls.chain === 1, calls);
  }

  console.log('\n【三】多模型变体按停止');
  {
    const { ctx } = makeCtx({ fullText: '半', reasoningText: '', blocks: [{ type: 'text', text: '半' }], error: null, aborted: true });
    const chat = { nodes: { 1: { id: 1, role: 'ai', variants: [{ content: '', streaming: true }] } } };
    await ctx.__streamVariant({ apiKey: 'k', nickname: 'A' }, [{ content: 'hi' }], chat, 1, 0);
    t('变体上有「已停止」', /已停止/.test(text(chat.nodes[1].variants[0])), text(chat.nodes[1].variants[0]));
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
