// 手机近况（2026-10-03）。直接跑 js/60-phone.js + js/36-weather.js 的真函数；安卓桥、fetch、时钟用假的。
// 跑法：node tests/phone.test.js
//
// 守的几件事：
//   · 默认全关：关着时一个 token 都不加，也不去碰桥
//   · 读一次就清：同一段「刚从 X 回来」只说一次；时长摘要两小时一次；同一个地方六小时一次，换了地方立刻说
//   · 隐私：提示词里只有城市/区，没有坐标；存下来的、发给天气的坐标都只到 0.1°
//   · 天气跟着定位走，但她 3 小时内亲手查过的城市不抢；自动刷新不把「亲手查过」的时刻顶新
//   · 开关关掉就忘掉位置；等定位的途中关掉，回来的结果作废
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'js') + path.sep;
const read = f => fs.readFileSync(R + f, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

const MIN = 60 * 1000, H = 60 * MIN;
const FC = { timezone: 'Asia/Shanghai', current: { temperature_2m: 20, apparent_temperature: 19, relative_humidity_2m: 60, weather_code: 0, wind_speed_10m: 3, time: '2026-10-03T12:00' }, daily: { time: ['2026-10-03'], weather_code: [0], temperature_2m_max: [25], temperature_2m_min: [18], precipitation_probability_max: [0] } };

function mkBox(opt = {}) {
  const clock = { now: Date.UTC(2026, 9, 3, 6, 0, 0) };
  const store = {}, calls = [], toasts = [];
  const FakeDate = class extends Date { constructor(...a) { a.length ? super(...a) : super(clock.now); } static now() { return clock.now; } };
  const usage = { v: opt.usage || null };
  const bridge = {
    n: { usage: 0, locate: 0, req: 0, open: 0, appSettings: 0 },
    granted: opt.granted !== false, locGranted: !!opt.locGranted,
    available: () => true,
    usageGranted() { return this.granted; },
    usageToday() { this.n.usage++; return JSON.stringify(usage.v || { ok: true, apps: [], totalMs: 0 }); },
    locationGranted() { return this.locGranted; },
    requestLocation() { this.n.req++; },
    locate() { this.n.locate++; },
    openUsageSettings() { this.n.open++; },
    openAppSettings() { this.n.appSettings++; },
  };
  const ctx = {
    console, Date: FakeDate, Math, JSON, String, Number, Object, Array, Promise, URLSearchParams, AbortController, clearTimeout,
    SERVER_BASE: 'http://127.0.0.1:3730',
    // 长定时器（定位兜底 60s、启动补跑 3~4s）不真排，免得测试干等
    setTimeout: (fn, ms) => (ms >= 3000 ? 0 : setTimeout(fn, ms)),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => null, visibilityState: 'visible' },
    escHtml: String, showToast: (m) => toasts.push(m),
    fetch: async (u) => {
      calls.push(u);
      if (u.includes('/api/geocode-reverse')) return { ok: true, json: async () => (opt.reverse || { ok: false }) };
      return { ok: true, json: async () => FC };
    },
  };
  if (!opt.noBridge) ctx.GrancyanPhone = bridge;
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(read('36-weather.js') + '\n' + read('60-phone.js')
    + '\n;globalThis.__w = () => _weather; globalThis.__p = () => _phone;', ctx);
  return { ctx, clock, store, calls, toasts, bridge, usage };
}
const tick = () => new Promise(r => setTimeout(r, 15));
const turnOn = (b, k) => { b.store.grancyan_phone = JSON.stringify({ ...JSON.parse(b.store.grancyan_phone || '{}'), [k]: true }); };

const DOUYIN = (now, stayMin, agoMin) => ({
  ok: true, now, totalMs: 200 * MIN,
  apps: [
    { pkg: 'com.ss.android.ugc.aweme', label: '抖音', ms: 95 * MIN },
    { pkg: 'com.grancyan.app', label: 'Grancyan', ms: 60 * MIN, self: true },
    { pkg: 'com.tencent.mm', label: '微信', ms: 45 * MIN },
  ],
  prev: { pkg: 'com.ss.android.ugc.aweme', label: '抖音', start: now - (stayMin + agoMin) * MIN, end: now - agoMin * MIN },
  fg: { pkg: 'com.grancyan.app', label: 'Grancyan', self: true },
});

