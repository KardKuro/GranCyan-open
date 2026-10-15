'use strict';
// 订阅 Claude 的型号别名 —— `/model` 往 settings.json 存的常常是别名（opus / sonnet …）。
// CLI 自己认，但思考链 / 力度的型号判定认不出别名 → 选「默认」时静默丢思考。
// 所以 resolveLocalClaudeModel 把别名翻成全名、剥掉 `[1m]` 这类档位后缀。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
function slice(a, b) {
  const i = server.indexOf(a), j = server.indexOf(b, i + 1);
  return i >= 0 && j > i ? server.slice(i, j) : '';
}

const aliasSrc = slice('const CLAUDE_MODEL_ALIASES', '\n// 思考力度（effort）');
t('抠得到别名表 + resolveLocalClaudeModel', aliasSrc.includes('function resolveLocalClaudeModel'));
const ctx = { cliDefault: '' };
vm.createContext(ctx);
vm.runInContext('function claudeCliDefaultModel() { return cliDefault; }\n' + aliasSrc
  + '\nthis.resolve = resolveLocalClaudeModel;', ctx);
const r = (m, def) => { ctx.cliDefault = def || ''; return ctx.resolve(m); };

t('★ 默认 + settings.json 存的是 opus → 全名', r('', 'opus') === 'claude-opus-5-5', r('', 'opus'));
t('★ 显式传别名也翻', r('sonnet') === 'claude-sonnet-5-5' && r('Haiku') === 'claude-haiku-4-5-20251001', [r('sonnet'), r('Haiku')]);
t('全名原样放行', r('claude-opus-4-8') === 'claude-opus-4-8');
t('[1m] 档位后缀剥掉', r('claude-fable-5[1m]') === 'claude-fable-5', r('claude-fable-5[1m]'));
t('都读不出来保持空串（调用方自己兜底）', r('', '') === '');

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
