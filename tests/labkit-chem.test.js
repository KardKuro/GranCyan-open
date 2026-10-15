'use strict';
// 学习工具箱 ②：元素周期表 + 分子模型 + 聊天里的 [[ELEM:]] / [[MOL:]]（js/55-chem.js）
//
// 化学数据错了是最糟的一类错：界面好好的，只是教错了。这份测试一半在守数据本身
// （118 个、电子排布的特例、课本上的 35.5），一半在守接线和「提示词里教的名字表里真有」。
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

const src = read('js/55-chem.js');
const elemSrc = read('js/labdata/elements.js');
const molSrc = read('js/labdata/molecules.js');
function sandbox(withData) {
  const box = {
    console, Math, JSON, Number, String, Object, Array, Set, Map, RegExp, encodeURIComponent,
    escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(box);
  vm.runInContext((withData ? elemSrc + molSrc : '') + src + ';this.chemFindElement=chemFindElement;this.chemFindMolecule=chemFindMolecule;'
    + 'this.chemTagToHtml=chemTagToHtml;this.maskStreamingChem=maskStreamingChem;this.chemCrystalXyz=chemCrystalXyz;this.chemBohrSvg=chemBohrSvg;'
    + 'this.CHEM_CAT=CHEM_CAT;this.CHEM_CRYSTALS=CHEM_CRYSTALS;'
    + (withData ? 'this.E=LAB_ELEMENTS;this.M=LAB_MOLECULES;' : ''), box);
  return box;
}
const B = sandbox(true);
const E = B.E, M = B.M;

console.log('\n[1] 元素数据');
t('★ 118 个，序号 1…118 连续', E.length === 118 && E.every((e, i) => e.n === i + 1));
t('★ 符号、中文名都不重复', new Set(E.map(e => e.s)).size === 118 && new Set(E.map(e => e.zh)).size === 118);
t('★ 各层电子数加起来等于原子序数', E.every(e => e.sh.reduce((a, b) => a + b, 0) === e.n), E.filter(e => e.sh.reduce((a, b) => a + b, 0) !== e.n).map(e => e.s));
t('★ 课本常用相对原子质量：Cl 35.5、Cu 64、Fe 56、O 16', B.chemFindElement('Cl').mc === 35.5 && B.chemFindElement('Cu').mc === 64
  && B.chemFindElement('Fe').mc === 56 && B.chemFindElement('O').mc === 16);
t('★ 电子排布的两个特例：Cr 3d5 4s1、Cu 3d10 4s1', B.chemFindElement('Cr').cfg === '[Ar] 3d5 4s1' && B.chemFindElement('Cu').cfg === '[Ar] 3d10 4s1');
t('★ 原数据漏的空格补上了（镧 "5d16s2" → "5d1 6s2"），没有粘在一起的轨道', B.chemFindElement('La').cfg === '[Xe] 5d1 6s2'
  && E.every(e => !/\d[spdf]\d{1,2}\d[spdf]/.test(e.cfg)), E.filter(e => /\d[spdf]\d{1,2}\d[spdf]/.test(e.cfg)).map(e => e.s + ':' + e.cfg));
t('  预测值的星号去掉、另外标 pred', B.chemFindElement('Og').pred === 1 && !/\*/.test(B.chemFindElement('Og').cfg));
t('★ 表格位置不重叠（x,y 各不相同）', new Set(E.map(e => e.x + ',' + e.y)).size === 118);
t('  分类都在图例里', E.every(e => B.CHEM_CAT[e.cat]), E.filter(e => !B.CHEM_CAT[e.cat]).map(e => e.cat));
t('  常见化合价：Fe +2,+3；Cl 有 +7；稀有气体 0', B.chemFindElement('Fe').v === '+2, +3' && /\+7/.test(B.chemFindElement('Cl').v) && B.chemFindElement('Ne').v === '0');
t('  熔沸点换成了摄氏度（水银的熔点在 -39 左右）', Math.abs(B.chemFindElement('Hg').mp + 38.8) < 1, B.chemFindElement('Hg').mp);

console.log('\n[2] 查元素');
t('★ 符号 / 中文 / 英文 / 序号都能查', B.chemFindElement('Fe').n === 26 && B.chemFindElement('铁').n === 26 && B.chemFindElement('iron').n === 26 && B.chemFindElement('26').n === 26);
t('  大小写：Co 是钴，co 也兜到钴（不会凭空变成别的）', B.chemFindElement('Co').n === 27 && B.chemFindElement('co').n === 27);
t('  查不到返回 null', B.chemFindElement('Xx') === null && B.chemFindElement('') === null && B.chemFindElement('200') === null);
{
  const svg = B.chemBohrSvg(B.chemFindElement('Fe'), 150);
  const dots = (svg.match(/fill="#7cc4ff"/g) || []).length;
  t('★ 玻尔模型：铁画 4 层、26 个电子点', (svg.match(/stroke="rgba\(180,190,210/g) || []).length === 4 && dots === 26, dots);
}

console.log('\n[3] 分子数据');
t('★ 离线表有 50 个以上分子，名字不重复', M.length >= 50 && new Set(M.map(m => m.zh)).size === M.length, M.length);
t('★ 每个都是完整的 SDF（有 M  END），有分子式', M.every(m => /M {2}END/.test(m.sdf) && m.f), M.filter(m => !/M {2}END/.test(m.sdf) || !m.f).map(m => m.zh));
{
  const bad = [];
  for (const m of M) {
    const counts = m.sdf.split('\n')[3] || '';
    const n = parseInt(counts.slice(0, 3), 10);
    const hs = (m.f.match(/[A-Z][a-z]?(\d*)/g) || []).reduce((a, x) => a + (Number(x.replace(/\D/g, '')) || 1), 0);
    if (m.dim === 3 && n !== hs) bad.push(m.zh + ' ' + n + '≠' + hs);
  }
  t('★ 3D 结构的原子数和分子式对得上（结构拿错了一眼看不出来）', bad.length === 0, bad);
}
t('  乙醇是 C2H6O、葡萄糖是 C6H12O6', B.chemFindMolecule('乙醇').f === 'C2H6O' && B.chemFindMolecule('葡萄糖').f === 'C6H12O6');
t('  英文名也能查', B.chemFindMolecule('ethanol').zh === '乙醇');

console.log('\n[4] 晶体');
{
  const lines = x => x.trim().split('\n').slice(2);
  const nacl = lines(B.chemCrystalXyz('nacl'));
  t('★ 氯化钠：27 个离子，Na 和 Cl 交替（14 Na + 13 Cl）', nacl.length === 27 && nacl.filter(l => l.startsWith('Na ')).length === 14);
  const cscl = lines(B.chemCrystalXyz('cscl'));
  t('★ 氯化铯：8 个角上的 Cl + 体心 1 个 Cs', cscl.length === 9 && cscl.filter(l => l.startsWith('Cs ')).length === 1);
  const dia = lines(B.chemCrystalXyz('diamond'));
  t('★ 金刚石：一个晶胞里画出 18 个 C（8 角 + 6 面心 + 4 个内部）', dia.length === 18);
  const xyz = dia.map(l => l.split(/\s+/).slice(1).map(Number));
  let minD = 99;
  for (let i = 0; i < xyz.length; i++) for (let j = i + 1; j < xyz.length; j++) minD = Math.min(minD, Math.hypot(xyz[i][0] - xyz[j][0], xyz[i][1] - xyz[j][1], xyz[i][2] - xyz[j][2]));
  t('  金刚石最近的 C–C 距离 ≈ 1.54 Å', Math.abs(minD - 1.545) < 0.01, minD);
  const gr = lines(B.chemCrystalXyz('graphite'));
  t('  石墨两层（z 有两个值）', new Set(gr.map(l => l.split(/\s+/)[3])).size === 2 && gr.length > 20);
}

console.log('\n[5] 聊天里的卡片');
{
  const h = B.chemTagToHtml('铁是 [[ELEM: Fe]]，[[ELEM: 17]]');
  t('★ 元素卡：点开是周期表并定位到那个元素', /onclick="openPeriodic\(&quot;Fe&quot;\)"/.test(h) && /onclick="openPeriodic\(&quot;Cl&quot;\)"/.test(h));
  const m = B.chemTagToHtml('[[MOL: 乙醇]] [[MOL: 布洛芬 | ibuprofen]]');
  t('★ 分子卡：表里的按 CID 取结构式、带分子式', /compound\/cid\/\d+\/PNG/.test(m) && /C₂H₆O/.test(m));
  t('★ 表外的带英文名：按名字取图、点开时把英文名传过去', /compound\/name\/ibuprofen\/PNG/.test(m) && /openMolecules\(&quot;布洛芬&quot;,&quot;ibuprofen&quot;\)/.test(m));
  const x = B.chemTagToHtml('[[MOL: <img src=x onerror=alert(1)>]] [[ELEM: <b>x</b>]]');
  t('★ 标签里的尖括号全转义（模型输出可能带着注入）', !/<img src=x/.test(x) && !/<b>x/.test(x), x.slice(0, 200));
}
{
  const N = sandbox(false);
  const h = N.chemTagToHtml('[[ELEM: Fe]] [[MOL: 乙醇]]');
  t('★ 数据还没加载：画成占位（data-elem / data-mol），等 chemHydrate 补画', /chem-pending" data-elem="Fe"/.test(h) || /chem-pending[^"]*" data-elem="Fe"/.test(h));
  t('  分子卡同样先占位', /chem-pending" data-mol="乙醇"/.test(h), h);
  t('  带英文名的分子卡不用等表（直接按名字取图）', !/data-mol/.test(N.chemTagToHtml('[[MOL: 布洛芬 | ibuprofen]]')));
}
t('★ 流式：写完的遮成 〔⚛〕〔🧊〕，写一半的也遮住', B.maskStreamingChem('a [[ELEM: Fe]] b [[MOL: 苯]]') === 'a 〔⚛〕 b 〔🧊〕'
  && B.maskStreamingChem('看 [[MOL: 乙') === '看 〔…〕');
t('  别的标签不碰', B.maskStreamingChem('[[PLOT: y=x]]') === '[[PLOT: y=x]]');

console.log('\n[6] 接线');
const media = read('js/12-math-media.js'), prompts = read('js/05-prompts-api.js'), input = read('js/09-appearance-input.js'), html = read('index.html');
t('★ 渲染层调 chemTagToHtml', /if \(typeof chemTagToHtml === 'function'\) text = chemTagToHtml\(text\);/.test(media));
t('★ 流式遮罩登记', /const _STREAM_MASKS = \[[^\]]*'maskStreamingChem'/.test(prompts));
{
  const fn = input.slice(input.indexOf('function typesetMath(el)'), input.indexOf('function hexAlpha'));
  t('★ 进了 DOM 之后补画占位卡（在 KaTeX 早退之前）', fn.indexOf('chemHydrate(el)') > 0 && fn.indexOf('chemHydrate(el)') < fn.indexOf("typeof renderMathInElement !== 'function') return;"));
}
t('★ 页面加载 55-chem.js，有两个面板和「学习」架子上的入口', /<script src="\.\/js\/55-chem\.js"><\/script>/.test(html) && /id="periodicModal"/.test(html) && /id="molModal"/.test(html)
  && /<span>学习<\/span>[\s\S]*?openWidget\(openPeriodic\)[\s\S]*?openWidget\(openMolecules\)/.test(html));
t('  数据文件和 3Dmol 都是懒加载（不进首屏）', !/<script[^>]*(labdata\/|3Dmol)/.test(html) && /'\.\/js\/lib\/3Dmol-min\.js'/.test(src) && fs.existsSync(path.join(ROOT, 'js/lib/3Dmol-min.js')));

console.log('\n[7] 提示词里教的名字，表里真有');
const skill = (prompts.match(/if \(skillOn\('chem'\)\) base \+= `([\s\S]*?)`;/) || [])[1] || '';
t('★ 化学卡片技能在开关表里、提示词在 buildSystemPrompt 里', /\{ key: 'chem',\s+tok: \d+,/.test(prompts) && skill.length > 100);
{
  const listed = ((skill.match(/直接写中文名：([^；。]*?) 等/) || [])[1] || '').split('、').map(s => s.trim()).filter(Boolean);
  const crystals = ((skill.match(/晶体有 ([^。]*?)。/) || [])[1] || '').split('、').map(s => s.trim()).filter(Boolean);
  const missing = listed.filter(n => !B.chemFindMolecule(n));
  const missC = crystals.filter(n => !B.CHEM_CRYSTALS.some(c => c.zh === n));
  t('★ 提示词里举例的中文分子名，离线表里都有（教了它一个表里没有的名字，卡片就只能显示「不在表里」）',
    listed.length >= 10 && missing.length === 0, { listed: listed.length, missing });
  t('★ 提示词里的晶体名都认得', crystals.length === 4 && missC.length === 0, missC);
}

console.log('\n[8] 生成物和安卓副本');
t('  labdata 是生成物，文件头写着怎么重新生成', /node scripts\/build-labdata\.js/.test(elemSrc) && /node scripts\/build-labdata\.js/.test(molSrc) && fs.existsSync(path.join(ROOT, 'scripts/build-labdata.js')));
t('  署名：CC BY-SA 3.0 的周期表数据在面板上写了出处', /CC BY-SA 3\.0/.test(src) && /Periodic-Table-JSON/.test(src));
for (const f of ['js/55-chem.js', 'js/labdata/elements.js', 'js/labdata/molecules.js', 'js/lib/3Dmol-min.js']) {
  const a = path.join(ROOT, 'android/assets', f);
  t('★★ android 副本与 ' + f + ' 一致', fs.existsSync(a) && fs.readFileSync(a).equals(fs.readFileSync(path.join(ROOT, f))));
}

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
