// ============================================================
// 学习工具箱 ②：元素周期表 + 分子 3D 模型，以及聊天里的 [[ELEM: Fe]] / [[MOL: 乙醇]]
//
// 数据都是生成物（scripts/build-labdata.js → js/labdata/*.js），第一次用到才加载：
//   · 周期表 28KB：Periodic-Table-JSON（CC BY-SA 3.0）+ 这边补的中文名/拼音/化合价
//   · 分子 150KB：PubChem 预取的 58 个高中常见分子（离线能看）；表外的现查 PubChem
//   · 3D 渲染：3Dmol.js（BSD-3，js/lib/3Dmol-min.js 540KB）
// 晶体（NaCl、CsCl、金刚石、石墨）PubChem 没有，这里按晶胞参数现算坐标。
//
// 两个标签都是**纯渲染**：没有副作用，不进 processAiCommands，挂在 stickerTagToHtml 上。
// 聊天里的分子卡**不**直接放 3D：每个 3D 视图占一个 WebGL 上下文，浏览器同时只给十几个，
// 翻长对话会把前面的挤掉（黑屏、零报错）。卡片上是结构式图，点开才进 3D 面板。
// ============================================================

const CHEM_CAT = {
  alkali: { zh: '碱金属', c: '#ff8a65' },
  alkaline: { zh: '碱土金属', c: '#ffb74d' },
  transition: { zh: '过渡金属', c: '#e0c168' },
  post: { zh: '主族金属', c: '#9ccc65' },
  metalloid: { zh: '类金属', c: '#4db6ac' },
  nonmetal: { zh: '非金属', c: '#64b5f6' },
  noble: { zh: '稀有气体', c: '#b39ddb' },
  lanthanide: { zh: '镧系', c: '#f48fb1' },
  actinide: { zh: '锕系', c: '#ce93d8' },
  unknown: { zh: '性质未知', c: '#90a4ae' }
};

// ── 懒加载 ───────────────────────────────────────────────────
const _chemLoads = {};
function _chemScript(src, test) {
  if (test()) return Promise.resolve();
  if (_chemLoads[src]) return _chemLoads[src];
  _chemLoads[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (test() ? resolve() : reject(new Error(src + ' 加载了但没东西')));
    s.onerror = () => { delete _chemLoads[src]; reject(new Error(src + ' 加载失败')); };
    document.head.appendChild(s);
  });
  return _chemLoads[src];
}
const chemLoadElements = () => _chemScript('./js/labdata/elements.js', () => typeof LAB_ELEMENTS !== 'undefined');
const chemLoadMolecules = () => _chemScript('./js/labdata/molecules.js', () => typeof LAB_MOLECULES !== 'undefined');
const chemLoad3Dmol = () => _chemScript('./js/lib/3Dmol-min.js', () => typeof $3Dmol !== 'undefined');

