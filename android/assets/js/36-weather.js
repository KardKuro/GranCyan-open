// 温度与天气：天气数据 Open-Meteo（无需 API Key），地名解析 Nominatim（走 server 的 /api/geocode，因为它直连被拦）。
// ⚠️ 别再用 Open-Meteo 的 geocoder 单取第一条：它在中国只到地级市，而且查不到会**静默给个别的地方**——
//    地级市名会被解析到别的省的同名地点、很多县名直接空手。所以这里两个源一起问、按行政区全路径摆出来给用户挑。
let _weather=null,_weatherBusy=false,_weatherAlts=[];
const WEATHER_STALE=15*60*1000;
// 比 server 那侧的 20 秒短：超时了就先用 Open-Meteo 的候选，而 server 还会把它查完写进缓存，
// 所以再点一次「查询」通常是秒回的。
const GEO_TIMEOUT=12000;
// Nominatim 是按名字模糊搜的，湖、火车站、路口都会混进来排在县前面（实测过同名的
// 湖(lake) → 火车站(railway) → 县(county) 这种顺序）。查天气要的永远是行政区，先把它们提上来。
// Open-Meteo 那边没有 kind，空串按行政区算（它本来就只返回聚落）。
const GEO_ADMIN=new Set(['','country','state','region','province','city','county','municipality','town','village','district','suburb','borough','hamlet','quarter','neighbourhood','administrative']);
function _weatherLoad(){try{_weather=JSON.parse(localStorage.getItem('grancyan_weather'))}catch{_weather=null}}
function _weatherSave(){localStorage.setItem('grancyan_weather',JSON.stringify(_weather))}
function openWeather(){_weatherLoad();document.getElementById('weatherModal')?.classList.remove('hidden');renderWeather();if(_weatherHasFix()&&Date.now()-_weather.ts>WEATHER_STALE)_weatherFetch(_weather,{silent:true})}
function closeWeather(){document.getElementById('weatherModal')?.classList.add('hidden')}
function _weatherHasFix(){return !!_weather&&Number.isFinite(_weather.latitude)&&Number.isFinite(_weather.longitude)}
function weatherRefresh(){if(_weatherHasFix())_weatherFetch(_weather);else if(_weather?.query){const i=document.getElementById('weatherCity');if(i)i.value=_weather.query;weatherSearch()}}
function _weatherIcon(code){if(code===0)return'☀️';if(code<=3)return'⛅';if(code<=48)return'🌫️';if(code<=57)return'🌦️';if(code<=67)return'🌧️';if(code<=77)return'🌨️';if(code<=82)return'🌦️';if(code<=86)return'❄️';return'⛈️'}
function _weatherName(code){if(code===0)return'晴';if(code<=3)return'多云';if(code<=48)return'雾';if(code<=57)return'毛毛雨';if(code<=67)return'雨';if(code<=77)return'雪';if(code<=82)return'阵雨';if(code<=86)return'阵雪';return'雷雨'}
function _weatherScene(code,time){const hour=Number(String(time||'').slice(11,13));const night=Number.isFinite(hour)&&(hour<6||hour>=19);let kind='clear';if(code<=3)kind=code===0?'clear':'overcast';else if(code<=48)kind='fog';else if(code<=67||code<=82)kind='rain';else if(code<=86)kind='snow';else kind='storm';return `weather-${kind}${night?' weather-night':''}`}
// ⚠️ 两件事都是 Codex 2026-09-06 审出来的，各自都是「零报错但功能没了」：
// ① 必须走 SERVER_BASE，不能写相对路径。手机 APK 的页面跑在 https://grancyan.app，
//    MainActivity.shouldInterceptRequest 会把这个域名下的所有路径当本地 assets 去开，
//    于是 /api/geocode 根本到不了电脑上的 server —— 手机上查县级地名照样查不到，
//    而且退回 Open-Meteo 之后什么错都不报。
// ② 必须自己带超时。server 那侧的 20 秒只管它自己；server 连上了却不回话的话，
//    这个 fetch 会永远挂着，而下面用的是 Promise.all —— 整个查询卡死，
//    连已经回来的 Open-Meteo 候选都显示不出来。abort 之后这一路当空处理，正常降级。
// 两路地名解析共用这一个取数口，唯一目的就是**每一路都必须有超时**。
// Codex 2026-09-06 二审逮到：我第一版只给 Nominatim 加了 abort，Open-Meteo 那路照样裸奔——
// 下面用的是 Promise.all，任何一路挂住，整个查询就卡死，_weatherBusy 永远为 true，
// 连已经回来的另一路候选都显示不出来，而且再也点不动「查询」。
async function _geoJson(url){const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),GEO_TIMEOUT);try{const r=await fetch(url,{signal:ctrl.signal});if(!r.ok)return null;return await r.json()}catch{return null}finally{clearTimeout(t)}}
// ⚠️ 必须走 SERVER_BASE，不能写相对路径。手机 APK 的页面跑在 https://grancyan.app，
//    MainActivity.shouldInterceptRequest 会把这个域名下的所有路径当本地 assets 去开，
//    于是 /api/geocode 根本到不了电脑上的 server —— 手机上查县级地名照样查不到，
//    而且退回 Open-Meteo 之后什么错都不报。
async function _geoNominatim(q){const j=await _geoJson(SERVER_BASE+'/api/geocode?q='+encodeURIComponent(q));return ((j&&j.results)||[]).map(p=>({name:p.name,full:p.full||p.name,latitude:Number(p.latitude),longitude:Number(p.longitude),kind:p.kind||'',src:'OpenStreetMap'}))}
async function _geoOpenMeteo(q){const j=await _geoJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=zh&format=json`);return ((j&&j.results)||[]).map(p=>({name:p.name,full:[p.name,p.admin3,p.admin2,p.admin1,p.country].filter(Boolean).join(' · '),latitude:Number(p.latitude),longitude:Number(p.longitude),src:'Open-Meteo'}))}
// ⚠️ 顺序是「先排序再去重」，反过来会静默丢掉正确答案：湖 / 火车站常常和县城落在同一个格子里
//    （县城火车站离县政府几公里，四舍五入到 0.1° 是同一格），先去重的话留下的是排在前面的火车站。
async function _weatherGeocode(q){const[osm,om]=await Promise.all([_geoNominatim(q),_geoOpenMeteo(q)]);const all=osm.concat(om).filter(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude));all.sort((a,b)=>(GEO_ADMIN.has(a.kind||'')?0:1)-(GEO_ADMIN.has(b.kind||'')?0:1));const out=[],seen=new Set();for(const p of all){const k=p.latitude.toFixed(1)+','+p.longitude.toFixed(1);if(seen.has(k))continue;seen.add(k);p.query=q;out.push(p)}return out}
// auto＝这个地点是 60-phone 按手机定位设的；pickedAt＝用户最后一次亲手选城市的时刻。刷新同一个地点时两样都原样留着
// （ts 每 15 分钟会被自动刷新顶新，拿它判断「刚手动查过」的话，手选的城市就永远不会让给定位）。
async function _weatherFetch(place,opt={}){if(_weatherBusy||!Number.isFinite(place?.latitude))return;_weatherBusy=true;if(!opt.silent)renderWeather();try{const params=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,current:'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',hourly:'temperature_2m,weather_code,precipitation_probability,is_day',forecast_hours:'24',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',timezone:'auto',forecast_days:'5'});const wr=await fetch('https://api.open-meteo.com/v1/forecast?'+params),wj=await wr.json();if(!wr.ok||!wj.current)throw new Error(wj.reason||'天气接口没有返回数据');const same=place===_weather;_weather={ts:Date.now(),auto:!!place.auto,pickedAt:same?(_weather.pickedAt||_weather.ts):Date.now(),query:place.query||_weather?.query||place.name,place:place.full||place.name||place.place||'',latitude:place.latitude,longitude:place.longitude,src:place.src||_weather?.src||'',timezone:wj.timezone,current:wj.current,daily:wj.daily,hourly:wj.hourly||null};_weatherSave()}catch(e){if(!opt.silent)showToast('🌧️ '+e.message,'error',4000)}finally{_weatherBusy=false;renderWeather()}}
async function weatherSearch(){const input=document.getElementById('weatherCity'),q=String(input?.value||'').trim();if(!q||_weatherBusy)return;_weatherBusy=true;_weatherAlts=[];renderWeather(q);let list=[];try{list=await _weatherGeocode(q)}catch(e){}_weatherBusy=false;if(!list.length){showToast('🌧️ 没找到「'+q+'」，换个写法试试（例如「淳安县」「杭州市」）','error',4000);renderWeather(q);return}_weatherAlts=list;await _weatherFetch(list[0])}
function weatherPick(i){const p=_weatherAlts[i];if(p)_weatherFetch(p)}
// ── 气象台的样子（2026-10-09 重画）──
// 原来那版是色块拼的拱形窗 + emoji，夜里窗外还挂着太阳，不好看。现在：自己画的线条图标（分昼夜）、
// 大号温度、24 小时温度曲线、五天的温度区间条。底色跟着天气和昼夜换，但永远是深的。
// ⚠️ 整段 innerHTML 重画，输入框 id 必须还叫 weatherCity：weatherAutoTick 靠它判断「她正在敲字」。
const _WX_CLOUD='M7.5 18H17a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.9 10.1 4 4 0 0 0 7.5 18z';
function _wxRays(cx,cy,r1,r2){let s='';for(let k=0;k<8;k++){const a=k*Math.PI/4,c=Math.cos(a),n=Math.sin(a);s+=`M${(cx+c*r1).toFixed(2)} ${(cy+n*r1).toFixed(2)}L${(cx+c*r2).toFixed(2)} ${(cy+n*r2).toFixed(2)}`}return s}
// 月相：0 新月 → .25 上弦 → .5 满月 → .75 下弦。基准是 2000-01-06 18:14 UTC 那次新月，朔望月 29.530588853 天，误差半天以内
function _wxMoonPhase(t=Date.now()){const p=((+new Date(t)-947182440000)/86400000/29.530588853)%1;return p<0?p+1:p}
// 月亮按真实月相画（北半球看：渐盈亮在右，渐亏亮在左）。暗面留一圈淡轮廓，新月那几天也看得出那儿有个月亮
function _wxMoon(cx,cy,r,p=_wxMoonPhase()){
  const k=(1-Math.cos(2*Math.PI*p))/2,f=n=>n.toFixed(2);
  let lit='';
  if(k>.97)lit=`<circle class="g-moon" cx="${cx}" cy="${cy}" r="${r}"/>`;
  else if(k>.03){const limb=p<.5?1:0,rx=r*Math.abs(1-2*k),term=k<.5?1-limb:limb;
    lit=`<path class="g-moon" d="M${f(cx)} ${f(cy-r)}A${r} ${r} 0 0 ${limb} ${f(cx)} ${f(cy+r)}A${f(rx)} ${r} 0 0 ${term} ${f(cx)} ${f(cy-r)}z"/>`}
  return `<circle class="g-moon-shade" cx="${cx}" cy="${cy}" r="${r}"/>`+lit;
}
function _wxGlyph(code,night){
  const sun=(cx,cy,r)=>`<circle class="g-sun" cx="${cx}" cy="${cy}" r="${r}"/><path class="g-sun" d="${_wxRays(cx,cy,r+2.2,r+4)}"/>`;
  const moon=(small)=>small?_wxMoon(8,8,4.4):_wxMoon(12,12,6.8);
  const cloud=(dy=0)=>`<path class="g-cloud" transform="translate(0 ${dy})" d="${_WX_CLOUD}"/>`;
  let g;
  if(code===0)g=night?moon():sun(12,12,4.2);
  else if(code<=2)g=(night?moon(true):sun(8,8,2.6))+cloud(1.5);
  else if(code===3)g=`<path class="g-cloud g-back" transform="translate(3.2 -4.2) scale(.8)" d="${_WX_CLOUD}"/>`+cloud(1);
  else if(code<=48)g=cloud(-3.5)+'<path class="g-fog" d="M5 18.5h14M7.5 21.5h9"/>';
  else if(code<=57)g=cloud(-2.5)+'<path class="g-rain" d="M9 19v.6M12.5 20.4v.6M16 19v.6"/>';
  else if(code<=67||(code>=80&&code<=82))g=cloud(-2.5)+'<path class="g-rain" d="M9 18.5l-1 3M12.5 18.5l-1 3M16 18.5l-1 3"/>';
  else if(code<=86)g=cloud(-2.5)+'<circle class="g-snow" cx="9" cy="19.6" r=".95"/><circle class="g-snow" cx="12.5" cy="21.4" r=".95"/><circle class="g-snow" cx="16" cy="19.6" r=".95"/>';
  else g=cloud(-2.5)+'<path class="g-bolt" d="M13.2 16.6l-2.4 3.4h2.8l-1.8 3.4"/>';
  return `<svg class="wx-glyph" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g}</svg>`;
}
// 温度 → 颜色（区间条两头用）：冷蓝 → 青 → 黄 → 橘 → 红
const _WX_RAMP=[[-10,[143,184,255]],[0,[154,208,240]],[10,[143,214,192]],[18,[233,210,126]],[26,[242,166,94]],[34,[239,111,94]]];
function _wxTempColor(t){const R=_WX_RAMP;if(t<=R[0][0])return `rgb(${R[0][1]})`;for(let i=1;i<R.length;i++){if(t<=R[i][0]){const[a,ca]=R[i-1],[b,cb]=R[i],f=(t-a)/(b-a);return `rgb(${ca.map((v,k)=>Math.round(v+(cb[k]-v)*f)).join(',')})`}}return `rgb(${R[R.length-1][1]})`}
function _wxNight(c){if(c&&(c.is_day===0||c.is_day===1))return c.is_day===0;const h=Number(String(c?.time||'').slice(11,13));return Number.isFinite(h)&&(h<6||h>=19)}
function _wxWind(k){return k<6?'几乎没风':k<12?'微风':k<20?'和风':k<29?'清风':k<39?'风有点大':k<50?'大风':'狂风，少出门'}
function _wxHumid(h){return h>=85?'很潮':h>=60?'偏湿':h>=35?'刚刚好':'很干，多喝水'}
function _wxFeel(t,a){const d=a-t;return d<=-2?'风一吹更凉':d>=2?'比温度更闷':'和温度差不多'}
// 「今天出门要穿什么」——小组件入口上就是这么写的，现在页里真的回答它
function _wxTip(c,d){
  const a=c.apparent_temperature,code=c.weather_code,p=d?.precipitation_probability_max?.[0]??0;
  let t=a<=0?'冷透了，羽绒服和围巾都带上':a<=7?'很冷，厚外套加毛衣':a<=13?'有点凉，外套别忘了':a<=18?'长袖加件薄外套刚好':a<=23?'长袖短袖都行，很舒服':a<=28?'短袖就好':'很热，短袖、防晒、多喝水';
  if((code>=71&&code<=77)||code===85||code===86)t+='；下雪，路上慢点';
  else if(code>=51||p>=50)t+='；记得带伞';
  else if(p>=30)t+='；包里塞把伞';
  return t;
}
function _wxSmooth(pts){let d=`M${pts[0][0]} ${pts[0][1].toFixed(1)}`;for(let i=0;i<pts.length-1;i++){const p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||p2;d+=`C${(p1[0]+(p2[0]-p0[0])/6).toFixed(1)} ${(p1[1]+(p2[1]-p0[1])/6).toFixed(1)} ${(p2[0]-(p3[0]-p1[0])/6).toFixed(1)} ${(p2[1]-(p3[1]-p1[1])/6).toFixed(1)} ${p2[0]} ${p2[1].toFixed(1)}`}return d}
// 24 小时：一整张 SVG，横着滑。缓存里旧数据没有 hourly（10-09 之前存的）就整块不画，等下一次刷新。
function _wxHours(w){
  const h=w.hourly;if(!h||!Array.isArray(h.time)||!h.time.length)return'';
  const nowH=String(w.current?.time||'').slice(0,13);
  let start=h.time.findIndex(t=>String(t).slice(0,13)>=nowH);if(start<0)start=0;
  const idx=[];for(let i=start;i<h.time.length&&idx.length<24;i++)if(Number.isFinite(h.temperature_2m?.[i]))idx.push(i);
  if(idx.length<2)return'';
  // 一天里只差两三度时别把这点起伏拉满整个带子（看着像大起大落），也别沉到底——按至少 8 度的跨度、居中画
  const W=52,top=70,bot=104,temps=idx.map(i=>h.temperature_2m[i]),lo=Math.min(...temps),hi=Math.max(...temps),span=Math.max(hi-lo,8),mid=(hi+lo)/2;
  const pts=idx.map((i,k)=>[k*W+W/2,(top+bot)/2-(h.temperature_2m[i]-mid)/span*(bot-top)]);
  const line=_wxSmooth(pts),width=idx.length*W;
  const cols=idx.map((i,k)=>{
    const x=k*W+W/2,hh=String(h.time[i]).slice(11,13),now=k===0&&String(h.time[i]).slice(0,13)===nowH;
    const label=now?'现在':hh==='00'?'明天':Number(hh)+'时',p=h.precipitation_probability?.[i]??0;
    return `<text class="wx-h-time${now?' on':''}" x="${x}" y="16">${label}</text>`
      +`<svg class="wx-glyph" x="${x-12}" y="26" width="24" height="24" viewBox="0 0 24 24">${_wxGlyph(h.weather_code?.[i],h.is_day?.[i]===0).replace(/^<svg[^>]*>|<\/svg>$/g,'')}</svg>`
      +`<text class="wx-h-temp" x="${x}" y="${(pts[k][1]-10).toFixed(1)}">${Math.round(h.temperature_2m[i])}°</text>`
      +`<circle class="wx-h-dot${now?' on':''}" cx="${x}" cy="${pts[k][1].toFixed(1)}" r="${now?3.2:2}"/>`
      +(p>=20?`<text class="wx-h-rain" x="${x}" y="132">${p}%</text>`:'');
  }).join('');
  return `<section class="wx-card wx-hours"><h4>接下来 24 小时</h4><div class="wx-hours-scroll"><svg width="${width}" height="140" viewBox="0 0 ${width} 140" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="wxHourFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--wx-curve)" stop-opacity=".28"/><stop offset="1" stop-color="var(--wx-curve)" stop-opacity="0"/></linearGradient></defs><path d="${line}L${pts[pts.length-1][0]} 120L${pts[0][0]} 120Z" fill="url(#wxHourFill)" stroke="none"/><path class="wx-h-line" d="${line}"/>${cols}</svg></div></section>`;
}
function _wxDays(w){
  const d=w.daily,c=w.current;if(!d?.time?.length)return'';
  const mins=d.temperature_2m_min.map(Number),maxs=d.temperature_2m_max.map(Number),lo=Math.min(...mins),hi=Math.max(...maxs),span=hi-lo||1,pct=t=>((t-lo)/span*100).toFixed(1);
  const drop='<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 3.5s-6 6.6-6 10.8a6 6 0 0 0 12 0C18 10.1 12 3.5 12 3.5z"/></svg>';
  const rows=d.time.map((date,i)=>{
    const dt=new Date(date+'T12:00:00'),wd=i===0?'今天':i===1?'明天':dt.toLocaleDateString('zh-CN',{weekday:'short'}),p=d.precipitation_probability_max?.[i]??0;
    const mn=mins[i],mx=maxs[i],cur=i===0&&c?Math.min(Math.max(c.temperature_2m,mn),mx):null;
    return `<div class="wx-day"><span class="wx-day-name"><b>${wd}</b><small>${dt.getMonth()+1}/${dt.getDate()}</small></span>${_wxGlyph(d.weather_code[i],false)}<span class="wx-day-rain">${p>=10?drop+p+'%':''}</span><span class="wx-day-lo">${Math.round(mn)}°</span><span class="wx-bar"><i style="left:${pct(mn)}%;right:${(100-pct(mx)).toFixed(1)}%;background:linear-gradient(90deg,${_wxTempColor(mn)},${_wxTempColor(mx)})"></i>${cur!=null?`<em style="left:${pct(cur)}%"></em>`:''}</span><span class="wx-day-hi">${Math.round(mx)}°</span></div>`;
  }).join('');
  return `<section class="wx-card wx-days"><h4>五天</h4>${rows}</section>`;
}
function renderWeather(pending=''){
  const b=document.getElementById('weatherBody');if(!b)return;
  const w=_weather,c=w?.current,d=w?.daily,night=c?_wxNight(c):(new Date().getHours()<6||new Date().getHours()>=19);
  const scene=c?_weatherScene(c.weather_code,c.time).replace(' weather-night','')+(night?' weather-night':''):'weather-idle'+(night?' weather-night':'');
  const alts=_weatherAlts.length>1?`<div class="weather-alts"><b>不是这个？</b>${_weatherAlts.map((p,i)=>`<button class="${w&&Math.abs(p.latitude-w.latitude)<.05&&Math.abs(p.longitude-w.longitude)<.05?'on':''}" onclick="weatherPick(${i})">${escHtml(p.full)}<small>${escHtml(p.src)}</small></button>`).join('')}</div>`:'';
  const search=`<div class="weather-search"><label class="wx-field"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg><input id="weatherCity" value="${escHtml(pending||w?.query||'')}" placeholder="城市或县，例如：广州、淳安县、Berlin" onkeydown="if(event.key==='Enter')weatherSearch()"></label><button class="wx-go" onclick="weatherSearch()" ${_weatherBusy?'disabled':''}>${_weatherBusy&&!c?'查询中…':'查询'}</button><button class="weather-reload${_weatherBusy?' spin':''}" title="刷新当前地点" aria-label="刷新当前地点" onclick="weatherRefresh()" ${_weatherBusy||!w?'disabled':''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg></button></div>`;
  let main;
  if(c){
    const parts=String(w.place||'').split(/\s*[·,，]\s*/).filter(Boolean),name=parts[0]||w.query||'',sub=parts.slice(1).filter(x=>x!=='中国').slice(0,2).join(' · ');
    const hi=d?.temperature_2m_max?.[0],lo=d?.temperature_2m_min?.[0],rise=String(d?.sunrise?.[0]||'').slice(11,16),set=String(d?.sunset?.[0]||'').slice(11,16);
    const stat=(k,v,n)=>`<div class="wx-stat"><span>${k}</span><b>${v}</b><small>${n}</small></div>`;
    main=`<section class="wx-hero">
<div class="wx-where"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg><b>${escHtml(name)}</b>${sub?`<small>${escHtml(sub)}</small>`:''}${w.auto?'<em>定位</em>':''}</div>
<div class="wx-now"><div class="wx-temp">${Math.round(c.temperature_2m)}<span>°</span></div>${_wxGlyph(c.weather_code,night)}</div>
<div class="wx-cond"><b>${_weatherName(c.weather_code)}</b>${Number.isFinite(hi)?`<span>最高 ${Math.round(hi)}°</span><span>最低 ${Math.round(lo)}°</span>`:''}</div>
<div class="wx-tip">今天出门：${_wxTip(c,d)}</div>
</section>
<div class="wx-stats">${stat('体感',Math.round(c.apparent_temperature)+'°',_wxFeel(c.temperature_2m,c.apparent_temperature))}${stat('湿度',c.relative_humidity_2m+'%',_wxHumid(c.relative_humidity_2m))}${stat('风',Math.round(c.wind_speed_10m)+'<i>km/h</i>',_wxWind(c.wind_speed_10m))}${rise?stat('日出 · 日落',rise+'<i>/</i>'+set,night?'天黑了':'天还亮着'):stat('降水',(d?.precipitation_probability_max?.[0]??0)+'%','今天的可能性')}</div>
${_wxHours(w)}${_wxDays(w)}
<div class="weather-note">更新于 ${new Date(w.ts).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · 每 15 分钟自己刷新 · 天气 Open-Meteo${w.src?' · 地名 '+escHtml(w.src):''}</div>`;
  }else{
    main=`<div class="weather-empty">${_wxGlyph(_weatherBusy?3:0,night)}<b>${_weatherBusy?'正在找这个地方…':'还没有城市'}</b><span>输入一个地方，这里就换成它此刻的天。</span><small>不需要 API Key。查过之后，AI 在约 3 小时内也看得到这份天气。</small></div>`;
  }
  b.innerHTML=`<div class="weather-room ${scene}"><div class="wx-atmo" aria-hidden="true"><i class="wx-glow"></i><i class="wx-fall"></i></div><div class="wx-inner">${search}${alts}${main}</div></div>`;
}
function weatherPromptFor(){_weatherLoad();if(!_weather||Date.now()-_weather.ts>3*60*60*1000)return'';const c=_weather.current;return `\n\n[${_weather.auto?'用户所在地的天气（手机定位）':'用户刚查询的天气'}] ${_weather.place}：${_weatherName(c.weather_code)}，${Math.round(c.temperature_2m)}°C，体感${Math.round(c.apparent_temperature)}°C，湿度${c.relative_humidity_2m}%，风速${Math.round(c.wind_speed_10m)}km/h。仅在相关时自然使用，不要无故复述。`}

// ── 后台自己保持新鲜，不用点开面板 ──
// 为什么必须有：刷新原来只发生在 openWeather() 里，而 weatherPromptFor() 只把 **3 小时内**的
// 天气递给 AI。于是不点面板的那几个钟头，克是看不到天气的 —— 面板自己一点开就补上了，
// 所以这个洞只在 AI 那一侧显形，面板上肉眼零征兆。
// 频率：每 5 分钟看一眼，数据过了 WEATHER_STALE(15 分钟) 才真去拉 —— 约等于 15 分钟一发，
// Open-Meteo 免费额度每天 10000 次，96 次/天连零头都不算。
const WEATHER_AUTO_TICK=5*60*1000;
function weatherAutoTick(){
    _weatherLoad();                                  // 别的窗口刚查过就用它那份，省一次请求
    if(!_weatherHasFix())return;                     // 还没设过地点，没什么可刷
    // 切到后台就让开，回前台有补刷（下面那个 visibilitychange）——别在她没看的时候偷跑流量
    if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
    if(Date.now()-_weather.ts<=WEATHER_STALE)return;
    // ⚠️ 面板开着、输入框里又是没提交的字（她正在敲城市名）就这轮不刷：_weatherFetch 收尾会
    //    renderWeather() 整段 innerHTML 重画，把她敲的半截字换成上次的 query。
    const inp=typeof document!=='undefined'?document.getElementById('weatherCity'):null;
    const typing=inp&&String(inp.value||'').trim()&&String(inp.value||'').trim()!==String(_weather.query||'').trim();
    if(typing)return;
    _weatherFetch(_weather,{silent:true});
}
// ⚠️ 这两个都得先探一下再挂：测试是在 vm 沙箱里跑的，那里既没有 setInterval
//    也没有 document.addEventListener，裸挂会让整个文件在 runInContext 那一行就炸。
if(typeof setInterval==='function')setInterval(()=>{try{weatherAutoTick()}catch(e){console.warn('[天气]',e)}},WEATHER_AUTO_TICK);
if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){try{weatherAutoTick()}catch(e){console.warn('[天气]',e)}}});
// 启动补一次：数据很可能是昨晚放着的。等 3 秒让 localStorage 和 DOM 都就位。
if(typeof setTimeout==='function')setTimeout(()=>{try{weatherAutoTick()}catch(e){console.warn('[天气]',e)}},3000);
