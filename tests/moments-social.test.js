'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stateSrc = read('js/02-state.js');
const memorySrc = read('js/04-memory.js');
const promptSrc = read('js/05-prompts-api.js');
const momentsSrc = read('js/51-moments.js');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const plain = value => JSON.parse(JSON.stringify(value));

const state = {
  moments: [], chars: [], configs: [], memories: [], recentMemos: [], trash: [],
  userName: '小明', userAvatar: '', skillsOff: {}, webSearchApiKey: 'k',
  webSearchProvider: 'tavily', bandAiEnabled: false, studyOn: false
};
let next = 500;
let saves = 0;
let activeReplyInput = null;
const listBox = {
  _html: '',
  get innerHTML() { return this._html; },
  set innerHTML(value) {
    this._html = String(value);
    const match = this._html.match(/id="momentsReplyInput"[\s\S]*?>([\s\S]*?)<\/textarea>/);
    activeReplyInput = match ? {
      value: match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
      focus() {}, setSelectionRange() {}
    } : null;
  }
};
const commandBox = {
  console, Date, setTimeout, clearTimeout,
  state,
  nextId: () => ++next,
  save: () => { saves++; },
  escHtml: value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  document: { getElementById: id => id === 'momentsList' ? listBox : (id === 'momentsReplyInput' ? activeReplyInput : null) },
  showToast: () => {},
  _stickerList: []
};
commandBox.globalThis = commandBox;
vm.createContext(commandBox);
vm.runInContext(memorySrc, commandBox, { filename: '04-memory.js' });
vm.runInContext(momentsSrc, commandBox, { filename: '51-moments.js' });

const confA = { id: 7, name: '角色A', nickname: '错误别名' };
const moment = (id, author, text, extra = {}) => Object.assign({ id, author, ts: id, text, images: [], likes: [], comments: [] }, extra);

console.log('\n[1] id 引用、fail closed 与点赞去重');
state.moments = [moment(11, '角色B', '第一条'), moment(29, '角色B', '已经删除') , moment(47, '角色B', '第三条')];
state.moments.splice(1, 1);
saves = 0;
vm.runInContext("processAiCommands('[[MOMENT_LIKE: 47]]', {}, __conf)", Object.assign(commandBox, { __conf: confA }));
t('★ 点赞引用 moment.id，删除中间项后仍不会按数组下标点错',
  state.moments[1].id === 47 && plain(state.moments[1].likes).join() === '角色A' && state.moments[0].likes.length === 0,
  JSON.stringify(state.moments));

const beforeClosed = JSON.stringify(state.moments);
let closedError = null;
try {
  vm.runInContext("processAiCommands('[[MOMENT_LIKE: 999]]\\n[[MOMENT_REPLY: 999 | 不该落下]]', {}, __conf)", commandBox);
} catch (error) { closedError = error; }
t('★ 不存在的 moment.id fail closed：不崩、不新建、不串到别条',
  !closedError && JSON.stringify(state.moments) === beforeClosed,
  closedError && closedError.message);

state.moments = [moment(73, '角色B', '一阵雨')];
saves = 0;
vm.runInContext("processAiCommands('[[MOMENT_LIKE: 73]]\\n[[MOMENT_LIKE: 73]]', {}, __conf)", commandBox);
t('★ 同一作者重复点赞去重，第二次是无操作',
  plain(state.moments[0].likes).join() === '角色A' && saves === 1,
  JSON.stringify({ likes: state.moments[0].likes, saves }));

console.log('\n[2] content 副作用、blocks 纯展示与角色互评');
state.moments = [moment(88, '角色B', '窗台上的薄荷冒芽了')];
saves = 0;
const socialRaw = '[[MOMENT_LIKE: 88]]\n[[MOMENT_REPLY: 88 | 我也看见春天了]]';
const socialCooked = vm.runInContext('processAiCommands(__raw, {}, __conf)', Object.assign(commandBox, { __raw: socialRaw }));
const afterContent = JSON.stringify(state.moments);
const savesAfterContent = saves;
const blocks = [{ type: 'text', text: socialRaw }];
vm.runInContext('_applyMomentsToBlocks(__blocks)', Object.assign(commandBox, { __blocks: blocks }));
t('★ blocks 路径只展示，不重复执行点赞或评论副作用',
  JSON.stringify(state.moments) === afterContent && saves === savesAfterContent
    && !blocks[0].text.includes('[[MOMENT_') && (blocks[0].text.match(/moment-echo/g) || []).length === 2,
  JSON.stringify({ moments: state.moments, saves, block: blocks[0].text }));
t('★ 角色A 能评论角色B，comment.author 存当前卡 name 字符串',
  state.moments[0].author === '角色B' && state.moments[0].comments.length === 1
    && state.moments[0].comments[0].author === '角色A' && typeof state.moments[0].comments[0].author === 'string',
  JSON.stringify(state.moments[0].comments));

