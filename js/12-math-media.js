function _renderMathSymbols() {
  const wrap = document.getElementById('mathSymbols');
  if (!wrap || wrap.childElementCount) return;
  wrap.innerHTML = _MATH_SYMBOLS.map((s, i) =>
    `<button type="button" class="math-sym-btn" onclick="insertMathSymbol(${i})" title="${escHtml(s.t)}">${escHtml(s.l)}</button>`
  ).join('');
}
function insertMathSymbol(i) {
  const s = _MATH_SYMBOLS[i]; if (!s) return;
  const ta = document.getElementById('mathInput');
  const wasFocused = document.activeElement === ta;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + s.t + ta.value.slice(end);
  // 把光标停在第一个 {} 里，方便继续输入
  const brace = s.t.indexOf('{}');
  const caret = brace >= 0 ? start + brace + 1 : start + s.t.length;
  // 手机端：没在打字就别 focus——一 focus 就弹系统键盘，把面板顶掉。
  // 光标位置照样记得住（不 focus 也能 setSelectionRange），所以能一个接一个连点。
  if (!_isMobile() || wasFocused) ta.focus();
  ta.setSelectionRange(caret, caret);
  updateMathPreview();
}
function updateMathPreview() {
  const ta = document.getElementById('mathInput');
  const prev = document.getElementById('mathPreview');
  if (!ta || !prev) return;
  const tex = ta.value.trim();
  if (!tex) { prev.innerHTML = '<span style="color:var(--text-muted);font-size:12px">预览会显示在这里</span>'; return; }
  if (typeof katex === 'undefined') { prev.textContent = tex; return; }
  try {
    katex.render(tex, prev, { throwOnError: true, displayMode: true });
  } catch (e) {
    prev.innerHTML = `<span class="math-err">${escHtml(e.message.split('\n')[0])}</span>`;
  }
}
function toggleMathPanel() {
  const panel = document.getElementById('mathPanel');
  if (panel.classList.contains('open')) { closeMathPanel(); return; }
  closeStickerPanel(); closePlusMenu();   // 三个面板抢同一块「键盘位」，不能一起开
  _portalOut(panel);                 // 手机端：同样得搬出 .input-bar（滤镜坑）
  _renderMathSymbols();
  panel.classList.add('open');
  updateMathPreview();
  if (_isMobile()) {
    // 和表情/加号面板一样长在输入框下面那块键盘位上，输入栏被顶到面板正上方
    document.getElementById('mathOverlay')?.classList.add('open');
    document.getElementById('userInput')?.blur();
    _liftInput(panel);
    // 手机端不自动 focus 公式框：一 focus 就弹键盘，直接把面板盖了。
    // 要打字自己点公式框，平时靠下面那排符号按钮点就行。
  } else {
    setTimeout(() => document.getElementById('mathInput')?.focus(), 30);
  }
}
function closeMathPanel() {
  const panel = document.getElementById('mathPanel');
  if (!panel?.classList.contains('open')) return;
  panel.classList.remove('open');
  document.getElementById('mathOverlay')?.classList.remove('open');
  _portalHome(panel);
  _dropInput();
}
// ── 花字面板 ───────────────────────────────────────────────
// AI 能发的那几种字，用户自己也能发：[[MARK:]] 的六个参数 + [[GLITCH:]] 的四种样式。
//
// ⚠️ 面板只干一件事：**拼出那条标签**。预览不许自己画样式，必须调真的渲染器 ——
//   自己画一套的话，面板里好看、发出去不一样，而且以后渲染器改了参数
//   面板还停在旧样子，零报错。所见即所得是这个面板存在的全部理由。
let _fancyKind = 'mark';

function toggleFancyPanel() {
  const panel = document.getElementById('fancyPanel');
  if (panel.classList.contains('open')) { closeFancyPanel(); return; }
  closeStickerPanel(); closePlusMenu(); closeMathPanel();   // 都抢同一块「键盘位」
  _portalOut(panel);
  panel.classList.add('open');
  updateFancyPreview();
  if (_isMobile()) {
    document.getElementById('fancyOverlay')?.classList.add('open');
    document.getElementById('userInput')?.blur();
    _liftInput(panel);
    // 同数学面板：手机端不自动 focus，一 focus 就弹键盘把面板盖掉
  } else {
    setTimeout(() => document.getElementById('fancyText')?.focus(), 30);
  }
}
function closeFancyPanel() {
  const panel = document.getElementById('fancyPanel');
  if (!panel?.classList.contains('open')) return;
  panel.classList.remove('open');
  document.getElementById('fancyOverlay')?.classList.remove('open');
  _portalHome(panel);
  _dropInput();
}
// 拖色块/拉滑杆时顺手把对应的开关勾上 —— 不然「调了半天没反应」
function fancyTick(...ids) {
  for (const id of ids) { const el = document.getElementById(id); if (el) el.checked = true; }
  updateFancyPreview();
}
function setFancyKind(kind) {
  _fancyKind = kind === 'glitch' ? 'glitch' : 'mark';
  document.getElementById('fancyTabMark')?.classList.toggle('on', _fancyKind === 'mark');
  document.getElementById('fancyTabGlitch')?.classList.toggle('on', _fancyKind === 'glitch');
  const mk = document.getElementById('fancyMarkBody');
  const gl = document.getElementById('fancyGlitchBody');
  if (mk) mk.style.display = _fancyKind === 'mark' ? '' : 'none';
  if (gl) gl.style.display = _fancyKind === 'glitch' ? '' : 'none';
  updateFancyPreview();
}

// 把面板上的控件拼成一条标签。**唯一的真相来源** —— 预览和插入都用它，
// 保证「看到的」和「发出去的」是同一个字符串。
function fancyTagText() {
  const word = (document.getElementById('fancyText')?.value || '').trim();
  if (!word) return '';
  const v = id => document.getElementById(id)?.value;
  const on = id => !!document.getElementById(id)?.checked;
  if (_fancyKind === 'glitch') {
    const style = v('fancyGlitchStyle') || '';
    return `[[GLITCH: ${word}${style ? '|' + style : ''}]]`;
  }
  const params = [];
  // 渐变开着的时候不写 c —— 写了也是物理无效（字身要透明才透得出渐变），
  // 留在标签里只会让模型以为这两个能一起用。
  if (on('fancyCOn') && !on('fancyGOn')) params.push('c=' + v('fancyC'));
  if (on('fancyGOn')) {
    const stops = [v('fancyG1'), v('fancyG2')];
    if (on('fancyG3On')) stops.push(v('fancyG3'));
    const angle = Number(v('fancyGA'));
    params.push('g=' + (angle === 90 ? '' : angle + ':') + stops.join('-'));
  }
  if (on('fancyKOn')) params.push('k=' + Number(v('fancyKW')) + ':' + v('fancyK'));
  const s = Number(v('fancyS')), o = Number(v('fancyO'));
  if (s !== 1) params.push('s=' + s);
  if (o !== 1) params.push('o=' + o);
  const bMode = v('fancyBMode');
  if (bMode) {
    const amt = Number(v('fancyB'));
    params.push('b=' + (bMode === 'g' ? amt : bMode + amt));
  }
  const blend = v('fancyM');
  if (blend) params.push('m=' + blend);
  // 动效三档：闪烁 / 位移 / 形变。三者各占一条 CSS 属性通道（opacity / translate /
  // rotate·scale），互不覆盖，所以这里是三个独立的 if 而不是 else if ——
  // 「闪着往左飘还一边摇」是能同时写出来的。
  const fHz = Number(v('fancyF'));
  if (fHz > 0) params.push('f=' + fHz);
  const vMode = v('fancyVMode');
  if (vMode) {
    const amp = _fancyMoveAmp(vMode, Number(v('fancyV')));
    params.push('v=' + (vMode === 'dir' ? Number(v('fancyVA')) : vMode) + ':' + amp);
  }
  const wMode = v('fancyWMode');
  if (wMode === 'swing') params.push('w=swing:' + _markClamp(Number(v('fancyW')), 0.5, 20));
  else if (wMode === 'pulse') params.push('w=pulse:' + _fancyPulseScale(Number(v('fancyW'))));
  return `[[MARK: ${word}${params.length ? ' | ' + params.join(' ') : ''}]]`;
}

// 幅度按模式钳制。两边读同一张 _MARK_MOVE_PRESETS，否则面板写 20px、
// 渲染器夹到 12px，而且两边都不报错（见那张表上面的注释）。
function _fancyMoveAmp(mode, n) {
  const p = _MARK_MOVE_PRESETS[mode] || _MARK_DIR_AMP;
  return _markClamp(Number.isFinite(n) ? n : p.amp, p.min, p.max);
}
// 呼吸滑杆量的是「放大几成」（1..20），标签里收的是倍数（1.02..1.20）。
// 下限跟 _markWobble 的 1.02 对齐，不然拖到 1 会被悄悄抬成 2。
function _fancyPulseScale(n) {
  return +(1 + _markClamp(Number.isFinite(n) ? n : 12, 2, 60) / 100).toFixed(2);
}

function updateFancyPreview() {
  // 滑杆旁边的读数
  const setVal = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setVal('fancyGAVal', (document.getElementById('fancyGA')?.value || 90) + '°');
  setVal('fancyKWVal', Number(document.getElementById('fancyKW')?.value || 0.6).toFixed(1) + 'px');
  setVal('fancySVal', Number(document.getElementById('fancyS')?.value || 1).toFixed(1) + '×');
  setVal('fancyOVal', Number(document.getElementById('fancyO')?.value || 1).toFixed(2));
  setVal('fancyBVal', Number(document.getElementById('fancyB')?.value || 1.5).toFixed(1));

  // 动效三档的读数。数字一律走 _fancyMoveAmp / _fancyPulseScale 算出来，
  // 不直接抄滑杆的 value —— 抄了就会出现「写着 20px、动起来是 12px」。
  const fHz = Number(document.getElementById('fancyF')?.value || 0);
  setVal('fancyFVal', fHz > 0 ? fHz.toFixed(1) + 'Hz' : '关');
  const vMode = document.getElementById('fancyVMode')?.value || '';
  const vaEl = document.getElementById('fancyVA');
  setVal('fancyVAVal', (Number(vaEl?.value) || 0) + '°');
  setVal('fancyVVal', vMode
    ? _fancyMoveAmp(vMode, Number(document.getElementById('fancyV')?.value)) + 'px' : '关');
  // 角度只有「定向往复」吃，另外三种预设自带轨迹。留一条拖了没反应的滑杆
  // 比没有更糟，所以连读数一起藏掉。
  const dirOn = vMode === 'dir';
  if (vaEl) vaEl.style.display = dirOn ? '' : 'none';
  const vaValEl = document.getElementById('fancyVAVal');
  if (vaValEl) vaValEl.style.display = dirOn ? '' : 'none';
  const wMode = document.getElementById('fancyWMode')?.value || '';
  const wN = Number(document.getElementById('fancyW')?.value || 4);
  setVal('fancyWVal', !wMode ? '关'
    : wMode === 'swing' ? _markClamp(wN, 0.5, 20) + '°'
    : '+' + Math.round((_fancyPulseScale(wN) - 1) * 100) + '%');

  // 实测出来的两条坑，光看滑杆看不出来，得当场说
  const warn = document.getElementById('fancyWarn');
  if (warn) {
    const msgs = [];
    if (document.getElementById('fancyBMode')?.value === 'v'
        && Number(document.getElementById('fancyB')?.value) > 1.5) {
      msgs.push('纵向糊过 1.5，汉字的横笔画会没掉、只剩竖线');
    }
    if (document.getElementById('fancyKOn')?.checked
        && Number(document.getElementById('fancyKW')?.value) > 1.5) {
      msgs.push('描边超过 1.5，汉字的字心会被自己的边吃掉');
    }
    if (document.getElementById('fancyGOn')?.checked
        && document.getElementById('fancyCOn')?.checked) {
      msgs.push('开了渐变，颜色那格就不起作用了（字身要透明才透得出渐变）');
    }
    if (fHz >= 4) msgs.push('闪得比 4Hz 快，对光敏感的人不友好，慢一点更好看');
    // 系统开了「减少动态效果」的话，CSS 那边把三种动效全停掉（无障碍），
    // 面板上看着开着、实际不动 —— 这属于必须当场说的那类
    if ((fHz > 0 || vMode || wMode)
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      msgs.push('你系统开了「减少动态效果」，动效在本机不会播（标签照发，别人那边正常）');
    }
    warn.textContent = msgs.join('；');
  }

  const box = document.getElementById('fancyPreview');
  if (!box) return;
  const tag = fancyTagText();
  if (!tag) {
    box.innerHTML = '<span style="color:var(--text-muted);font-size:12px">预览会显示在这里</span>';
    return;
  }
  // ⚠️ 这里必须走真的渲染器。它同时也是一道体检：面板拼出来的标签要是渲染器
  //   认不出来，预览当场就是一段裸标签，肉眼可见 —— 比任何断言都直观。
  box.innerHTML = stickerTagToHtml(tag);
}

