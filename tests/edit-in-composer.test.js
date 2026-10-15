'use strict';
// 改消息也能全屏、能加附件（用户：「修改发送消息的时候也支持全屏和附加文件」）
//
// 做法是把这条消息整份搬进底下的主输入框（08 的 editMessageInComposer），
// 发送仍走 handleSend，靠 composerEditTarget() 把新节点挂到原消息的父节点下 = 开新分支。
// 这里守三件事：搬得全、她原来的草稿还得回来、handleSend 真的按「改」去挂父节点。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const edit = read('js/08-edit-trash.js');
const api  = read('js/05-prompts-api.js');
const chats = read('js/03-chats-models.js');
const html = read('index.html');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

function el(v) { return { value: v || '', style: {}, innerHTML: '', classList: { contains: () => false } }; }

function setup() {
  const chat = {
    id: 7, headId: 3,
    nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '第一句' },
      2: { id: 2, parentId: 1, role: 'assistant', content: '回' },
      3: { id: 3, parentId: 2, role: 'user', content: '看看这张图', userThinking: '有点紧张',
           images: [{ url: 'data:a', name: 'a.png' }], files: [{ name: 'x.txt', content: 'xx' }],
           quotes: [{ text: '引一句', sourceNodeId: 2 }] }
    }
  };
  const dom = { userInput: el('我还没发的草稿'), userThinkingInput: el('草稿的思考'), editModeBar: el() };
  const calls = [];
  const box = {
    console, state: {},
    document: {
      getElementById: id => dom[id] || null,
      querySelector: () => null
    },
    getActiveChat: () => chat,
    escHtml: s => String(s),
    autoResize: () => {},
    renderPendingImgs: () => calls.push('imgs'), renderPendingFiles: () => calls.push('files'),
    renderQuoteBar: () => calls.push('quotes'),
    _invalidateNodeCache: () => calls.push('invalidate'), renderMessages: () => calls.push('render'),
    toggleInputExpand: on => calls.push('expand:' + on),
    updateInputTokenEstimate: () => {}
  };
  vm.createContext(box);
  // 08 里用到的 _pendingImgs 等是 09 声明的全局 let；这里先声明好，和真实加载顺序下的作用域一致
  vm.runInContext(`let _pendingImgs = [{ url: 'data:draft' }]; let _pendingFiles = [{ name: 'draft.md', content: 'd' }]; let _pendingQuotes = [];
    ${edit}
    this.api = { editMessageInComposer, composerEditTarget, endComposerEdit, cancelComposerEdit,
      get imgs() { return _pendingImgs; }, get files() { return _pendingFiles; }, get quotes() { return _pendingQuotes; } };`, box);
  return { chat, dom, calls, api: box.api };
}

console.log('\n[改消息：搬进输入框]');
{
  const { chat, dom, calls, api } = setup();
  t('没在改时 composerEditTarget 回 null（照常发）', api.composerEditTarget(chat) === null);
  // 行内框里已经改了一半
  const wrap = { querySelector: s => s === '.msg-edit-body' ? { value: '改了一半的字' } : s === '.msg-edit-think' ? { value: '改过的思考' } : null };
  api.editMessageInComposer(3, { closest: () => wrap });
  t('★ 行内框里改了一半的正文 / 思考跟着搬进输入框', dom.userInput.value === '改了一半的字' && dom.userThinkingInput.value === '改过的思考', [dom.userInput.value, dom.userThinkingInput.value]);
  t('★ 原消息的图、文件、引用都搬进待发区', api.imgs.length === 1 && api.imgs[0].url === 'data:a'
    && api.files.length === 1 && api.files[0].name === 'x.txt' && api.quotes.length === 1);
  t('★ 展开成全屏', calls.includes('expand:true'));
  t('横条出来了', dom.editModeBar.style.display === 'flex' && /看看这张图/.test(dom.editModeBar.innerHTML));
  t('★ composerEditTarget 指向原消息（handleSend 拿它的 parentId）', api.composerEditTarget(chat) === chat.nodes[3]);
  // 在输入框里 × 掉图不能改到原节点
  api.imgs.splice(0, 1); api.files[0].content = '被改';
  t('待发区是拷贝：× 掉图 / 动文件不碰原消息', chat.nodes[3].images.length === 1 && chat.nodes[3].files[0].content === 'xx');

  // 再点另一条也不能把「上一条的修改稿」当成草稿收进去
  chat.nodes[5] = { id: 5, parentId: 4, role: 'user', content: '另一条' };
  api.editMessageInComposer(5, null);
  t('改到一半换一条改：正文换成那条的', dom.userInput.value === '另一条' && api.composerEditTarget(chat) === chat.nodes[5]);

  api.endComposerEdit();
  t('★ 发出去 / 结束后，原来的草稿（字、思考、图、文件）原样还回来',
    dom.userInput.value === '我还没发的草稿' && dom.userThinkingInput.value === '草稿的思考'
    && api.imgs.length === 1 && api.imgs[0].url === 'data:draft' && api.files[0].name === 'draft.md', [dom.userInput.value, api.imgs]);
  t('结束后横条收起、不再算在改', dom.editModeBar.style.display === 'none' && api.composerEditTarget(chat) === null);
}
{
  const { chat, calls, api } = setup();
  api.editMessageInComposer(3, null);
  t('直接从节点搬（没有行内框）也行', api.composerEditTarget(chat) === chat.nodes[3]);
  delete chat.nodes[3];
  t('★ 原消息没了 → 回 false（handleSend 拦下，不把改的字当新消息发）', api.composerEditTarget(chat) === false);
  chat.nodes[3] = { id: 3, parentId: 2, role: 'user', content: 'x' };
  t('换了对话 → 也回 false', api.composerEditTarget({ id: 99, nodes: {} }) === false);
  api.cancelComposerEdit();
  t('「不改了」退出编辑', api.composerEditTarget(chat) === null);
  t('非用户消息不进编辑', (api.editMessageInComposer(2, null), api.composerEditTarget(chat) === null));
}

console.log('\n[接线]');
t('行内编辑框有「⤢ 全屏 · 加附件」按钮', /msg-edit-big[^>]*editMessageInComposer\(\$\{nodeId\}, this\)/.test(edit));
t('index.html 有 #editModeBar 横条', /id="editModeBar"/.test(html));
t('★ handleSend：在改时新节点挂到原消息的父节点下', /prevHeadId = editOf \? editOf\.parentId : chat\.headId/.test(api));
t('★ handleSend：原消息不在了就拦下不发', /if \(editOf === false\)[\s\S]{0,300}return;/.test(api));
t('handleSend：编辑重发叫停朗读', /editOf && typeof ttsStopSpeaking === 'function'\) ttsStopSpeaking\(\)/.test(api));
t('handleSend：语音消息不算在改', /customText == null && typeof composerEditTarget === 'function'/.test(api));
t('handleSend：发完把草稿还回来', /endComposerEdit\(\)/.test(api));
t('切对话 / 新建对话都会退出编辑',
  /function switchChat[\s\S]{0,400}cancelComposerEdit\(\)/.test(chats) && /function createNewChat[\s\S]{0,400}cancelComposerEdit\(\)/.test(chats));

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exitCode = 1;
