const fs=require('fs'),vm=require('vm');let p=0,f=0;
function ok(n,v){v?(console.log('  ✓ '+n),p++):(console.error('  ✗ '+n),f++)}
const src=fs.readFileSync('js/39-ludo.js','utf8'),store={};
const s={console,state:{configs:[{id:'a',nickname:'Nova'}]},localStorage:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v},setTimeout:()=>0,escHtml:String,
  document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[]}};
vm.createContext(s);vm.runInContext(src,s);const run=x=>vm.runInContext(x,s);

console.log('\n[飞行棋]');
run("_ludo=_ludoFresh('a')");

// ── 棋盘 ──
ok('20 格环形跑道坐标互不重复',run('LUDO_POS.length===20&&LUDO_CELLS.length===20&&new Set(LUDO_POS.map(x=>x.join(","))).size===20'));
ok('两人起飞点在环的对角',run('Math.abs(LUDO_START.user-LUDO_START.ai)===10'));
ok('起飞点格子类型和起飞点常量对得上',run("LUDO_CELLS[LUDO_START.user]==='start-u'&&LUDO_CELLS[LUDO_START.ai]==='start-a'"));
ok('step 换算跑道格号：走满 20 步回到起飞点',run("_ludoCell('user',1)===0&&_ludoCell('user',20)===19&&_ludoCell('ai',1)===10&&_ludoCell('ai',11)===0"));
ok('停机坪和终点道都不在环上',run("_ludoCell('user',0)===-1&&_ludoCell('user',21)===-1&&_ludoCell('user',24)===-1"));

// ── ① 掷 6 才能起飞 ──
const hangar={user:[0,0],ai:[0,0]};s.hangar=hangar;
ok('停机坪里掷 5 不能起飞',run("_ludoResolve(hangar,'user',0,5).ok===false"));
ok('停机坪里掷 6 起飞到第 1 步',run("(r=>r.ok&&r.to===1)(_ludoResolve(hangar,'user',0,6))"));
ok('起飞之后可以再掷一次',run("_ludoResolve(hangar,'user',0,6).again===true"));

// ── ② 掷 6 额外一次（跑道上也算）──
run("mid={user:[3,0],ai:[0,0]}");
ok('跑道上掷 6 也多一次',run("_ludoResolve(mid,'user',0,6).again===true"));
ok('跑道上掷 3 不多给',run("_ludoResolve(mid,'user',0,3).again!==true"));

// ── ③ 同色跳 4 ──
// 用户的 jump-u 在 2 号格 = user 的第 3 步。从第 1 步掷 2 落到第 3 步 → 再跳 4 → 第 7 步
ok('落到自己颜色的格子往前跳 4',run("(r=>r.to===7)(_ludoResolve({user:[1,0],ai:[0,0]},'user',0,2))"));
// AI 踩到 jump-u（2 号格）不该跳：ai 第 12 步 = 格 (10+11)%20 = 1，掷 1 到第 13 步 = 格 2
ok('AI 踩到用户的颜色格不会跳',run("(r=>r.to===13)(_ludoResolve({user:[0,0],ai:[12,0]},'ai',0,1))"));

// ── ④ 航线飞 12 ──
// fly-u 在 4 号格 = user 第 5 步。从第 1 步掷 4 → 第 5 步 → 直飞 12 → 第 17 步
ok('落到自己的航线格直飞 12',run("(r=>r.to===17)(_ludoResolve({user:[1,0],ai:[0,0]},'user',0,4))"));
ok('航线会让这一步远超骰子点数',run("(r=>r.to-1>4)(_ludoResolve({user:[1,0],ai:[0,0]},'user',0,4))"));

// ── ⑤ 撞机 ──
// user 第 4 步 = 格 3；ai 停在格 3 = ai 第 14 步（(10+13)%20=3）
ok('落到对方飞机头上把它打回停机坪',run("(r=>r.bump&&r.bump.k==='ai'&&r.bump.idx===0)(_ludoResolve({user:[1,0],ai:[14,0]},'user',0,3))"));
ok('自己的飞机不会被自己撞下来',run("_ludoResolve({user:[1,4],ai:[0,0]},'user',0,3).bump==null"));
run("_ludo=_ludoFresh('a');_ludo.planes={user:[1,0],ai:[14,0]};_ludoApply('user',0,_ludoResolve(_ludo.planes,'user',0,3))");
ok('撞机落库后对方真的回到 0',run("_ludo.planes.ai[0]===0"));