function insertFancy() {
  const tag = fancyTagText();
  if (!tag) { closeFancyPanel(); return; }
  const input = document.getElementById('userInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + tag + input.value.slice(end);
  const caret = start + tag.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  autoResize(input);
  if (typeof updateInputTokenEstimate === 'function') updateInputTokenEstimate();
  const ta = document.getElementById('fancyText');
  if (ta) ta.value = '';
  closeFancyPanel();
}
// 点面板外关闭。同数学面板：手机端面板被搬到 body 上了，
// 光判断 wrap 会把「点面板自己」也当成点了外面。
document.addEventListener('click', e => {
  const panel = document.getElementById('fancyPanel');
  if (!panel?.classList.contains('open')) return;
  if (!e.target.closest('#fancyPanel') && !e.target.closest('.plus-menu-wrap')
      && !e.target.closest('.expand-tool-btn')) closeFancyPanel();
});

function insertMath(displayMode) {
  const ta = document.getElementById('mathInput');
  const tex = (ta?.value || '').trim();
  if (!tex) { closeMathPanel(); return; }
  const wrapped = displayMode ? `$$${tex}$$` : `$${tex}$`;
  const input = document.getElementById('userInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const pad = displayMode ? '\n' : '';
  input.value = input.value.slice(0, start) + pad + wrapped + pad + input.value.slice(end);
  const caret = start + pad.length + wrapped.length + pad.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  autoResize(input);
  if (typeof updateInputTokenEstimate === 'function') updateInputTokenEstimate();
  ta.value = '';
  closeMathPanel();
}
// 点面板外关闭。手机端面板被搬到 body 上了（滤镜坑），光判断 .math-picker-wrap 会把
// 「点面板自己」也当成点了外面——用户遇到的「点一个符号就自动退出」就是这么来的。
document.addEventListener('click', e => {
  const panel = document.getElementById('mathPanel');
  if (!panel?.classList.contains('open')) return;
  // 别把「打开它的那个按钮」也算成点了外面 —— 展开编辑器工具条上的 ∑ 就栽在这：
  // onclick 刚把面板打开，同一次 click 冒泡到这里又立刻关掉，看起来像「点了没反应」。
  if (!e.target.closest('.math-picker-wrap') && !e.target.closest('#mathPanel')
      && !e.target.closest('.plus-menu-wrap') && !e.target.closest('.expand-tool-btn')) closeMathPanel();
});

function _initStickerDrag(panel) {
  if (panel._dragBound) return;
  panel._dragBound = true;
  let startY = 0, currentY = 0, dragging = false;
  panel.addEventListener('touchstart', e => {
    const t = e.target;
    if (t.closest('.sticker-grid') && panel.querySelector('.sticker-grid').scrollTop > 0) return;
    if (t.closest('.sticker-search-input')) return;
    startY = e.touches[0].clientY;
    dragging = true;
    panel.style.transition = 'none';
  }, { passive: true });
  panel.addEventListener('touchmove', e => {
    if (!dragging) return;
    currentY = e.touches[0].clientY - startY;
    if (currentY < 0) currentY = 0;
    panel.style.transform = `translateY(${currentY}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    if (currentY > 80) {
      closeStickerPanel();
    } else {
      panel.style.transform = '';
    }
    currentY = 0;
  }, { passive: true });
}

function switchStickerTab(tab, ev) {
  _stickerTab = tab;
  // 两套标签共用一个状态：电脑端是面板顶上那排字，手机端是底部那条图标栏（TIM 式）
  document.querySelectorAll('.sticker-tab, .sticker-tabbar-btn').forEach(t => {
    if (t.dataset.stab) t.classList.toggle('active', t.dataset.stab === tab);
  });
  renderStickerView();
  if (tab === 'search' && !_isMobile()) {
    setTimeout(() => document.getElementById('stickerSearchInput')?.focus(), 50);
  }
}

// 收藏 = App 里存的（云端 / 本地服务器 stickers-fav/ 里的）——能删。
// 自带表情库 = 项目 stickers/ 文件夹整个（作者准备的本地库）——软件层删不掉。
function _favStickers() { return _stickerList.filter(s => s.custom || s.source === 'cloud'); }
function _libStickers() { return _stickerList.filter(s => !s.custom && s.source !== 'cloud' && s.source !== 'pack'); }

/* ── 表情包分组 ───────────────────────────────────────────────────────
   两种「栏」共用一套渲染，区别只在成员从哪来：
     包 pack:<id>   stickers-packs/<id>/ 一个文件夹一栏，成员由磁盘决定，不用手动归类
     分组 grp:<id>  用户自建，成员靠 state.stickerGroupOf 这张表，任何来源的表情都能放进来
   名字和图标都能改。包的覆盖也存进 state.stickerGroups（pack:true 的条目），
   这样「自定义图标」只有一处逻辑、一份持久化，不必为包再开一个 state 字段 ——
   多开一个就要多过一遍持久化的三道白名单，漏一道就是刷新后图标悄悄变回去。*/

// 表情的唯一键。必须和 loadStickers 里的 merge key 是同一套算法：
// 两边不一致的话，归组表里的键会指向一个 _stickerList 里根本不存在的表情，
// 症状是「分组里凭空少几张」，而两处代码单看都没错。
function stickerKey(s) {
  return s.source === 'pack' ? `pack:${s.pack}/${s.file}` : s.name;
}
function _packStickers(pid) { return _stickerList.filter(s => s.source === 'pack' && s.pack === pid); }

/* 分组的版本是**逻辑计数器**，不是时间戳 —— 时间戳靠设备时钟，一台机器时钟快一年
   就能长期压住另一台（favGroups 当年踩过，合并那头的注释里写着）。每次写 +1，
   跨设备合并时取 max，所以本地 ver 永远大于本地用过的所有版本。 */
function _bumpGroupVer() {
  state.stickerGroupsVer = (state.stickerGroupsVer || 0) + 1;
  return state.stickerGroupsVer;
}
function _stkOp(id, isPack) { return (isPack ? 'p:' : 'g:') + id; }
/* 这两张表的键是表情名 / 分组 id，而表情可以叫 `__proto__.png`（收藏是按文件名起的）。
   普通 {} 碰上这个键，赋值会写进原型：Object.keys 看不到它、JSON.stringify 出来是空的，
   界面上当场看着像成功了，一刷新或者一同步，那条归属就没了 —— 全程零报错。
   从 IndexedDB 反序列化回来的又是普通对象，所以每次写之前都得确认一遍。
   （favGroupOps 早就因为同一个原因用的无原型对象，见 06-render-msg 那段注释。） */
function _nullProto(o) {
  if (o && Object.getPrototypeOf(o) === null) return o;
  const m = Object.create(null);
  for (const k of Object.keys(o || {})) m[k] = o[k];
  return m;
}
// 存活判定：a = 最后一次新建的版本，d = 最后一次删除的版本，a >= d 即存活（撞平偏向保留）。
// 没有 ops 记录的当成「0 版建的」——老数据和升级前建的分组照样活着。
function _groupAlive(id, isPack) {
  const ops = state.stickerGroupOps || {}, k = _stkOp(id, isPack);
  const o = Object.prototype.hasOwnProperty.call(ops, k) ? ops[k] : null;
  return !o || (o.a || 0) >= (o.d || 0);
}
function _markGroup(id, isPack, kind) {   // kind: 'a' 新建 / 'd' 删除
  state.stickerGroupOps = _nullProto(state.stickerGroupOps);
  const k = _stkOp(id, isPack);
  const cur = state.stickerGroupOps[k] || { a: 0, d: 0 };
  const v = _bumpGroupVer();
  state.stickerGroupOps[k] = kind === 'd' ? { a: cur.a, d: v } : { a: v, d: cur.d };
  return v;
}

/* 归属表的值是 { g: 分组id 或 null, v: 逻辑版本 }，不是裸的分组id。
   为什么要包一层：两台设备都在改这张表，删除必须能传播过去 —— 只靠「本地优先合并」的话，
   这台删掉的归属会被另一台的旧值原样送回来复活（Codex 审出来的）。
   g=null 是「已移出」的墓碑，**不清理**：清掉它，另一台的旧归属就会把这张表情塞回分组。
   老格式（裸字符串）也认，免得先写进去的数据在这次改动后全失效。 */
function _groupIdOf(key) {
  const map = state.stickerGroupOf || {};
  // 普通对象上 map['__proto__'] 读到的是 Object.prototype（一个 truthy 的对象），
  // 不查自有属性的话会把它当成一条归属记录
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  const v = map[key];
  if (v == null) return null;
  return typeof v === 'string' ? v : (v.g || null);
}
function _setGroupOf(key, gid) {
  state.stickerGroupOf = _nullProto(state.stickerGroupOf);
  state.stickerGroupOf[key] = { g: gid || null, v: _bumpGroupVer() };
}

/* [[STICKER:…]] 里写什么、怎么查回来 —— 一处生成一处解析，别再各写各的。

   包里的表情**一律**写 `包id/完整文件名`（含扩展名），不管当时撞没撞名。
   为什么不是「撞名才加前缀」（我第一版就是那么写的，Codex 二审打回来）：
     · 同一个包里 爱心.png 和 爱心.gif，按显示名生成的前缀引用还是同一个，照样分不开
     · 引用要存进历史消息里躺很久。今天不撞名写了短名字，明天用户收藏一张同名的图，
       那条老消息就悄悄改成指向新的那张了 —— 而 loadStickers 把包排在收藏前面，
       改指向的恰好是包里那张。**一个持久引用的含义不该随当前列表变化。**
   收藏和自带库仍然写名字：它们本来就是按名字存的，改了等于把所有老消息作废。

   解析反过来，三级兼容：带斜杠的先按 包id+文件名 精确找 → 再按 包id+显示名（旧写法）→
   最后剥掉前缀按名字找（包被删了、换了台机器、APK 里没打进去）。
   这样老消息、新消息、有包没包，走的是同一条路。 */
function stickerRef(s) {
  if (!s) return '';
  return s.source === 'pack' ? `${s.pack}/${s.file}` : s.name;
}
function findSticker(ref) {
  const r = String(ref || '').trim();
  const i = r.indexOf('/');
  if (i > 0) {
    const pid = r.slice(0, i), nm = r.slice(i + 1);
    const inPack = _stickerList.filter(s => s.source === 'pack' && s.pack === pid);
    // 文件名优先：同一个包里 爱心.png / 爱心.gif 只有文件名分得开
    const hit = inPack.find(s => s.file === nm) || inPack.find(s => s.name === nm);
    if (hit) return hit;
    // 包不在了：退回**剥掉前缀之后**的名字去找。忘了剥的话就是拿 "keke/爱心.gif" 整个
    // 去比 name，永远找不到 —— 老消息变成一行裸标签。
    const bare = nm.replace(/\.[^.]+$/, '');
    const byName = _stickerList.find(s => s.name === nm) || _stickerList.find(s => s.name === bare);
    if (byName) return byName;
  }
  const hit = _stickerList.find(s => s.name === r);
  if (hit) return hit;
  // 自带库里撤掉的表情（sad、wink）：老消息里的 [[STICKER:sad]] 退到意思最近的那张，别露一行裸标签
  const RETIRED = { sad: 'cry', wink: 'happy' };
  if (Object.prototype.hasOwnProperty.call(RETIRED, r)) return _stickerList.find(s => s.name === RETIRED[r]) || null;
  return null;
}
function _groupStickers(gid) {
  return _stickerList.filter(s => _groupIdOf(stickerKey(s)) === gid);
}
function _grpEntry(id, isPack) {
  if (!_groupAlive(id, isPack)) return null;
  return (state.stickerGroups || []).find(g => g.id === id && !!g.pack === !!isPack);
}
// 磁盘包的显示名/图标：用户改过就用她的，没改过用 pack.json 里的
function _packMeta(p) {
  const ov = _grpEntry(p.id, true) || {};
  return { id: p.id, name: ov.name || p.name, icon: ov.icon || '', iconUrl: p.iconUrl || '' };
}
// 标签栏上所有「额外的栏」，顺序 = 磁盘包在前、自建分组在后
function _stickerTabDefs() {
  const packs = (_stickerPacks || []).map(p => {
    const m = _packMeta(p);
    return { stab: 'pack:' + p.id, id: p.id, isPack: true, name: m.name, icon: m.icon, iconUrl: m.iconUrl };
  });
  const grps = (state.stickerGroups || []).filter(g => !g.pack && _groupAlive(g.id, false)).map(g => ({
    stab: 'grp:' + g.id, id: g.id, isPack: false, name: g.name || '分组', icon: g.icon || '', iconUrl: ''
  }));
  return [...packs, ...grps];
}
// 图标既可能是 emoji 文本，也可能是一张图（包自带的 _icon.png，或用户上传的 dataURL）
function _tabIconHtml(icon, iconUrl, size) {
  const src = (icon && /^(data:|https?:|\/)/.test(icon)) ? icon : (!icon && iconUrl ? iconUrl : '');
  if (src) return `<img class="sticker-tab-ico" src="${escHtml(src)}" alt="" style="width:${size}px;height:${size}px">`;
  return `<span class="sticker-tab-emo" style="font-size:${size - 3}px;line-height:1">${escHtml(icon || '📁')}</span>`;
}

// 重画两条标签栏里「内建三栏之后」的那段。内建按钮（含它们的 SVG）留在 index.html 里不动，
// 这里只填两个容器 —— 动态的部分和写死的部分分开，改一边不会碰坏另一边。
function renderStickerTabs() {
  const defs = _stickerTabDefs();
  const top = document.getElementById('stickerTabsExtra');
  if (top) {
    top.innerHTML = defs.map(d => `
      <div class="sticker-tab${_stickerTab === d.stab ? ' active' : ''}" data-stab="${escHtml(d.stab)}"
           onclick="switchStickerTab(${jsAttr(d.stab)},event)"
           oncontextmenu="event.preventDefault();openStickerGroupEditor(${jsAttr(d.stab)})"
           title="${escHtml(d.name)}（右键可改名字和图标）">
        ${_tabIconHtml(d.icon, d.iconUrl, 14)}<span>${escHtml(d.name)}</span>
      </div>`).join('') +
      `<div class="sticker-tab sticker-tab-new" onclick="newStickerGroup()" title="新建一个分组">＋组</div>`;
  }
  const bar = document.getElementById('stickerTabbarExtra');
  if (bar) {
    bar.innerHTML = defs.map(d => `
      <button type="button" class="sticker-tabbar-btn${_stickerTab === d.stab ? ' active' : ''}" data-stab="${escHtml(d.stab)}"
              onclick="switchStickerTab(${jsAttr(d.stab)},event)"
              oncontextmenu="event.preventDefault();openStickerGroupEditor(${jsAttr(d.stab)})"
              ontouchstart="_stkTabPress(event,${jsAttr(d.stab)})" ontouchend="_stkTabRelease()" ontouchmove="_stkTabRelease()"
              title="${escHtml(d.name)}（长按可改名字和图标）">
        ${_tabIconHtml(d.icon, d.iconUrl, 21)}
      </button>`).join('') +
      `<button type="button" class="sticker-tabbar-btn" onclick="newStickerGroup()" title="新建分组">
         <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5a2 2 0 0 1 2-2h3.6l1.7 2.2H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/></svg>
       </button>`;
  }
}

// 手机上没有右键：长按分组图标 = 打开编辑器。按住 600ms 起效，和消息长按同一个手感。
let _stkTabTimer = null;
function _stkTabPress(ev, stab) {
  clearTimeout(_stkTabTimer);
  _stkTabTimer = setTimeout(() => { _stkTabTimer = null; openStickerGroupEditor(stab); }, 600);
}
function _stkTabRelease() { clearTimeout(_stkTabTimer); _stkTabTimer = null; }

function newStickerGroup() {
  const id = 'g' + Date.now().toString(36);
  state.stickerGroups = state.stickerGroups || [];
  state.stickerGroups.push({ id, name: '新分组', icon: '📁', v: _markGroup(id, false, 'a') });
  save();
  renderStickerTabs();
  switchStickerTab('grp:' + id);
  openStickerGroupEditor('grp:' + id);
}

/* 分组编辑器：改名 / 换图标（emoji 或上传图片）/ 删除。
   用独立的小模态而不是 appPrompt，是因为「自定义图标」要能选图 —— 一个文本框装不下。*/
let _editingStab = null;
let _sgPendingIcon = '';
function openStickerGroupEditor(stab) {
  const isPack = stab.startsWith('pack:');
  const id = stab.slice(stab.indexOf(':') + 1);
  const p = isPack ? (_stickerPacks || []).find(x => x.id === id) : null;
  if (isPack && !p) return;
  const cur = isPack ? _packMeta(p) : (_grpEntry(id, false) || { name: '分组', icon: '📁' });
  _editingStab = stab;
  const modal = document.getElementById('stickerGroupModal');
  if (!modal) return;
  const isImgIcon = !!(cur.icon && /^(data:|https?:|\/)/.test(cur.icon));
  modal.querySelector('#sgName').value = cur.name || '';
  modal.querySelector('#sgEmoji').value = isImgIcon ? '' : (cur.icon || '');
  modal.querySelector('#sgCount').textContent = isPack
    ? `${_packStickers(id).length} 个（来自文件夹 stickers-packs/${id}/，内容由磁盘决定）`
    : `${_groupStickers(id).length} 个`;
  modal.querySelector('#sgDelBtn').style.display = isPack ? 'none' : '';
  modal.querySelector('#sgPackHint').style.display = isPack ? '' : 'none';
  _sgPendingIcon = isImgIcon ? cur.icon : '';
  _sgFallbackIconUrl = cur.iconUrl || '';
  _sgRenderPreview();
  modal.classList.remove('hidden');
}
let _sgFallbackIconUrl = '';
function _sgRenderPreview() {
  const box = document.getElementById('sgIconPreview');
  if (!box) return;
  const emo = document.getElementById('sgEmoji').value.trim();
  box.innerHTML = _tabIconHtml(_sgPendingIcon || emo, _sgFallbackIconUrl, 30);
}
function closeStickerGroupEditor() {
  document.getElementById('stickerGroupModal')?.classList.add('hidden');
  _editingStab = null;
}
// 上传的图标压到 64px 见方存 dataURL：它要跟着云同步的 settings 走，原图几百 KB 会把设置包撑爆。
// 像素画（比如那只像素猫）缩放时关掉平滑，不然会糊成一团。
async function sgPickIcon(input) {
  const f = (input.files || [])[0];
  input.value = '';
  if (!f) return;
  try {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    if (img.width <= 64 && img.height <= 64 && url.length < 24000) {
      _sgPendingIcon = url;                       // 已经很小了，原样存，一个像素都不动
    } else {
      const side = 64;
      const cv = document.createElement('canvas');
      cv.width = cv.height = side;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = !(img.width <= 128 && img.height <= 128);
      const k = Math.min(side / img.width, side / img.height);
      const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      ctx.drawImage(img, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
      _sgPendingIcon = cv.toDataURL('image/png');
    }
    document.getElementById('sgEmoji').value = '';
    _sgRenderPreview();
  } catch (e) { showToast('图标读取失败: ' + e.message, 'error'); }
}
function sgClearIcon() { _sgPendingIcon = ''; document.getElementById('sgEmoji').value = ''; _sgRenderPreview(); }
function saveStickerGroupEditor() {
  if (!_editingStab) return;
  const isPack = _editingStab.startsWith('pack:');
  const id = _editingStab.slice(_editingStab.indexOf(':') + 1);
  const name = document.getElementById('sgName').value.trim();
  const emoji = document.getElementById('sgEmoji').value.trim();
  const icon = _sgPendingIcon || emoji;
  state.stickerGroups = state.stickerGroups || [];
  let entry = _grpEntry(id, isPack);
  if (!entry) {
    entry = isPack ? { id, pack: true } : { id };
    state.stickerGroups.push(entry);
    _markGroup(id, isPack, 'a');       // 没有 ops 记录的话，这条覆盖在另一台设备上判不出存活
  }
  entry.name = name || entry.name || (isPack ? id : '分组');
  entry.icon = icon;
  // 只抬属性版本，不碰 ops：改个名字不该把一个已经被别的设备删掉的分组复活
  entry.v = _bumpGroupVer();
  save();
  closeStickerGroupEditor();
  renderStickerTabs();
  showToast('✓ 已保存', 'success');
}
function deleteStickerGroup() {
  if (!_editingStab || _editingStab.startsWith('pack:')) return;
  const id = _editingStab.slice(4);
  const n = _groupStickers(id).length;
  if (!confirm(`删除这个分组？${n ? `组里那 ${n} 个表情只是移出分组，图本身不会被删。` : ''}`)) return;
  _markGroup(id, false, 'd');          // 墓碑进 ops 表，条目本身留着（属性还要用来显示历史）
  for (const k of Object.keys(state.stickerGroupOf || {})) {
    if (_groupIdOf(k) === id) _setGroupOf(k, null);
  }
  save();
  closeStickerGroupEditor();
  if (_stickerTab === 'grp:' + id) _stickerTab = 'fav';
  renderStickerTabs();
  renderStickerView();
}

/* 往分组里加表情：进「挑选模式」——格子换成全部表情，点一下切换在不在本组，
   再点一次「完成」退出。比逐个右键快，而且一眼能看出哪些已经在组里了。*/
let _stickerPickFor = null;
function toggleStickerPick(gid) {
  _stickerPickFor = _stickerPickFor ? null : gid;
  renderLocalStickers();
}
function toggleStickerInGroup(key) {
  if (!_stickerPickFor) return;
  _setGroupOf(key, _groupIdOf(key) === _stickerPickFor ? null : _stickerPickFor);
  save();
  renderLocalStickers();
}
function removeFromGroup(key) {
  _setGroupOf(key, null);      // 写墓碑而不是 delete：delete 传不到另一台设备
  save();
  renderLocalStickers();
}

function renderStickerView() {
  const searchWrap = document.getElementById('stickerSearchWrap');
  const loadMore = document.getElementById('stickerLoadMore');
  const grid = document.getElementById('stickerGrid');
  if (_stickerTab === 'search') {
    searchWrap.style.display = 'flex';
    loadMore.style.display = _gifSearchOffset > 0 ? 'block' : 'none';
    if (!grid.dataset.hasResults) {
      grid.innerHTML = !state.tenorApiKey
        ? `<div class="sticker-no-key" style="grid-column:1/-1">需要先在 设置 → 表情包 中填写 <a href="https://developers.giphy.com/" target="_blank">Giphy API Key</a>（免费）才能搜索 GIF</div>`
        : `<div class="sticker-no-key" style="grid-column:1/-1">输入关键词搜索 GIF 表情包<br>例如：猫猫、doge、开心、哭了</div>`;
    }
  } else {
    searchWrap.style.display = 'none';
    loadMore.style.display = 'none';
    renderLocalStickers();
  }
}

// 云端收藏没拉到时挂在收藏栏最上面的条子。
// 为什么非要有它：收藏的图存在 Supabase 桶里，掉登录 / 超时的时候 loadCloudStickers 返回空数组，
// 收藏栏就只剩本地那几张甚至全空 —— 用户看到的是「我的收藏全没了」，而云端一张都没少。
// 静默是这个 bug 唯一的伤害，所以这里宁可多挂一条也不许不吭声。
function _cloudStickerBanner() {
  if (_cloudStickerState.ok) return '';
  if (typeof CLOUD_ENABLED !== 'undefined' && !CLOUD_ENABLED) return '';   // 没配云同步：本来就只有本地收藏，不用喊
  const loggedOut = _cloudStickerState.reason === 'logged-out';
  if (loggedOut && !_authChecked) return '';   // 登录还在查，先别喊没登录
  // 「登录状态没查出来」跟「确认没登录」得分开说：对一个其实登录着的人说她没登录，
  // 会把她引去重新登录——一个错误的修复动作，而真正的毛病在网络/存储。
  const unknown = loggedOut && _authCheckFailed;
  const detail = _cloudStickerState.detail ? `（${escHtml(_cloudStickerState.detail)}）` : '';
  const why = unknown ? '：登录状态没查出来（多半是网络）' : loggedOut ? '：当前未登录' : detail;
  // 措辞只许说这一路自己知道的事。「你云端的收藏还在，没有丢」是句证明不了的承诺：
  // 这一路唯一知道的是「列表没取回来」，它区分不了「桶里有但拉不到」和「本来就没同步过 / 换了账号」。
  // 拿它安慰对了九次，第十次就是骗人 —— 而这个 bug 的伤害本来就是「界面说的话不可信」。
  return `<div class="sticker-cloud-warn" style="grid-column:1/-1">
      ⚠️ 云端收藏没加载出来${why}，下面显示的只是本地的。
      <span style="font-size:12px">这只说明这次没取到，不代表云端的收藏没了；本地这些一张也没动。</span>
      <div style="margin-top:6px">
        ${unknown
          ? `<button onclick="retryAuthAndStickers(this)">重试</button>
             <button onclick="document.getElementById('authModal').classList.remove('hidden')" class="secondary">还是去登录</button>`
          : loggedOut
            ? `<button onclick="document.getElementById('authModal').classList.remove('hidden')">去登录</button>`
            : `<button onclick="retryCloudStickers(this)">重新加载</button>`}
      </div>
    </div>`;
}

// 登录状态没查出来时那颗「重试」：先重查登录，再重拉表情。
// 只重拉表情没用 —— 病根是登录状态未知，得先把它问清楚。
async function retryAuthAndStickers(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '重试中…'; }
  try { await checkUser(); } catch (e) { /* checkUser 自己会记 _authCheckFailed */ }
  await loadStickers();
  if (_stickerTab !== 'search') renderLocalStickers();
}

// 条子上的「重新加载」：重拉一遍三个来源再重画。失败了照样会被 banner 接住，不用自己报错。
async function retryCloudStickers(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
  await loadStickers();
  if (_stickerTab !== 'search') renderLocalStickers();
  if (_cloudStickerState.ok) showToast('✓ 云端收藏已恢复', 'success');
}

// 一个函数渲染除「搜索」外的所有栏：收藏 / 自带库 / 磁盘包 / 自建分组 / 分组的挑选模式。
// 差别只有四样：列表来源、空状态文案、格子右上角那颗按钮、底下跟着什么操作块。
function renderLocalStickers() {
  const grid = document.getElementById('stickerGrid');
  if (!grid) return;          // loadStickers 现在会自己回调这里，可能赶在面板 DOM 之前
  grid.dataset.hasResults = '';
  const tab    = _stickerTab;
  const isLib  = tab === 'lib';
  const isPack = tab.indexOf('pack:') === 0;
  const isGrp  = tab.indexOf('grp:') === 0;
  const id     = (isPack || isGrp) ? tab.slice(tab.indexOf(':') + 1) : '';
  // 挑选模式只属于「当前这个自建分组」：切到别的栏还留着它，点一下就会把表情加进上一个组里去
  const picking = isGrp && _stickerPickFor === id;
  if (!isGrp && _stickerPickFor) _stickerPickFor = null;

  const list = picking ? _stickerList
    : isPack ? _packStickers(id)
    : isGrp  ? _groupStickers(id)
    : isLib  ? _libStickers()
    : _favStickers();

  const addBtn = `<div class="sticker-add-btn" onclick="document.getElementById('stickerFileInput').click()" title="上传表情">+</div>`;
  const pickBtn = isGrp && !picking
    ? `<div class="sticker-add-btn" onclick="toggleStickerPick(${jsAttr(id)})" title="从全部表情里挑几个放进这个分组">+</div>` : '';
  const pickBar = picking
    ? `<div class="sticker-pick-bar" style="grid-column:1/-1">
         点表情加入 / 移出「${escHtml((_grpEntry(id, false) || {}).name || '分组')}」，图本身不会被动
         <button onclick="toggleStickerPick(${jsAttr(id)})">完成</button>
       </div>` : '';
  // 云端那条警告只跟「收藏」有关：自带库、磁盘包、自建分组都不从云端来，别拿它去吓人
  const banner = (isLib || isPack || isGrp) ? '' : _cloudStickerBanner();

  if (!list.length) {
    grid.innerHTML = pickBar + (
      isPack
        ? `<div class="sticker-no-key" style="grid-column:1/-1">这个分组的文件夹是空的<br>
            <span style="font-size:12px">往 <code>stickers-packs/${escHtml(id)}/</code> 里丢图片就会出现在这栏<br>
            （可选：同目录放一个 pack.json 写组名、图标和每张图的含义给 AI 看）</span></div>`
      : isGrp
        ? `<div class="sticker-no-key" style="grid-column:1/-1">这个分组还是空的<br>
            <span style="font-size:12px">点下面的 ＋ 从全部表情里挑几个放进来<br>
            （分组只是给表情贴个标签，收藏和自带库里的图都还在原处）</span></div>`
      : isLib
        ? `<div class="sticker-no-key" style="grid-column:1/-1">自带表情库是空的<br>
            <span style="font-size:12px">把图片丢进项目的 stickers/ 文件夹就会出现在这里，不用写 manifest.json<br>
            （manifest 只是给它们补个中文说明给 AI 看；这一栏的表情软件里删不掉）</span></div>`
        // 云端没拉到的时候，「还没有收藏的表情」这句是假话 —— 那种情况下只挂条子，别再劝人去收藏
        : banner || `<div class="sticker-no-key" style="grid-column:1/-1">
            还没有收藏的表情<br>
            <span style="font-size:12px">在「搜索」里点 ★ 收藏 GIF，或者点右下角 ＋ 上传自己的图<br>
            登录账号后收藏会存到云端，手机电脑同步</span>
          </div>`);
    if (isGrp) grid.innerHTML += pickBtn;
    else if (!isLib && !isPack) grid.innerHTML += addBtn;
    return;
  }

  grid.innerHTML = pickBar + banner + list.map(s => {
    const key  = stickerKey(s);
    const note = (state.stickerNotes || {})[s.name] || '';
    const inThis = _groupIdOf(key) === id;
    // 挑选模式下点格子是「加进组 / 移出组」，不是发送 —— 这时不显示任何角标按钮，
    // 免得手指点偏就把图删了（删除是不可逆的，挑选是随手的，两者不该挨着）
    if (picking) {
      return `
    <div class="sticker-item${inThis ? ' picked' : ''}" onclick="toggleStickerInGroup(${jsAttr(key)})"
         title="${escHtml(s.desc || s.name)}${inThis ? '（已在本组）' : ''}">
      <img src="${escHtml(s.url)}" alt="${escHtml(s.name)}" loading="lazy" onerror="_stickerImgRetry(this)">
      ${inThis ? '<span class="sticker-pick-tick">✓</span>' : ''}
    </div>`;
    }
    // 删除只给收藏：云端的删云端，本地服务器上的删文件；打进 APK 的、磁盘包里的都删不掉（也不该删）。
    // 分组栏里那颗是「移出分组」，只动归属表，绝不碰图片本身。
    const cornerBtn = isGrp
      ? `<button class="sticker-del-fav" onclick="event.stopPropagation();removeFromGroup(${jsAttr(key)})" title="移出这个分组（不删图）">−</button>`
      : (isLib || isPack) ? ''
        : s.source === 'cloud'
          ? `<button class="sticker-del-fav" onclick="event.stopPropagation();deleteCloudSticker(${jsAttr(s.file)})" title="从云端删除">×</button>`
          : s.source === 'server'
            ? `<button class="sticker-del-fav" onclick="event.stopPropagation();deleteServerSticker(${jsAttr(s.file)})" title="删除这个表情">×</button>`
            : '';
    // 「不给 AI 用」的那张：图淡一点 + 左下角一个小记号。她自己点照样发
    const aiOff = typeof stickerAiOff === 'function' && stickerAiOff(s.name);
    return `
    <div class="sticker-item${note ? ' has-note' : ''}${aiOff ? ' ai-off' : ''}" onclick="sendLocalSticker(${jsAttr(stickerRef(s))})" title="${escHtml(s.desc)}${note ? '\n给AI的备注: ' + escHtml(note) : ''}${aiOff ? '\n不给 AI 用' : ''}${s.source === 'cloud' ? '（云端）' : ''}${s.source === 'pack' ? '（' + escHtml(s.packName || s.pack) + '）' : ''}">
      <img src="${escHtml(s.url)}" alt="${escHtml(s.name)}" loading="lazy" onerror="_stickerImgRetry(this)">
      <button class="sticker-note-btn" onclick="event.stopPropagation();editStickerNote(${jsAttr(s.name)})" title="备注给 AI 看的名字 / 不给 AI 用">✏️</button>
      ${aiOff ? '<span class="sticker-ai-off-tag" aria-label="不给 AI 用">AI✕</span>' : ''}
      ${cornerBtn}
    </div>`;
  }).join('') +
    (picking ? '' : isGrp ? pickBtn : (isLib || isPack) ? '' : addBtn) +
    (!isLib && !isPack && !isGrp && list.some(s => s.source === 'server')
      ? `<div class="sticker-add-btn" onclick="migrateLocalStickersToCloud()" title="把只存在本地服务器的收藏表情上传到云端（全设备同步）">⇪</div>`
      : '');
}

// 删掉存在电脑 server.js 的 stickers/ 文件夹里的收藏（自带库那套 manifest 里的删不掉，服务端也会挡）
async function deleteServerSticker(file) {
  if (!confirm(`删除表情「${file}」？（从电脑的 stickers/ 文件夹里删掉）`)) return;
  try {
    const res = await fetch(SERVER_BASE + '/api/sticker-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (!data.ok) { showToast('删除失败: ' + (data.error || '未知错误'), 'error'); return; }
    showToast('已删除', 'success');
    await loadStickers();
    renderStickerView();
  } catch (e) {
    showToast('删除失败（连不上电脑上的 server）: ' + e.message, 'error');
  }
}

// 把只存在本地服务器 stickers/ 文件夹里的收藏批量搬到 Supabase Storage（云端表情库）。
// 同名文件 upsert，云端已有的下次 loadStickers 合并时自然去重。
async function migrateLocalStickersToCloud() {
  if (!currentUser) { showToast('先登录账号才能把收藏上云', 'error'); return; }
  const targets = _stickerList.filter(s => s.source === 'server');
  if (!targets.length) { showToast('本地收藏都已经在云端了', 'success'); return; }
  if (!confirm(`把 ${targets.length} 个本地收藏的表情上传到云端？（全设备同步）`)) return;
  let ok = 0, fail = 0;
  showToast(`⇪ 开始上云 ${targets.length} 个表情…`);
  for (const s of targets) {
    try {
      const resp = await fetch(s.url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const { error } = await supabaseClient.storage.from(STICKER_BUCKET)
        .upload(currentUser.id + '/' + s.file, blob, { upsert: true, contentType: blob.type || 'image/png' });
      if (error) throw new Error(error.message);
      ok++;
    } catch(e) { fail++; console.warn('[表情上云]', s.file, e.message); }
  }
  showToast(`⇪ 上云完成：成功 ${ok} 个${fail ? '，失败 ' + fail + ' 个' : ''}`, fail ? 'warn' : 'success', 4500);
  await loadStickers();
  renderLocalStickers();
}

let _gifSearchOffset = 0;
let _lastGifQuery = '';   // 当前搜索词，随所选 GIF 一起写入 [[GIF:url|关键词]]，让 AI 知道用户发的是什么表情

async function searchTenorGifs(loadMore = false) {
  if (!state.tenorApiKey) {
    showToast('请先在 设置 → 表情包 中填写 Giphy API Key', 'error', 3000);
    return;
  }
  const input = document.getElementById('stickerSearchInput');
  const q = input.value.trim();
  if (!q) return;
  _lastGifQuery = q;
  const grid = document.getElementById('stickerGrid');
  if (!loadMore) {
    grid.innerHTML = `<div class="sticker-no-key" style="grid-column:1/-1">搜索中…</div>`;
    _gifSearchOffset = 0;
  }
  try {
    const res = await fetch(`${SERVER_BASE}/api/gif-search?q=${encodeURIComponent(q)}&key=${encodeURIComponent(state.tenorApiKey)}&limit=20&offset=${_gifSearchOffset}`);
    const data = await res.json();
    if (data.error) { showToast('Giphy: ' + data.error, 'error'); return; }
    const results = data.data || [];
    const hasMore = results.length >= 20;
    _gifSearchOffset += results.length;
    document.getElementById('stickerLoadMore').style.display = hasMore ? 'block' : 'none';
    if (!results.length && !loadMore) {
      grid.innerHTML = `<div class="sticker-no-key" style="grid-column:1/-1">没找到相关 GIF</div>`;
      grid.dataset.hasResults = '';
      return;
    }
    const html = results.map(r => {
      const gif = r.images?.original?.url || r.images?.downsized?.url || '';
      const preview = r.images?.fixed_height_small?.url || r.images?.preview_gif?.url || gif;
      if (!gif) return '';
      const id = r.id || '';
      return `<div class="sticker-item" onclick="sendTenorGif('${escHtml(gif)}')" title="${escHtml(r.title || '')}">
        <img src="${escHtml(preview)}" alt="GIF" loading="lazy" onerror="_stickerImgRetry(this)">
        <button class="sticker-save-btn" onclick="event.stopPropagation();saveTenorGif('${escHtml(gif)}','${escHtml(id)}')" title="收藏到本地">★</button>
      </div>`;
    }).join('');
    if (loadMore) {
      grid.insertAdjacentHTML('beforeend', html);
    } else {
      grid.innerHTML = html;
    }
    grid.dataset.hasResults = '1';
  } catch(e) {
    console.error('[Giphy]', e);
    showToast('GIF 搜索失败: ' + e.message, 'error');
  }
}

function sendTenorGif(gifUrl) {
  const kw = _lastGifQuery.replace(/[\[\]|]/g, ' ').trim();
  insertStickerTag(kw ? `[[GIF:${gifUrl}|${kw}]]` : `[[GIF:${gifUrl}]]`);
}

function sendLocalSticker(name) {
  insertStickerTag(`[[STICKER:${name}]]`);
}

function insertStickerTag(tag) {
  closeStickerPanel();
  const input = document.getElementById('userInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const needSpaceBefore = before.length && !before.endsWith(' ') && !before.endsWith('\n');
  const needSpaceAfter = after.length && !after.startsWith(' ') && !after.startsWith('\n');
  input.value = before + (needSpaceBefore ? ' ' : '') + tag + (needSpaceAfter ? ' ' : '') + after;
  const cursor = before.length + (needSpaceBefore ? 1 : 0) + tag.length + (needSpaceAfter ? 1 : 0);
  input.selectionStart = input.selectionEnd = cursor;
  input.focus();
  autoResize(input);
}

async function saveTenorGif(gifUrl, id) {
  const name = `tenor_${id || Date.now()}.gif`;
  // 已登录 → 抓图存云端（全设备同步）。直连被 CORS/墙挡住就走服务器代理，
  // 别因为抓不到图就悄悄降级成"只存本地"（那样手机上永远看不到这批收藏）。
  if (currentUser) {
    try {
      let blob = null;
      try {
        const resp = await fetch(gifUrl);
        if (resp.ok) { const b = await resp.blob(); if (b && b.size) blob = b; }
      } catch(e) { /* CORS/网络失败，落到代理 */ }
      if (!blob) {
        const resp = await fetch(SERVER_BASE + '/api/proxy-image?url=' + encodeURIComponent(gifUrl));
        if (!resp.ok) throw new Error('代理抓图失败 HTTP ' + resp.status);
        blob = await resp.blob();
      }
      const r = await uploadStickerBlob(name, blob);
      if (r.ok) {
        // degraded = 落到本地了、云端没存上。文案说了警告、颜色还是绿的话等于没警告
        showToast('★ 已收藏到' + r.where, r.degraded ? 'warning' : 'success', r.degraded ? 4000 : 2200);
        await loadStickers();
        return;
      }
    } catch(e) { console.warn('[表情包] 直接抓图失败，改走本地服务器:', e.message); }
  }
  // 未登录或云端失败 → 让 server.js 代下载到 stickers/ 文件夹
  try {
    const res = await fetch(SERVER_BASE + '/api/sticker-save-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: gifUrl, name })
    });
    if (res.ok) {
      // 登录着还走到这一步，说明云端那条路断了——别报成一句干净的「已收藏」
      showToast(currentUser ? '★ 已收藏到本地（云端没存上，其它设备看不到）' : '★ 已收藏到本地',
                currentUser ? 'warning' : 'success', currentUser ? 4000 : 2200);
      await loadStickers();
    } else {
      showToast('收藏失败', 'error');
    }
  } catch(e) {
    showToast('收藏失败: ' + e.message, 'error');
  }
}

// 抓图 blob：先试浏览器直连（同源/允许 CORS 的图床），失败就走服务器代理下载——
// 外站图片浏览器直接 fetch 常被 CORS 挡住（手机端尤甚），代理绕过跨域。
async function fetchImgBlobSmart(imgUrl) {
  try {
    const resp = await fetch(imgUrl);
    if (resp.ok) { const b = await resp.blob(); if (b && b.size) return b; }
  } catch(e) { /* CORS/网络失败，落到代理 */ }
  const resp = await fetch(SERVER_BASE + '/api/proxy-image?url=' + encodeURIComponent(imgUrl));
  if (!resp.ok) throw new Error('代理抓图失败 HTTP ' + resp.status);
  return await resp.blob();
}

// 保存 AI 搜索到的图片
async function saveSearchImg(imgUrl, keyword) {
  const name = `img_${keyword.replace(/[^a-zA-Z0-9一-龥]/g, '_')}_${Date.now()}.jpg`;
  const fetchImgBlob = () => fetchImgBlobSmart(imgUrl);
  // 已登录 → 抓图存云端表情库（全设备同步）
  if (currentUser) {
    try {
      const blob = await fetchImgBlob();
      const r = await uploadStickerBlob(name, blob);
      if (r.ok) {
        showToast('💾 图片已存进表情库（' + r.where + '）', r.degraded ? 'warning' : 'success', r.degraded ? 4000 : 3000);
        await loadStickers();
        return;
      }
    } catch(e) { console.warn('[图片保存] 云端保存失败，改走本地服务器:', e.message); }
  }
  // 未登录或云端失败 → 让 server.js 代下载到电脑上的保存目录（GRANCYAN_SAVE_DIR，默认 ~/Pictures/GranCyan）
  try {
    console.log('[图片保存] 使用本地服务器保存');
    const res = await fetch(SERVER_BASE + '/api/sticker-save-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imgUrl, name })
    });
    const result = await res.json();
    if (res.ok && result.ok) {
      const displayPath = result.path || name;
      showToast(`💾 图片已保存\n${displayPath}`, 'success', 5000);
      await loadStickers();
      console.log('[图片保存] 本地保存成功:', displayPath);
    } else {
      const errorText = result.error || '未知错误';
      console.error('[图片保存] 保存失败:', errorText);
      showToast('图片保存失败: ' + errorText, 'error', 3000);
    }
  } catch(e) {
    console.error('[图片保存] 错误:', e);
    showToast('图片保存失败: ' + e.message, 'error', 3000);
  }
}

async function handleStickerUpload(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  for (const file of files) {
    try {
      const r = await uploadStickerBlob(file.name, file);
      if (r.ok) {
        showToast(`✨ 表情已添加到${r.where}: ` + file.name, r.degraded ? 'warning' : 'success', r.degraded ? 4000 : 2200);
      } else {
        showToast('表情上传失败: ' + r.error, 'error');
      }
    } catch(e) {
      showToast('表情上传失败: ' + e.message, 'error');
    }
  }
  input.value = '';
  await loadStickers();
  if (_stickerTab !== 'search') renderLocalStickers();
}

// 表情图加载失败时指数退避重试（网络抖动/电脑服务器临时不可达时，img 默认失败一次就永远碎图）
function _stickerImgRetry(img) {
  const n = (+img.dataset.retry || 0) + 1;
  if (n > 5) return;
  img.dataset.retry = n;
  if (!img.dataset.src0) img.dataset.src0 = img.getAttribute('src');
  setTimeout(() => {
    const base = img.dataset.src0;
    img.src = base + (base.includes('?') ? '&' : '?') + '_r=' + Date.now();
  }, Math.min(2000 * n, 15000));
}
// 网络恢复 / 回到前台时，重扫所有碎掉的表情图再给一轮重试机会
function _rescanBrokenStickers() {
  document.querySelectorAll('img.sticker-msg, .sticker-item img').forEach(img => {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
      img.dataset.retry = 0;
      _stickerImgRetry(img);
    }
  });
}
window.addEventListener('online', _rescanBrokenStickers);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _rescanBrokenStickers();
});

// 表情图（含 AI 发的）右上角挂一个 ★ 收藏按钮：把这张外链表情抓进表情库，
// 之后能在表情面板里直接发。名字按 url 哈希固定，同一张 GIF 收藏几次都只存一份。
function _gifImgHtml(url, kw) {
  // onclick 里的字符串参数要过 escHtml——url 里的引号/& 不转义会把属性截断
  const urlForJs = escHtml(JSON.stringify(url));
  const kwForJs = escHtml(JSON.stringify(kw || ''));
  const faved = isGifFaved(url) ? ' faved' : '';
  return `<span class="sticker-msg-wrap">` +
    `<img class="sticker-msg" src="${escHtml(url)}" alt="${escHtml(kw || 'GIF')}" title="GIF: ${escHtml(kw || '表情')}" onerror="_stickerImgRetry(this)">` +
    `<button class="sticker-fav-btn${faved}" onclick="event.stopPropagation();favGifSticker(${urlForJs},${kwForJs},this)" title="${faved ? '已在表情库里' : '收藏到表情库'}">${faved ? '✓' : '★'}</button>` +
    `</span>`;
}

// 收藏名：fav_关键词_url哈希.扩展名——哈希保证同一张图只存一份，关键词让 AI/自己认得出
function _gifFavName(url, kw) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  const tag = (kw || '').replace(/[^a-zA-Z0-9一-龥]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
  return `fav_${tag ? tag + '_' : ''}${h.toString(36)}`;
}

function isGifFaved(url) {
  const base = _gifFavName(url, '');
  const hash = base.slice(4);   // 去掉 fav_ 前缀，只比哈希段（关键词可能不同）
  return _stickerList.some(s => s.name.endsWith('_' + hash) || s.name === 'fav_' + hash);
}

// 把一颗收藏按钮切成「已收藏」态。灯箱那颗是带文字的长按钮，气泡里那些是小圆 ★
function _markFavBtn(b) {
  if (!b) return;
  b.textContent = b.id === 'lightboxFavBtn' ? '✓ 已在表情库' : '✓';
  b.disabled = false;
  b.classList.add('faved');
  b.title = '已在表情库里';
}

// 从一个 <img> 元素直接收藏（灯箱按钮、手机长按都走这里）：
// 关键词优先用 title（"GIF: 开心猫猫" 要先剥掉前缀），退回 alt
function favImgFromEl(img, btn) {
  if (!img || !img.src) return;
  const kw = (img.getAttribute('title') || img.getAttribute('alt') || '')
    .replace(/^GIF:\s*/, '').trim();
  return favGifSticker(img.src, kw === 'GIF' || kw === '表情' ? '' : kw, btn);
}

async function favGifSticker(url, kw, btn) {
  if (isGifFaved(url)) { showToast('这个表情已经在表情库里了', 'info'); return; }
  const base = _gifFavName(url, kw);
  const isBig = btn && btn.id === 'lightboxFavBtn';   // 灯箱那颗带文字，别被切成光秃秃一个字符
  if (btn) { btn.textContent = isBig ? '⏳ 收藏中…' : '⏳'; btn.disabled = true; }
  try {
    const blob = await fetchImgBlobSmart(url);
    // 扩展名优先信 blob 的 MIME（Giphy 的 url 常带一堆 query，光看后缀会猜错）
    const mime = (blob.type || '').toLowerCase();
    const byUrl = (/\.(gif|webp|png|jpe?g)(?:\?|#|$)/i.exec(url)?.[1] || '').toLowerCase();
    const ext = mime.includes('gif') ? '.gif'
      : mime.includes('webp') ? '.webp'
      : mime.includes('png') ? '.png'
      : /jpe?g/.test(mime) ? '.jpg'
      : byUrl ? '.' + byUrl.replace('jpeg', 'jpg')
      : '.gif';
    const r = await uploadStickerBlob(base + ext, blob);
    if (!r.ok) throw new Error(r.error);
    // 关键词顺手记成给 AI 看的备注，这样它以后知道这张表情是什么意思
    if (kw && kw.trim()) {
      state.stickerNotes = state.stickerNotes || {};
      if (!state.stickerNotes[base]) { state.stickerNotes[base] = kw.trim(); save(); }
    }
    await loadStickers();
    if (typeof _stickerTab !== 'undefined' && _stickerTab !== 'search') renderLocalStickers();
    showToast('★ 已收藏到表情库（' + r.where + '）', r.degraded ? 'warning' : 'success', r.degraded ? 4000 : 2200);
    // 同一张图可能在历史里出现多次，全部标上已收藏（灯箱那颗按钮不带 url，单独标）
    if (btn) _markFavBtn(btn);
    document.querySelectorAll('.sticker-msg-wrap .sticker-fav-btn').forEach(b => {
      if (b.getAttribute('onclick')?.includes(JSON.stringify(url))) _markFavBtn(b);
    });
  } catch(e) {
    if (btn) { btn.textContent = isBig ? '★ 收藏到表情库' : '★'; btn.disabled = false; }
    showToast('收藏失败: ' + e.message, 'error');
  }
}

function _markRgb(value) {
  const raw = String(value || '').trim();
  let m = raw.match(/^#([0-9a-f]{3})$/i);
  if (m) return Array.from(m[1], ch => parseInt(ch + ch, 16));
  m = raw.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  return null;
}
function _markLum(rgb) {
  const linear = rgb.map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function _markContrast(a, b) {
  const hi = Math.max(_markLum(a), _markLum(b));
  const lo = Math.min(_markLum(a), _markLum(b));
  return (hi + 0.05) / (lo + 0.05);
}
function _markHex(rgb) {
  return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}
function _markDisplayColor(raw) {
  const rgb = _markRgb(raw);
  if (!rgb) return 'var(--accent)';
  let bgRaw = '#141210';
  try {
    const cssBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim();
    if (cssBg) bgRaw = cssBg;
  } catch (e) { /* 非浏览器测试或主题尚未就绪时用真实默认底色 */ }
  const bg = _markRgb(bgRaw) || _markRgb('#141210');
  if (_markContrast(rgb, bg) >= 3) return raw;
  // 选和背景更远的端点：暗底往白推，亮底往黑推；0.179 是黑白对比度相等点。
  const target = _markLum(bg) > 0.179 ? 0 : 255;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mix = (lo + hi) / 2;
    const candidate = rgb.map(v => v + (target - v) * mix);
    if (_markContrast(candidate, bg) >= 3) hi = mix;
    else lo = mix;
  }
  let shown = rgb.map(v => Math.round(v + (target - v) * hi));
  const step = target === 255 ? 1 : -1;
  while (_markContrast(shown, bg) < 3 && shown.some(v => v !== target)) {
    shown = shown.map(v => Math.max(0, Math.min(255, v + step)));
  }
  return _markHex(shown);
}
function _markNumber(raw) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(raw || '').trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function _markClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function _markBlur(raw) {
  const value = String(raw || '').trim();
  const directional = value.match(/^([hv])(.+)$/i);
  if (directional) {
    const amount = _markNumber(directional[2]);
    if (amount == null || amount <= 0) return null;
    const quantized = Math.round(_markClamp(amount, 0.5, 4) * 2) / 2;
    const id = `mkb-${directional[1].toLowerCase()}-${String(Math.round(quantized * 10)).padStart(2, '0')}`;
    return { css: `url(#${id})`, id };
  }
  const amount = _markNumber(value);
  if (amount == null) return null;
  const clamped = _markClamp(amount, 0, 2.5);
  return { css: clamped === 0 ? '' : `blur(${clamped}px)`, id: null };
}
// 渐变：g=#ff8ab0-#88ccff，带角度写 g=90:#ff8ab0-#88ccff，2~3 个色标。
// 分隔符 `-` 和 `>` 都收 —— 模型两种都会写，而颜色本身是 #rrggbb 不含这两个字符，
// 所以拿它们当分隔符不会切坏色值。
// ⚠️ 色标同样过 _markDisplayColor：渐变照样可能整条融进背景，对比度保护不能因为
//   换了个属性就失效（深色底上一条 #222→#333 的渐变，等于一行看不见的字）。
function _markGradient(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  let angle = 90;                       // 默认从左到右
  let body = value;
  const withAngle = value.match(/^([+-]?\d+(?:\.\d*)?):(.+)$/);
  if (withAngle) {
    const a = _markNumber(withAngle[1]);
    if (a == null) return null;
    angle = ((a % 360) + 360) % 360;    // -45 和 315 是同一个方向，先归一化免得 CSS 里出现负号
    body = withAngle[2];
  }
  const stops = body.split(/[->]/).map(s => s.trim()).filter(Boolean);
  if (stops.length < 2 || stops.length > 3) return null;
  if (!stops.every(s => _markRgb(s))) return null;
  const shown = stops.map(s => _markDisplayColor(s));
  return { css: `linear-gradient(${angle}deg, ${shown.join(', ')})`, first: shown[0] };
}

// 描边：k=#000，带粗细写 k=1.5:#000（px，0.2~3）。
// ⚠️ 描边色**不过** _markDisplayColor。那个保护管的是「字会不会融进背景」，
//   而描边的职责恰恰是跟**字身**拉开对比 —— 亮渐变配纯黑边是常见写法，
//   拿背景对比度去推它，会把黑边推成白边，等于把这个功能废掉。
function _markStroke(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  let width = 0.6, color = value;
  const withWidth = value.match(/^(\d+(?:\.\d*)?|\.\d+):(.+)$/);
  if (withWidth) {
    const w = _markNumber(withWidth[1]);
    if (w == null) return null;
    width = _markClamp(w, 0.2, 3);
    color = withWidth[2];
  }
  color = color.trim();
  if (!_markRgb(color)) return null;
  return { width, color };
}

// 图层混合模式（m=）。CSS 的 mix-blend-mode 全套都在，外加 PS 的中文名当别名 ——
// 用户和模型都更可能写「滤色」「差值」而不是 screen / difference。
//
// ⚠️ 必须是白名单。这个值会原样进 inline style，放任意字符串等于开了一条注入缝
// （'red;position:fixed;inset:0' 之类）。所以这里返回的永远是表里那个常量，
// 不是用户给的那个字符串。
const _MARK_BLENDS = {
  'normal': 'normal', 'multiply': 'multiply', 'screen': 'screen', 'overlay': 'overlay',
  'darken': 'darken', 'lighten': 'lighten', 'color-dodge': 'color-dodge', 'color-burn': 'color-burn',
  'hard-light': 'hard-light', 'soft-light': 'soft-light', 'difference': 'difference',
  'exclusion': 'exclusion', 'hue': 'hue', 'saturation': 'saturation', 'color': 'color',
  'luminosity': 'luminosity', 'plus-lighter': 'plus-lighter',
  // 常见简写
  'dodge': 'color-dodge', 'burn': 'color-burn', 'diff': 'difference', 'plus': 'plus-lighter',
  // PS 的中文名
  '正常': 'normal', '正片叠底': 'multiply', '滤色': 'screen', '叠加': 'overlay',
  '变暗': 'darken', '变亮': 'lighten', '颜色减淡': 'color-dodge', '颜色加深': 'color-burn',
  '强光': 'hard-light', '柔光': 'soft-light', '差值': 'difference', '排除': 'exclusion',
  '色相': 'hue', '饱和度': 'saturation', '颜色': 'color', '明度': 'luminosity', '增亮': 'plus-lighter',
};
/* ── 动起来的三个参数：f= 闪烁 / v= 位移 / w= 形变 ────────────────────
   分三个参数而不是一个，是因为它们各自占一条 CSS 属性通道（opacity / translate /
   rotate·scale），互不打架，可以任意叠。挤进一个参数里的话，"闪着往左飘"这种
   组合就表达不出来了。
   周期统一是最后一段，省略时各有各的默认（抖动本来就该比漂浮快）。 */

// f=2 或 f=2:0.2 —— 频率 Hz（一秒闪几次）+ 可选的最暗透明度
function _markFlash(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  const parts = value.split(':');
  const hz = _markNumber(parts[0]);
  if (hz == null || hz <= 0) return null;
  // 上限 8Hz：再快就只是一团糊的闪，而且对光敏感的人不友好
  const clampedHz = _markClamp(hz, 0.2, 8);
  let low = parts.length > 1 ? _markNumber(parts[1]) : null;
  low = low == null ? 0.15 : _markClamp(low, 0, 0.9);
  return { dur: +(1 / clampedHz).toFixed(3), low: +low.toFixed(3), hz: clampedHz };
}

/* 位移的幅度钳制表。提到模块级是因为**花字面板也要读它** —— 面板滑杆能拖到 20，
   而抖动实际只到 12，各存一份的话面板旁边写着 20px、渲染出来是 12px，
   而且两边都「没报错」。钳制只允许有一份。 */
const _MARK_MOVE_PRESETS = {
  shake: { kw: 'markShake', dur: 0.4,  amp: 2, min: 0.5, max: 12 },
  float: { kw: 'markFloat', dur: 3.2,  amp: 5, min: 1,   max: 24 },
  orbit: { kw: 'markOrbit', dur: 2.6,  amp: 4, min: 1,   max: 20 },
};
// 定向往复没有预设轨迹，幅度范围单列
const _MARK_DIR_AMP = { amp: 6, min: 0.5, max: 24 };

/* v=角度:幅度[:周期] 定向往复，或 v=shake|float|orbit:幅度[:周期] 三种预设。
   角度沿用 g= 那套约定：**0 是向上，90 是向右**，顺时针。两处约定不一致的话
   模型会拿渐变的角度感觉去写位移，方向就全错了，而且错得看不出是约定问题。 */
function _markMove(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  const parts = value.split(':');
  const head = parts[0].trim().toLowerCase();
  const PRESETS = _MARK_MOVE_PRESETS;
  if (Object.prototype.hasOwnProperty.call(PRESETS, head)) {
    const p = PRESETS[head];
    const a = parts.length > 1 ? _markNumber(parts[1]) : null;
    const amp = a == null ? p.amp : _markClamp(a, p.min, p.max);
    const d = parts.length > 2 ? _markNumber(parts[2]) : null;
    const dur = d == null ? p.dur : _markClamp(d, 0.2, 8);
    return { kw: p.kw, dur, vars: { '--mk-amp': amp + 'px' } };
  }
  // 定向：角度 + 幅度
  const deg = _markNumber(parts[0]);
  const amtRaw = parts.length > 1 ? _markNumber(parts[1]) : null;
  if (deg == null || amtRaw == null) return null;
  const amp = _markClamp(amtRaw, _MARK_DIR_AMP.min, _MARK_DIR_AMP.max);
  if (amp <= 0) return null;
  const d = parts.length > 2 ? _markNumber(parts[2]) : null;
  const dur = d == null ? 1.6 : _markClamp(d, 0.2, 8);
  // 0°=上、90°=右，屏幕 y 轴朝下所以 dy 取负
  const rad = ((deg % 360) + 360) % 360 * Math.PI / 180;
  const dx = +(Math.sin(rad) * amp).toFixed(2);
  const dy = +(-Math.cos(rad) * amp).toFixed(2);
  return { kw: 'markDrift', dur, vars: { '--mk-dx': dx + 'px', '--mk-dy': dy + 'px' } };
}

// w=swing:4[:周期] 摇摆度数 / w=pulse:1.15[:周期] 呼吸倍数
function _markWobble(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  const parts = value.split(':');
  const head = parts[0].trim().toLowerCase();
  const n = parts.length > 1 ? _markNumber(parts[1]) : null;
  const d = parts.length > 2 ? _markNumber(parts[2]) : null;
  if (head === 'swing') {
    // 上限 20°：汉字歪过头就开始难认了
    const deg = n == null ? 4 : _markClamp(n, 0.5, 20);
    return { kw: 'markSwing', dur: d == null ? 1.8 : _markClamp(d, 0.2, 8), vars: { '--mk-deg': deg + 'deg' } };
  }
  if (head === 'pulse') {
    const sc = n == null ? 1.12 : _markClamp(n, 1.02, 1.6);
    return { kw: 'markPulse', dur: d == null ? 2 : _markClamp(d, 0.2, 8), vars: { '--mk-scale': sc } };
  }
  return null;
}

function _markBlend(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return null;
  // 下划线/空格/驼峰写法都收下（colorDodge、color_dodge、"soft light"）
  const k = v.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
  return Object.prototype.hasOwnProperty.call(_MARK_BLENDS, k) ? _MARK_BLENDS[k]
    : (Object.prototype.hasOwnProperty.call(_MARK_BLENDS, v) ? _MARK_BLENDS[v] : null);
}

function _markToHtml(word, paramText) {
  const raw = {};
  // ⚠️ 加新参数记得扩这个字符类。漏了的话标签里写了、解析时被直接丢掉，
  //    渲染出来是一个没有该效果的普通花字 —— 零报错，最难查的那种。
  String(paramText || '').replace(/(?:^|\s)([csobgkmfvw])\s*=\s*([^\s]+)/gi, (_, key, value) => {
    raw[key.toLowerCase()] = value;
    return _;
  });
  const validColor = _markRgb(raw.c) ? raw.c : null;
  const validSize = _markNumber(raw.s);
  const validOpacity = _markNumber(raw.o);
  const validBlur = _markBlur(raw.b);
  const validGradient = _markGradient(raw.g);
  const validStroke = _markStroke(raw.k);
  const validBlend = _markBlend(raw.m);
  const validFlash = _markFlash(raw.f);
  const validMove = _markMove(raw.v);
  const validWobble = _markWobble(raw.w);
  const size = validSize == null ? 1 : _markClamp(validSize, 0.6, 2);
  const opacity = validOpacity == null ? 1 : _markClamp(validOpacity, 0.3, 1);
  let attrs = '';
  if (validColor) attrs += ` data-mark-c="${escHtml(raw.c)}"`;
  if (validSize != null) attrs += ` data-mark-s="${escHtml(raw.s)}"`;
  if (validOpacity != null) attrs += ` data-mark-o="${escHtml(raw.o)}"`;
  if (validBlur) attrs += ` data-mark-b="${escHtml(raw.b)}"`;
  if (validGradient) attrs += ` data-mark-g="${escHtml(raw.g)}"`;
  if (validStroke) attrs += ` data-mark-k="${escHtml(raw.k)}"`;
  if (validBlend) attrs += ` data-mark-m="${escHtml(raw.m)}"`;
  if (validFlash) attrs += ` data-mark-f="${escHtml(raw.f)}"`;
  if (validMove) attrs += ` data-mark-v="${escHtml(raw.v)}"`;
  if (validWobble) attrs += ` data-mark-w="${escHtml(raw.w)}"`;
  const filter = validBlur && validBlur.css ? `;filter:${validBlur.css}` : '';
  // ⚠️ 渐变字的实现是「把渐变当背景，再按字形裁剪」，所以字身**必须**透明 ——
  //   于是 g 和 c 同时给时 c 是物理上无效的，不是被我们挑掉的。提示词里要说清楚。
  //   打底那句 `color:第一个色标` 是**降级用的**，不是装饰：万一引擎不认
  //   background-clip:text，字身透明那两句多半也不认，于是回落成一个纯色 ——
  //   总好过渲染出一行看不见的字（这类静默失效在这台机器上已经吃过几次了）。
  let style = validGradient
    ? `color:${validGradient.first};background-image:${validGradient.css}`
      + ';-webkit-background-clip:text;background-clip:text'
      + ';-webkit-text-fill-color:transparent'
    : `color:${validColor ? _markDisplayColor(validColor) : 'var(--accent)'}`;
  /* opacity 走 --mk-o 变量而不是直接写死：闪烁那条 keyframes 动的就是 opacity，
     写死的话「半透明 + 闪烁」里的半透明会被动画整个盖掉（静默失效）。
     变量在手，markFlash 就能把 o= 当成亮点、按比例压到暗点。 */
  style += `;font-size:${size}em;--mk-o:${opacity};opacity:var(--mk-o)${filter}`;
  // paint-order:stroke fill —— 让描边先画、字身后画。不加的话描边是「骑在」字形边缘上
  // 往里吃一半，汉字笔画细，稍粗一点就把字心糊死。
  if (validStroke) {
    style += `;-webkit-text-stroke:${validStroke.width}px ${validStroke.color}`
           + ';paint-order:stroke fill';
  }
  // 混合模式。**混合对象是气泡背景**，靠 CSS 里那条
  // `.bubble:has(.mark-text[data-mark-m]){isolation:isolate}` 把混合圈在气泡内 ——
  // 不圈的话它会一路混到页面背景（深色底上 difference 之类几乎看不出变化）。
  // :has() 认不出来的引擎上仍然会混，只是混的层更外面，不会静默变成什么都没有。
  if (validBlend) style += `;mix-blend-mode:${validBlend}`;
  /* 三条动画合成一条 animation 简写（逗号分隔并行）。它们动的是三个**不同的**
     CSS 属性（opacity / translate / rotate·scale），所以并行不打架 ——
     这也是 v 和 w 分成两个参数的原因：挤在一个 transform 里只会剩最后一条生效。
     闪烁用 steps 之外的默认缓动（ease-in-out）看着最像呼吸；位移/形变同理。 */
  const anims = [];
  const vars = [];
  if (validFlash) {
    anims.push(`markFlash ${validFlash.dur}s ease-in-out infinite`);
    vars.push(`--mk-f-lo:${validFlash.low}`);
  }
  if (validMove) {
    anims.push(`${validMove.kw} ${validMove.dur}s ease-in-out infinite`);
    for (const k in validMove.vars) vars.push(`${k}:${validMove.vars[k]}`);
  }
  if (validWobble) {
    anims.push(`${validWobble.kw} ${validWobble.dur}s ease-in-out infinite`);
    for (const k in validWobble.vars) vars.push(`${k}:${validWobble.vars[k]}`);
  }
  if (vars.length) style += ';' + vars.join(';');
  if (anims.length) style += `;animation:${anims.join(',')}`;
  return `<span class="mark-text"${attrs} style="${style}">${escHtml(String(word).trim())}</span>`;
}

function stickerTagToHtml(text) {
  // 兜底：历史里已存下的中文形态（以及绕过 processAiCommands 的路径）也能正常出图
  text = normalizeStickerTags(text);
  // [[GIF:url]] 或 [[GIF:url|关键词]]（关键词用于 alt/title 和发给 AI 的可读描述）
  // 用户消息路径先过了 escHtml，url 里的 & 已成 &amp;，先还原避免 _gifImgHtml 二次转义
  text = text.replace(/\[\[GIF:\s*(https?:\/\/[^\]|]+?)\s*(?:\|\s*([^\]]+?))?\s*\]\]/g, (match, url, kw) => {
    return _gifImgHtml(url.replace(/&amp;/g, '&'), kw);
  });
  text = text.replace(/\[\[STICKER:\s*([^\]]+?)\s*\]\]/g, (match, name) => {
    const s = findSticker(name);
    if (s) return `<img class="sticker-msg" src="${escHtml(s.url)}" alt="${escHtml(s.desc)}" title="${escHtml(s.desc)}" onerror="_stickerImgRetry(this)">`;
    return match;
  });
  // 旧版本把占位符 <div> 永久存进了消息里（关键词已丢失，无法恢复），渲染成中性占位。
  // 必须放在下面生成新占位符之前，否则会把刚生成的占位符也误杀。
  text = text.replace(/<div id="gifsearch_[^"]*"[^>]*>[\s\S]*?<\/div>/g,
    '<span style="color:var(--text-muted);font-size:12px;">[表情包]</span>');
  // AI 的 [[GIF_SEARCH:关键词]]：渲染时才解析。成功后写回存储为 [[GIF:url|关键词]]，
  // 失败则标签留在存储里，下次渲染自动重试（不会像旧版那样永久卡在"搜索中"）。
  text = text.replace(/\[\[GIF_SEARCH:\s*([^\]]+?)\s*\]\]/g, (match, keyword) => {
    const kw = keyword.trim();
    if (_gifSearchCache[kw]) return _gifImgHtml(_gifSearchCache[kw], kw);
    const uid = 'gifsearch_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    setTimeout(() => resolveGifSearch(uid, kw), 30);
    // 占位是 <div>，前后留空行：否则 marked 会把它后面的正文一起当 HTML 吞掉
    return `\n\n<div id="${uid}" class="sticker-msg" style="height:120px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">🔍 搜索表情中…</div>\n\n`;
  });
  // AI 发来的真实图片（非 GIF）：[[IMG:url]] 或 [[IMG:url|关键词]]（固化后的形态）
  text = text.replace(/\[\[IMG:\s*(https?:\/\/[^\]|]+?)\s*(?:\|\s*([^\]]+?))?\s*\]\]/g, (match, url, kw) => {
    return _imgSearchHtml(url.replace(/&amp;/g, '&'), kw);
  });
  // AI 的 [[IMG_SEARCH:关键词]]：渲染时才解析（Tavily 图搜），成功后写回 [[IMG:url|关键词]]
  text = text.replace(/\[\[IMG_SEARCH:\s*([^\]]+?)\s*\]\]/g, (match, keyword) => {
    const kw = keyword.trim();
    if (_imgSearchCache[kw]) return _imgSearchHtml(_imgSearchCache[kw], kw);
    const uid = 'imgsearch_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    setTimeout(() => resolveImgSearch(uid, kw), 30);
    return `\n\n<div id="${uid}" class="msg-img" style="height:150px;width:200px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;background:var(--bg-elevated);border-radius:10px;">🖼 搜索图片中…</div>\n\n`;
  });
  // 崩坏关键词：[[GLITCH:词]] 或 [[GLITCH:词|big/small/flicker/broken]]
  // 不指定样式时按词哈希固定选一种，重渲染不会变来变去
  text = text.replace(/\[\[GLITCH:\s*([^\]|]+?)\s*(?:\|\s*(big|small|flicker|broken)\s*)?\]\]/g, (_, w, style) => {
    const map = { big:'g1', small:'g2', flicker:'g3', broken:'g4' };
    const cls = map[style] || 'g' + ((Array.from(w).reduce((a,ch)=>a+ch.codePointAt(0),0) % 4) + 1);
    const styleAttr = style ? ` data-glitch-style="${style}"` : '';
    return `<span class="glitch-word ${cls}" data-glitch-w="${escHtml(w)}"${styleAttr}>${w}</span>`;
  });
  // 自由文字标注：参数只从白名单解析，原值留在 data 属性供历史回填，style 只用钳制后的值。
  text = text.replace(/\[\[MARK:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/g,
    (_, word, params) => _markToHtml(word, params));
  // AI 引用消息：[[QUOTE: 原话片段]] —— 渲染成和用户 Reply 一样的引用条，点击可定位原文
  text = text.replace(/\[\[QUOTE:\s*([^\]]+?)\s*\]\]/g, (_, q) => {
    const t = q.trim();
    const disp = t.length > 80 ? t.slice(0,80) + '…' : t;
    const attr = escHtml(t).replace(/"/g, '&quot;');
    return `\n\n<div class="bubble-quote" style="cursor:pointer" data-q="${attr}" onclick="scrollToQuotedText(this.dataset.q)" title="点击定位原文">↩ ${escHtml(disp)}</div>\n\n`;
  });
  // 学习卡片 [[CARDQ:卡id|提问id]] → 按卡片**当前**状态重画。
  // 挂在这里是因为 content 和 blocks 两条渲染路径都会经过 stickerTagToHtml，
  // 不用再单独写一份 _applyXxxToBlocks。
  if (typeof studyTagToHtml === 'function') text = studyTagToHtml(text);
  // 点歌 [[SONG:…]] / [[MUSIC:…]] → 播放卡片。挂这儿的理由同上（两条渲染路径都经过）
  if (typeof musicTagToHtmlAll === 'function') text = musicTagToHtmlAll(text);
  // 塔罗 10-09 拆了：老消息里残留的 [[TAROT…]] 标签不画出来
  if (typeof text === 'string' && text.indexOf('[[TAROT') >= 0) text = text.replace(/\[\[TAROT[^\]]*\]\]/g, '');
  if (typeof lifeTagToHtml === 'function') text = lifeTagToHtml(text);
  // 画图 [[PLOT:]]：这里只出一个占位盒子，真正画要等进了 DOM（见 typesetMath → plotMountIn）
  if (typeof plotTagToHtml === 'function') text = plotTagToHtml(text);
  // 元素卡 [[ELEM:]] / 分子卡 [[MOL:]]（55-chem.js），同样两条渲染路径都经过这里
  if (typeof chemTagToHtml === 'function') text = chemTagToHtml(text);
  // 实验卡 [[SIM:]]（56-sims.js）
  if (typeof simTagToHtml === 'function') text = simTagToHtml(text);
  // 公式卡 [[FCARD:]]（58-formulas.js）
  if (typeof fcardTagToHtml === 'function') text = fcardTagToHtml(text);
  // 跑腿卡 [[ERRAND:]]（61-errand.js）：按那件活**当前**的状态画（在跑 / 办完 / 没办成）
  if (typeof errandTagToHtml === 'function') text = errandTagToHtml(text);
  // 施工单卡 [[BUILDJOB:]]（64-build.js）：按单子当前状态画（等你批 / 施工中 / 完工 / 没成）
  if (typeof buildTagToHtml === 'function') text = buildTagToHtml(text);
  // 相册 [[KEPT:]] / [[PHOTOREF:]]（62-album.js）：按 hash 去对话里找原图
  if (typeof albumTagToHtml === 'function') text = albumTagToHtml(text);
  // 藏宝地图 [[TREASURE_HID:]] / [[TREASURE_MISS:]]（68-treasure.js）：纸条卡片，**不画正文**；
  // 漏到这里的裸 [[HIDE_LETTER…]] 也只画占位
  if (typeof treasureTagToHtml === 'function') text = treasureTagToHtml(text);
  // 小本子 [[WISH_KEPT:]] / [[WISH_SHOWN:]]（71-wishbook.js）：记了只画一枚小印章，翻开的才画内容
  if (typeof wishTagToHtml === 'function') text = wishTagToHtml(text);
  return text;
}

