function updateBrightness(val) {
  state.brightness = parseFloat(val);
  const t = (typeof effectiveTheme === 'function') ? effectiveTheme() : { mask:'9,9,15' };
  document.getElementById('bg-mask').style.background = `rgba(${t.mask},${val})`;
  // 遮罩浓度就是"壁纸透出来多少"，auto 挡的判据直接建立在它上面。
  // 亮度是缓存的，这里只重算合成值，拖滑块不会反复解码图片。
  applyBgLegibility();
  save();
}
function updateBgBlur(val) {
  state.bgBlur = parseFloat(val);
  document.getElementById('bg-layer').style.filter = `blur(${val}px) saturate(0.6)`;
  save();
}
function updateUiBlur(val, fromRender = false) {
  state.uiBlur = parseFloat(val);
  const v = `blur(${val}px)`;
  document.getElementById('sidebar').style.backdropFilter = v;
  document.getElementById('sidebar').style.webkitBackdropFilter = v;
  if (!fromRender) save();
}
function applyBackgroundBtn() {
  const val = document.getElementById('bgInput').value.trim();
  if (val) { state.background = val; renderBackground(); save(); }
}
function handleBgFileUpload(input) {
  const file = input.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const r = new FileReader();
  r.onload = e => {
    state.background = e.target.result;
    renderBackground(); save();
    // 明确提示走的是"背景"通道：手机 WebView 的文件选择器偶发会把结果路由错，
    // 如果上传头像却弹出这个提示，说明就是选择器串线（头像变壁纸的来源），当场可发现
    showToast('✓ 聊天背景已更新', 'success');
  };
  r.readAsDataURL(file);
  input.value = '';
}
function clearBackground() {
  state.background = '';
  document.getElementById('bg-layer').style.backgroundImage = '';
  document.getElementById('bgInput').value = '';
  applyBgTint();         // 壁纸没了，取色也就无从谈起，退回手选色
  applyBgLegibility();   // 同理，底衬也得撤掉，否则纯色底上白挂一层壳
  save();
}
function renderBackground() {
  if (state.background) {
    document.getElementById('bg-layer').style.backgroundImage = `url('${state.background}')`;
    // 不把 base64 塞进输入框，只显示 URL 或占位提示
    const inp = document.getElementById('bgInput');
    if (state.background.startsWith('data:')) {
      inp.value = '';
      inp.placeholder = '已使用本地图片 (◕‿◕)';
    } else {
      inp.value = state.background;
      inp.placeholder = '粘贴图片链接…';
    }
  }
  const temp = (typeof effectiveTheme === 'function') ? effectiveTheme() : { mask:'9,9,15' };
  document.getElementById('bg-mask').style.background = `rgba(${temp.mask},${state.brightness})`;
  document.getElementById('brightnessRange').value = state.brightness;
  document.getElementById('brightnessLabel').innerText = parseFloat(state.brightness).toFixed(2);
  if (document.getElementById('bgBlurRange')) {
    document.getElementById('bgBlurRange').value = state.bgBlur ?? 3;
    document.getElementById('bgBlurLabel').innerText = (state.bgBlur ?? 3).toFixed(1) + 'px';
    document.getElementById('uiBlurRange').value = state.uiBlur ?? 28;
    document.getElementById('uiBlurLabel').innerText = (state.uiBlur ?? 28) + 'px';
  }
  updateBgBlur(state.bgBlur ?? 3);
  updateUiBlur(state.uiBlur ?? 28, true);
  syncFontSizeUI();
  if (typeof _syncAppearancePresetUI === 'function') _syncAppearancePresetUI();
  applyBgTint();   // 背景换了就重取一次色（关着开关时它只负责把颜色退回手选色）
  applyBgLegibility();   // 换了张白壁纸就该自动补底衬，换回深色的自动撤掉
}
// ═══════════════════════════════════════════════════════
// 壁纸取色（开关，默认关）
// ═══════════════════════════════════════════════════════
// 从背景图里挑一个主色，染到 --accent 那一整套变量上。
// ⚠️ 只改「当前生效的颜色」，绝不动 state.accentColor —— 手选色原样留着，
// 关掉开关立刻退回去，不会把用户攒的配色悄悄吃掉。

var _bgTintCache = { src: '', hex: '' };   // 同一张图别反复解码：切标签页、云端回灌都会重跑 renderBackground

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else               h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}
function _hslToHex(h, s, l) {
  const f = n => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}
// 图片得能被画布跨域读取，否则 getImageData 抛 SecurityError（画布被污染）。
// data: 直接用；外链先试 crossOrigin，站点不给 CORS 头就退到 server 的 /api/proxy-image
//（那个接口固定回 Access-Control-Allow-Origin:*，本来就是为这种场景准备的）。
function _loadTintImage(src) {
  const load = url => new Promise((ok, no) => {
    const img = new Image();
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload  = () => ok(img);
    img.onerror = () => no(new Error('图片加载失败'));
    img.src = url;
  });
  if (src.startsWith('data:')) return load(src);
  return load(src).catch(() => load(gcTok(SERVER_BASE + '/api/proxy-image?url=' + encodeURIComponent(src))));
}
// 按色相分 24 桶投票选主色。只投「够鲜艳、不过暗不过亮」的像素：
// 壁纸大半是暗部和灰天空，按出现次数硬选必然选出一坨灰，染到 UI 上等于没染。
async function _pickTintFromImage(src) {
  const img = await _loadTintImage(src);
  const N = 48;                                        // 缩到 48×48 取样：够稳，手机上也不卡
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, N, N);
  const data = cx.getImageData(0, 0, N, N).data;       // 跨域没解决的话在这里抛，交给上层兜底

  const bins = Array.from({ length: 24 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;                   // 透明像素不算
    const [h, s, l] = _rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.18 || l < 0.12 || l > 0.92) continue;    // 灰、死黑、过曝全跳过
    const w = s * (1 - Math.abs(l - 0.5) * 1.4);       // 越鲜艳、越接近中间调，票越重
    if (w <= 0) continue;
    const bin = bins[Math.min(23, Math.floor(h * 24))];
    bin.w += w; bin.h += h * w; bin.s += s * w; bin.l += l * w;
  }
  const top = bins.reduce((a, b) => (b.w > a.w ? b : a), bins[0]);
  if (top.w <= 0) throw new Error('这张图挑不出有彩度的主色');

  // 归一化到深色 UI 能看清的区间：--accent 既要当深底上的文字色，
  // 又要当按钮底色配白字 —— 太暗看不见，太浅白字糊掉。
  // 区间对齐默认的 #6366f1（s≈0.84、l≈0.67），保证观感不跑偏。
  return _hslToHex(
    top.h / top.w,
    Math.max(0.55, Math.min(0.88, top.s / top.w)),
    Math.max(0.58, Math.min(0.70, top.l / top.w))
  );
}
// 背景变了 / 开关动了 / 启动完成，都走这里。
async function applyBgTint() {
  const t = document.getElementById('bgAutoTintToggle');
  if (t) t.checked = !!state.bgAutoTint;   // 别在 HTML 里写死 checked——面板重画会把它弹回默认值
  if (!state.bgAutoTint || !state.background) {
    _bgTintCache = { src: '', hex: '' };
    applyAccentCSS(state.accentColor);     // 退回手选色
    return;
  }
  if (_bgTintCache.src === state.background && _bgTintCache.hex) {
    applyAccentCSS(_bgTintCache.hex);
    return;
  }
  const src = state.background;
  try {
    const hex = await _pickTintFromImage(src);
    // 取色期间她又换了壁纸 / 关了自动取色：这个结果作废。外链走代理慢、本地图快，
    // 不比对的话先设的那张后回来，界面按旧图着色、背景却是新图
    if (!state.bgAutoTint || state.background !== src) return;
    _bgTintCache = { src, hex };
    applyAccentCSS(hex);
    // 有些颜色是烤进 inline style 的（气泡、聊天列表），得重画才跟得上
    if (typeof renderChatList === 'function') renderChatList();
    if (typeof renderMessages === 'function') renderMessages();
  } catch (e) {
    if (!state.bgAutoTint || state.background !== src) return;
    // 取不出来不算故障，就是这张壁纸不适合取色（纯灰 / 跨域读不到像素）。
    // 静默退回手选色；只有设置面板开着才提示，免得启动时冒出个没头没尾的报错。
    console.warn('[壁纸取色]', e.message);
    applyAccentCSS(state.accentColor);
    if (!document.getElementById('settingsModal')?.classList.contains('hidden')) {
      showToast('这张壁纸取不出主色（' + e.message + '），先用你选的颜色', 'error', 3000);
    }
  }
}
function toggleBgAutoTint(on) {
  state.bgAutoTint = !!on;
  save();
  applyBgTint();
}

