// ============================================================
// 学习工具箱 ③：PhET 交互实验（科罗拉多大学，CC BY 4.0）+ 聊天里的 [[SIM: 抛体运动]]
//
// 每个实验是一个几 MB 的单文件 HTML，简体中文版。离线副本放在 labkit/phet/
// （node scripts/fetch-phet.js 下载；不进 git、不进 exe、不进 APK，由电脑后端当静态文件发）。
// 电脑后端上有就用电脑上的，没有退回 PhET 官网（国内能直连，只是慢一点）。
// 「有没有」靠 labkit/phet/manifest.js 判断：它是 <script> 加载的，跨源也不受 CORS 管
// （手机 APK 的页面源和电脑后端不是同一个源，fetch 探测会被挡）。
//
// ⚠️ 这份清单是唯一来源：下载脚本也读它（vm 跑这个文件取 LAB_SIMS），别在别处再抄一份。
// ============================================================

const LAB_SIMS = [
  { id: 'projectile-motion', zh: '抛体运动', g: '物理', note: '平抛、斜抛，调角度和初速度看射程' },
  { id: 'forces-and-motion-basics', zh: '力与运动：基础', g: '物理', note: '合力、摩擦力、牛顿第一第二定律' },
  { id: 'collision-lab', zh: '碰撞实验室', g: '物理', note: '动量守恒，弹性和非弹性碰撞' },
  { id: 'energy-skate-park-basics', zh: '能量滑板公园', g: '物理', note: '动能、势能相互转化，机械能守恒' },
  { id: 'pendulum-lab', zh: '单摆实验室', g: '物理', note: '摆长、重力加速度和周期的关系' },
  { id: 'masses-and-springs', zh: '质量与弹簧', g: '物理', note: '胡克定律、简谐振动' },
  { id: 'gravity-and-orbits', zh: '重力与轨道', g: '物理', note: '万有引力、卫星轨道' },
  { id: 'wave-on-a-string', zh: '弦上的波', g: '物理', note: '波长、频率、振幅，反射和驻波' },
  { id: 'bending-light', zh: '光的折射', g: '物理', note: '折射定律、全反射、临界角' },
  { id: 'geometric-optics', zh: '几何光学', g: '物理', note: '透镜成像、物距像距' },
  { id: 'charges-and-fields', zh: '电荷与电场', g: '物理', note: '点电荷的电场线和等势面' },
  { id: 'circuit-construction-kit-dc', zh: '电路搭建：直流', g: '物理', note: '串联并联、欧姆定律，自己连电路' },
  { id: 'faradays-electromagnetic-lab', zh: '法拉第电磁实验室', g: '物理', note: '电磁感应、楞次定律、发电机' },
  { id: 'gas-properties', zh: '气体性质', g: '物理', note: '压强、体积、温度，理想气体' },
  { id: 'states-of-matter', zh: '物质的状态', g: '化学', note: '固液气三态的分子运动、相变' },
  { id: 'build-an-atom', zh: '构建原子', g: '化学', note: '质子、中子、电子，原子序数和质量数' },
  { id: 'isotopes-and-atomic-mass', zh: '同位素与原子质量', g: '化学', note: '同位素丰度和相对原子质量' },
  { id: 'molecule-shapes', zh: '分子形状', g: '化学', note: '价层电子对互斥理论（VSEPR），键角' },
  { id: 'balancing-chemical-equations', zh: '配平化学方程式', g: '化学', note: '原子守恒，配平练习' },
  { id: 'reactants-products-and-leftovers', zh: '反应物与剩余物', g: '化学', note: '限量反应物、过量计算' },
  { id: 'concentration', zh: '溶液浓度', g: '化学', note: '溶质、溶剂、饱和溶液' },
  { id: 'molarity', zh: '物质的量浓度', g: '化学', note: 'c = n / V，稀释和配溶液' },
  { id: 'acid-base-solutions', zh: '酸碱溶液', g: '化学', note: '强酸弱酸、电离程度、导电性' },
  { id: 'ph-scale', zh: 'pH 标度', g: '化学', note: '常见溶液的 pH、稀释对 pH 的影响' },
  { id: 'graphing-quadratics', zh: '二次函数图像', g: '数学', note: '顶点式、一般式，参数怎么影响抛物线' },
  { id: 'trig-tour', zh: '三角函数之旅', g: '数学', note: '单位圆上看 sin、cos、tan' }
];

function simOnlineUrl(id) {
  return 'https://phet.colorado.edu/sims/html/' + id + '/latest/' + id + '_zh_CN.html';
}
function simLocalUrl(id) {
  const base = (typeof SERVER_BASE === 'string' && SERVER_BASE) ? SERVER_BASE : '';
  return base + '/labkit/phet/' + id + '.html';
}
function simFind(q) {
  const s = String(q == null ? '' : q).trim();
  if (!s) return null;
  return LAB_SIMS.find(x => x.id === s) || LAB_SIMS.find(x => x.zh === s)
    || LAB_SIMS.find(x => x.zh.replace(/[\s：:]/g, '') === s.replace(/[\s：:]/g, '')) || null;
}

