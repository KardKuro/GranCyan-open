// 生成学习工具箱的离线数据：js/labdata/elements.js（周期表）+ js/labdata/molecules.js（分子 3D 结构）
//
//   node scripts/build-labdata.js            两样都生成（分子要联网拉 PubChem，约一两分钟）
//   node scripts/build-labdata.js elements   只生成周期表（不联网，读环境变量 PT_JSON 指的文件，默认 <项目>/_vendor/PeriodicTableJSON.json）
//
// 周期表数据：Bowserinator/Periodic-Table-JSON（CC BY-SA 3.0，数据取自维基百科）。
//   原始 JSON 下载：https://raw.githubusercontent.com/Bowserinator/Periodic-Table-JSON/master/PeriodicTableJSON.json
//   中文名、拼音、高中常见化合价、课本用的「常用相对原子质量」是这里补的（原数据没有）。
// 分子：PubChem PUG REST（美国 NIH，公有领域）。先要 3D 构象，没有 3D 的退回 2D。
//
// ⚠️ js/labdata/*.js 是生成物，别手改 —— 改这个脚本再跑一遍。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'js', 'labdata');
const SRC_PT = process.env.PT_JSON || path.join(ROOT, '_vendor', 'PeriodicTableJSON.json');

// 1-118 中文名（113 以后是 2017 年定的新字，有的字体里没有，界面上符号兜底）
const ZH = ('氢 氦 锂 铍 硼 碳 氮 氧 氟 氖 钠 镁 铝 硅 磷 硫 氯 氩 钾 钙 钪 钛 钒 铬 锰 铁 钴 镍 铜 锌 镓 锗 砷 硒 溴 氪 '
  + '铷 锶 钇 锆 铌 钼 锝 钌 铑 钯 银 镉 铟 锡 锑 碲 碘 氙 铯 钡 镧 铈 镨 钕 钷 钐 铕 钆 铽 镝 钬 铒 铥 镱 镥 '
  + '铪 钽 钨 铼 锇 铱 铂 金 汞 铊 铅 铋 钋 砹 氡 钫 镭 锕 钍 镤 铀 镎 钚 镅 锔 锫 锎 锿 镄 钔 锘 铹 '
  + '𬬻 𬭊 𬭳 𬭛 𬭶 鿏 𫟼 𬬭 鿔 鿭 𫓧 镆 𫟷 鿬 鿫').split(' ');

// 拼音：只给读得不太确定的前 56 号和几个常见重元素，其余不标（宁缺别错）
const PY = {
  1: 'qīng', 2: 'hài', 3: 'lǐ', 4: 'pí', 5: 'péng', 6: 'tàn', 7: 'dàn', 8: 'yǎng', 9: 'fú', 10: 'nǎi',
  11: 'nà', 12: 'měi', 13: 'lǚ', 14: 'guī', 15: 'lín', 16: 'liú', 17: 'lǜ', 18: 'yà', 19: 'jiǎ', 20: 'gài',
  21: 'kàng', 22: 'tài', 23: 'fán', 24: 'gè', 25: 'měng', 26: 'tiě', 27: 'gǔ', 28: 'niè', 29: 'tóng', 30: 'xīn',
  31: 'jiā', 32: 'zhě', 33: 'shēn', 34: 'xī', 35: 'xiù', 36: 'kè', 37: 'rú', 38: 'sī', 39: 'yǐ', 40: 'gào',
  41: 'ní', 42: 'mù', 43: 'dé', 44: 'liǎo', 45: 'lǎo', 46: 'bǎ', 47: 'yín', 48: 'gé', 49: 'yīn', 50: 'xī',
  51: 'tī', 52: 'dì', 53: 'diǎn', 54: 'xiān', 55: 'sè', 56: 'bèi',
  74: 'wū', 78: 'bó', 79: 'jīn', 80: 'gǒng', 82: 'qiān', 83: 'bì', 84: 'pō', 85: 'ài', 86: 'dōng', 88: 'léi', 92: 'yóu'
};

// 高中常见化合价（人教版课本口径，只列课本里会用到的）
const VAL = {
  1: '+1, -1', 2: '0', 3: '+1', 4: '+2', 5: '+3', 6: '-4, +2, +4', 7: '-3, +1, +2, +3, +4, +5', 8: '-2, -1',
  9: '-1', 10: '0', 11: '+1', 12: '+2', 13: '+3', 14: '-4, +4', 15: '-3, +3, +5', 16: '-2, +4, +6',
  17: '-1, +1, +3, +5, +7', 18: '0', 19: '+1', 20: '+2', 22: '+4', 24: '+2, +3, +6', 25: '+2, +4, +6, +7',
  26: '+2, +3', 27: '+2, +3', 28: '+2', 29: '+1, +2', 30: '+2', 33: '-3, +3, +5', 34: '-2, +4, +6',
  35: '-1, +1, +5', 36: '0', 47: '+1', 50: '+2, +4', 53: '-1, +5, +7', 54: '0', 56: '+2', 78: '+2, +4',
  79: '+1, +3', 80: '+1, +2', 82: '+2, +4', 86: '0'
};

