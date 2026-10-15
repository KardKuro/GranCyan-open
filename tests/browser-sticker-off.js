// 表情包「不给 AI 用」开关的**浏览器**冒烟测试：真点 ✏️、真勾弹窗里的框、真量系统提示。
// 静态断言证明不了的几件事：弹窗里那个框真的出来了、点了真的写进 state、格子真的变淡、
// 拼出来的系统提示里真的少了那张 —— 以及她自己照样能发。
//
// 跑法：
//   1) 先起一个 server：  GRANCYAN_PORT=3750 GRANCYAN_PORT_TLS=3751 node server.js
//   2) STK_PORT=3750 node tests/browser-sticker-off.js
// 用的是一次性的 Chrome 配置目录，不碰任何人的真存档。

const { spawn } = require('child_process');
const os = require('os'), path = require('path'), fs = require('fs');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9353;
const PORT = process.env.STK_PORT || 3750;
const URL = `http://127.0.0.1:${PORT}/`;
const SHOT = process.env.STK_SHOT || '';   // 想要截图就给个路径

// 自带一个临时表情包（stickers-packs/<PACK>/），测试结束删掉，不依赖仓库里有哪些包
const PACK = 'smoke-off-pack';
const PACK_DIR = path.join(__dirname, '..', 'stickers-packs', PACK);
(() => {
  const src = path.join(__dirname, '..', 'stickers');
  const pngs = fs.readdirSync(src).filter(f => /\.png$/i.test(f)).slice(0, 3);
  fs.mkdirSync(PACK_DIR, { recursive: true });
  pngs.forEach(f => fs.copyFileSync(path.join(src, f), path.join(PACK_DIR, f)));
  fs.writeFileSync(path.join(PACK_DIR, 'pack.json'), JSON.stringify({ name: '冒烟测试包' }));
})();
process.on('exit', () => { try { fs.rmSync(PACK_DIR, { recursive: true, force: true }); } catch (_) {} });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stkoff-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--window-size=900,1000',
  '--no-default-browser-check', '--disable-gpu', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WATCHDOG = setTimeout(() => {
  console.error('\n❌ 超过 150 秒还没跑完，判定卡死');
  try { chrome.kill(); } catch (_) {}
  process.exit(1);
}, 150000);
let pass = 0, fail = 0;
const t = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n, extra === undefined ? '' : JSON.stringify(extra))); };