console.log('\n[3] 旧数据与用户侧交互');
state.moments = [moment(91, '角色B', '旧备份', { likes: undefined, comments: undefined })];
saves = 0;
let legacyError = null;
try {
  vm.runInContext("processAiCommands('[[MOMENT_LIKE: 91]]\\n[[MOMENT_REPLY: 91 | 旧数据也能回]]', {}, __conf)", commandBox);
  vm.runInContext('momentsRender()', commandBox);
} catch (error) { legacyError = error; }
t('★ likes/comments 为 undefined 的旧数据在渲染和写入前都会兜底',
  !legacyError && Array.isArray(state.moments[0].likes) && Array.isArray(state.moments[0].comments)
    && state.moments[0].likes[0] === '角色A' && state.moments[0].comments[0].text === '旧数据也能回',
  legacyError && legacyError.message);

state.moments = [moment(94, '角色B', '留个回应')];
saves = 0;
vm.runInContext("momentsToggleLike('94'); momentsToggleLike('94'); _momentsReplyTo = '94'; _momentsReplyDraft = '小明的评论'; momentsSubmitReply('94');", commandBox);
t('★ 用户能切换点赞并用共享 nextId 写入 user 评论',
  state.moments[0].likes.length === 0 && state.moments[0].comments.length === 1
    && state.moments[0].comments[0].author === 'user' && state.moments[0].comments[0].text === '小明的评论'
    && state.moments[0].comments[0].id === next && saves === 3,
  JSON.stringify({ moment: state.moments[0], saves }));

state.moments = [moment(95, '角色B', '可以接着聊', { comments: [
  { id: 701, author: '角色A', text: '第一层评论', ts: 1 }
] })];
saves = 0;
vm.runInContext("momentsReplyToComment('95', '701')", commandBox);
t('★ 点一条评论会打开定向回复框，并明确显示回复对象',
  vm.runInContext("_momentsReplyTarget && _momentsReplyTarget.id === 701", commandBox)
    && listBox.innerHTML.includes('回复 角色A') && listBox.innerHTML.includes('取消回复'),
  listBox.innerHTML.slice(-500));
activeReplyInput.value = '接住你的话';
vm.runInContext("momentsSubmitReply('95');", commandBox);
const nested = state.moments[0].comments[1];
t('★ 回复评论保存目标评论 id 与作者，渲染为「用户 回复 角色A」',
  nested && nested.author === 'user' && nested.text === '接住你的话'
    && nested.replyTo && nested.replyTo.id === 701 && nested.replyTo.author === '角色A'
    && listBox.innerHTML.includes('moment-comment-reply-word')
    && listBox.innerHTML.includes('小明') && listBox.innerHTML.includes('角色A') && saves === 1,
  JSON.stringify({ nested, html: listBox.innerHTML.slice(-500) }));

