const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function t(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const html = read('index.html');
const api = read('js/05-prompts-api.js');
const state = read('js/02-state.js');
const edit = read('js/08-edit-trash.js');
const render = read('js/06-render-msg.js');
const css = read('css/grancyan.css');

console.log('\n[用户思考输入与存储]');
t('正文上方有独立的内心想法输入框', /id="userThinkingInput"[\s\S]*id="userInput"/.test(html));
t('提示明确说明会保存在聊天记录里', /userThinkingInput[\s\S]{0,180}我的思考/.test(html));
t('发送时单独存 userThinking，不污染可见 content', /userThinking:\s*userThinking\s*\|\|\s*null/.test(api));
t('手动发送后同时清空两个输入框', /thinkingInput\.value\s*=\s*''/.test(api) && /input\.value\s*=\s*''/.test(api));
// 编辑弹层现在也能改内心想法（原来是原样搬运 old.userThinking，改不了）
t('编辑弹层带一个思考链输入框，预填原值', /msg-edit-think[\s\S]{0,120}escHtml\(old\.userThinking \|\| ''\)/.test(edit));
// 判据只认真实调用（带 `.` 前缀），源码里那句「别用 querySelector('textarea')」的注释不算
t('两个 textarea 按 class 取，不能再裸取第一个 textarea（那会拿到思考链）',
  /querySelector\('\.msg-edit-body'\)/.test(edit) && !/\.querySelector\('textarea'\)/.test(edit));
t('新分支存的是编辑框里的思考链，留空则为 null', /userThinking:\s*newThinking/.test(edit) && /msg-edit-think'\)\?\.value\?\.trim\(\) \|\| null/.test(edit));
// 2026-09-29 起一字没改也照发（见 edit-resend-same.test.js），「只改思考链」自然也发。
// 这里守的是反面：别再长出一道「和原来一样就静默不发」的早退。
t('只改思考链 / 一字没改都照发，没有「和原来一样就不发」的早退',
  !/newContent === old\.content/.test(edit) && !/newThinking === \(old\.userThinking/.test(edit));
t('token 估算把改后的思考链算进去', /estimateTokens\(newContent\) \+ \(newThinking \? estimateTokens\(newThinking\)/.test(edit));
t('token 估算包含正文和内心想法', /estimateTokens\(txt\)\s*\+\s*estimateTokens\(thinking\)/.test(state));

console.log('\n[API 内容块边界]');
t('内心想法包在 user_thinking XML 标签内', /<user_thinking>\$\{safe\}<\/user_thinking>/.test(api));
t('XML 特殊字符被转义，不能提前闭合标签', /replace\(\/&\/g, '&amp;'\)[\s\S]{0,100}replace\(\/>\/g, '&gt;'\)/.test(api));
t('thinking 和正文分别 push 为两个 text block', /parts\.push\(thinkingPart\)[\s\S]{0,100}parts\.push\(\{ type: 'text', text: content \}\)/.test(api));
// 2026-10-03：「有图」改成「有要发原图的图」—— 历史图换成描述之后不再带图片块（js/60-imgmem.js）
t('没有想法时仍走原有字符串消息路径', /if \(m\.role === 'user' && \(imgSplitOf\(m\)\.raw\.length \|\| thinkingPart\)\)/.test(api));
t('本地模型会从数组中提取所有 text blocks', api.includes("filter(c => c.type === 'text').map(c => c.text).join('\\n')"));
t('输入框有独立样式且语音模式会一起收起', /#userThinkingInput\s*\{/.test(css) && /voice-mode \.composer-text-stack/.test(css));

console.log('\n[聊天记录可见性]');
t('用户思考渲染为默认收起的 details', /<details class="user-thinking-block">/.test(render) && /<summary>[\s\S]*我的思考/.test(render));
t('展示前经过 HTML 转义', /user-thinking-body">\$\{escHtml\(m\.userThinking\)\}/.test(render));
t('长消息和普通气泡都挂入思考区块', (render.match(/\$\{userThinkingHtml\}/g) || []).length === 2);
t('两条渲染路径都先画思考再画说出口的正文', (() => {
  const spots = [...render.matchAll(/\$\{userThinkingHtml\}/g)].map(m => m.index);
  return spots.length === 2 && spots.every(pos => {
    const after = render.slice(pos, pos + 260);
    return after.includes('renderUserText(m.content)') || after.includes('renderVoiceBubble(m)');
  });
})());
t('缓存键包含 userThinking，刷新后不会复用旧气泡', /ut\$\{m\.userThinking\?\.length\|\|0\}/.test(render));
t('思考区有独立的折叠与正文样式', /\.user-thinking-block\s*\{/.test(css) && /\.user-thinking-body\s*\{/.test(css));

console.log('\n[指南与端侧一致性]');
t('功能指南写明可回看与 XML block', /用户思考[\s\S]{0,500}我的思考[\s\S]{0,500}user_thinking/.test(html));
t('桌面与安卓副本一致', ['02-state.js','05-prompts-api.js','06-render-msg.js','08-edit-trash.js'].every(f =>
  fs.readFileSync(path.join(root, 'js', f)).equals(fs.readFileSync(path.join(root, 'android/assets/js', f))))
  && fs.readFileSync(path.join(root, 'css/grancyan.css')).equals(fs.readFileSync(path.join(root, 'android/assets/css/grancyan.css')))
  && fs.readFileSync(path.join(root, 'index.html')).equals(fs.readFileSync(path.join(root, 'android/assets/index.html'))));

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