// AI 引用条点击：在当前对话里找到第一条包含该文字的消息并滚动过去
function scrollToQuotedText(txt) {
  if (!txt) return;
  const chat = getActiveChat();
  if (!chat) return;
  const needle = txt.replace(/…$/, '').trim();
  const nodes = Object.values(chat.nodes || {});
  const hit = nodes.find(n => (n.content || '').includes(needle))
           || nodes.find(n => needle.length > 12 && (n.content || '').includes(needle.slice(0, 12)));
  if (hit) scrollToMessage(hit.id, needle);
  else showToast('找不到被引用的原文', 'info');
}

const _gifSearchCache = {};    // 关键词 -> 已解析的 GIF url（本次会话）
const _gifSearchPending = {};  // 关键词 -> 进行中的 Promise（去重并发请求）

// ── 真实图片搜索（Tavily），AI 用 [[IMG_SEARCH:关键词]] 触发 ──
const _imgSearchCache = {};
const _imgSearchPending = {};
function _imgSearchHtml(url, kw) {
  const safeUrl = escHtml(url);
  const safeKw = escHtml(kw || '图片');
  // onclick 属性里：JSON.stringify 出来的是双引号，**还得再转一层 HTML** —— 以前没转，
  // 属性在第一个 " 就收尾了，💾 按钮一直是哑的；而 url/kw 是 AI 写的，等于一个属性注入口。
  // 和上面 GIF 那份（favGifSticker）同一个写法。
  const urlForJs = escHtml(JSON.stringify(url));
  const kwForJs = escHtml(JSON.stringify(kw || '图片'));
  // 前后留空行：这是 <div>，紧邻的正文会被 marked 当 HTML 一起吞掉（**加粗** 会露星号）
  const html = `\n\n<div class="msg-img-wrap" style="position:relative;display:inline-block;">
    <img class="msg-img" src="${safeUrl}" alt="${safeKw}" title="${safeKw}" loading="lazy" onerror="_stickerImgRetry(this)">
    <button class="msg-img-save-btn" onclick="event.stopPropagation();saveSearchImg(${urlForJs},${kwForJs})" title="保存图片">💾</button>
  </div>\n\n`;
  return html;
}
async function resolveImgSearch(elementId, keyword) {
  const swap = html => { const el = document.getElementById(elementId); if (el) el.outerHTML = html; };
  if (!state.webSearchApiKey) {
    swap(`<span style="color:var(--text-muted);font-size:12px;">[图片: ${escHtml(keyword)}]（需在 设置→模型&API 填 Tavily Key）</span>`);
    return;
  }
  try {
    if (!_imgSearchPending[keyword]) {
      _imgSearchPending[keyword] = fetch(`${SERVER_BASE}/api/img-search?q=${encodeURIComponent(keyword)}&key=${encodeURIComponent(state.webSearchApiKey)}`)
        .then(res => res.json())
        .then(data => (data.images?.[0]?.url) || '')
        .finally(() => { delete _imgSearchPending[keyword]; });
    }
    const img = await _imgSearchPending[keyword];
    if (img) {
      _imgSearchCache[keyword] = img;
      const elGone = !document.getElementById(elementId);
      swap(_imgSearchHtml(img, keyword));
      _persistImgResult(keyword, img);
      if (elGone) renderMessages();
      return;
    }
    swap(`<span style="color:var(--text-muted);font-size:12px;">[未找到图片: ${escHtml(keyword)}]</span>`);
  } catch(e) {
    swap(`<span style="color:var(--text-muted);font-size:12px;">[图片: ${escHtml(keyword)}]（搜索失败，稍后自动重试）</span>`);
  }
}
// 把存储里的 [[IMG_SEARCH:kw]] 固化成 [[IMG:url|kw]]，避免每次渲染重复请求
function _persistImgResult(keyword, imgUrl) {
  const chat = getActiveChat();
  if (!chat) return;
  const re = new RegExp(`\\[\\[IMG_SEARCH:\\s*${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]`, 'g');
  const tag = `[[IMG:${imgUrl}|${keyword}]]`;
  let changed = false;
  const fix = s => { if (!s) return s; const r = s.replace(re, tag); if (r !== s) changed = true; return r; };
  for (const node of Object.values(chat.nodes)) {
    node.content = fix(node.content);
    if (node.blocks) node.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    if (node.variants) node.variants.forEach(v => {
      v.content = fix(v.content);
      if (v.blocks) v.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    });
  }
  if (changed) save();
}

