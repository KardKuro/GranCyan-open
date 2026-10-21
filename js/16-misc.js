// ═══════════════════════════════════════════════════════
// 英文界面（设置 → 外观 → 语言）的机制。词典在 16-i18n-en.js（window.GRANCYAN_I18N_EN），
// 这里只管「什么时候、翻哪些节点、怎么查」。
//
// 不翻的地方（2026-10-21）：消息气泡、引用、思考正文这类**她和 AI 写的内容**。
// 以前 TreeWalker 只跳过 SCRIPT/STYLE/TEXTAREA/NOSCRIPT/PRE，词典一大，
// 有人刚好发一句「好的」「删除」就会被换成英文。现在：
//   · 挂 data-no-i18n（或命中 NO_I18N 里的 class）的容器整棵跳过；
//   · 容器里真正的界面零件（思考块的标题、附件卡片的说明……）列在 OPT_IN，照翻；
//   · 流式输出时气泡每帧在变，命中跳过容器的变动一个 closest 就返回，不去跑 RULES。
// 调试：localStorage.grancyanI18nDebug='1' 后，查不到的中文记在 window.__i18nMisses（Map 文本→来源）。
// ═══════════════════════════════════════════════════════
(function(){
  var DICT = window.GRANCYAN_I18N_EN || {};
  var MAP = DICT.MAP || {};
  var HTML = DICT.HTML || {};
  var RULES = DICT.RULES || [];
  var CJK = /[一-鿿]/;
  var HAS = Object.prototype.hasOwnProperty;

  // 空白压平后的索引：index.html 里换行缩进的文字节点，按「压成一个空格」的样子查
  var CMAP = {};
  for (var k0 in MAP) if (HAS.call(MAP, k0)) {
    var c0 = k0.replace(/\s+/g, ' ');
    if (!HAS.call(CMAP, c0)) CMAP[c0] = MAP[k0];
  }

  // RULES 按正则开头的第一个字面字分桶：几百条规则时，每个文字节点只试同首字的那几条
  // （桶里记着原来的下标，查的时候两边合起来还按词典里的先后试，跟没分桶时一样）。
  // 另外每条记下一段**必定出现**的中文字面，先 indexOf 过一道再跑正则：
  // 分组 (…) 和字符类 […] 里的字不算（「(十[一二]?|[一…九])月」里的「十」不是每次都有），
  // 后面跟着 ? * { 的那个字也不算
  function needOf(src){
    var s = src.replace(/\\./g, ' ').replace(/\[[^\]]*\]/g, ' ');
    for (var guard = 0; guard < 20 && /\([^()]*\)/.test(s); guard++) s = s.replace(/\([^()]*\)[?*+]?(\{[^}]*\})?/g, ' ');
    s = s.replace(/[一-鿿](?=[?*{])/g, ' ');
    var runs = s.match(/[一-鿿]+/g) || [], need = '';
    for (var q = 0; q < runs.length; q++) if (runs[q].length > need.length) need = runs[q];
    return need;
  }
  var RBUCKET = {}, RANY = [];
  for (var r0 = 0; r0 < RULES.length; r0++) {
    var re = RULES[r0][0], src = re && re.source;
    if (!src) continue;
    var ent = [re, RULES[r0][1], needOf(src), r0];
    var ch = src.charAt(0) === '^' ? src.charAt(1) : '';
    var nx = src.charAt(2);
    if (ch && !/[()[\]\\.^$|?*+{]/.test(ch) && !/[?*+{]/.test(nx)) (RBUCKET[ch] = RBUCKET[ch] || []).push(ent);
    else RANY.push(ent);
  }
  // 填进去的那几段要是也是中文（「列表循环（点一下切换）」里的「列表循环」「切换」），也各自查一遍。
  // 只往下查一层（_slotDepth），免得规则套规则转圈。
  // 但**引号里的不查**：「对话「设置」已恢复」里的「设置」是她起的标题，不是界面上的字——
  // 英文模板里写成 "$1" / “$1” / '$1' / «$1» 的那几个组原样放回去。
  var _slotDepth = 0;
  function slot(g){
    if (!g || !CJK.test(g) || _slotDepth > 0) return g;
    _slotDepth++;
    try { var t = lookup(g, true, 'slot'); return t != null ? t : g; } finally { _slotDepth--; }
  }
  function fill(to, m){
    return to.replace(/(["“'«]?)\$(\d+)(["”'»]?)|\$\$/g, function(s, q1, n, q2){
      if (n == null) return '$';
      var g = m[+n] == null ? '' : m[+n];
      return q1 + ((q1 && q2) ? g : slot(g)) + q2;
    });
  }
  // 翻完还剩中文（引号里的名字除外）＝ 填进去的那段查不到：宁可整句留中文，也别出「Device 名称」这种半截
  function mixed(s){ return CJK.test(String(s).replace(/"[^"]*"|“[^”]*”|'[^']*'|«[^»]*»|「[^」]*」/g, '')); }
  function byRule(key){
    var A = RBUCKET[key.charAt(0)] || [], B = RANY, ia = 0, ib = 0;
    while (ia < A.length || ib < B.length) {
      var e = (ib >= B.length || (ia < A.length && A[ia][3] < B[ib][3])) ? A[ia++] : B[ib++];
      if (e[2] && key.indexOf(e[2]) < 0) continue;
      e[0].lastIndex = 0;
      if (!e[0].test(key)) continue;
      // 只换匹配到的那一段：没写 $ 锚的规则，后面那截（文件名、编号列表）原样留着
      var to = e[1];
      var out = typeof to === 'function' ? key.replace(e[0], to)
        : key.replace(e[0], function(){ return fill(to, arguments); });
      if (!mixed(out)) return out;
    }
    return null;
  }
  function exact(key){
    if (HAS.call(MAP, key)) return MAP[key];
    var c = key.replace(/\s+/g, ' ');
    if (HAS.call(CMAP, c)) return CMAP[c];
    return null;
  }

  // 「🗑 删除」「名称：」「加载中…」「，然后点保存」：剥掉开头的符号和结尾的标点，只查中间那段。
  // 剥下来的中文标点换成英文的（帮助页被 <b>/<code> 切开的半句常以「，」「、」开头）
  var DECOR = /^([^一-鿿A-Za-z0-9「『“"'（(\[【《<]*)([\s\S]*?)([\s:：。.!！?？…~～，、；;,）)」』”"》】]*)$/;
  var PUNCT = {'，':', ','、':', ','；':'; ','：':': ','。':'. ','！':'! ','？':'? ','（':' (','）':') ','～':'~',
               '「':'"','」':'"','『':'"','』':'"','“':'"','”':'"','《':'"','》':'"','【':'[','】':']'};
  function enPunct(s){ return s.replace(/[，、；：。！？（）～「」『』“”《》【】]/g, function(c){ return PUNCT[c]; }); }
  // rules=false：中间那段只查整句（先于规则跑——「✨ 回复建议已开启…」整句有词条，别让一条宽规则抢先翻一半）
  function decor(key, full, rules){
    var m = DECOR.exec(key);
    if (!m || (!m[1] && !m[3]) || !m[2] || !CJK.test(m[2])) return null;
    var core = exact(m[2]);
    if (core == null && rules && (full || m[2].length < 80)) core = byRule(m[2]);
    if (core == null) return null;
    var head = enPunct(m[1]).replace(/^\s+/, '');
    var tail = enPunct(m[3]).replace(/\s+$/, '');
    if (/^\s*:/.test(tail) && /:\s*$/.test(core)) tail = tail.replace(/^\s*:/, '');
    if (/^[.!?]/.test(tail) && /[.!?]$/.test(core)) tail = tail.replace(/^[.!?]+/, '');
    return head + core + tail;
  }

  var DEBUG = false;
  try { DEBUG = localStorage.getItem('grancyanI18nDebug') === '1'; } catch (e) {}
  if (DEBUG) window.__i18nMisses = new Map();
  function miss(key, where){
    if (DEBUG && key && !window.__i18nMisses.has(key)) window.__i18nMisses.set(key, where);
  }

  function lookup(str, full, where){
    if (str == null) return null;
    var key = String(str).trim();
    if (!key || !CJK.test(key)) return null;
    var t = exact(key);
    if (t != null) return t;
    t = decor(key, full, false);
    if (t != null) return t;
    if (full || key.length < 80) {
      t = byRule(key);
      // 规则是按压平空白的样子写的；多行的 toast / confirm 压平了再试一次
      if (t == null) { var ck = key.replace(/\s+/g, ' '); if (ck !== key) t = byRule(ck); }
      if (t != null) return t;
    }
    t = decor(key, full, true);
    if (t == null) miss(key, where || 'text');
    return t;
  }

  // ── 不翻的容器 ──
  // 消息正文（.bubble 里是 markdown 渲染出来的回复 / 她的原话）、引用、思考正文、她写的思考；
  // 记忆 / 收藏 / 公告板的正文（.memory-text / .board-item-text）、收藏来自哪个对话、无缝换窗里的消息摘录
  var NO_I18N = '[data-no-i18n],.bubble,.bubble-quote,.think-body,.user-thinking-body,' +
                '.memory-text,.board-item-text,.fav-meta-src,.forge-u,.forge-a,' +
                // 超过 320 字的消息不画气泡、画成可展开的附件卡（06-render-msg.js），正文在 .msg-attach-body
                '.msg-attach-body,' +
                // 她起的对话标题；小组件里她和 AI 写的正文（日记、错题题干、梦、相册批注和图片描述、
                // 小本子那一页、生活面板的小票 / 约定、猫爪日报的动态和评论）
                '.chat-item-title,.diary-entry-text,.mk-item-txt,.mk-qtxt,.dr-text,' +
                '.album-card-note,.album-card-desc,.wish-page-t,.wish-page-why,.life-rt,.moment-text,.moment-comment-text';
  // 跳过容器里的界面零件：思考块标题那一行、附件卡片的元信息。
  // 别图省事写 button：有的按钮上是 AI 写的字
  var OPT_IN = '[data-i18n],.think-toggle,.msg-attach-meta';
  function blockedEl(el){
    if (!el || !el.closest) return false;
    var s = el.closest(NO_I18N);
    if (!s) return false;
    var o = el.closest(OPT_IN);
    return !(o && s.contains(o));
  }
  // 整棵子树都在跳过容器里、里面也没有要翻的零件 → 整棵不看
  function blockedTree(el){
    return blockedEl(el) && !(el.querySelector && el.querySelector(OPT_IN));
  }

  function applyText(node){
    var raw = node.nodeValue;
    if (!raw || !CJK.test(raw)) return;
    var t = lookup(raw, false, 'text');
    if (t == null) return;
    var lead = (raw.match(/^\s*/)||[''])[0];
    var trail = (raw.match(/\s*$/)||[''])[0];
    // 中文前后不留空格，英文要：「点<b>设置</b>里的」切成三段翻完会粘成 "TapSettings"。
    // 左右挨着别的节点、又没有空白隔开时，补一个空格（标点开头 / 结尾的不补）
    if (!lead && /^[A-Za-z0-9(“"'\[]/.test(t)) {
      var pv = node.previousSibling, pt = pv && (pv.nodeType === 3 ? pv.nodeValue : pv.textContent);
      if (pt && /[^\s(“"'\[\/（「『《【]$/.test(pt)) lead = ' ';
    }
    if (!trail && /[A-Za-z0-9.,;:!?)”"'\]]$/.test(t)) {
      var nx = node.nextSibling, nt = nx && (nx.nodeType === 3 ? nx.nodeValue : nx.textContent);
      if (nt && /^[^\s.,;:!?)”"'\]\/，。、；：！？）」』》】…]/.test(nt)) trail = ' ';
    }
    var next = lead + t + trail;
    if (next !== raw) node.nodeValue = next;
  }

  var ATTRS = ['placeholder','title','aria-label'];
  function applyAttr(el){
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    for (var i=0;i<ATTRS.length;i++){
      if (!el.hasAttribute(ATTRS[i])) continue;
      var v = el.getAttribute(ATTRS[i]);
      if (!v || !CJK.test(v)) continue;
      if (blockedEl(el)) return;
      var t = lookup(v, false, ATTRS[i]);
      if (t != null && t !== v) el.setAttribute(ATTRS[i], t);
    }
  }

  var BLOCKS = '.help-desc,[data-i18n-block]';
  function blockKey(el){ return el.innerHTML.replace(/\s+/g, ' ').trim(); }
  function applyBlock(el){
    if (el.__i18nBlock) return;
    var k = blockKey(el);
    if (!CJK.test(k)) return;
    if (HAS.call(HTML, k)) { el.__i18nBlock = 1; el.innerHTML = HTML[k]; }
    else miss(k, 'block');
  }

  var SKIP = {SCRIPT:1,STYLE:1,TEXTAREA:1,NOSCRIPT:1,PRE:1};
  function translateTree(root){
    if (!root) return;
    if (root.nodeType === 3){ if (!blockedEl(root.parentElement)) applyText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && blockedTree(root)) return;
    // 整段换：功能指南那种带 <b>/<code> 的长段落，按整段 innerHTML 查 HTML 表，查到就整段换掉
    // （一个个文字节点拼出来的英文语序不对，读着像机翻）
    if (root.querySelectorAll) {
      if (root.nodeType === 1 && root.matches && root.matches(BLOCKS)) applyBlock(root);
      var bl = root.querySelectorAll(BLOCKS);
      for (var b = 0; b < bl.length; b++) applyBlock(bl[b]);
    }
    // attributes
    if (root.nodeType === 1) applyAttr(root);
    if (root.querySelectorAll){
      var els = root.querySelectorAll('[placeholder],[title],[aria-label]');
      for (var i=0;i<els.length;i++) applyAttr(els[i]);
    }
    // text nodes：元素也走一遍，跳过容器整棵剪掉
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function(n){
        if (n.nodeType === 1) {
          if (SKIP[n.nodeName]) return NodeFilter.FILTER_REJECT;
          if (n.matches && n.matches(NO_I18N) && !n.querySelector(OPT_IN)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        var p = n.parentNode;
        if (!p || SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (!CJK.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (blockedEl(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var list = [], cur;
    while ((cur = tw.nextNode())) list.push(cur);
    for (var j=0;j<list.length;j++) applyText(list[j]);
  }

  var observer = new MutationObserver(function(muts){
    for (var i=0;i<muts.length;i++){
      var m = muts[i];
      if (m.type === 'characterData'){
        var p = m.target.parentNode;
        if (p && !SKIP[p.nodeName] && !blockedEl(p)) applyText(m.target);
      }
      else if (m.type === 'attributes'){ applyAttr(m.target); }
      else {
        // 跳过容器里的变动（流式输出、morph 重画）：父节点在容器里、又不是界面零件，直接走
        if (m.target.nodeType === 1 && blockedTree(m.target)) continue;
        for (var k=0;k<m.addedNodes.length;k++){
          var n = m.addedNodes[k];
          if (n.nodeType === 3) { var pp = n.parentNode; if (pp && !SKIP[pp.nodeName] && !blockedEl(pp)) applyText(n); }
          else if (n.nodeType === 1) translateTree(n);
        }
      }
    }
  });

  function startObserver(){
    observer.observe(document.documentElement, {
      childList:true, subtree:true, characterData:true,
      attributes:true, attributeFilter:ATTRS
    });
  }

  function patchDisplays(){
    if (typeof window.showToast === 'function'){
      var ot = window.showToast;
      window.showToast = function(msg){
        var t = lookup(msg, true, 'toast');
        arguments[0] = (t != null ? t : msg);
        return ot.apply(this, arguments);
      };
    }
    var oc = window.confirm;
    window.confirm = function(msg){ var t = lookup(msg, true, 'confirm'); return oc.call(window, t != null ? t : msg); };
    var oa = window.alert;
    window.alert = function(msg){ var t = lookup(msg, true, 'alert'); return oa.call(window, t != null ? t : msg); };
    var op = window.prompt;
    window.prompt = function(msg, def){ var t = lookup(msg, true, 'prompt'); return op.call(window, t != null ? t : msg, def); };
    if (typeof window.appPrompt === 'function'){
      var oap = window.appPrompt;
      window.appPrompt = function(msg, def){
        var t = lookup(msg, true, 'appPrompt');
        var args = Array.prototype.slice.call(arguments);
        args[0] = (t != null ? t : msg);
        // 勾选框那行的字也翻（appPrompt 第三个参数 { check: { label } }）
        var o = args[2];
        if (o && o.check && o.check.label) { var tl = lookup(o.check.label, true, 'appPrompt'); if (tl != null) o.check.label = tl; }
        return oap.apply(this, args);
      };
    }
  }

  window.getLang = function(){ try { return localStorage.getItem('grancyanLang') || 'zh'; } catch(e){ return 'zh'; } };
  window.setLanguage = function(lang){ try { localStorage.setItem('grancyanLang', lang); } catch(e){} location.reload(); };
  // 给别的脚本 / 测试用：拿一句中文的英文（英文模式以外原样返回）
  window.i18nText = function(s){ if (window.getLang() !== 'en') return s; var t = lookup(s, true, 'api'); return t != null ? t : s; };
  window.__i18n = { lookup: lookup, blocked: blockedEl, NO_I18N: NO_I18N, OPT_IN: OPT_IN, translateTree: translateTree };

  function boot(){
    var sel = document.getElementById('uiLanguageSelect');
    if (sel) sel.value = window.getLang();
    if (window.getLang() !== 'en') return;
    document.documentElement.setAttribute('lang','en');
    patchDisplays();
    translateTree(document.documentElement);
    startObserver();
    // second pass after async init render settles
    setTimeout(function(){ translateTree(document.body); }, 400);
    setTimeout(function(){ translateTree(document.body); }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
