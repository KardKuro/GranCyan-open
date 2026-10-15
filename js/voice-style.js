/* ══════════════════════════════════════════════════════════════════════════
   语气挑选 · 本地情绪声音（CosyVoice3）用的，页面和 server 共用的**同一份**

   页面手里有生命体征（30-vitals.js）和要念的那句话，挑一个语气的「名字」发给 server；
   server 只认这张表里的名字，把它换成真正喂给模型的指令文本。
   名字 → 指令只写在这里：页面那头挑、server 这头查，写两份迟早一边多一个键，
   多出来的那个就会被 server 静默当成「平常」念，零报错。

   为什么是这么几种、措辞为什么这么怪（「请非常开心地说一句话」）：
   CosyVoice3 的 instruct 是拿 cosyvoice/utils/common.py 里那张 instruct_list 训出来的，
   情绪只有开心/伤心/生气三种，外加轻声、慢速。自己编的句子它也会听，但效果不稳——
   所以只用训练时见过的原句，靠「什么时候用哪句」来做细腻，而不是靠措辞。

   这个文件必须同时能被 <script> 和 require() 加载：不碰 DOM、不碰 state，只收参数回结果。
   ════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceStyle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // neutral 不给指令：走零样本克隆那条路，韵律跟着参考音走，最像「平常说话」
  const STYLES = {
    neutral: '',
    happy: '请非常开心地说一句话。',
    sad: '请非常伤心地说一句话。',
    angry: '请非常生气地说一句话。',
    soft: 'Please say a sentence in a very soft voice.',
    slow: '请用尽可能慢地语速说一句话。'
  };
  const LABELS = { neutral: '平常', happy: '开心', sad: '难过', angry: '生气', soft: '轻声', slow: '慢慢说' };

  // 本地声音的 voice id：cosy-<样本名>。样本名只许小写字母数字连字符——
  // 它会变成 voices 目录下的文件名，也要过 /api/tts 原有的 voice 白名单。
  const LOCAL_PREFIX = 'cosy-';
  const LOCAL_RE = /^cosy-[a-z0-9][a-z0-9-]{0,39}$/;
  function isLocalVoice(voice) { return LOCAL_RE.test(String(voice || '')); }
  function sampleName(voice) { return isLocalVoice(voice) ? String(voice).slice(LOCAL_PREFIX.length) : ''; }

  function instructFor(style) {
    const s = Object.prototype.hasOwnProperty.call(STYLES, style) ? STYLES[style] : '';
    return s ? 'You are a helpful assistant. ' + s + '<|endofprompt|>' : '';
  }

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  // 句子本身的信号。比体征优先：体征是「这会儿整体的心情」，话是「这一句」——
  // 心情明亮的时候也会说一句对不起，那句就该轻下来。
  const CUE = {
    laugh: /哈哈|嘿嘿|嘻嘻|好耶|太好了|太棒了|😆|😄|😂|🤣|😁/,
    sad: /呜呜|难过|伤心|好难受|想哭|哭了|对不起|舍不得|好想你/,
    tender: /没事的|辛苦了|乖|抱抱|晚安|心疼|别怕|我在呢|摸摸/,
    angry: /生气|气死|凭什么|不许再|够了/
  };

  // vitals：30-vitals.js 那五维（0~1），可以是 null（体征关着/还没有）。
  // 返回 { style, why }，why 给日志和响应头看，方便用户说「这句怎么这么凶」时查得到。
  function pick(vitals, text) {
    const t = String(text || '');
    const v = vitals && typeof vitals === 'object' ? vitals : null;
    const mood = num(v && v.mood, 0.3), arousal = num(v && v.arousal, 0.35);
    const energy = num(v && v.energy, 0.6), stress = num(v && v.stress, 0.2);
    const bangs = (t.match(/[!！]/g) || []).length;

    // 生气是最容易误伤她的一种，所以要话和身体两边都对得上才给
    if (CUE.angry.test(t) && v && stress >= 0.55 && arousal >= 0.5) return { style: 'angry', why: '话里在生气，压力也高' };
    if (CUE.sad.test(t)) return mood < 0.35 ? { style: 'sad', why: '话里难过，情绪也低' } : { style: 'soft', why: '话里难过，但情绪还好——轻一点' };
    if (CUE.tender.test(t)) return { style: 'soft', why: '在哄人/亲近' };
    if (CUE.laugh.test(t) || bangs >= 2) return mood >= 0.12 ? { style: 'happy', why: '话里在笑' } : { style: 'neutral', why: '话里在笑，但情绪很低——不硬装开心' };
    if (!v) return { style: 'neutral', why: '没有体征' };

    if (mood < 0.12 && stress >= 0.38) return { style: 'sad', why: '情绪低、压力也在' };
    if (energy < 0.25) return { style: 'slow', why: '没力气了' };
    if (mood >= 0.62 && arousal >= 0.48) return { style: 'happy', why: '情绪明亮又醒着' };
    if (mood < 0.12 || energy < 0.4 || arousal < 0.3) return { style: 'soft', why: '低低的/累/安静' };
    return { style: 'neutral', why: '平常' };
  }

  return { STYLES, LABELS, LOCAL_PREFIX, isLocalVoice, sampleName, instructFor, pick };
});
