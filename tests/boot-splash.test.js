// 启动页 + 登录墙（2026-10-10）的回归测试。跑法：node tests/boot-splash.test.js
//
// 用户的原话：每次点开**已经登录**的 GranCyan，都会先出现几秒登录框。
// 病根：#authModal 在 index.html 里默认立着，checkUser() 却要等 IDB 读完、整个界面画完才跑。
// 现在开机先盖 #bootSplash，登录一有结论就收。守的全是静默失效：
//   · 某条路忘了收启动页 → 永远对着一张在转的启动页（或者等云端对话拉完几十秒才收）
//   · 换了登录墙的皮，handleAuth 按 onclick 属性找按钮找不到 → 点登录直接 TypeError，零提示
//   · .hidden 被 #authModal 的 display 压住 → 登录了墙也收不起来
// 真画面是 headless 截图看过的，这里只守那几根线。

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };

const html = read('index.html');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');
const css = read('css/boot.css').replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里会提到反面教材，先剥掉

console.log('── 页面骨架 ──');
const splashAt = html.indexOf('<div id="bootSplash"'), wallAt = html.indexOf('<div id="authModal"');
t('启动页在，而且排在登录墙前面（首帧盖住的是它）', splashAt > 0 && wallAt > splashAt, { splashAt, wallAt });
t('boot.css 挂上了', /<link rel="stylesheet" href="\.\/css\/boot\.css">/.test(html));
t('猫脸渐变放在常驻的 defs 里（启动页会被移除，放它身上登录墙的猫脸就没颜色了）',
  (() => { const d = html.indexOf('id="markBlurDefs"'), g = html.indexOf('id="gcAmber"'); return d > splashAt && g > d && g < wallAt; })());
t('登录按钮的 onclick 原样（handleAuth 靠这串属性找按钮）', html.includes(`<button onclick="handleAuth('login')"`));
t('注册按钮的 onclick 原样', html.includes(`<button onclick="handleAuth('signup')"`));
for (const id of ['authEmail', 'authPassword', 'authPasswordConfirm', 'confirmPwdWrap', 'togglePwd', 'togglePwd2', 'authError', 'authErrorIcon', 'authErrorText', 'starCanvas'])
  t(`#${id} 还在`, html.includes(`id="${id}"`));
const h2 = (html.slice(wallAt).match(/<h2[^>]*>([^<]*)<\/h2>/) || [])[1];
t('标题文字没动（16-misc.js 的英文规则整句匹配它）', /^欢迎([\s\S]*?)回家 ✦ ·˚$/.test(h2 || ''), h2);
t('登录墙默认不挂 hidden（没登录的人第一眼要看得到它）', !/id="authModal"[^>]*\bhidden\b/.test(html));

console.log('── 收启动页的三条路 ──');
const cu = core.slice(core.indexOf('async function checkUser()'), core.indexOf('function togglePasswordVisibility'));
const userBranch = cu.slice(cu.indexOf('if (user) {'), cu.indexOf('} else {'));
const hideAt = userBranch.indexOf(`classList.add('hidden')`), doneAt = userBranch.indexOf('bootSplashDone()'), cloudAt = userBranch.indexOf('await loadFromCloud()');
t('已登录：收墙之后、拉云端之前就收启动页（云端能拖几十秒）', hideAt > 0 && doneAt > hideAt && cloudAt > doneAt, { hideAt, doneAt, cloudAt });
const elseBranch = cu.slice(cu.indexOf('} else {'), cu.indexOf('} catch (err)'));
t('没登录：露出墙之后收启动页', /classList\.remove\('hidden'\);\s*\n\s*bootSplashDone\(\);/.test(elseBranch));
const catchBranch = cu.slice(cu.indexOf('} catch (err)'), cu.indexOf('} finally'));
t('查不出来：同样收', /classList\.add\('hidden'\);\s*\n\s*bootSplashDone\(\);/.test(catchBranch));
t('开机链挂了（checkUser 轮不到）也收', /\[启动失败\][\s\S]{0,200}bootSplashDone\(\)/.test(boot));
t('兜底计时器在', /setTimeout\(bootSplashDone, \d{4,5}\)/.test(core));

console.log('── 云端挂了不许把人锁门外（2026-10-11 exceed_egress_quota）──');
{
  const src = core.slice(core.indexOf('function authServiceDown('), core.indexOf('function enterOffline('));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src + ';this.f=authServiceDown;', ctx);
  const f = ctx.f;
  t('限流报错算服务挂了', f({ message: 'Service for this project is restricted due to the following violations: exceed_egress_quota', status: 402 }));
  t('限流报错就算没带 status 也认', f({ message: 'Service for this project is restricted' }));
  t('断网算服务挂了', f({ message: 'Failed to fetch', status: 0 }));
  t('5xx 算服务挂了', f({ message: 'x', status: 503 }));
  t('密码错不算（不能给没登录的人开门）', !f({ message: 'Invalid login credentials', status: 400 }));
  t('会话吊销不算', !f({ message: 'invalid JWT', status: 401 }));
  t('没有错误不算', !f(null));
  const gu = cu.slice(cu.indexOf('auth.getUser()'), cu.indexOf(`classList.remove('hidden')`));
  t('getUser 失败时先问 authServiceDown 再决定踢不踢', /authServiceDown\(error\)[\s\S]*return;/.test(gu), gu.slice(0, 200));
  // 用户：「登录页下面就直接有用本机数据的选项」—— 不再等登录失败才露
  const offTag = (html.match(/<button[^>]*id="authOfflineBtn"[^>]*>/) || [''])[0];
  t('登录墙的「先用本机数据」常驻（不挂 display:none / hidden）', /onclick="enterOffline\(\)"/.test(offTag) && !/display:\s*none|\bhidden\b/.test(offTag), offTag);
  t('它在登录、注册按钮下面', html.indexOf('id="authOfflineBtn"') > html.indexOf(`onclick="handleAuth('signup')"`));
  const ha = core.slice(core.indexOf('async function handleAuth('), core.indexOf('function authServiceDown('));
  t('handleAuth 不再去藏它', !/authOfflineBtn/.test(ha));
  t('登录失败且云端挂了 → 开始盯恢复', /authServiceDown\(error\)\)\s*watchCloudRecovery\(true\)/.test(ha));
  t('getUser 报云端挂了 → 也开始盯', /authServiceDown\(error\)\)\s*\{[\s\S]{0,160}watchCloudRecovery\(true\);\s*\n\s*return;/.test(gu));
  t('点离线进门 → 开始盯（不预设挂了）', /function enterOffline\(\)\s*\{[\s\S]*?watchCloudRecovery\(\);\s*\n\s*\}/.test(core));
  t('登进来了就停掉、收横条', /currentUser = user;\s*\n\s*stopCloudWatch\(\);[\s\S]{0,120}cloudBackBar'\)\?\.remove\(\)/.test(userBranch));
}

