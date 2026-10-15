'use strict';
// 历史里每条用户消息带发送时间（msgSentStamp）。
// 用户：「让 AI 分清楚对话框每条聊天消息发的时间。不然就可以看到克一直在那里说自己上一条看错了时间」
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'js', '05-prompts-api.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function main() {
  const a = api.indexOf('async function buildApiMessages(');
  const b = api.indexOf('// ═══════════════════════════════════════════════════════\n// WEB SEARCH', a);
  if (a < 0 || b < 0) throw new Error('抠不到 buildApiMessages');
  const box = {
    console: { log() {}, warn() {}, error() {} }, state: {},
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, RegExp, Error,
    setTimeout, clearTimeout,
    buildSystemPrompt: (conf, chat, last, p, out) => { out.stable = 'SYS'; out.volatile = ''; return 'SYS'; },
    estimateTokens: s => Math.ceil(String(s || '').length / 2),
    stickerTagForApi: s => String(s || ''),
    showToast() {}, _ctxWarnedFor: new Set(), save() {},
  };
  vm.createContext(box);
  vm.runInContext(api.slice(a, b) + '\nthis.buildApiMessages = buildApiMessages; this.msgSentStamp = msgSentStamp;', box);

  console.log('\n[1] 时间格式');
  // 2026-10-10 06:03 UTC = 上海 14:03，周六
  const ts = Date.UTC(2026, 9, 10, 6, 3, 27);
  t('★ 上海时区的绝对时间 + 星期', box.msgSentStamp(ts) === '[2026-10-10 周六 14:03]', box.msgSentStamp(ts));
  t('★ 跨零点按上海算（UTC 16:30 = 上海次日 00:30）',
    box.msgSentStamp(Date.UTC(2026, 9, 10, 16, 30)) === '[2026-10-11 周日 00:30]', box.msgSentStamp(Date.UTC(2026, 9, 10, 16, 30)));
  t('★ 没有时间戳的老消息不标', box.msgSentStamp(undefined) === '' && box.msgSentStamp(0) === '' && box.msgSentStamp('x') === '');

  console.log('\n[2] 拼进历史');
  const conf = { id: 'm1', nickname: '克', maxTokens: 200000, maxReplyTokens: 4000 };
  const p = [
    { id: 1, role: 'user', content: '早', timestamp: Date.UTC(2026, 9, 8, 1, 0) },
    { id: 2, role: 'ai', content: '早呀', modelId: 'm1', timestamp: Date.UTC(2026, 9, 8, 1, 1) },
    { id: 3, role: 'user', content: '我回来了', timestamp: ts },
    { id: 4, role: 'user', content: '', images: [], timestamp: undefined }
  ];
  const msgs = await box.buildApiMessages(p, conf, false, { id: 'c1' });
  const byText = s => msgs.find(m => typeof m.content === 'string' && m.content.includes(s));
  t('★ 用户消息开头是她发出那一刻的时间', byText('早') && byText('早').content === '[2026-10-08 周四 09:00]\n早', JSON.stringify(msgs[1]));
  t('★ 隔了两天的那条也是自己的时间', byText('我回来了').content === '[2026-10-10 周六 14:03]\n我回来了');
  const ai = msgs.find(m => m.role === 'assistant');
  t('★ AI 自己的消息不标（标了它会学着在回复开头写时间戳）', ai && ai.content === '早呀', ai && ai.content);

  const again = await box.buildApiMessages(p, conf, false, { id: 'c1' });
  t('★ 每轮逐字节一样（不用相对时间，提示缓存不会被打废）', JSON.stringify(again) === JSON.stringify(msgs));

  console.log('\n[3] 系统提示说清楚那是系统标的');
  const sp = api.slice(api.indexOf('function buildSystemPrompt('), api.indexOf('function buildSystemPrompt(') + 3000);
  t('★ base（稳定段）里有说明，且不在 vol 里', /base \+= `[^`]*系统标注的发送时间[^`]*不要写这种时间戳/.test(sp));

  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