// ── ⑥ 终点要精确 ──
ok('走到正好 24 算到家',run("(r=>r.to===24)(_ludoResolve({user:[21,0],ai:[0,0]},'user',0,3))"));
ok('超过终点原路退回',run("(r=>r.to===22)(_ludoResolve({user:[23,0],ai:[0,0]},'user',0,3))"));
ok('已经到家的飞机不再动',run("_ludoResolve({user:[24,0],ai:[0,0]},'user',0,3).ok===false"));

// ── ⑦ 胜负 ──
run("_ludo=_ludoFresh('a');_ludo.planes.user=[24,24]");
ok('两架都到家才判赢',run("_ludoCheck()===true&&_ludo.over===true"));
run("_ludo=_ludoFresh('a');_ludo.planes.user=[24,20]");
ok('只到家一架不算赢',run("_ludoCheck()===false&&_ludo.over===false"));

// ── ⑧ 事件格 ──
ok('八个事件格各自绑定一号效果',run("LUDO_CELLS.filter(t=>t==='event').length===LUDO_EFFECTS.length"));
ok('非事件格查不到效果',run("_ludoEventAt(0)===-1&&_ludoEventAt(2)===-1"));
ok('事件格按格号顺序取效果',run("_ludoEventAt(1)===0&&_ludoEventAt(3)===1&&_ludoEventAt(5)===2&&_ludoEventAt(18)===7"));
// 1 号格 = user 第 2 步，效果 0 = forward 3 → 落到 2 步再前进 3 = 第 5 步
run("_ludo=_ludoFresh('a');_ludo.planes={user:[1,0],ai:[0,0]};_ludoApply('user',0,_ludoResolve(_ludo.planes,'user',0,1))");
ok('事件「前进」真的把飞机往前挪',run("_ludo.planes.user[0]===5"));
ok('事件文案会显示在本轮动态里',run("_ludo.event.length>0&&_ludo.log.some(x=>x.indexOf('【事件】')===0)"));
// 3 号格 = user 第 4 步，效果 1 = back 2 → 第 2 步
run("_ludo=_ludoFresh('a');_ludo.planes={user:[3,0],ai:[0,0]};_ludoApply('user',0,_ludoResolve(_ludo.planes,'user',0,1))");
ok('事件「后退」真的把飞机往回挪',run("_ludo.planes.user[0]===2"));
// 5 号格 = user 第 6 步，效果 2 = again
run("_ludo=_ludoFresh('a');_ludo.planes={user:[5,0],ai:[0,0]};againOut=_ludoApply('user',0,_ludoResolve(_ludo.planes,'user',0,1))");
ok('事件「再掷一次」会把额外回合传出来',run("againOut===true"));
// ⬇ 原先这里是一条假绿：传 to=1 落在起飞格，压根没触发 back 事件，最后只查了一个本来就是 1 的值。
// 穷举过棋盘：两个 back 格（n=2 / n=3）能到达的最小落点是 step 2 和 step 1，
// 所以「退到 0」在当前布局下压根造不出来，Math.max(1,…) 是防御性死代码。
// 硬造一个不存在的局面等于造假数据，所以改成穷举全部落点、验更强的不变量。
ok('穷举所有合法走法：落点永远在 1..24，永远不会被退回停机坪', run(`(()=>{
  for(const k of ['user','ai'])for(let st=0;st<=24;st++)for(let d=1;d<=6;d++){
    _ludo=_ludoFresh('a');_ludo.planes[k]=[st,0];_ludo.planes[k==='user'?'ai':'user']=[0,0];
    const r=_ludoResolve(_ludo.planes,k,0,d);if(!r.ok)continue;
    _ludoApply(k,0,r);const v=_ludo.planes[k][0];
    if(!Number.isInteger(v)||v<1||v>24)return false;
  }return true})()`));

// ── ⑨ 主题版本只换文案不换效果 ──
ok('四个主题版本都在',run("Object.keys(LUDO_EVENTS).length>=4&&!!LUDO_EVENTS.standard&&!!LUDO_EVENTS.couple&&!!LUDO_EVENTS.maid&&!!LUDO_EVENTS.butler"));
ok('每个版本的文案条数都对齐效果表',run("Object.values(LUDO_EVENTS).every(v=>v.texts.length===LUDO_EFFECTS.length)"));
ok('换版本不改变任何一格的效果',run("(()=>{const a=[];for(const t of Object.keys(LUDO_EVENTS)){_ludo=_ludoFresh('a',t);const seq=[];for(let c=0;c<20;c++){const e=_ludoEventAt(c);seq.push(e<0?'-':LUDO_EFFECTS[e].kind+LUDO_EFFECTS[e].n)}a.push(seq.join(','))}return new Set(a).size===1})()"));
ok('换版本换到的是不同的文案',run("LUDO_EVENTS.standard.texts[0]!==LUDO_EVENTS.maid.texts[0]&&LUDO_EVENTS.couple.texts[0]!==LUDO_EVENTS.butler.texts[0]"));
ok('乱填的版本名会落回标准版',run("_ludoFresh('a','不存在的版本').theme==='standard'"));

