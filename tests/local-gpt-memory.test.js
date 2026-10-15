const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed++; console.log('  OK ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

console.log('\n[1] 本地 GPT 启动与事件隔离');
const server = read('server.js');
const api = read('js/05-prompts-api.js');
test('关闭插件与启动期网络预热', /'--disable', 'plugins'/.test(server) && /'--disable', 'remote_plugin'/.test(server));
test('关闭 PowerShell shell snapshot', /'--disable', 'shell_snapshot'/.test(server));
test('思考模式传到服务端', /thinkingMode: conf\.thinkingMode \|\| 'auto'/.test(api));
// 思考深度（effort）和摘要（summary）这两个值是拼进 codex 命令行的，传错了它 exit 0 +
// 空日志（静默不生效）。原来这条断言是 grep 源码里有没有「detailed」这个词 ——
// 把字面量换成变量它就假红，而且它从头到尾没问过「什么时候该给 detailed」。
// 改成把那几行真的抠出来在 vm 里跑一遍，逐个组合对结果。
{
  const grab = (re, what) => {
    const m = server.match(re);
    if (!m) throw new Error(`抠不出来：${what}（server.js 改了形状，这条断言已经不测东西了）`);
    return m[0];
  };
  const src = [
    grab(/const GPT_EFFORTS = \[[^\]]*\];/, 'GPT_EFFORTS'),
    grab(/const reasoningMode = [^\n]*/, 'reasoningMode'),
    grab(/const effort = GPT_EFFORTS[\s\S]*?;(?=\n)/, 'effort'),
    grab(/const reasoningSummary = [^\n]*/, 'reasoningSummary'),
    'result = { effort, summary: reasoningSummary };',
  ].join('\n');
  const decide = (thinkingMode, reasoningEffort) => {
    const ctx = { thinkingMode, reasoningEffort };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return ctx.result;
  };
  const d0 = decide('auto', undefined);
  test('默认（没选深度）仍然是 medium + 可读摘要', d0.effort === 'medium' && d0.summary === 'detailed');
  const dOff = decide('off', undefined);
  test('关掉思考链时不要摘要，深度回落 low', dOff.effort === 'low' && dOff.summary === 'none');
  const dAlways = decide('always', undefined);
  test('「思考：总是」在没选深度时维持老行为 high', dAlways.effort === 'high' && dAlways.summary === 'detailed');
  // 这一组就是新功能本体：深度独立于思考链开关。
  const dHigh = decide('auto', 'high');
  test('单独调高深度不影响思考链显示', dHigh.effort === 'high' && dHigh.summary === 'detailed');
  const dDeepQuiet = decide('off', 'xhigh');
  test('能表达「深想但不用给我看」', dDeepQuiet.effort === 'xhigh' && dDeepQuiet.summary === 'none');
  const dNone = decide('auto', 'none');
  test('深度选 none 时不要自相矛盾的摘要', dNone.effort === 'none' && dNone.summary === 'none');
  const dBogus = decide('always', 'HIGH; rm -rf');
  test('白名单外的深度不会拼进命令行', dBogus.effort === 'high');
  // 算出来了还得真的传下去 —— 两个 --config 少一个都是静默不生效。
  test('两个值都拼进 codex 命令行', /model_reasoning_effort="\$\{effort\}"/.test(server)
    && /model_reasoning_summary="\$\{reasoningSummary\}"/.test(server));
}
test('检测到 Plus 登录时优先走官方 Codex', /GPT_USES_OPENAI_LOGIN = fs\.existsSync/.test(server)
  && /if \(!GPT_USES_OPENAI_LOGIN\) args\.push\(/.test(server));
test('没有内置的第三方中转（不硬编码任何默认 base_url）',
  !/model_providers\.[a-z_]+\.base_url="https?:/.test(server)
  && /model_providers\.grancyan_custom\.base_url=\$\{JSON\.stringify\(GPT_CUSTOM_BASE_URL\)\}/.test(server));
test('没登录时只认用户自己配的端点，key 从 GRANCYAN_GPT_API_KEY 读',
  /GPT_CUSTOM_BASE_URL = String\(process\.env\.GRANCYAN_GPT_BASE_URL/.test(server)
  && /for \(const k of GPT_USES_OPENAI_LOGIN \? \[\] : \['GRANCYAN_GPT_API_KEY'\]\)/.test(server));
test('既没登录也没配端点：开跑前就 400 报清楚，不 spawn',
  /if \(!GPT_USES_OPENAI_LOGIN && !GPT_CUSTOM_BASE_URL\) \{[\s\S]{0,200}?res\.status\(400\)\.json\(\{ error: GPT_NO_BACKEND_MSG \}\)/.test(server)
  && server.indexOf('if (!GPT_USES_OPENAI_LOGIN && !GPT_CUSTOM_BASE_URL)') < server.indexOf('const exePath = resolveGptExe();'));
// 开源版不查 Codex 订阅额度：那条路要读 ~/.codex/auth.json 的 token、冒充 codex-cli 去打 ChatGPT 的非公开 usage 接口
test('开源版没有 Codex 订阅额度接口（不读 auth.json token、不打非公开 usage 接口）',
  !/\/api\/gpt-ratelimit/.test(server)
  && !/backend-api\/wham/.test(server)
  && !/ChatGPT-Account-Id/.test(server)
  && !/User-Agent['"]?\s*:\s*['"`]codex-cli/.test(server)
  && !/gptQuotaChip|refreshGptQuota|showGptQuotaDetail|\/api\/gpt-ratelimit/.test(read('js/03-chats-models.js'))
  && !/\/api\/gpt-ratelimit/.test(read('js/41-code-workbench.js')));
test('非 JSON stdout 只写日志，不进入 delta', /忽略非 JSON stdout/.test(server));
// 前端这个判断 2026-07-30 从 getActiveChat() 改成 originChat：
// 一轮活能跑几分钟，她中途切走的话，用「当前对话」判会让这一轮跑了什么命令全部消失
// 2026-07-30 前端这个条件放宽了一点：本地 Claude 纯聊天开了 WebSearch/WebFetch，
// 那两个要显示出来。Codex 侧不发联网工具事件（只有 command_execution / file），
// 所以对本地 GPT 来说实际行为没变 —— server 这半仍然必须是 agent-only。
test('本地 GPT 的工具事件只在电脑操控模式输出', /if \(agent && j\.type === 'item\.started'/.test(server)
  && /if \(j\.tool && \(originChat\?\.agentMode \|\| isWebTool\)\)/.test(api));
test('stderr 状态只在电脑操控模式输出', /if \(agent && now - lastStatusAt/.test(server));

console.log('\n[1b] 生命体征与梦境入口归入小组件');
const html = read('index.html');
test('生命体征不再占设置标签', !/switchSettingsTab\('vitals'/.test(html) && !/id="stab-vitals"/.test(html));
test('梦境不再占设置标签或左侧导航', !/switchSettingsTab\('dreams'/.test(html) && !/data-hub="dreams"/.test(html));
test('小组件网格同时提供两个入口', /class="widget-item" onclick="openHubSection\('vitals','widgets'\)/.test(html)
  && /class="widget-item" onclick="openHubSection\('dreams','widgets'\)/.test(html));

console.log('\n[2] 高级记忆逐模型权限');
const brainSrc = read('js/14-boot-brain-hub.js');
const brainStart = brainSrc.indexOf('const BRAIN_HALFLIFE_DAYS');
const brainEnd = brainSrc.indexOf('// ── 高级记忆 UI ──', brainStart);
const brainCtx = {
  state: { configs: [{ id: 1, nickname: '本地 Claude', isLocalClaude: true }, { id: 2, nickname: '本地 GPT', isLocalGpt: true }], brainMemories: [], trash: [] },
  console, Date, Math,
  nextId: (() => { let id = 100; return () => ++id; })(),
  save() {}, renderMemoryBadge() {}, renderBrainMemList() {}, renderProustList() {},
  getMsgPlainText(n) { return n.content || ''; }, escHtml: String,
};
vm.createContext(brainCtx);
vm.runInContext(brainSrc.slice(brainStart, brainEnd), brainCtx);

const privateBrain = brainCtx.addBrainMemory({ text: '只属于 GPT 的约定', modelId: 2 });
const legacyBrain = brainCtx.addBrainMemory({ text: '旧版共享记忆' });
test('AI 新记忆默认只授权创建模型', JSON.stringify(privateBrain.modelIds) === '[2]');
test('手工/旧版记忆默认归本地 Claude', brainCtx.memoryAllowedForModel(legacyBrain, 1)
  && !brainCtx.memoryAllowedForModel(legacyBrain, 2));
test('未授权模型检索不到私有高级记忆', brainCtx.brainFindByMatch('只属于', 1) === undefined);
test('创建模型能检索自己的高级记忆', brainCtx.brainFindByMatch('只属于', 2)?.id === privateBrain.id);
brainCtx.toggleMemoryModelAccess('brain', privateBrain.id, 1, true);
test('界面授权后另一个模型立即可用', brainCtx.memoryAllowedForModel(privateBrain, 1));
brainCtx.toggleMemoryModelAccess('brain', privateBrain.id, 2, false);
test('逐条取消授权立即生效', !brainCtx.memoryAllowedForModel(privateBrain, 2));

console.log('\n[3] 普鲁斯特记忆逐模型权限');
const proustSrc = read('js/17-proust.js');
const proustStart = proustSrc.indexOf('const PROUST_COOLDOWN_MS');
const proustEnd = proustSrc.indexOf('/* ── 记忆管理里的「普鲁斯特」栏', proustStart);
const proustCtx = {
  state: { proustMems: [], proustRecent: [], configs: [] }, console, Date, Math,
  save() {}, renderProustList() {}, memoryAllowedForModel: brainCtx.memoryAllowedForModel,
  getActiveChatModelIds() { return []; },
};
vm.createContext(proustCtx);
vm.runInContext(proustSrc.slice(proustStart, proustEnd), proustCtx);
const p = proustCtx.addProustMemory('雨落在窗台上，我忽然安静下来。', 2);
test('新瞬间默认只授权创建模型', JSON.stringify(p.modelIds) === '[2]');
test('未授权模型不会进入普鲁斯特候选池', proustCtx._proustCandidates(1).length === 0);
test('授权模型可以触发该瞬间', proustCtx._proustCandidates(2)[0]?.id === p.id);
proustCtx.addProustMemory('雨落在窗台上，我忽然安静下来。', 1);
test('相同瞬间由另一模型写入时合并授权', brainCtx.memoryAllowedForModel(p, 1)
  && proustCtx.state.proustMems.length === 1);

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
