'use strict';
// 学习工具箱 ④⑤：错题本（js/57-mistakes.js）+ 公式卡（js/58-formulas.js、js/labdata/formulas.js）
//
// 这两样的数据都是她自己一点点攒的，丢了就是真丢了。所以最重的几条守的是：
//   · 三道持久化白名单都登记了（漏一道就是「刷新即失、零报错」）
//   · 复习节奏按设计走（做对往后排、做错回第一格、六次掌握）
//   · 从聊天收错题时，题目和解析别配错对
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

const mkSrc = read('js/57-mistakes.js'), fcSrc = read('js/58-formulas.js'), dataSrc = read('js/labdata/formulas.js');
function sandbox(extra) {
  const saves = [];
  const box = Object.assign({
    console, Math, JSON, Number, String, Object, Array, Set, Map, RegExp, Date,
    state: { mistakes: [], fcards: {} },
    save: () => saves.push(1),
    escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }, extra || {});
  box.__saves = saves;
  vm.createContext(box);
  vm.runInContext(dataSrc + mkSrc + fcSrc
    + ';this.LAB_FORMULAS=LAB_FORMULAS;this.MISTAKE_LADDER=MISTAKE_LADDER;this.mistakeGuessSubject=mistakeGuessSubject;this.mistakeSchedule=mistakeSchedule;'
    + 'this.mistakeIsDue=mistakeIsDue;this.mistakeAdd=mistakeAdd;this.mistakeFromNode=mistakeFromNode;this._mkStripTags=_mkStripTags;this.mistakeDueCount=mistakeDueCount;'
    + 'this.fcardTex=fcardTex;this.fcardGrade=fcardGrade;this.fcardQueue=fcardQueue;this.fcardAddCustom=fcardAddCustom;this.fcardAll=fcardAll;'
    + 'this.fcardTagToHtml=fcardTagToHtml;this.fcardTagRe=fcardTagRe;this.maskStreamingFcard=maskStreamingFcard;', box);
  return box;
}
const DAY = 86400000;

console.log('\n[1] 错题本：复习节奏');
{
  const B = sandbox();
  t('★ 阶梯是 1/2/4/7/15/30 天', JSON.stringify(B.MISTAKE_LADDER) === '[1,2,4,7,15,30]');
  const now = 1_700_000_000_000;
  const m = B.mistakeAdd({ q: '求 f(x)=x²-2x 的最小值' }, now);
  t('★ 新收的错题明天到期', m.due === now + DAY && m.step === 0);
  B.mistakeSchedule(m, true, now);
  t('★ 做对一次 → 第二格（2 天后）', m.step === 1 && m.due === now + 2 * DAY);
  B.mistakeSchedule(m, false, now);
  t('★ 做错 → 回第一格、明天再来', m.step === 0 && m.due === now + DAY && m.mastered === 0);
  for (let i = 0; i < 6; i++) B.mistakeSchedule(m, true, now);
  t('★ 连对六次算掌握，不再排进复习', !!m.mastered && !B.mistakeIsDue(m, now + 999 * DAY));
  t('  每次作答都记在 log 里', m.log.length === 8 && m.log.filter(x => x.ok).length === 7);
  t('  题目和图片都没有就不收', B.mistakeAdd({ q: '  ' }) === null && B.mistakeAdd({ q: '', imgs: ['http://x/y.png'] }) === null);
  t('  图片只收 data:image（不存外链，外链会过期）', B.mistakeAdd({ q: 'x', imgs: ['data:image/png;base64,AA', 'https://a/b.png'] }).imgs.length === 1);
  t('  收进来就落盘', B.__saves.length > 0);
}
{
  const B = sandbox();
  t('★ 按关键词猜科目', B.mistakeGuessSubject('已知函数 f(x)=sin x') === '数学' && B.mistakeGuessSubject('求物体的加速度') === '物理'
    && B.mistakeGuessSubject('配平下面的化学方程式') === '化学' && B.mistakeGuessSubject('Choose the best answer to complete the sentence, please.') === '英语'
    && B.mistakeGuessSubject('今天天气不错') === '其他');
}

