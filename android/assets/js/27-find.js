// ══════════════════════════════════════════════════════════
// 页内查找（Ctrl+F）
// ══════════════════════════════════════════════════════════
// exe 是 Electron 起的窗口，没有浏览器那条自带的查找栏，Ctrl+F 按下去什么都不会发生。
// 这里自己实现一条：网页版、exe、安卓包三边一套代码，行为也一致。
//
// 高亮用 CSS Custom Highlight API（CSS.highlights）而不是往 DOM 里插 <mark>：
//   聊天气泡上挂着一堆事件和渲染逻辑，插标签会打断文本节点、可能踩坏选区和复制，
//   而 Highlight 只是给 Range 画个色，DOM 一个字节都不动。
//   万一环境不支持（老 WebView），降级成只滚动定位，不高亮 —— 功能还在，就是没色。

(function () {
  'use strict';

  const HL_ALL = 'gc-find';        // 全部命中
  const HL_CUR = 'gc-find-cur';    // 当前这一处
  const MAX_HITS = 3000;           // 长对话里搜个 "的" 能命中上万处，画不完也没意义
  const SUPPORTED = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  let bar = null;       // 查找栏 DOM
  let input = null;
  let counter = null;
  let hits = [];        // Range[]
  let cur = -1;
  let debounce = null;
  let lastQ = '';       // 上次搜的词（小写），用来校验 Range 有没有失效
  let dirty = false;    // DOM 动过了，下次导航前得重搜
  let observer = null;

  // ── 收集可搜索的文本节点 ──────────────────────────────────
  // 跳掉三种：脚本样式这类非展示内容、藏起来的东西（关着的弹窗一大堆）、查找栏自己。
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TITLE: 1 };

  // 判断两段文字之间该不该断开。页面上「阅读 <b>GitHub</b> 仓库」在屏幕上是连着的一句，
  // 搜「阅读 GitHub」就该命中；但两个不同段落的字**不能**接起来，不然会搜出根本不存在的短语。
  // 所以按「最近的块级祖先」分组：同一块内的文本节点首尾相接，跨块之间插一个换行当墙。
  const BLOCK_TAGS = {
    DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, TD: 1, TH: 1, TR: 1, TABLE: 1, PRE: 1, BLOCKQUOTE: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1,
    NAV: 1, MAIN: 1, ASIDE: 1, FORM: 1, FIGURE: 1, DETAILS: 1, SUMMARY: 1, BODY: 1,
  };
  function blockOf(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (BLOCK_TAGS[el.tagName]) return el;
    }
    return document.body;
  }

  function collectTextNodes() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // ⚠️ 别把纯空白节点扔掉。`<b>foo</b> <code>bar</code>` 中间那个 " " 是独立文本节点，
        //    丢了就会拼成 "foobar"：搜「foo bar」漏掉，搜「foobar」反而命中一个屏幕上不存在的词。
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[el.tagName]) return NodeFilter.FILTER_REJECT;
        if (el.closest('#gcFindBar')) return NodeFilter.FILTER_REJECT;
        // checkVisibility 会把 display:none / visibility:hidden / 折叠掉的祖先一并算进去，
        // 比自己一层层往上翻 class 靠谱得多（这项目里藏东西的写法有好几种）
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
          return NodeFilter.FILTER_REJECT;
        }
        /* 糊着的思考链不进索引。CSS 只管画面 —— 那段文字还老老实实躺在 DOM 里，
           而 checkVisibility 只挡得住 display:none / visibility:hidden 这类，
           挡不住「看得见但读不出来」。不排掉的话有两个后果，后一个更糟：
             ① 跳到命中处，看到的是一块糊的高亮，什么都读不出来（这本身就是个 bug）
             ② 她可以换着词搜、看命中计数变不变，把糊着的思考一个词一个词探出来 ——
                前面整套「得等它同意」就成了装饰。
           判据直接问浏览器（量 computed filter），不在这儿重抄一遍 CSS 的条件 ——
           抄一遍就是两份判据，CSS 那边一改这儿就悄悄漂了。 */
        const veil = el.closest && el.closest('.think-veil');
        if (veil && getComputedStyle(veil).filter !== 'none') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // ── 搜索 ──────────────────────────────────────────────────
  // 先把整页可见文字拼成一条长串（跨块处插换行），在长串上找，再把命中的区间映射回
  // 具体的文本节点。这样跨 <b>/<code>/<a> 的短语也能命中 —— 逐节点各找各的是搜不到的。
  //
  // 源码里的换行和缩进也是文本节点，直接拼进去搜索词就对不上了。所以把每个空白字符
  // **一对一**换成普通空格（长度不变，偏移映射照旧能用），nbsp 也顺手归一化 ——
  // 她敲的是普通空格，页面上却可能是 &nbsp;，不归一化永远搜不到。
  const normWS = s => s.replace(/\s/g, ' ');

  // 小写也必须 1:1。整串 toLowerCase() **会改长度**：'İ'（U+0130）一个码元小写成 'i̇' 两个，
  // 于是 hay 比 text 长，locate() 按原偏移一取就取到隔壁字符去了 —— 命中会漏，Range 会歪。
  // 所以逐**码点**折叠。
  //
  // ⚠️ 逐字符折叠会丢掉 toLowerCase 的**上下文**，别以为「两边过同一个函数就一定对齐」：
  //    希腊文词尾 sigma 是 ς、词中是 σ，整串 toLowerCase('ΟΣ') 给的是 'ος'，
  //    逐字符给的是 'οσ' —— 页面上写着 'ος'，搜 'ΟΣ' 就搜不到了。
  //    所以末尾再把 ς 统一成 σ（都是单码元，长度不变），三种写法互相都能搜到。
  const lowerFixed = s => {
    let out = '';
    for (const ch of s) {          // for…of 按码点走，不会把 astral 字符劈成两半
      const lo = ch.toLowerCase();
      if (lo.length === ch.length) { out += lo; continue; }
      // 变长了（目前只有 'İ' → 'i' + 组合点这一种）：只取头一个码点。
      // 长度对得上就用它 —— 这样 İ 和 i 还能互相搜到；对不上就原样留着，
      // 宁可这一个字符大小写敏感，也不能让整段偏移错位。
      const head = String.fromCodePoint(lo.codePointAt(0));
      out += head.length === ch.length ? head : ch;
    }
    return out.replace(/ς/g, 'σ');   // 词尾 ς → 普通 σ，1:1
  };
  // 搜索词和页面文字都过这一道：空白 1:1、小写 1:1，偏移映射才站得住
  const fold = s => lowerFixed(normWS(s || ''));

  function buildIndex() {
    const map = [];      // [{node, start, len}]，start 是它在 text 里的起点
    let text = '';
    let prevBlock = null;
    for (const node of collectTextNodes()) {
      const b = blockOf(node);
      if (prevBlock && b !== prevBlock) text += '\n';   // 跨块的墙，用 \n；搜索词里的空白都成了空格，撞不上
      prevBlock = b;
      map.push({ node, start: text.length, len: node.nodeValue.length });
      text += normWS(node.nodeValue);
    }
    return { text, map };
  }

  // 长串里的偏移 → 是哪个节点的第几个字。map 按 start 递增，二分。
  function locate(map, off) {
    let lo = 0, hi = map.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, e = map[mid];
      if (off < e.start) hi = mid - 1;
      else if (off >= e.start + e.len) lo = mid + 1;
      else return { node: e.node, offset: off - e.start };
    }
    return null;   // 落在块间插的那个换行上；匹配串里不含换行时不会走到这
  }

  function search(q, silent) {
    clearHighlights();
    hits = [];
    cur = -1;
    lastQ = fold(q);
    if (!q) { dirty = false; updateCounter(); return; }

    const { text, map } = buildIndex();
    const hay = lowerFixed(text);   // text 里的空白已经归一化过了，这里只补小写
    const needle = lastQ;
    let from = 0, idx;
    while ((idx = hay.indexOf(needle, from)) !== -1) {
      const s = locate(map, idx);
      const e = locate(map, idx + needle.length - 1);   // 末字符所在节点，再 +1 变成 exclusive
      if (s && e) {
        const r = document.createRange();
        try {
          r.setStart(s.node, s.offset);
          r.setEnd(e.node, e.offset + 1);
          hits.push(r);
        } catch (_) { /* 节点在这一瞬被换掉了，跳过这一处 */ }
      }
      from = idx + needle.length;
      if (hits.length >= MAX_HITS) break;
    }

    paintAll();
    // 搜索期间 observer 记下的都是自己造成的（高亮不动 DOM，但计数会动）；
    // takeRecords 把队列倒掉，免得回调稍后又把 dirty 置上去，白白触发下一次重搜。
    if (observer) observer.takeRecords();
    dirty = false;
    if (!silent && hits.length) focus(0);
    updateCounter();
  }

  function paintAll() {
    if (!SUPPORTED) return;
    CSS.highlights.set(HL_ALL, new Highlight(...hits));
  }

  function clearHighlights() {
    if (!SUPPORTED) return;
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CUR);
  }

  // 聊天消息外层开了 content-visibility:auto。屏幕外消息的内部文本节点可能还在 DOM，
  // 但处于“跳过渲染”的子树里：直接对那个 span/p 调 scrollIntoView，有的 Chromium/WebView
  // 只会换当前高亮，#chatWindow 的 scrollTop 根本不动。先临时激活整条消息、测出 Range
  // 在聊天滚动容器里的真实坐标，再直接推动容器；测完立刻还原性能优化。
  function scrollHitIntoView(r) {
    const el = r.startContainer && r.startContainer.parentElement;
    if (!el) return;
    const wrapper = el.closest && el.closest('[data-msg-wrapper]');
    const chatWin = wrapper && wrapper.closest('#chatWindow');
    if (wrapper && chatWin && typeof chatWin.scrollTo === 'function') {
      const oldVisibility = wrapper.style.contentVisibility;
      let rect = null;
      try {
        wrapper.style.contentVisibility = 'visible';
        rect = r.getBoundingClientRect(); // 同时强制这条此前被跳过的消息完成布局
        if (!rect || !Number.isFinite(rect.top)) rect = el.getBoundingClientRect();
      } catch (_) { rect = null; }
      finally { wrapper.style.contentVisibility = oldVisibility; }
      if (rect) {
        const viewport = chatWin.getBoundingClientRect();
        const top = chatWin.scrollTop + rect.top - viewport.top
          - chatWin.clientHeight / 2 + rect.height / 2;
        chatWin.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        return;
      }
    }
    // 弹窗、设置、指南等普通内容没有虚拟化，原生定位能正确选择它自己的滚动祖先。
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── 跳到第 i 处 ───────────────────────────────────────────
  function focus(i) {
    if (!hits.length) return;
    cur = ((i % hits.length) + hits.length) % hits.length;   // 到头绕回去
    const r = hits[cur];
    if (SUPPORTED) CSS.highlights.set(HL_CUR, new Highlight(r));
    scrollHitIntoView(r);
    updateCounter();
  }

  // dir 是**方向**（+1 / -1），不是绝对下标。
  // 重搜会把 hits 整个换掉，旧下标那时候就没有意义了：当前处之前多冒出一个命中，
  // 「下一个」传进来的 cur+1 正好还是原地，看着像点了没反应。
  function go(dir) {
    if (!hits.length) return;
    // 切对话、重新渲染消息、流式输出替换气泡之后，存下来的 Range 就不指向真东西了 ——
    // 计数还挂着，点「下一个」却什么都不动。
    //
    // ⚠️ 别指望用 startContainer.isConnected 判断：按 DOM 规范，边界节点被移除时
    //    Range 会自动**收缩到父节点**，而父节点通常还在文档里，isConnected 照样是 true。
    //    （实测就是这么漏的：整块 innerHTML 换掉，一条都没判出来。）
    //    所以改成盯 DOM 变动 + 校验 Range 里的字还是不是搜索词。
    const stale = dirty || hits.some(r => r.collapsed || fold(r.toString()) !== lastQ);
    if (!stale) { focus(cur + dir); return; }

    // 记住当前这处在文档里的位置，重搜后按**位置**接着走，而不是按下标。
    const anchor = (cur >= 0 && hits[cur]) ? hits[cur].cloneRange() : null;
    search(input.value, true);      // silent：先别跳到第 1 个，位置还没算出来
    if (!hits.length) { updateCounter(); return; }

    let base = -1, same = false;
    if (anchor) {
      try {
        // 第一个「起点不早于旧位置」的命中。节点被整个摘走时比较会抛，那就退回从头开始。
        base = hits.findIndex(r => r.compareBoundaryPoints(Range.START_TO_START, anchor) >= 0);
        same = base >= 0 && hits[base].compareBoundaryPoints(Range.START_TO_START, anchor) === 0;
      } catch (_) { base = -1; }
    }
    if (base < 0) focus(dir > 0 ? 0 : hits.length - 1);   // 旧位置没了或已在末尾之后 → 绕回
    // 往下：base 就是原处的话要再迈一步，是新冒出来的一处就停在它身上。
    // 往上：两种情况都是 base 前面那一处。
    else focus(dir > 0 ? (same ? base + 1 : base) : base - 1);
  }

  // 查找栏开着的时候才盯 DOM，关掉就撤 —— 常驻一个全页 observer 太亏了
  function watchDom() {
    if (observer) return;
    observer = new MutationObserver(muts => {
      for (const m of muts) {
        // ⚠️ 查找栏自己也在 body 里：改计数是 characterData、加 .show 是 attributes，
        //    不排掉的话每导航一次就把 dirty 置上，下一次点「下一个」必定全文重建索引。
        const t = m.target, el = t.nodeType === 1 ? t : t.parentElement;
        if (el && el.closest && el.closest('#gcFindBar')) continue;
        dirty = true;
        return;
      }
    });
    // 也要盯 attributes：这项目切弹窗靠加减 .hidden，只盯 childList 的话
    // 刚被藏起来的命中还能继续导航、刚露出来的内容又搜不到，而且 Range 校验全过。
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden'],
    });
  }
  function unwatchDom() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    dirty = false;
  }

  function updateCounter() {
    if (!counter) return;
    if (!input.value) counter.textContent = '';
    else if (!hits.length) counter.textContent = '无结果';
    else counter.textContent = `${cur + 1}/${hits.length}${hits.length >= MAX_HITS ? '+' : ''}`;
    counter.style.color = input.value && !hits.length ? '#ff7a7a' : '';
  }

  // ── 查找栏 ────────────────────────────────────────────────
  function build() {
    bar = document.createElement('div');
    bar.id = 'gcFindBar';
    bar.innerHTML = `
      <input id="gcFindInput" type="text" placeholder="页内查找…" autocomplete="off" spellcheck="false">
      <span id="gcFindCount"></span>
      <button id="gcFindPrev" title="上一个 (Shift+Enter)">↑</button>
      <button id="gcFindNext" title="下一个 (Enter)">↓</button>
      <button id="gcFindClose" title="关闭 (Esc)">✕</button>`;
    document.body.appendChild(bar);

    input = bar.querySelector('#gcFindInput');
    counter = bar.querySelector('#gcFindCount');

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      // 每敲一个字就全文扫一遍，长对话下会顿。等她停 180ms 再搜，打字过程是跟手的。
      debounce = setTimeout(() => search(input.value), 180);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    bar.querySelector('#gcFindPrev').onclick = () => go(-1);
    bar.querySelector('#gcFindNext').onclick = () => go(1);
    bar.querySelector('#gcFindClose').onclick = close;
  }

  function open() {
    if (!bar) build();
    bar.classList.add('show');
    watchDom();
    // 打开时如果正好选中了一段文字，直接拿来当搜索词——这是查找栏的老规矩
    const sel = String(window.getSelection() || '').trim();
    if (sel && sel.length <= 60 && !sel.includes('\n')) input.value = sel;
    input.focus();
    input.select();
    if (input.value) search(input.value);
  }

  function close() {
    if (!bar) return;
    // 刚敲完字 180ms 内就关：那一拍搜索还挂着，关完才落地，高亮画在已关的栏底下
    clearTimeout(debounce);
    debounce = null;
    bar.classList.remove('show');
    unwatchDom();
    clearHighlights();
    hits = [];
    cur = -1;
    lastQ = '';
  }

  function toggle() { (bar && bar.classList.contains('show')) ? close() : open(); }

  // ── 快捷键 ────────────────────────────────────────────────
  // 用捕获阶段：项目里已经有好几处 keydown 监听（Esc 关弹窗、输入框回车发送），
  // 冒泡阶段挂上去会被它们先吃掉或者互相打架。
  document.addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'f' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      open();
      return;
    }
    if (k === 'f3') { e.preventDefault(); bar && bar.classList.contains('show') ? go(e.shiftKey ? -1 : 1) : open(); return; }
    // 查找栏开着时 Esc 先关它，别让底下的弹窗跟着一起关了
    if (k === 'escape' && bar && bar.classList.contains('show')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);

  // 手机没有 Ctrl 键，给个能从别处调起来的入口（功能指南、工具栏都可以挂）
  window.openFindBar = open;
  window.closeFindBar = close;
  window.toggleFindBar = toggle;
})();
