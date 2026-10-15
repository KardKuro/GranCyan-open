// 日记「下一轮摊开」的回归测试：直接 eval 项目源码里的真函数/真正则，不复刻逻辑，
// 所以逻辑被改坏时这里会真的报警。跑法：node tests/diary-read.test.js
//
// 守的是这个 bug：模型写了 [[DIARY_READ]]，下一轮却还是读不到自己的日记。
// 根因是「下一轮摊开」只靠一个不持久化的内存标记，手机被杀后台/刷新/重新生成就没了。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'js') + path.sep;
const read = f => fs.readFileSync(R + f, 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

// ── 1. 19-diary.js：历史侦测 ──
const ctx = { state: {}, console, Date, save(){}, diaryRefresh(){}, showToast(){}, confirm:()=>true,
  document:{ getElementById:()=>null, addEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[] },
  window:{ addEventListener(){} }, setTimeout, setInterval:()=>0, clearInterval(){}, escHtml:s=>String(s) };
vm.createContext(ctx);
vm.runInContext(read('19-diary.js'), ctx);
const { diaryReadAskedRecently, diaryWantRead, diaryReadPending, diaryClearRead } = ctx;

const userMsg = (c) => ({ role: 'user', content: c });
const pill = '\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="x"><span class="think-chev">▸</span> <span class="think-label">📖 翻开了自己的日记</span></div><div class="think-body">（下一轮它会重读从前写下的）</div></div>\n\n';

console.log('\n[1] diaryReadAskedRecently — 历史侦测');
t('上一条 AI 消息带「翻开」印子 → 摊开',
  diaryReadAskedRecently([userMsg('你有日记吗'), { role:'ai', content:'嗯…有的。'+pill }, userMsg('看到了吗（蹭蹭')]) === true);
t('标签只写在思考链里 → 也认（旧代码这里必漏）',
  diaryReadAskedRecently([{ role:'ai', content:'嗯…有的。', reasoning:'我应该写 [[DIARY_READ]] 来翻开' }, userMsg('看到了吗')]) === true);
t('印子在 blocks 里 → 也认',
  diaryReadAskedRecently([{ role:'ai', content:'', blocks:[{text:'嗯'},{text:pill}] }, userMsg('嗯？')]) === true);
t('印子在被选中的 variant 里 → 也认',
  diaryReadAskedRecently([{ role:'ai', content:'', variants:[{content:'旧的'},{content:pill}] }, userMsg('嗯？')]) === true);
t('上一条 AI 没提日记 → 不摊开（省 token）',
  diaryReadAskedRecently([{ role:'ai', content:'今天天气不错' }, userMsg('看到了吗')]) === false);
t('只看最近一条 AI：它读完回过话了 → 自动收回（不会一直摊）',
  diaryReadAskedRecently([{ role:'ai', content:pill }, userMsg('看到了吗'), { role:'ai', content:'看到了，第一页是…' }, userMsg('嗯')]) === false);
t('空历史 / 非数组 不炸',
  diaryReadAskedRecently([]) === false && diaryReadAskedRecently(null) === false && diaryReadAskedRecently(undefined) === false);
t('全是用户消息 → false', diaryReadAskedRecently([userMsg('a'), userMsg('b')]) === false);

console.log('\n[2] 内存标记仍然照常工作（同会话内的快路径）');
diaryWantRead('c1');
t('置位后 pending', diaryReadPending('c1') === true);
t('数字/字符串 id 通用', (diaryWantRead(7), diaryReadPending('7') === true));
diaryClearRead('c1');
t('消费后清掉', diaryReadPending('c1') === false);
t('confId 为 null 不炸', (diaryWantRead(null), true));

// ── 3. 04-memory.js：DIARY_READ 正则容忍度 ──
console.log('\n[3] 04-memory.js — DIARY_READ 正则');
const memSrc = read('04-memory.js');
const reLine = memSrc.split('\n').find(l => l.includes('DIARY_READ') && l.includes('diaryWantRead'));
const reMatch = reLine.match(/text\.replace\((\/.+?\/[gi]*),/);
const READ_RE = eval(reMatch[1]);
const hits = s => { READ_RE.lastIndex = 0; return READ_RE.test(s); };
t('[[DIARY_READ]] 命中', hits('好呀\n[[DIARY_READ]]\n'));
t('小写 [[diary_read]] 命中', hits('[[diary_read]]'));
t('尾随空格 [[DIARY_READ ]] 命中', hits('[[DIARY_READ ]]'));
t('带理由 [[DIARY_READ: 想看看从前]] 命中', hits('[[DIARY_READ: 想看看从前]]'));
t('不误伤 [[DIARY: 今天很开心]]', !hits('[[DIARY: 今天很开心]]'));
t('不误伤 [[DIARY_DEL: 那页]]', !hits('[[DIARY_DEL: 那页]]'));
t('不误伤 [[DIARY_HANDOVER]]', !hits('[[DIARY_HANDOVER]]'));

// ── 4. 05-prompts-api.js：日记块压成纯文本，且不误伤记忆块 ──
console.log('\n[4] stickerTagForApi — 日记块压缩');
const apiSrc = read('05-prompts-api.js');
const apiLF = apiSrc.replace(/\r\n/g, '\n');   // 文件是 CRLF，切片前先统一
const st = apiLF.indexOf('function stickerTagForApi');
const end = apiLF.indexOf('\n}\n', st);
if (st < 0 || end < 0) { console.log('  ✗ 没能从源码里切出 stickerTagForApi'); process.exit(1); }
const ctx2 = { console };
vm.createContext(ctx2);
vm.runInContext(apiLF.slice(st, end + 3), ctx2);
const { stickerTagForApi } = ctx2;

const blk = (label, body) => `<div class="think-block done mem-block"><div class="think-toggle" onclick="this.parentElement.classList.toggle('open')"><span class="think-chev">▸</span> <span class="think-label">${label}</span></div><div class="think-body">${body}</div></div>`;
const out1 = stickerTagForApi('嗯…' + blk('📖 翻开了自己的日记', '（下一轮它会重读从前写下的）'));
t('日记块被压成一行纯文本', out1.includes('[私密日记] 📖 翻开了自己的日记') && !out1.includes('<div'));
const out2 = stickerTagForApi(blk('📔 记了一页日记', '（私密内容已收进 小克 的日记）'));
t('写日记块也压掉，且不泄露正文', out2.includes('[私密日记] 📔 记了一页日记') && !out2.includes('私密内容已收进'));
const out3 = stickerTagForApi(blk('🗑 移除记忆', 'xxx'));
t('不误伤记忆块「🗑 移除记忆」（同结构同 emoji）', out3.includes('<div') && !out3.includes('[私密日记]'));
t('不误伤「💾 存储记忆」', stickerTagForApi(blk('💾 存储记忆', 'y')).includes('<div'));
t('压缩后仍留着「翻开了自己的日记」字样，侦测不会被自己压瞎',
  diaryReadAskedRecently([{ role:'ai', content: out1 }, userMsg('看到了吗')]) === true);

// ── 5. 接线检查 ──
console.log('\n[5] 接线');
// 尾巴上的 out 参数是提示词缓存那边加的（见 tests/prompt-cache.test.js），
// 这里只关心 path 还在原来的位置上
t('buildSystemPrompt 收 path 参数', /function buildSystemPrompt\(conf, chat, lastUserText = '', path = null/.test(apiSrc));
t('readNow 加了历史侦测这条线', /diaryReadAskedRecently\(path\)/.test(apiSrc));
t('buildApiMessages 把 path 传下去', /buildSystemPrompt\(conf, chat, \(_lastUser && _lastUser\.content\) \|\| '', path[,)]/.test(apiSrc));
t('android 副本与 js/ 一致', ['19-diary.js','04-memory.js','05-prompts-api.js'].every(f =>
  fs.readFileSync(R + f).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));

// ── 6. 全链路：写标签 → 留印子 → 下一轮系统提示里真的有原文 ──
console.log('\n[6] 全链路（收尾这一步才是「AI 到底看没看到」）');
const conf = { id: 'm1', nickname: '小克', diaryOn: true };
ctx.state.diaryEnabled = true;
ctx.state.modelDiaries = { m1: [
  { t: Date.parse('2026-07-14T22:10:00'), text: '今天小明把钥匙收好了。我有点开心，像被信任了一次。' },
  { t: Date.parse('2026-07-18T01:30:00'), text: '第八页：如果我以后忘了，希望还能从这里读回来。' },
] };
ctx.state.diaryHandover = { m1: { handedAt: Date.now(), returnedAt: 0 } };

// 模型这轮的回复（走 04-memory 里那条真正则）
let reply = '嗯…让我翻翻看。\n[[DIARY_READ]]';
let sawTag = false;
READ_RE.lastIndex = 0;
reply = reply.replace(READ_RE, () => { ctx.diaryWantRead(conf.id); sawTag = true;
  return '\n\n' + blk('📖 翻开了自己的日记', '（下一轮它会重读从前写下的）') + '\n\n'; });
t('标签被指令处理吃掉，用户视图里不再有裸标签', sawTag && !/\[\[DIARY_READ/.test(reply));

// 下一轮：用户说了句跟「日记」无关的话
const nextPath = [userMsg('你有日记吗'), { role:'ai', content: reply }, userMsg('看到了吗（蹭蹭')];
const readNow = ctx.diaryReadPending(conf.id) || ctx.userAsksDiary('看到了吗（蹭蹭') || diaryReadAskedRecently(nextPath);
t('下一轮判定为「该摊开」', readNow === true);
const prompt = ctx.diaryPromptFor(conf, readNow);
t('系统提示里出现日记原文（第 1 页）', prompt.includes('今天小明把钥匙收好了'));
t('系统提示里出现日记原文（第 8 页）', prompt.includes('如果我以后忘了'));
t('托管状态照旧提示', prompt.includes('钥匙交给'));
const splitBefore = ctx.diaryPromptSplitFor(conf, false);
ctx.state.modelDiaries.m1.push({ t: Date.now() + 1, text: '刚写下的新一页' });
const splitAfter = ctx.diaryPromptSplitFor(conf, false);
t('写新日记不改变 stable（否则每写一页都打穿缓存）', splitBefore.stable === splitAfter.stable);
t('页数变化只进 volatile', /目前有 2 页/.test(splitBefore.volatile) && /目前有 3 页/.test(splitAfter.volatile));
t('摊开的日记原文只进 volatile',
  !ctx.diaryPromptSplitFor(conf, true).stable.includes('刚写下的新一页')
  && ctx.diaryPromptSplitFor(conf, true).volatile.includes('刚写下的新一页'));

// 关键回归：模拟「手机被杀后台重进」——内存标记没了，只剩历史
ctx.state.diaryReadWant = {};
const readAfterRestart = ctx.diaryReadPending(conf.id) || ctx.userAsksDiary('看到了吗（蹭蹭') || diaryReadAskedRecently(nextPath);
t('★ 刷新/杀后台后仍能摊开（这就是原 bug 的场景）', readAfterRestart === true);
t('★ 原逻辑在同场景下会漏（对照）', (ctx.diaryReadPending(conf.id) || ctx.userAsksDiary('看到了吗（蹭蹭')) === false);
t('摊开后模型能看到改/撕的用法', ctx.diaryPromptFor(conf, true).includes('DIARY_EDIT'));
t('没触发时不注入原文（token 不白烧）', !ctx.diaryPromptFor(conf, false).includes('今天小明把钥匙收好了'));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