async function resolveGifSearch(elementId, keyword) {
  const swap = html => { const el = document.getElementById(elementId); if (el) el.outerHTML = html; };
  if (!state.tenorApiKey) {
    swap(`<span style="color:var(--text-muted);font-size:12px;">[表情包: ${escHtml(keyword)}] (需配置 Giphy API Key)</span>`);
    return;
  }
  try {
    if (!_gifSearchPending[keyword]) {
      _gifSearchPending[keyword] = fetch(`${SERVER_BASE}/api/gif-search?q=${encodeURIComponent(keyword)}&key=${encodeURIComponent(state.tenorApiKey)}&limit=1`)
        .then(res => res.json())
        .then(data => {
          const r = data.data?.[0];
          return r ? (r.images?.original?.url || r.images?.downsized?.url || '') : '';
        })
        .finally(() => { delete _gifSearchPending[keyword]; });
    }
    const gif = await _gifSearchPending[keyword];
    if (gif) {
      _gifSearchCache[keyword] = gif;
      const elGone = !document.getElementById(elementId);
      swap(_gifImgHtml(gif, keyword));
      _persistGifResult(keyword, gif);
      // 占位元素已被中途的重渲染换掉 → 再渲染一次（这次直接命中 _gifSearchCache 出图，不会循环）
      if (elGone) renderMessages();
      return;
    }
    swap(`<span style="color:var(--text-muted);font-size:12px;">[未找到表情: ${escHtml(keyword)}]</span>`);
  } catch(e) {
    swap(`<span style="color:var(--text-muted);font-size:12px;">[表情包: ${escHtml(keyword)}] (搜索失败，稍后自动重试)</span>`);
  }
}
// 把存储里的 [[GIF_SEARCH:kw]] 固化成 [[GIF:url|kw]]（同关键词 limit=1 结果一致，全部替换）
function _persistGifResult(keyword, gifUrl) {
  const chat = getActiveChat();
  if (!chat) return;
  const re = new RegExp(`\\[\\[GIF_SEARCH:\\s*${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]`, 'g');
  const tag = `[[GIF:${gifUrl}|${keyword}]]`;
  let changed = false;
  const fix = s => { if (!s) return s; const r = s.replace(re, tag); if (r !== s) changed = true; return r; };
  for (const node of Object.values(chat.nodes)) {
    node.content = fix(node.content);
    if (node.blocks) node.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    // 拆条语音的表情段存的是标签副本，也得一起固化。漏了的话 content 里明明已经是
    // [[GIF:url]]，voiceParts 里还留着 [[GIF_SEARCH:kw]] —— 这一进程靠内存缓存看着正常，
    // 重开缓存空了就会拿同一个关键词重搜一次，可能换成另一张图，离线时干脆显示失败。
    if (node.voiceParts) node.voiceParts.forEach(p => { if (p.type === 'sticker') p.tag = fix(p.tag); });
    if (node.variants) node.variants.forEach(v => {
      v.content = fix(v.content);
      if (v.blocks) v.blocks.forEach(b => { if (b.type === 'text') b.text = fix(b.text); });
    });
  }
  if (changed) save();
}

