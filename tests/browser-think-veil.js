// 思考链默认上锁的**浏览器**冒烟测试（真跑渲染 + 真量 computed style）。
//
// 为什么非得进浏览器、而且非得量 computed：这个功能整个是 CSS 滤镜撑起来的，
// 而滤镜类的东西「看着生效实则 no-op」是这台机器上的惯犯 ——
//   · 切了个没人认的类名：JS 全对、classList 里躺着那个类，CSS 里没有一条规则盖得住它
//   · filter 的值写错/被别的规则压过：DOM 上什么都看不出来，源码断言照样全绿
//   · filter 不能被子元素撤销（父元素上的 filter 会开新的渲染上下文），
//     所以「.think-note 有没有被连坐糊掉」只有真渲染才答得出来
// 结论：这一份里每一条「糊了/没糊」都是 getComputedStyle 量出来的数，不是源码里读出来的。
//
// 跑法：
//   1) 先起一个 server：  GRANCYAN_PORT=3097 node server.js
//   2) node tests/browser-think-veil.js
//   （端口可以用环境变量 STK_PORT 改）

const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9343;
const PORT = process.env.STK_PORT || 3097;
const URL = `http://127.0.0.1:${PORT}/`;

// 自己一份 profile：headless 的 profile 目录是带锁的，和别的冒烟共用会报
// 「某函数 is not defined」——那不是代码坏了，是页面压根没起来（踩过）
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'gc-thinkveil-profile')}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WATCHDOG = setTimeout(() => {
  console.error('\n❌ 超过 150 秒还没跑完，判定卡死（多半是某个 Runtime.evaluate 等着一个永不落地的 Promise）');
  try { chrome.kill(); } catch (_) {}
  process.exit(1);
}, 150000);
let pass = 0, fail = 0;
const t = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n, extra ?? '')); };

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
    if (await ev(`typeof applyThinkVeil === 'function' && typeof renderMsgGroup === 'function'`)) break;
    await sleep(400);
  }
  /* ⚠️ 函数在 ≠ 数据在。loadStateFromDB 是异步的，脚本一加载完这些函数就都有了，
     而 state 里还是出厂默认值。这时候去存「原状态」会存到一个假的 false，
     随后 boot 把盘上的真值灌进来 —— body 挂上 think-seen，下面第一条断言当场红，
     页面零报错、源码一个字没错，换个空 profile 跑还全绿。查这个花了一轮。
     判据直接问「state 和盘上一致了吗」，别猜某个函数在不在。 */
  let synced = false;
  for (let i = 0; i < 40; i++) {
    synced = await ev(`(async()=>{
      if (typeof idbGet !== 'function') return false;
      const v = await idbGet('kuro_thinkOpen');
      if (v === undefined || v === null) return true;      // 盘上压根没存过，默认值就是对的
      return JSON.parse(String(v)) === !!state.thinkOpen;
    })()`);
    if (synced) break;
    await sleep(300);
  }
  t('state 已经和 IndexedDB 对齐了（早读会存到假的「原状态」，跑完再恢复就冲掉真值）', synced === true);

  /* 先把当前状态存下来。这份测试会真的调 setThinkOpen → save() → 写
     IndexedDB，跑完必须原样放回去，不然跑完测试显示开关就被改掉了。 */
  const saved = await ev(`JSON.stringify({o:!!state.thinkOpen, v:state.thinkOpenVer||0, off:!!(state.skillsOff||{}).thinkveil})`);
  console.log('  （已存下原状态，跑完会放回去：' + saved + '）');

  /* 前置条件：得有一个**选中**的对话，不然 getActiveChat() 是 undefined，
     这份测试会从第一条起全红，而页面零报错 —— 排查起来看着像功能崩了。
     headless 的 profile 里 activeChatId 经常是 null（对话有，只是没选中）。 */
  const prevActive = await ev(`JSON.stringify(state.activeChatId ?? null)`);
  const haveChat = await ev(`(()=>{
    if (!getActiveChat() && (state.chats||[]).length) state.activeChatId = state.chats[0].id;
    return !!getActiveChat();
  })()`);
  t('有一个选中的对话可以往里造测试消息（前置条件，不是被测功能）', haveChat === true,
    'state.chats 条数=' + await ev(`(state.chats||[]).length`));
  if (!haveChat) {
    console.log('\n❌ 这个 profile 里一条对话都没有，后面全部无从下手 —— 先在这个 origin 上开一个对话');
    clearTimeout(WATCHDOG); ws.close(); chrome.kill(); process.exit(1);
  }

  console.log('\n[1] 先把糊面渲染出来：四个渲染点有没有真的包上');
  /* 造一条带思考链的消息走真正的渲染函数，但**不接进 chat.headId 那条链** ——
     改 headId 是在动用户真实的对话结构，测试中途崩一次就可能把她的消息藏起来。 */
  const mid = await ev(`(()=>{
    const chat=getActiveChat(); if(!chat) return null;
    const id=nextId();
    chat.nodes[id]={id,role:'assistant',content:'正文一句',reasoning:'我在想要不要告诉她这件事',
                    thinkingSummary:'在犹豫该不该说',parentId:null,ts:Date.now()};
    const box=document.createElement('div');
    box.id='veilMsgBox';
    box.innerHTML=renderMsgGroup(chat.nodes[id], 0);
    document.getElementById('chatWindow').appendChild(box);
    return id;
  })()`);
  t('造出了一条带思考链的消息', mid != null, mid);
  t('思考块渲染出来了', await ev(`!!document.querySelector('#veilMsgBox .think-block')`));
  t('正文包进了糊面（.think-body 里有 .think-veil）',
    await ev(`!!document.querySelector('#veilMsgBox .think-body .think-veil')`));
  t('正文一个字都没漏在糊面外头',
    await ev(`(()=>{const b=document.querySelector('#veilMsgBox .think-body');
      if(!b) return false;
      const veiled=[...b.querySelectorAll('.think-veil')].map(x=>x.textContent).join('');
      // body 的全部文字减去糊面里的，剩下的只允许是空白（.think-note 那行这条消息里没有）
      return b.textContent.replace(veiled,'').trim()==='';})()`));
  /* DeepSeek 的概括在**标题**上而不在正文里。漏了这一层的话，一句
     「在犹豫该不该说」等于把整段思考剧透了，糊了正文也白糊。 */
  t('DeepSeek 的概括也包进了糊面（标题上的概括同样要糊）',
    await ev(`(()=>{const v=document.querySelector('#veilMsgBox .think-label .think-veil');
      return !!v && v.textContent.indexOf('在犹豫该不该说')>=0;})()`));
  t('💭 留在糊面外面（不然她看不出这块是思考）',
    await ev(`(()=>{const l=document.querySelector('#veilMsgBox .think-label');
      return !!l && l.childNodes[0] && l.childNodes[0].textContent.indexOf('💭')>=0;})()`));
  t('折叠块上有那把锁', await ev(`!!document.querySelector('#veilMsgBox .think-lock')`));

  console.log('\n[2] 默认就是糊的（量 computed，别看源码）');
  await ev(`(()=>{ state.thinkOpen=false; if(state.skillsOff) delete state.skillsOff.thinkveil; applyThinkVeil(); })()`);
  await sleep(80);
  t('body 上没有 think-seen（默认态＝糊着，JS 挂了也不会先清晰地闪一下）',
    await ev(`!document.body.classList.contains('think-seen')`));
  const blurBody = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).filter`);
  t('正文真的糊了（computed filter = blur(5px)）', blurBody === 'blur(5px)', blurBody);
  const blurLabel = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-label .think-veil')).filter`);
  t('概括也真的糊了', /^blur\(3\.5px\)$/.test(blurLabel), blurLabel);
  const selBody = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).userSelect`);
  t('糊掉的思考选不中（computed user-select = none）', selBody === 'none', selBody);
  /* 这一条是反面：filter 不能被子元素撤销，所以「只有小标题」那行说明必须在糊面
     **外面**。糊掉的话她连「为什么没正文」都读不到，而这种事只有真渲染才看得见。 */
  t('「只有小标题」那行说明不在糊面里（filter 撤不回来，糊了她就读不到）',
    await ev(`(()=>{const n=document.querySelector('.think-note');
      return n ? !n.closest('.think-veil') : true;})()`));

  console.log('\n[3] 解锁是全局的：一开就是**所有**思考（兼容历史里的 [[THINK_OPEN]]）');
  const okOpen = await ev(`(()=>{
    const chat=getActiveChat();
    processAiCommands('好啊[[THINK_OPEN]]', chat, {id:'m1',nickname:'克克'}, {});
    return !!state.thinkOpen;
  })()`);
  t('[[THINK_OPEN]] 真的把锁开了', okOpen === true);
  t('body 上挂上了 think-seen', await ev(`document.body.classList.contains('think-seen')`));
  const afterFilter = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).filter`);
  t('这条**旧**消息的思考跟着清晰了（全局解锁，不是只解锁那一条）', afterFilter === 'none', afterFilter);
  const afterSel = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).userSelect`);
  t('清晰之后也选得中了', afterSel !== 'none', afterSel);
  t('ver 跟着涨了一格（跨设备合并要靠它）', await ev(`(state.thinkOpenVer||0) > 0`));

  console.log('\n[4] AI 可以撤回去（她的第三条）');
  const okShut = await ev(`(()=>{
    const chat=getActiveChat();
    processAiCommands('不给看了[[THINK_CLOSE]]', chat, {id:'m1',nickname:'克克'}, {});
    return !!state.thinkOpen;
  })()`);
  t('[[THINK_CLOSE]] 真的糊回去了', okShut === false);
  t('body 上的 think-seen 撤了', await ev(`!document.body.classList.contains('think-seen')`));
  t('思考又糊上了',
    await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).filter === 'blur(5px)'`));

  console.log('\n[5] 她自己也能还回去（她的第四条）');
  await ev(`setThinkOpen(true,'ai')`);
  await sleep(60);
  const verBefore = await ev(`state.thinkOpenVer||0`);
  await ev(`thinkVeilTap({stopPropagation(){},preventDefault(){}})`);
  await sleep(60);
  t('点那把锁，思考还回去了', await ev(`state.thinkOpen === false`));
  t('还回去也抬版本（不抬的话另一台设备会把「同意」推回来）',
    await ev(`(state.thinkOpenVer||0) > ${verBefore}`));
  // 糊着的时候点它不该有「破解」的效果 —— 要看就去问它，这是它的东西
  await ev(`thinkVeilTap({stopPropagation(){},preventDefault(){}})`);
  await sleep(60);
  t('糊着的时候点锁不会自己打开（没有绕过它的后门）', await ev(`state.thinkOpen === false`));

  console.log('\n[5b] 糊着的时候，搜索也挖不出来（真搜一次，数命中）');
  /* 这是整份里最实际的一条。页内搜索走的是 DOM 文本，CSS 只管画面 ——
     那段思考老老实实躺在 DOM 里。不排掉的话她可以换着词搜、看命中计数变不变，
     把糊着的内容一个词一个词探出来，前面整套「得等它同意」就成了装饰。
     造的那条消息里思考正文是「我在想要不要告诉她这件事」，拿「要不要告诉」去搜。 */
  /* 搜索栏只开这一次。open() 里有 input.select() 和「选区里有字就拿来当搜索词」，
     反复 open 会把输入框的值搅掉 —— 读到的计数是空串，看着像「搜不到」，
     实际是压根没搜（空输入时 updateCounter 就把计数清空，见 js/27-find.js:291）。 */
  const barOk = await ev(`(()=>{ openFindBar();
    return !!document.getElementById('gcFindInput') && !!document.getElementById('gcFindCount'); })()`);
  t('页内搜索栏开得出来（下面几条全靠它）', barOk === true);
  const doFind = async (word) => {
    await ev(`(()=>{const inp=document.getElementById('gcFindInput');
      inp.value=''; inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(260);                       // 输入有 180ms 防抖，先让「清空」那次落地
    await ev(`(()=>{const inp=document.getElementById('gcFindInput');
      inp.value=${JSON.stringify(word)}; inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(340);                       // 再等这一次搜完，不等就读到上一次的计数
    // 把实测的 input.value 一起带回来：值被别人改掉的时候，直接看得见，
    // 不用对着一个空字符串猜是「搜不到」还是「压根没搜」
    return await ev(`(()=>{const inp=document.getElementById('gcFindInput');
      return document.getElementById('gcFindCount').textContent + ' |词=' + inp.value;})()`);
  };

  // 先证明这条路本身是通的：搜一个**明着**的词（气泡正文），必须搜得到 ——
  // 不然下面那个「搜不到」证明不了任何事（可能只是搜索压根没跑起来）
  await ev(`setThinkOpen(false,'ai')`);
  await sleep(80);
  const hitPlain = await doFind('正文一句');
  t('搜索这条路是通的（搜气泡正文能命中）', /\d+\/\d+/.test(String(hitPlain)), '实测=' + hitPlain);

  /* 折叠着的时候天然搜不到（.think-body 是 display:none，checkVisibility 直接排掉）。
     这条单独钉一下：万一哪天 .think-body 改成 visibility:hidden 或 height:0，
     这一层保护就没了，而下面那条「展开后搜不到」才是真正在验我加的排除逻辑。 */
  const hitsFolded = await doFind('要不要告诉');
  t('折叠着的时候本来就搜不到（display:none 那一层）',
    String(hitsFolded).indexOf('无结果') === 0, '实测=' + hitsFolded);

  /* ⚠️ 真正的洞在这里：她**点开**折叠块之后（不点开压根看不到糊的样子），
     .think-body 变成 display:block，思考正文就进了搜索索引 ——
     换着词搜、看命中数变不变，糊住的内容一个词一个词就被探出来了。
     上面那条「折叠时搜不到」证明不了这件事，第一版我就是拿它当了判据（假绿）。 */
  await ev(`document.querySelectorAll('#veilMsgBox .think-block').forEach(b=>b.classList.add('open'))`);
  await sleep(80);
  t('折叠块真的展开了（下面那条全靠这个前提）',
    await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body')).display === 'block'`));
  const hitsShut = await doFind('要不要告诉');
  t('展开着、但还糊着 → 照样搜不到（这条才是在验那段排除逻辑）',
    String(hitsShut).indexOf('无结果') === 0, '实测=' + hitsShut);

  await ev(`setThinkOpen(true,'ai')`);
  await sleep(80);
  const hitsOpen = await doFind('要不要告诉');
  t('解锁之后同一个词搜得到了（证明挡的是糊面，不是把搜索搞坏了）',
    /\d+\/\d+/.test(String(hitsOpen)), '实测=' + hitsOpen);

  // 收尾：清空并关掉搜索栏，别在她界面上留个开着的搜索框和一片高亮
  await ev(`(()=>{const inp=document.getElementById('gcFindInput');
    if(inp){ inp.value=''; inp.dispatchEvent(new Event('input',{bubbles:true})); }
    if (typeof closeFindBar === 'function') closeFindBar();})()`);
  await sleep(240);

  console.log('\n[6] 锁的图标两个状态不一样（CSS 换，不重渲染整屏）');
  /* 每一段开头自己把状态摆好。上一段为了验「解锁后搜得到」把锁打开了 ——
     不摆的话这里第一下就读到 🔓，断言红着，而功能其实好好的
     （「断言被前面的 setup 掏空」的同款，只是这次是假红不是假绿）。 */
  await ev(`setThinkOpen(false,'ai')`);
  await sleep(80);
  const icoShut = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-lock'),'::before').content`);
  await ev(`setThinkOpen(true,'ai')`); await sleep(60);
  const icoOpen = await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-lock'),'::before').content`);
  t('糊着是 🔒', icoShut.indexOf('\u{1f512}') >= 0, icoShut);
  t('开着是 🔓', icoOpen.indexOf('\u{1f513}') >= 0, icoOpen);
  t('两个图标真的不一样（同一个值说明那条规则没生效）', icoShut !== icoOpen, icoShut + ' vs ' + icoOpen);

  console.log('\n[7] 技能开关关掉＝整功能停用（思考一直明着）');
  await ev(`(()=>{ setThinkOpen(false,'ai'); setSkillOn('thinkveil', false); })()`);
  await sleep(80);
  t('body 上挂了 think-veil-off', await ev(`document.body.classList.contains('think-veil-off')`));
  t('关掉之后不糊了（哪怕 thinkOpen 还是 false）',
    await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).filter === 'none'`));
  t('关掉之后那把锁也不显示（没有能点的东西）',
    await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-lock')).display === 'none'`));
  t('关掉时提示词里没有 [[THINK_OPEN]]',
    await ev(`buildSystemPrompt(getActiveChat(), state.configs&&state.configs[0]||{}).indexOf('[[THINK_OPEN]]') === -1`));
  await ev(`setSkillOn('thinkveil', true)`); await sleep(60);
  t('开回来立刻又糊上',
    await ev(`getComputedStyle(document.querySelector('#veilMsgBox .think-body .think-veil')).filter === 'blur(5px)'`));
  t('开着时提示词里也没有 [[THINK_OPEN]]（这只是界面显示设置）',
    await ev(`buildSystemPrompt(getActiveChat(), state.configs&&state.configs[0]||{}).indexOf('[[THINK_OPEN]]') === -1`));

  console.log('\n[8] 反面：界面自己的话不该被糊');
  t('AI 那两个药丸（mem-block）的正文是明的 —— 那是界面在讲话不是它的思考',
    await ev(`(()=>{
      const d=document.createElement('div'); d.id='veilPillBox';
      d.innerHTML=_thinkVeilPillHtml(true); document.body.appendChild(d);
      const b=d.querySelector('.think-body');
      const f=getComputedStyle(b).filter;
      const inner=b.querySelector('.think-veil');
      d.remove();
      return f==='none' && !inner;})()`));

  console.log('\n[9] 跨设备合并（ver 是逻辑计数器，撞平偏向糊着）');
  t('ver 大的赢（同意方版本高）', await ev(`_mergeThinkOpen(true,5,false,3).on === true`));
  t('ver 大的赢（撤回方版本高）', await ev(`_mergeThinkOpen(true,3,false,9).on === false`));
  t('撞平时两边都同意才算同意（偏向糊着）', await ev(`_mergeThinkOpen(true,4,false,4).on === false`));
  t('撞平且两边都同意，那就是同意', await ev(`_mergeThinkOpen(true,4,true,4).on === true`));
  t('正反向合并结果一样（不许依赖谁先同步）',
    await ev(`_mergeThinkOpen(true,4,false,4).on === _mergeThinkOpen(false,4,true,4).on`));
  t('合并后的 ver 取 max（不取的话下一次写会撞上已用过的版本）',
    await ev(`_mergeThinkOpen(true,3,false,9).ver === 9 && _mergeThinkOpen(true,9,false,3).ver === 9`));

  console.log('\n[10] 落盘真的回得来（持久化三道门）');
  /* ⚠️ 别写成 `await save()` —— save() 是 800ms 防抖的（js/02-state.js:158），
     await 它只是起了个定时器就立刻返回，紧接着去读必然是 null，看起来像功能坏了。
     要验真的写没写就直接调 _doSave()。 */
  await ev(`(async()=>{ setThinkOpen(true,'ai'); await _doSave(); })()`);
  // 先拿一个必然存在的 key 验读取路径本身：读不到有两种可能「没写进去」和「我读错了」，
  // 终端上长得一模一样，不先排掉后者就会把假红当成真 bug 去改代码
  const probeVer = await ev(`(async()=>{ const v = await idbGet('kuro_stickerGroupsVer'); return v===undefined?'MISSING':String(v); })()`);
  t('读取路径本身是通的（先验一个必然存在的 key）', probeVer !== 'MISSING' && probeVer !== 'null', probeVer);
  const back = await ev(`(async()=>{ const v = await idbGet('kuro_thinkOpen'); return JSON.stringify(v); })()`);
  t('第 1 道：写进了 IndexedDB', back === 'true' || back === '"true"', back);
  const backVer = await ev(`(async()=>{ const v = await idbGet('kuro_thinkOpenVer'); return String(v); })()`);
  t('版本号也写进去了', Number(backVer) > 0, backVer);
  // 第 2 道：读盘那张表里有没有它（漏了刷新后它的同意就没了，而且零报错）
  const loaded = await ev(`(async()=>{ const s = await loadStateFromDB(); return JSON.stringify({o:s.thinkOpen, v:s.thinkOpenVer}); })()`);
  t('第 2 道：loadStateFromDB 读得回来', /"o":true/.test(loaded) && /"v":[1-9]/.test(loaded), loaded);

  // ── 收尾：把原状态原样放回去 ──────────────────────────────
  await ev(`(async()=>{
    const s = ${saved};
    state.thinkOpen = s.o; state.thinkOpenVer = s.v;
    if (s.off) { state.skillsOff = state.skillsOff||{}; state.skillsOff.thinkveil = true; }
    else if (state.skillsOff) delete state.skillsOff.thinkveil;
    applyThinkVeil();
    const chat=getActiveChat();
    if (chat && ${mid}!=null) delete chat.nodes[${mid}];
    document.getElementById('veilMsgBox')?.remove();
    state.activeChatId = ${prevActive};      // 前置条件也放回去，别把「没选中」改成「选中了」
    /* ⚠️ 这里**必须** _doSave()，不能 save() —— save 是 800ms 防抖的，
       而下面紧接着就 chrome.kill()，那次恢复根本落不了盘。于是这一轮写进去的
       thinkOpen=true 留在 IndexedDB 里，污染下一次跑（甚至污染她真正的设置），
       而终端上印的是「✓ 跑完把她的原状态放回去了」。 */
    await _doSave();
  })()`);
  const restored = await ev(`JSON.stringify({o:!!state.thinkOpen, v:state.thinkOpenVer||0, off:!!(state.skillsOff||{}).thinkveil})`);
  t('跑完把她的原状态放回去了（测试不许改她的设置）', restored === saved, restored + ' vs ' + saved);
  // 而且**真的落盘了** —— 只改内存不落盘的话，下一次跑会带着这一轮的脏状态开跑
  const restoredOnDisk = await ev(`(async()=>{ const v = await idbGet('kuro_thinkOpen');
    return v === undefined || v === null ? 'MISSING' : String(JSON.parse(String(v))); })()`);
  t('恢复真的写进了 IndexedDB（save() 是防抖的，收尾必须 _doSave）',
    restoredOnDisk === 'MISSING' || restoredOnDisk === String(JSON.parse(saved).o), restoredOnDisk);

  clearTimeout(WATCHDOG);
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试挂了:', e.message); try { chrome.kill(); } catch (_) {} process.exit(1); });