// ═══════════════════════════════════════════════════════
// 浅色壁纸的文字底衬（三档：auto / on / off，默认 auto）
// ═══════════════════════════════════════════════════════
// 起因：solo 模式（单模型，用户的主力用法）下 AI 气泡的底被刻意做到几乎没有
// （grancyan.css 那条 `background:rgba(255,255,255,0.012)` + `backdrop-filter:none`），
// 正文等于**直接裸压在壁纸上**。壁纸一白，#eee8df 的字就整段糊掉，
// 而且这事只在特定壁纸 + 特定遮罩浓度的组合下才出现，看着像"偶尔发癫"。
//
// ⚠️ 判亮度必须判**合成后**的，不是原图的：bg-mask 那层 rgba(9,9,15,brightness)
// 压在图上面。只看原图的话，遮罩拉到 0.88 时任何白图都会被误判成"需要底衬"，
// 于是她的深色配色被无缘无故加上一层壳。
//
// auto 挡的判据是对比度而不是"图白不白"：文字 #eee8df 的相对亮度是 0.812，
// 要求它和背景至少有 WCAG AA 的 4.5:1，反推出背景相对亮度上限 ≈ 0.142。
// 不用 3:1（大字标准）—— 17px 的中文是正文不是大字，而且中文笔画比拉丁字母密，
// 同样对比度下更早糊。够黑就一点不动，保持她原本的观感。
//
// 顺带一个反直觉的结论（实测算出来的，别凭感觉推翻）：默认遮罩 0.88 下，
// **纯白壁纸的合成对比度也有 12:1**，数学上完全够读 —— 也就是说 auto 挡在她的
// 默认配置下永远不触发。真正会读不清的是她把遮罩拉到 0.6 以下想看清壁纸的时候。
// 所以「常开」这一挡是必须留的：判据只管得住能量化的那部分。

var _bgLumCache = { src: '', lum: -1 };

// sRGB → WCAG 相对亮度
function _relLum(r, g, b) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// 取图的「偏亮那一侧」的亮度（P75）而不是平均值。
// 一张整体很暗、但中间横着一大片白云/雪地的壁纸，平均值完全正常，
// 可正文偏偏就压在那片白上 —— 用平均值判等于漏掉最典型的那种难读。
async function _pickBgLuminance(src) {
  if (_bgLumCache.src === src && _bgLumCache.lum >= 0) return _bgLumCache.lum;
  const img = await _loadTintImage(src);
  const N = 48;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, N, N);
  const data = cx.getImageData(0, 0, N, N).data;
  const lums = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    lums.push(_relLum(data[i], data[i + 1], data[i + 2]));
  }
  if (!lums.length) throw new Error('这张图取不到像素');
  lums.sort((a, b) => a - b);
  const lum = lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.75))];
  _bgLumCache = { src, lum };
  return lum;
}

// 遮罩压上去之后实际透出来的亮度。遮罩色跟着色温走，自己调了底色就跟底色（effectiveTheme().mask）。
function _maskedLuminance(imgLum) {
  const t = (typeof effectiveTheme === 'function') ? effectiveTheme() : { mask: '9,9,15' };
  const [mr, mg, mb] = String(t.mask).split(',').map(n => parseFloat(n) || 0);
  const a = Math.max(0, Math.min(1, Number(state.brightness ?? 0.88)));
  // 亮度不是线性可加的，但遮罩是在 sRGB 空间做的 alpha 混合，所以要在 sRGB 空间混完再转亮度。
  // 拿 imgLum 反推一个等效灰阶，混上遮罩色，再算一次相对亮度。
  const inv = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
  const g0 = inv(imgLum);
  return _relLum(g0 * (1 - a) + mr * a, g0 * (1 - a) + mg * a, g0 * (1 - a) + mb * a);
}

// 文字 #eee8df 的相对亮度 = 0.812，要 4.5:1 → 背景上限 (0.812+0.05)/4.5 - 0.05
const BG_LUM_CEILING = (0.812 + 0.05) / 4.5 - 0.05;

async function applyBgLegibility() {
  const mode = state.bgLegibility || 'auto';
  const sel = document.getElementById('bgLegibilitySelect');
  if (sel) sel.value = mode;          // 别在 HTML 里写死 selected：面板重画会弹回默认值
  const set = on => document.body.classList.toggle('bg-light-boost', !!on);

  if (mode === 'off') return set(false);
  // 浅色配色（米纸）下这层「给亮壁纸垫深色壳」是反着来的：底和字本来就是为亮背景配的
  if (document.documentElement?.classList.contains('theme-light')) return set(false);
  if (mode === 'on')  return set(true);
  if (!state.background) return set(false);   // 没壁纸就是纯 --bg-base，本来就够黑
  const src = state.background;
  try {
    const lum = _maskedLuminance(await _pickBgLuminance(src));
    // 同取色：晚回来的旧壁纸结果别盖掉新壁纸的判断
    if (state.background !== src || (state.bgLegibility || 'auto') !== 'auto') return;
    set(lum > BG_LUM_CEILING);
  } catch (e) {
    if (state.background !== src) return;
    // 跨域读不到像素 / 纯透明图。判不了就当它不需要 —— 宁可维持原样，
    // 也不要因为一次取样失败就给深色壁纸套上一层她没要过的壳。
    console.warn('[壁纸亮度]', e.message);
    set(false);
  }
}
function setBgLegibility(mode) {
  state.bgLegibility = ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
  save();
  applyBgLegibility();
}

function syncFontSizeUI() {
  const aiSlider = document.querySelector('#stab-appearance input[oninput^="setAiFontSize"]');
  const userSlider = document.querySelector('#stab-appearance input[oninput^="setUserFontSize"]');
  if (aiSlider) aiSlider.value = state.aiFontSize;
  if (userSlider) userSlider.value = state.userFontSize;
  const aiLbl = document.getElementById('aiFontSizeLabel');
  const userLbl = document.getElementById('userFontSizeLabel');
  if (aiLbl) aiLbl.innerText = state.aiFontSize + 'px';
  if (userLbl) userLbl.innerText = state.userFontSize + 'px';
}