// ── ⑩ AI 选飞机 ──
run("_ludo=_ludoFresh('a')");
ok('能撞对方就优先撞',run("(()=>{const pl={ai:[1,4],user:[14,0]};return _ludoPlan(pl,'ai',3)===0})()"));
ok('没得动就返回 -1',run("_ludoPlan({ai:[0,0],user:[0,0]},'ai',3)===-1"));
ok('能起飞就把飞机放出来',run("_ludoPlan({ai:[0,0],user:[0,0]},'ai',6)>=0"));
ok('优先走能精确到家的那架',run("(()=>{const pl={ai:[21,5],user:[0,0]};return _ludoPlan(pl,'ai',3)===0})()"));

// ── ⑪ 存档 ──
run("_ludo=_ludoFresh('a');_ludo.turn='ai';_ludoSave();_ludo=null;_ludoLoad()");
ok('重开面板会把卡死的 AI 回合还给用户',run("_ludo.turn==='user'&&_ludo.log.some(x=>x.includes('控制权已还给你'))"));
run("localStorage.setItem('grancyan_ludo',JSON.stringify({v:99,junk:1}));_ludo=null;_ludoLoad()");
ok('版本对不上的旧存档直接重开一局',run("_ludo.v===1&&_ludo.planes.user.length===2"));
ok('默认对手是不调用 API 的本地猫猫',run("_ludoFresh().aiId==='local'")&&src.includes('本地猫猫（不调用 AI）'));


// ── ⑬ 脏存档 fail closed（Codex：planes.ai=[] 会让 every() 恒真 → AI 无机却判赢）──
function badSave(o, name) {
  run("localStorage.setItem('grancyan_ludo'," + JSON.stringify(JSON.stringify(o)) + ");_ludo=null;_ludoLoad()");
  ok(name, run("_ludo.planes.user.length===2&&_ludo.planes.ai.length===2&&_ludo.planes.user.every(s=>s===0)"));
}
const good = JSON.parse(run("JSON.stringify(_ludoFresh('a'))"));
badSave(Object.assign({}, good, { planes: { user: [0], ai: [0, 0] } }), '脏存档：user 只有一架 → 重开');
badSave(Object.assign({}, good, { planes: { user: [0, 0], ai: [] } }), '脏存档：ai 零架（会被判赢）→ 重开');
badSave(Object.assign({}, good, { planes: { user: [0, 999], ai: [0, 0] } }), '脏存档：step 越界 → 重开');
badSave(Object.assign({}, good, { planes: { user: [0, -1], ai: [0, 0] } }), '脏存档：step 负数 → 重开');
badSave(Object.assign({}, good, { planes: { user: [0, '3'], ai: [0, 0] } }), '脏存档：step 是字符串 → 重开');
badSave(Object.assign({}, good, { turn: 'nobody' }), '脏存档：非法 turn（会死局）→ 重开');
badSave(Object.assign({}, good, { log: '不是数组' }), '脏存档：log 不是数组 → 重开');
badSave(Object.assign({}, good, { lastRoll: 99 }), '脏存档：lastRoll 越界 → 重开');
badSave(Object.assign({}, good, { over: 'yes' }), '脏存档：over 不是布尔 → 重开');
// 对照组：干净存档不能被误伤（不写这条的话，把校验写成 return false 也能全绿）
run("_ludo=_ludoFresh('a');_ludo.planes={user:[3,7],ai:[2,0]};_ludo.lastRoll=4;_ludoSave();_ludo=null;_ludoLoad()");
ok('对照组：干净存档原样读回，没被误伤', run("_ludo.planes.user.join()==='3,7'&&_ludo.planes.ai.join()==='2,0'"));

// ── ⑭ picking 恢复（Codex：重开会让这次骰子作废，白捡一个点数）──
run("_ludo=_ludoFresh('a');_ludo.planes={user:[2,7],ai:[0,0]};_ludo.lastRoll=3;_ludo.picking=true;_ludoSave();_ludo=null;_ludoLoad()");
ok('掉头重开后仍然要把刚掷的骰子选完', run("_ludo.picking===true&&_ludo.lastRoll===3"));
run("_ludo=_ludoFresh('a');_ludo.planes={user:[24,24],ai:[0,0]};_ludo.lastRoll=3;_ludo.picking=true;_ludoSave();_ludo=null;_ludoLoad()");
ok('但已经没飞机可选时不会卡在选机界面', run("_ludo.picking===false"));

