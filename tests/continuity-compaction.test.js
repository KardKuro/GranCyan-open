const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', '05-continuity-compaction.js'), 'utf8');
let saves = 0;
const ctx = {
  console,
  state: { thinkSumKey: '' },
  estimateTokens: text => Math.ceil(String(text || '').length / 2),
  stickerTagForApi: text => String(text || ''),
  save: () => { saves++; },
  fetch: async () => { throw new Error('unexpected fetch'); },
  setTimeout,
  clearTimeout
};
vm.createContext(ctx);
vm.runInContext(source, ctx);

let failed = 0;
function test(name, fn) {
  Promise.resolve().then(fn).then(() => console.log('✓', name), e => { failed++; console.error('✗', name, e); });
}
function msg(id, role, size = 1000) { return { id, role, content: `${id}:` + '字'.repeat(size), tokens: Math.ceil(size / 2) }; }

test('没有摘要 key 时原样返回，不写状态', async () => {
  const path = [msg('m1', 'user'), msg('m2', 'ai')];
  const chat = { id: 'c1' };
  const out = await ctx.continuityPreparePath(path, chat, { id: 'model' });
  if (out.path.length !== 2 || out.summary !== '' || saves !== 0) throw new Error(JSON.stringify(out));
});

test('已有边界只发送边界后的 raw tail', async () => {
  const path = [msg('m1', 'user'), msg('m2', 'ai'), msg('m3', 'user')];
  const chat = { id: 'c2', continuityCompaction: { model: { untilId: 'm2', summary: '旧摘要' } } };
  const out = await ctx.continuityPreparePath(path, chat, { id: 'model' });
  if (out.path.length !== 1 || out.path[0].id !== 'm3' || out.summary !== '旧摘要') throw new Error(JSON.stringify(out));
});

test('切到不含旧边界的分支时不注入旧摘要', async () => {
  const path = [msg('x1', 'user'), msg('x2', 'ai')];
  const chat = { id: 'c3', continuityCompaction: { model: { untilId: 'other', summary: '不能串过来' } } };
  const out = await ctx.continuityPreparePath(path, chat, { id: 'model' });
  if (out.path.length !== 2 || out.summary !== '') throw new Error(JSON.stringify(out));
});

test('结构化摘要块明确要求静默使用', () => {
  const block = ctx.continuityInjectedBlock('连续性');
  if (!block.includes('<earlier_continuity>') || !block.includes('不要提及')) throw new Error(block);
});

setTimeout(() => { if (failed) process.exitCode = 1; }, 50);