// ═══════════════════════════════════════════════════════
// SETTINGS TABS
// ═══════════════════════════════════════════════════════
function switchSettingsTab(name, btn) {
  document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.stab-content').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('stab-' + name).classList.add('active');
  if (typeof _syncInkSettings === 'function') _syncInkSettings();   // 云端设置可能在开机后改过它，打开设置时回填一次
  if (name === 'memory') { renderSettingsMemoryList(); document.getElementById('autoMemoryToggle').checked = state.autoMemory; }
  if (name === 'account') {
    renderUserAvatar();
    const t = document.getElementById('showUserAvatarToggle'); if (t) t.checked = !!state.showUserAvatar;
    const ni = document.getElementById('userNameInput'); if (ni) ni.value = state.userName || '';
    const nt = document.getElementById('userNameAiToggle'); if (nt) nt.checked = state.userNameAiVisible !== false;
    const tr = document.getElementById('typingRhythmToggle'); if (tr) tr.checked = state.typingRhythmEnabled !== false;
    const td = document.getElementById('typingDraftPeekToggle'); if (td) td.checked = !!state.typingDraftPeek;
  }
  if (name === 'models') { renderConfigs(); renderSearchSettings(); renderSkillToggles(); }
  if (name === 'trash') renderTrashList();
}
function toggleSettings() {
  document.getElementById('settingsModal').classList.toggle('hidden');
  refreshSettingsUI();
}
// 设置面板按 state 回填。两个入口共用这一份：右上角 ⚙（toggleSettings）和小组件 hub 里的
// 「设置中心」（14 的 renderHubSettings）。以前 hub 那边是手抄的副本，两边各漏各的 ——
// 从 hub 进去「谁来跑腿」下拉一个选项都没有、技能开关没画，月历那个框也没回填（2026-10-10）。
// ⚠️ 新加的设置项回填写在这里，别再往任何一个入口里单独抄。
function refreshSettingsUI() {
  renderConfigs(); renderSettingsMemoryList(); renderSearchSettings();
  const tenorInp = document.getElementById('tenorKeyInput');
  if (tenorInp) tenorInp.value = state.tenorApiKey || '';
  const thinkSumInp = document.getElementById('thinkSumKeyInput');
  if (thinkSumInp) thinkSumInp.value = state.thinkSumKey || '';
  renderVoiceSettings();
  renderSkillToggles();
  if (typeof renderErrandSettings === 'function') renderErrandSettings();
  syncCallBgUI();
  const dndT0 = document.getElementById('callDndToggle'); if (dndT0) dndT0.checked = !!state.callDnd;
  // ⚠️ 设置里的每个开关都要按当前 state 回填，不能靠 HTML 里的默认未勾选。
  //    默认开的那几个尤其明显：第一次打开设置会看见两个没勾的框，
  //    而功能其实是开着的 —— 她照着框去理解，就理解反了。（Codex 逮到的）
  const crT = document.getElementById('coreadToggle');
  if (crT) crT.checked = (typeof coreadEnabled === 'function') ? coreadEnabled() : true;
  if (typeof coreadRenderStatus === 'function') coreadRenderStatus();
  const lfT = document.getElementById('lifeToggle');
  if (lfT) lfT.checked = (typeof lifeEnabled === 'function') ? lifeEnabled() : true;
  // ⚠️⚠️ 这里必须读**原始的 state.lifeCycleShare**，不能用 lifeCycleShared() ——
  //    那个函数是 `lifeEnabled() && share !== false`，受总开关影响。
  //    后果是隐私方向的：总开关关着时月历框显示没勾，她再打开总开关，
  //    框**还是没勾**，但 lifeCycleShare 实际是 true，下一轮就把身体记录发出去了。
  //    她看着一个没勾的框，以为没在发。（Codex 三审逮到的，我上一版的测试
  //    还把这个错误实现当成正确断言固化下来了。）
  const lcT = document.getElementById('lifeCycleToggle');
  if (lcT) lcT.checked = (typeof state === 'object' && state) ? (state.lifeCycleShare !== false) : true;
  const serverInp = document.getElementById('serverBaseInput');
  if (serverInp) {
    serverInp.value = localStorage.getItem('grancyanServerBase') || '';
    serverInp.placeholder = '留空 = 自动 (当前: ' + SERVER_BASE + ')';
  }
  if (typeof renderPairSettings === 'function') renderPairSettings();
  const ccT = document.getElementById('ccMemoryToggle');
  if (ccT) { ccT.checked = !!state.ccMemoryEnabled; if (typeof refreshCcMemoryStat === 'function') refreshCcMemoryStat(); }
  if (typeof syncTtsSettingsUI === 'function') syncTtsSettingsUI();
}
function renderSearchSettings() {
  const sel = document.getElementById('webSearchProviderSelect');
  if (!sel) return;
  const p = state.webSearchProvider || 'tavily';
  sel.value = p;
  const sec = document.getElementById('webSearchApiKeySection');
  if (!sec) return;
  if (p === 'duckduckgo') {
    sec.innerHTML = '<div class="field-full field-group" style="color:var(--text-muted);font-size:12px;">✓ DuckDuckGo 无需 API Key，直接可用</div>';
  } else {
    const label = p === 'tavily' ? 'Tavily API Key (在 tavily.com 获取)' :
                  p === 'serper' ? 'Serper API Key (在 serper.dev 获取)' :
                  p === 'brave' ? 'Brave API Key (在 brave.com/search/api 获取)' : 'API Key';
    const ph = p === 'tavily' ? 'tvly-…' : p === 'serper' ? 'serper-…' : 'your-api-key';
    sec.innerHTML = '<div class="field-full field-group"><span class="field-label">' + escHtml(label) +
      '</span><input class="field-input" type="password" value="' + escHtml(state.webSearchApiKey || '') +
      '" placeholder="' + escHtml(ph) + '" onchange="state.webSearchApiKey=this.value;save()"></div>';
  }
}

/* 语音转写的服务商设置。做成可切换是因为 Groq 注册可能一直卡在「邮箱不属于任何组织」——
   这几家其实是同一套 OpenAI 兼容接口，换服务商只是换 baseURL 和模型名（见 server.js 的
   STT_PROVIDERS）。硅基流动国内手机号就能注册、直连不用梯子，所以摆在第一个。 */
const VOICE_PROVIDER_INFO = {
  deepgram: {
    label: 'Deepgram API Key', ph: '（一长串十六进制）',
    tip: '邮箱注册就行，不要手机号、不用绑卡，直接送 $200 额度（够你说到天荒地老）。<a href="https://console.deepgram.com/signup" target="_blank" style="color:var(--accent)">去拿 Key →</a> 用 nova-3 模型，识别快。要梯子。',
  },
  elevenlabs: {
    label: 'ElevenLabs API Key', ph: 'sk_…',
    tip: '邮箱注册，有免费额度。<a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" style="color:var(--accent)">去拿 Key →</a> 用 Scribe 模型，转写准确度是这几家里最高的（中英混说也稳）。要梯子。',
  },
  groq: {
    label: 'Groq API Key', ph: 'gsk_…',
    tip: '免费额度大、最快。<a href="https://console.groq.com/keys" target="_blank" style="color:var(--accent)">去拿 Key →</a>（注册若卡在「邮箱不属于任何组织」，换无痕窗口 + 换节点，或直接用 Google 账号登）。要梯子。',
  },
  openai: {
    label: 'OpenAI API Key', ph: 'sk-…',
    tip: '用 whisper-1，按量计费（要绑卡）。<a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--accent)">去拿 Key →</a>',
  },
  siliconflow: {
    label: '硅基流动 API Key', ph: 'sk-…',
    tip: '国内直连、不用梯子，但注册要手机号实名。<a href="https://cloud.siliconflow.cn/account/ak" target="_blank" style="color:var(--accent)">去拿 Key →</a>（SenseVoiceSmall，中文很准）',
  },
};
function renderVoiceSettings() {
  const sel = document.getElementById('voiceProviderSelect');
  const sec = document.getElementById('voiceSettingsSection');
  if (!sel || !sec) return;
  const p = state.voiceProvider || 'deepgram';
  sel.value = p;
  const keyField = (label, ph) => `
    <div class="field-full field-group">
      <span class="field-label">${escHtml(label)}</span>
      <input class="field-input" type="password" id="voiceKeyInput" value="${escHtml(state.voiceApiKey || '')}"
        placeholder="${escHtml(ph)}" onchange="state.voiceApiKey=this.value;save()">
    </div>`;
  if (p === 'custom') {
    sec.innerHTML = keyField('API Key', 'sk-…') + `
      <div class="field-full field-group">
        <span class="field-label">Base URL（到 /v1 为止）</span>
        <input class="field-input" type="text" value="${escHtml(state.voiceApiBase || '')}"
          placeholder="https://api.example.com/v1" onchange="state.voiceApiBase=this.value;save()">
      </div>
      <div class="field-full field-group">
        <span class="field-label">模型名</span>
        <input class="field-input" type="text" value="${escHtml(state.voiceModel || '')}"
          placeholder="whisper-1" onchange="state.voiceModel=this.value;save()">
      </div>
      <div class="section-desc">任何提供 OpenAI 兼容 <code>/audio/transcriptions</code> 的服务都行。</div>`;
  } else {
    const info = VOICE_PROVIDER_INFO[p] || VOICE_PROVIDER_INFO.deepgram;
    sec.innerHTML = keyField(info.label, info.ph) + `<div class="section-desc">${info.tip}</div>`;
  }
}

// ═══════════════════════════════════════════════════════
// 指尖节奏 —— 让 AI 感觉到用户打字时的犹豫
// 参照 github.com/eveacla11/fingertips，铁律照抄：默认只记时间戳，一个字都不碰。
// 想让 AI 连没发出去的草稿也看见，另开 state.typingDraftPeek（默认关）。
// 全在本地 localStorage 里滚，不依赖 SERVER_BASE —— 手机连不上电脑时照样有。
// ═══════════════════════════════════════════════════════
const TYPING_ORPHAN_AFTER = 10 * 60 * 1000; // 打完这么久还没发 → 记成「欲言又止」
const TYPING_MIN_NOTE     = 20 * 1000;      // 打字没超过这么久就别打扰 AI（快问快答很正常）
const TYPING_PAUSE_GAP    = 15 * 1000;      // 两次输入隔这么久，算「停下来想了一次」
const TYPING_PING_GAP     = 4 * 1000;       // 最快多久记一次，别把 localStorage 写爆
const TYPING_PING_KEEP    = 300;
const TYPING_NOTE_TTL     = 2 * 60 * 1000;  // 结算出的节奏笔记多久后作废
const TYPING_KEY = 'kuro_typingRhythm';

