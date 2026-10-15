// 猫猫大富翁：双人环形棋盘。核心取舍是买地/留现金/升级，不含股票贷款拍卖。
const MONO_CELLS=[['起点',0,0],['鱼干巷',120,24],['好运',0,0],['月光街',160,32],['小憩',0,0],['铃铛路',200,40],['意外',0,0],['纸箱城',240,48],['车站',0,0],['毛线街',280,56],['好运',0,0],['猫爪湾',320,64],['小憩',0,0],['罐头路',360,72],['意外',0,0],['星空城',400,80]];
const MONO_POS=[[5,5],[5,4],[5,3],[5,2],[5,1],[4,1],[3,1],[2,1],[1,1],[1,2],[1,3],[1,4],[1,5],[2,5],[3,5],[4,5]];
let _mono=null;
let _monoAnimating=false;
// 动画代际（照 39-ludo.js 的 _ludoRun）：看门狗和回合协程都记住自己是第几代。
// 以前看门狗不带代际，玩家这回合的 5 秒定时器会在 AI 回合动画中途醒来，只看到共享的
// _monoAnimating===true 就解锁并把回合还给玩家——两个回合并发写同一份局面。
let _monoRun=0;
const _monoWait=ms=>new Promise(r=>setTimeout(r,ms));
function _monoFresh(aiId='local'){return{v:2,aiId,turn:'user',players:{user:{pos:0,cash:1000},ai:{pos:0,cash:1000}},owners:{},levels:{},log:['新的一局开始啦。沿箭头前进，先达到 1800 总资产获胜。'],quip:'来吧，别怪我收租不留情噢。',over:false,pendingBuy:false,pendingUpgrade:false,lastRoll:0};}
function _monoSave(){localStorage.setItem('grancyan_monopoly',JSON.stringify(_mono));}
function _monoLoad(){try{_mono=JSON.parse(localStorage.getItem('grancyan_monopoly'))}catch{};if(!_mono)_mono=_monoFresh('local');_mono.levels||={};_mono.pendingUpgrade=false;if(_mono.turn==='ai'&&!_mono.pendingBuy&&!_mono.pendingUpgrade){_mono.turn='user';_monoAdd('检测到上次停在 AI 回合，控制权已还给你。');_monoSave()}}
function openMonopoly(){_monoRun++;_monoAnimating=false;_monoLoad();document.getElementById('monopolyModal')?.classList.remove('hidden');renderMonopoly();}
function closeMonopoly(){document.getElementById('monopolyModal')?.classList.add('hidden');}
function monoNew(){_monoRun++;_monoAnimating=false;const sel=document.getElementById('monoAi');_mono=_monoFresh(sel?.value||'local');_monoSave();renderMonopoly();}
function monoSetAi(id){_mono.aiId=id;_monoSave();renderMonopoly();}
function _monoUserName(){return (typeof state!=='undefined'&&state&&state.userName)||'你'}
function _monoAiName(){if(!_mono||_mono.aiId==='local')return '本地猫猫';return state.configs?.find(c=>String(c.id)===String(_mono.aiId))?.nickname||'AI';}
function _monoAiStyle(){let h=0;for(const c of String(_mono.aiId||'AI'))h+=c.charCodeAt(0);return[{name:'激进',reserve:180},{name:'均衡',reserve:300},{name:'稳健',reserve:440}][h%3];}
function _monoLevel(i){return _mono.levels[i]||1;}
function _monoUpgradeCost(i){return Math.round(MONO_CELLS[i][1]*.55*_monoLevel(i));}
function _monoRent(i){return MONO_CELLS[i][2]*_monoLevel(i);}
function _monoWorth(k){const p=_mono.players[k];let land=0;for(const [i,o] of Object.entries(_mono.owners))if(o===k)land+=MONO_CELLS[+i][1]+(_monoLevel(+i)-1)*Math.round(MONO_CELLS[+i][1]*.55);return p.cash+land;}
function _monoAdd(s){_mono.log.push(s);if(_mono.log.length>35)_mono.log.shift();}
function _monoQuip(kind){const q={buy:['这块地位置不错，我先收下啦。','以后路过记得带租金（？）'],skip:['现金得留一点，我才不上头。','这块先让给你，看你敢不敢买。'],take:['叮——租金到账，谢谢啦。','踩中我的地了，承让承让。'],pay:['可恶，居然要给你交租。','这笔账我记下了，下圈见。'],upgrade:['还升级？你开始认真了。','租金越来越危险，我得想办法。'],bad:['骰子今天是不是不喜欢我……','怎么又是这种格子。'],roll:['轮到我了，看看骰子站谁。','这一步要是踩你地上就糟了。']};const a=q[kind]||q.roll;_mono.quip=a[(_mono.log.length+String(_mono.aiId||'').length)%a.length];}
async function _monoAskSelectedAi(){const run=_monoRun;if(_mono.aiId==='local')return;const conf=(state.configs||[]).find(c=>String(c.id)===String(_mono.aiId));if(!conf||(!conf.apiKey&&!conf.isLocalClaude&&!conf.isLocalGpt&&!conf.isGemini))return;const prompt=`你正在和${_monoUserName()}玩轻量大富翁。你是${_monoAiName()}，根据刚才局面用自己的语气吐槽一句，最多30个汉字，不解释规则，不加引号。局面：${_mono.log.slice(-3).join('；')}；你有${_mono.players.ai.cash}金币，${_monoUserName()}有${_mono.players.user.cash}金币。`;try{const r=await streamCompletion(conf,[{role:'user',content:prompt}],()=>{});if(run!==_monoRun)return;const q=String(r.fullText||'').trim().replace(/\[\[[\s\S]*?\]\]/g,'').slice(0,60);if(q)_mono.quip=q}catch{}}
function _monoMove(k,d){const p=_mono.players[k],old=p.pos;p.pos=(p.pos+d)%MONO_CELLS.length;if(p.pos<old){p.cash+=200;_monoAdd(`${k==='user'?_monoUserName():_monoAiName()}经过起点，领到 200 金币。`)}const i=p.pos,c=MONO_CELLS[i],owner=_mono.owners[i];_mono.pendingBuy=_mono.pendingUpgrade=false;if(c[1]&&owner&&owner!==k){const rent=_monoRent(i);p.cash-=rent;_mono.players[owner].cash+=rent;_monoAdd(`踩到 ${c[0]} Lv.${_monoLevel(i)}，付给${owner==='user'?_monoUserName():_monoAiName()} ${rent} 租金。`)}else if(c[1]&&!owner){if(k==='user')_mono.pendingBuy=p.cash>=c[1];else{const st=_monoAiStyle();if(p.cash-c[1]>=st.reserve){p.cash-=c[1];_mono.owners[i]='ai';_mono.levels[i]=1;_monoAdd(`${_monoAiName()}按「${st.name}」策略买下了${c[0]}。`)}else _monoAdd(`${_monoAiName()}选择留现金，放弃${c[0]}。`)}}else if(c[1]&&owner===k&&_monoLevel(i)<3){if(k==='user')_mono.pendingUpgrade=p.cash>=_monoUpgradeCost(i);else{const cost=_monoUpgradeCost(i),st=_monoAiStyle();if(p.cash-cost>=st.reserve){p.cash-=cost;_mono.levels[i]=_monoLevel(i)+1;_monoAdd(`${_monoAiName()}把${c[0]}升到 Lv.${_monoLevel(i)}。`)}}}else if(c[0]==='好运'){p.cash+=100;_monoAdd('好运！捡到 100 金币。')}else if(c[0]==='意外'){p.cash-=80;_monoAdd('踩坏花盆，赔了 80 金币。')}}
function _monoCheck(){for(const k of ['user','ai'])if(_monoWorth(k)>=1800||_mono.players[k].cash<0){_mono.over=true;const winner=_mono.players[k].cash<0?(k==='user'?_monoAiName():_monoUserName()):(k==='user'?_monoUserName():_monoAiName());_monoAdd(winner+' 获胜！');return true}return false}
function _monoEndUserTurn(){if(!_monoCheck()){_mono.turn='ai';setTimeout(monoAiTurn,650)}_monoSave();renderMonopoly();}
async function monoRoll(){if(_mono.over||_mono.turn!=='user'||_mono.pendingBuy||_mono.pendingUpgrade||_monoAnimating)return;const run=++_monoRun;_monoAnimating=true;renderMonopoly();const d=1+Math.floor(Math.random()*6),from=_mono.players.user.pos;await _monoRollAnimation(d);if(run!==_monoRun)return;await _monoPawnAnimation('user',from,d);if(run!==_monoRun)return;_mono.lastRoll=d;_monoAdd(`${_monoUserName()}掷出 ${d}，从 ${from} 号格走到 ${(from+d)%MONO_CELLS.length} 号格。`);_monoMove('user',d);_monoAnimating=false;if(!_mono.pendingBuy&&!_mono.pendingUpgrade)_monoEndUserTurn();else{_monoSave();renderMonopoly()}}
function monoBuy(){if(!_mono.pendingBuy)return;const p=_mono.players.user,i=p.pos,c=MONO_CELLS[i];p.cash-=c[1];_mono.owners[i]='user';_mono.levels[i]=1;_mono.pendingBuy=false;_monoAdd(`${_monoUserName()}买下了${c[0]}。`);_monoQuip('upgrade');_monoEndUserTurn();}
function monoUpgrade(){if(!_mono.pendingUpgrade)return;const i=_mono.players.user.pos,cost=_monoUpgradeCost(i);_mono.players.user.cash-=cost;_mono.levels[i]=_monoLevel(i)+1;_mono.pendingUpgrade=false;_monoAdd(`${_monoUserName()}花 ${cost} 把${MONO_CELLS[i][0]}升到 Lv.${_monoLevel(i)}，租金变为 ${_monoRent(i)}。`);_monoQuip('upgrade');_monoEndUserTurn();}
function monoSkipChoice(){_mono.pendingBuy=_mono.pendingUpgrade=false;_monoEndUserTurn();}
async function monoAiTurn(){if(_mono.over||_mono.turn!=='ai')return;const run=++_monoRun;_monoAnimating=true;renderMonopoly();const beforeCash=_mono.players.ai.cash,beforeOwner=Object.keys(_mono.owners).length,d=1+Math.floor(Math.random()*6),from=_mono.players.ai.pos;_monoQuip('roll');await _monoRollAnimation(d);if(run!==_monoRun)return;await _monoPawnAnimation('ai',from,d);if(run!==_monoRun)return;_mono.lastRoll=d;_monoAdd(`${_monoAiName()}掷出 ${d}，从 ${from} 号格走到 ${(from+d)%MONO_CELLS.length} 号格。`);_monoMove('ai',d);if(Object.keys(_mono.owners).length>beforeOwner)_monoQuip('buy');else if(_mono.players.ai.cash<beforeCash)_monoQuip(_mono.owners[_mono.players.ai.pos]==='user'?'pay':'bad');else if(_mono.owners[_mono.players.ai.pos]==='ai')_monoQuip('take');else _monoQuip('skip');_monoCheck();_mono.turn='user';_monoAnimating=false;_monoSave();renderMonopoly();await _monoAskSelectedAi();if(run!==_monoRun)return;_monoSave();renderMonopoly();}
function _monoArrow(i){return i<4?'◀':i<8?'▲':i<12?'▶':'▼';}
// 点数同时写进文字（兜底）和 data-face（CSS 用它画真正的骰子点）
function _monoFace(die,n){die.textContent='⚀⚁⚂⚃⚄⚅'[n-1];if(die.setAttribute)die.setAttribute('data-face',n)}
async function _monoRollAnimation(finalFace){const die=document.querySelector('#monopolyBody .mono-die');if(!die)return;die.classList.add('rolling');for(let i=0;i<9;i++){_monoFace(die,1+Math.floor(Math.random()*6));await _monoWait(65+i*8)}_monoFace(die,finalFace);die.classList.remove('rolling');die.classList.add('landed');await _monoWait(260)}
async function _monoPawnAnimation(k,from,d){const cells=[...document.querySelectorAll('#monopolyBody .mono-cell')];if(cells.length<16||!document.body?.appendChild)return;const first=cells[from]?.getBoundingClientRect();if(!first)return;const pawn=document.createElement('div');pawn.className='mono-moving-pawn';pawn.innerHTML=_monoToken(k);document.body.appendChild(pawn);const frames=[];for(let n=0;n<=d;n++){const rect=cells[(from+n)%16].getBoundingClientRect();frames.push({left:(rect.left+rect.width/2-15)+'px',top:(rect.top+rect.height/2-15)+'px',transform:`scale(${n===d?1.35:1}) rotate(${n*8}deg)`})}const duration=Math.max(500,d*190);try{const anim=pawn.animate(frames,{duration,easing:'ease-in-out',fill:'forwards'});await Promise.race([anim.finished,_monoWait(duration+250)])}catch{await _monoWait(duration)}pawn.remove()}