console.log('\n[2] 错题本：从聊天收');
{
  const chat = {
    id: 'c1', headId: 4,
    nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '在吗' },
      2: { id: 2, parentId: 1, role: 'assistant', content: '在' },
      3: { id: 3, parentId: 2, role: 'user', content: '这题怎么做 [[REACT: 😭]]', images: ['data:image/png;base64,QQ'] },
      // 另一条分支上的回复故意排在前面：只按「第一个孩子」找解析的话会拿到它
      4: { id: 4, parentId: 3, role: 'assistant', content: '另一条分支上的回复' },
      6: { id: 6, parentId: 3, role: 'assistant', content: '<div class="think-block done"><div class="think-toggle">想</div><div class="think-body">内心</div></div></div>先配方：\n\n[[PLOT: y=x^2]]', variants: null }
    }
  };
  chat.headId = 6;
  const path = [chat.nodes[1], chat.nodes[2], chat.nodes[3], chat.nodes[6]];
  const B = sandbox({ getActiveChat: () => chat, getMessagePath: () => path });
  const m = B.mistakeFromNode(3);
  t('★ 点她的消息：题目是这条（带图），解析是当前分支上紧跟着的那条 AI 回复', m.q === '这题怎么做' && m.imgs.length === 1 && /先配方/.test(m.a) && !/另一条分支/.test(m.a), m);
  t('★ 收进来的文字去掉了思考块和 App 指令，画图标签留着（解析里的图还要画）', !/think-block|REACT|内心/.test(m.q + m.a) && /\[\[PLOT: y=x\^2\]\]/.test(m.a));
  const m2 = B.mistakeFromNode(6) || {};
  t('★ 点 AI 的回复：题目往上找它回的那条', m2.q === '这题怎么做' && /先配方/.test(m2.a || ''), m2);
  t('  记下来源（哪个对话哪条消息）', m.from === 'c1:3');
  t('  点的是开头的闲聊也能收（没有题也不崩）', B.mistakeFromNode(1) !== undefined);
}
{
  t('★ 右键菜单项先抄下 _ctxNodeId 再关菜单（关菜单会把它清空）', /const id = typeof _ctxNodeId !== 'undefined' \? _ctxNodeId : null;[^\n]*\n\s*if \(typeof closeMsgContextMenu === 'function'\) closeMsgContextMenu\(\);/.test(mkSrc));
  // ui-polish/chat（A11）：菜单图标改成 data-ic 线条图标，文案里不再带 emoji
  t('  右键菜单里有「错题本」', /<button [^>]*onclick="ctxAddMistake\(\)"[^>]*>(📕 )?错题本<\/button>/.test(read('index.html')));
}

console.log('\n[3] 三道持久化白名单（漏一道就是刷新即失、零报错）');
{
  const st = read('js/02-state.js'), core = read('js/01-core.js'), boot = read('js/14-boot-brain-hub.js');
  for (const k of ['mistakes', 'fcards']) {
    t('★ ' + k + '：_doSave 写 kuro_' + k, new RegExp("idbSet\\('kuro_" + k + "',\\s+JSON\\.stringify\\(state\\." + k).test(st));
    t('★ ' + k + '：loadStateFromDB 读 kuro_' + k, new RegExp(k + ":\\s+await g\\('kuro_" + k + "'").test(core));
    t('★ ' + k + '：启动时赋回 state', new RegExp('state\\.' + k + '\\s+= ').test(boot));
  }
  t('  坏数据当空（一条坏记录别把整个面板打挂）', /state\.mistakes\s+= Array\.isArray\(saved\.mistakes\) \? saved\.mistakes\.filter/.test(boot));
}

