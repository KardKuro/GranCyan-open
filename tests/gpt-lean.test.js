'use strict';
// 订阅 GPT 省 token（gptLeanArgs，2026-10-07）。
// Codex 每开一条线程默认塞 17.7k 字编程基础指令 + 21.7k 字技能清单 + 项目 AGENTS.md，
// 「你好」一句首轮 19k token；精简后 7k。这份守的是「该关的关了、该留的留着」：
//   · 电脑操控必须留着 Codex 原装基础指令、权限说明和工具（它要干活）
//   · code_mode_host 绝不能关（关了 Codex 报 error item）
//   · 参数真的接进了 spawn，而不是函数写了没人调
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\r\n').join('\n');

let fail = 0;
function t(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function sourceBetween(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('切不出源码片段：' + from + ' → ' + to);
  return src.slice(a, b);
}

const fnSrc = sourceBetween(serverSrc, 'const GPT_CHAT_BASE', '\nfunction gptLog(');
const os = require('node:os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-lean-'));
const box = { fs, path, os: { tmpdir: () => tmp }, process: { env: {} } };
vm.createContext(box);
vm.runInContext(fnSrc + '\nthis.f = gptLeanArgs;', box);

const chat = box.f(false), agent = box.f(true);
const has = (arr, s) => arr.join(' ').includes(s);
const disabled = arr => arr.flatMap((x, i) => x === '--disable' ? [arr[i + 1]] : []);

console.log('\n[1] 两种模式都关掉白塞的说明块');
for (const [name, a] of [['聊天', chat], ['电脑操控', agent]]) {
  t(`${name}：关技能清单说明`, has(a, 'include_skills_usage_instructions=false'), a);
  t(`${name}：关插件/应用说明`, has(a, 'include_plugin_usage_instructions=false') && has(a, 'include_apps_instructions=false'));
}

console.log('\n[2] 聊天：换基础指令、不读 AGENTS.md、精简工具');
const m = chat.join(' ').match(/model_instructions_file=("[^"]+")/);
t('★ 聊天换了基础指令文件', !!m, chat);
const baseFile = m && JSON.parse(m[1]);
t('基础指令文件真的写出来了、内容是聊天用的那段', !!baseFile && fs.existsSync(baseFile) && /not a coding agent/.test(fs.readFileSync(baseFile, 'utf8')));
t('基础指令里指明人格在 System instructions（prompt 里就是这么写的）',
  fs.readFileSync(baseFile, 'utf8').includes('"System instructions"') && serverSrc.includes("'System instructions:',"));
t('不读项目 AGENTS.md', has(chat, 'project_doc_max_bytes=0'));
t('聊天显示不了的工具关掉了', ['image_generation', 'computer_use', 'browser_use'].every(f => disabled(chat).includes(f)), disabled(chat));
t('★ code_mode_host 两边都没关', !disabled(chat).includes('code_mode_host') && !disabled(agent).includes('code_mode_host'));
t('聊天还留着 shell（她发链接让它看要用）', !disabled(chat).some(f => /shell_tool|unified_exec/.test(f)), disabled(chat));

console.log('\n[3] 电脑操控：原装基础指令和工具都留着');
t('★ 电脑操控不换基础指令', !has(agent, 'model_instructions_file'), agent);
t('★ 电脑操控一个工具都不关', disabled(agent).length === 0, disabled(agent));
t('电脑操控留着权限说明和项目 AGENTS.md', !has(agent, 'include_permissions_instructions') && !has(agent, 'project_doc_max_bytes'));

console.log('\n[4] 退路和接线');
box.process.env.GRANCYAN_GPT_LEAN = '0';
t('GRANCYAN_GPT_LEAN=0 回到原装', box.f(false).length === 0 && box.f(true).length === 0);
const spawnPart = sourceBetween(serverSrc, "'--disable', 'shell_snapshot',", "if (!GPT_USES_OPENAI_LOGIN) args.push(");
t('★ spawn 参数接上了 gptLeanArgs(!!agent)', spawnPart.includes('...gptLeanArgs(!!agent)'), spawnPart.slice(-200));

fs.rmSync(tmp, { recursive: true, force: true });
if (fail) { console.error(`\n❌ ${fail} 条失败`); process.exit(1); }
console.log('\n✅ gpt-lean 全部通过');
