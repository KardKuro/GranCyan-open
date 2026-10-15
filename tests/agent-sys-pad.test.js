// 电脑操控档的系统提示别再自相矛盾 + 拉起的 CLI 会话带名字
// 跑法：node tests/agent-sys-pad.test.js
//
// 背景（2026-10-10）：翻施工机的会话记录，系统提示是「施工单 → 电脑操控模式：你能用 Bash…」，
// 后面又垫了一段缓存用的对话守则，第 5 条写着「绝不使用任何工具、不读写文件、不执行命令」。
// 另外 GranCyan 拉起的每只 claude -p 在会话列表里都叫「Below is the conversation so far…」，
// 用户分不清哪只施工机在做哪张单。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// 真源码抠出来跑（const 不挂 context，结尾手动导出）
const a = server.indexOf("const DEFAULT_SYS = '");
const b = server.indexOf('// ── 会话续传', a);
if (a < 0 || b < 0) throw new Error('抠不到 DEFAULT_SYS → 会话续传 这一段（server.js 结构变了？）');
const ctx = { String, RegExp, Array };
vm.createContext(ctx);
vm.runInContext(server.slice(a, b)
  + '\nthis.out = { DEFAULT_SYS, DEFAULT_SYS_TOOLS, CACHE_PAD, CACHE_PAD_TOOLS, padSystemPrompt, localSessionName };', ctx);
const { DEFAULT_SYS, DEFAULT_SYS_TOOLS, CACHE_PAD, CACHE_PAD_TOOLS, padSystemPrompt, localSessionName } = ctx.out;
const NO_TOOLS = /绝不使用任何工具|不执行命令/;

console.log('\n[1] 垫片');
t('★ 带工具那份真的换掉了（原文改一个字 replace 就静默落空，两份会一模一样）',
  CACHE_PAD_TOOLS !== CACHE_PAD && !NO_TOOLS.test(CACHE_PAD_TOOLS));
// 纯聊天档带着 WebSearch/WebFetch/GitHub，守则不能再说「不访问网络」（2026-10-10）
t('★ 纯聊天档的守则不再禁止上网，并且说了可以读网页',
  !/不访问网络|绝不使用任何工具/.test(CACHE_PAD) && /读取网页/.test(CACHE_PAD)
  && !/绝不使用任何工具/.test(DEFAULT_SYS) && /上网/.test(DEFAULT_SYS));
t('其余守则一字不少（只动第 5 条那半句）',
  CACHE_PAD_TOOLS.split('\n').length === CACHE_PAD.split('\n').length && /16\. 收尾自然/.test(CACHE_PAD_TOOLS));
const shortSys = '施工单：改个按钮\n\n---\n# 电脑操控模式\n你现在能用 Bash';
t('★ 电脑操控档：垫完不再说「不执行命令」', !NO_TOOLS.test(padSystemPrompt(shortSys, { tools: true })));
t('纯聊天档原样不动（缓存前缀一个字节都不能变）', padSystemPrompt('人设') === '人设' + CACHE_PAD);
t('够长不垫，两档都一样', padSystemPrompt('x'.repeat(2000), { tools: true }) === 'x'.repeat(2000));
t('没传人设时的兜底：带工具那份也不说「不执行命令」', NO_TOOLS.test(DEFAULT_SYS) && !NO_TOOLS.test(DEFAULT_SYS_TOOLS));

console.log('\n[2] 接线');
t('★ 电脑操控或浏览器开着就用带工具的垫片', /\{ tools: !!\(agent \|\| browser\) \}\);/.test(server));
t('没传人设时按档挑兜底', /\|\| \(agent \? DEFAULT_SYS_TOOLS : DEFAULT_SYS\)\)/.test(server));
t('★ 会话名用 --name 传给 CLI，续传时不传（续传的会话早就有名了）',
  /if \(sessionName && !resumeEntry\) args\.push\('--name', sessionName\);/.test(server));

console.log('\n[3] 会话名清洗');
t('换行和控制字符压成一个空格', localSessionName('🏗 改\n按钮\t颜色\x07') === '🏗 改 按钮 颜色');
t('开头的 - 去掉（不让 CLI 当成参数）', localSessionName('--resume x') === 'resume x');
t('最多 60 个字（按字符算，emoji 不劈半）', [...localSessionName('🏗' + '字'.repeat(100))].length === 60
  && localSessionName('🏗' + '字'.repeat(100)).startsWith('🏗'));
t('没给就是空串（不传 --name）', localSessionName(undefined) === '' && localSessionName('  \n ') === '');

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