// 电脑后端上有哪些离线副本：manifest.js 设置 window.LAB_PHET_LOCAL = ['projectile-motion', …]
let _simManifest = null;
function simLoadManifest() {
  if (_simManifest) return _simManifest;
  _simManifest = new Promise(resolve => {
    if (typeof document === 'undefined') return resolve([]);
    const base = (typeof SERVER_BASE === 'string' && SERVER_BASE) ? SERVER_BASE : '';
    const s = document.createElement('script');
    s.src = base + '/labkit/phet/manifest.js?t=' + Math.floor(Date.now() / 600000);
    const done = () => resolve(Array.isArray(window.LAB_PHET_LOCAL) ? window.LAB_PHET_LOCAL : []);
    const timer = setTimeout(() => { s.onload = s.onerror = null; resolve([]); }, 4000);
    s.onload = () => { clearTimeout(timer); done(); };
    s.onerror = () => { clearTimeout(timer); resolve([]); };
    document.head.appendChild(s);
  });
  return _simManifest;
}

let _simCur = '';

function openSims(q) {
  const modal = document.getElementById('simModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const sim = simFind(q);
  simLoadManifest().then(local => {
    simRenderList(local);
    if (sim) simOpen(sim.id);
    else if (!_simCur) simShowHome();
  });
}
function closeSims() {
  const m = document.getElementById('simModal');
  if (m) m.classList.add('hidden');
  // 关面板就把 iframe 清掉：PhET 的实验一直在跑动画，藏起来也照样吃 CPU
  const f = document.getElementById('simFrame');
  if (f) f.remove();
  _simCur = '';
}

function _simEsc(s) {
  return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function simRenderList(local) {
  const list = document.getElementById('simList');
  if (!list) return;
  const have = new Set(local || []);
  const groups = {};
  for (const s of LAB_SIMS) (groups[s.g] = groups[s.g] || []).push(s);
  list.innerHTML = Object.keys(groups).map(g => '<div class="mol-group"><div class="mol-group-t">' + _simEsc(g) + '</div>'
    + groups[g].map(s => '<button type="button" class="sim-item' + (s.id === _simCur ? ' on' : '') + '" onclick="simOpen(' + _simEsc(JSON.stringify(s.id)) + ')">'
      + '<b>' + _simEsc(s.zh) + (have.has(s.id) ? '' : ' <i title="电脑后端上没有离线副本，从 PhET 官网加载">☁</i>') + '</b><small>' + _simEsc(s.note) + '</small></button>').join('')
    + '</div>').join('');
}

function simShowHome() {
  const stage = document.getElementById('simStage');
  if (stage) stage.innerHTML = '<div class="sim-home"><b>挑一个实验</b><small>实验列表是按科目分好的，都是能自己动手调参数的交互模拟。<br>'
    + '标 ☁ 的是电脑后端上还没下载离线副本，会从 PhET 官网现拉（几 MB，稍等一下）。</small></div>';
}

function simOpen(id) {
  const s = simFind(id);
  const stage = document.getElementById('simStage');
  if (!s || !stage) return;
  _simCur = s.id;
  simLoadManifest().then(local => {
    const url = (local || []).includes(s.id) ? simLocalUrl(s.id) : simOnlineUrl(s.id);
    stage.innerHTML = '';
    const f = document.createElement('iframe');
    f.id = 'simFrame';
    f.className = 'sim-frame';
    f.src = url;
    f.title = s.zh;
    f.setAttribute('allow', 'fullscreen');
    // 实验是第三方页面：给脚本（它本身就是个 JS 程序），不给同源 —— 碰不到 GranCyan 的存储和 API
    f.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
    stage.appendChild(f);
    const note = document.getElementById('simNote');
    if (note) note.textContent = s.zh + ' · ' + s.note + ' · ' + ((local || []).includes(s.id) ? '电脑上的离线副本' : 'PhET 官网');
    simRenderList(local);
  });
}

function simAskAi() {
  const s = simFind(_simCur);
  if (!s) return;
  const input = document.getElementById('userInput');
  if (!input) return;
  input.value = '我在玩「' + s.zh + '」这个实验（' + s.note + '），';
  try { autoResize(input); } catch (e) {}
  try { updateComposerBtns(); } catch (e) {}
  closeSims();
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
}

// ── 聊天里：[[SIM: 抛体运动]] → 一张能点开的实验卡 ──
function simTagRe() { return /\[\[SIM:\s*([^\]]{1,40}?)\s*\]\]/g; }

function simTagToHtml(text) {
  if (!text || text.indexOf('[[SIM') < 0) return text;
  return String(text).replace(simTagRe(), (m, q) => {
    const s = simFind(q);
    if (!s) return '<span class="chem-card sim-card sim-miss">🔬 ' + _simEsc(q) + '（实验库里没有这个）</span>';
    return '<button type="button" class="chem-card sim-card" onclick="openSims(' + _simEsc(JSON.stringify(s.id)) + ')">'
      + '<span class="sim-card-ico">🔬</span><span class="chem-card-txt"><b>' + _simEsc(s.zh) + '</b><small>' + _simEsc(s.note) + ' · 点开动手试</small></span></button>';
  });
}

// 回填：认得的原样留着（正确写法）；认不出的告诉模型，不然它下次还写这个名字
function simTagForApi(text) {
  if (!text || text.indexOf('[[SIM') < 0) return text;
  return String(text).replace(simTagRe(), (m, q) => (simFind(q) ? m : m + '[实验库里没有「' + String(q).slice(0, 20) + '」，这张卡没画出来]'));
}

function maskStreamingSim(text) {
  if (!text || text.indexOf('[[') < 0) return text;
  return String(text).replace(simTagRe(), '〔🔬〕').replace(/\[\[SIM\b[^\]]*$/, '〔…〕');
}