function _chemEsc(s) {
  return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 符号 / 中文名 / 英文名 / 原子序数 → 元素。大小写不敏感，但 Co 和 CO 这种由调用方自己分清
function chemFindElement(q, list) {
  const L = list || (typeof LAB_ELEMENTS !== 'undefined' ? LAB_ELEMENTS : []);
  const s = String(q == null ? '' : q).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return L[Number(s) - 1] || null;
  return L.find(e => e.s === s) || L.find(e => e.zh === s) || L.find(e => e.s.toLowerCase() === s.toLowerCase())
    || L.find(e => e.en.toLowerCase() === s.toLowerCase()) || null;
}

// ── 玻尔模型小图（电子层 + 电子数）────────────────────────────
function chemBohrSvg(el, size) {
  const sh = (el && el.sh) || [];
  const W = size || 150, c = W / 2;
  const n = sh.length || 1;
  const r0 = W * 0.1, step = (W / 2 - r0 - 6) / n;
  let s = '<svg class="chem-bohr" viewBox="0 0 ' + W + ' ' + W + '" width="' + W + '" height="' + W + '">';
  s += '<circle cx="' + c + '" cy="' + c + '" r="' + r0 + '" fill="' + (CHEM_CAT[el.cat] || CHEM_CAT.unknown).c + '" opacity=".85"/>';
  s += '<text x="' + c + '" y="' + (c + 4) + '" text-anchor="middle" font-size="' + Math.round(r0 * 0.9) + '" fill="#111" font-weight="700">' + _chemEsc(el.s) + '</text>';
  sh.forEach((cnt, i) => {
    const r = r0 + step * (i + 1);
    s += '<circle cx="' + c + '" cy="' + c + '" r="' + r.toFixed(1) + '" fill="none" stroke="rgba(180,190,210,.35)" stroke-width="1"/>';
    const k = Math.min(cnt, 32);
    for (let j = 0; j < k; j++) {
      const a = -Math.PI / 2 + j * 2 * Math.PI / k;
      s += '<circle cx="' + (c + r * Math.cos(a)).toFixed(1) + '" cy="' + (c + r * Math.sin(a)).toFixed(1) + '" r="' + (k > 18 ? 1.6 : 2.3) + '" fill="#7cc4ff"/>';
    }
  });
  return s + '</svg>';
}

// ── 周期表面板 ───────────────────────────────────────────────
let _ptSel = 0, _ptMode = 'cat';

function openPeriodic(q) {
  const modal = document.getElementById('periodicModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const body = document.getElementById('ptBody');
  if (body && !body.innerHTML) body.innerHTML = '<div class="chem-wait">周期表加载中…</div>';
  chemLoadElements().then(() => {
    const e = chemFindElement(q);
    if (e) _ptSel = e.n;
    ptRender();
  }).catch(err => { if (body) body.innerHTML = '<div class="chem-wait">' + _chemEsc(err.message) + '</div>'; });
}
function closePeriodic() {
  const m = document.getElementById('periodicModal');
  if (m) m.classList.add('hidden');
}
function ptSetMode(m) { _ptMode = m === 'eneg' ? 'eneg' : 'cat'; ptRender(); }
function ptPick(n) { _ptSel = Number(n) || 0; ptRender(); }
function ptSearch(v) {
  const e = chemFindElement(v);
  if (e) { _ptSel = e.n; ptRender(); }
}

function _ptColor(e) {
  if (_ptMode === 'eneg') {
    if (e.eneg == null) return '#3a3f4a';
    // 0.7 → 4.0 蓝到橙
    const t = Math.max(0, Math.min(1, (e.eneg - 0.7) / 3.3));
    const hue = 210 - 180 * t;
    return 'hsl(' + hue.toFixed(0) + ',65%,58%)';
  }
  return (CHEM_CAT[e.cat] || CHEM_CAT.unknown).c;
}

function ptRender() {
  const body = document.getElementById('ptBody');
  if (!body || typeof LAB_ELEMENTS === 'undefined') return;
  let h = '<div class="pt-grid">';
  for (const e of LAB_ELEMENTS) {
    const row = e.y >= 9 ? e.y + 0.4 : e.y;       // 镧系锕系下面空半行
    h += '<button type="button" class="pt-cell' + (e.n === _ptSel ? ' on' : '') + '" style="grid-column:' + e.x
      + ';grid-row:' + Math.round(row * 10) + ' / span 10;--pc:' + _ptColor(e) + '" onclick="ptPick(' + e.n + ')" title="'
      + _chemEsc(e.n + ' ' + e.zh + ' ' + e.s) + '"><small>' + e.n + '</small><b>' + _chemEsc(e.s) + '</b><i>' + _chemEsc(e.zh) + '</i></button>';
  }
  // 主表里镧系锕系的位置放个占位
  h += '<div class="pt-gap" style="grid-column:3;grid-row:60 / span 10">57-71</div>';
  h += '<div class="pt-gap" style="grid-column:3;grid-row:70 / span 10">89-103</div>';
  h += '</div>';
  // 图例
  if (_ptMode === 'cat') {
    h += '<div class="pt-legend">' + Object.keys(CHEM_CAT).map(k => '<span><i style="background:' + CHEM_CAT[k].c + '"></i>' + CHEM_CAT[k].zh + '</span>').join('') + '</div>';
  } else {
    h += '<div class="pt-legend"><span><i style="background:hsl(210,65%,58%)"></i>电负性小（易失电子）</span><span><i style="background:hsl(30,65%,58%)"></i>电负性大（易得电子）</span><span><i style="background:#3a3f4a"></i>没有数据</span></div>';
  }
  const e = LAB_ELEMENTS[_ptSel - 1];
  h += '<div class="pt-detail">' + (e ? _ptDetail(e) : '<div class="chem-wait">点一个元素看详情</div>') + '</div>';
  h += '<div class="chem-credit">数据：Periodic-Table-JSON（CC BY-SA 3.0，取自维基百科）；中文名、化合价、常用相对原子质量为补充</div>';
  body.innerHTML = h;
  const modeSel = document.getElementById('ptMode');
  if (modeSel) modeSel.value = _ptMode;
}

function _ptDetail(e) {
  const row = (k, v) => (v === '' || v == null ? '' : '<div class="pt-kv"><span>' + k + '</span><b>' + v + '</b></div>');
  const cat = CHEM_CAT[e.cat] || CHEM_CAT.unknown;
  return '<div class="pt-detail-head">' + chemBohrSvg(e, 132)
    + '<div class="pt-detail-name"><div class="pt-big" style="color:' + cat.c + '">' + _chemEsc(e.s) + '</div>'
    + '<div>' + e.n + ' · ' + _chemEsc(e.zh) + (e.py ? '（' + _chemEsc(e.py) + '）' : '') + ' · ' + _chemEsc(e.en) + '</div>'
    + '<div class="pt-cat" style="border-color:' + cat.c + ';color:' + cat.c + '">' + cat.zh + ' · 第 ' + e.p + ' 周期' + (e.g ? ' · 第 ' + e.g + ' 列' : '') + ' · ' + _chemEsc(e.bl) + ' 区</div>'
    + '<button type="button" class="apply-btn pt-ask" onclick="ptAskAi(' + e.n + ')">问 AI 这个元素</button></div></div>'
    + '<div class="pt-kvs">'
    + row('相对原子质量', e.m + (e.mc != null ? '（课本常用 ' + e.mc + '）' : ''))
    + row('电子排布', _chemEsc(e.cfg) + (e.pred ? '（预测）' : ''))
    + row('各层电子数', e.sh.join(', '))
    + row('常见化合价', _chemEsc(e.v))
    + row('电负性', e.eneg == null ? '—' : e.eneg)
    + row('常温状态', e.ph ? e.ph + '态' : '')
    + row('熔点', e.mp == null ? '' : e.mp + ' ℃')
    + row('沸点', e.bp == null ? '' : e.bp + ' ℃')
    + row('密度', e.d == null ? '' : e.d + (e.ph === '气' ? ' g/L' : ' g/cm³'))
    + '</div>';
}

function ptAskAi(n) {
  const e = typeof LAB_ELEMENTS !== 'undefined' ? LAB_ELEMENTS[Number(n) - 1] : null;
  if (!e) return;
  _chemFillInput('讲讲' + e.zh + '（' + e.s + '）这个元素：');
  closePeriodic();
}

// 只填进输入框，不替她发 —— 问什么、发不发是她的事
function _chemFillInput(text) {
  const input = document.getElementById('userInput');
  if (!input) return;
  input.value = text;
  try { autoResize(input); } catch (e) {}
  try { updateInputTokenEstimate(); } catch (e) {}
  try { updateComposerBtns(); } catch (e) {}
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
}

// ── 晶体：按晶胞现算坐标（XYZ 格式喂给 3Dmol）─────────────────
const CHEM_CRYSTALS = [
  { zh: '氯化钠晶体', key: 'nacl', note: '面心立方，每个 Na⁺ 周围 6 个 Cl⁻', ionic: true },
  { zh: '氯化铯晶体', key: 'cscl', note: '体心立方，每个 Cs⁺ 周围 8 个 Cl⁻', ionic: true },
  { zh: '金刚石', key: 'diamond', note: '每个 C 和 4 个 C 成正四面体，空间网状', ionic: false },
  { zh: '石墨', key: 'graphite', note: '层内六元环，层间靠范德华力', ionic: false }
];

function chemCrystalXyz(key) {
  const atoms = [];
  const add = (el, x, y, z) => atoms.push(el + ' ' + x.toFixed(3) + ' ' + y.toFixed(3) + ' ' + z.toFixed(3));
  if (key === 'nacl') {
    const a = 5.64;
    for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) for (let k = 0; k <= 2; k++)
      add((i + j + k) % 2 ? 'Cl' : 'Na', i * a / 2, j * a / 2, k * a / 2);
  } else if (key === 'cscl') {
    const a = 4.12;
    for (let i = 0; i <= 1; i++) for (let j = 0; j <= 1; j++) for (let k = 0; k <= 1; k++) add('Cl', i * a, j * a, k * a);
    add('Cs', a / 2, a / 2, a / 2);
  } else if (key === 'diamond') {
    const a = 3.567, eps = 1e-6;
    const fcc = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]];
    const seen = new Set();
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      for (const b of [[0, 0, 0], [.25, .25, .25]]) for (const f of fcc) {
        const x = i + f[0] + b[0], y = j + f[1] + b[1], z = k + f[2] + b[2];
        if (x < -eps || y < -eps || z < -eps || x > 1 + eps || y > 1 + eps || z > 1 + eps) continue;
        const id = [x, y, z].map(v => v.toFixed(3)).join();
        if (seen.has(id)) continue;
        seen.add(id);
        add('C', x * a, y * a, z * a);
      }
    }
  } else if (key === 'graphite') {
    const d = 1.42, c = 3.35;
    for (let layer = 0; layer < 2; layer++) {
      const off = layer ? d : 0;           // AB 堆积：第二层错开一个键长
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
        const bx = i * 1.5 * d, by = (j + (i % 2 ? 0.5 : 0)) * Math.sqrt(3) * d;
        for (const [px, py] of [[0, 0], [d, 0]]) {
          const x = bx + px + off, y = by + py;
          if (Math.hypot(x - off, y) > 6.2) continue;
          add('C', x, y, layer * c);
        }
      }
    }
  }
  return atoms.length + '\n' + key + '\n' + atoms.join('\n') + '\n';
}