console.log('── 云端恢复了叫她去登录（10-11）──');
{
  const src = core.slice(core.indexOf('const CLOUD_PROBE_MS'), core.indexOf('function cloudError('));
  const mk = (opts = {}) => {
    const S = { up: !!opts.up, fetches: 0, intervals: [], cleared: 0, toasts: [], notes: [], pulls: 0, now: 1e6, win: {}, doc: {}, appended: [], entered: 0 };
    const el = id => S.els[id] || (S.els[id] = { id, style: {}, textContent: '', innerText: '', _c: new Set(),
      classList: { add: c => S.els[id]._c.add(c), remove: c => S.els[id]._c.delete(c), contains: c => S.els[id]._c.has(c) }, focus() {} });
    S.els = {};
    if (opts.wallHidden) el('authModal')._c.add('hidden');
    const ctx = {
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k',
      currentUser: opts.user || null,
      Date: { now: () => S.now },
      fetch: async (url, o) => { S.fetches++; S.lastUrl = url; S.lastKey = o.headers.apikey; if (S.up === 'throw') throw new TypeError('Failed to fetch'); return { ok: S.up }; },
      setInterval: (fn, ms) => { S.intervals.push({ fn, ms }); return S.intervals.length; },
      clearInterval: () => { S.cleared++; },
      window: { addEventListener: (k, fn) => { S.win[k] = fn; }, removeEventListener: k => { delete S.win[k]; }, focus() {} },
      document: {
        visibilityState: 'visible',
        addEventListener: (k, fn) => { S.doc[k] = fn; }, removeEventListener: k => { delete S.doc[k]; },
        getElementById: id => (id === 'cloudBackBar' ? (S.bar && !S.bar.gone ? S.bar : null) : el(id)),
        createElement: () => {
          const btns = {};
          const b = { setAttribute() {}, querySelector: s => btns[s] || (btns[s] = {}), remove() { b.gone = true; } };
          return b;
        },
        body: { appendChild: b => { S.bar = b; S.appended.push(b); } },
      },
      showToast: (m, k) => S.toasts.push([m, k]),
      loadFromCloud: async () => { S.pulls++; },
      authWallEnter: () => { S.entered++; },
      console,
      Notification: Object.assign(function (title, o) { S.notes.push({ title, ...o, n: this }); this.close = () => {}; }, { permission: 'granted' }),
    };
    vm.createContext(ctx);
    vm.runInContext(src + ';this.watch=watchCloudRecovery;this.stop=stopCloudWatch;', ctx);
    S.ctx = ctx;
    S.flush = () => new Promise(r => setImmediate(r));
    S.tick = async (dt = 3 * 60 * 1000) => { S.now += dt; S.intervals.at(-1).fn(); await S.flush(); };
    return S;
  };
  (async () => {
    {
      const S = mk({ up: true });
      S.ctx.watch(); await S.flush();
      t('离线进门时云端本来就好：敲一下就收工，不报喜', S.fetches === 1 && S.notes.length === 0 && !S.bar && S.cleared === 1);
      t('敲的是 /auth/v1/health，带 apikey', S.lastUrl === 'https://x.supabase.co/auth/v1/health' && S.lastKey === 'k', S.lastUrl);
    }
    {
      const S = mk({ up: false, wallHidden: true });
      S.ctx.watch(); await S.flush();
      t('挂着：继续盯，3 分钟一次', S.fetches === 1 && S.intervals.length === 1 && S.intervals[0].ms === 180000 && S.cleared === 0, S.intervals.map(x => x.ms));
      S.ctx.watch(); await S.flush();
      t('再调一次不叠一套计时器', S.intervals.length === 1);
      S.up = 'throw'; await S.tick();
      t('402 不带 CORS → fetch 抛错也算还挂着', S.fetches === 2 && S.notes.length === 0 && !S.bar);
      S.up = true; S.now += 5000; S.win.online(); await S.flush();
      t('联网事件 20s 内连敲不算数（不刷 egress）', S.fetches === 2);
      await S.tick();
      t('恢复了（离线进来、墙收着）：顶上挂横条 + 系统通知', S.fetches === 3 && S.bar && !S.bar.gone && S.notes.length === 1 && /恢复/.test(S.notes[0].title));
      t('恢复后停表、摘监听', S.cleared === 1 && !S.win.online && !S.doc.visibilitychange);
      S.bar.querySelector('.cloud-back-go').onclick();
      t('点「去登录」：收横条、墙露出来、播进场', S.bar.gone && !S.els.authModal._c.has('hidden') && S.entered === 1);
    }
    {
      const S = mk({ up: true, wallHidden: true });
      S.ctx.watch(); await S.flush(); const f = S.fetches;
      S.ctx.watch(true); await S.flush();
      t('先前没见挂、后来别处报挂了（seenDown）→ 新开一轮，好了就报', S.fetches === f + 1 && S.notes.length === 1 && S.bar);
      S.notes[0].n.onclick();
      t('点系统通知也能回到登录墙', !S.els.authModal._c.has('hidden') && S.entered === 1);
    }
    {
      const S = mk({ up: false });   // 墙还立着
      S.ctx.watch(true); await S.flush();
      S.up = true; await S.tick();
      t('人还在墙前：那行字换成「可以登录了」、标 is-ok，不挂横条', /可以登录/.test(S.els.authErrorText.innerText) && S.els.authError._c.has('is-ok') && !S.bar);
    }
    {
      const S = mk({ up: false, user: { id: 'u' }, wallHidden: true });
      S.ctx.watch(true); await S.flush();
      S.up = true; await S.tick();
      t('登录着、只是云端挂过：不叫她登录，直接补拉一轮', S.pulls === 1 && !S.bar && S.toasts.some(([m]) => /恢复/.test(m)));
    }
    {
      const S = mk({ up: false });
      S.ctx.watch(true); await S.flush();
      S.ctx.stop(); S.up = true; S.intervals[0].fn(); await S.flush();
      t('stopCloudWatch 之后旧计时器再响也不动', S.fetches === 1 && S.notes.length === 0);
    }
    {
      const S = mk({ up: true, wallHidden: true });
      S.ctx.Notification.permission = 'denied';
      S.ctx.watch(true); await S.flush();
      t('系统通知被拒：页面里的横条照样挂', S.bar && S.notes.length === 0);
      delete S.ctx.Notification;
    }
    {
      const S = mk({ up: true, wallHidden: true });
      vm.runInContext('Notification = undefined', S.ctx);
      S.ctx.watch(true); await S.flush();
      t('安卓 WebView 没 Notification：不抛错，横条照样挂', S.bar && !S.bar.gone);
    }
    t('.cloud-back 有样式、自带深色底', /\.cloud-back\s*\{[^}]*position:\s*fixed[^}]*background:\s*rgba\(22,16,12/.test(css));
    t('#authError.is-ok 换色不抖', /#authModal #authError\.is-ok\s*\{[^}]*animation:\s*none/.test(css));
  })().then(() => {
    console.log(`\n${pass} 过 / ${fail} 挂`);
    if (fail) process.exit(1);
  });
}


console.log('── bootSplashDone 真跑一遍 ──');
{
  const src = core.slice(core.indexOf('let _bootSplashGone = false;'), core.indexOf('function authGreeting('));
  const timers = []; let removed = 0, entered = 0, now = 300;
  const el = { classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } }, remove() { removed++; } };
  const ctx = {
    document: { getElementById: id => id === 'bootSplash' ? el : null },
    performance: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    authWallEnter: () => { entered++; },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.bootSplashDone = bootSplashDone;', ctx);
  timers.length = 0;   // 模块顶层那个 15s 兜底不算
  ctx.bootSplashDone();
  t('开机太快就等猫脸画完再收（不然只闪一下）', timers.length === 1 && timers[0].ms === 850, timers.map(x => x.ms));
  timers.shift().fn();
  t('收的时候挂 boot-leave、播墙的进场', el.classList.contains('boot-leave') && entered === 1);
  timers.shift().fn();
  t('淡出完从 DOM 里拿掉', removed === 1);
  ctx.bootSplashDone();
  t('第二次调是空操作（三条路 + 兜底可能都会调）', timers.length === 0 && entered === 1);
}

