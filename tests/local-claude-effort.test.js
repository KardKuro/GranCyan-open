'use strict';
// 订阅 Claude 的思考力度（effort）选择 —— 用户：「AI不是有非常多档思考等级吗，给订阅克加选择 ui」
//
// 只有一条路：官方 CLI 的 `--effort <level>`（带图的轮也走同一条 CLI 路，只是 stdin 换成 stream-json）。
// 会静默出错的地方：
//   · 坏值：CLI 碰到不认的值只打一行 Warning 就按默认跑 —— 她以为选了「最高」，其实是默认
//   · 老型号：Haiku 4.5 / Sonnet 4.5 不认 effort（API 传了会 400）；4.6 没有 xhigh（Haiku 5.5 五档全认）
//   · 漏接：前端存了、请求体没带，或者 server 收了没往 args 里塞 —— 全链路零报错
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

const server = read('server.js');
const models = read('js/03-chats-models.js');
const prompts = read('js/05-prompts-api.js');

// 从 server.js 抠出 isAdaptiveOnlyClaude + claudeEffortFor 单独跑
function slice(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  return i >= 0 && j > i ? src.slice(i, j) : '';
}
// 按函数自己的右大括号截，不按空行截：函数体里多一个空行就会被截断、整个测试崩掉（一条 ✗ 都打不出来）
const effStart = server.indexOf('const CLAUDE_EFFORTS = ');
const effEnd = server.indexOf('\n}\n', server.indexOf('function claudeEffortFor(', effStart));
const code = slice(server, 'function isAdaptiveOnlyClaude(', '\n// 前端选「默认」时')
  + '\n' + (effStart >= 0 && effEnd > effStart ? server.slice(effStart, effEnd + 2) : '');
const box = { String };
vm.createContext(box);
vm.runInContext(code + ';this.claudeEffortFor=claudeEffortFor;this.CLAUDE_EFFORTS=CLAUDE_EFFORTS;', box);
const f = box.claudeEffortFor;

console.log('\n[1] 哪一档哪个型号认');
t('★ 白名单正好是 CLI 认的五档', JSON.stringify(box.CLAUDE_EFFORTS) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']));
t('★ 5 代五档原样传（Sonnet 5.5 / Opus 5.5 / Fable 5.1）',
  ['low', 'medium', 'high', 'xhigh', 'max'].every(e => f(e, 'claude-sonnet-5-5') === e && f(e, 'claude-opus-5-5') === e && f(e, 'claude-fable-5-1') === e));
t('  4.7 / 4.8 也是五档', f('xhigh', 'claude-opus-4-7') === 'xhigh' && f('max', 'claude-opus-4-8') === 'max');
t('★ 4.6 没有 xhigh → 按 high，其余照传', f('xhigh', 'claude-sonnet-4-6') === 'high' && f('max', 'claude-opus-4-6') === 'max' && f('low', 'claude-opus-4-6') === 'low');
t('  Opus 4.5 只有三档：xhigh/max → high', f('xhigh', 'claude-opus-4-5') === 'high' && f('max', 'claude-opus-4-5') === 'high' && f('medium', 'claude-opus-4-5') === 'medium');
t('★ Haiku 5.5 五档原样传（第一个认 effort 的 Haiku）',
  ['low', 'medium', 'high', 'xhigh', 'max'].every(e => f(e, 'claude-haiku-5-5') === e));
t('★ Haiku 4.5 / Sonnet 4.5 不传（传了会 400）', f('high', 'claude-haiku-4-5-20251001') === '' && f('low', 'claude-sonnet-4-5') === '');
t('★ 前后端两份 isAdaptiveOnlyClaude 正则一字不差（haiku-5 只加一边＝思考链/temperature 一边对一边 400）',
  (() => {
    const re = s => (s.match(/function isAdaptiveOnlyClaude\([^)]*\)\s*\{\s*return (\/[^\n]*?\/)\.test/) || [])[1];
    const front = re(prompts);
    return !!front && front === re(server) && /haiku-5/.test(front);
  })());
t('★ 坏值不传（CLI 会静默按默认跑，与其传一个没用的值不如明着不传）', f('bogus', 'claude-sonnet-5-5') === '' && f('ultra', 'claude-opus-5') === '' && f('', 'claude-opus-5') === '');
t('  读不出 CLI 默认模型时交给 CLI 自己判', f('xhigh', '') === 'xhigh');

console.log('\n[2] server 那条 CLI 路接上了');
const cliRoute = slice(server, "app.post('/api/local-claude'", "\napp.post(");
t('★ CLI 那条：按解析后的型号修正，再 push --effort', /const effortArg = claudeEffortFor\(req\.body\.effort, resolveLocalClaudeModel\(model\)\);\s*\n\s*if \(effortArg\) args\.push\('--effort', effortArg\);/.test(cliRoute));
t('  spawn 日志里写着这轮用的力度（排查「选了没生效」用）', /力度=\$\{effortArg \|\| '默认'\}/.test(server));
t('★ 带图不再绕开 CLI（没有第二条直连路，力度对带图的轮一样生效）', !/handleLocalClaudeWithImages|output_config/.test(server));

console.log('\n[3] 前端：会话栏上的下拉 + 存 + 发');
t('★ setLocalClaudeEffort 存到订阅 Claude 那个 config 的 localEffort', /function setLocalClaudeEffort\(effort\) \{\s*\n\s*const conf = ensureLocalClaudeConfig\(\);\s*\n\s*conf\.localEffort = effort;\s*\n\s*save\(\);/.test(models));
{
  const sel = slice(models, 'onchange="setLocalClaudeEffort(this.value)"', '</select>');
  const vals = (sel.match(/\['(\w*)', '🎚/g) || []).map(s => s.slice(2, s.indexOf("'", 2)));
  t('★ 下拉里六个选项：默认 + 五档（和 server 白名单一致）', JSON.stringify(vals) === JSON.stringify(['', 'low', 'medium', 'high', 'xhigh', 'max']), vals);
  t('  回显当前选中的那档', /c\.isLocalClaude\)\?\.localEffort\) \|\| ''/.test(sel));
}
t('★ 请求体带 effort（只给订阅 Claude 带）', /effort: conf\.isLocalClaude \? \(conf\.localEffort \|\| ''\) : undefined,/.test(prompts));
{
  const bar = slice(models, "${isLocalClaudeOnly() ? `", "` : ''}");
  t('  下拉在订阅 Claude 的会话栏里（和模型、思考链并排）', bar.includes('setLocalClaudeEffort') && bar.includes('setLocalClaudeThinking'));
}

console.log('\n[4] 后台小活儿（claudeOnce）用便宜型号（它走 CLI 的那些细节在 server-fixes.test.js [J] 真跑）');
t('  起草和看图的默认型号是 Haiku 5.5',
  /DRAFT_MODEL = [^;]*\|\| 'claude-haiku-5-5'/.test(read('social-browser.js')) && /IMG_DESCRIBE_MODEL = [^;]*\|\| 'claude-haiku-5-5'/.test(server));
console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
