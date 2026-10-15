const fs=require('fs'),vm=require('vm');let p=0,f=0;
function ok(n,v){v?(console.log('  ✓ '+n),p++):(console.error('  ✗ '+n),f++)}
const src=fs.readFileSync('js/36-weather.js','utf8'),store={};
const s={console,Date,URLSearchParams,localStorage:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v},document:{getElementById:()=>null},escHtml:String,showToast(){}};
vm.createContext(s);vm.runInContext(src,s);console.log('\n[温度与天气]');
ok('晴雨雪雷图标覆盖',s._weatherIcon(0)==='☀️'&&s._weatherIcon(61)==='🌧️'&&s._weatherIcon(75)==='🌨️'&&s._weatherIcon(95)==='⛈️');
ok('气象台窗景跟随天气和昼夜',s._weatherScene(61,'2026-08-05T21:00')==='weather-rain weather-night'&&s._weatherScene(0,'2026-08-05T12:00')==='weather-clear');
ok('地理编码两个源都问，且不再只取一条',src.includes('geocoding-api.open-meteo.com')&&src.includes('language=zh')&&src.includes('count=5')&&!/count=1\b/.test(src)&&src.includes("'/api/geocode?q='"));
ok('查询当前体感湿度风速',src.includes('apparent_temperature')&&src.includes('relative_humidity_2m')&&src.includes('wind_speed_10m'));
ok('包含五日高低温和降水概率',src.includes("forecast_days:'5'")&&src.includes('precipitation_probability_max'));
ok('无需 API Key 配置或鉴权头',!src.includes('Authorization')&&!src.includes('apiKey'));
ok('客户端超时比 server 那侧的 20 秒短（否则等于没有超时）',/const GEO_TIMEOUT=(\d+);/.test(src)&&Number(RegExp.$1)<20000&&Number(RegExp.$1)>=5000);
ok('三小时内天气可给 AI',src.includes('3*60*60*1000')&&src.includes('weatherPromptFor'));
const html=fs.readFileSync('index.html','utf8'),api=fs.readFileSync('js/05-prompts-api.js','utf8'),css=fs.readFileSync('css/grancyan.css','utf8'),srv=fs.readFileSync('server.js','utf8');
ok('小组件和脚本已挂载',html.includes('openWidget(openWeather)')&&html.includes('js/36-weather.js'));
// 10-09 重画：屋顶拱窗那版拆了（色块拼的窗 + emoji，夜里还挂太阳）。行为见文件末尾「气象台的样子」那组
ok('图标是自己画的线条 SVG，不再用 emoji 拼',src.includes('function _wxGlyph(')&&/renderWeather[\s\S]*_wxGlyph\(c\.weather_code,night\)/.test(src));
ok('要了逐小时、昼夜和日出日落',src.includes("hourly:'temperature_2m,weather_code,precipitation_probability,is_day'")&&src.includes("forecast_hours:'24'")&&src.includes('wind_speed_10m,is_day')&&src.includes('sunrise,sunset')&&src.includes('hourly:wj.hourly||null'));
ok('手机能滑到气象台底部且显示滚动条',/weather-panel \.cap-body\{[^}]*overflow-y:scroll/.test(css)&&/weather-panel \.weather-room\{[^}]*flex:0 0 auto/.test(css));
{const bots=css.match(/--wx-bot:#[0-9a-f]{6}/g)||[];
ok('天幕永远压在深色里（每种天气的底色都够暗）',bots.length>=6&&bots.every(m=>{const h=m.slice(-6);return Math.max(...[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)))<40}));}
ok('候选列表和刷新键有深色样式',/\.weather-alts button\.on\{/.test(css)&&/\.weather-search \.weather-reload\{/.test(css));
ok('天气摘要进入 volatile 而非缓存稳定段',api.includes("vol += weatherPromptFor()"));

// ── server 侧的 Nominatim 代理：三条用量守则一条都不能少（不守会被封 IP）──
const geoSeg=(srv.match(/app\.get\('\/api\/geocode'[\s\S]*?\n\}\);/)||[''])[0];
ok('地名代理带得出身份的 User-Agent',/NOMINATIM_UA/.test(geoSeg)&&/'User-Agent'/.test(geoSeg)&&/GranCyan\/[\d.]+ \(/.test(srv));
ok('地名代理限速到每秒一发',/geoThrottle\(/.test(geoSeg)&&/1100 - \(Date\.now\(\) - _geoLastAt\)/.test(srv));
ok('限速链上一次失败不会带走后面排队的',/_geoChain = run\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(srv));
ok('结果缓存一天并且有上限',/GEO_TTL/.test(geoSeg)&&/_geoCache\.set/.test(geoSeg)&&/_geoCache\.size > 300/.test(geoSeg));
ok('走 outboundAgent 出网（直连 Nominatim 是 000）',/await outboundAgent\(\)/.test(geoSeg));

// ── 行为测试：源码正则证明不了「挑对了地方」，这几条要真跑一遍 ──
const FC={timezone:'Asia/Shanghai',current:{temperature_2m:20,apparent_temperature:19,relative_humidity_2m:60,weather_code:0,wind_speed_10m:3,time:'2026-09-06T12:00'},daily:{time:['2026-09-06'],weather_code:[0],temperature_2m_max:[25],temperature_2m_min:[18],precipitation_probability_max:[0]}};
function mkBox(osm,om,calls){
    const st={},els={weatherCity:{value:''},weatherBody:{innerHTML:''},weatherModal:{classList:{add(){},remove(){}}}};
    const ivals=[],listeners=[],vis={state:'visible'};
    // 沙箱里把长定时器压到 30ms：真值 GEO_TIMEOUT 由下面单独一条断言守，测试不必真等 12 秒
    const ctx={console,Date,URLSearchParams,clearTimeout,AbortController,SERVER_BASE:'http://127.0.0.1:3000',
        setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,30)),
        // 后台自动刷新那套要能被看见：定时器和 visibilitychange 都只登记不真跑，
        // 由测试自己按下去（vis.state 可写，用来演「切到后台」）
        setInterval:(fn,ms)=>{ivals.push({fn,ms});return ivals.length},
        localStorage:{getItem:k=>st[k]||null,setItem:(k,v)=>st[k]=v},
        document:{getElementById:id=>els[id]||null,addEventListener:(ev,fn)=>listeners.push({ev,fn}),get visibilityState(){return vis.state}},escHtml:String,showToast(){},
        fetch:async (u,init)=>{calls.push(u);
            if(u.includes('/api/geocode')){
                // osm 传 'hang' = 模拟 server 连上了但永远不回话，只有 abort 能把它解开
                if(osm==='hang')return new Promise((_,rej)=>{init&&init.signal&&init.signal.addEventListener('abort',()=>rej(new Error('aborted')))});
                return{ok:true,json:async()=>({results:osm})}}
            if(u.includes('geocoding-api')){
                if(om==='hang')return new Promise((_,rej)=>{init&&init.signal&&init.signal.addEventListener('abort',()=>rej(new Error('aborted')))});
                return{ok:true,json:async()=>({results:om})}}
            return{ok:true,json:async()=>FC}},
        st,els,ivals,listeners,vis};
    vm.createContext(ctx);
    vm.runInContext(src+'\n;globalThis.__exp={weatherSearch,openWeather,weatherPick,weatherAutoTick,weatherPromptFor,get w(){return _weather},get alts(){return _weatherAlts}};',ctx);
    return ctx;
}
const CITY_OSM=[{name:'杭州市',full:'杭州市 · 浙江省 · 中国',latitude:30.2741,longitude:120.1551}];
// Open-Meteo 的错配：查一个地级市名，静默给回别的省份里的地点（坐标是故意编的另一处）
const CITY_OM=[{name:'杭州',admin1:'西藏',admin2:'那曲市',country:'中国',latitude:31.101,longitude:91.001}];
(async()=>{
    let calls=[];const a=mkBox(CITY_OSM,CITY_OM,calls);
    a.els.weatherCity.value='杭州';await a.__exp.weatherSearch();
    ok('★ 杭州不再静默变成西藏那曲（同名错配）',/浙江/.test(a.__exp.w?.place||'')&&Math.abs((a.__exp.w?.latitude??0)-30.2741)<.01);
    ok('★ 取天气用的是选中候选的坐标',calls.some(u=>u.includes('/forecast')&&u.includes('latitude=30.2741')));
    ok('★ 两个源的候选都留着，错了能一键换',a.__exp.alts.length===2&&a.__exp.alts.some(x=>Math.abs(x.latitude-31.101)<.01));
    ok('★ 候选摆的是完整行政区路径，不是光秃秃一个地名',a.__exp.alts.every(x=>String(x.full).includes(' · ')));

    calls=[];const b=mkBox([{name:'淳安县',full:'淳安县 · 杭州市 · 浙江省 · 中国',latitude:29.6086,longitude:119.0423}],[],calls);
    b.els.weatherCity.value='淳安县';await b.__exp.weatherSearch();
    ok('★ Open-Meteo 查不到的县，靠 server 代理照样查得到',/淳安县/.test(b.__exp.w?.place||'')&&Math.abs((b.__exp.w?.latitude??0)-29.6086)<.01);

    // 对照组：server 不在（纯前端跑）时不能整个废掉，要退回 Open-Meteo
    calls=[];const c2=mkBox([],CITY_OM,calls);
    c2.els.weatherCity.value='杭州';await c2.__exp.weatherSearch();
    ok('★ 代理拿不到结果时退回 Open-Meteo，不是整个查不了',Math.abs((c2.__exp.w?.latitude??0)-31.101)<.01);

    const stale={ts:Date.now()-30*60*1000,query:'淳安县',place:'淳安县 · 杭州市 · 浙江省',latitude:29.6086,longitude:119.0423,current:FC.current,daily:FC.daily};
    calls=[];const d=mkBox([],[],calls);d.st.grancyan_weather=JSON.stringify(stale);
    d.__exp.openWeather();await new Promise(r=>setTimeout(r,30));
    ok('★ 打开面板时数据过期会自己刷新',calls.some(u=>u.includes('/forecast'))&&(d.__exp.w?.ts||0)>stale.ts);
    ok('★ 自动刷新不重新解析地名，直接用存下来的坐标',!calls.some(u=>u.includes('geocode')||u.includes('geocoding-api'))&&calls.some(u=>u.includes('latitude=29.6086')));

    calls=[];const e=mkBox([],[],calls);e.st.grancyan_weather=JSON.stringify({...stale,ts:Date.now()-60*1000});
    e.__exp.openWeather();await new Promise(r=>setTimeout(r,30));
    ok('★ 对照：一分钟前刚查过就不该再打接口',!calls.length);

    // Nominatim 对短地名常见的返回顺序是 湖(外国同名) → 火车站 → 县，直接取第一条就跑到国外去了
    // （下面三条是编的样本，形状照实测）
    calls=[];const g=mkBox([
        {name:'淳安',full:'淳安湖 · 某某郡 · 日本',latitude:36.0514,longitude:140.3310,kind:'lake'},
        {name:'淳安',full:'淳安站 · 站前路 · 淳安县 · 杭州市 · 浙江省 · 中国',latitude:29.6130,longitude:119.0350,kind:'railway'},
        {name:'淳安县',full:'淳安县 · 杭州市 · 浙江省 · 中国',latitude:29.6086,longitude:119.0423,kind:'county'},
    ],[],calls);
    g.els.weatherCity.value='淳安';await g.__exp.weatherSearch();
    ok('★ 湖和火车站不许排在县前面（短地名不会跑到国外的同名湖）',/浙江/.test(g.__exp.w?.place||'')&&/县/.test(g.__exp.w?.place||''));
    ok('★ 排后面的候选还在（火车站和县同格被合并，日本那个留着）',g.__exp.alts.length===2&&/日本/.test(g.__exp.alts[1].full));

    // Codex 2026-09-06 逮到的两条
    calls=[];const h=mkBox([{name:'淳安县',full:'淳安县 · 杭州市 · 浙江省 · 中国',latitude:29.6086,longitude:119.0423,kind:'county'}],[],calls);
    h.els.weatherCity.value='淳安县';await h.__exp.weatherSearch();
    ok('★ 地名代理走 SERVER_BASE（手机 APK 里相对路径会被 WebView 拦成本地文件）',
        calls.some(u=>u.startsWith('http://127.0.0.1:3000/api/geocode')));
    // 注入「不存坐标」时上面那条「用存下来的坐标」照样绿 —— 因为它是直接往 storage 里塞种子，
    // 绕过了写入那一步。这条补的就是写→读这个闭环。
    ok('★ 查询结果把坐标存进了 localStorage（不然刷新只能重新解析地名，又会解析错）',
        (()=>{try{const st=JSON.parse(h.st.grancyan_weather);
            return Math.abs(st.latitude-29.6086)<.01&&Math.abs(st.longitude-119.0423)<.01}catch{return false}})());

    calls=[];const k=mkBox('hang',CITY_OM,calls);
    k.els.weatherCity.value='杭州';
    // ⚠️ 不能直接 await：拿掉超时之后 weatherSearch 永远不 resolve，
    //    node 事件循环空了就以 0 退出，一条 ✗ 都不打 —— 挂起会伪装成「全绿」。
    const t0=Date.now();
    const raced=await Promise.race([
        k.__exp.weatherSearch().then(()=>'done'),
        new Promise(r=>setTimeout(()=>r('HANG'),2500))]);
    const spent=Date.now()-t0;
    ok('★ server 连上却不回话时不会卡死，超时后退回 Open-Meteo',
        raced==='done'&&Math.abs((k.__exp.w?.latitude??0)-31.101)<.01&&spent<2500);

    // Codex 二审逮到的两条
    // ①「刷新」传进去的是缓存对象（字段叫 place），不是候选对象（full/name）——取错字段地名就没了
    calls=[];const m=mkBox([],[],calls);
    m.st.grancyan_weather=JSON.stringify(stale);
    m.__exp.openWeather();await new Promise(r=>setTimeout(r,60));
    ok('★ 自动刷新之后地名还在（取错字段会写回一个 undefined）',/淳安县/.test(m.__exp.w?.place||''));
    ok('★ 存回 localStorage 的也不是空地名',/淳安县/.test(JSON.parse(m.st.grancyan_weather).place||''));

    // ② 只给一路加超时不够：另一路挂住，Promise.all 一样卡死
    calls=[];const n=mkBox([{name:'淳安县',full:'淳安县 · 杭州市 · 浙江省 · 中国',latitude:29.6086,longitude:119.0423,kind:'county'}],'hang',calls);
    n.els.weatherCity.value='淳安县';
    const raced2=await Promise.race([n.__exp.weatherSearch().then(()=>'done'),new Promise(r=>setTimeout(()=>r('HANG'),2500))]);
    ok('★ Open-Meteo 那一路挂住也不卡死（两路都必须有超时）',raced2==='done'&&/淳安县/.test(n.__exp.w?.place||''));
    ok('★ 反面：两路地名解析都得走带超时的 _geoJson，不许裸 fetch',
        /async function _geoNominatim\(q\)\{const j=await _geoJson\(/.test(src)
        && /async function _geoOpenMeteo\(q\)\{const j=await _geoJson\(/.test(src));

    // ── 后台自动刷新：不点开面板也要新鲜 ──
    // 这一组真正守的是 **AI 那一侧**：weatherPromptFor() 只递 3 小时内的天气，
    // 而刷新原来只发生在 openWeather() 里。面板一点开就自己补上了，所以这个洞
    // 在面板上肉眼零征兆，只在「AI 怎么不知道天气」的时候显形。
    const OLD4H={ts:Date.now()-4*60*60*1000,query:'淳安县',place:'淳安县 · 杭州市 · 浙江省',latitude:29.6086,longitude:119.0423,current:FC.current,daily:FC.daily};

    calls=[];const q1=mkBox([],[],calls);q1.st.grancyan_weather=JSON.stringify(OLD4H);
    ok('★ 对照：放了 4 小时没人刷，AI 就拿不到天气了（这就是原来的病）',
        q1.__exp.weatherPromptFor()==='');
    q1.__exp.weatherAutoTick();await new Promise(r=>setTimeout(r,30));
    ok('★ 后台 tick 会去拉新天气，不用点开面板',
        calls.some(u=>u.includes('/forecast')&&u.includes('latitude=29.6086')));
    ok('★ tick 之后 AI 又看得到天气了（这条才是要的效果）',
        /淳安县/.test(q1.__exp.weatherPromptFor()));
    ok('★ tick 不重新解析地名，只用存下来的坐标',
        !calls.some(u=>u.includes('geocode')||u.includes('geocoding-api')));

    // 对照组三条：该不刷的时候一次也不许发
    calls=[];const q2=mkBox([],[],calls);
    q2.st.grancyan_weather=JSON.stringify({...OLD4H,ts:Date.now()-60*1000});
    q2.__exp.weatherAutoTick();await new Promise(r=>setTimeout(r,30));
    ok('★ 对照：一分钟前刚刷过，tick 不该再打接口',!calls.length);

    calls=[];const q3=mkBox([],[],calls);q3.st.grancyan_weather=JSON.stringify(OLD4H);
    q3.vis.state='hidden';
    q3.__exp.weatherAutoTick();await new Promise(r=>setTimeout(r,30));
    ok('★ 对照：切到后台不偷跑流量（回前台有 visibilitychange 补刷）',!calls.length);

    // ⚠️ 这条守的是 innerHTML 重画吃表单状态：_weatherFetch 收尾会整段重画 weatherBody，
    //    把用户正敲的半截城市名换成上次的 query
    calls=[];const q4=mkBox([],[],calls);q4.st.grancyan_weather=JSON.stringify(OLD4H);
    q4.els.weatherCity.value='淳安';
    q4.__exp.weatherAutoTick();await new Promise(r=>setTimeout(r,30));
    ok('★ 对照：用户正在输入框里打字时这轮让开，不许把半截字重画掉',!calls.length);

    // 没设过地点的空库：别对着 undefined 坐标发请求
    calls=[];const q5=mkBox([],[],calls);
    q5.__exp.weatherAutoTick();await new Promise(r=>setTimeout(r,30));
    ok('★ 对照：还没设过城市，tick 什么都不做',!calls.length);

    // 光有 tick 函数不算数 —— 得真挂上定时器和回前台补刷，不然谁来按它
    const q6=mkBox([],[],[]);
    const wTick=q6.ivals.find(x=>x.ms>0&&x.ms<=15*60*1000);
    ok('★ 定时器真的挂上了，且间隔不长于 WEATHER_STALE（否则每轮都撞在过期上）',!!wTick);
    ok('★ 回到前台会补刷一次（切出去一会儿再切回来比重启常见得多）',
        q6.listeners.some(x=>x.ev==='visibilitychange'));

    // ── 气象台的样子（10-09 重画）：真跑 renderWeather，看吐出来的 HTML ──
    console.log('\n[气象台的样子]');
    const rbox=()=>{const body={innerHTML:''},c={console,Date,Math,Number,String,JSON,Array,URLSearchParams,localStorage:{getItem:()=>null,setItem(){}},
        document:{getElementById:id=>id==='weatherBody'?body:null},escHtml:x=>String(x).replace(/</g,'&lt;'),showToast(){}};
        vm.createContext(c);vm.runInContext(src+';globalThis.__set=w=>{_weather=w};',c);return{c,body}};
    // 25 格：01 点（已经过去）+ 02 点起往后 24 小时，跨过午夜到 10 号 01 点
    const hrs=Array.from({length:25},(_,i)=>{const t=new Date(Date.UTC(2026,9,9,1+i));return t.toISOString().slice(0,13)+':00'});
    const NIGHT={ts:Date.now(),query:'淳安县',place:'淳安县 · 杭州市 · 浙江省 · 中国',latitude:29.6,longitude:119.04,src:'OpenStreetMap',
        current:{time:'2026-10-09T02:15',temperature_2m:11.6,apparent_temperature:10.8,relative_humidity_2m:97,weather_code:0,wind_speed_10m:4,is_day:0},
        daily:{time:['2026-10-09','2026-10-10','2026-10-11'],weather_code:[2,3,63],temperature_2m_max:[23,25,19],temperature_2m_min:[10,12,14],precipitation_probability_max:[0,10,80],sunrise:['2026-10-09T06:00'],sunset:['2026-10-09T17:42']},
        hourly:{time:hrs,temperature_2m:Array.from({length:25},(_,i)=>11+i/3),weather_code:Array(25).fill(0),precipitation_probability:Array.from({length:25},(_,i)=>i===5?40:0),is_day:Array.from({length:25},(_,i)=>i>=5&&i<17?1:0)}};
    {const{c,body}=rbox();c.__set(NIGHT);c.renderWeather();const h=body.innerHTML,hero=h.split('class="wx-stats"')[0];const hours=h.slice(h.indexOf('wx-hours'),h.indexOf('wx-days'));
     ok('★ 夜里晴天：主图是月亮，不是太阳（旧版就是夜里挂太阳）',/g-moon/.test(hero)&&!/g-sun/.test(hero)&&/weather-clear weather-night/.test(h));
     ok('★ 地名只留县名做标题，副标题最多两级',/<b>淳安县<\/b><small>杭州市 · 浙江省<\/small>/.test(h));
     {const g=JSON.parse(JSON.stringify(NIGHT));g.place='广州市 · 中国';c.__set(g);c.renderWeather();
      ok('★ 「中国」不当副标题（广州市 · 中国 → 只剩广州市）',/<b>广州市<\/b><\/div>|<b>广州市<\/b>(?!<small>)/.test(body.innerHTML)&&!/<small>中国/.test(body.innerHTML));}
     ok('★ 24 小时从「现在」这一格起（已经过去的 1 点那格不画）',/>现在</.test(h)&&(h.match(/class="wx-h-temp"/g)||[]).length===24&&!/>1时</.test(hours.split('明天')[0]));
     ok('★ 逐小时的图标跟着昼夜走：天亮那几格换太阳',/g-sun/.test(hours)&&/g-moon/.test(hours));
     ok('★ 降水概率 ≥20% 的那一小时才标数字',/class="wx-h-rain"[^>]*>40%</.test(h)&&(h.match(/class="wx-h-rain"/g)||[]).length===1);
     ok('★ 跨过午夜那格写「明天」',/>明天</.test(hours));
     ok('★ 五天区间条：今天那行有「现在」的小点，其余没有',(h.match(/<em style="left:/g)||[]).length===1);
     ok('★ 回答了「今天出门要穿什么」，体感 10.8° 要外套',/今天出门：有点凉，外套别忘了/.test(h));
     ok('★ 日出日落拿到了就显示',/06:00<i>\/<\/i>17:42/.test(h));
     ok('★ 输入框还叫 weatherCity（自动刷新靠它判断用户在不在打字）',/id="weatherCity"/.test(h));}
    {const{c,body}=rbox();const old=JSON.parse(JSON.stringify(NIGHT));delete old.hourly;delete old.daily.sunrise;delete old.daily.sunset;delete old.current.is_day;
     c.__set(old);let err=null;try{c.renderWeather()}catch(e){err=e}const h=body.innerHTML;
     ok('★ 10-09 之前存的旧缓存（没有 hourly/日出/is_day）照样画得出来，24 小时那块先不画',!err&&/wx-hero/.test(h)&&!/wx-hours/.test(h)&&/>降水</.test(h));
     ok('★ 旧缓存没 is_day 就按钟点判夜里（02:15 是夜）',/weather-night/.test(h)&&/g-moon/.test(h.split('class="wx-stats"')[0]));}
    {const{c,body}=rbox();const rain=JSON.parse(JSON.stringify(NIGHT));Object.assign(rain.current,{weather_code:63,is_day:1,apparent_temperature:24});
     c.__set(rain);c.renderWeather();const h=body.innerHTML;
     ok('★ 下雨天：雨的场景 + 云下有雨丝 + 提醒带伞',/weather-rain/.test(h)&&!/weather-night/.test(h)&&/g-rain/.test(h.split('class="wx-stats"')[0])&&/记得带伞/.test(h));}
    {const{c,body}=rbox();c.__set(null);c.renderWeather();
     ok('★ 还没城市：空状态 + 搜索框都在',/还没有城市/.test(body.innerHTML)&&/id="weatherCity"/.test(body.innerHTML));}
    {const{c}=rbox();
     ok('★ 温度配色两头：-20° 是冷蓝，40° 是红',c._wxTempColor(-20)==='rgb(143,184,255)'&&c._wxTempColor(40)==='rgb(239,111,94)'&&/^rgb\(\d+,\d+,\d+\)$/.test(c._wxTempColor(14.3)));}
    // 月亮跟着真实月相变。对照 2024 年 1-2 月的天文历
    {const{c}=rbox();const P=s=>c._wxMoonPhase(Date.parse(s)),near=(a,b)=>Math.min(Math.abs(a-b),1-Math.abs(a-b))<.02;
     ok('★ 月相算得准：新月≈0、上弦≈.25、满月≈.5、下弦≈.75',
        near(P('2024-01-11T11:57Z'),0)&&near(P('2024-01-18T03:53Z'),.25)&&near(P('2024-01-25T17:54Z'),.5)&&near(P('2024-02-02T23:18Z'),.75));
     const M=s=>c._wxMoon(12,12,6.8,P(s));
     ok('★ 满月画整圆，新月只剩淡轮廓',/<circle class="g-moon" /.test(M('2024-01-25T17:54Z'))&&!/class="g-moon"/.test(M('2024-01-11T11:57Z'))&&/g-moon-shade/.test(M('2024-01-11T11:57Z')));
     ok('★ 上弦亮在右、下弦亮在左（北半球看）',/A6\.8 6\.8 0 0 1 /.test(M('2024-01-18T03:53Z'))&&/A6\.8 6\.8 0 0 0 /.test(M('2024-02-02T23:18Z')));
     ok('★ 眉月是细的一牙，盈凸月是鼓的一大块（明暗线鼓向不同边）',(()=>{const a=M('2024-01-14T12:00Z'),b=M('2024-01-22T12:00Z');
        return /0 0 1 12\.00 18\.80A[\d.]+ 6\.8 0 0 0 /.test(a)&&/0 0 1 12\.00 18\.80A[\d.]+ 6\.8 0 0 1 /.test(b)})());}

    console.log(`\n${f?'❌':'✅'} ${p} passed, ${f} failed`);if(f)process.exit(1);
})();
