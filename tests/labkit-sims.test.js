'use strict';
// 学习工具箱 ③：PhET 交互实验面板 + 聊天里的 [[SIM:]]（js/56-sims.js）
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

const src = read('js/56-sims.js');
const box = {
  console, JSON, String, Object, Array, Set, Math, Date,
  escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  SERVER_BASE: 'http://192.168.1.5:3000'
};
vm.createContext(box);
vm.runInContext(src + ';this.LAB_SIMS=LAB_SIMS;this.simFind=simFind;this.simTagToHtml=simTagToHtml;this.simTagForApi=simTagForApi;'
  + 'this.maskStreamingSim=maskStreamingSim;this.simOnlineUrl=simOnlineUrl;this.simLocalUrl=simLocalUrl;', box);
const S = box.LAB_SIMS;

console.log('\n[1] 实验清单');
t('★ id 和中文名都不重复', new Set(S.map(s => s.id)).size === S.length && new Set(S.map(s => s.zh)).size === S.length);
t('  每个都有科目和一句「学什么」', S.every(s => ['物理', '化学', '数学'].includes(s.g) && s.note && s.note.length > 4));
t('★ 官网地址是简体中文单文件版', box.simOnlineUrl('projectile-motion') === 'https://phet.colorado.edu/sims/html/projectile-motion/latest/projectile-motion_zh_CN.html');
t('★ 本地地址走电脑后端的 labkit/phet', box.simLocalUrl('ph-scale') === 'http://192.168.1.5:3000/labkit/phet/ph-scale.html');
t('  中文名 / id / 去掉冒号空格的写法都能查', box.simFind('抛体运动').id === 'projectile-motion' && box.simFind('ph-scale').zh === 'pH 标度'
  && box.simFind('电路搭建直流').id === 'circuit-construction-kit-dc' && box.simFind('瞎编') === null);

console.log('\n[2] 聊天里的卡片');
{
  const h = box.simTagToHtml('试试 [[SIM: 抛体运动]] 和 [[SIM: <img onerror=x>]]');
  t('★ 认得的画成卡片，点开定位到那个实验', /onclick="openSims\(&quot;projectile-motion&quot;\)"/.test(h));
  t('★ 认不出的明说没有，不画成能点的按钮；名字转义', /实验库里没有这个/.test(h) && !/<img onerror/.test(h));
  const a = box.simTagForApi('[[SIM: 抛体运动]] [[SIM: 瞎编]]');
  t('★ 回填：认得的原样留着，认不出的告诉模型（不然它下次还写这个名字）', a === '[[SIM: 抛体运动]] [[SIM: 瞎编]][实验库里没有「瞎编」，这张卡没画出来]', a);
  t('★ 流式遮罩：整的和半截的都遮', box.maskStreamingSim('a [[SIM: 抛体运动]] b') === 'a 〔🔬〕 b' && box.maskStreamingSim('看 [[SIM: 抛') === '看 〔…〕');
}

console.log('\n[3] 安全：第三方页面关在沙箱里');
t('★ iframe 有 sandbox，且**不给** allow-same-origin（碰不到 GranCyan 的存储和 API）',
  /f\.setAttribute\('sandbox', 'allow-scripts[^']*'\)/.test(src) && !/allow-same-origin/.test(src));
t('  关面板就把 iframe 移掉（实验一直在跑动画，藏起来也吃 CPU）', /function closeSims\(\) \{[\s\S]*?getElementById\('simFrame'\);\s*\n\s*if \(f\) f\.remove\(\);/.test(src));
t('  「本地有没有」靠 <script> 加载 manifest（跨源 fetch 会被 CORS 挡）', /s\.src = base \+ '\/labkit\/phet\/manifest\.js/.test(src) && !/fetch\(/.test(src));

console.log('\n[4] 接线和提示词');
const media = read('js/12-math-media.js'), prompts = read('js/05-prompts-api.js'), html = read('index.html');
t('★ 渲染层调 simTagToHtml', /if \(typeof simTagToHtml === 'function'\) text = simTagToHtml\(text\);/.test(media));
t('★ 回填链有 simTagForApi', /cooked = typeof simTagForApi === 'function' \? simTagForApi\(cooked\) : cooked;/.test(prompts));
t('★ 流式遮罩登记', /const _STREAM_MASKS = \[[^\]]*'maskStreamingSim'/.test(prompts));
t('★ 页面加载 56-sims.js，有面板和「学习」架子上的入口', /<script src="\.\/js\/56-sims\.js"><\/script>/.test(html) && /id="simModal"/.test(html)
  && /<span>学习<\/span>[\s\S]*?openWidget\(openSims\)/.test(html));
{
  const skill = (prompts.match(/if \(skillOn\('sim'\)\) base \+= `([\s\S]*?)`;/) || [])[1] || '';
  const names = ((skill.match(/实验名只能用这些：([^。]*)。/) || [])[1] || '').split('、').map(s => s.trim()).filter(Boolean);
  const unknown = names.filter(n => !box.simFind(n));
  const untaught = S.filter(s => !names.includes(s.zh)).map(s => s.zh);
  t('★ 提示词里列的每个实验名都在清单里', names.length > 0 && unknown.length === 0, unknown);
  t('★ 清单里每个实验都列进了提示词（加了实验忘了教，它就永远不会递那张卡）', untaught.length === 0, untaught);
  t('  技能开关表里有 sim', /\{ key: 'sim',\s+tok: \d+,/.test(prompts));
}

console.log('\n[5] 打包：72MB 的实验只在电脑后端');
t('★ labkit/ 不进 git、不进 exe', /^labkit\/$/m.test(read('.gitignore')) && (read('package.json').match(/--ignore=\\"\^\/labkit\(\$\|\/\)\\"/g) || []).length === 2);
t('  下载脚本读的是同一份清单（vm 跑 56-sims.js），验完整性（</html> 结尾）',
  /js', '56-sims\.js'/.test(read('scripts/fetch-phet.js')) && /<\\\/html>/.test(read('scripts/fetch-phet.js')));
{
  const man = path.join(ROOT, 'labkit/phet/manifest.js');
  if (fs.existsSync(man)) {
    const b2 = { window: {} };
    vm.createContext(b2);
    vm.runInContext(fs.readFileSync(man, 'utf8'), b2);
    const have = b2.window.LAB_PHET_LOCAL || [];
    t('  （这台电脑上）manifest 里列的离线副本文件都在', have.every(id => fs.existsSync(path.join(ROOT, 'labkit/phet', id + '.html'))), have.length);
  } else {
    console.log('  · 这台机器没下载离线副本（labkit/phet/manifest.js 不存在），跳过');
  }
}
{
  const a = path.join(ROOT, 'android/assets/js/56-sims.js');
  t('★★ android 副本与 js/56-sims.js 字节一致', fs.existsSync(a) && fs.readFileSync(a, 'utf8') === src);
}

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