let _typingPings = [];
let _typingOrphan = null;      // { start, end, text? }
let _typingDraft = '';
let _lastTypingPing = 0;
let _typingNote = null;        // { text, ts } —— 发送时结算一次，buildSystemPrompt 只读

function _typingLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(TYPING_KEY) || '{}');
    _typingPings  = Array.isArray(d.pings) ? d.pings : [];
    _typingOrphan = d.orphan || null;
    _typingDraft  = d.draft || '';
  } catch { _typingPings = []; _typingOrphan = null; _typingDraft = ''; }
}
function _typingSave() {
  try {
    localStorage.setItem(TYPING_KEY, JSON.stringify({
      pings: _typingPings, orphan: _typingOrphan, draft: _typingDraft }));
  } catch {}
}
// 一段字搁置太久没发出去 → 沉为「欲言又止」的痕迹
function _typingGc() {
  if (!_typingPings.length) return;
  const last = _typingPings[_typingPings.length - 1];
  if (Date.now() - last <= TYPING_ORPHAN_AFTER) return;
  if (last - _typingPings[0] >= 5000) {   // 太短的不算，可能只是误触
    _typingOrphan = { start: _typingPings[0], end: last, text: _typingDraft || '' };
  }
  _typingPings = [];
  _typingDraft = '';
}

// 输入框每次 input 都会走这儿（4 秒节流）
function typingPing(el) {
  if (state.typingRhythmEnabled === false) return;
  const now = Date.now();
  if (now - _lastTypingPing < TYPING_PING_GAP) return;
  if (!el || !el.value.trim()) return;
  _lastTypingPing = now;
  _typingLoad();
  _typingGc();
  _typingPings.push(now);
  if (_typingPings.length > TYPING_PING_KEEP) _typingPings = _typingPings.slice(-TYPING_PING_KEEP);
  // 草稿只在用户明确打开偷看开关时才落盘，否则这套系统从头到尾没见过一个字
  _typingDraft = state.typingDraftPeek ? el.value.slice(0, 500) : '';
  _typingSave();
}

// 发送时结算：把这段节奏变成一句给 AI 看的话，然后清账
function popTypingNote() {
  if (state.typingRhythmEnabled === false) { _typingNote = null; return; }
  _typingLoad();
  _typingGc();
  const notes = [];
  if (_typingOrphan) {
    const mins = Math.round((Date.now() - _typingOrphan.end) / 60000);
    const dur  = Math.round((_typingOrphan.end - _typingOrphan.start) / 1000);
    let s = `${state.userName || '用户'} ${mins} 分钟前打过 ${dur} 秒的字，那条最后没有发出来`;
    s += (state.typingDraftPeek && _typingOrphan.text)
      ? `，当时打的是：「${_typingOrphan.text}」`
      : '（打了什么无人知晓，包括这套系统）';
    notes.push(s);
    _typingOrphan = null;
  }
  if (_typingPings.length) {
    const dur = Math.round((_typingPings[_typingPings.length - 1] - _typingPings[0]) / 1000);
    let gaps = 0;
    for (let i = 1; i < _typingPings.length; i++) {
      if (_typingPings[i] - _typingPings[i - 1] > TYPING_PAUSE_GAP) gaps++;
    }
    if (dur * 1000 >= TYPING_MIN_NOTE || gaps) {
      let seg = `这条消息${state.userName || '用户'}打了 ${dur} 秒`;
      if (gaps) seg += `，中途停下来想了 ${gaps} 次`;
      notes.push(seg);
    }
    _typingPings = [];
    _typingDraft = '';
  }
  _typingSave();
  _typingNote = notes.length ? { text: notes.join('；'), ts: Date.now() } : null;
}

// buildSystemPrompt 调用（可能一次发送里被调好几次），只读、不消费；超时自动作废
function currentTypingNote() {
  if (!_typingNote) return '';
  if (Date.now() - _typingNote.ts > TYPING_NOTE_TTL) { _typingNote = null; return ''; }
  return _typingNote.text;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
function autoResize(el) {
  // 发送/清空/粘贴/切对话 都会走到这儿，顺手把手机端输入栏的按钮状态也刷了，
  // 免得每个改动 value 的地方都得记着调一次 updateComposerBtns()
  if (el && el.id === 'userInput') { try { updateComposerBtns(); } catch {} }
  // 全屏展开模式下高度由 CSS 撑满，不做自动伸缩
  if (el.id === 'userInput' && el.closest('.input-expanded')) { el.style.height = ''; return; }
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

// ── 输入框全屏展开/收起（类 GPT 大编辑窗口）──
function toggleInputExpand(force) {
  const wrap  = document.querySelector('.input-bar-wrap');
  const btn   = document.getElementById('expandInputBtn');
  const input = document.getElementById('userInput');
  if (!wrap || !input) return;
  const on = (force !== undefined) ? force : !wrap.classList.contains('input-expanded');
  wrap.classList.toggle('input-expanded', on);
  // 面板虽是 fixed 全屏 z-70，但被困在 main 的 z-10 层叠上下文里，会被 #sidebar(z-30) 盖住左侧；
  // 展开期间把 main 临时抬到侧栏之上（45 < 各弹窗的 50，不抢模态框）
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.toggle('input-expand-hoist', on);
  // 图标是按钮里的两枚 SVG，CSS 按 .input-expanded 切；这里只换提示文字（别再写 textContent，会把 SVG 冲掉）
  if (btn) { const tip = on ? '收起输入框 (Esc)' : '展开输入框'; btn.title = tip; btn.setAttribute('aria-label', tip); }
  if (on) { input.style.height = ''; input.focus(); }
  else { autoResize(input); }
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* 把值拼进 onclick="..." 这类事件属性里时用这个，别自己 JSON.stringify 完只换引号。
   漏掉 & 是会出人命的：属性里的实体是浏览器**解析属性时**就解掉的，所以值自身带的
   &quot; 会变回真引号，把 JS 字符串literal提前收尾 —— 名字取成 `&quot;);alert(1);//`
   的歌 / 分组 / 书签，点一下就执行了。& 必须第一个换，不然会把自己刚生成的实体再转一遍。
   单引号也要换：24-music 的 onclick 用的是单引号包裹，歌名里一个 Don't 就能崩掉。 */
function jsAttr(v) {
  return JSON.stringify(v)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;');
}
// 抠占位符用的前缀，每次现摇一个。
// 写死成字面量的话，正文里同形的字符串就会被还原逻辑撞上：下标越界的被吞成空，
// 撞上真实下标的被换成别处的内容。用户能手打，AI 也能原样吐出来，两边都不可信。
// 首尾固定用字母，中间的 (\d+) 下标不会和随机段自身的数字粘连。
function _placeholderNonce() {
  return 'zZ' + Math.random().toString(36).slice(2, 10) + 'Zz';
}
// 用户消息保留原始 m.content，仅显示时支持安全的基础 Markdown。
function renderUserText(raw) {
  const store = [];
  const nonce = _placeholderNonce();
  const keep = m => { store.push(m); return nonce + (store.length - 1) + nonce; };
  // 应用自己的富媒体标签先整体抠成占位符，两个理由：
  // 一是 marked(GFM) 会把标签里的裸 URL 自动加 <a>，抠走它就啃不到；
  // 二是下面那轮图片清洗只该管用户手打的 Markdown 图片——占位期间表情包
  // 还不是 <img>，清洗压根见不到它，不必靠 class 白名单去区分谁是谁
  // （白名单漏一个就是静默把表情包显示成 alt 那行文字）。
  const source = normalizeStickerTags(escHtml(raw || ''))
    .replace(/\[\[[A-Z0-9_]+:[\s\S]*?\]\]/g, keep);
  const restore = h => h.replace(new RegExp(nonce + '(\\d+)' + nonce, 'g'),
    (_, i) => stickerTagToHtml(store[+i] ?? ''));
  const html = marked.parse(source, { breaks: true });
  if (typeof document === 'undefined') return restore(html);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // 用户正文里的 Markdown 图片不自动联网；图片请走应用本身的附件功能。
  tpl.content.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(img.alt || '')));
  tpl.content.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) {
      link.replaceWith(document.createTextNode(link.textContent || ''));
      return;
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  return restore(tpl.innerHTML);
}
// 渲染 AI 富文本：先把数学公式抠出来占位（防止 markdown 把 x_1 之类啃坏），
// 再跑表情标签 + marked，最后还原公式，交给 KaTeX auto-render 真正排版。
function renderRichText(raw) {
  const store = [];
  const nonce = _placeholderNonce();
  const keep = m => { store.push(m); return nonce + (store.length - 1) + nonce; };
  let s = String(raw || '')
    .replace(/\$\$([\s\S]+?)\$\$/g, keep)          // $$...$$ block
    .replace(/\\\[([\s\S]+?)\\\]/g, keep)          // \[...\] block
    .replace(/\\\(([\s\S]+?)\\\)/g, keep)          // \(...\) inline
    // $...$ inline: only when it contains a math char (\ ^ _ { }) to avoid matching currency like "$5 and $10"
    .replace(/\$([^\n$]*?[\\^_{}][^\n$]*?)\$/g, keep);
  s = stickerTagToHtml(s);
  let html = marked.parse(s);
  // 公式原样塞回会被当 HTML 解析（`$a<b$` 的 `<b` 成了标签，还能夹带 <img onerror>）。
  // 转义后 KaTeX 读的是 textContent，实体解回来一模一样。
  html = html.replace(new RegExp(nonce + '(\\d+)' + nonce, 'g'), (_, i) => escHtml(store[+i] ?? ''));
  return typeof gcSanitize === 'function' ? gcSanitize(html) : html;   // 测试沙箱里单抽这个函数时没有它；页面里同文件必在
}

// ── 渲染出口的消毒 ─────────────────────────────────────────────
// 模型的回复是当 HTML 渲染的（marked 不转义裸 HTML），以前一个字都没消：网页里一段提示注入
// 就能让模型吐出 <img src=x onerror=…>，在这个页面里执行 —— 而这个页面能调本地 server 的
// 电脑操控。不能在进 marked 之前把 < 一刀切转掉：processAiCommands 会把 App 自己的卡片
// （记忆折叠块、猫爪日报卡、onclick="openMoments()" 那种）**存进正文**，历史里全是。
// 所以在出口按 DOM 过一遍：
//   · 删整元素：script / iframe / object / embed / style / form / meta / base …
//   · 链接类属性只认 http(s) / mailto / tel / blob / 相对地址，图片另认 data:image
//   · 内联事件只留「调 App 自己的全局函数、参数全是字面量或 this」这种形状；
//     会自己触发的事件（onerror / onload / onmouseover …）再收紧到几个已知的
// 拿掉了什么都在控制台说一声（每种说一次）—— 哪张卡片的按钮哑了，先看这里。
const _GC_DROP_TAGS = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'BASE', 'META', 'LINK',
  'STYLE', 'FORM', 'NOSCRIPT', 'TEMPLATE', 'PORTAL', 'FOREIGNOBJECT', 'ANIMATE', 'SET', 'ANIMATETRANSFORM', 'ANIMATEMOTION', 'HANDLER', 'LISTENER']);