// 过期的看门狗（run 不是当前代）醒来直接走开；真超时就换代，让还卡在 await 里的旧协程醒来后自己退出。
function _monoAnimationWatchdog(run){setTimeout(()=>{if(run!==_monoRun||!_monoAnimating)return;_monoRun++;_monoAnimating=false;if(_mono.turn==='ai')_mono.turn='user';_monoAdd('动画超时，已自动解除锁定。');_monoSave();renderMonopoly();},5000)}

const _monoRollCore=monoRoll;
// 核心函数到第一个 await 之前是同步的：调用一返回，_monoRun 就是这一回合刚领到的代际。
monoRoll=function(){const r=_monoRollCore();if(_monoAnimating)_monoAnimationWatchdog(_monoRun);return r;};
const _monoAiTurnCore=monoAiTurn;
monoAiTurn=function(){const r=_monoAiTurnCore();if(_monoAnimating)_monoAnimationWatchdog(_monoRun);return r;};
// ── 渲染 ──
// 版面照真大富翁：四个角是非地产格（起点/小憩/车站/小憩），其余八块地按价格从低到高走一遍经典色带
// （棕→浅蓝→粉→橙→红→黄→绿→深蓝）。房子数＝地的等级，棋子是圆形的筹码。
const MONO_BAND={1:'#9a6a46',3:'#5fb8e6',5:'#ee74b6',7:'#f29a2e',9:'#e5484d',11:'#f1cd3c',13:'#2fb27a',15:'#4663e0'};
const MONO_KIND={'起点':['go','➜','路过 +200'],'好运':['luck','🍀','+100 币'],'意外':['oops','📦','−80 币'],'小憩':['rest','🛋️','歇一歇'],'车站':['rest','🚃','歇一歇']};
function _monoToken(k){return`<i class="mono-token ${k==='user'?'u':'a'}">${k==='user'?'🐾':'🤖'}</i>`;}
function _monoHouses(lv){return`<span class="mono-houses lv${lv}">${'<i></i>'.repeat(lv)}</span>`;}
function _monoCellHtml(c,i,an){
  const o=_mono.owners[i],u=_mono.players.user,a=_mono.players.ai,here=u.pos===i||a.pos===i,[r,col]=MONO_POS[i];
  const step=`<span class="mono-step">${i} ${_monoArrow(i)}</span>`;
  const pawns=`<div class="mono-pawns">${u.pos===i?_monoToken('user'):''}${a.pos===i?_monoToken('ai'):''}</div>`;
  let kind,body;
  if(c[1]){
    kind='land';const lv=o?_monoLevel(i):0;
    body=`<i class="mono-band" style="--band:${MONO_BAND[i]||'#888'}"></i>${step}<b class="mono-name">${escHtml(c[0])}</b><span class="mono-price">${c[1]}币</span><span class="mono-rent">租${_monoRent(i)}</span>${o?`<span class="mono-owner">${o==='user'?escHtml(_monoUserName()):escHtml(an)} · Lv.${lv}</span>${_monoHouses(lv)}`:''}`;
  }else{
    const [k,icon,sub]=MONO_KIND[c[0]]||['rest','✦',''];kind=k+(i%4===0?' corner':'');
    body=`${step}<span class="mono-icon">${icon}</span><b class="mono-name">${escHtml(c[0])}</b><span class="mono-sub">${sub}</span>`;
  }
  return`<div class="mono-cell ${kind} ${o?o+'-owned':''} ${here?'here':''}" data-index="${i}" style="grid-row:${r};grid-column:${col}">${body}${pawns}</div>`;
}
function _monoPlayerHtml(k,name){
  const p=_mono.players[k],w=_monoWorth(k),pct=Math.max(0,Math.min(100,Math.round(w/18)));
  return`<div class="mono-player ${k==='user'?'u':'a'} ${!_mono.over&&_mono.turn===k?'active':''}">${_monoToken(k)}<div class="mp-main"><b>${name}</b><span class="mp-cash">${p.cash}<small>币</small></span></div><div class="mp-bar"><i style="width:${pct}%"></i></div><small class="mp-worth">资产 ${w} / 1800</small></div>`;
}
function renderMonopoly(){
  const b=document.getElementById('monopolyBody');if(!b||!_mono)return;
  const an=_monoAiName(),st=_monoAiStyle(),u=_mono.players.user;
  const canRoll=_mono.turn==='user'&&!_mono.over&&!_mono.pendingBuy&&!_mono.pendingUpgrade&&!_monoAnimating;
  const faceN=_mono.lastRoll||5,turnText=_mono.over?'本局结束':_monoAnimating?'骰子滚动中…':_mono.turn==='user'?`轮到${escHtml(_monoUserName())}`:`${escHtml(an)} 正在行动`;
  const choice=_mono.pendingBuy?`<div class="mono-choice"><b>买下 ${escHtml(MONO_CELLS[u.pos][0])}？</b><button class="mono-action" onclick="monoBuy()">买地</button><button onclick="monoSkipChoice()">留现金</button></div>`:_mono.pendingUpgrade?`<div class="mono-choice"><b>升级 ${escHtml(MONO_CELLS[u.pos][0])}？</b><small>${_monoUpgradeCost(u.pos)}币 → 租金 ${MONO_CELLS[u.pos][2]*(_monoLevel(u.pos)+1)}</small><button class="mono-action" onclick="monoUpgrade()">升级</button><button onclick="monoSkipChoice()">保留现金</button></div>`:'';
  b.innerHTML=`<div class="mono-room"><div class="mono-window" aria-hidden="true"><i></i><span></span></div><div class="mono-shelf" aria-hidden="true"><i>🐟</i><i>🧶</i><i>🐈</i></div><div class="mono-room-title"><span>CAT GAME ROOM</span><small>今晚也在地毯上分个高下</small></div><div class="mono-wrap">
<div class="mono-toolbar"><select id="monoAi" onchange="monoSetAi(this.value)" aria-label="选择对手"><option value="local" ${(_mono.aiId||'local')==='local'?'selected':''}>本地猫猫（不调用 AI）</option>${(state.configs||[]).map(c=>`<option value="${escHtml(String(c.id))}" ${String(c.id)===String(_mono.aiId)?'selected':''}>${escHtml(c.nickname||'AI')}</option>`).join('')}</select><button onclick="monoNew()">重新开局</button><span>先到 1800 总资产获胜 · ${escHtml(an)}：${st.name}策略（保留 ${st.reserve}）</span></div>
<div class="mono-hud">${_monoPlayerHtml('user',escHtml(_monoUserName()))}${_monoPlayerHtml('ai',escHtml(an))}</div>
<div class="mono-table"><div class="mono-board">${MONO_CELLS.map((c,i)=>_monoCellHtml(c,i,an)).join('')}<div class="mono-center"><i class="mono-deck luck" aria-hidden="true">好运</i><i class="mono-deck oops" aria-hidden="true">意外</i><div class="mono-logo" aria-hidden="true"><span>猫猫</span><b>大富翁</b></div>
<div class="mono-roller"><button class="mono-die" onclick="monoRoll()" type="button" data-face="${faceN}" aria-label="点击投骰子" title="点击投骰子">${'⚀⚁⚂⚃⚄⚅'[faceN-1]}</button><div class="mono-roll-side"><div class="mono-turn">${turnText}</div><button class="mono-action" id="monoRollBtn" onclick="monoRoll()" type="button">🎲 掷骰子</button></div></div>${choice}
<div class="mono-event"><small>本轮动态</small><b>${escHtml(_mono.log[_mono.log.length-1]||'等待开局')}</b></div><div class="mono-quips"><b>${escHtml(an)}</b><span>${escHtml(_mono.quip||'轮到谁了？')}</span></div></div></div></div>
<div class="mono-log"><div class="mono-log-title">📜 对局记录 <small>最新在前 · 可滚动</small></div>${_mono.log.slice().reverse().map(x=>`<div>› ${escHtml(x)}</div>`).join('')}</div></div></div>`;
  // 能不能投由上面这一个 canRoll 说了算，模板里不再各写一遍条件。
  const rollBtn=document.getElementById('monoRollBtn');
  if(rollBtn){rollBtn.disabled=!canRoll;rollBtn.style.pointerEvents=canRoll?'auto':'none';rollBtn.title=canRoll?'点击投骰子':'当前不能投骰子';}
  const dieBtn=b.querySelector('.mono-die');if(dieBtn){dieBtn.disabled=!canRoll;dieBtn.style.pointerEvents=canRoll?'auto':'none';}
}