// ── 分子面板 ─────────────────────────────────────────────────
let _molViewer = null, _molStyle = 'ballstick', _molLabels = false, _molSpin = true, _molCur = null;

function chemFindMolecule(q) {
  const s = String(q == null ? '' : q).trim();
  if (!s || typeof LAB_MOLECULES === 'undefined') return null;
  const low = s.toLowerCase();
  return LAB_MOLECULES.find(m => m.zh === s) || LAB_MOLECULES.find(m => m.q.toLowerCase() === low)
    || LAB_MOLECULES.find(m => m.zh.replace(/\s/g, '') === s.replace(/\s/g, '')) || null;
}

function openMolecules(q, en) {
  const modal = document.getElementById('molModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const list = document.getElementById('molList');
  if (list && !list.innerHTML) list.innerHTML = '<div class="chem-wait">加载中…</div>';
  Promise.all([chemLoadMolecules(), chemLoad3Dmol()]).then(() => {
    molRenderList();
    const want = q || (_molCur && _molCur.zh) || '水';
    molShow(want, en);
  }).catch(err => { if (list) list.innerHTML = '<div class="chem-wait">' + _chemEsc(err.message) + '</div>'; });
}
function closeMolecules() {
  const m = document.getElementById('molModal');
  if (m) m.classList.add('hidden');
  if (_molViewer) { try { _molViewer.spin(false); } catch (e) {} }
}

function molRenderList() {
  const list = document.getElementById('molList');
  if (!list || typeof LAB_MOLECULES === 'undefined') return;
  const groups = {};
  for (const m of LAB_MOLECULES) (groups[m.g] = groups[m.g] || []).push(m);
  let h = '';
  for (const g of Object.keys(groups)) {
    h += '<div class="mol-group"><div class="mol-group-t">' + _chemEsc(g) + '</div>'
      + groups[g].map(m => '<button type="button" class="mol-chip' + (_molCur && _molCur.zh === m.zh ? ' on' : '') + '" onclick="molShow(' + _chemEsc(JSON.stringify(m.zh)) + ')">' + _chemEsc(m.zh) + '</button>').join('') + '</div>';
  }
  h += '<div class="mol-group"><div class="mol-group-t">晶体</div>'
    + CHEM_CRYSTALS.map(c => '<button type="button" class="mol-chip' + (_molCur && _molCur.zh === c.zh ? ' on' : '') + '" onclick="molShow(' + _chemEsc(JSON.stringify(c.zh)) + ')">' + _chemEsc(c.zh) + '</button>').join('') + '</div>';
  list.innerHTML = h;
}

function molSearch(v) {
  const s = String(v || '').trim();
  if (s) molShow(s, /^[\x20-\x7e]+$/.test(s) ? s : '');
}

// 表外的分子现查 PubChem（只认英文名；中文名 PubChem 基本查不到）。查到的缓存在内存里
const _molNet = new Map();
async function _molFetch(en) {
  const key = String(en).toLowerCase();
  if (_molNet.has(key)) return _molNet.get(key);
  const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' + encodeURIComponent(en);
  const get = async u => { const r = await fetch(u); return r.ok ? r.text() : null; };
  let sdf = await get(base + '/SDF?record_type=3d'), dim = 3;
  if (!sdf) { sdf = await get(base + '/SDF?record_type=2d'); dim = 2; }
  if (!sdf) return null;
  let f = '', cid = 0;
  try { const p = JSON.parse(await get(base + '/property/MolecularFormula/JSON')).PropertyTable.Properties[0]; f = p.MolecularFormula || ''; cid = p.CID || 0; } catch (e) {}
  const m = { zh: en, q: en, g: '现查', f, cid, dim, sdf: sdf.split('$$$$')[0].trim() + '\n$$$$\n' };
  _molNet.set(key, m);
  return m;
}

async function molShow(q, en) {
  const info = document.getElementById('molInfo');
  const host = document.getElementById('molViewer');
  if (!host) return;
  let mol = chemFindMolecule(q);
  const cry = CHEM_CRYSTALS.find(c => c.zh === q || c.key === q);
  if (!mol && !cry) {
    const eng = en || (/^[\x20-\x7e]+$/.test(String(q || '')) ? q : '');
    if (!eng) {
      if (info) info.innerHTML = '<b>' + _chemEsc(q) + '</b> 不在离线表里。表外的分子要用英文名查（PubChem 认的通用名，比如 ibuprofen）。';
      return;
    }
    if (info) info.innerHTML = '在 PubChem 上查 <b>' + _chemEsc(eng) + '</b>…';
    try { mol = await _molFetch(eng); } catch (e) { mol = null; }
    if (!mol) { if (info) info.innerHTML = 'PubChem 上没查到 <b>' + _chemEsc(eng) + '</b>（名字要英文通用名；也可能是网络不通）'; return; }
    if (q && q !== eng) mol = Object.assign({}, mol, { zh: q });
  }
  _molCur = cry ? { zh: cry.zh, crystal: cry } : mol;
  molRenderList();
  if (!_molViewer) {
    host.innerHTML = '';
    _molViewer = $3Dmol.createViewer(host, { backgroundColor: '#14161b', antialias: true });
  }
  const v = _molViewer;
  v.clear();
  if (cry) {
    v.addModel(chemCrystalXyz(cry.key), 'xyz');
  } else {
    v.addModel(mol.sdf, 'sdf');
  }
  _molApplyStyle();
  v.zoomTo();
  v.zoom(1.35);        // zoomTo 留的边太宽，小分子在画面里只有一小团
  v.render();
  try { v.spin(_molSpin ? 'y' : false, 0.6); } catch (e) {}
  if (info) {
    if (cry) info.innerHTML = '<b>' + _chemEsc(cry.zh) + '</b> · ' + _chemEsc(cry.note) + '<small>坐标按晶胞参数算的示意，只画了一两个晶胞</small>';
    else info.innerHTML = '<b>' + _chemEsc(mol.zh) + '</b>' + (mol.f ? ' · ' + _chemFormula(mol.f) : '')
      + (mol.zh !== mol.q ? ' · <span class="mol-en">' + _chemEsc(mol.q) + '</span>' : '')
      + (mol.dim === 2 ? '<small>PubChem 没有它的 3D 构象，这是平面结构</small>' : '')
      + '<button type="button" class="apply-btn mol-ask" onclick="molAskAi()">问 AI</button>';
  }
}

// C6H12O6 → C₆H₁₂O₆
function _chemFormula(f) {
  const sub = '₀₁₂₃₄₅₆₇₈₉';
  return _chemEsc(String(f).replace(/\d/g, d => sub[+d]));
}

function _molApplyStyle() {
  const v = _molViewer;
  if (!v) return;
  const ionic = _molCur && _molCur.crystal && _molCur.crystal.ionic;
  const st = {
    ballstick: { stick: { radius: 0.14, colorscheme: 'Jmol' }, sphere: { scale: 0.26, colorscheme: 'Jmol' } },
    fill: { sphere: { colorscheme: 'Jmol' } },
    stick: { stick: { radius: 0.2, colorscheme: 'Jmol' } },
    line: { line: { colorscheme: 'Jmol', linewidth: 2 } }
  }[_molStyle];
  // 离子晶体没有共价键，按球棍画只剩一堆小球 —— 球放大一点，让配位关系看得出来
  v.setStyle({}, ionic && _molStyle === 'ballstick' ? { sphere: { scale: 0.45, colorscheme: 'Jmol' } } : st);
  v.removeAllLabels();
  if (_molLabels) {
    v.addPropertyLabels('elem', {}, { fontColor: 'white', fontSize: 12, showBackground: false, alignment: 'center', inFront: true });
  }
  v.render();
}

function molSetStyle(s) {
  if (!['ballstick', 'fill', 'stick', 'line'].includes(s)) return;
  _molStyle = s;
  document.querySelectorAll('.mol-style').forEach(b => b.classList.toggle('on', b.dataset.s === s));
  _molApplyStyle();
}
function molToggleLabels() {
  _molLabels = !_molLabels;
  const b = document.getElementById('molLabelBtn');
  if (b) b.classList.toggle('on', _molLabels);
  _molApplyStyle();
}
function molToggleSpin() {
  _molSpin = !_molSpin;
  const b = document.getElementById('molSpinBtn');
  if (b) b.classList.toggle('on', _molSpin);
  if (_molViewer) { try { _molViewer.spin(_molSpin ? 'y' : false, 0.6); } catch (e) {} }
}
function molAskAi() {
  if (!_molCur) return;
  _chemFillInput('讲讲' + _molCur.zh + '的结构：');
  closeMolecules();
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { if (_molViewer) { try { _molViewer.resize(); _molViewer.render(); } catch (e) {} } });
}