const _GC_URL_ATTR = /^(href|src|xlink:href|action|formaction|poster|background|data|codebase|cite|longdesc|lowsrc|dynsrc|ping|srcset)$/i;
const _GC_AUTO_EVENTS = /^on(error|load|loadstart|loadeddata|loadedmetadata|canplay\w*|play\w*|pause|ended|timeupdate|progress|animation\w+|transition\w+|focus\w*|blur|mouse(over|enter|out|leave|move)|pointer(over|enter|out|leave|move|rawupdate)|toggle|beforetoggle|scroll\w*|wheel|resize|begin|end|repeat|content\w+|selectstart|select|invalid|search|message|pageshow|pagehide|visibilitychange|show)$/i;
// 会自己触发的事件里只认这几个：图片挂了重试、点歌卡片进度条跟手
const _GC_AUTO_OK = new Set(['_stickerImgRetry', '_gazeImgFail', 'musicSeekMove']);
// 能被卡片点到、但落在模型手里就危险的：改服务器地址 / 配对码、删改数据、登出
const _GC_FN_DENY = /^(setServerBase|setPairToken\w*|rotatePairToken|delete\w*|remove\w*|clear\w*|wipe\w*|reset\w*|import\w*|restore\w*|logout|signOut|migrate\w*|eval|Function|fetch|open|setTimeout|setInterval)$/;
const _GC_STYLE_SET = /^this\.style\.[a-zA-Z]+\s*=\s*'[^'\\]*'$/;
// 老版本存进正文的折叠块是 this.parentElement.classList.toggle('open')，历史里还有
const _GC_CLASS_SET = /^this(\.parentElement)*\.classList\.(toggle|add|remove)\('[\w -]*'\)$/;
// 按顶层的 sep 切：引号里、括号里的不算（歌名里的 ; 和 , 、URL 里的 ; 都常见）
function _gcSplitTop(s, sep) {
  const out = []; let depth = 0, q = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { if (c === '`') return null; q = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { if (--depth < 0) return null; }
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  if (q || depth) return null;
  out.push(s.slice(start));
  return out.map(x => x.trim());
}
// 参数只能是「数据」：字面量（含 JSON 对象，点歌卡片传的就是整首歌的 JSON）、this 上的属性、event
function _gcArgOk(a) {
  if (/^(event|true|false|null|-?\d+(\.\d+)?)$/.test(a)) return true;
  if (/^this(?:\.[\w$]+|\('(?:[^'\\]|\\.)*'\))*$/.test(a)) return true;
  if (/^'(?:[^'\\]|\\.)*'$/.test(a)) return true;
  if (/^!?[A-Za-z_$][\w$]*$/.test(a)) return true;
  if (/^["{[]/.test(a)) { try { JSON.parse(a); return true; } catch (_) { return false; } }
  return false;
}
const _gcFnOk = {};
function _gcIsAppFn(name) {
  if (name in _gcFnOk) return _gcFnOk[name];
  let ok = false;
  try {
    const f = new Function('return typeof ' + name + ' === "function" ? ' + name + ' : null')();
    ok = !!f && !/\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f));
  } catch (_) { ok = false; }
  return (_gcFnOk[name] = ok);
}
function _gcHandlerOk(evName, value) {
  const auto = _GC_AUTO_EVENTS.test(evName);
  const stmts = (_gcSplitTop(String(value), ';') || [null]).filter(x => x !== '');
  if (!stmts.length || stmts.length > 4 || stmts.includes(null)) return false;
  for (const st of stmts) {
    if (/^event\.(stopPropagation|preventDefault)\(\)$/.test(st) || st === 'return false') continue;
    if (_GC_STYLE_SET.test(st) || _GC_CLASS_SET.test(st)) continue;
    const m = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(st);
    if (!m) return false;
    const args = m[2].trim() ? _gcSplitTop(m[2], ',') : [];
    if (!args || !args.every(_gcArgOk)) return false;
    const fn = m[1];
    if (_GC_FN_DENY.test(fn) || !_gcIsAppFn(fn)) return false;
    if (auto && !_GC_AUTO_OK.has(fn)) return false;
  }
  return true;
}
function _gcUrlOk(tag, attr, v) {
  const s = String(v).replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000\ufeff]/g, '');
  if (/^srcset$/i.test(attr)) return !/(javascript|vbscript|data):/i.test(s);
  const m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
  if (!m) return true;                                   // 相对地址、#锚点
  const sch = m[1].toLowerCase();
  if (sch === 'http' || sch === 'https' || sch === 'mailto' || sch === 'tel' || sch === 'blob') return true;
  if (sch === 'data' && /^src$/i.test(attr) && /^(IMG|SOURCE|VIDEO|AUDIO)$/.test(tag)
      && /^data:(image\/(png|jpe?g|gif|webp|avif|bmp)|audio\/|video\/)/i.test(s)) return true;
  return false;
}
const _gcWarned = new Set();
function _gcWarn(what) {
  if (_gcWarned.has(what) || _gcWarned.size > 200) return;
  _gcWarned.add(what);
  console.warn('[消毒] 拿掉了 ' + what);
}
// strict：外来内容（网页正文、代码卡片），一个内联事件都不留
function gcSanitize(html, opts) {
  if (typeof document === 'undefined' || !html) return html;
  const strict = !!(opts && opts.strict);
  const tpl = document.createElement('template');   // template 里的东西是惰性的：不加载图片、不触发 onerror
  tpl.innerHTML = html;
  const walk = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const drop = [];
  for (let el = walk.nextNode(); el; el = walk.nextNode()) {
    const tag = el.tagName.toUpperCase();
    if (_GC_DROP_TAGS.has(tag)) { drop.push(el); _gcWarn('<' + el.tagName.toLowerCase() + '>'); continue; }
    if (tag === 'USE') {
      const h = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (h && !h.startsWith('#')) { drop.push(el); _gcWarn('<use href=外部>'); continue; }
    }
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) {
        if (strict || !_gcHandlerOk(n, a.value)) { el.removeAttribute(a.name); _gcWarn(n + '="' + a.value.slice(0, 80) + '"'); }
      } else if (n === 'srcdoc' || n === 'http-equiv') {
        el.removeAttribute(a.name); _gcWarn(n);
      } else if ((n === 'id' || n === 'name') && /^(Grancyan|Android|electron|__)/i.test(a.value)) {
        // 元素 id 会变成 window 上的同名属性：<div id="GrancyanBand"> 能让 `window.GrancyanBand`
        // 这类「有没有安卓壳」的判断变真（桌面上音乐就去连手机的 8080 了）。
        // 只拦这几类「可能不存在、靠有没有来分岔」的名字 —— 学习卡片的 spellIn_xxx 这种 id 是要留的。
        el.removeAttribute(a.name); _gcWarn(n + '="' + a.value.slice(0, 40) + '"');
      } else if (_GC_URL_ATTR.test(n) && !_gcUrlOk(tag, n, a.value)) {
        el.removeAttribute(a.name); _gcWarn(n + '="' + a.value.slice(0, 60) + '"');
      }
    }
    if (tag === 'A' && (el.getAttribute('target') || '').toLowerCase() === '_blank') el.setAttribute('rel', 'noopener noreferrer');
  }
  drop.forEach(el => el.remove());
  return tpl.innerHTML;
}
// 流式正文也应立即呈现已经闭合的 Markdown（例如 **重点**），不必等整轮结束。
// 指令标签仍先遮挡，避免 AI 正在输入协议时把半截控制文字露给用户。
function renderStreamingRichText(raw) {
  return renderRichText(maskStreamingTags(String(raw || ''))) + '<span class="stream-cursor"></span>';
}
// 对已插入 DOM 的容器执行 KaTeX 排版（库未加载时静默跳过）
function typesetMath(el) {
  // 画图盒子也在这个时机画（要等进了 DOM 才量得到尺寸）。放在 KaTeX 的早退之前：
  // KaTeX 是 defer 加载的，没到时这里会直接 return，图就跟着不画了。
  if (el && typeof plotMountIn === 'function') { try { plotMountIn(el); } catch (e) {} }
  // 元素卡在周期表数据加载前画成了占位，这里补画（55-chem.js）
  if (el && typeof chemHydrate === 'function') { try { chemHydrate(el); } catch (e) {} }
  if (!el || typeof renderMathInElement !== 'function') return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch (e) {}
}
function hexAlpha(hex, a) {
  let h = hex.replace('#','');
  if (h.length === 3) h = h.split('').map(c => c+c).join('');
  const r = parseInt(h.slice(0,2),16);
  const g = parseInt(h.slice(2,4),16);
  const b = parseInt(h.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// QUOTE / REPLY
// ═══════════════════════════════════════════════════════
let _pendingQuotes = [];
let _selTarget    = null;

document.addEventListener('mouseup', e => {
  const btn = document.getElementById('floatReplyBtn');
  if (btn.contains(e.target)) return;
  // 右键（呼出复制菜单）和点消息操作按钮（⎘等）不算"点别处"——别把蓝色选区清掉
  if (e.button !== 0) return;
  if (e.target.closest('.msg-action-btn, #contextMenu')) return;
  const sel  = window.getSelection();
  const text = sel?.toString().trim();
  // 按钮已显示且选区还是刚才那段（点空白/按钮不会清除旧选区）→ 这是"点别处想关掉"，
  // 直接隐藏，不许按钮"飘"到鼠标新位置
  if (btn.style.display === 'block' && text === _selTarget) {
    btn.style.display = 'none';
    _selTarget = null;
    window.getSelection()?.removeAllRanges();
    return;
  }
  if (text && text.length > 2) {
    const anchor = sel.getRangeAt(0).commonAncestorContainer;
    const node   = anchor.nodeType === 3 ? anchor.parentElement : anchor;
    if (node.closest('.bubble, .resp-variant')) {
      _selTarget = text;
      btn.style.display = 'block';
      btn.style.top  = Math.max(8, e.clientY - 44) + 'px';
      btn.style.left = Math.min(parseInt(btn.style.left), window.innerWidth - 110) + 'px';
      btn.style.left = Math.max(8, e.clientX - 56) + 'px';
      return;
    }
  }
  if (!e.target.closest('#floatReplyBtn')) btn.style.display = 'none';
});

function insertQuote() {
  if (!_selTarget) return;
  // 从选区内往上找到所属消息的 nodeId
  const sel = window.getSelection();
  const anchor = sel?.getRangeAt(0).commonAncestorContainer;
  const el = anchor.nodeType === 3 ? anchor.parentElement : anchor;
  const group = el.closest('.msg-group');
  const sourceNodeId = group ? parseInt(group.dataset.nodeId) : null;

  _pendingQuotes.push({ text: _selTarget.slice(0, 200), sourceNodeId });
  _selTarget = null;
  document.getElementById('floatReplyBtn').style.display = 'none';
  window.getSelection()?.removeAllRanges();
  renderQuoteBar();
  document.getElementById('userInput').focus();
}

function clearQuote() {
  _pendingQuotes = [];
  renderQuoteBar();
}
// 返回 true = 真的找到并滚过去了；false = 这条消息当前没渲染（在别的分支上）。
// 调用方靠这个返回值区分「定位成功」和「静默什么都没发生」。
// 在一条消息里找被引用的那段原文，返回 Range；找不到给 null。
// 比对时忽略所有空白：引用是从选区复制出来的，跨段落会带 \n，而 DOM 里段落之间未必有文本节点，
// 按原样比就对不上。消息里自己挂着的引用条（.bubble-quote）不算，不然会亮到引用条上。
function _quoteRangeIn(root, quote) {
  const needle = String(quote || '').replace(/…$/, '').replace(/\s+/g, '');
  if (!root || !needle) return null;
  let flat = '';
  const at = [];   // flat 里第 i 个字 → [文本节点, 节点内偏移]
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const p = n.parentElement;
    if (p && p.closest('.bubble-quote, .msg-actions, script, style, button')) continue;
    const v = n.nodeValue;
    for (let i = 0; i < v.length; i++) {
      if (/\s/.test(v[i])) continue;
      flat += v[i]; at.push([n, i]);
    }
  }
  let idx = flat.indexOf(needle), len = needle.length;
  // 原消息后来被改过一点：退一步只认开头一截（同 scrollToQuotedText 的 12 字规则）
  if (idx < 0 && needle.length > 12) { idx = flat.indexOf(needle.slice(0, 12)); len = 12; }
  if (idx < 0) return null;
  const s = at[idx], e = at[idx + len - 1];
  try {
    const r = document.createRange();
    r.setStart(s[0], s[1]);
    r.setEnd(e[0], e[1] + 1);
    return r;
  } catch (_) { return null; }
}
let _quoteHlTimer = 0, _quoteHlDone = null;

// 在引用那段底下按行铺圆角色块。以前用 ::highlight，可它不认 border-radius，用户要圆角；
// 色块放进气泡里的一层 z-index:-1（气泡临时 isolate），画在字底下，字本身的颜色不动、DOM 文本不动。
// 量的是每个文本节点各自那一截的 rect：直接 range.getClientRects() 会把整段包进去的 <p>/<strong>
// 的整块盒子也吐出来，一整行宽的方块就冒出来了。
function _quoteMarkPaint(el, range) {
  if (_quoteHlDone) _quoteHlDone();
  const host = range.startContainer.parentElement?.closest('.bubble') || el;
  const prev = { position: host.style.position, isolation: host.style.isolation };
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.style.isolation = 'isolate';
  const layer = document.createElement('div');
  layer.className = 'gc-quote-mark';
  layer.dataset.text = range.toString();
  host.appendChild(layer);
  const paint = () => {
    const hr = host.getBoundingClientRect();
    const ox = hr.left + host.clientLeft, oy = hr.top + host.clientTop;
    const rects = [];
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!range.intersectsNode(n)) continue;
      const sub = document.createRange();
      sub.setStart(n, n === range.startContainer ? range.startOffset : 0);
      sub.setEnd(n, n === range.endContainer ? range.endOffset : n.nodeValue.length);
      for (const r of sub.getClientRects()) if (r.width > .5 && r.height > .5) rects.push(r);
    }
    // 同一行（竖向重叠过半）并成一块，免得加粗/斜体把一行切成几段各自圆角
    const lines = [];
    for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const L = lines.find(l => Math.min(l.b, r.bottom) - Math.max(l.t, r.top) > Math.min(l.b - l.t, r.height) / 2);
      if (L) { L.l = Math.min(L.l, r.left); L.r = Math.max(L.r, r.right); L.t = Math.min(L.t, r.top); L.b = Math.max(L.b, r.bottom); }
      else lines.push({ l: r.left, r: r.right, t: r.top, b: r.bottom });
    }
    layer.innerHTML = lines.map(l =>
      `<i style="left:${l.l - ox - 3}px;top:${l.t - oy - 1}px;width:${l.r - l.l + 6}px;height:${l.b - l.t + 2}px"></i>`).join('');
  };
  paint();
  requestAnimationFrame(() => layer.classList.add('on'));
  let gone = false;
  const done = _quoteHlDone = () => {
    if (gone) return; gone = true;
    if (_quoteHlDone === done) _quoteHlDone = null;
    layer.remove();
    host.style.position = prev.position; host.style.isolation = prev.isolation;
  };
  clearTimeout(_quoteHlTimer);
  _quoteHlTimer = setTimeout(() => { layer.classList.remove('on'); setTimeout(done, 350); }, 2200);
  return paint;
}