(async () => {
  let ws;
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const p = l.find(x => x.type === 'page' && x.url.includes(String(PORT)));
      if (p && p.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
    } catch (_) {}
    await sleep(500);
  }
  if (!ws) throw new Error(`等不到 CDP —— server 起了吗？(${URL})`);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const rpc = (m, p) => new Promise((res, rej) => {
    const my = ++id;
    const on = e => { const x = JSON.parse(e.data); if (x.id !== my) return;
      ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); };
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
  });
  const ev = async expr => {
    const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 挂了');
    return r.result.value;
  };
  await rpc('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    if (await ev(`typeof loadStickers === 'function' && typeof editStickerNote === 'function' && typeof buildSystemPrompt === 'function'`)) break;
    await sleep(400);
  }
  await sleep(1500);   // 让启动那一轮 loadStateFromDB / loadStickers 先落地，别跟它抢

  // 量提示词：拿一份假配置走真的 buildSystemPrompt，只截表情那一段
  await ev(`window.__probeConf = { id: 'stkoff-probe', nickname: '克克', modelName: 'probe', apiBase: '', maxTokens: 200000, maxReplyTokens: 4096 }; state.skillsOff = Object.assign({}, state.skillsOff); delete state.skillsOff.sticker;`);
  const sp = `(async () => { const p = await buildSystemPrompt(window.__probeConf, getActiveChat() || { id: 'x', nodes: {} }, '', null, {});
      const i = p.indexOf('[表情包技能]'); return i < 0 ? '' : p.slice(i, p.indexOf('方式2', i)); })()`;

  console.log('\n[0] 准备');
  await ev(`(async()=>{ await loadStickers(); })()`);
  const pick = await ev(`(()=>{ const s=_packStickers('${PACK}')[0]; return s ? { name: s.name, ref: stickerRef(s) } : null; })()`);
  t('拿到一张包里的表情当靶子', !!pick, pick);
  if (!pick) throw new Error(`没扫到临时表情包 ${PACK}，没法测（server 的 ROOT 是这份仓库吗？）`);
  const before = await ev(sp);
  t('探针先验身：没关之前它在系统提示的清单里', before.includes(pick.ref + '('), before.slice(0, 200));
  t('老数据（这个干净配置里没有开关表）= 给 AI 用', await ev(`stickerAiOff(${JSON.stringify(pick.name)}) === false`));

  console.log('\n[1] 真点 ✏️ → 勾「不给 AI 用」→ 确定');
  await ev(`switchStickerTab('pack:${PACK}')`);
  await sleep(300);
  await ev(`document.querySelector('#stickerGrid .sticker-item .sticker-note-btn').click()`);
  await sleep(250);
  const modal = await ev(`(()=>{ const w=document.getElementById('appPromptModal'); const row=document.getElementById('appPromptCheckRow');
      return { open: !!w && w.style.display==='block', row: row ? getComputedStyle(row).display : 'none',
               label: (document.getElementById('appPromptCheckLabel')||{}).textContent||'', checked: document.getElementById('appPromptCheck').checked }; })()`);
  t('弹窗开了', modal.open, modal);
  t('弹窗里有那个勾选框，看得见', modal.row !== 'none', modal);
  t('文案说清了：AI 用不了、她自己照样能发', /不给 AI 用/.test(modal.label) && /照样能发/.test(modal.label), modal.label);
  t('初值是没勾（老数据给 AI 用）', modal.checked === false);
  await ev(`document.getElementById('appPromptCheckLabel').click()`);    // 点文字也该能勾上（label 包着）
  t('点文字就勾上了', await ev(`document.getElementById('appPromptCheck').checked === true`));
  await ev(`document.getElementById('appPromptOk').click()`);
  await sleep(300);
  t('确定之后写进了 state', await ev(`stickerAiOff(${JSON.stringify(pick.name)}) === true`));
  const cell = await ev(`(()=>{ const c=document.querySelector('#stickerGrid .sticker-item'); const img=c.querySelector('img');
      return { cls: c.className, tag: !!c.querySelector('.sticker-ai-off-tag'), op: getComputedStyle(img).opacity, title: c.title }; })()`);
  t('面板上那张变淡了（ai-off）', /\bai-off\b/.test(cell.cls) && Number(cell.op) < 0.9, cell);
  t('角上有个小记号', cell.tag, cell);
  t('悬停提示里写了不给 AI 用', /不给 AI 用/.test(cell.title), cell.title);
  if (SHOT) {
    await ev(`(()=>{ if (typeof openStickerPanel==='function') openStickerPanel(); else document.getElementById('stickerPanel')?.classList.add('open'); switchStickerTab('pack:${PACK}'); })()`);
    await sleep(800);
    const shot = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  （截图：' + SHOT + '）');
  }

  console.log('\n[2] 系统提示里真的少了那张');
  const after = await ev(sp);
  t('关掉之后清单里没有它了', after.length > 0 && !after.includes(pick.ref + '('), after.slice(0, 200));
  t('同一栏别的表情还在', await ev(`(()=>{ const o=_packStickers('${PACK}')[1]; return o ? stickerRef(o) : ''; })()`).then(r => !r || after.includes(r + '(')));
  t('提示词变短了', after.length < before.length, [before.length, after.length]);

  console.log('\n[3] AI 写了它：不出图；她自己发：照样出图');
  const aiOut = await ev(`processAiCommands('抱抱你[[STICKER:${pick.ref.replace(/'/g, "\\'")}]]', getActiveChat(), window.__probeConf, {})`);
  t('AI 回复里那张被抹掉了', aiOut === '抱抱你', aiOut);
  const aiReadable = await ev(`processAiCommands('[表情包: ${pick.name.replace(/'/g, "\\'")}]好', getActiveChat(), window.__probeConf, {})`);
  t('照抄历史写成 [表情包: 名字] 的也拦住', !/STICKER/.test(aiReadable) && /好/.test(aiReadable), aiReadable);
  const blk = await ev(`(()=>{ const b=[{type:'text',text:'嗯[[STICKER:${pick.ref.replace(/'/g, "\\'")}]]'}]; _applyStickerOffToBlocks(b); return b[0].text; })()`);
  t('blocks 那条路也抹了', blk === '嗯', blk);
  const userHtml = await ev(`renderUserText('[[STICKER:${pick.ref.replace(/'/g, "\\'")}]]')`);
  t('她自己发的照样渲染成图', /<img class="sticker-msg"/.test(userHtml), userHtml.slice(0, 120));
  const oldAi = await ev(`renderRichText('以前发过的[[STICKER:${pick.ref.replace(/'/g, "\\'")}]]')`);
  t('关掉之前 AI 发过的老消息照样出图（没在渲染层拦）', /<img class="sticker-msg"/.test(oldAi), oldAi.slice(0, 120));
  const typed = await ev(`(()=>{ const inp=document.getElementById('userInput'); const b=inp.value;
      document.querySelector('#stickerGrid .sticker-item').click(); const got=inp.value; inp.value=b; return got; })()`);
  t('点那张格子照样插进输入框', typed.includes('[[STICKER:' + pick.ref + ']]'), typed);

  console.log('\n[4] 弹窗是复用的：别的调用方不该看到那个框');
  const other = await ev(`(async()=>{ const p=appPrompt('随便问一句'); await new Promise(r=>setTimeout(r,80));
      const row=getComputedStyle(document.getElementById('appPromptCheckRow')).display;
      document.getElementById('appPromptCancel').click(); const v=await p; return { row, v }; })()`);
  t('普通的 appPrompt 里勾选框是藏着的', other.row === 'none', other);
  t('取消照旧返回 null', other.v === null, other);

  console.log('\n[5] 落盘 + 再打开');
  await ev(`(async()=>{ await save(); })()`);
  await sleep(500);
  const disk = await ev(`(async()=>{ const v=await idbGet('kuro_stickerAiOff'); return typeof v==='string'?JSON.parse(v):v; })()`);
  t('写进 IndexedDB 了（刷新还在）', disk && disk[pick.name] && disk[pick.name].off === true, disk);
  await ev(`document.querySelector('#stickerGrid .sticker-item .sticker-note-btn').click()`);
  await sleep(250);
  t('再开弹窗，框是勾着的（初值读的是当前状态）', await ev(`document.getElementById('appPromptCheck').checked === true`));
  await ev(`document.getElementById('appPromptCheck').click()`);
  await ev(`document.getElementById('appPromptOk').click()`);
  await sleep(300);
  t('取消勾选后重新给 AI 用', await ev(`stickerAiOff(${JSON.stringify(pick.name)}) === false`));
  t('记成 off:false（不是删键）', await ev(`(state.stickerAiOff[${JSON.stringify(pick.name)}]||{}).off === false`));
  t('面板上那张不淡了', await ev(`!document.querySelector('#stickerGrid .sticker-item').classList.contains('ai-off')`));
  const back = await ev(sp);
  t('清单里又有它了', back.includes(pick.ref + '('));
  t('AI 又能发了', await ev(`processAiCommands('[[STICKER:${pick.ref.replace(/'/g, "\\'")}]]', getActiveChat(), window.__probeConf, {})`) === '[[STICKER:' + pick.ref + ']]');

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  clearTimeout(WATCHDOG);
  ws.close(); chrome.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(fail ? 1 : 0); }, 800);
})().catch(e => { console.error('测试挂了:', e.message); chrome.kill(); process.exit(1); });