console.log('\n[4] 公式卡：内置卡组');
{
  const B = sandbox();
  const F = B.LAB_FORMULAS;
  t('★ id 不重复（进度按 id 存，重复了两张卡共用一份进度）', new Set(F.map(c => c.id)).size === F.length);
  t('★ 三个卡组都有三十张上下', ['数学', '物理', '化学'].every(d => F.filter(c => c.deck === d).length >= 25), ['数学', '物理', '化学'].map(d => F.filter(c => c.deck === d).length));
  t('★ 每张的 $ 都成对（不成对的话整张卡的公式都不排版，看到一堆 LaTeX 源码）', F.every(c => ((c.back.match(/\$/g) || []).length % 2) === 0), F.filter(c => ((c.back.match(/\$/g) || []).length % 2) !== 0).map(c => c.id));
  t('  化学方程式用 \\mathrm（正体），反应条件用 \\xlongequal / \\overset', F.filter(c => c.deck === '化学' && /[A-Z][a-z]?_?\d/.test(c.back)).every(c => /\\mathrm\{/.test(c.back)));
  t('  几条关键内容：Cl₂+H₂O 可逆、铝和碱按新教材写 Na[Al(OH)₄]、第一宇宙速度 7.9', /Cl_2\+H_2O\\rightleftharpoons/.test(F.find(c => c.id === 'c05').back)
    && /Na\[Al\(OH\)_4\]/.test(F.find(c => c.id === 'c07').back) && /7\.9/.test(F.find(c => c.id === 'p11').back));
  const tex = B.fcardTex('$\\mathrm{MnO_2+4HCl(浓)\\xlongequal{\\triangle}MnCl_2}$ 和 $\\text{已包好}+x_{合}$');
  t('★ LaTeX 里的汉字包进 \\text{}（KaTeX 数学模式里不认汉字），已经包过的不重复包',
    /HCl\(\\text\{浓\}\)/.test(tex) && /\\text\{已包好\}/.test(tex) && !/\\text\{\\text/.test(tex) && /x_\{\\text\{合\}\}/.test(tex), tex);
  t('  $ 外面的汉字不动', B.fcardTex('和 $x$ 一起') === '和 $x$ 一起');
}

console.log('\n[5] 公式卡：复习');
{
  const B = sandbox();
  const now = 1_700_000_000_000;
  const p1 = B.fcardGrade('m01', 2, now);
  t('★ 新卡第一次「会」→ 第一格（1 天后）', p1.step === 0 && p1.due === now + DAY);
  B.fcardGrade('m01', 2, now);
  t('★ 再「会」→ 第二格（2 天后）', B.state.fcards.prog.m01.step === 1 && B.state.fcards.prog.m01.due === now + 2 * DAY);
  B.fcardGrade('m01', 1, now);
  t('★ 「模糊」→ 原地、明天', B.state.fcards.prog.m01.step === 1 && B.state.fcards.prog.m01.due === now + DAY);
  B.fcardGrade('m01', 0, now);
  t('★ 「不会」→ 回第一格、明天', B.state.fcards.prog.m01.step === 0 && B.state.fcards.prog.m01.due === now + DAY);
  B.state.fcards.prog = { m02: { step: 1, due: now - 10 }, m03: { step: 1, due: now - 99 }, m04: { step: 2, due: now + 9 * DAY } };
  const q = B.fcardQueue('数学', now);
  t('★ 一轮：先到期的（早到期的在前），再补新卡，新卡一轮最多 10 张', q[0].id === 'm03' && q[1].id === 'm02' && !q.some(c => c.id === 'm04')
    && q.slice(2).every(c => !B.state.fcards.prog[c.id]) && q.length === 12, q.map(c => c.id));
  const a = B.fcardAddCustom('动能定理', '$W=\\Delta E_k$');
  const b = B.fcardAddCustom('动能定理', '$W=\\Delta E_k$');
  t('  自己加的卡进「我的」，同一张不重复收', a.deck === '我的' && a === b && B.state.fcards.custom.length === 1);
  t('  正面或背面空着不收', B.fcardAddCustom('', 'x') === null && B.fcardAddCustom('x', ' ') === null);
}

console.log('\n[6] 聊天里的公式卡');
{
  const B = sandbox();
  const h = B.fcardTagToHtml('[[FCARD: 绝对值不等式 | $|a|-|b|\\le|a+b|\\le|a|+|b|$]]');
  t('★ 只按第一个竖线切：背面里的绝对值竖线不会被切断', /data-back="\$\|a\|-\|b\|\\le\|a\+b\|\\le\|a\|\+\|b\|\$"/.test(h), h.slice(0, 200));
  t('★ 收藏按钮挂在她的点击上（渲染时不加卡）', /onclick="fcardAddFromChat\(this\)"/.test(h) && B.state.fcards.custom === undefined);
  const x = B.fcardTagToHtml('[[FCARD: <img src=x onerror=1> | <script>1</script>]]');
  t('★ 正面背面都转义', !/<img src=x|<script>/.test(x));
  t('★ 流式遮罩', B.maskStreamingFcard('a [[FCARD: 名 | $x$]] b') === 'a 〔📐〕 b' && B.maskStreamingFcard('看 [[FCARD: 动能') === '看 〔…〕');
  const prompts = read('js/05-prompts-api.js');
  const skill = (prompts.match(/if \(skillOn\('fcard'\)\) base \+= `([\s\S]*?)`;/) || [])[1] || '';
  const example = (skill.match(/比如 (\[\[FCARD:[^\]]*\]\])/) || [])[1] || '';
  // 模板字符串里的 \\Delta 到了运行时是 \Delta
  const exRuntime = example.replace(/\\\\/g, '\\');
  t('★ 提示词里的示例本身能被解析（示例写坏了，模型照着写的全都画不出来）', !!exRuntime && B.fcardTagRe().test(exRuntime) && /\\Delta/.test(exRuntime), exRuntime);
}

console.log('\n[7] 接线');
{
  const media = read('js/12-math-media.js'), prompts = read('js/05-prompts-api.js'), html = read('index.html');
  t('★ 渲染层调 fcardTagToHtml', /if \(typeof fcardTagToHtml === 'function'\) text = fcardTagToHtml\(text\);/.test(media));
  t('★ 流式遮罩登记', /const _STREAM_MASKS = \[[^\]]*'maskStreamingFcard'/.test(prompts));
  t('★ 技能开关表里有 fcard', /\{ key: 'fcard',\s+tok: \d+,/.test(prompts));
  t('★ 页面加载 57、58，有两个面板和「学习」架子上的入口', /<script src="\.\/js\/57-mistakes\.js"><\/script>/.test(html) && /<script src="\.\/js\/58-formulas\.js"><\/script>/.test(html)
    && /id="mistakeModal"/.test(html) && /id="formulaModal"/.test(html) && /<span>学习<\/span>[\s\S]*?openWidget\(openMistakes\)[\s\S]*?openWidget\(openFormulas\)/.test(html));
  t('  内置卡组懒加载', !/<script[^>]*labdata\/formulas/.test(html) && /'\.\/js\/labdata\/formulas\.js'/.test(fcSrc));
  t('  面板里的删除函数不叫 delete*/remove*（渲染消毒会拔掉这种 onclick）', !/function (delete|remove)\w*\(/.test(mkSrc + fcSrc));
}

console.log('\n[8] 安卓副本');
for (const f of ['js/57-mistakes.js', 'js/58-formulas.js', 'js/labdata/formulas.js']) {
  const a = path.join(ROOT, 'android/assets', f);
  t('★★ android 副本与 ' + f + ' 一致', fs.existsSync(a) && fs.readFileSync(a, 'utf8') === read(f));
}

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