// 分类：原数据是英文，有的还带「unknown, probably …」
const CAT = {
  'diatomic nonmetal': 'nonmetal', 'polyatomic nonmetal': 'nonmetal', 'reactive nonmetal': 'nonmetal',
  'noble gas': 'noble', 'alkali metal': 'alkali', 'alkaline earth metal': 'alkaline', 'metalloid': 'metalloid',
  'post-transition metal': 'post', 'transition metal': 'transition', 'lanthanide': 'lanthanide', 'actinide': 'actinide'
};

function buildElements() {
  const raw = JSON.parse(fs.readFileSync(SRC_PT, 'utf8')).elements;
  const rows = raw.filter(e => e.number >= 1 && e.number <= 118).map(e => {
    const n = e.number;
    let cat = CAT[e.category];
    if (!cat) cat = /unknown/.test(e.category || '') ? 'unknown' : 'unknown';
    // 课本上的「常用相对原子质量」：取整，氯是 35.5（课本就这么给的）
    const common = n === 17 ? 35.5 : (n <= 56 || [74, 78, 79, 80, 82, 92].includes(n)) ? Math.round(e.atomic_mass) : null;
    const k2c = v => (typeof v === 'number' ? Math.round((v - 273.15) * 10) / 10 : null);
    return {
      n, s: e.symbol, zh: ZH[n - 1], py: PY[n] || '', en: e.name,
      m: Math.round(e.atomic_mass * 1000) / 1000, mc: common,
      cat, p: e.period, g: e.group, x: e.xpos, y: e.ypos,
      // 原数据有的漏空格（镧是 "[Xe] 5d16s2"），有的带 * 表示预测值 —— 补空格、去星号、另记 pred
      cfg: String(e.electron_configuration_semantic || '').replace(/^\*/, '')
        .replace(/(\d[spdf]\d{1,2})(?=\d[spdf])/g, '$1 ').trim(),
      pred: /^\*/.test(e.electron_configuration_semantic || '') ? 1 : 0,
      sh: e.shells || [],
      eneg: e.electronegativity_pauling == null ? null : e.electronegativity_pauling,
      mp: k2c(e.melt), bp: k2c(e.boil), d: e.density == null ? null : e.density,
      ph: ({ Solid: '固', Liquid: '液', Gas: '气' })[e.phase] || '',
      bl: e.block || '', v: VAL[n] || ''
    };
  });
  if (rows.length !== 118) throw new Error('元素不是 118 个：' + rows.length);
  if (ZH.length !== 118) throw new Error('中文名不是 118 个：' + ZH.length);
  fs.mkdirSync(OUT, { recursive: true });
  const body = '// 生成物，别手改：node scripts/build-labdata.js elements\n'
    + '// 数据：Periodic-Table-JSON（CC BY-SA 3.0，取自维基百科）；中文名/拼音/常见化合价/常用相对原子质量为 GranCyan 补充。\n'
    + 'const LAB_ELEMENTS = ' + JSON.stringify(rows) + ';\n';
  fs.writeFileSync(path.join(OUT, 'elements.js'), body);
  console.log('elements.js', rows.length, '个元素', body.length, '字节');
}

