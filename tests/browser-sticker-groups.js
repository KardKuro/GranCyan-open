// 表情包分组 + emoji 标注的**浏览器**冒烟测试（真跑 loadStickers / renderStickerTabs /
// renderLocalStickers / processAiCommands，不是对着源码做正则断言）。
//
// 为什么非得进浏览器：这两个功能的失败形态全是「代码看着对、界面上没有」——
//   · 标签栏是 innerHTML 拼出来的，写错一个 id 就是整栏不见，静态断言照样全绿
//   · 包里的图走 URL，编码错了是碎图，naturalWidth 才看得见
//   · emoji 药丸靠 :empty 收起来，模板里多一个换行就会在每条消息下面留一条空行
//
// 跑法：
//   1) 先起一个 server：  GRANCYAN_PORT=3097 node server.js
//   2) node tests/browser-sticker-groups.js
//   （端口可以用环境变量 STK_PORT 改）

const { spawn } = require('child_process');
const os = require('os'), path = require('path'), fs = require('fs');

// 自带一个临时表情包：stickers-packs/<PACK>/，测试结束删掉。不依赖仓库里有哪些包。
// 文件名特意带中文、emoji、撇号 —— 编码错一处就是碎图 / onclick 被提前收尾。
const PACK = 'smoke-pack';
const PACK_NAME = '冒烟测试包';
const PACK_DIR = path.join(__dirname, '..', 'stickers-packs', PACK);
const PACK_FILES = ['开心 😊.png', "You're Absolutely Right!.png", '思考.png', 'wave.png', '大哭.png'];
const PACK_N = PACK_FILES.length;
function makePack() {
  const src = path.join(__dirname, '..', 'stickers');
  const pngs = fs.readdirSync(src).filter(f => /\.png$/i.test(f));
  fs.mkdirSync(PACK_DIR, { recursive: true });
  PACK_FILES.forEach((f, i) => fs.copyFileSync(path.join(src, pngs[i % pngs.length]), path.join(PACK_DIR, f)));
  fs.copyFileSync(path.join(src, pngs[0]), path.join(PACK_DIR, '_icon.png'));
  fs.writeFileSync(path.join(PACK_DIR, 'pack.json'), JSON.stringify({ name: PACK_NAME, icon: '_icon.png' }));
}
function dropPack() { try { fs.rmSync(PACK_DIR, { recursive: true, force: true }); } catch (_) {} }
makePack();
process.on('exit', dropPack);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9341;
const PORT = process.env.STK_PORT || 3097;
const URL = `http://127.0.0.1:${PORT}/`;

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'gc-skgrp-profile')}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 看门狗：CDP 的 awaitPromise 碰上一个永远不 resolve 的 Promise 时不会超时也不会报错，
// 整个测试就那么安静地卡住 —— 没有它，「挂了」和「还在跑」在终端上长得一模一样。
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
    if (await ev(`typeof loadStickers === 'function' && typeof renderStickerTabs === 'function'`)) break;
    await sleep(400);
  }

  console.log(`\n[1] 磁盘包自动成栏（stickers-packs/${PACK} → 「${PACK_NAME}」）`);
  await ev(`(async()=>{ await loadStickers(); renderStickerTabs(); })()`);
  const packCount = await ev(`(_stickerPacks||[]).length`);
  t('扫到了包', packCount >= 1, packCount);
  const packName = await ev(`((_stickerPacks||[]).find(p=>p.id==='${PACK}')||{}).name`);
  t('包名取自 pack.json 而不是文件夹名', packName === PACK_NAME, packName);
  const n = await ev(`_packStickers('${PACK}').length`);
  t(`${PACK_N} 张全在（文件夹里有几张就该有几张）`, n === PACK_N, n);

  // 标签栏：两条都得有（电脑那排文字标签 + 手机那条图标栏），少一条就是一端点不进去
  const tabTop = await ev(`!!document.querySelector('#stickerTabsExtra [data-stab="pack:${PACK}"]')`);
  const tabBar = await ev(`!!document.querySelector('#stickerTabbarExtra [data-stab="pack:${PACK}"]')`);
  t('电脑端标签栏里有这一栏', tabTop);
  t('手机端图标栏里也有这一栏', tabBar);
  const icoSrc = await ev(`(document.querySelector('#stickerTabbarExtra [data-stab="pack:${PACK}"] img')||{}).src||''`);
  t('图标用的是包里的 _icon.png', new RegExp(`stickers-packs/${PACK}/_icon\\.png`).test(icoSrc), icoSrc);

  console.log('\n[2] 切进去真的画得出来（URL 编码 / 碎图）');
  await ev(`switchStickerTab('pack:${PACK}')`);
  await sleep(300);
  const cells = await ev(`document.querySelectorAll('#stickerGrid .sticker-item').length`);
  t('格子数 = 包里的张数（分组栏不该混进上传按钮/收藏）', cells === PACK_N, cells);
  // 中文 + emoji + 撇号的文件名全在这个包里，编码错一处就是碎图。等图真的加载完再数。
  // ⚠️ 格子里的 img 是 loading="lazy" 的，headless 窗口小，视口外那些**永远不会开始加载** ——
  // 傻等 onload 就是永久挂起（这个 ev 不返回，整个测试静静卡死，没有任何报错）。
  // 所以先强制 eager，再给每张图一个 8 秒兜底。
  const broken = await ev(`(async()=>{
    const imgs=[...document.querySelectorAll('#stickerGrid .sticker-item img')];
    imgs.forEach(i=>{ i.loading='eager'; });
    await Promise.all(imgs.map(i=>i.complete?null:new Promise(r=>{
      const done=()=>r(); i.onload=done; i.onerror=done; setTimeout(done,8000);
    })));
    return imgs.filter(i=>!i.naturalWidth).map(i=>i.getAttribute('alt'));
  })()`);
  t('一张碎图都没有', Array.isArray(broken) && broken.length === 0, broken);
  // 撇号那张（You're Absolutely Right!）曾经能把 onclick 里的 JS 字符串提前收尾
  const clickOk = await ev(`(()=>{
    const el=[...document.querySelectorAll('#stickerGrid .sticker-item')].find(e=>/Absolutely/.test(e.querySelector('img').alt));
    if(!el) return 'no-such-sticker';
    const before=document.getElementById('userInput').value;
    el.click();
    const after=document.getElementById('userInput').value;
    document.getElementById('userInput').value=before;
    return after;
  })()`);
  t('名字带撇号的那张点了能插进输入框（不是 JS 报错）',
    typeof clickOk === 'string' && clickOk.indexOf(`[[STICKER:${PACK}/You're Absolutely Right!.png]]`) >= 0, clickOk);

  console.log('\n[3] 自建分组：建 → 归类 → 显示 → 删');
  const gid = await ev(`(()=>{
    state.stickerGroups=(state.stickerGroups||[]).filter(g=>g.name!=='冒烟测试组');
    const id='smoke'+Date.now().toString(36);
    // 走真正的写入路径（带 ops 记录），手搓对象会绕开存活判定，测了个假的
    state.stickerGroups.push({id,name:'冒烟测试组',icon:'🧪',v:_markGroup(id,false,'a')});
    renderStickerTabs();
    return id;
  })()`);
  t('新分组出现在标签栏', await ev(`!!document.querySelector('#stickerTabbarExtra [data-stab="grp:${gid}"]')`));
  const emo = await ev(`(document.querySelector('#stickerTabsExtra [data-stab="grp:${gid}"] .sticker-tab-emo')||{}).textContent||''`);
  t('emoji 图标画出来了', emo === '🧪', emo);
  // 归类用的键必须和 loadStickers 的 merge key 同一套，否则组里会凭空少图
  await ev(`(()=>{
    const s=_packStickers('${PACK}')[0];
    _setGroupOf(stickerKey(s), '${gid}');
    switchStickerTab('grp:${gid}');
  })()`);
  await sleep(200);
  t('包里的表情能归进自建分组（键对得上）', await ev(`_groupStickers('${gid}').length`) === 1);
  t('分组栏里画出来了', await ev(`document.querySelectorAll('#stickerGrid .sticker-item').length`) === 1);
  t('分组栏里那颗角标是「移出分组」不是「删除」',
    await ev(`!!document.querySelector('#stickerGrid .sticker-del-fav[title*="移出"]')`));
  // 删组只该摘标签，不该动图本身
  const afterDel = await ev(`(()=>{
    const before=_stickerList.length;
    _markGroup('${gid}', false, 'd');
    for(const k of Object.keys(state.stickerGroupOf||{})) if(_groupIdOf(k)==='${gid}') _setGroupOf(k,null);
    _stickerTab='fav'; renderStickerTabs();
    return {gone:!document.querySelector('[data-stab="grp:${gid}"]'),
            sameStickers:_stickerList.length===before,
            tomb:!_groupAlive('${gid}', false)};
  })()`);
  t('删掉分组后标签没了', afterDel.gone);
  t('删组不会连表情一起没掉', afterDel.sameStickers);
  // 直接从数组抹掉的话，另一台设备会把它当成「我这边新建的」推回来 —— 删不掉的分组
  t('删除留下的是 ops 墓碑，不是把条目抹掉（否则跨设备会复活）', afterDel.tomb);
  // 收尾：把这轮造出来的分组、ops 墓碑、归属墓碑都清掉，别留在用户的真 state 里
  await ev(`(()=>{ state.stickerGroups=(state.stickerGroups||[]).filter(g=>g.id!=='${gid}');
    delete (state.stickerGroupOps||{})['g:${gid}'];
    for(const k of Object.keys(state.stickerGroupOf||{})) if((state.stickerGroupOf[k]||{}).g==null) delete state.stickerGroupOf[k];
    save(); })()`);

  console.log('\n[3.5] 二审补的两条（Codex 逮到的）');
  // 「单开一栏」= 只在那一栏。包里的图同时混在自带表情库里的话，那一栏就没意义了
  await ev(`switchStickerTab('lib')`);
  await sleep(200);
  const libHasPack = await ev(`(()=>{
    const names=new Set(_packStickers('${PACK}').map(s=>s.name));
    return _libStickers().filter(s=>names.has(s.name)&&s.source==='pack').length;
  })()`);
  t('「表情库」那栏不再混进包里的图', libHasPack === 0, libHasPack);
  // 存储键带包名、发送协议只有名字 → 收藏里同名的那张会把包里的顶掉（点 A 发出 B）
  const refDup = await ev(`(()=>{
    const s=_packStickers('${PACK}')[0];
    const fake={name:s.name, desc:'冒名顶替', url:s.url, source:'server', file:'x.png', custom:true};
    _stickerList.unshift(fake);                    // 造一个同名的收藏排在它前面
    const ref=stickerRef(s);
    const got=findSticker(ref);
    _stickerList.shift();
    return {ref, hitPack: got && got.source==='pack', file:s.file};
  })()`);
  t('包里的表情引用带包前缀 + 完整文件名', refDup.ref === PACK + '/' + refDup.file, refDup.ref);
  t('拿这个引用查回来的确实是包里那张，不是同名的收藏', refDup.hitPack === true);
  // 「撞名才加前缀」那版被打回来了：引用在历史里躺很久，含义不能随当前列表变
  t('不撞名的包表情也照样带前缀（含义不随列表漂移）',
    await ev(`(()=>{const s=_packStickers('${PACK}').find(x=>_stickerList.filter(y=>y.name===x.name).length===1);return s?stickerRef(s)==='${PACK}/'+s.file:true;})()`));
  t('真点一下，输入框里进去的就是这个引用', await ev(`(()=>{
    const s=_packStickers('${PACK}')[0];
    const inp=document.getElementById('userInput'); const before=inp.value;
    sendLocalSticker(stickerRef(s));
    const got=inp.value; inp.value=before;
    return got.indexOf('[[STICKER:${PACK}/'+s.file+']]')>=0;
  })()`));

  console.log('\n[4] emoji 标注');
  /* 造一条消息走真正的渲染函数，但**不接进 chat.headId 那条链**：
     改 headId 是在动用户真实的对话结构，测试中途崩一次就可能把她的消息藏起来。
     这里只把节点挂进 chat.nodes（toggleReaction 要靠它查），HTML 塞进一个临时容器，
     渲染路径仍然是 renderMsgGroup 本人。 */
  const mid = await ev(`(()=>{
    const chat=getActiveChat(); if(!chat) return null;
    const id=nextId();
    chat.nodes[id]={id,role:'user',content:'冒烟测试消息',parentId:null,ts:Date.now()};
    const box=document.createElement('div');
    box.id='smokeMsgBox';
    box.innerHTML=renderMsgGroup(chat.nodes[id], 0);
    document.getElementById('chatWindow').appendChild(box);
    return id;
  })()`);
  t('造出了一条消息', mid != null, mid);
  t('气泡下面有那一行（容器必须一直在，不然贴第一个 emoji 要整条重画）',
    await ev(`!!document.getElementById('react-row-${mid}')`));
  t('没有标注时它是空的（靠 :empty 收起来；模板里多一个换行就不算空了）',
    await ev(`(()=>{const r=document.getElementById('react-row-${mid}');return !!r && r.innerHTML==='';})()`));
  t('空的时候真的不占位（量 computed display，别只看 innerHTML）',
    await ev(`getComputedStyle(document.getElementById('react-row-${mid}')).display==='none'`));
  await ev(`toggleReaction(${mid},'😂')`);
  await sleep(120);
  t('点一下贴上了', await ev(`document.querySelectorAll('#react-row-${mid} .react-pill').length`) === 1);
  t('是自己贴的（高亮）', await ev(`!!document.querySelector('#react-row-${mid} .react-pill.mine')`));
  await ev(`toggleReaction(${mid},'😂')`);
  await sleep(120);
  // 先确认那一行还在，再说「取消了」—— 不然行没了也是 0 个药丸，这条会假绿
  t('再点一下取消（行还在，只是空了）',
    await ev(`!!document.getElementById('react-row-${mid}')`)
    && await ev(`document.querySelectorAll('#react-row-${mid} .react-pill').length`) === 0);

  console.log('\n[5] AI 侧：[[REACT:]] 的三个配套');
  const aiRes = await ev(`(()=>{
    const chat=getActiveChat();
    const ctx={userTurnId:${mid}};
    const out=processAiCommands('好笑死了 [[REACT: 🤣]] 你继续说', chat, {id:'m1',nickname:'克克'}, ctx);
    const m=chat.nodes[${mid}];
    return {out, list:(m.reactions||[]).map(r=>r.e+'/'+r.by+'/'+r.who)};
  })()`);
  t('标签从正文里抹干净了（不许裸在气泡里）', aiRes.out.indexOf('[[REACT') === -1, aiRes.out);
  t('正文其余部分原样留着', /好笑死了/.test(aiRes.out) && /你继续说/.test(aiRes.out), aiRes.out);
  t('emoji 贴到了它正在回复的那条用户消息上', aiRes.list.join() === '🤣/ai/克克', aiRes.list);
  const dup = await ev(`(()=>{
    const chat=getActiveChat();
    processAiCommands('[[REACT: 🤣]]', chat, {id:'m1',nickname:'克克'}, {userTurnId:${mid}});
    return (chat.nodes[${mid}].reactions||[]).length;
  })()`);
  t('同一个模型贴同一个 emoji 不叠加', dup === 1, dup);
  // 群里两个模型可以起一样的昵称。拿昵称去重的话，第二个模型贴不上（被当成重复）
  const twins = await ev(`(()=>{
    const chat=getActiveChat();
    processAiCommands('[[REACT: 🤣]]', chat, {id:'m2',nickname:'克克'}, {userTurnId:${mid}});
    return (chat.nodes[${mid}].reactions||[]).filter(r=>r.e==='🤣').length;
  })()`);
  t('同昵称的另一个模型贴得上（身份认的是模型 id）', twins === 2, twins);
  t('流式半截标签被遮住', await ev(`maskStreamingReact('在想 [[REACT: 🤣').indexOf('[[REACT')===-1`));
  t('blocks 那条路也把标签抹了（渲染只看 blocks，不补就裸给用户看）',
    await ev(`(()=>{const b=[{type:'text',text:'嗯 [[REACT: 😂]] 好'}];_applyReactToBlocks(b);return b[0].text.indexOf('[[REACT')===-1;})()`));
  t('回填给模型时能看见已有的标注',
    await ev(`/emoji 标注/.test(reactionsForApi(getActiveChat().nodes[${mid}]))`));
  t('没有标注的消息不往 API 里塞空话',
    await ev(`reactionsForApi({id:-1})===''`));

  // 收尾：把造出来的节点和临时容器撤掉，别在用户的对话里留垃圾（它没进 headId 那条链，
  // 所以只要删掉节点和这个 div 就干净了；不调 save()，本来就没打算落盘）
  await ev(`(()=>{
    const chat=getActiveChat();
    if (chat && ${mid}!=null) delete chat.nodes[${mid}];
    document.getElementById('smokeMsgBox')?.remove();
  })()`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试挂了:', e.message); chrome.kill(); process.exit(1); });