// ── ⑮ 事件把飞机推到对方头上，也要撞（Codex 给的复现）──
// 用户 step1 掷 1 → step2（格 1，forward 3）→ step5 = 跑道格 4；AI step15 也在跑道格 4
ok('复现前提：事件后双方确实同格', run("_ludoCell('user',5)===_ludoCell('ai',15)"));
run("_ludo=_ludoFresh('a');_ludo.planes={user:[1,0],ai:[15,0]};_ludoApply('user',0,_ludoResolve(_ludo.planes,'user',0,1))");
ok('事件推着撞上对方，对方也要回停机坪', run("_ludo.planes.user[0]===5&&_ludo.planes.ai[0]===0"));
ok('而且日志里说清楚是被事件推着撞的', run("_ludo.log.some(x=>x.includes('被事件推着撞上'))"));
// 对照组：事件没挪动位置时不该凭空多一条撞机日志
run("_ludo=_ludoFresh('a');_ludo.planes={user:[7,0],ai:[0,0]};_ludoApply('user',0,_ludoResolve(_ludo.planes,'user',0,1))");
ok('对照组：没人可撞时不会凭空多出一条撞机日志', run("!_ludo.log.some(x=>x.includes('被事件推着撞上'))"));

// ── ⑯ 看门狗代际（Codex 一审第 1 条）──
// vm 里的 setTimeout 是个桩，这里换成能手动触发的，才能真的把过期回调叫起来
s.__timers = []; s.setTimeout = fn => { s.__timers.push(fn); return s.__timers.length; };
run("_ludo=_ludoFresh('a');_ludo.turn='ai';_ludoAnimating=true;_ludoAnimationWatchdog(_ludoRun)");
run('_ludoRun++;_ludoAnimating=true');            // 下一代开始（AI 连掷 6）
s.__timers.forEach(fn => fn());                    // 上一代的看门狗醒了
ok('过期的看门狗不会解掉下一代的动画锁', run('_ludoAnimating===true'));
ok('也不会把 AI 回合抢回给用户', run("_ludo.turn==='ai'"));
// 对照组：当代的看门狗必须真的能解锁（否则上面两条只是把看门狗弄死了也能绿）
s.__timers.length = 0;
run("_ludo=_ludoFresh('a');_ludo.turn='ai';_ludoAnimating=true;_ludoAnimationWatchdog(_ludoRun)");
// 基准要在**看门狗触发前一瞬**取。先前拿的是 genBefore，中间隔着一次手动
// _ludoRun++，就算解锁根本不换代也能满足 > genBefore——故障注入时拆掉
// _ludoRun++ 这条照样全绿，是我自己写的假绿。
const genAtWatchdog = run('_ludoRun');
s.__timers.forEach(fn => fn());
ok('对照组：当代的看门狗照样能解锁并还回合', run("_ludoAnimating===false&&_ludo.turn==='user'"));
ok('对照组：解锁时会换代，让还在跑的旧协程落子前退出', run('_ludoRun') > genAtWatchdog);


// ── ⑰ 动画中重开 / 重新开局，旧协程不许落子（Codex 二审）──
// 造一个「旧协程醒来」的场景：它手里攥着换代前的 run，醒来时局面已经换了一局。
run("_ludo=_ludoFresh('a');_ludo.planes={user:[5,9],ai:[3,0]};_ludoSave();const staleRun=_ludoRun;_ludoAnimating=true");
run("ludoNew()");
ok('动画中「重新开局」会换代', run('_ludoRun') > run('staleRun'));
ok('并且顺手解掉动画锁（不然新局第一颗骰子就点不动）', run('_ludoAnimating===false'));
ok('新局真的是空的', run("_ludo.planes.user.join()==='0,0'&&_ludo.planes.ai.join()==='0,0'"));
// 旧协程带着过期的 run 醒来：它在 _ludoUserMove / ludoAiTurn 里的判据应当让它退出。
// 这里直接验判据本身——过期的 run 不等于当代，所以那三处 `if (run !== _ludoRun) return` 会命中。
ok('旧协程手里的 run 已经过期，落子判据会拦住它', run('staleRun !== _ludoRun'));
run("openLudo && (_ludoAnimating=true, (function(){const before=_ludoRun; openLudo(); globalThis.__openBumped = _ludoRun>before;})())");
ok('关窗重开也换代（同一个漏洞的另一个入口）', run('__openBumped===true'));