// ── 分子 ──
// [中文名, PubChem 查询名, 分组]。查询名要能在 PubChem 按名字查到（英文），查不到就会退回 2D 或者跳过。
const MOLS = [
  ['水', 'water', '无机'], ['二氧化碳', 'carbon dioxide', '无机'], ['一氧化碳', 'carbon monoxide', '无机'],
  ['氨', 'ammonia', '无机'], ['过氧化氢', 'hydrogen peroxide', '无机'], ['二氧化硫', 'sulfur dioxide', '无机'],
  ['三氧化硫', 'sulfur trioxide', '无机'], ['硫化氢', 'hydrogen sulfide', '无机'], ['氯化氢', 'hydrogen chloride', '无机'],
  ['硫酸', 'sulfuric acid', '无机'], ['硝酸', 'nitric acid', '无机'], ['次氯酸', 'hypochlorous acid', '无机'],
  ['二氧化氮', 'nitrogen dioxide', '无机'], ['臭氧', 'ozone', '无机'], ['白磷', 'tetraphosphorus', '无机'],
  ['四氯化碳', 'carbon tetrachloride', '无机'],
  ['甲烷', 'methane', '烃'], ['乙烷', 'ethane', '烃'], ['丙烷', 'propane', '烃'], ['正丁烷', 'butane', '烃'],
  ['异丁烷', 'isobutane', '烃'], ['乙烯', 'ethylene', '烃'], ['丙烯', 'propene', '烃'], ['1,3-丁二烯', '1,3-butadiene', '烃'],
  ['乙炔', 'acetylene', '烃'], ['环己烷', 'cyclohexane', '烃'], ['苯', 'benzene', '烃'], ['甲苯', 'toluene', '烃'], ['萘', 'naphthalene', '烃'],
  ['一氯甲烷', 'chloromethane', '烃的衍生物'], ['溴乙烷', 'bromoethane', '烃的衍生物'], ['甲醇', 'methanol', '烃的衍生物'],
  ['乙醇', 'ethanol', '烃的衍生物'], ['乙二醇', 'ethylene glycol', '烃的衍生物'], ['丙三醇', 'glycerol', '烃的衍生物'],
  ['苯酚', 'phenol', '烃的衍生物'], ['甲醛', 'formaldehyde', '烃的衍生物'], ['乙醛', 'acetaldehyde', '烃的衍生物'],
  ['丙酮', 'acetone', '烃的衍生物'], ['甲酸', 'formic acid', '烃的衍生物'], ['乙酸', 'acetic acid', '烃的衍生物'],
  ['乙酸乙酯', 'ethyl acetate', '烃的衍生物'], ['草酸', 'oxalic acid', '烃的衍生物'], ['苯甲酸', 'benzoic acid', '烃的衍生物'],
  ['硝基苯', 'nitrobenzene', '烃的衍生物'], ['苯胺', 'aniline', '烃的衍生物'], ['阿司匹林', 'aspirin', '烃的衍生物'],
  ['葡萄糖', 'glucose', '生命中的分子'], ['果糖', 'fructose', '生命中的分子'], ['蔗糖', 'sucrose', '生命中的分子'],
  ['甘氨酸', 'glycine', '生命中的分子'], ['丙氨酸', 'alanine', '生命中的分子'], ['尿素', 'urea', '生命中的分子'],
  ['硬脂酸', 'stearic acid', '生命中的分子'], ['油酸', 'oleic acid', '生命中的分子'], ['维生素 C', 'ascorbic acid', '生命中的分子'],
  ['咖啡因', 'caffeine', '生命中的分子'], ['胆固醇', 'cholesterol', '生命中的分子']
];

async function getText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return null;
      if (r.ok) return await r.text();
    } catch (e) { /* 重试 */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function buildMolecules() {
  const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/';
  const out = [];
  for (const [zh, q, grp] of MOLS) {
    const enc = encodeURIComponent(q);
    let sdf = await getText(base + enc + '/SDF?record_type=3d');
    let dim = 3;
    if (!sdf) { sdf = await getText(base + enc + '/SDF?record_type=2d'); dim = 2; }
    const prop = await getText(base + enc + '/property/MolecularFormula,IUPACName/JSON');
    let formula = '', cid = 0;
    try { const p = JSON.parse(prop).PropertyTable.Properties[0]; formula = p.MolecularFormula || ''; cid = p.CID || 0; } catch (e) {}
    if (!sdf) { console.log('  ✗', zh, q, '拿不到结构'); continue; }
    // 一个名字可能返回多个记录（$$$$ 分隔），只留第一个
    sdf = sdf.split('$$$$')[0].trim() + '\n$$$$\n';
    out.push({ zh, q, g: grp, f: formula, cid, dim, sdf });
    console.log('  ✓', zh.padEnd(6, '　'), formula.padEnd(10), dim + 'D', sdf.length + 'B');
    await new Promise(r => setTimeout(r, 250));      // PubChem 要求每秒不超过 5 次
  }
  fs.mkdirSync(OUT, { recursive: true });
  const body = '// 生成物，别手改：node scripts/build-labdata.js\n'
    + '// 结构：PubChem（NIH，公有领域）。dim=3 是 3D 构象；dim=2 是 PubChem 没有 3D 时退回的平面结构。\n'
    + 'const LAB_MOLECULES = ' + JSON.stringify(out) + ';\n';
  fs.writeFileSync(path.join(OUT, 'molecules.js'), body);
  console.log('molecules.js', out.length + '/' + MOLS.length, '个分子', body.length, '字节');
}

(async () => {
  const only = process.argv[2];
  if (!only || only === 'elements') buildElements();
  if (!only || only === 'molecules') await buildMolecules();
})().catch(e => { console.error(e); process.exit(1); });