(async () => {
  console.log('\n[1] 默认全关');
  {
    const b = mkBox({ usage: DOUYIN(Date.now(), 25, 1) });
    t('关着时什么都不加', b.ctx.takePhoneMoment() === '');
    t('关着时根本不去读手机', b.bridge.n.usage === 0 && b.bridge.n.locate === 0);
    t('存档里两个开关默认都是关', (() => { const p = b.ctx.__p(); return p.usageOn === false && p.locOn === false; })());
  }

  console.log('\n[2] 使用情况：读一次就清');
  {
    const b = mkBox();
    b.usage.v = DOUYIN(b.clock.now, 25, 1);
    turnOn(b, 'usageOn');
    const s1 = b.ctx.takePhoneMoment();
    t('刚从抖音回来：说了在那边待了多久', /刚从「抖音」切回来/.test(s1) && /25 分钟/.test(s1));
    t('第一轮带上今天的时长摘要，最多的排前面', /用得最多的是：抖音 1 小时 35 分、微信 45 分钟/.test(s1));
    t('摘要里自己（Grancyan）单独说成「在这里」，不混进排行', /在这里（和你聊天）1 小时/.test(s1) && !/Grancyan 1 小时/.test(s1));
    t('告诉它这是她自己开的、她知道', /ta 自己打开的/.test(s1) && /ta 知道你看得见/.test(s1));
    t('★ 紧接着下一轮：什么都不加（读一次就清）', b.ctx.takePhoneMoment() === '');
    b.clock.now += 30 * MIN;
    b.usage.v = DOUYIN(b.clock.now - 30 * MIN, 25, 1);         // 还是同一段抖音
    t('★ 同一段抖音过一会儿也不再提', b.ctx.takePhoneMoment() === '');
    b.clock.now += 2 * H;
    b.usage.v = { ...DOUYIN(b.clock.now, 25, 1) };
    const s3 = b.ctx.takePhoneMoment();
    t('两小时后：新的一段抖音又能提、摘要再给一次', /刚从「抖音」/.test(s3) && /用得最多的是/.test(s3));
  }

  console.log('\n[3] 什么算「刚回来」');
  {
    const b = mkBox(); turnOn(b, 'usageOn');
    b.usage.v = DOUYIN(b.clock.now, 25, 20);
    t('★ 离开已经 20 分钟：不算刚回来', !/切回来/.test(b.ctx.takePhoneMoment()));
    const c = mkBox(); turnOn(c, 'usageOn');
    c.usage.v = DOUYIN(c.clock.now, 1, 1);
    t('★ 只在那边待了 1 分钟：不提', !/切回来/.test(c.ctx.takePhoneMoment()));
    const d = mkBox(); turnOn(d, 'usageOn');
    d.usage.v = { ...DOUYIN(d.clock.now, 25, 1), prev: { pkg: 'x', label: '抖音', start: d.clock.now - 30 * MIN, end: 0 } };
    t('那个 App 还开着（end=0）：不说成刚回来', !/切回来/.test(d.ctx.takePhoneMoment()));
    // 2026-10-03 真机：Gadgetbridge 被手环同步在后台闪一下，熄屏 7 分钟后解锁又露了 3 秒——首尾相减是 7 分钟
    const g = mkBox(); turnOn(g, 'usageOn');
    g.usage.v = { ...DOUYIN(g.clock.now, 7, 0), prev: { pkg: 'nodomain.freeyourgadget.gadgetbridge', label: 'Gadgetbridge', start: g.clock.now - 7 * MIN, end: g.clock.now - 1000, fgMs: 3000 } };
    t('★ 首尾隔 7 分钟、真在前台只有 3 秒：不算「在那边待了」', !/切回来/.test(g.ctx.takePhoneMoment()));
    const h = mkBox(); turnOn(h, 'usageOn');
    h.usage.v = { ...DOUYIN(h.clock.now, 30, 1), prev: { pkg: 'x', label: '小红书', start: h.clock.now - 31 * MIN, end: h.clock.now - MIN, fgMs: 12 * MIN } };
    t('说的时长是真在前台的时间，不是首尾相减', /待了约 12 分钟/.test(h.ctx.takePhoneMoment()));
  }

  console.log('\n[4] 没授权 / 没有桥');
  {
    const b = mkBox({ granted: false }); turnOn(b, 'usageOn');
    b.usage.v = DOUYIN(b.clock.now, 25, 1);
    t('开了但还没去系统里授权：不加、不炸、不去读', b.ctx.takePhoneMoment() === '' && b.bridge.n.usage === 0);
    const c = mkBox({ noBridge: true }); turnOn(c, 'usageOn'); turnOn(c, 'locOn');
    t('电脑上（没有桥）：不加、不炸', c.ctx.takePhoneMoment() === '');
    c.ctx.phoneToggleUsage();
    t('电脑上点开关：提示去手机上开，开关不动', c.toasts.some(m => /安卓 App/.test(m)));
  }

  console.log('\n[5] 开关');
  {
    const b = mkBox({ granted: false });
    b.ctx.phoneToggleUsage();
    t('开使用情况：没授权就把她送去系统设置', b.bridge.n.open === 1 && b.ctx.__p().usageOn === true);
    const c = mkBox({ locGranted: false });
    c.ctx.phoneToggleLoc();
    t('开位置：没权限就弹系统授权框，先不定位', c.bridge.n.req === 1 && c.bridge.n.locate === 0);
    c.bridge.locGranted = true;      // 她在系统框里点了允许
    c.ctx._phoneNative('perm', true);
    t('授权回来了：马上定位', c.bridge.n.locate === 1);
    const d = mkBox({ locGranted: false });
    d.ctx.phoneToggleLoc();
    d.ctx._phoneNative('perm', false);
    t('被拒：位置开关自己弹回关', d.ctx.__p().locOn === false);
  }

  console.log('\n[6] 位置：只到区，换地方才说');
  {
    const b = mkBox({ locGranted: true });
    b.ctx.phoneToggleLoc();
    t('开了且有权限：直接定位', b.bridge.n.locate === 1);
    await b.ctx._phoneOnLoc({ ok: true, lat1: 30.2441, lon1: 120.1689, province: '浙江省', city: '杭州市', district: '上城区', at: b.clock.now });
    await tick();
    const s1 = b.ctx.takePhoneMoment();
    t('提示里有城市和区', /浙江省 杭州市 上城区/.test(s1));
    t('★ 提示里没有任何坐标', !/\d+\.\d+/.test(s1));
    t('★ 存下来的坐标只到 0.1°（Java 那边哪天改松了这里也兜住）', (() => { const L = b.ctx.__p().loc; return L.lat1 === 30.2 && L.lon1 === 120.2; })());
    t('★ 本机存档里找不到细坐标', !/30\.24|120\.16/.test(b.store.grancyan_phone));
    t('★ 发给天气的也只有 0.1°', b.calls.some(u => /forecast/.test(u) && /latitude=30\.2&/.test(u) && /longitude=120\.2&/.test(u)) && !b.calls.some(u => /30\.24|120\.16/.test(u)));
    t('读一次就清：下一轮不再说', b.ctx.takePhoneMoment() === '');
    b.clock.now += 3 * H;
    await b.ctx._phoneOnLoc({ ok: true, lat1: 30.24, lon1: 120.17, province: '浙江省', city: '杭州市', district: '上城区', at: b.clock.now });
    t('同一个地方三小时后：还是不说', b.ctx.takePhoneMoment() === '');
    b.clock.now += 1 * H;
    await b.ctx._phoneOnLoc({ ok: true, lat1: 29.87, lon1: 121.55, province: '浙江省', city: '宁波市', district: '海曙区', at: b.clock.now });
    const s2 = b.ctx.takePhoneMoment();
    t('★ 换了地方：下一轮就说，还带上之前在哪', /宁波市 海曙区/.test(s2) && /上次还在浙江省 杭州市 上城区/.test(s2));
    b.clock.now += 7 * H;
    t('★ 六小时没更新过的位置不再拿来说（多半早挪地方了）', b.ctx.takePhoneMoment() === '');
  }
  {
    const b = mkBox({ locGranted: true });
    b.ctx.phoneToggleLoc();
    await b.ctx._phoneOnLoc({ ok: true, lat1: 39.9, lon1: 116.4, province: '北京市', city: '北京市', district: '朝阳区', at: b.clock.now });
    t('直辖市不重复一层', b.ctx.__p().loc.place === '北京市 朝阳区');
  }

  console.log('\n[7] 系统反查不出地名 → 问电脑兜底');
  {
    const b = mkBox({ locGranted: true, reverse: { ok: true, province: '浙江省', city: '湖州市', district: '' } });
    b.ctx.phoneToggleLoc();
    await b.ctx._phoneOnLoc({ ok: true, lat1: 30.89, lon1: 120.09, geocoder: 'failed', at: b.clock.now });
    t('兜底问的是 server，坐标只到 0.1°', b.calls.some(u => u === 'http://127.0.0.1:3730/api/geocode-reverse?lat=30.9&lon=120.1'));
    t('兜底拿到的城市用上了', b.ctx.__p().loc.place === '浙江省 湖州市');
    const c = mkBox({ locGranted: true, reverse: { ok: false } });
    c.ctx.phoneToggleLoc();
    await c.ctx._phoneOnLoc({ ok: true, lat1: 30.89, lon1: 120.09, at: c.clock.now });
    t('兜底也不行：不编地名，提示里不说位置', c.ctx.__p().loc.place === '' && !/现在大概在/.test(c.ctx.takePhoneMoment()));
    t('…但天气照样跟过去（坐标还是有用的）', c.calls.some(u => /forecast/.test(u) && /latitude=30\.9/.test(u)));
  }

  console.log('\n[8] 关掉 / 途中关掉');
  {
    const b = mkBox({ locGranted: true });
    b.ctx.phoneToggleLoc();
    await b.ctx._phoneOnLoc({ ok: true, lat1: 30.24, lon1: 120.17, province: '浙江省', city: '杭州市', district: '上城区', at: b.clock.now });
    await tick();
    b.ctx.phoneToggleLoc();
    t('★ 关掉位置：本机存档里的位置一起清掉', b.ctx.__p().loc === null && !/杭州/.test(b.store.grancyan_phone));
    t('关掉后气象台不再自称「所在地」', b.ctx.__w().auto === false && !/所在地/.test(b.ctx.weatherPromptFor()));
    const c = mkBox({ locGranted: true });
    c.ctx.phoneToggleLoc();
    c.ctx.phoneToggleLoc();          // 定位还没回来她就关了
    await c.ctx._phoneOnLoc({ ok: true, lat1: 30.24, lon1: 120.17, province: '浙江省', city: '杭州市', district: '上城区', at: c.clock.now });
    t('★ 途中关掉：迟到的定位结果作废，不存、不查天气', c.ctx.__p().loc === null && !c.calls.some(u => /forecast/.test(u)));
  }

  console.log('\n[9] 天气跟着定位走');
  {
    const b = mkBox({ locGranted: true });
    b.ctx.phoneToggleLoc();
    await b.ctx._phoneOnLoc({ ok: true, lat1: 30.24, lon1: 120.17, province: '浙江省', city: '杭州市', district: '上城区', at: b.clock.now });
    await tick();
    const w = b.ctx.__w();
    t('没设过城市：直接用定位的', w && w.auto === true && w.place === '浙江省 杭州市 上城区' && w.latitude === 30.2);
    t('给 AI 的天气标成「所在地」', /用户所在地的天气（手机定位）/.test(b.ctx.weatherPromptFor()));

    // 用户 1 小时前亲手查了淳安县（之后被自动刷新顶新过 ts）
    const c = mkBox({ locGranted: true });
    c.store.grancyan_weather = JSON.stringify({ ts: c.clock.now - 5 * MIN, pickedAt: c.clock.now - 1 * H, auto: false, query: '淳安县', place: '淳安县', latitude: 29.61, longitude: 119.04, current: FC.current, daily: FC.daily });
    c.ctx.phoneToggleLoc();
    await c.ctx._phoneOnLoc({ ok: true, lat1: 30.24, lon1: 120.17, province: '浙江省', city: '杭州市', district: '上城区', at: c.clock.now });
    await tick();
    t('★ 用户一小时前亲手查的城市：不抢', c.ctx.__w().place === '淳安县' && !c.calls.some(u => /forecast/.test(u)));

    const d = mkBox({ locGranted: true });
    d.store.grancyan_weather = JSON.stringify({ ts: d.clock.now - 5 * MIN, pickedAt: d.clock.now - 4 * H, auto: false, query: '淳安县', place: '淳安县', latitude: 29.61, longitude: 119.04, current: FC.current, daily: FC.daily });
    d.ctx.phoneToggleLoc();
    await d.ctx._phoneOnLoc({ ok: true, lat1: 30.24, lon1: 120.17, province: '浙江省', city: '杭州市', district: '上城区', at: d.clock.now });
    await tick();
    t('★ 亲手查是 4 小时前的事（哪怕 5 分钟前刚自动刷新过）：换成定位', d.ctx.__w().place === '浙江省 杭州市 上城区');

    // 自动刷新同一个地点：不能把 pickedAt 顶新、也不能把 auto 弄丢
    const e = mkBox();
    e.store.grancyan_weather = JSON.stringify({ ts: e.clock.now - 30 * MIN, pickedAt: e.clock.now - 4 * H, auto: false, query: '淳安县', place: '淳安县', latitude: 29.61, longitude: 119.04, current: FC.current, daily: FC.daily });
    e.ctx.weatherAutoTick(); await tick();
    const ew = e.ctx.__w();
    t('★ 自动刷新不把「亲手查过」的时刻顶新', ew.ts === e.clock.now && ew.pickedAt === e.clock.now - 4 * H);
    const f = mkBox();
    f.store.grancyan_weather = JSON.stringify({ ts: f.clock.now - 30 * MIN, pickedAt: f.clock.now - 4 * H, auto: true, query: '杭州市', place: '浙江省 杭州市 上城区', latitude: 30.2, longitude: 120.2, current: FC.current, daily: FC.daily });
    f.ctx.weatherAutoTick(); await tick();
    t('自动刷新定位来的地点：还是 auto', f.ctx.__w().auto === true);
    t('同一格同一个名字再定位一次：不重复拉天气', (() => { f.calls.length = 0; return f.ctx._phoneWeatherSync({ place: '浙江省 杭州市 上城区', lat1: 30.2, lon1: 120.2 }) === false && !f.calls.length; })());
  }

  console.log('\n[10] 接线');
  const api = read('05-prompts-api.js'), html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  t('提示只进 volatile', /vol \+= takePhoneMoment\(\)/.test(api) && !/base \+= takePhoneMoment/.test(api));
  t('小屋里有入口、面板和脚本都挂上了', /onclick="openWidget\(openPhone\)"/.test(html) && /id="phoneModal"/.test(html) && /js\/60-phone\.js/.test(html));
  const AND = path.join(ROOT, 'android');
  const java = fs.readFileSync(path.join(AND, 'src/com/grancyan/app/PhoneBridge.java'), 'utf8');
  const main = fs.readFileSync(path.join(AND, 'src/com/grancyan/app/MainActivity.java'), 'utf8');
  const mani = fs.readFileSync(path.join(AND, 'AndroidManifest.xml'), 'utf8');
  t('壳里把桥挂成 GrancyanPhone', /addJavascriptInterface\(phoneBridge, "GrancyanPhone"\)/.test(main));
  t('授权结果转回桥', /requestCode == PhoneBridge\.LOCATION_PERMISSION_REQUEST/.test(main) && /phoneBridge\.onPermissionResult/.test(main));
  t('manifest 声明了使用情况、粗略定位、包可见性', /PACKAGE_USAGE_STATS/.test(mani) && /ACCESS_COARSE_LOCATION"\/>/.test(mani) && /<queries>[\s\S]*LAUNCHER[\s\S]*<\/queries>/.test(mani));
  t('Java 熄屏就断开「最近一段」，并交出真在前台的时长', /t == 16 \/\* SCREEN_NON_INTERACTIVE \*\/\) \{\s*runBroken = true;/.test(java) && /put\("fgMs", runFg\)/.test(java));
  t('★ Java 交出去的坐标只有舍到 0.1° 的那份', /put\("lat1", Math\.round\(best\.getLatitude\(\) \* 10\) \/ 10\.0\)/.test(java)
    && !/put\("lat"|put\("lon"|put\("latitude"|put\("longitude"/.test(java));
  t('Java 回调走 window._phoneNative', /window\._phoneNative && window\._phoneNative\(/.test(java) && /function _phoneNative\(kind, d\)/.test(read('60-phone.js')));
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const seg = (srv.match(/app\.get\('\/api\/geocode-reverse'[\s\S]*?\n\}\);/) || [''])[0];
  t('★ server 兜底反查自己再舍到 0.1°、只到城市一级', /Math\.round\(Number\(req\.query\.lat\) \* 10\) \/ 10/.test(seg) && /zoom: '10'/.test(seg));
  t('server 兜底同样守 Nominatim 的规矩（UA、限速、走代理）', /NOMINATIM_UA/.test(seg) && /geoThrottle\(/.test(seg) && /await outboundAgent\(\)/.test(seg));
  t('android 副本与 js/ 一致', ['60-phone.js', '36-weather.js', '05-prompts-api.js'].every(f => {
    try { return fs.readFileSync(R + f).equals(fs.readFileSync(path.join(AND, 'assets/js', f))); } catch { return false; }
  }));

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ 测试自己炸了：' + e.stack); process.exit(1); });