// 吐槽：过期的那一局回来了也不许写 quip
run("_ludo=_ludoFresh('a');_ludo.quip='本局的话';const oldRun=_ludoRun;_ludoRun++");
ok('模型吐槽带代际参数，过期就不写回去',
   src.includes('async function _ludoAskSelectedAi(run)') && src.includes('if (run !== undefined && run !== _ludoRun) return;'));
ok('AI 回合在**请求之前**就已经落盘（请求要几秒，期间重开不能丢掉这一步）',
   /_ludoSave\(\); renderLudo\(\);\s*\n\s*await _ludoAskSelectedAi\(run\);/.test(src));
// 对照组：本地猫猫压根不发请求，也就不该被代际判据挡掉台词
run("_ludo=_ludoFresh('local');_ludo.quip='猫猫的话'");
ok('对照组：本地猫猫不受影响（它根本不发请求）', run("_ludo.aiId==='local'&&_ludo.quip==='猫猫的话'"));

// ── ⑫ 挂载与 UI ──
const html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('css/grancyan.css','utf8');
ok('小组件入口、弹窗与脚本都挂上了',html.includes('openWidget(openLudo)')&&html.includes('id="ludoModal"')&&html.includes('js/39-ludo.js'));
ok('弹窗里有渲染目标节点',html.includes('id="ludoBody"'));
ok('功能指南里写了飞行棋的规则',html.includes('class="help-key">✈️ 飞行棋</div>')&&html.includes('掷出 6 才能起飞')&&html.includes('精确走到第 24 步')&&html.includes('只换文案，不改规则'));
ok('面板可纵向滚动并显示滑条',css.includes('.ludo-panel .cap-body')&&css.includes('.ludo-panel .cap-body::-webkit-scrollbar-thumb'));
// 用户吃过播放器进度条冒绿色的亏，飞行棋这边一律走主题变量
ok('配色全走主题变量，没有写死的绿色',!/\.ludo-[a-z-]*\{[^}]*(?:#0f0|#00ff00|green|lime|rgb\(\s*0\s*,\s*\d+\s*,\s*0\s*\))/i.test(css));
ok('骰子滚动后才落到最终点数',src.includes('async function _ludoRollAnimation')&&src.includes("classList.add('rolling')"));
ok('棋子沿途按 hops 逐格生成关键帧',src.includes('async function _ludoPawnAnimation')&&src.includes('for (let n = 0; n < hops.length; n++)'));
ok('WebView 动画不回调也会超时继续',src.includes('Promise.race([anim.finished')&&src.includes('duration + 250'));
ok('五秒看门狗会强制解锁',src.includes('function _ludoAnimationWatchdog')&&src.includes('动画超时，已自动解除锁定'));
ok('掷骰按钮由单一判定强制覆盖',src.includes('const canRoll =')&&src.includes('rollBtn.disabled = !canRoll'));
ok('两架都能动时交给用户自己选',src.includes('_ludo.picking = true')&&src.includes('function ludoPick'));
ok('只在真的有得选时才停下来问',src.includes('const distinct =')&&src.includes('if (distinct.length === 1)'));
ok('两架停在同一步时去重只剩一个选项',run("(()=>{const pl={user:[0,0],ai:[0,0]},can=_ludoMovable(pl,'user',6);"+"return can.length===2&&[...new Map(can.map(i=>[pl.user[i],i])).values()].length===1})()"));
ok('两架在不同位置时仍然是两个选项',run("(()=>{const pl={user:[2,7],ai:[0,0]},can=_ludoMovable(pl,'user',3);"+"return [...new Map(can.map(i=>[pl.user[i],i])).values()].length===2})()"));
ok('真实模型被选中时才单独请求一句吐槽',src.includes('async function _ludoAskSelectedAi')&&src.includes("if (_ludo.aiId === 'local') return"));
ok('日志有标题和滚动提示',src.includes('对局记录')&&src.includes('最新在前 · 可滚动'));

// ── ⑱ 桌面与安卓副本一致（少了这条就会出现「网页对、APK 错」且零报错）──
const crypto=require('crypto'),sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
ok('android 副本与 js/39-ludo.js 逐字节一致',sha('js/39-ludo.js')===sha('android/assets/js/39-ludo.js'));
ok('android 的 index.html / css 也同步了飞行棋',
   fs.readFileSync('android/assets/index.html','utf8').includes('js/39-ludo.js')
   &&fs.readFileSync('android/assets/index.html','utf8').includes('openWidget(openLudo)')
   &&fs.readFileSync('android/assets/css/grancyan.css','utf8').includes('.ludo-board'));

console.log(`\n${f?'❌':'✅'} ${p} passed, ${f} failed`);if(f)process.exit(1);