// 点面板外关闭。和上面数学面板同一个坑：.sticker-picker-wrap 现在只是个宽高为 0 的定位锚点，
// 真正的☺按钮(#emojiBtn)和展开工具条上的表情键都在它外面 —— onclick 刚把面板打开，
// 同一次 click 冒泡到这儿又立刻关掉，电脑端看起来就是「点了完全没反应」。
document.addEventListener('click', e => {
  const panel = document.getElementById('stickerPanel');
  if (!panel?.classList.contains('open')) return;
  if (_isMobile()) return;
  if (!e.target.closest('.sticker-picker-wrap') && !e.target.closest('#stickerPanel')
      && !e.target.closest('#emojiBtn') && !e.target.closest('.expand-tool-btn')
      && !e.target.closest('.plus-menu-wrap')) closeStickerPanel();
});

loadStickers();

function isTextFile(mime) {
  const textTypes = ['text/', 'application/json', 'application/javascript', 'application/xml', 'application/x-httpd-php', 'application/x-sh', 'application/x-python', 'application/x-yaml'];
  return textTypes.some(t => mime.startsWith(t));
}
function isTextFileByName(name) {
  const ext = name.split('.').pop().toLowerCase();
  const textExts = ['txt','html','htm','md','csv','json','js','ts','jsx','tsx','css','scss','less','xml','yaml','yml','toml','ini','cfg','log','py','rb','php','java','c','cpp','h','hpp','sh','bat','ps1','sql','r','go','rs','swift','kt','lua','vim','conf','env'];
  return textExts.includes(ext);
}
function isDocxFile(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return ['docx', 'doc', 'pdf', 'pptx', 'xlsx', 'odt'].includes(ext);
}
async function extractDocText(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) throw new Error('not-docx');
    const xml = await xmlFile.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paragraphs = doc.getElementsByTagName('w:p');
    const lines = [];
    for (const p of paragraphs) {
      const texts = p.getElementsByTagName('w:t');
      let line = '';
      for (const t of texts) line += t.textContent || '';
      lines.push(line);
    }
    return lines.join('\n');
  } catch {
    const buf = await file.arrayBuffer();
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const res = await fetch(SERVER_BASE + '/api/extract-doc?ext=' + ext, {
      method: 'POST', body: buf,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '解析失败');
    return j.text;
  }
}
// 粘贴支持（图片 → 气泡 / 文本文件 → 气泡 / 超长文字 → 自动转.txt）
const PASTE_TEXT_LIMIT = 500;  // 超过这个字数就变成文件气泡
document.getElementById('userInput').addEventListener('paste', function(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  let handled = false;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault(); handled = true;
      const file = item.getAsFile();
      const r = new FileReader();
      r.onload = ev => { addPendingImg({ url: ev.target.result, name: 'paste-' + Date.now() + '.png' }); };
      r.readAsDataURL(file);
    } else if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file && typeof isAudioFile === 'function' && isAudioFile(file)) {
        e.preventDefault(); handled = true;
        addAudioFile(file);
      } else if (file && isDocxFile(file.name || '')) {
        e.preventDefault(); handled = true;
        addDocFile(file);
      } else if (file && (isTextFile(item.type) || isTextFileByName(file.name || ''))) {
        e.preventDefault(); handled = true;
        const r = new FileReader();
        r.onload = ev => { _pendingFiles.push({ name: file.name, content: ev.target.result }); renderPendingFiles(); };
        r.readAsText(file);
      }
    }
  }
  if (!handled) {
    const plainText = e.clipboardData.getData('text/plain');
    if (plainText && plainText.length > PASTE_TEXT_LIMIT) {
      e.preventDefault();
      _pendingFiles.push({ name: 'paste-' + Date.now() + '.txt', content: plainText });
      renderPendingFiles();
    }
  }
});