t('★ 评论和回复都显示时间（每条一个 moment-comment-time）',
  (listBox.innerHTML.match(/<time class="moment-comment-time"/g) || []).length === 2 && /moment-comment-time" title="[^"]+">[^<]+<\/time>/.test(listBox.innerHTML),
  listBox.innerHTML.slice(-600));

const beforeMissingTarget = JSON.stringify(state.moments[0].comments);
const rejected = vm.runInContext("momentsReplyByAuthor('95', 'user', '不该变成悬空回复', undefined, '999')", commandBox);
t('★ 目标评论不存在时 fail closed，不落成看似普通的错误回复',
  rejected === null && JSON.stringify(state.moments[0].comments) === beforeMissingTarget && saves === 1,
  JSON.stringify(state.moments[0].comments));

state.moments = [moment(97, '角色B', '写到一半也别丢')];
vm.runInContext("_momentsReplyTo = '97'; _momentsReplyDraft = ''; momentsRender();", commandBox);
const firstInput = activeReplyInput;
firstInput.value = '还没写完的半句';
vm.runInContext('momentsRender()', commandBox);
t('★ momentsRender 重画后保留正在输入的评论草稿并恢复新输入框',
  activeReplyInput !== firstInput && activeReplyInput && activeReplyInput.value === '还没写完的半句',
  activeReplyInput && activeReplyInput.value);

const promptBox = {
  console, Date, setTimeout, clearTimeout, JSON, Math, String, Array, Object, Set, Map,
  fetch: async () => ({ ok: true }), state,
  _stickerList: [], _call: { on: false }, _ctxWarnedFor: new Set(),
  save() {}, showToast() {}, escHtml: value => String(value),
  pickBrainMemories: () => [], formatBrainForPrompt: () => '', takeProustMoment: () => '',
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  window: {}
};
promptBox.globalThis = promptBox;
vm.createContext(promptBox);
const tokenStart = stateSrc.indexOf('function estimateTokens(text)');
const tokenEnd = stateSrc.indexOf('function getChatTotalTokens', tokenStart);
vm.runInContext(stateSrc.slice(tokenStart, tokenEnd), promptBox, { filename: '02-state.js#estimateTokens' });
vm.runInContext(promptSrc, promptBox, { filename: '05-prompts-api.js' });
vm.runInContext(momentsSrc, promptBox, { filename: '51-moments.js' });

console.log('\n[4] 历史自咬合、动态摘要与流式遮罩');
const history = promptBox.stickerTagForApi(socialCooked);
t('★ 点赞评论回填为正牌指令且不含任何 HTML 展示形态（有意误伤所有展示形态）',
  history.includes('[[MOMENT_LIKE: 88]]') && history.includes('[[MOMENT_REPLY: 88 | 我也看见春天了]]')
    && !/<[^>]+>/.test(history),
  history);

state.moments = Array.from({ length: 10 }, (_, i) => moment(100 + i, i % 2 ? '角色A' : '角色B',
  '正文' + i + (i === 9 ? 'x'.repeat(220) + '不该看见的尾巴' : ''), { ts: 100 + i, comments: i === 8 ? [{ id: 1, author: 'user', text: '一条', ts: 1 }] : [] }));
state.skillsOff = {};
const viewConf = { id: 7, name: '角色A', nickname: '角色A' };
const viewChat = { id: 1, nodes: {}, headId: null };
const quiet = {};
promptBox.buildSystemPrompt(viewConf, viewChat, '', null, quiet);
t('★ 没写 [[MOMENTS]] 时一条动态都不塞（按需翻看，省 token）',
  !quiet.stable.includes('[最近的猫爪日报动态]') && !quiet.volatile.includes('[最近的猫爪日报动态]')
    && quiet.stable.includes('[[MOMENTS]]'),
  quiet.volatile);

// 真实路径：模型写 [[MOMENTS]] → processAiCommands 置位 → 下一轮摊开
const viewCooked = vm.runInContext("processAiCommands('我去看看 [[MOMENTS]]', {}, __vc)", Object.assign(commandBox, { __vc: viewConf }));
t('[[MOMENTS]] 渲染成提示块，不裸露指令',
  !viewCooked.includes('[[MOMENTS]]') && viewCooked.includes('🐾 翻了翻猫爪日报'), viewCooked);
t('提示块回填历史时咬回正牌 [[MOMENTS]]',
  promptBox.stickerTagForApi(viewCooked).includes('[[MOMENTS]]') && !promptBox.stickerTagForApi(viewCooked).includes('think-block'));
const split = {};
promptBox.buildSystemPrompt(viewConf, viewChat, '', null, split);
const summaryLines = (split.volatile.match(/^- id=/gm) || []).length;
t('★ 最近 8 条动态摘要只进 volatile，含真实 id、自己与别的角色和评论数',
  !split.stable.includes('[最近的猫爪日报动态]') && split.volatile.includes('[最近的猫爪日报动态]')
    && summaryLines === 8 && split.volatile.includes('id=109') && split.volatile.includes('作者=角色A')
    && split.volatile.includes('作者=角色B') && /评论 .* user（小明）：一条/.test(split.volatile)
    && !split.volatile.includes('不该看见的尾巴'),
  split.volatile);
t('★ 摊开的每条动态都带发布时间',
  (split.volatile.match(/\| 时间=\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g) || []).length === 8, split.volatile);
const again = {};
promptBox.buildSystemPrompt(viewConf, viewChat, '', null, again);
t('★ 只摊开一轮：下一轮不再给',
  !again.volatile.includes('[最近的猫爪日报动态]'), again.volatile);
const fromHistory = {};
promptBox.buildSystemPrompt(viewConf, viewChat, '', [{ role: 'user', content: '你看看' }, { role: 'ai', content: viewCooked }], fromHistory);
t('内存标记丢了（刷新/换设备）也能从最后一条 AI 消息的印子认出来',
  fromHistory.volatile.includes('[最近的猫爪日报动态]'));
const prose = {};
promptBox.buildSystemPrompt(viewConf, viewChat, '', [{ role: 'ai', content: '我才没翻了翻猫爪日报' }], prose);
t('散文里说「翻了翻猫爪日报」不算请求', !prose.volatile.includes('[最近的猫爪日报动态]'));
t('momentsPromptTime：一周内给绝对时间+相对时间',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（3 小时前）$/.test(promptBox.momentsPromptTime(Date.now() - 3 * 3600e3 - 1000, Date.now()))
    || /（昨天）$/.test(promptBox.momentsPromptTime(Date.now() - 3 * 3600e3 - 1000, Date.now())),
  promptBox.momentsPromptTime(Date.now() - 3 * 3600e3 - 1000, Date.now()));

const maskedLike = promptBox.maskStreamingTags('前 [[MOMENT_LIKE: 109');
const maskedReply = promptBox.maskStreamingTags('前 [[MOMENT_REPLY: 108 | 还没写完');
t('★ 流式未闭合的点赞和评论指令都被遮住',
  !maskedLike.includes('[[MOMENT') && !maskedLike.includes('109')
    && !maskedReply.includes('[[MOMENT') && !maskedReply.includes('还没写完')
    && maskedLike.includes('正在处理猫爪日报') && maskedReply.includes('正在处理猫爪日报'),
  JSON.stringify({ maskedLike, maskedReply }));

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed ? 1 : 0);