console.log('── 水纹 ──');
{
  const sp = html.slice(splashAt, wallAt);
  t('光纹画布在启动页里', sp.includes('<canvas id="bootWater">'));
  t('不用 SVG 位移滤镜 / SMIL（都在主线程上算，开机一卡就跟着卡）', !/gcRipple|<feDisplacementMap|<animate\b/.test(sp) && !/url\(#gcRipple\)/.test(css));
  t('猫脸画在画布里时，HTML 那枚只占位置、不跑动画', /#bootSplash\.gl \.boot-lens \.gc-mark\s*\{\s*visibility:\s*hidden/.test(css) && /#bootSplash\.gl \.boot-lens \.gc-mark \*\s*\{\s*animation:\s*none/.test(css));
  const a = html.indexOf('// 水底光纹 + 猫脸从水下浮上来'), src = html.slice(a, html.indexOf('</script>', a));
  const tag = sp.indexOf('<script src="./js/boot-water.js"></script>');
  t('boot-water.js 在启动页后面同步载入、排在内联那段前面（Worker 拿它的源码起，不自己再排队请求）', tag > 0 && tag < sp.indexOf('// 水底光纹 + 猫脸从水下浮上来'));
  t('exe 的 CSP 放行 blob: Worker（不然退回按文件地址起，又得排队）', /worker-src[^;"]*blob:/.test(read('electron-main.js')));

  // ── 内联那段：画布交给 Worker（先 Blob 再文件地址），Worker 不行就主线程，什么都不行就露出 SVG 猫脸
  const boot = opts => {
    const cls = new Set(), timers = [], workers = [], listeners = {}, mos = [], rafs = [], revoked = [], mains = [];
    let pnow = 100;
    const offs = [];
    const mark = { getBoundingClientRect: () => ({ left: 635, top: 350, width: 170, height: 98 }) };
    const center = {};
    const mkCanvas = () => {
      const c = { id: 'bootWater', parentNode: null, transferControlToOffscreen: opts.noOffscreen ? undefined : () => { const o = { from: c, w: c.width, h: c.height }; offs.push(o); return o; } };
      return c;
    };
    const parent = { swaps: [], replaceChild(n, o) { this.swaps.push([n, o]); n.parentNode = parent; } };
    const cv = mkCanvas(); cv.parentNode = parent;
    const anims = ['bootLampIn', 'bootRise', 'bootRise', 'bootRise', 'bootFlow'].map(n => ({ animationName: n, startTime: null }));
    const host = {
      isConnected: true,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
      querySelector: s => s === '.boot-lens .gc-mark' ? mark : s === '.boot-center' ? center : null,
      getAnimations: o => (o && o.subtree ? anims : []),
    };
    function Worker(url) {
      this.url = url; this.msgs = []; this.terminated = false; workers.push(this);
      if (opts.workerThrows === true || (opts.workerThrows === 'blob' && /^blob:/.test(url))) throw new Error('nope');
    }
    Worker.prototype.postMessage = function (m, tr) { this.msgs.push([m, tr]); };
    Worker.prototype.terminate = function () { this.terminated = true; };
    const BW = opts.noBW ? undefined : Object.assign(function (c, d) {
      const r = opts.mainNoGL ? null : { c, d, started: [], frames: 0, start(at) { this.started.push(at); }, frame() { if (!this.frames++ && d.onFirst) d.onFirst(); }, size() {}, leave() {}, free() {} };
      mains.push(r || { c, d, nogl: true });
      return r;
    }, { src: '(function bootWater(G){})(self);' });
    const win = {
      matchMedia: () => ({ matches: !!opts.still }), devicePixelRatio: opts.dpr || 1.5,
      Worker, OffscreenCanvas: function () {}, GCBootWater: BW,
      location: { hostname: opts.host || '127.0.0.1' }, navigator: { userAgent: opts.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140' },
    };
    let blobs = 0;
    const ctx = {
      window: win, matchMedia: win.matchMedia, Worker, innerWidth: 1302, innerHeight: 667, location: win.location, navigator: win.navigator,
      Blob: function (parts, o) { this.parts = parts; this.type = o && o.type; },
      URL: { createObjectURL: b => (win.lastBlob = b, 'blob:' + ++blobs), revokeObjectURL: u => revoked.push(u) },
      performance: { now: () => pnow, timeOrigin: 1e12 },
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      requestAnimationFrame: fn => rafs.push(fn),
      addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: k => { delete listeners[k]; },
      ResizeObserver: function (fn) { this.observe = el => { this.el = el; }; },
      MutationObserver: function (fn) { this.observe = (el, o) => { mos.push({ fn, el, o, mo: this }); }; this.disconnect = () => { this.off = true; }; },
      document: {
        getElementById: id => id === 'bootSplash' ? host : id === 'bootWater' ? cv : null,
        createElement: tag => tag === 'canvas' ? mkCanvas() : { tag },
      },
    };
    win.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return { ctx, win, cls, timers, workers, listeners, mos, rafs, revoked, mains, anims, parent, cv, offs, setNow: v => { pnow = v; } };
  };
  const fallback = b => b.timers.find(x => x.ms === 1500);
  // 手机不画水：WebView 冷启动时 Worker 那张全屏画布怎么都抢不过，交出前定尺寸也没救（用户实测还是卡）
  for (const [name, o] of [['手机 app（grancyan.app）', { host: 'grancyan.app' }], ['手机浏览器', { ua: 'Mozilla/5.0 (Linux; Android 17; Pixel 8) Mobile Safari/537.36' }]]) {
    const b = boot(o);
    let done = 0; b.setNow(400); b.win.bootIntroDone(() => done++);
    t(name + '：不起 Worker、不碰画布，挂 .lite 露出 HTML 猫脸，字马上起跑', b.workers.length === 0 && b.offs.length === 0 && b.mains.length === 0 &&
      b.cls.has('lite') && !b.cls.has('gl') && b.cls.has('go'), [...b.cls]);
    t(name + '：开场照样播满 2.2s 才放行（字 1.7s 才升完，按兜底的 1150ms 收会把字切掉）', b.timers.at(-1).ms === 1900, b.timers.map(x => x.ms));
  }
  {
    const b = boot({});
    t('电脑照旧画水（不挂 .lite）', b.workers.length === 1 && !b.cls.has('lite') && b.cls.has('gl'));
  }
  t('.lite：画布不显示，猫脸整枚只动 opacity / transform，里面的笔画、蓝影不跑动画（那两样要主线程重画）',
    /#bootSplash\.lite #bootWater\s*\{\s*display:\s*none/.test(css) &&
    /#bootSplash\.lite \.gc-mark\s*\{\s*animation:\s*bootMarkIn\b/.test(css) && /#bootSplash\.lite \.gc-mark \*\s*\{\s*animation:\s*none/.test(css) &&
    /#bootSplash\.lite \.gc-mark path\s*\{\s*stroke-dashoffset:\s*0/.test(css) &&
    /@keyframes bootMarkIn\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:[^}]*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*none;\s*\}\s*\}/.test(css));
  {
    const b = boot({ dpr: 3 }), init = b.workers[0] && b.workers[0].msgs[0];
    t('手机 dpr 3：画布按 1.5 倍像素画（全屏 shader 少算一半多）', init && init[0].d.k === 1.5, init && init[0].d);
    // Worker 那边再改尺寸会换 surface，安卓 WebView 冷启动时等主线程重推那一层才认 → 猫脸冻在第一笔 3 秒多
    t('交出画布之前尺寸已经定好（Worker 不用再改尺寸）', b.offs[0] && b.offs[0].w === 1953 && b.offs[0].h === 1001, b.offs[0]);
  }
  {
    const bw = read('js/boot-water.js');
    t('两边定尺寸是同一个取整（不一样 Worker 还是会改一次）',
      /cv\.width = Math\.max\(1, Math\.round\(d\.w \* d\.k\)\); cv\.height = Math\.max\(1, Math\.round\(d\.h \* d\.k\)\);\s*\n\s*var off = cv\.transferControlToOffscreen\(\)/.test(html) &&
      /var w = Math\.max\(1, Math\.round\(d\.w \* d\.k\)\), h = Math\.max\(1, Math\.round\(d\.h \* d\.k\)\);/.test(bw));
  }

  {
    const b = boot({});
    const w = b.workers[0], init = w && w.msgs[0];
    t('先用 Blob 起 Worker，源码就是 GCBootWater.src', w && w.url === 'blob:1' && b.win.lastBlob.parts[0] === '(function bootWater(G){})(self);' && b.workers.length === 1);
    t('画布转过去了（transfer 列表里有它），带上猫脸位置；不带起点（起点等画布上屏再给）', init && init[0].type === 'init' && init[0].canvas === b.offs[0] && init[1] && init[1][0] === b.offs[0] &&
      !('origin' in init[0]) && JSON.stringify(init[0].d.rect) === '[635,350,170,98]' && init[0].d.k === 1.5 && init[0].still === false, init && init[0]);
    t('挂上 .gl（HTML 猫脸让位给画布），还没 .go（字停在第一帧）', b.cls.has('gl') && !b.cls.has('go'));
    let done = 0; b.setNow(400); b.win.bootIntroDone(() => done++);
    t('画布还没起跑：bootIntroDone 先排着，不按页面时间放行', b.timers.length === 1 && b.timers[0].ms === 1500, b.timers.map(x => x.ms));
    w.onmessage({ data: 'ready' });
    t('Worker 报 ready：不马上起跑，等主线程下一个 rAF（那一帧画布才提交上屏）', b.rafs.length === 1 && w.msgs.length === 1 && !b.cls.has('go'));
    b.setNow(900); if (b.rafs[0]) b.rafs[0](900);
    t('rAF 里起跑：Worker 收到同一个起点', w.msgs[1] && w.msgs[1][0].type === 'start' && w.msgs[1][0].at === 1e12 + 900, w.msgs[1]);
    t('字跟着起跑：挂 .go，bootRise / bootFlow 的 startTime 对齐到起点，灯不动', b.cls.has('go') &&
      b.anims.filter(x => /^boot(Rise|Flow)$/.test(x.animationName)).every(x => x.startTime === 900) && b.anims.filter(x => /^bootLamp/.test(x.animationName)).every(x => x.startTime === null), b.anims);
    t('排着的 bootIntroDone 从起点算 2.2s 放行', b.timers.at(-1).ms === 2200, b.timers.map(x => x.ms));
    b.setNow(1500); b.win.bootIntroDone(() => done++);
    t('起跑后再调：按起点 + 2.2s 算剩多少', b.timers.at(-1).ms === 1600, b.timers.map(x => x.ms));
    if (fallback(b)) fallback(b).fn();
    t('1.5s 兜底晚到：起点不变（再发一次同一个，不会把开场往后推）', w.msgs.at(-1)[0].type === 'start' && w.msgs.at(-1)[0].at === 1e12 + 900 && b.anims[2].startTime === 900);
    b.mos[0].fn([], b.mos[0].mo);
    const n = w.msgs.length;
    t('还没离场时 class 变了不算', w.msgs.length === n);
    b.cls.add('boot-leave'); b.setNow(3000); b.mos[0].fn([], b.mos[0].mo);
    t('一挂 boot-leave 就通知 Worker 沉回水里', w.msgs.at(-1)[0].type === 'leave' && w.msgs.at(-1)[0].at === 1e12 + 3000);
    t('淡出完 1s 后关掉 Worker、放掉 Blob 地址', b.timers.at(-1).ms === 1000 && (b.timers.at(-1).fn(), w.terminated && b.revoked.includes('blob:1')));
    t('离场后不再听窗口尺寸', typeof b.listeners.resize === 'undefined');
  }
  {
    const b = boot({});
    b.listeners.resize();
    t('尺寸变了把新位置发给 Worker', b.workers[0].msgs[1] && b.workers[0].msgs[1][0].type === 'size');
    let done = 0; b.setNow(400); b.win.bootIntroDone(() => done++);
    b.workers[0].onmessage({ data: 'fail' });
    t('Worker 里拿不到 WebGL → 摘掉 .gl 露出 SVG 猫脸、字也起跑', !b.cls.has('gl') && b.cls.has('go') && b.workers[0].terminated);
    t('排着的 bootIntroDone 改按 SVG 猫脸画完的时间放行（1150ms）', b.timers.at(-1).ms === 750, b.timers.map(x => x.ms));
  }
  {
    const b = boot({});
    b.workers[0].onerror();
    const w2 = b.workers[1];
    t('Blob Worker 起不来（CSP 不给）→ 换新画布，按文件地址再起一个', w2 && w2.url === './js/boot-water.js' && b.parent.swaps.length === 1 && b.parent.swaps[0][1] === b.cv &&
      w2.msgs[0][0].canvas === b.offs[1] && b.offs[1].from === b.parent.swaps[0][0] && b.revoked.includes('blob:1'));
    if (w2) w2.onerror();
    t('文件那个也起不来 → 再换一张，同一份代码在主线程上画', b.parent.swaps.length === 2 && b.mains.length === 1 && b.mains[0].c === b.parent.swaps[1][0]);
    t('主线程画出第一帧就起跑（画在主线程上的，画出来就是上屏了）', b.cls.has('go') && b.mains[0].started && b.mains[0].started[0] === 1e12 + 100, b.mains[0].started);
  }
  {
    const b = boot({ workerThrows: 'blob', mainNoGL: true });
    t('new Worker(blob) 当场抛错也退到文件地址', b.workers.length === 2 && b.workers[1].url === './js/boot-water.js' && b.workers[1].msgs.length === 1);
    if (b.workers[1]) b.workers[1].onerror();
    t('主线程也拿不到 WebGL → 露出 SVG 猫脸', !b.cls.has('gl') && b.cls.has('go'));
  }
  {
    const b = boot({ noOffscreen: true });
    t('没有 OffscreenCanvas 直接走主线程（画布不用换）', b.workers.length === 0 && b.mains.length === 1 && b.mains[0].c === b.cv && b.parent.swaps.length === 0);
  }
  {
    const b = boot({ workerThrows: true });
    t('两种 Worker 都抛错 → 主线程', b.workers.length === 2 && b.mains.length === 1);
  }
  {
    const b = boot({ noBW: true });
    t('boot-water.js 没载进来 → 露出 SVG 猫脸，字照常起跑', !b.cls.has('gl') && b.cls.has('go') && b.workers.length === 0);
  }
  {
    const b = boot({});
    if (fallback(b)) fallback(b).fn();
    t('Worker 一直不报 ready：1.5s 兜底起跑（字不会一直停着），起点也发给 Worker', b.cls.has('go') && b.workers[0].msgs.at(-1)[0].type === 'start');
  }
  {
    const b = boot({ still: true });
    t('减少动态效果：告诉画布只画一帧', b.workers[0].msgs[0][0].still === true);
    b.workers[0].onmessage({ data: 'ready' }); if (b.rafs[0]) b.rafs[0]();
    let done = 0; b.setNow(400); b.win.bootIntroDone(() => done++);
    t('减少动态效果：不用等 2.2s 开场', b.timers.at(-1).ms === 750);
  }

  // ── js/boot-water.js：时间线 + Worker 那头
  const bw = read('js/boot-water.js');
  const g = {};
  vm.createContext(g); g.self = g;
  vm.runInContext(bw, g);
  const TL = g.GCBootWater && g.GCBootWater.timeline;
  t('主线程载入时挂出 GCBootWater', typeof g.GCBootWater === 'function' && typeof TL === 'function');
  if (TL) {
    const s0 = TL(0, null), s3 = TL(0.3, null), s12 = TL(1.2, null), s22 = TL(2.2, null), lv = TL(3, 0.6), lv2 = TL(3, 0.2);
    t('开场：猫脸在水下（位移拉满），一笔还没画', s0.amp === 17 && s0.p.every(x => x === 0), s0);
    t('0.3s：第一笔在画，最后一笔还没开始', s3.p[0] > 0 && s3.p[0] < 1 && s3.p[4] === 0, s3.p);
    t('笔头起步不拖（第一笔开画 0.1s 已经走了一成）', TL(0.15, null).p[0] > 0.08, TL(0.15, null).p);
    t('1.2s：五笔都画完', s12.p.every(x => x === 1), s12.p);
    t('2.2s：浮上来了，位移归零', s22.amp < 0.01 && s22.alpha === 1, s22.amp);
    t('蓝影先出来再淡到 .55', TL(0.5, null).ghost[2] === 0 && TL(1, null).ghost[2] > 0.5 && Math.abs(s22.ghost[2] - 0.55 * 0.55) < 0.01, [TL(1, null).ghost, s22.ghost]);
    t('离场：位移重新起来（沉回去）、猫脸淡掉', lv.amp === 14 && lv.alpha === 0 && lv2.alpha > 0 && lv2.amp > 0 && lv2.amp < 14, [lv, lv2]);
  }

  // 装成 Worker 的全局跑一份源码：self 就是全局本身，而且是 WorkerGlobalScope。glOk = 给一个记账用的假 WebGL
  const asWorker = (code, glOk) => {
    const posted = [], rafs = [], uni = {};
    let now = 0;
    const any = new Proxy({}, { get: (o, k) => k in o ? o[k] : () => any });
    const gl = new Proxy({
      getProgramParameter: () => true,
      getUniformLocation: (p, n) => n,
      uniform1f: (n, v) => { uni[n] = v; },
      uniform1fv: (n, v) => { uni[n] = Array.from(v); },
      getExtension: () => null,
    }, { get: (o, k) => k in o ? o[k] : (typeof k === 'string' && /^[A-Z_]+$/.test(k) ? 1 : () => any) });
    const w = {
      postMessage: m => posted.push(m), requestAnimationFrame: f => rafs.push(f),
      performance: { now: () => now, timeOrigin: 5000 },
      OffscreenCanvas: function (cw, ch) { this.width = cw; this.height = ch; this.getContext = () => any; },
    };
    vm.createContext(w);
    vm.runInContext('function WorkerGlobalScope() {} Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype); var self = globalThis;', w);
    vm.runInContext(code, w);
    const canvas = { width: 0, height: 0, getContext: () => glOk ? gl : null };
    const init = still => w.onmessage({ data: { type: 'init', canvas, d: { w: 800, h: 600, k: 1, rect: [300, 200, 170, 98] }, still: !!still } });
    const tick = ms => { now = ms; const f = rafs.shift(); if (f) f(ms); };
    return { w, posted, rafs, uni, init, tick };
  };
  {
    const k = asWorker(bw, false);
    t('Worker 里不往全局挂 GCBootWater、接 onmessage', typeof k.w.onmessage === 'function' && k.w.GCBootWater === undefined);
    k.init();
    t('拿不到 WebGL 就回 fail（主线程好露出 SVG 猫脸）', k.posted[0] === 'fail');
  }
  t('GCBootWater.src 是整份源码', typeof g.GCBootWater.src === 'string' && g.GCBootWater.src.startsWith('(function bootWater(G)'));
  if (typeof g.GCBootWater.src === 'string') {
    const k = asWorker(g.GCBootWater.src, true);
    t('GCBootWater.src 自己就能当 Worker 跑（Blob 起的就是它）', typeof k.w.onmessage === 'function' && k.w.GCBootWater === undefined);
    k.init();
    k.tick(100);
    t('第一帧报 ready，T 停在 0、一笔都不露（等页面给起点）', k.posted[0] === 'ready' && k.uni.T === 0 && k.uni.P.every(x => x === 0), [k.posted, k.uni.T]);
    k.tick(700);
    t('没给起点之前一直停在第 0 帧（画布可能还没上屏，不能偷跑）', k.uni.T === 0 && k.posted.length === 1);
    k.w.onmessage({ data: { type: 'start', at: 5000 + 700 } });
    k.tick(1000);
    t('给了起点就从那一刻算', Math.abs(k.uni.T - 0.3) < 1e-9 && k.uni.P[0] > 0, [k.uni.T, k.uni.P]);
    k.w.onmessage({ data: { type: 'start', at: 5000 + 900 } });
    k.tick(1100);
    t('起点只认第一次', Math.abs(k.uni.T - 0.4) < 1e-9, k.uni.T);
    // 高刷屏上每个 vsync 都画会把 GPU 吃满，冷启动整窗停帧（exe trace 实测）：离上一帧不到 15ms 就跳过
    k.tick(1106);
    t('最多 60 帧：6ms 后（165Hz 的下一个 vsync）不画', Math.abs(k.uni.T - 0.4) < 1e-9 && k.rafs.length === 1, k.uni.T);
    k.tick(1118);
    t('最多 60 帧：过了 15ms 照常画，时间按真实时钟', Math.abs(k.uni.T - 0.418) < 1e-9, k.uni.T);
  }
  t('猫脸贴图用 CPU 画（GPU 画布的 blur 冷启动要占住 GPU 主线程 145ms，整窗停帧）',
    /getContext\('2d',\s*\{\s*willReadFrequently:\s*true\s*\}\)/.test(bw));
  {
    // 底色在 shader 里算了一份（为了不挂 mix-blend-mode），数字必须跟 boot.css 一致，不然第一帧画布一盖上颜色就跳
    const num = s => +s;
    const cssG = [...css.slice(css.indexOf('#bootSplash {'), css.indexOf('#bootSplash.boot-leave'))
      .matchAll(/radial-gradient\((\d+)vmax (\d+)vmax at (\d+)% (\d+)%, rgba\((\d+),(\d+),(\d+),([\d.]+)\), transparent (\d+)%\)/g)]
      .map(m => ({ r: [num(m[1]), num(m[2])], at: [m[3] / 100, m[4] / 100], rgb: [num(m[5]), num(m[6]), num(m[7])], a: num(m[8]), stop: m[9] / 100 }));
    const glG = [...bw.matchAll(/float a(\d) = ([\d.]+) \* \(1\. - clamp\(length\(\(cp - W \* vec2\(([\d.]+), ([\d.]+)\)\) \/ \(vec2\(([\d.]+), ([\d.]+)\) \* vm\)\) \/ ([\d.]+)/g)]
      .map(m => ({ i: +m[1], a: num(m[2]), at: [num(m[3]), num(m[4])], r: [num(m[5]), num(m[6])], stop: num(m[7]) }));
    const glRgb = i => (bw.match(new RegExp('vec3\\(([\\d.]+), ([\\d.]+), ([\\d.]+)\\) / 255\\., a' + i + '\\)')) || []).slice(1).map(num);
    const ink = (css.match(/--gc-ink:\s*#([0-9a-f]{6})/i) || [])[1];
    const glInk = (bw.match(/mix\(vec3\(([\d.]+), ([\d.]+), ([\d.]+)\) \/ 255\./) || []).slice(1).map(num);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const ok = cssG.length === 2 && glG.length === 2 && cssG.every((c, j) => {
      const s = glG.find(x => x.i === j + 1);
      return s && same(c.r, s.r) && same(c.at, s.at) && c.a === s.a && c.stop === s.stop && same(c.rgb, glRgb(j + 1));
    }) && ink && same([0, 2, 4].map(o => parseInt(ink.substr(o, 2), 16)), glInk);
    t('shader 里的底色跟 boot.css #bootSplash 的两层渐变、--gc-ink 一致', ok, { cssG, glG, rgb: [glRgb(1), glRgb(2)], ink, glInk });
  }
}

console.log('── bootSplashDone 等开场播完 ──');
{
  const src = core.slice(core.indexOf('let _bootSplashGone = false;'), core.indexOf('function authGreeting('));
  const timers = []; let introCb = null, entered = 0;
  const cls = new Set(), el = { classList: { add: c => cls.add(c) }, remove() {} };
  const ctx = {
    document: { getElementById: id => id === 'bootSplash' ? el : null },
    performance: { now: () => 300 },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    authWallEnter: () => { entered++; },
    bootIntroDone: cb => { introCb = cb; },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.bootSplashDone = bootSplashDone;', ctx);
  timers.length = 0;
  ctx.bootSplashDone();
  t('开场还没播完：不收，排给 bootIntroDone，另挂 3s 上限（窗口没显示时 rAF 不跑）', typeof introCb === 'function' && !cls.has('boot-leave') && timers.length === 1 && timers[0].ms === 3000, timers.map(x => x.ms));
  if (introCb) introCb();
  t('开场播完才收', cls.has('boot-leave') && entered === 1);
  timers.shift().fn();
  t('3s 上限后到也不会再收一次', entered === 1);
}

console.log('── 样式 ──');
t('#authModal 的 display 不压 .hidden（不然登录了墙也收不起来）', /#authModal\.auth-wall\.hidden\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(css));
t('启动页点击穿透（不吃开机那一秒的点击 / 浏览器测试的坐标点击）', /#bootSplash\s*\{[^}]*pointer-events:\s*none/.test(css));
t('流光线不用 translateX 居中（bootRise 的 transform:none 会冲掉它）', !/\.boot-line\s*\{[^}]*translateX/.test(css));
t('减少动态效果时动画一笔带过', /prefers-reduced-motion: reduce/.test(css));
t('画布不挂 mix-blend-mode（底色 shader 自己叠；挂了合成器每帧多一张全屏离屏图）', !/#bootWater\s*\{[^}]*mix-blend-mode/.test(css) && !/mix-blend-mode/.test(css.slice(css.indexOf('#bootSplash'), css.indexOf('#authModal.auth-wall'))));
{
  // 开机主线程每秒卡半秒多：启动页上的动画只许动合成器自己推的 opacity / transform。
  // filter: blur 会让整条动画落回主线程（exe 里录到字卡在半模糊 1 秒多），background-position 同理
  const kf = name => (css.match(new RegExp('@keyframes ' + name + '\\s*\\{([^{}]*\\{[^{}]*\\})*[^{}]*\\}')) || [''])[0];
  const used = [...new Set([...css.slice(css.indexOf('#bootSplash'), css.indexOf('#authModal.auth-wall')).matchAll(/animation:\s*([^;]+);/g)]
    .flatMap(m => m[1].split(/,(?![^(]*\))/).map(x => x.trim().split(/\s+/)[0]))
    .filter(n => n !== 'none' && n !== 'gcDraw'))];   // gcDraw 只在 WebGL 起不来、露出 SVG 猫脸时才跑，没得选
  const bad = used.filter(n => { const k = kf(n); return !k || /filter|background|stroke|width|height|top|left|margin/.test(k.replace(/@keyframes\s+\S+/, '')); });
  t('启动页的动画都只动 opacity / transform', used.length >= 4 && bad.length === 0, { used, bad });
  t('离场过渡也不带 filter', !/\.boot-center\s*\{[^}]*transition:[^;]*filter/.test(css) && !/#bootSplash\.boot-leave \.boot-center\s*\{[^}]*filter/.test(css));
  const pause = (css.match(/([^{}]*)\{\s*animation-play-state:\s*paused;?\s*\}/) || ['', ''])[1].split(',').map(s => s.trim());
  t('字等画布起跑（.go）再动', ['.boot-word', '.boot-sub', '.boot-line', '.boot-line::after'].every(s => pause.includes('#bootSplash.gl:not(.go) ' + s)), pause);
  // 用户「减少渲染元素」：冷启动那几秒 GPU 本来就挤，看不出差别的开销全砍
  const lamp = (css.match(/\.boot-lamp\s*\{[^}]*\}/) || [''])[0];
  t('灯不挂 filter、不无限呼吸（渐变本身就是软边，blur 每帧多一张离屏图）', lamp && !/filter/.test(lamp) && !/infinite/.test(lamp), lamp);
  const under = '#bootSplash:not(.boot-leave) ~ #authModal';
  const rule = sel => (css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')) || ['', ''])[1];
  t('启动页盖着时：墙底下的模糊光不画', /display:\s*none/.test(rule(under + ' .auth-bg')));
  t('启动页盖着时：卡片不做毛玻璃', /(^|[^-])backdrop-filter:\s*none/.test(rule(under + ' .auth-card')));
  const pauseAll = (css.match(new RegExp('([^{}]*)\\{\\s*animation-play-state:\\s*paused;?\\s*\\}', 'g')) || []).map(r => r.replace(/\{[^}]*\}/, '')).join(',').split(',').map(s => s.trim());
  t('启动页盖着时：墙里所有动画（连伪元素）停着', [under, under + ' *', under + ' *::before', under + ' *::after'].every(s => pauseAll.includes(s)), pauseAll);
}
{
  // 手机 dpr 2.75~3：画布按 1.5 倍画，不按 2 倍
  const m = html.match(/k:\s*Math\.min\(window\.devicePixelRatio \|\| 1,\s*([\d.]+)\)/);
  t('画布像素倍数上限 1.5（全屏 shader 是启动页最贵的一样）', m && +m[1] === 1.5, m && m[0]);
}
t('眼睛按钮切 SVG，不写 textContent 冲掉图标', /btn\.classList\.contains\('auth-eye'\)\)\s*btn\.classList\.toggle\('is-on'/.test(core));
// 总数在上面「云端恢复」那段异步测试跑完后打印