// 拖拽文件支持（图片 → 气泡 / 文本文件 → 气泡）
const inputBar = document.querySelector('.input-bar');
inputBar.addEventListener('dragover', function(e) { e.preventDefault(); this.style.borderColor = 'var(--accent)'; });
inputBar.addEventListener('dragleave', function(e) { this.style.borderColor = ''; });
inputBar.addEventListener('drop', function(e) {
  e.preventDefault();
  this.style.borderColor = '';
  const files = e.dataTransfer?.files;
  if (!files) return;
  Array.from(files).forEach(file => {
    if (file.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = ev => { addPendingImg({ url: ev.target.result, name: file.name }); };
      r.readAsDataURL(file);
    } else if (typeof isAudioFile === 'function' && isAudioFile(file)) {
      addAudioFile(file);   // 拖进来的音频让电脑上的 Gemini 听一遍（66-audio-attach.js）
    } else if (typeof isVideoFile === 'function' && isVideoFile(file)) {
      addVideoFile(file);   // 拖进来的视频走抽帧（30-video.js），不接的话拖了等于没拖
    } else if (isDocxFile(file.name)) {
      addDocFile(file);
    } else if (isTextFile(file.type) || isTextFileByName(file.name)) {
      const r = new FileReader();
      r.onload = ev => { _pendingFiles.push({ name: file.name, content: ev.target.result }); renderPendingFiles(); };
      r.readAsText(file);
    }
  });
});