// ── 聊天里的标签 ──────────────────────────────────────────────
// [[ELEM: Fe]]、[[ELEM: 铁]]、[[ELEM: 26]]
// [[MOL: 乙醇]]、[[MOL: 布洛芬 | ibuprofen]]（表外的分子要带英文名，PubChem 才查得到）
function chemTagRe() { return /\[\[(ELEM|MOL):\s*([^\]|]{1,40}?)\s*(?:\|\s*([^\]]{1,60}?)\s*)?\]\]/g; }

function chemTagToHtml(text) {
  if (!text || (text.indexOf('[[ELEM') < 0 && text.indexOf('[[MOL') < 0)) return text;
  return String(text).replace(chemTagRe(), (m, kind, a, b) => {
    const q = String(a).trim(), en = String(b || '').trim();
    if (kind === 'ELEM') {
      // 标签里只存名字，卡片内容在渲染时按数据画；数据没加载就先画个能点的占位，加载完 typesetMath 那边会补
      const e = typeof LAB_ELEMENTS !== 'undefined' ? chemFindElement(q) : null;
      if (e) {
        const cat = CHEM_CAT[e.cat] || CHEM_CAT.unknown;
        return '<button type="button" class="chem-card chem-elem" style="--pc:' + cat.c + '" onclick="openPeriodic(' + _chemEsc(JSON.stringify(e.s)) + ')">'
          + '<span class="chem-elem-tile"><small>' + e.n + '</small><b>' + _chemEsc(e.s) + '</b><i>' + _chemEsc(e.zh) + '</i></span>'
          + '<span class="chem-card-txt"><b>' + _chemEsc(e.zh) + ' · ' + cat.zh + '</b><small>' + _chemEsc(e.cfg) + ' · ' + (e.mc != null ? e.mc : e.m) + '</small></span></button>';
      }
      return '<button type="button" class="chem-card chem-elem chem-pending" data-elem="' + _chemEsc(q) + '" onclick="openPeriodic(' + _chemEsc(JSON.stringify(q)) + ')">'
        + '<span class="chem-card-txt"><b>⚛ ' + _chemEsc(q) + '</b><small>点开看元素周期表</small></span></button>';
    }
    // MOL：结构式图用 PubChem 的 PNG（白底，CSS 里反色成深色）；拿不到图也不影响点开 3D
    const mol = typeof LAB_MOLECULES !== 'undefined' ? chemFindMolecule(q) : null;
    const img = mol && mol.cid
      ? 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/' + mol.cid + '/PNG?image_size=240x180'
      : (en ? 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' + encodeURIComponent(en) + '/PNG?image_size=240x180' : '');
    const args = _chemEsc(JSON.stringify(q)) + (en ? ',' + _chemEsc(JSON.stringify(en)) : '');
    // 分子表还没加载（她这次还没开过分子面板）：先画成占位，chemHydrate 加载完再补上结构式和分子式
    const pending = typeof LAB_MOLECULES === 'undefined' && !en;
    return '<button type="button" class="chem-card chem-mol' + (pending ? ' chem-pending" data-mol="' + _chemEsc(q) : '') + '" onclick="openMolecules(' + args + ')">'
      + (img ? '<img class="chem-mol-img" src="' + _chemEsc(img) + '" alt="' + _chemEsc(q) + ' 的结构式" loading="lazy">' : '')
      + '<span class="chem-card-txt"><b>🧊 ' + _chemEsc(q) + (mol && mol.f ? ' · ' + _chemFormula(mol.f) : '') + '</b><small>点开转着看 3D 模型</small></span></button>';
  });
}

// 回填：标签就是正确写法，原样留着（历史就是教材）。这里不需要改写。
// 流式：写一半的 [[ELEM / [[MOL 遮住
function maskStreamingChem(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  return String(text).replace(chemTagRe(), (m, kind) => (kind === 'ELEM' ? '〔⚛〕' : '〔🧊〕'))
    .replace(/\[\[(?:ELEM|MOL)\b[^\]]*$/, '〔…〕');
}

// 元素卡在数据加载前画成了占位：数据一到，页面上的占位全部重画一遍
// 分子卡同理（分子表 150KB，只在对话里真有分子卡时才加载）
function chemHydrate(root) {
  if (!root || !root.querySelectorAll) return;
  const pe = root.querySelectorAll('.chem-pending[data-elem]');
  if (pe.length) {
    chemLoadElements().then(() => {
      pe.forEach(el => {
        const html = chemTagToHtml('[[ELEM: ' + el.getAttribute('data-elem') + ']]');
        if (html.indexOf('chem-pending') < 0) el.outerHTML = html;
      });
    }).catch(() => {});
  }
  const pm = root.querySelectorAll('.chem-pending[data-mol]');
  if (pm.length) {
    chemLoadMolecules().then(() => {
      pm.forEach(el => {
        const html = chemTagToHtml('[[MOL: ' + el.getAttribute('data-mol') + ']]');
        if (html.indexOf('chem-pending') < 0) el.outerHTML = html;
      });
    }).catch(() => {});
  }
}