// quote：点的是引用条的话把原文带进来，只亮被引用的那一段；不给或找不到就整条闪一下
function scrollToMessage(nodeId, quote) {
  if (!nodeId) return false;
  // 先找 wrapper 再找 data-node-id：wrapper 开着 content-visibility:auto，
  // 它自己永远参与布局，滚动定位精确；里面的元素属于被跳过的子树，
  // 靠 scrollIntoView 触发「激活渲染」才量得准，各内核时机不一致。
  let el = document.querySelector('[data-msg-wrapper="' + nodeId + '"]');
  if (!el) el = document.querySelector('[data-node-id="' + nodeId + '"]');
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 只亮引用的那段：色块是气泡里临时挂的一层，文本节点一个字节都不动（不会冲掉渲染缓存、不踩选区）
  const range = quote ? _quoteRangeIn(el, quote) : null;
  if (range) {
    const repaint = _quoteMarkPaint(el, range);
    // 长消息比一屏还高时，居中的是整条，引用那段可能还在屏外 —— 等滚完再把那段拉进来
    setTimeout(() => {
      repaint();   // content-visibility 刚激活、字体晚到时第一次量的可能不准，滚完再量一遍
      const rc = range.getBoundingClientRect();
      if (rc.height && (rc.top < 0 || rc.bottom > window.innerHeight)) {
        range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 450);
    return true;
  }
  if (_quoteHlDone) _quoteHlDone();   // 上一处的色块还没消失就跳去别处了，别让它挂在那边
  // 高亮闪烁一下
  const msgGroup = el.querySelector?.('.msg-group') || el;
  msgGroup.style.transition = 'background 0.15s';
  msgGroup.style.background = 'var(--accent-soft)';
  setTimeout(() => { msgGroup.style.background = ''; }, 1500);
  return true;
}
// ═══════════════════════════════════════════════════════
// IMAGE UPLOAD
// ═══════════════════════════════════════════════════════
let _pendingImgs = [];let _pendingFiles = [];

/* ── 发给模型之前把图片缩到 768 长边 ──────────────────────────────
   一张 1910×896 的截图按 Anthropic 的算法是 w*h/750 ≈ 2280 token，缩到长边 768
   只剩 ~340 —— 省 85%。而且图片**留在历史里**：只要那条消息还在上下文里，
   每一轮都会重发一遍。一张没缩的截图聊 50 轮就是 11 万 token，全花在同一张图上。

   768 是 Anthropic 建议的上限（再大也不会看得更清，只是多收钱），和视频抽帧
   （30-video.js 的 targetW）用的是同一个数。

   ⚠️ 缩放要在**存进节点之前**做，不能只在发送时做：存原图的话，云同步、
   IndexedDB、导出备份全都跟着背这份体积。发送时那道（见 buildApiMessages）
   是给**历史里已经存下的老图**兜底的，两道都要有。 */
const IMG_API_MAX = 768;    // 长边上限
const IMG_API_Q   = 0.72;   // 和视频抽帧同一档质量
// 缩过的结果按原 dataURL 缓存：历史里的老图每轮都要走一遍，不缓存就是每轮重解码。
const _imgShrinkCache = new Map();

// 估这张图值多少 token（Anthropic: w*h/750）。拿不到尺寸就按经验值算一张 768 图。
function imgApiTokens(img) {
  if (img && img.w && img.h) return Math.round(img.w * img.h / 750);
  return 1230;   // 30-video.js 里那个 720p 一帧的经验值
}

/* 返回 { url, w, h }。已经够小的原样返回（只补尺寸），拿不到尺寸的原样放行 ——
   宁可漏缩一张，也不能因为解码失败把用户的图吃掉。 */
async function shrinkImgForApi(url) {
  if (!url || typeof url !== 'string') return { url, w: 0, h: 0 };
  const hit = _imgShrinkCache.get(url);
  if (hit) return hit;
  const out = await new Promise(res => {
    const im = new Image();
    let done = false;
    const fin = v => { if (!done) { done = true; res(v); } };
    im.onload = () => {
      const iw = im.naturalWidth, ih = im.naturalHeight;
      if (!iw || !ih) return fin({ url, w: 0, h: 0 });
      const long = Math.max(iw, ih);
      if (long <= IMG_API_MAX) return fin({ url, w: iw, h: ih });
      const k = IMG_API_MAX / long;
      const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        // 先铺白：透明 PNG 转 JPEG 时未填的像素会变成黑色，截图里的透明边
        // 会糊成一片黑，模型看到的和用户看到的不是一张图。
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(im, 0, 0, w, h);
        fin({ url: c.toDataURL('image/jpeg', IMG_API_Q), w, h });
      } catch (e) {
        fin({ url, w: iw, h: ih });   // canvas 被污染（跨域图）等情况：原样发
      }
    };
    im.onerror = () => fin({ url, w: 0, h: 0 });
    im.src = url;
    setTimeout(() => fin({ url, w: 0, h: 0 }), 8000);
  });
  if (_imgShrinkCache.size > 300) _imgShrinkCache.clear();   // 粗暴但够用，别让它无限长
  _imgShrinkCache.set(url, out);
  return out;
}

/* 所有「往输入框加一张图」的入口都走这里（选文件 / 拍照 / 粘贴 / 拖拽 / 视频抽帧）。
   分散着写的话，新加一个入口就漏一次缩放，而漏掉是**零征兆**的 —— 图照发、
   模型照看，只是每轮多烧两千 token，除非有人去量请求体，否则永远发现不了。
   额外字段（视频帧的 vidId/vidT 等）原样保留。 */
async function addPendingImg(obj) {
  const { url, w, h } = await shrinkImgForApi(obj.url);
  _pendingImgs.push({ ...obj, url, w, h });
  renderPendingImgs();
}
// 文本文件上传按钮处理
function handleTextFileUpload(input) {
  Array.from(input.files).forEach(file => {
    // 音频排最前：.m4a/.amr 这些可能被系统报成奇怪的 MIME，别让文本分支抢走（66-audio-attach.js）
    if (typeof isAudioFile === 'function' && isAudioFile(file)) {
      addAudioFile(file);
    } else if (isDocxFile(file.name)) {
      addDocFile(file);
    } else if (isTextFile(file.type) || isTextFileByName(file.name)) {
      const r = new FileReader();
      r.onload = e => { _pendingFiles.push({ name: file.name, content: e.target.result }); renderPendingFiles(); };
      r.readAsText(file);
    }
  });
  input.value = '';
}

// 打开文件查看器
let _viewedFile = { name: '', content: '' };
function openFileViewer(name, content) {
  _viewedFile = { name, content };
  document.getElementById('fileViewerName').textContent = name;
  document.getElementById('fileViewerBody').textContent = content;
  document.getElementById('fileViewerModal').classList.remove('hidden');
  document.getElementById('fileViewerModal').style.display = 'flex';
}

// 关闭文件查看器
function closeFileViewer() {
  document.getElementById('fileViewerModal').classList.add('hidden');
  document.getElementById('fileViewerModal').style.display = 'none';
}

// 下载当前查看的文件
function downloadViewedFile() {
  const blob = new Blob([_viewedFile.content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = _viewedFile.name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderQuoteBar() {
  const bar = document.getElementById('quotePrevBar');
  if (!_pendingQuotes.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  // 样式都在 css（.quote-chip* / .quote-clear-btn，附件托盘那段），这里只拼结构
  bar.innerHTML = `
    <span class="quote-ico">↩</span>
    <div class="quote-chips">
      ${_pendingQuotes.map((q,i) => {
        const s = typeof q === 'string' ? q : q.text;
        return `
        <span class="quote-chip" title="${escHtml(s)}">
          <span class="quote-chip-text">${escHtml(s.length > 40 ? s.slice(0,40)+'…' : s)}</span>
          <button class="quote-chip-x" onclick="_pendingQuotes.splice(${i},1);renderQuoteBar()" aria-label="去掉这条引用">×</button>
        </span>`;
      }).join('')}
    </div>
    <button class="quote-clear-btn" onclick="clearQuote()">清空</button>`;
}

function handleImgUpload(input) {
  Array.from(input.files).forEach(file => {
    // 视频走抽帧那条路（30-video.js），抽完的关键帧会回到 _pendingImgs 里，
    // 所以从这行往后的所有链路对它们来说和普通图片没有区别。
    // ⚠️ 判据用 isVideoFile 而不是 file.type：.mkv/.avi 的 MIME 常常是空的，
    // 只看 MIME 的话它们会被下一行的 return 悄悄吃掉，界面上毫无反应。
    // 第二个参数 = 「这里就是在选视频」：从这个选择框进来的 .ts 当 MPEG-TS。
    // 拖拽那条路不能这么认，那边 .ts 多半是 TypeScript 源码，见 isVideoFile 的注释。
    if (typeof isVideoFile === 'function' && isVideoFile(file, true)) {
      if (typeof addVideoFile === 'function') addVideoFile(file);
      return;
    }
    if (!file.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = e => { addPendingImg({ url: e.target.result, name: file.name }); };
    r.readAsDataURL(file);
  });
  input.value = '';
}

function renderPendingImgs() {
  const wrap = document.getElementById('imgPendingWrap');
  try { updateComposerBtns(); } catch {}   // 只带图不打字也得能发出去 → 发送按钮要露出来
  if (!_pendingImgs.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = _pendingImgs.map((img, i) => `
    <div class="img-pending-item">
      <img src="${img.url}">
      <button class="img-pending-rm" onclick="_pendingImgs.splice(${i},1);renderPendingImgs()">×</button>
    </div>`).join('');
}
function renderPendingFiles() {
  const wrap = document.getElementById('filePendingWrap');
  try { updateComposerBtns(); } catch {}
  if (!_pendingFiles.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = _pendingFiles.map((f, i) => `
    <div class="file-pending-item">
      <span class="fname">${escHtml(f.name)}</span>
      <span class="fsize">${f.loading ? escHtml(f.loadingText || '解析中...') : f.content.length + ' 字'}</span>
      ${f.loading && f.kind !== 'audio' ? '' : `<button class="file-pending-rm" onclick="_pendingFiles.splice(${i},1);renderPendingFiles()">×</button>`}
    </div>`).join('');
}
function addDocFile(file) {
  const placeholder = { name: file.name, content: '', loading: true };
  _pendingFiles.push(placeholder);
  renderPendingFiles();
  extractDocText(file).then(text => {
    placeholder.content = text;
    placeholder.loading = false;
    renderPendingFiles();
  }).catch(e => {
    // 占位可能已经不在了（比如被 × 掉）：indexOf 为 -1 时 splice(-1,1) 会删掉别的附件
    const i = _pendingFiles.indexOf(placeholder);
    if (i >= 0) _pendingFiles.splice(i, 1);
    renderPendingFiles();
    alert('文档解析失败: ' + e.message);
  });
}
document.getElementById('chatWindow').addEventListener('click', e => {
  if (_suppressImgClick) { _suppressImgClick = false; return; }   // 刚长按收藏过，别再弹放大
  if (e.target.classList.contains('msg-img') || e.target.classList.contains('sticker-msg'))
    openImgLightbox(e.target);
});

// 放大看图。顺手把「★ 收藏到表情库」按钮切到该图对应的状态（已收藏的显示 ✓）
function openImgLightbox(img) {
  const big = document.getElementById('lightboxImg');
  big.src = img.src;
  big.setAttribute('title', img.getAttribute('title') || '');
  big.setAttribute('alt', img.getAttribute('alt') || '');
  const btn = document.getElementById('lightboxFavBtn');
  if (btn) {
    const faved = typeof isGifFaved === 'function' && isGifFaved(img.src);
    btn.disabled = false;
    btn.classList.toggle('faved', faved);
    btn.textContent = faved ? '✓ 已在表情库' : '★ 收藏到表情库';
  }
  document.getElementById('imgLightbox').classList.remove('hidden');
}

// 手机上长按聊天里的图/表情 = 直接收藏进表情库（小圆 ★ 按钮在触屏上不好戳）
let _suppressImgClick = false;
(function initImgLongPressFav() {
  const win = document.getElementById('chatWindow');
  if (!win) return;
  let timer = null, startX = 0, startY = 0, target = null;
  const cancel = () => { clearTimeout(timer); timer = null; target = null; };
  win.addEventListener('touchstart', e => {
    const t = e.target;
    if (!(t.classList.contains('msg-img') || t.classList.contains('sticker-msg'))) return;
    if (!t.src) return;
    target = t;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      _suppressImgClick = true;
      if (navigator.vibrate) navigator.vibrate(15);
      favImgFromEl(target);
      target = null;
    }, 550);
  }, { passive: true });
  // 手指挪了 = 在滚页面，不是长按
  win.addEventListener('touchmove', e => {
    if (!timer) return;
    const dx = Math.abs(e.touches[0].clientX - startX), dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 10 || dy > 10) cancel();
  }, { passive: true });
  win.addEventListener('touchend', cancel, { passive: true });
  win.addEventListener('touchcancel', cancel, { passive: true });
})();

// ═══════════════════════════════════════════════════════
// STICKER SYSTEM / 表情包系统 (Tenor GIF 搜索 + 本地收藏)
// ═══════════════════════════════════════════════════════
let _stickerList = [];
// 标签栏现在是动态的：内建三栏（搜索/收藏/自带库）之后接「包」和用户自建的分组。
// 取值形态：'search' | 'fav' | 'lib' | 'pack:<包id>' | 'grp:<分组id>'
let _stickerTab = 'search';
// 磁盘上的包（stickers-packs/<id>/），由 loadPackStickers 和 _stickerList 同一轮原子写入
let _stickerPacks = [];
// 云端收藏这一路拉得成不成（见 loadCloudStickers）。以前它失败只 console.warn，
// 收藏栏就直接空了 —— 看着跟「收藏全丢了」一模一样，实际图都在桶里躺着。
// ok=false 时收藏栏顶上必须挂条子说明白，不许再静默。
let _cloudStickerState = { ok: true, reason: '', detail: '' };
// checkUser() 跑完没有。启动时 loadStickers() 先于登录检查触发，那一轮 currentUser 必然是 null，
// 不设这个标记的话每次开 App 打开表情栏都会闪一句「当前未登录」——真掉登录的提示会被当成噪音。
let _authChecked = false;
// 登录检查**失败**（getSession 自己抛了）时为 true。「查不出来」和「确认没登录」是两回事：
// 前者多半是网络/存储出问题，对着一个其实登录着的人说「当前未登录」是在撒谎，
// 而且会把她引去重新登录——错误的修复动作。这两种情况 banner 的说法必须分开。
let _authCheckFailed = false;
const IS_APP = location.hostname === 'grancyan.app'; // 运行在 Android 壳应用里
const STICKER_BUCKET = 'stickers';

// 三个来源合并：云端(Supabase) > 本地服务器(server.js) > APK 内置(assets)，同名去重
