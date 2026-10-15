// 梦境系统核心回归测试。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js/31-dreams.js'), 'utf8');
let pass=0, fail=0;
const t=(name,cond)=>{ if(cond){pass++;console.log('  ✓ '+name)}else{fail++;console.log('  ✗ '+name)} };
const now = new Date('2026-08-03T18:00:00Z').getTime(); // 上海 02:00
const ctx={ console, Date, Math, Intl, JSON, Object, Array, String, Number, Set, Map,
  setInterval(){}, setTimeout(){}, save(){}, showToast(){}, escHtml:s=>String(s),
  document:{getElementById:()=>null},
  state:{ dreamsOn:true,dreamsByModel:{},dreamGateByModel:{},dreamMaterialCooldowns:{},vitalsByModel:{},
    configs:[], memories:[{id:'m1',text:'小明在雨夜捡到一只浑身湿透的黑猫',createdAt:now-1000},{id:'m2',text:'计划秋天去海边看一次日出',createdAt:now-2000}], brainMemories:[],proustMems:[] }
};
ctx.globalThis=ctx; vm.createContext(ctx); vm.runInContext(source,ctx);
const conf={id:'a',nickname:'Alice',persona:'温柔但有一点神秘'};
(async()=>{
  console.log('\n[梦境闸门与隔离]');
  t('夜间窗口识别',ctx._dreamHour(now)===2);
  let r=await ctx.dreamAttempt(conf,{now,random:()=>0.1,generate:async()=> '走廊尽头变成了海，黑猫踩着雨点。\n[[DREAM_SCAR: 海风里有猫的脚印]]'});
  t('成功生成并独立落库',r.ok && ctx.state.dreamsByModel.a.length===1);
  t('梦没有进入普通记忆',ctx.state.memories.length===2 && !ctx.state.memories.some(x=>x.id===r.dream.id));
  t('梦材进入72小时冷却',Object.keys(ctx.state.dreamMaterialCooldowns).length===2);
  r=await ctx.dreamAttempt(conf,{now:now+1000,random:()=>0.1,generate:async()=>''});
  t('同一夜只尝试一次',r.reason==='already-attempted');
  const outside=await ctx.dreamAttempt({id:'b'},{now:new Date('2026-08-03T10:00:00Z').getTime(),random:()=>0,generate:async()=>''});
  t('夜间窗口外不触发',outside.reason==='outside-window');
  ctx.state.memories=[{id:'only',text:'只有一条足够长的孤单记忆素材',createdAt:now}];
  const thin=await ctx.dreamAttempt({id:'c'},{now,random:()=>0,generate:async()=>''});
  t('素材不足时梦可以不发生',thin.reason==='insufficient-material');
  console.log('\n[梦痕一次性消费]');
  ctx.dreamArmScar(conf,now+2000); const scar=ctx.dreamScarPromptFor(conf);
  t('梦痕不超过20字并可注入',scar.includes('海风里有猫的脚印'));
  ctx.dreamArmScar(conf,now+3000);
  t('已消费梦痕不会重复出现',ctx.dreamScarPromptFor(conf)==='');
  const old={id:'old',modelId:'a',scar:'过期',content:'旧梦',createdAt:now-25*3600e3,scarConsumedAt:0};
  ctx.state.dreamsByModel.a=[old]; ctx.dreamArmScar(conf,now);
  t('24小时后的梦痕过期',ctx.dreamScarPromptFor(conf)==='');
  console.log('\n[跨设备同步]');
  // 2026-10-10 电脑的 IndexedDB 被整个重建，梦只存本机，陈列室一个不剩
  const d=(id,mid,at,used)=>({id,modelId:mid,content:'梦'+id,scar:'痕',createdAt:at,scarConsumedAt:used||0});
  const cloudDreams={a:[d('c1','a',now-5e6)],z:[d('z1','z',now-7e6)]};
  let mg=ctx.dreamsMerge({},JSON.parse(JSON.stringify(cloudDreams)));
  t('★ 本机被删光 → 云端的梦全回来',mg.a?.length===1 && mg.z?.[0]?.id==='z1');
  mg=ctx.dreamsMerge({a:[d('l1','a',now)]},cloudDreams);
  t('★ 本机新做的梦 + 云端的并集，按时间新的在前',mg.a.map(x=>x.id).join()==='l1,c1' && mg.z.length===1);
  t('★ 云端为空（老版本没这个键）不会冲掉本机',ctx.dreamsMerge({a:[d('l1','a',now)]},undefined).a.length===1);
  mg=ctx.dreamsMerge({a:[d('s','a',now,0)]},{a:[d('s','a',now,now+500)]});
  t('★ 同一个梦只留一份，另一台用掉的梦痕这边也算用掉',mg.a.length===1 && mg.a[0].scarConsumedAt===now+500);
  mg=ctx.dreamsMerge({a:Array.from({length:50},(_,i)=>d('x'+i,'a',now-i*1e3))},{a:Array.from({length:50},(_,i)=>d('y'+i,'a',now-i*1e3-500))});
  t('★ 每个模型最多留 60 个，留新的',mg.a.length===60 && mg.a[0].id==='x0');
  let saves=0; ctx.save=()=>{saves++};
  ctx.state.dreamsByModel={a:[d('s','a',now)]};
  t('★ 云端跟本机一样 → 不改、不落盘',ctx.dreamsSyncApply({a:[d('s','a',now)]})===false && saves===0);
  t('★ 云端有新的 → 收进来并落盘',ctx.dreamsSyncApply(cloudDreams)===true && saves===1 && ctx.state.dreamsByModel.z.length===1);
  ctx.save=()=>{};
  ctx.state.dreamGateByModel={}; ctx.state.memories=[{id:'m1',text:'小明在雨夜捡到一只浑身湿透的黑猫',createdAt:now},{id:'m2',text:'计划秋天去海边看一次日出',createdAt:now}]; ctx.state.dreamMaterialCooldowns={};
  ctx.state.dreamsByModel={a:[d('phone','a',now-3600e3)]};
  r=await ctx.dreamAttempt(conf,{now,random:()=>0.1,generate:async()=>'不该做的梦\n[[DREAM_SCAR: 不该]]'});
  t('★ 另一台今晚已经替它做过梦（同步过来了），这台不再做',r.reason==='already-dreamed' && ctx.state.dreamsByModel.a.length===1);
  const core=fs.readFileSync(path.join(ROOT,'js/01-core.js'),'utf8');
  const push=core.slice(core.indexOf('async function syncSettingsToCloud()'),core.indexOf('async function cloudRetry',core.indexOf('async function syncSettingsToCloud()')));
  t('★ 推之前合并云端那份，整包里带着梦',/dreamsSyncApply\(cloud\.dreamsByModel\)/.test(push) && /settings\.dreamsByModel = state\.dreamsByModel/.test(push) && /dreamsByModel: state\.dreamsByModel \|\| \{\}/.test(push));
  const pull=core.slice(core.indexOf('async function loadFromCloud()'),core.indexOf('async function loadFromCloud()')+30000);
  t('★ 梦也在拉下来时合并进本机',/dreamsSyncApply\(s\.dreamsByModel\)/.test(pull));
  console.log('\n[陈列室界面]');
  const els={}; const el=id=>els[id]||(els[id]={innerHTML:'',dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v},insertAdjacentHTML(_,h){this.innerHTML+=h}});
  ['dreamGallery','dreamTabs','dreamCount','dreamSky','dreamsToggle','dreamSettingsPanel'].forEach(el);
  ctx.document={getElementById:id=>els[id]||null};
  ctx.escHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  ctx.state.configs=[{id:'a',nickname:'克克'}];
  ctx.state.dreamsByModel={a:[{id:'a2',modelId:'a',modelNickname:'旧名字',content:'<img src=x onerror=alert(1)>走廊',scar:'铃铛',createdAt:now,scarConsumedAt:0},{id:'a1',modelId:'a',modelNickname:'旧名字',content:'书店',scar:'信',createdAt:now-9e6,scarConsumedAt:now}],
    b:[{id:'b1',modelId:'b',modelNickname:'小千',content:'收音机',scar:'苗',createdAt:now-5e6,scarConsumedAt:0}]};
  ctx.dreamSetFilter('all');
  const g=()=>els.dreamGallery.innerHTML, cards=()=>(g().match(/class="dr-ex"/g)||[]).length;
  t('全部展品都在、最新的排最前',cards()===3 && g().indexOf('走廊')<g().indexOf('收音机') && g().indexOf('收音机')<g().indexOf('书店'));
  const byNo=Object.fromEntries(g().split('class="dr-ex"').slice(1).map(c=>[c.match(/No\.(\d+)/)?.[1], c]));
  t('馆藏编号按时间：最早的是 No.01、最新的是 No.03',byNo['01']?.includes('书店') && byNo['02']?.includes('收音机') && byNo['03']?.includes('走廊'));
  t('梦的正文被转义，不会变成真标签',!g().includes('<img src=x') && g().includes('&lt;img src=x'));
  t('名字取当前配置的昵称，不用做梦时存下的旧名',!g().includes('旧名字') && els.dreamTabs.innerHTML.includes('克克<small>2</small>'));
  t('已消散的梦痕带 gone 样式',/dr-scar gone"><span>梦痕 · 信/.test(g()));
  ctx.dreamSetFilter('b');
  t('按小机筛选只剩她的梦',cards()===1 && g().includes('收音机') && /aria-selected="true" data-id="b"/.test(els.dreamTabs.innerHTML));
  ctx.state.dreamsByModel.b=[]; ctx.dreamRenderGallery();
  t('筛选的小机没梦了就退回「全部」',cards()===2 && /aria-selected="true" data-id="all"/.test(els.dreamTabs.innerHTML));
  ctx.state.dreamsByModel={}; ctx.dreamRenderGallery();
  t('空展厅有空状态、没有门牌',g().includes('dr-empty') && els.dreamTabs.innerHTML==='' && els.dreamCount.innerHTML==='展厅还空着');
  t('夜空只撒一次星星',(()=>{const n=els.dreamSky.innerHTML.length; ctx.dreamRenderGallery(); return n>0 && els.dreamSky.innerHTML.length===n;})());
  ctx.state.dreamsOn=false; ctx.dreamRenderSettings();
  t('夜间做梦开关跟着 state 走',els.dreamsToggle.attrs['aria-pressed']==='false' && els.dreamSettingsPanel.innerHTML.includes('现在试做一个梦'));
  t('Android 梦境脚本与桌面一致',fs.readFileSync(path.join(ROOT,'js/31-dreams.js')).equals(fs.readFileSync(path.join(ROOT,'android/assets/js/31-dreams.js'))));
  console.log('\n'+(fail?'❌':'✅')+' '+pass+' passed, '+fail+' failed'); process.exit(fail?1:0);
})();
