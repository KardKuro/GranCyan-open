    // 折叠块（🍼育儿 / 💾记忆 / 📖日记…）的展开收起。
    // 以前是内联 `this.parentElement.classList.toggle('open')`，配合 .think-toggle 的
    // user-select:none —— 结果标题里的正文（育儿 feed 那种一整段都在标题上）根本选不中复制。
    // 现在标题和正文都可选了，于是这里要挡一下：刚拖出选区的那一下不当成点击，
    // 否则选完字块就自己收起来了。
    function _thinkToggle(el) {
        const sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).trim()) return;   // 用户在选字，不是在点开关
        el.parentElement.classList.toggle('open');
        el.parentElement.dataset.userToggled = '1';   // 流式重画时认这个，别把她收起的又弹开（05 的 _patchThinkBlock）
    }

    /* ── 思考链的糊面 ─────────────────────────────────────────────
       思考默认是糊着的：折叠块、标题、展开收起全照旧，但正文和 DeepSeek 的概括
       都盖着高斯模糊，而且选不中、复制不了。技能开关里关掉「思考链上锁」就一直清晰。
       （历史消息里若有 [[THINK_OPEN]] / [[THINK_CLOSE]]，仍按原样切换 state.thinkOpen；
       系统提示里不教这两个标签。清晰时点 🔓 可以调回模糊。）

       ⚠️ 糊的是这层 .think-veil 内包装，不是整个 .think-body。因为 filter
          不能被子元素撤销（父元素上的 filter 会开一个新的渲染上下文，子元素再写
          filter:none 也回不去），而 .think-body 里还躺着「只有小标题」那行说明，
          那句是界面自己讲的话，糊掉她就连「为什么没正文」都读不到了。
       ⚠️ 概括那句话在**标题**上而不在正文里，所以标题那边也得包 —— 漏了的话，
          一句「在犹豫要不要告诉她」等于把整段思考剧透了，糊了正文也白糊。 */
    function thinkVeil(inner) { return `<span class="think-veil">${inner}</span>`; }
    // 锁的图标由 CSS 按 body 上的类换（🔒/🔓），所以 AI 一开一关不用重渲染她整屏消息
    const THINK_LOCK = `<span class="think-lock" onclick="thinkVeilTap(event)" title="思考链"></span>`;

    /* ── 思考链的中/英切换 ────────────────────────────────────────
       英文思考会被电脑上的本地小模型翻成中文，存在消息的 thinkZh 里（原文一个字不动）。
       两份都渲染进 DOM，显示哪份只由 body 上的 think-lang-en 类决定 —— 和锁同一个做法，
       切换不用重渲染整屏。这只是「她这台设备上想看哪种」，放 localStorage，不进 state。
       这个开关只在有译文的思考块上出现。 */
    const THINK_LANG = `<span class="think-lang" onclick="thinkLangTap(event)" title="中文 / 英文原文"></span>`;
    // 还没译文的英文思考（旧消息、当时电脑没开）挂一个「译」，点了才翻 —— 处理在 thinkTransTap（05）
    const THINK_TRANS = `<span class="think-trans" onclick="thinkTransTap(event)" title="翻译成中文（电脑上的本地小模型）"></span>`;
    // 和 server/think-translate.js 的 mostlyChinese 同一判据：本来就是中文想的不给「译」
    function _thinkNeedsTrans(s) { s = String(s || ''); const c = (s.match(/[一-鿿]/g) || []).length, l = (s.match(/[A-Za-z]/g) || []).length; return l > 0 && !(c > 0 && c / (c + l) > 0.3); }
    // 存着的译文是不是其实是本地模型的拒绝（「我无法生成此类内容……」）。判据和 server/think-translate.js 的 looksRefused 同一套；
    // 修之前已经存下来的那些不显示，思考块退回原文 + 「译」，点了会重翻（server 那边拒了会换模型）
    function _thinkTransReal(src, zh) { src = String(src || ''); zh = String(zh || ''); if (!zh) return false; const rz = /(我|抱歉|对不起|很抱歉)[^。\n]{0,20}(无法|不能|不可以|不会)[^。\n]{0,30}(生成|提供|创作|输出|协助|翻译|处理|帮)/, re = /\b(I can(?:not|'t)|I'm (?:sorry|unable|not able)|I am (?:sorry|unable|not able)|I won't)\b[^.\n]{0,60}\b(generate|provide|create|produce|assist|help|translate|write)/i; return !((rz.test(zh) || re.test(zh)) && !re.test(src) && !rz.test(src) && zh.length < Math.max(200, src.length * 0.25)); }
    function applyThinkLang() {
        if (typeof document === 'undefined' || !document.body) return;
        let en = false;
        try { en = localStorage.getItem('grancyanThinkLang') === 'en'; } catch (e) { }
        document.body.classList.toggle('think-lang-en', en);
    }
    function thinkLangTap(ev) {
        if (ev) { ev.stopPropagation(); ev.preventDefault(); }
        const en = !document.body.classList.contains('think-lang-en');
        try { localStorage.setItem('grancyanThinkLang', en ? 'en' : 'zh'); } catch (e) { }
        document.body.classList.toggle('think-lang-en', en);
    }

    /* 这两个类决定清不清晰。默认（body 上什么都没有）＝糊着：JS 还没跑到、
       或者哪天这段挂了，也不会先清晰地闪一下再糊上。要清晰必须有人显式加类。 */
    function applyThinkVeil() {
        if (typeof document === 'undefined' || !document.body) return;
        const off = (typeof skillOn === 'function') ? !skillOn('thinkveil') : false;
        document.body.classList.toggle('think-veil-off', off);
        document.body.classList.toggle('think-seen', !off && !!state.thinkOpen);
    }

    /* who: 'ai'（它自己开/关）| 'user'（她还回去）。
       版本号是**逻辑计数器**不是时间戳 —— 时间戳靠设备时钟，一台机器时钟快一年
       就能长期压住另一台（favGroups 那段注释里记的同一个坑，这次直接照搬）。 */
    function setThinkOpen(on, who) {
        const next = !!on;
        state.thinkOpen = next;
        state.thinkOpenVer = (state.thinkOpenVer || 0) + 1;
        applyThinkVeil();
        if (typeof save === 'function') save();
        return next;
    }

    // 点那把锁。糊着的时候不给她"破解"的入口 —— 要看就去问它，这是它的东西。
    function thinkVeilTap(ev) {
        if (ev) { ev.stopPropagation(); ev.preventDefault(); }
        if (state.thinkOpen) {
            setThinkOpen(false, 'user');
            if (typeof showToast === 'function') showToast('思考还回去了 🔒', 'info');
        } else if (typeof showToast === 'function') {
            showToast('思考是糊着的 🔒 想看就到 技能开关 → 思考链上锁 把它关掉', 'info', 3000);
        }
    }

    // 后端服务器地址（本地 Claude / 表情包 / GIF 搜索 / 文档解析 / 手环数据 使用）
    // 通过浏览器访问 server.js 时自动使用当前地址；在手机 App (WebView) 中可于设置里填写电脑的局域网 IP
    const SERVER_BASE = (localStorage.getItem('grancyanServerBase') || '').replace(/\/+$/, '')
        || ((location.protocol.startsWith('http') && location.host !== 'grancyan.app')
            ? location.origin : 'http://localhost:3000');

    // ── 手机配对码 ─────────────────────────────────────────────
    // 电脑 server 只信本机；别的设备（手机 APK、手机浏览器、tailnet 上的机器）连 /api 要带配对码，
    // 不然局域网里谁拿 curl 都能让本地 Claude在电脑上跑命令（判据见 origin-guard.js makePairGate）。
    // 码存在本源的 localStorage，设置里「配对码」那一栏填。电脑上本机访问用不着，永远是空的。
    let PAIR_TOKEN = (() => { try { return localStorage.getItem('grancyanPairToken') || ''; } catch (_) { return ''; } })();
    function setPairToken(t) {
        PAIR_TOKEN = String(t || '').toUpperCase().replace(/[\s-]/g, '');
        try { PAIR_TOKEN ? localStorage.setItem('grancyanPairToken', PAIR_TOKEN) : localStorage.removeItem('grancyanPairToken'); } catch (_) { }
    }
    const _serverOrigin = (() => { try { return new URL(SERVER_BASE, location.href).origin; } catch (_) { return ''; } })();
    function _toServer(url) {
        try { return !!_serverOrigin && new URL(url, location.href).origin === _serverOrigin; } catch (_) { return false; }
    }
    // 给 <img>/<audio>/整页跳转这种加不了头的地址补 ?gct=。同源（手机浏览器直接开电脑地址）不用补——
    // 服务端见过一次带码的请求就种了 cookie。**只在拼 src 的那一刻补，别存进消息**：码会跟着对话进云端。
    function gcTok(url) {
        if (!PAIR_TOKEN || !url || !_toServer(url)) return url;
        try { if (new URL(url, location.href).origin === location.origin) return url; } catch (_) { return url; }
        if (/[?&]gct=/.test(url)) return url;
        return url + (url.includes('?') ? '&' : '?') + 'gct=' + encodeURIComponent(PAIR_TOKEN);
    }
    // 所有打到电脑 server 的 fetch 自动带上 X-GC-Token。九十几处 fetch 散在二十个文件里，
    // 一处处改必漏一处，漏的那处在手机上就是静默 401。
    let _pairNagAt = 0;
    if (typeof window !== 'undefined' && typeof window.fetch === 'function' && !window.fetch._gcPair) {
        const _rawFetch = window.fetch.bind(window);
        const wrapped = async function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
            if (!_toServer(url)) return _rawFetch(input, init);
            if (PAIR_TOKEN) {
                if (typeof input === 'string' || input instanceof URL) {
                    const h = new Headers((init && init.headers) || undefined);
                    if (!h.has('X-GC-Token')) h.set('X-GC-Token', PAIR_TOKEN);
                    init = Object.assign({}, init, { headers: h });
                } else {
                    input = new Request(input, init);
                    if (!input.headers.has('X-GC-Token')) input.headers.set('X-GC-Token', PAIR_TOKEN);
                    init = undefined;
                }
            }
            const r = await _rawFetch(input, init);
            if (r.status === 401 && Date.now() - _pairNagAt > 20000 && typeof showToast === 'function') {
                const pair = await r.clone().json().then(j => j && j.pair, () => false);
                if (pair) {
                    _pairNagAt = Date.now();
                    showToast(PAIR_TOKEN ? '🔑 配对码不对 —— 电脑上 设置 里能看到正确的，填到这边设置的「配对码」'
                        : '🔑 电脑要配对码才让连 —— 电脑上 设置 里能看到，填到这边设置的「配对码」', 'error', 6000);
                }
            }
            return r;
        };
        wrapped._gcPair = true;
        window.fetch = wrapped;
    }
    // 伴读书架入口：手机 App 里若配了电脑服务器地址，直接走电脑端完整书架（深色、可导入 epub）；
    // 没配则退回 App 内嵌的离线书架（MainActivity 会把 /reading 拦到 localhost:8080）
    // 把模型配置推给电脑 server 存下来：书架的聊天/批注/摘要都是服务端发起的，
    // 服务端得自己能调模型；而手机上书架和主程序不同源，读不到这边的 state.configs。
    // 推过去之后书架的下拉框里就能选任意模型（本地 Claude 还能选具体模型号）。
    async function pushReadingModels() {
        try {
            const configs = (typeof state !== 'undefined' && state.configs) || [];
            if (!configs.length) return;
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 2500);   // 服务器没开就别卡着进书架
            await fetch(SERVER_BASE + '/api/reading/models', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs }), signal: ctrl.signal,
            });
            clearTimeout(t);
        } catch (e) { /* 推不上去不影响看书，书架会退回本地 Claude */ }
    }

    // 电脑 server 还活着吗？（GET /api/reading/models 永远 200，拿来当探针正好）
    // 手机进书架是整页跳转：地址不可达时 WebView 会对着死 IP 干等 TCP 超时（几十秒白屏，
    // 整个 App 都没了），所以必须先探活、且用 AbortController 把等待压到 2 秒。
    // 局域网 IP 是会变的（换路由器、DHCP 重新分配），这条路踩过一次。
    async function serverAlive() {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 2000);
            const r = await fetch(SERVER_BASE + '/api/reading/models', { signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(t);
            return r.ok;
        } catch (e) { return false; }
    }

    // 重点色跟着 URL 走：手机上主程序是 grancyan.app、书架是电脑 server 的 IP，两个源，
    // IndexedDB 隔离 → 书架读不到 kuro_accent 只能用默认靛蓝。把颜色挂在 ?acc= 上带过去，
    // 书架落进它自己那个源的 localStorage，之后翻章节都还在。
    async function openReading() {
        const acc = (typeof state !== 'undefined' && state.accentColor) || '';
        const q = /^#[0-9a-fA-F]{6}$/.test(acc) ? '?acc=' + encodeURIComponent(acc) : '';

        // 手机 App + 配了电脑地址：连得上才跳电脑端完整书架，连不上就退回内置离线书架
        if (location.host === 'grancyan.app' && localStorage.getItem('grancyanServerBase')) {
            showToast('正在连接电脑书架…', 'info', 1800);
            if (!await serverAlive()) {
                showToast('连不上 ' + SERVER_BASE + '，已打开离线书架（去设置里改服务器地址）', 'error', 4200);
                window.location.href = '/reading' + q;   // MainActivity 拦到内置 localhost:8080
                return;
            }
            await pushReadingModels();
            window.location.href = gcTok(SERVER_BASE + '/reading' + q);   // 整页跳过去带不了头，带码一次服务端种 cookie
            return;
        }

        await pushReadingModels();
        window.location.href = '/reading' + q;
    }
    function setServerBase(v) {
        v = (v || '').trim().replace(/\/+$/, '');
        if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
        if (v) localStorage.setItem('grancyanServerBase', v);
        else localStorage.removeItem('grancyanServerBase');
        location.reload();
    }

    // 设置里「配对码」那一栏：电脑上（本机）显示手机该填的码；手机上填码并当场试连一次
    async function renderPairSettings() {
        const inp = document.getElementById('pairTokenInput');
        const info = document.getElementById('pairTokenInfo');
        if (!inp || !info) return;
        inp.value = PAIR_TOKEN;
        info.textContent = '';
        try {
            const r = await fetch(SERVER_BASE + '/api/pair-token', { cache: 'no-store' });
            if (r.ok) {
                const j = await r.json();
                inp.closest('.field-group').style.display = 'none';   // 本机用不着自己填
                info.innerHTML = '手机配对码：<b style="font-family:monospace;font-size:14px;letter-spacing:1px">' + escHtml(j.token || '') + '</b>'
                    + '　<a href="#" onclick="rotatePairToken();return false" style="opacity:.7">换一个</a>'
                    + '<br>手机（或别的电脑）连这台 server 要在它的设置里填这串。换了之后旧的立刻失效。';
                return;
            }
        } catch (_) { }
        inp.closest('.field-group').style.display = '';
        let ok = false;
        try { ok = (await fetch(SERVER_BASE + '/api/pair-check', { cache: 'no-store' })).ok; } catch (_) { }
        info.textContent = ok ? '✓ 已经连上电脑了' : (PAIR_TOKEN ? '✗ 连不上：配对码不对，或电脑没开' : '电脑设置里能看到配对码，填在上面');
    }
    async function setPairTokenUI(v) {
        setPairToken(v);
        await renderPairSettings();
    }
    async function rotatePairToken() {
        try {
            const r = await fetch(SERVER_BASE + '/api/pair-token/rotate', { method: 'POST' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            showToast('🔑 换好了，手机要重新填新的配对码', 'info', 3500);
        } catch (e) { showToast('换配对码失败：' + e.message, 'error'); }
        renderPairSettings();
    }

    // 初始化 Supabase（云同步是可选的）
    // 项目地址和 anon key 来自 js/00-config.js 的 GRANCYAN_CONFIG。两项都填了才启用云同步；
    // 留空 = 纯本机模式：checkUser 直接放行不弹登录墙，所有云端调用落到 cloudDisabledClient 这个空壳上安静失败。
    const _GC_CFG = (typeof GRANCYAN_CONFIG === 'object' && GRANCYAN_CONFIG) || {};
    const SUPABASE_URL = String(_GC_CFG.supabaseUrl || '').trim().replace(/\/+$/, '');
    const SUPABASE_ANON_KEY = String(_GC_CFG.supabaseAnonKey || '').trim();
    const CLOUD_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
    const supabaseClient = CLOUD_ENABLED ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : cloudDisabledClient();

    // 没配云同步时顶替 supabaseClient 的空壳：接口形状和 supabase-js 一致，
    // 会话永远为空、写入永远返回 error，链式查询（from().select().eq()…）await 出 { data: null, error }。
    function cloudDisabledClient() {
        const error = { message: '云同步未配置（见 js/00-config.js）', status: 0 };
        const done = { data: null, error };
        const q = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? (ok) => ok(done) : q), apply: () => q });
        const fail = async () => done;
        return {
            auth: {
                getSession: async () => ({ data: { session: null }, error: null }),
                getUser: async () => ({ data: { user: null }, error }),
                signInWithPassword: fail, signUp: fail, updateUser: fail,
                signOut: async () => ({ error: null }),
                admin: { deleteUser: fail },
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            },
            from: () => q,
            rpc: () => q,
            storage: { from: () => q },
        };
    }

    // --- 云端同步核心逻辑 ---
    let currentUser = null;

    // ── 启动页 / 登录墙进场 ──
    // 登录墙在 index.html 里默认立着，checkUser() 却要等存档读完、界面画完才跑（14-boot-brain-hub.js），
    // 已登录的人每次开机都被登录框晃几秒。所以开机先盖 #bootSplash，登录一有结论（三条路都算）就收起来。
    // 墙的 hidden 一个字不动 —— 那几条盯 .hidden 的浏览器测试和 measure-idle-cost 照旧成立。
    let _bootSplashGone = false;
    function bootSplashDone() {
        if (_bootSplashGone) return;
        _bootSplashGone = true;
        const el = document.getElementById('bootSplash');
        let left = false;
        const leave = () => {
            if (left) return;
            left = true;
            authWallEnter();
            if (!el) return;
            el.classList.add('boot-leave');   // index.html 里那段看到它就通知画布（js/boot-water.js）：光纹涨一下、猫脸沉回水里
            setTimeout(() => el.remove(), 800);
        };
        // 等开场（猫脸画完、从水里浮上来）播完再收，不然开机一快，波纹刚冒头就被收走。
        // 开场时钟是 index.html 那段 rAF 推的，窗口没显示时 rAF 不跑，所以再兜一个 3s 上限
        if (typeof bootIntroDone === 'function') {
            bootIntroDone(leave);
            setTimeout(leave, 3000);
        } else {
            setTimeout(leave, Math.max(0, 1150 - performance.now()));   // 那段脚本没跑起来：至少等猫脸画完
        }
    }
    // 开机链卡死的兜底（IDB 打不开、某个渲染抛了）：最差也就回到原来「登录墙立着」的样子，
    // 不能让人对着一张永远在转的启动页
    setTimeout(bootSplashDone, 15000);

    function authGreeting(d = new Date()) {
        const h = d.getHours();
        if (h < 5)  return '夜深了，灯还给你留着';
        if (h < 9)  return '早安，今天也慢慢来';
        if (h < 12) return '上午好，今天想做点什么';
        if (h < 14) return '中午好，记得吃饭';
        if (h < 18) return '下午好，歇一会儿也没关系';
        return '晚上好，欢迎回来';
    }

    // 墙露出来的那一刻才播进场（启动页收起时、被踢回登录时）。
    // 用 data-enter 不用 class：initStars 的 MutationObserver 盯的是 class，在它的回调里改 class 会自己触发自己
    let _authCardFx = false;
    function authWallEnter() {
        const m = document.getElementById('authModal');
        if (!m || m.classList.contains('hidden') || !_bootSplashGone) return;
        const g = document.getElementById('authGreet');
        if (g) g.textContent = authGreeting();
        const dt = document.getElementById('authDate');
        if (dt) dt.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        m.removeAttribute('data-enter');
        void m.offsetWidth;   // 强制回流，动画才会从头再播
        m.setAttribute('data-enter', '');
        const card = document.getElementById('authCard');
        if (card && !_authCardFx) {
            _authCardFx = true;
            card.addEventListener('pointermove', (e) => {
                const r = card.getBoundingClientRect();
                card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
                card.style.setProperty('--my', (e.clientY - r.top) + 'px');
            });
        }
    }

    // 1. 检查登录状态
    // getSession() 只读本地缓存的会话（不走网络），登录 UI 瞬间恢复；
    // 之后后台再用 getUser() 向 Supabase 确认会话仍有效（被吊销/过期才踢回登录框）
    async function checkUser() {
       try {
            const nameEl = document.getElementById('footerUserName');
            if (nameEl && !state.userName) nameEl.textContent = '检查登录中…';
            if (!CLOUD_ENABLED) {
                // 没配云同步（js/00-config.js 留空）：纯本机模式，登录墙不出现
                _authChecked = true;
                _authCheckFailed = false;
                document.getElementById('authModal').classList.add('hidden');
                bootSplashDone();
                renderUserName();
                if (typeof renderLocalStickers === 'function' && _stickerTab !== 'search') renderLocalStickers();
                return;
            }
            const { data: { session } } = await supabaseClient.auth.getSession();
            // 登录状态在这一行就有结论了。别等到函数末尾才置 —— 下面还有个 await loadFromCloud()，
            // 云端对话慢的时候能拖几十秒，那段时间里 banner 会被「还在查登录」压住，
            // 真掉登录也不吭声（见 _authChecked / _cloudStickerBanner）。
            _authChecked = true;
            _authCheckFailed = false;
            const user = session?.user;
            if (user) {
                currentUser = user;
                stopCloudWatch();   // 登进来了就不用再盯；恢复横条也收掉
                document.getElementById('cloudBackBar')?.remove();
                document.getElementById('authModal').classList.add('hidden');
                bootSplashDone();   // 必须在 loadFromCloud 之前：云端对话能拖几十秒，别让启动页陪着等
                renderUserName();
                updateAccountInfo(); // 更新账号信息显示
                // 后台校验会话真实有效性，不阻塞界面
                supabaseClient.auth.getUser().then(({ data, error }) => {
                    /* getUser 出错不 throw，是把 error 放在返回值里 —— 光看 data.user 为空，
                       「Supabase 整个被限流」和「会话被吊销」长得一模一样。
                       2026-10-11 免费额度超了（exceed_egress_quota），就是从这里把已登录的用户踹回了登录墙，
                       而墙上没有出口，连本机数据都进不去。服务挂了 ≠ 没登录。 */
                    if (!data?.user && authServiceDown(error)) {
                        showToast('⚠️ 云端服务暂时不可用，先按离线用；本机数据没动', 'warning', 6000);
                        watchCloudRecovery(true);
                        return;
                    }
                    if (!data?.user) {
                        currentUser = null;
                        _authChecked = true;
                        renderUserName();
                        document.getElementById('authModal').classList.remove('hidden');
                        // 会话被吊销 = 云端收藏这一路也断了。之前只清 currentUser 就完事，
                        // 收藏栏还挂着上一轮 ok 的状态和已经加载出来的云端表情，
                        // 直到下次碰巧重跑 loadStickers 才露馅。重拉一遍，把状态刷成 logged-out。
                        loadStickers().then(() => { if (_stickerTab !== 'search') renderLocalStickers(); });
                    }
                }).catch(() => {}); // 网络抖动不当作掉线
                // 登录后重新加载表情包（此时才能拉到云端 stickers 桶）。
                // 必须排在 loadFromCloud 前面：它俩没有依赖关系，而云端对话能卡几十秒甚至抛错——
                // 排在后面的话，这段时间收藏栏一直挂着启动轮那份 logged-out 状态（她已经登录了却被告知没登录），
                // loadFromCloud 一抛异常更是永远轮不到这句。并发交叠有 _stickerLoadGen 兜着，不怕。
                loadStickers();
                // 云端对话拉不动 ≠ 没登录。不单独接住的话它会掉进下面那个 catch，
                // 把已经登录好的人一脚踹回登录框（表情都拉回来了，界面还在要求重新登录）。
                await loadFromCloud().catch(e => console.error('[云端同步] 拉取失败:', e?.message || e));
            } else {
                renderUserName();
                document.getElementById('authModal').classList.remove('hidden');
                bootSplashDone();
                // 确认没登录 = 刚刚解除了「还在查登录」那道压制。启动那轮早把状态记成 logged-out 了，
                // 但收藏栏此刻画的还是被压制时的样子（一句「还没有收藏的表情」）。
                // 不在这儿补一次重绘，真警告就被这道压制永久吃掉了。
                if (typeof renderLocalStickers === 'function' && _stickerTab !== 'search') renderLocalStickers();
            }
        } catch (err) {
            console.error('检查登录状态失败:', err.message);
            // 「查不出来」不是「确认没登录」。标出来，让收藏栏说实话（见 _authCheckFailed），
            // 顺便补一次重绘 —— 否则收藏栏停在被压制时那一帧，什么都不说。
            // _authChecked 必须在重绘**之前**置：它在 finally 里才置的话，下面这次重绘
            // 还处在「登录检查未完成」的压制里，画出来照样是空的（测试 [10d] 逮到过）。
            _authCheckFailed = true;
            _authChecked = true;
            renderUserName();
            // 这里**不**弹登录墙。authModal 在 index.html 里没挂 hidden，是默认铺满全屏、
            // 没有关闭按钮的硬墙 —— 查不出来就把它留着，等于对一个可能正登录着的人说
            // 「你没登录，重新登录去」，还顺手把她锁在自己的本地数据外面（连下面这条子都被盖住）。
            // 未知就按未知处理：放她进去用，把话说清楚，重试和去登录都在收藏栏那条子上给她。
            document.getElementById('authModal').classList.add('hidden');
            bootSplashDone();
            if (typeof showToast === 'function') {
                showToast('⚠️ 没查出登录状态（多半是网络），先按离线用；云端数据没动', 'warning', 6000);
            }
            if (typeof renderLocalStickers === 'function' && _stickerTab !== 'search') renderLocalStickers();
        } finally {
            // 登录检查有结论了，从这一刻起「没登录」才是真的没登录（见 _authChecked）
            _authChecked = true;
        }
    }

    // 2. 登录/注册处理
    // 👁 显示/隐藏密码的眼睛功能
    function togglePasswordVisibility(inputId, btnId) {
        const input = document.getElementById(inputId);
        const btn = document.getElementById(btnId);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        // 登录墙的眼睛是两枚 SVG，切 is-on 换图；写 textContent 会把 SVG 整个冲掉
        if (btn.classList.contains('auth-eye')) btn.classList.toggle('is-on', show);
        else btn.textContent = show ? '－' : '👁';
    }

// 点「注册」时显示确认密码框，点「登录」时隐藏
    async function handleAuth(type) {
        // 清除旧错误
        document.getElementById('authError').classList.remove('is-ok');
        document.getElementById('authErrorIcon').style.display = 'none';
        document.getElementById('authErrorText').innerText = '';

        // 注册时显示确认密码框，登录时隐藏
        const confirmWrap = document.getElementById('confirmPwdWrap');
        if (type === 'signup') {
            confirmWrap.style.display = 'block';
        } else {
            confirmWrap.style.display = 'none';
        }

        const loginBtn = document.querySelector('button[onclick="handleAuth(\'login\')"]');
        const signupBtn = document.querySelector('button[onclick="handleAuth(\'signup\')"]');
        loginBtn.disabled = true;
        signupBtn.disabled = true;
        loginBtn.style.opacity = '0.5';
        signupBtn.style.opacity = '0.5';

        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value;
        const errorIcon = document.getElementById('authErrorIcon');
        const errorText = document.getElementById('authErrorText');

        // 格式检查
            if (!email.includes('@')) {
            errorIcon.style.display = 'inline'; errorIcon.textContent = '📧';
            errorText.innerText = '请输入有效的邮箱地址';
            loginBtn.disabled = false; signupBtn.disabled = false;
            loginBtn.style.opacity = '1'; signupBtn.style.opacity = '1';
            return;
        }
        if (password.length < 6) {
            errorIcon.style.display = 'inline'; errorIcon.textContent = '🔐';
            errorText.innerText = '密码至少需要 6 位';
            loginBtn.disabled = false; signupBtn.disabled = false;
            loginBtn.style.opacity = '1'; signupBtn.style.opacity = '1';
            return;
        }

        // 注册时：检查两次密码是否一致
        if (type === 'signup') {
            const passwordConfirm = document.getElementById('authPasswordConfirm').value;
            if (password !== passwordConfirm) {
                errorIcon.style.display = 'inline'; errorIcon.textContent = '❌';
                errorText.innerText = '两次密码不一致，请重新输入';
                loginBtn.disabled = false; signupBtn.disabled = false;
                loginBtn.style.opacity = '1'; signupBtn.style.opacity = '1';
                return;
            }
        }

        const { data, error } = type === 'login'
            ? await supabaseClient.auth.signInWithPassword({ email, password })
            : await supabaseClient.auth.signUp({ email, password });

        loginBtn.disabled = false; signupBtn.disabled = false;
        loginBtn.style.opacity = '1'; signupBtn.style.opacity = '1';

        if (error) {
        // 把 Supabase 英文错误翻译成中文
            let msg = error.message;
            if (msg.includes('Invalid login credentials')) msg = '密码错误，或邮箱未注册';
            if (msg.includes('Email not confirmed')) msg = '邮箱尚未验证，请先去邮箱点确认链接';
            if (msg.includes('User already registered')) msg = '该邮箱已注册，请直接登录';
            if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) msg = '网络连接失败：无法访问云端服务器，请检查网络后重试';
            if (/restricted/i.test(msg)) msg = '云端服务（Supabase）这个月的免费流量用完了，被暂停 —— 不是密码的问题';
            errorIcon.style.display = 'inline'; errorIcon.textContent = '🔐';
            errorText.innerText = msg;
            // 云端那头挂了：开始盯它什么时候回来（「先用本机数据」现在一直在墙上，不用这里露）
            if (authServiceDown(error)) watchCloudRecovery(true);
        } else {
            if (type === 'signup') {
                alert('注册成功！请去邮箱查收确认邮件后再登录。');
                document.getElementById('authEmail').value = '';
                document.getElementById('authPassword').value = '';
                document.getElementById('authPasswordConfirm').value = '';
                confirmWrap.style.display = 'none';
            } else {
                checkUser();
            }
        }
    }

    /* 这个错是「云端那头出事了」（限流/超额/网络/5xx），还是「你真的没登录」（密码错、会话吊销）。
       分不清的一律算前者：把登录着的人锁在门外，比让没登录的人先看本机数据代价大得多。 */
    function authServiceDown(err) {
        if (!err) return false;
        const m = String(err.message || '');
        if (/restricted|quota|Failed to fetch|NetworkError|Load failed|timed? ?out/i.test(m)) return true;
        const s = Number(err.status) || 0;
        return s === 0 || s === 402 || s === 429 || s >= 500;
    }

    // 登录墙上的「先用本机数据」：只收墙，不碰会话，currentUser 留空 = 云同步全部跳过
    // 用户要它一直在墙底下，不用等登录失败才露出来
    function enterOffline() {
        document.getElementById('authModal').classList.add('hidden');
        bootSplashDone();
        renderUserName();
        showToast('已离线进入：本机数据都在，云端恢复了会叫你登录', 'info', 6000);
        watchCloudRecovery();
    }

    /* 云端恢复探测（用户：「发现云重置了之后弹个通知让我去登录」）。
       敲 /auth/v1/health：好的时候 200、一百来字节；被限流时 402 restricted，跟 auth/REST 同一道闸，
       不碰 profiles.settings 那种 4MB 的大头，几分钟一次烧不了 egress。
       seenDown：只有亲眼见过它挂，后来好了才算「恢复」—— 云端本来就好、她只是自己点了离线，就别报喜。 */
    const CLOUD_PROBE_MS = 3 * 60 * 1000;
    let _cloudWatch = null;
    async function cloudAlive() {
        try {
            const r = await fetch(SUPABASE_URL + '/auth/v1/health', { headers: { apikey: SUPABASE_ANON_KEY }, cache: 'no-store' });
            return r.ok;
        } catch (_) { return false; }   // 402 没带 CORS 头时 fetch 直接抛，也是「还挂着」
    }
    function watchCloudRecovery(seenDown) {
        if (_cloudWatch) { if (seenDown) _cloudWatch.seenDown = true; return; }
        const w = _cloudWatch = { seenDown: !!seenDown, busy: false, last: 0, timer: null };
        const tick = async () => {
            if (_cloudWatch !== w || w.busy || Date.now() - w.last < 20000) return;
            w.busy = true; w.last = Date.now();
            const ok = await cloudAlive();
            w.busy = false;
            if (_cloudWatch !== w) return;
            if (!ok) { w.seenDown = true; return; }
            stopCloudWatch();
            if (w.seenDown) cloudRecovered();
        };
        const onVis = () => { if (document.visibilityState === 'visible') tick(); };
        w.stop = () => { clearInterval(w.timer); window.removeEventListener('online', tick); document.removeEventListener('visibilitychange', onVis); };
        w.timer = setInterval(tick, CLOUD_PROBE_MS);
        window.addEventListener('online', tick);
        document.addEventListener('visibilitychange', onVis);
        tick();
    }
    function stopCloudWatch() {
        if (_cloudWatch) { _cloudWatch.stop(); _cloudWatch = null; }
    }
    function cloudRecovered() {
        const wall = document.getElementById('authModal');
        if (currentUser) {
            // 登录着、只是云端挂过：不用她做什么，把开机那轮没拉成的补上
            showToast('☁️ 云端恢复了，同步接上了', 'success', 6000);
            sysNotify('GranCyan 云端恢复了', '同步已经接上');
            loadFromCloud().catch(e => console.error('[云端同步] 恢复后拉取失败:', e?.message || e));
            return;
        }
        if (wall && !wall.classList.contains('hidden')) {
            // 人就在墙前：把那行红字换成好消息，出口按钮留着
            document.getElementById('authError').classList.add('is-ok');
            document.getElementById('authErrorIcon').style.display = 'inline';
            document.getElementById('authErrorIcon').textContent = '☁️';
            document.getElementById('authErrorText').innerText = '云端恢复了，现在可以登录了';
        } else {
            showCloudBackBar();
        }
        sysNotify('GranCyan 云端恢复了', '点这里回去登录，本机这段时间的东西会合并上去', openLoginWall);
    }
    function openLoginWall() {
        document.getElementById('cloudBackBar')?.remove();
        const wall = document.getElementById('authModal');
        wall.classList.remove('hidden');
        authWallEnter();
        document.getElementById('authEmail')?.focus();
    }
    // 收起来之后她可能好半天才回来看，所以不自己消失（toast 一会儿就没了）
    function showCloudBackBar() {
        if (document.getElementById('cloudBackBar')) return;
        const bar = document.createElement('div');
        bar.id = 'cloudBackBar';
        bar.className = 'cloud-back';
        bar.setAttribute('role', 'status');
        bar.innerHTML = '<span>☁️ 云端恢复了，登录一下把本机这段时间的东西同步上去</span>'
            + '<button type="button" class="cloud-back-go">去登录</button>'
            + '<button type="button" class="cloud-back-x" title="先不">✕</button>';
        bar.querySelector('.cloud-back-go').onclick = openLoginWall;
        bar.querySelector('.cloud-back-x').onclick = () => bar.remove();
        document.body.appendChild(bar);
    }
    // 系统通知：exe 里就是 Windows 通知；安卓 WebView 没有 Notification，只剩页面里那条
    function sysNotify(title, body, onClick) {
        try {
            if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
            const fire = () => {
                const n = new Notification(title, { body, icon: './img/logo.png', tag: 'grancyan-cloud' });
                n.onclick = () => { try { window.focus(); } catch (_) {} if (onClick) onClick(); n.close(); };
            };
            if (Notification.permission === 'granted') fire();
            else Notification.requestPermission().then(p => { if (p === 'granted') fire(); }).catch(() => {});
        } catch (_) {}
    }

    function cloudError(message, status, cause) {
        const e = new Error(message || '云同步失败');
        if (status) e.status = Number(status);
        if (cause && cause.code) e.code = cause.code;
        return e;
    }

    function cloudErrorMessage(body, fallback) {
        return body && (body.message || body.error_description || body.error || body.msg) || fallback;
    }

    function isRetryableCloudError(error) {
        const status = Number(error && (error.status || error.statusCode));
        if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
        const code = String(error && error.code || '');
        if (/^(AbortError|ECONN|ETIMEDOUT|UND_ERR)/i.test(code)) return true;
        return /Failed to fetch|NetworkError|Load failed|network|timeout|超时|aborted/i.test(String(error && error.message || error || ''));
    }

    async function cloudResponseError(response, fallback) {
        let body = null;
        try { body = await response.json(); } catch {}
        return cloudError(cloudErrorMessage(body, fallback + ` (HTTP ${response.status})`), response.status, body);
    }

    /* 设置那一行 2026-10-11 量出来 4.25MB。以前每次 save 推之前、每次开点歌面板都整包下载一遍，
       一天 310 次 ≈ 1.3GB，把 Supabase 免费档 5GB/月的出口流量吃爆，整个项目被停（exceed_egress_quota）。
       现在先只问一句 updated_at（几十字节）：跟上次见过的一样 = 云端没人动过，直接用内存里那份；
       对不上（另一台推过）、没缓存、问不到，才整包拉。自己推成功后把推上去的那份记下来，
       下一次 save 就不用把自己刚推的东西再下载回来。
       updated_at 只有 pushCloudSettings 在写（客户端 new Date()，表上没有 trigger），按毫秒比是否相等，不比先后，所以不怕时钟偏。

       2026-10-14 第二轮（10-13 一天又 401MB，整包 253 次、问时间的只有 ~95 次）：
       · 「另一台推过」以前就整包 4MB。现在推的时候在 settings 里带一张 _ver（顶层键 → 内容指纹），
         问时间那一下顺便把 _ver 也问回来（几百字节），对不上的键才拉：select=k0:settings->favMessages,…
         另一台只改了 musicRecent，这边就只下载 musicRecent。
       · 缓存存进 IndexedDB（kuro_cloud_cache）：整页刷新 / 手机 App 被系统回收重开，不再从零整包拉。
       · 合并完跟云端一模一样就不推：不推就不动 updated_at，另一台也就不用拉。
       · 中转没回话改走直连时，不再把缓存清空（以前清空 = 下一次必整包）：旧缓存仍是云端某一刻的真快照，
         按 _ver 比就知道哪些键变了；推的那份记在 _cloudPendingPush，问时间对上了就直接认它。
       ⚠️ 以后谁要写 profiles.settings，必须走 pushCloudSettings（它负责重算 _ver 并把 _ver._at 对上 updated_at）。
          绕过它写的，_ver._at 对不上 updated_at，这边会认出来退回整包，不会拿旧东西当新的。 */
    let _cloudSettingsCache = null;   // { uid, at: 毫秒, ver: {键: 指纹, _at}|null, settings（不带 _ver）}
    let _cloudPendingPush = null;     // 中转那次没回话、改走直连时推的那份（同上结构）
    let _cloudProxyDownUntil = 0;     // 中转根本连不上（不是 HTTP 报错）→ 这段时间直接走直连，别每次先等 15 秒
    const CLOUD_CACHE_IDB_KEY = 'kuro_cloud_cache';
    const CLOUD_MEMO_IDB_KEY = 'kuro_cloud_vermemo';
    /* 这几个是「一袋东西」，合并规则都是「按某个认人的键，同一条本机为准，云端独有的才接到后面」
       （mergeMemoryLists 按正文、mergeFavLists 按 chatId/nodeId、_mergeProust 按 id）。
       所以对收的那台来说，云端这一袋里**只有「多了哪几条」**会改变它的东西；同一条的其它字段、排列顺序都收不进去。
       指纹就只算「认人的键」的集合 —— 跟合并规则看到的一模一样。不这样的话两台会永远互推，每次 1~2MB：
         · 记忆收件箱（AI 散步带回来的记忆）电脑和手机各吸收一遍，同一条正文两边 id / createdAt 不一样（10-14 真浏览器里看到的）；
         · 高级记忆每轮 AI 回复都给检索到的几条盖新的 lastAccess；
         · 两台各自往后接，顺序天生不一样。
       ⚠️ 改了上面三个合并函数的认人规则，这里要跟着改。 */
    const _cloudMemKey = m => String((m && m.text) || '').trim().toLowerCase();
    const CLOUD_BAG_KEYS = {
        memories: _cloudMemKey,
        brainMemories: _cloudMemKey,
        favMessages: f => (f && f.chatId != null && f.nodeId != null) ? f.chatId + '/' + f.nodeId : '',
        proustMems: m => (m && m.id) ? String(m.id) : '',
    };
    const CLOUD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
    // 诊断：控制台敲 __cloudStats 看这一页开着以来各走了几次（bytes 是下载的字符数，约等于字节）
    const cloudStats = { probe: 0, hit: 0, partial: 0, partialKeys: 0, full: 0, push: 0, skip: 0, bytes: 0 };
    if (typeof window !== 'undefined') window.__cloudStats = cloudStats;
    function _cloudLog(kind, extra) {
        try { console.info('[云同步] ' + kind, extra || '', JSON.stringify(cloudStats)); } catch (_) {}
    }

    function _cloudAt(v) {
        const t = v == null ? NaN : new Date(v).getTime();
        return Number.isFinite(t) ? t : null;
    }
    // 跟 JSON 同规则（undefined/函数丢掉），但对象的键排好序：云端 jsonb 会把键重排，排过序两边才认得是同一份
    function _cloudCanon(v) {
        if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s; }
        if (typeof v.toJSON === 'function') return _cloudCanon(v.toJSON());
        if (Array.isArray(v)) return '[' + v.map(_cloudCanon).join(',') + ']';
        const ks = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
        return '{' + ks.map(k => JSON.stringify(k) + ':' + _cloudCanon(v[k])).join(',') + '}';
    }
    function _cloudHash(s) {   // 两路 32 位混合 + 长度，撞车概率可以忽略
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < s.length; i++) {
            const ch = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(36) + '.' + (h1 >>> 0).toString(36) + '.' + s.length.toString(36);
    }
    // 一袋东西的指纹：认人的键去重排序后算（认不出人的条目合并时本来就不收，不算）
    function _cloudBagHash(arr, keyOf) {
        const ids = new Set();
        for (const it of arr) { const k = keyOf(it); if (k) ids.add(k); }
        return 'b' + _cloudHash(JSON.stringify([...ids].sort()));
    }
    // 一袋东西「本机这份内容」的指纹，只用来判断要不要推（见 pushCloudSettings）：
    // 认人的键之外，同一条的字段改了（收藏换分组、普鲁斯特的 modelIds…）也得推上去，云端那份是新设备 / 本机丢档时的备份。
    // lastAccess / accessCount 不算：高级记忆每轮检索都会盖新的，算进去就等于聊一句推一次
    function _cloudBagContentHash(v) {
        return _cloudHash(JSON.stringify(v, (k, x) => (k === 'lastAccess' || k === 'accessCount') ? undefined : x));
    }
    // 排序版的序列化比原生 JSON.stringify 慢得多（4MB 一整行要一两百毫秒到一秒，手机上更久）。
    // 记一下「原生 JSON 的指纹 → 算出来的指纹」：原生 JSON 一字不差 = 结果一样，只有真变了的键才重算。
    // 这张表跟着缓存落进 IndexedDB（kuro_cloud_vermemo），App 重开后第一次同步也不用全量重算
    let _cloudVerMemo = new Map();      // 键 → { bag, raw: 原生 JSON 指纹, h: _ver 用的指纹, ch: 袋子内容指纹 }
    let _cloudPushedBag = null;         // { uid, bags: {键: 内容指纹} }：本机上一次推上去的袋子内容
    function _cloudVerOf(settings, at, bagOut) {
        const ver = {};
        for (const k of Object.keys(settings || {})) {
            const v = settings[k];
            if (k === '_ver' || v === undefined || typeof v === 'function') continue;
            const bag = Object.prototype.hasOwnProperty.call(CLOUD_BAG_KEYS, k) && Array.isArray(v);
            const json = JSON.stringify(v);
            let m = _cloudVerMemo.get(k);
            const raw = json.length > 4000 ? _cloudHash(json) : null;
            if (!(m && raw && m.bag === bag && m.raw === raw)) {
                m = { bag, raw, h: bag ? _cloudBagHash(v, CLOUD_BAG_KEYS[k]) : _cloudHash(_cloudCanon(v)), ch: bag ? _cloudBagContentHash(v) : '' };
                if (raw) _cloudVerMemo.set(k, m); else _cloudVerMemo.delete(k);
            }
            ver[k] = m.h;
            if (bag && bagOut) bagOut[k] = m.ch;
        }
        if (at != null) ver._at = at;
        return ver;
    }
    // 云端那张 _ver 能不能信：得是这次 updated_at 那一刻写的（_at 对得上），不然就是有人绕过 pushCloudSettings 写过
    function _cloudVerOk(ver, at) {
        return !!ver && typeof ver === 'object' && !Array.isArray(ver) && at !== null && ver._at === at;
    }
    function _cloudVerSame(a, b) {
        if (!a || !b) return false;
        const ka = Object.keys(a).filter(k => k !== '_at'), kb = Object.keys(b).filter(k => k !== '_at');
        return ka.length === kb.length && ka.every(k => a[k] === b[k]);
    }
    let _cloudCacheTimer = null, _cloudCacheLoaded = false;
    function _cloudCacheSet(c) {
        _cloudSettingsCache = c;
        if (typeof idbSet !== 'function') return;
        clearTimeout(_cloudCacheTimer);
        _cloudCacheTimer = setTimeout(_cloudCacheFlush, 2000);
    }
    async function _cloudCacheFlush() {
        clearTimeout(_cloudCacheTimer); _cloudCacheTimer = null;
        if (typeof idbSet !== 'function') return;
        try {
            await idbSet(CLOUD_CACHE_IDB_KEY, _cloudSettingsCache);
            await idbSet(CLOUD_MEMO_IDB_KEY, { memo: [..._cloudVerMemo], pushed: _cloudPushedBag });
        } catch (e) { console.warn('[云同步] 缓存没存进本机:', e && e.message); }
    }
    // 只在这一页第一次用到时从 IndexedDB 读一次。读到的是云端某一刻的真快照，问一下时间 / _ver 就知道还准不准
    async function _cloudCacheLoad(uid) {
        if (_cloudCacheLoaded || typeof idbGet !== 'function') return;
        _cloudCacheLoaded = true;
        try {
            const c = await idbGet(CLOUD_CACHE_IDB_KEY);
            if (!_cloudSettingsCache && c && c.uid === uid && Number.isFinite(c.at) && c.settings && typeof c.settings === 'object') {
                _cloudSettingsCache = { uid: c.uid, at: c.at, ver: _cloudVerOk(c.ver, c.at) ? c.ver : null, settings: c.settings };
            }
            const mm = await idbGet(CLOUD_MEMO_IDB_KEY);
            if (mm && Array.isArray(mm.memo) && !_cloudVerMemo.size) _cloudVerMemo = new Map(mm.memo);
            if (mm && mm.pushed && mm.pushed.uid === uid && !_cloudPushedBag) _cloudPushedBag = mm.pushed;
        } catch (e) { console.warn('[云同步] 读本机缓存失败:', e && e.message); }
    }
    // row 是云端那一行（settings 里可能带 _ver），或者自己推上去的那份
    function _rememberCloudSettings(uid, row) {
        const at = _cloudAt(row && row.updated_at);
        const s = row && row.settings;
        if (!(uid && at !== null && s && typeof s === 'object')) { _cloudCacheSet(null); return null; }
        const settings = JSON.parse(JSON.stringify(s));
        let ver = settings._ver;
        delete settings._ver;
        if (!_cloudVerOk(ver, at)) ver = null;
        _cloudCacheSet({ uid, at, ver, settings });
        return _cloudSettingsCache;
    }
    // 给调用方一份拷贝：调用方会在拿到的对象上合并，别把缓存改脏了
    function _cloudResult(c, updated_at) {
        return { data: { settings: JSON.parse(JSON.stringify(c.settings)), updated_at, ver: c.ver }, error: null };
    }

    // 设置(profiles)读写：中转优先。只有网络故障、限流或 5xx 才直连兜底；
    // 4xx 是同一请求的永久错误，再直连一次只会重复失败并刷屏。
    async function fetchCloudSettings() {
        const session = (await supabaseClient.auth.getSession()).data.session;
        if (!session) return { data: null, error: { message: '未登录' } };
        const uid = session.user && session.user.id;
        if (!_cloudSettingsCache) await _cloudCacheLoad(uid);
        const c = _cloudSettingsCache;
        if (c && c.uid === uid) {
            cloudStats.probe++;
            // 绝大多数时候云端没人动过：只问时间（几十字节）。对不上了才去要 _ver（几 KB）
            const probe = await _fetchCloudProfile(session, 'updated_at');
            // 断网 / 超时 / 5xx：整包那一下也一样拉不到，别再白等一轮，交给外面的 cloudRetry
            if (probe.error && isRetryableCloudError(probe.error)) return probe;
            const p = !probe.error && probe.data;
            if (p) {
                // 很老的 server 不认 ?select=，整包回来了 —— 那就直接当整包用，别再拉第二遍
                if (p.settings !== undefined) {
                    cloudStats.full++;
                    const nc = _rememberCloudSettings(uid, p);
                    _cloudLog('整包（老 server 不认 select）');
                    return nc ? _cloudResult(nc, p.updated_at) : probe;
                }
                const at = _cloudAt(p.updated_at);
                if (at !== null && at === c.at) { cloudStats.hit++; return _cloudResult(c, p.updated_at); }
                // 上次中转没回话、改走直连推的那份：时间对上了 = 其实推上去了，直接认它，不用再下载自己推的东西
                const pend = _cloudPendingPush;
                if (pend && pend.uid === uid && at !== null && at === pend.at) {
                    _cloudPendingPush = null;
                    if (pend.pushedBag) _cloudPushedBag = pend.pushedBag;
                    const pc = { uid: pend.uid, at: pend.at, ver: pend.ver, settings: pend.settings };
                    _cloudCacheSet(pc);
                    cloudStats.hit++;
                    return _cloudResult(pc, p.updated_at);
                }
                // 另一台推过：要来云端的 _ver，只拉变了的键。
                // select=updated_at 是给 10-11 那版 server 看的（它只认白名单、照样只回时间 → 下面认出来走整包，跟以前一样）；
                // 新 server 认 cols。_ver 不可信（老前端推的，没有 / _at 对不上）也走整包
                if (at !== null && c.ver) {
                    const vr = await _fetchCloudProfile(session, 'updated_at', 'updated_at,ver:settings->_ver');
                    if (vr.error && isRetryableCloudError(vr.error)) return vr;
                    const v = !vr.error && vr.data;
                    if (v && 'ver' in v) {
                        const vat = _cloudAt(v.updated_at);
                        if (vat !== null && vat === c.at) { cloudStats.hit++; return _cloudResult(c, v.updated_at); }
                        if (_cloudVerOk(v.ver, vat)) {
                            const part = await _fetchCloudChanged(session, uid, c, v.ver, v.updated_at, 0);
                            if (part) return part;
                        }
                    }
                }
            }
            // 时间对不上又没法按键拉 / 行没了 / 问不到 → 老老实实整包拉
        }
        cloudStats.full++;
        const full = await _fetchCloudProfile(session, 'settings,updated_at', null, true);
        if (!full.error) {
            const nc = _rememberCloudSettings(uid, full.data);
            _cloudLog('整包', c ? '（有缓存但对不上）' : '（没缓存）');
            if (nc) return _cloudResult(nc, full.data.updated_at);
            if (full.data && full.data.settings) delete full.data.settings._ver;
        }
        else if (full.error.code === 'PGRST116') _cloudCacheSet(null);   // 行被删了（注销）
        return full;
    }

    // 只拉 _ver 对不上的那几个键。拿不准（键名怪、太多、server 不认、快照对不齐）就返回 null，外面整包兜底
    async function _fetchCloudChanged(session, uid, c, ver, updated_at, depth) {
        const changed = Object.keys(ver).filter(k => k !== '_at' && ver[k] !== c.ver[k]);
        const gone = Object.keys(c.ver).some(k => k !== '_at' && !(k in ver));
        if (!changed.length) {
            // 内容一样只是时间变了（另一台推了份一模一样的）：一个字节都不用拉
            const at = _cloudAt(updated_at);
            const settings = Object.assign({}, c.settings);   // 浅拷就够：缓存里的值谁都不改，交给调用方的是 _cloudResult 深拷的那份
            if (gone) for (const k of Object.keys(settings)) if (!(k in ver)) delete settings[k];
            const nc = { uid, at, ver, settings };
            _cloudCacheSet(nc);
            cloudStats.hit++;
            return _cloudResult(nc, updated_at);
        }
        if (changed.length > 40 || !changed.every(k => CLOUD_KEY_RE.test(k))) return null;
        const cols = ['updated_at'].concat(changed.map((k, i) => 'k' + i + ':settings->' + k)).join(',');
        const r = await _fetchCloudProfile(session, 'updated_at', cols, true);
        if (r.error) return isRetryableCloudError(r.error) ? r : null;
        const row = r.data;
        if (!row || !('k0' in row)) return null;   // 老 server 不认 cols，只回了时间
        const at = _cloudAt(row.updated_at);
        // 拿 _ver 和拿键是两个请求：中间又有人推过（时间变了）就对不上号 → 按新的 _ver 再来一次，还不行就整包
        if (at === null || at !== _cloudAt(updated_at)) {
            if (depth >= 1) return null;
            const vr = await _fetchCloudProfile(session, 'updated_at', 'updated_at,ver:settings->_ver');
            const v = !vr.error && vr.data;
            if (!v || !_cloudVerOk(v.ver, _cloudAt(v.updated_at))) return null;
            return _fetchCloudChanged(session, uid, c, v.ver, v.updated_at, depth + 1);
        }
        const settings = Object.assign({}, c.settings);   // 浅拷（同上）
        for (const k of Object.keys(settings)) if (!(k in ver)) delete settings[k];
        // changed 里的键都在 _ver 里 = 云端那一刻确实有这个键（值可以就是 null）
        changed.forEach((k, i) => { settings[k] = row['k' + i] === undefined ? null : row['k' + i]; });
        const nc = { uid, at, ver, settings };
        _cloudCacheSet(nc);
        cloudStats.partial++;
        cloudStats.partialKeys += changed.length;
        _cloudLog('按键拉', changed.join(','));
        return _cloudResult(nc, row.updated_at);
    }

    // 只有「根本连不上中转」才先直连一阵（fetch 的网络错是 TypeError）。
    // 超时（AbortError）不算：那多半是中转慢，server 那头还在接着下 / 推，这时候改直连等于同一份再来一遍
    function _cloudProxyUnreachable(e) {
        return !!e && !e.status && e.name !== 'AbortError' && /Failed to fetch|NetworkError|Load failed|ERR_|network/i.test(String(e.message || e));
    }

    // legacySel：老 server 白名单认得的 select；cols：新 server 认的完整列（直连也用它）。
    // big：要下载的是正文（整包 / 按键），超时放宽 —— 15 秒一到前端就扔了，中转那头其实还在接着下载，
    // 前端再直连拉一遍 = 同一份算两次流量，手机直连还会被 cloudRetry 再拉两遍
    async function _fetchCloudProfile(session, legacySel, cols, big) {
        cols = cols || legacySel;
        let proxyError = null;
        if (Date.now() >= _cloudProxyDownUntil) {
            try {
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), big ? 35000 : 15000);
                let r;
                try {
                    const q = 'select=' + encodeURIComponent(legacySel) + (cols !== legacySel ? '&cols=' + encodeURIComponent(cols) : '');
                    r = await fetch(SERVER_BASE + '/api/cloud-profile?' + q, {
                        headers: { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_ANON_KEY },
                        signal: ctl.signal
                    });
                    if (r.ok) {
                        const text = await r.text();
                        cloudStats.bytes += text.length;
                        const rows = JSON.parse(text);
                        return { data: (Array.isArray(rows) ? rows[0] : null) || null, error: null };
                    }
                } finally { clearTimeout(t); }
                proxyError = await cloudResponseError(r, '读取云端设置失败');
                if (!isRetryableCloudError(proxyError)) return { data: null, error: proxyError };
            } catch (e) {
                proxyError = e;
                if (_cloudProxyUnreachable(e)) _cloudProxyDownUntil = Date.now() + 60000;   // 根本没连上中转（不在家 / 电脑关了）
            }
        }
        const ms = big ? 90000 : 15000;
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        let timer;
        try {
            let q = supabaseClient.from('profiles').select(cols);
            if (ctl && typeof q.abortSignal === 'function') q = q.abortSignal(ctl.signal);   // 超时就真的掐掉，别让它在后台接着下载
            const res = await Promise.race([
                q.single(),
                new Promise(res => { timer = setTimeout(() => { if (ctl) ctl.abort(); res({ data: null, error: cloudError('直连超时 (' + ms / 1000 + 's)', 408, proxyError) }); }, ms); })
            ]);
            if (res && res.data) { try { cloudStats.bytes += JSON.stringify(res.data).length; } catch (_) {} }
            return res;
        } finally { clearTimeout(timer); }
    }

    // opts.baseVer：这次合并时依据的云端那份的 _ver。合并完跟它一模一样 = 没有要推的，直接不推
    // （不推就不动 updated_at，另一台下次问时间对得上，什么都不用下载）。返回 { skipped: true } 表示没推
    async function pushCloudSettings(row, opts) {
        const session = (await supabaseClient.auth.getSession()).data.session;
        if (!session) throw new Error('未登录');
        const uid = session.user && session.user.id;
        row = stripNullBytes(row);   // 洗掉云端不收的字符（见 stripNullBytes）；中转和直连两条路都用洗过的这份
        const at = _cloudAt(row.updated_at);
        const bags = {};
        const ver = _cloudVerOf(row.settings, at, bags);
        // 袋子按「认人的键」比是给另一台看的；本机这份袋子的内容要跟上次自己推的一样才算没变（同一条改了字段也得推）
        const bagsSame = !!(_cloudPushedBag && _cloudPushedBag.uid === uid)
            && Object.keys(bags).every(k => _cloudPushedBag.bags[k] === bags[k]);
        if (opts && opts.baseVer && _cloudVerSame(opts.baseVer, ver) && bagsSame) {
            cloudStats.skip++;
            _cloudLog('没变，不推');
            return { skipped: true };
        }
        const pushedBag = { uid, bags };
        row.settings = Object.assign({}, row.settings, { _ver: ver });
        cloudStats.push++;
        let proxyError = null;
        if (Date.now() >= _cloudProxyDownUntil) {
            try {
                const ctl = new AbortController();
                // 4MB 走中转：server 那头 30 秒超时会自己回 502。前端别先 15 秒扔掉 —— 扔了 server 照样推上去，
                // 前端再直连推一遍（手机直连 4MB 要推好几分钟），还把缓存搞没了
                const t = setTimeout(() => ctl.abort(), 45000);
                let r;
                try {
                    r = await fetch(SERVER_BASE + '/api/cloud-profile', {
                        method: 'POST',
                        headers: { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
                        body: JSON.stringify(row),
                        signal: ctl.signal
                    });
                } finally { clearTimeout(t); }
                if (r.ok) { _cloudPendingPush = null; _cloudPushedBag = pushedBag; _rememberCloudSettings(uid, row); return; }
                proxyError = await cloudResponseError(r, '写入云端设置失败');
                if (!isRetryableCloudError(proxyError)) throw proxyError;
            } catch (e) {
                if (!isRetryableCloudError(e)) throw e;
                proxyError = e;
                if (_cloudProxyUnreachable(e)) _cloudProxyDownUntil = Date.now() + 60000;
            }
        }
        // 走到直连说明中转那次没成（也可能上游其实写进去了只是回包丢了）。
        // 以前这里把缓存清空 = 下一次必整包 4MB。现在缓存留着（它仍是云端某一刻的真快照，按 _ver 比就知道哪些键变了），
        // 推的这份另记一笔：下次问时间要是正好是这一刻，就说明其实推上去了，直接认它
        const mine = JSON.parse(JSON.stringify(row.settings));
        delete mine._ver;
        _cloudPendingPush = (uid && at !== null) ? { uid, at, ver, settings: mine, pushedBag } : null;
        // 同步现在是串行的：这一下要是永远挂着，后面所有同步都得排在它后面。手机直连推 4MB 慢归慢，3 分钟总该有个结果
        const uctl = typeof AbortController === 'function' ? new AbortController() : null;
        const utimer = uctl ? setTimeout(() => uctl.abort(), 180000) : null;
        let error;
        try {
            let q = supabaseClient.from('profiles').upsert(row);
            if (uctl && q && typeof q.abortSignal === 'function') q = q.abortSignal(uctl.signal);
            ({ error } = await q);
        } catch (e) { error = e; }
        finally { clearTimeout(utimer); }
        if (error) throw cloudError(error.message || '直连写入失败', error.status || error.statusCode || (error.name === 'AbortError' ? 408 : 0), error);
        _cloudPendingPush = null;
        _cloudPushedBag = pushedBag;
        _rememberCloudSettings(uid, row);
    }

    // 记忆条目合并：本地优先，云端独有且不在回收站里的补回来。
    // settings 是整包 upsert（最后写入者赢），以前另一台设备随手一存就会把
    // 这边 AI 刚写入的记忆/高级记忆整包冲掉 —— 看起来就像"AI 没真的写入"。
    function mergeMemoryLists(local, cloud) {
        const out = [...(local || [])];
        const seen = new Set(out.map(m => (m.text || '').trim().toLowerCase()).filter(Boolean));
        // 回收站当墓碑。按时间认：删了之后（另一台上）又记下 / 恢复的照收
        const trashed = _memGoneMerge(null);
        for (const cm of (cloud || [])) {
            const k = (cm.text || '').trim().toLowerCase();
            if (k && !seen.has(k) && _memAlive(cm, trashed)) { out.push(cm); seen.add(k); }
        }
        return out;
    }

    // 收藏合并：和记忆同一个坑。这里以前是整包替换（state.favMessages = s.favMessages || …），
    // 而 settings 是整包 upsert「最后写入者赢」——另一台设备（或本机上次还没推送成功时）
    // 存一次设置，就把这边刚点的收藏整包冲掉，下次推送再把"冲掉"固化到云端。
    // 用户看到的就是：收藏一条没删，过阵子自己没了。
    // 本地回收站正好当墓碑：手动删掉的收藏不会被云端复活。
    function mergeFavLists(local, cloud) {
        const key = _favKey;
        const out = [...(local || [])];
        const seen = new Set(out.map(key).filter(Boolean));
        // 回收站当墓碑。按时间认：墓碑之后又收藏 / 从回收站恢复的（另一台上）照收
        const trashed = _favGoneMerge(null);
        for (const cf of (cloud || [])) {
            const k = key(cf);
            if (k && !seen.has(k) && _favAlive(cf, trashed)) { out.push(cf); seen.add(k); }
        }
        return out;
    }
    function _favKey(f) { return (f && f.chatId != null && f.nodeId != null) ? f.chatId + '/' + f.nodeId : ''; }
    const _favTrashKey = t => (t && t.type === 'fav' && t.favData) ? _favKey(t.favData) : '';
    const _memTrashKey = t => (t && t.memoryData) ? _cloudMemKey(t.memoryData) : '';
    /* 墓碑 favGone {chatId/nodeId: 删掉的时刻} / memGone {记忆正文: 删掉的时刻}：本机回收站 ∪ 云端那张，跟着设置上云（2026-10-14）。
       以前删收藏 / 删记忆（她手删，或 AI 的 [[BRAIN_DEL]]）只在删的那台生效：另一台还留着那条，同步时又推回云端；
       删的那台合并时被回收站挡掉、再推一份没有它的……两台为这一键（收藏 1.7MB / 高级记忆 0.9MB）每次同步互推一次。
       现在删掉的会传到另一台。墓碑之后又收藏 / 又记下 / 从回收站恢复的不算（按时间比，恢复时盖 restoredAt）。
       云端那张里一年前的墓碑清掉，免得越攒越多；本机回收站里的照旧一直挡着（跟以前一样）。 */
    function _trashGone(cloudGone, trashKey) {
        const out = {};
        const cutoff = Date.now() - 365 * 86400000;
        if (cloudGone && typeof cloudGone === 'object') for (const k of Object.keys(cloudGone)) if (Number(cloudGone[k]) >= cutoff) out[k] = Number(cloudGone[k]);
        for (const t of (state.trash || [])) {
            const k = trashKey(t), at = Date.parse(t && t.deletedAt) || 0;   // 进回收站的各处都写 deletedAt
            if (k && at > (out[k] || 0)) out[k] = at;
        }
        return out;
    }
    const _favGoneMerge = cloudGone => _trashGone(cloudGone, _favTrashKey);
    const _memGoneMerge = cloudGone => _trashGone(cloudGone, _memTrashKey);
    // 不在墓碑里，或者比墓碑新（墓碑之后又收藏 / 又记下 / 恢复的）
    function _goneAlive(item, gone, keyOf) {
        const at = gone[keyOf(item)];
        if (!at) return true;
        return Math.max(Number(item && item.time) || 0, Number(item && item.createdAt) || 0, Number(item && item.restoredAt) || 0) > at;
    }
    const _favAlive = (f, gone) => _goneAlive(f, gone, _favKey);
    const _memAlive = (m, gone) => _goneAlive(m, gone, _cloudMemKey);

    // 3. 将设置同步到云端 (替换原来的 save 函数一部分)
    // 同一时刻只跑一轮。以前每次 save 3 秒后各起一轮、互不等：上一轮还在推（手机直连推 4MB 能推好几分钟），
    // 下一轮又拉一遍、又推一遍，叠罗汉。现在中途又要同步的记一笔，这轮完了再跑一轮（用那时候最新的 state）
    let _settingsSyncRun = null, _settingsSyncAgain = false;
    async function syncSettingsToCloud() {
        if (!currentUser) return;
        if (_settingsSyncRun) { _settingsSyncAgain = true; return _settingsSyncRun; }
        _settingsSyncRun = (async () => {
            try {
                let err = null;
                do {
                    _settingsSyncAgain = false;
                    // 总闸 10 分钟：哪一环要是永远挂着（getSession 被锁住之类），别让后面的同步永远排着
                    let cap;
                    try {
                        await Promise.race([
                            _syncSettingsOnce(),
                            new Promise((_, rej) => { cap = setTimeout(() => rej(cloudError('设置同步 10 分钟没结束，先放掉', 408)), 600000); })
                        ]);
                        err = null;
                    } catch (e) { err = e; }
                    finally { clearTimeout(cap); }
                } while (_settingsSyncAgain && currentUser);
                if (err) throw err;
            } finally { _settingsSyncRun = null; }
        })();
        return _settingsSyncRun;
    }
    async function _syncSettingsOnce() {
        if (!currentUser) return;
        const settings = {
            // base64 本地图片不上云（体积太大会截断连接），只同步 URL
            background: state.background?.startsWith('data:') ? '' : state.background,
            callBg: state.callBg?.startsWith('data:') ? '' : state.callBg,
            callBgMask: state.callBgMask,
            callBgBlur: state.callBgBlur,
            brightness: state.brightness,
            accentColor: state.accentColor,
            themeTemperature: state.themeTemperature,
            customBg: state.customBg || '',
            customText: state.customText || '',
            echoOpacity: state.echoOpacity ?? 1,
            fontPreset: state.fontPreset,
            uiShape: state.uiShape,
            bgAutoTint: !!state.bgAutoTint,
            bgLegibility: state.bgLegibility || 'auto',
            aiFontSize: state.aiFontSize,
            userFontSize: state.userFontSize,
            webSearchApiKey: state.webSearchApiKey,
            webSearchProvider: state.webSearchProvider,
            tenorApiKey: state.tenorApiKey,
            thinkSumKey: state.thinkSumKey,
            voiceApiKey: state.voiceApiKey,
            voiceProvider: state.voiceProvider,
            voiceApiBase: state.voiceApiBase,
            voiceModel: state.voiceModel,
            bgBlur: state.bgBlur,
            uiBlur: state.uiBlur,
            configs: state.configs,
            // 跟着 configs 一起上云，另一台设备靠它判断「谁改得晚」。
            // 漏了这一行 = 云端永远 ver 0，合并永远偏向本地，跨设备改配置再也传不过去
            configsVer: Math.max(0, state.configsVer | 0),
            memories: state.memories,
            bandAiEnabled: state.bandAiEnabled !== false,
            callDnd: !!state.callDnd,
            ccMemoryEnabled: !!state.ccMemoryEnabled,
            typingRhythmEnabled: state.typingRhythmEnabled !== false,
            typingDraftPeek: !!state.typingDraftPeek,
            showUserAvatar: !!state.showUserAvatar,
            inkStream: state.inkStream !== false,
            inkRate: +state.inkRate || 14,
            // 用户头像已压成 128px JPEG（几 KB），体积够小，直接进云端设置多设备同步；
            // 万一异常大（>80KB）就不上云，避免整包 upsert 截断连接
            userAvatar: (state.userAvatar && state.userAvatar.length < 80000) ? state.userAvatar : '',
            favMessages: state.favMessages || [],
            favGroups: state.favGroups || [],
            favGroupsVer: state.favGroupsVer || 0,
            favGroupOps: state.favGroupOps || {},
            userName: state.userName || '',
            userNameAiVisible: state.userNameAiVisible !== false,
            stickerNotes: state.stickerNotes || {},
            stickerAiOff: state.stickerAiOff || {},
            stickerGroups: state.stickerGroups || [],
            stickerGroupOf: state.stickerGroupOf || {},
            stickerGroupsVer: state.stickerGroupsVer || 0,
            stickerGroupOps: state.stickerGroupOps || {},
            brainMemories: state.brainMemories || [],
            proustMems: state.proustMems || [],
            vitalsOn: state.vitalsOn !== false,
            vitalsByModel: typeof vitalsForCloud === 'function'
                ? vitalsForCloud(state.vitalsByModel)
                : (state.vitalsByModel || {}),
            // 作息设置跨设备一致：server 那张「夜里别吵她」的表是哪台同步得晚就用哪台的，
            // 两台不一致的话它会在两份作息之间来回跳
            vitalsSleepPref: state.vitalsSleepPref || null,
            ttsVoice: state.ttsVoice || 'zh-CN-XiaoxiaoNeural',
            ttsVoiceZh: state.ttsVoiceZh || 'zh-CN-XiaoxiaoNeural',
            ttsRate: state.ttsRate || 0,
            ttsPitch: state.ttsPitch || 0,
            // 对话墓碑：不上云的话，另一台设备会把它本地那份原样推回云端，
            // 这台再同步就又看见了 —— 删除只在执行删除的那台生效，等于没删
            deletedChats: state.deletedChats || {},
            modelDiaries: state.modelDiaries || {},
            diaryHandover: state.diaryHandover || {},
            diaryEnabled: !!state.diaryEnabled,
            diaryDevView: !!state.diaryDevView,
            // 小本子：两台各记各的，推之前同样跟云端按 id 并集（71-wishbook.js 的 wishMerge）
            wishbook: state.wishbook || [],
            // 思考链那把锁。它在另一台设备上答应了她，这台也该能看（她的原话是
            // 「同意之后看所有的思考」）；反过来撤回也要能传过去。
            thinkOpen: !!state.thinkOpen,
            thinkOpenVer: state.thinkOpenVer || 0,
            // 世界书：下面推之前会跟云端按条合并（wbMerge），这里先放本地那份
            worldbook: state.worldbook || null,
            // 猫爪日报：下面推之前跟云端按条合并（momentsMerge），这里先放本地那份
            moments: state.moments || [],
            // 梦境陈列室：同上，推之前跟云端按 id 合并（dreamsMerge）
            dreamsByModel: state.dreamsByModel || {},
            // 单词卡：同上，推之前跟云端按词合并（studyCardsMerge），墓碑和词书进度一起带
            studyCards: state.studyCards || [],
            studyGone: state.studyGone || {},
            studyBook: state.studyBook || null
        };
        await cloudRetry(async () => {
            // 整包 upsert 是"最后写入者赢"：本地没存过 Key 的设备会把云端刚存的 Key 清空。
            // 所以 Key 类字段先和云端合并——本地为空就保留云端的，顺便回填到本地 state
            const { data: existing, error: readErr } = await fetchCloudSettings();
            // 读不到云端就绝不能写：拿着空 Key 整包 upsert 会把别的设备刚存的 Key 清掉
            if (readErr && readErr.code !== 'PGRST116') {
                throw cloudError('读取云端设置失败，跳过本次同步: ' + readErr.message,
                    readErr.status || readErr.statusCode, readErr);
            }
            const cloud = existing?.settings || {};
            for (const k of ['webSearchApiKey', 'tenorApiKey', 'thinkSumKey', 'voiceApiKey', 'voiceApiBase', 'voiceModel', 'userAvatar']) {
                if (!settings[k] && cloud[k]) {
                    settings[k] = cloud[k];
                    state[k] = cloud[k];
                }
            }
            /* 模型配置：推送前也要比一次 ver，否则合并只有一半。
               启动时拉到的是那一刻的云端，这台开着的几小时里另一台改了配置，
               本机一 save 就会拿自己较旧的那份整包 upsert 上去 —— 云端在两个版本之间
               来回抖，谁也压不住谁。在这里比一次，云端更新就先收进本地再推，
               ver 取 max 保证推上去的永远是两边里较新的那份。 */
            {
                const _cv = Number(cloud.configsVer) || 0;
                const _sv = Number(settings.configsVer) || 0;
                const _cloudOk = Array.isArray(cloud.configs) && cloud.configs.length;
                let _next = null, _nextVer = Math.max(_sv, _cv);
                if (_cloudOk && _cv > _sv) {
                    _next = cloud.configs;                       // 云端更新，直接收
                } else if (_cloudOk && _cv === _sv && _cv >= 0
                           && _cfgCanon(cloud.configs) !== _cfgCanon(settings.configs || [])) {
                    /* 平局且内容不同 —— 两台各从同一版改了一次。谁也不严格大于谁，
                       原来这里是「各自保留本地」，结果双方永远看不见对方那次改动。
                       走对称合并（规则和取舍见 02-state.js 的 _mergeConfigs），
                       并把 ver 抬一级：两台算出来的内容和 ver 都一样，下一轮就判等收敛。 */
                    _next = _mergeConfigs(settings.configs, cloud.configs);
                    _nextVer = _cv + 1;
                }
                if (_next) {
                    settings.configs = state.configs = _next;
                    settings.configsVer = state.configsVer = _nextVer;
                    /* 基线必须跟着换（否则下次写盘把这份「不是我改的」误判成「我改的」→ ver 虚涨），
                       而且要真的落盘 —— 只改内存的话下次启动从 IDB 读回旧值，症状原样复现。
                       这两件事捆在 _persistConfigs 里，别在这儿拆开做。 */
                    if (typeof _persistConfigs === 'function') _persistConfigs();
                    // 换了模型清单就得重画，不然右上角胶囊和会话栏还挂着旧的那套
                    if (typeof renderModelPills === 'function') renderModelPills();
                    if (typeof renderConvSettingsBar === 'function') renderConvSettingsBar();
                    if (typeof renderConfigs === 'function') renderConfigs();
                } else {
                    settings.configsVer = state.configsVer = _nextVer;
                }
            }
            /* 点歌的收藏 / 最近播放 / 搜索记录 / 歌单：按条合并（带墓碑）再推，
               规则见 24-music.js 的 musicSyncMerge。合并有变化时顺手落本地盘，
               不然本机下次启动从 IDB 读回的还是合并前那份。 */
            if (typeof musicSyncApply === 'function') {
                const _ms = musicSyncApply(cloud);
                Object.assign(settings, _ms.payload);
                if (_ms.changed) {
                    if (typeof save === 'function') save();
                    if (typeof musicRefresh === 'function') musicRefresh();
                }
            }
            // 记忆按条目合并再推送，防止整包覆盖丢掉另一台设备刚写入的条目
            // 另一台删掉的（memGone 墓碑）这台也拿掉，见 _trashGone
            const _memGone = _memGoneMerge(cloud.memGone);
            settings.memories = mergeMemoryLists(settings.memories, cloud.memories).filter(m => _memAlive(m, _memGone));
            settings.brainMemories = mergeMemoryLists(settings.brainMemories, cloud.brainMemories).filter(m => _memAlive(m, _memGone));
            settings.memGone = _memGone;
            state.memories = settings.memories;
            state.brainMemories = settings.brainMemories;
            // 收藏也按条合并（规则同启动时那次，见 mergeFavLists）。以前这里直接推本机那份：
            // 两台各收藏了不同的几条，云端就在两份之间来回翻，另一台每翻一次都得重新下载 1.7MB 的收藏
            {
                const _favN = (state.favMessages || []).length;
                const _gone = _favGoneMerge(cloud.favGone);
                settings.favMessages = mergeFavLists(settings.favMessages, cloud.favMessages).filter(f => _favAlive(f, _gone));
                settings.favGone = _gone;
                state.favMessages = settings.favMessages;
                if (state.favMessages.length !== _favN && typeof updateFavBadge === 'function') updateFavBadge();
            }
            // 普鲁斯特池：id 是内容哈希，按 id 合并（两台设备各自写下的瞬间都留着）
            settings.proustMems = _mergeProust(settings.proustMems, cloud.proustMems);
            state.proustMems = settings.proustMems;
            // 生命体征：按模型 id 合并，保留更新较晚的一份身体状态。
            if (typeof _mergeVitals === 'function') {
                settings.vitalsByModel = _mergeVitals(settings.vitalsByModel, cloud.vitalsByModel);
                state.vitalsByModel = settings.vitalsByModel;
            }
            if (typeof _vitalsSleepPrefNewer === 'function') {
                settings.vitalsSleepPref = state.vitalsSleepPref = _vitalsSleepPrefNewer(settings.vitalsSleepPref, cloud.vitalsSleepPref);
            }
            // 表情备注同理：本设备没有的备注不能被整包 upsert 清掉（本地优先合并）
            settings.stickerNotes = Object.assign({}, cloud.stickerNotes || {}, settings.stickerNotes || {});
            state.stickerNotes = settings.stickerNotes;
            // 「不给 AI 用」是开关，要能关回去 —— 不能跟备注一样本地优先，理由见 _mergeStickerAiOff
            settings.stickerAiOff = state.stickerAiOff = _mergeStickerAiOff(cloud.stickerAiOff, settings.stickerAiOff);
            // 分组：逐条比时间戳，删除靠墓碑传播（整包合并会让删掉的分组从另一台复活）
            settings.stickerGroupOf = _mergeStickerGroupOf(cloud.stickerGroupOf, settings.stickerGroupOf);
            state.stickerGroupOf = settings.stickerGroupOf;
            {
                const m = _mergeStickerGroupState(
                    { groups: settings.stickerGroups, ops: settings.stickerGroupOps, ver: settings.stickerGroupsVer },
                    { groups: cloud.stickerGroups, ops: cloud.stickerGroupOps, ver: cloud.stickerGroupsVer });
                settings.stickerGroups = state.stickerGroups = m.groups;
                settings.stickerGroupOps = state.stickerGroupOps = m.ops;
                settings.stickerGroupsVer = state.stickerGroupsVer = m.ver;
            }
            {
                const t = _mergeThinkOpen(settings.thinkOpen, settings.thinkOpenVer,
                                          cloud.thinkOpen, cloud.thinkOpenVer);
                settings.thinkOpen = state.thinkOpen = t.on;
                settings.thinkOpenVer = state.thinkOpenVer = t.ver;
                if (typeof applyThinkVeil === 'function') applyThinkVeil();
            }
            /* 对话墓碑并集合并：两台设备各自删掉的都算数。
               ⚠️ 必须在 upsert **之前**合进 settings，不然这台的整包 upsert
                  会把另一台刚记下的删除冲掉 —— 那些对话就又活过来了。 */
            if (typeof mergeTombstones === 'function') {
                settings.deletedChats = mergeTombstones(settings.deletedChats, cloud.deletedChats);
                state.deletedChats = settings.deletedChats;
                /* ⚠️ 合并**之后**立刻 prune，否则 TTL 永远不生效：
                   本机清掉的过期墓碑，下一次并集合并又被云端那份原样加回来。
                   在这里清，清完的结果才会随这次 upsert 推上去，两边一起变干净。
                   （Codex 审出来的 —— 我原来只在本地 prune，白清。） */
                if (typeof pruneTombstones === 'function') {
                    pruneTombstones();
                    settings.deletedChats = state.deletedChats;
                }
            }
            // 模型日记按条目并集合并（两台设备各自写下的页都留着），别被整包 upsert 冲掉
            if (typeof _mergeDiaries === 'function') {
                settings.modelDiaries = _mergeDiaries(settings.modelDiaries, cloud.modelDiaries);
                state.modelDiaries = settings.modelDiaries;
            }
            // 交钥匙托管状态：按时间戳 max 合并（单调不回退，别把已还的钥匙又交出去）
            if (typeof _mergeHandover === 'function') {
                settings.diaryHandover = _mergeHandover(settings.diaryHandover, cloud.diaryHandover);
                state.diaryHandover = settings.diaryHandover;
            }
            // 世界书：按条合并（同 id 取 ver 大的，删除靠墓碑），规则见 60-worldbook.js 的 wbMerge。
            // 合并后跟本地不一样 = 收到了另一台的改动，落一次本地盘，不然下次启动从 IDB 读回的还是旧的
            if (typeof wbMerge === 'function') {
                const _wbBefore = JSON.stringify(wbNorm(state.worldbook));
                settings.worldbook = state.worldbook = wbMerge(state.worldbook, cloud.worldbook);
                if (JSON.stringify(state.worldbook) !== _wbBefore) {
                    if (typeof save === 'function') save();
                    if (typeof worldbookRefresh === 'function') worldbookRefresh();
                }
            }
            /* 猫爪日报：按条并集合并再推（规则见 51-moments.js 的 momentsMerge）。
               ⚠️ 引擎没加载时也得把云端那份原样带上 —— 整包 upsert 漏一个键就等于删掉它，
                  而且本机是空的（存档刚被删光）时，正是要靠云端那份找回来的时候。 */
            if (typeof momentsSyncApply === 'function') {
                momentsSyncApply(cloud.moments);
                settings.moments = state.moments;
            } else if (Array.isArray(cloud.moments) && cloud.moments.length) {
                settings.moments = cloud.moments;
            }
            // 梦境陈列室：按梦的 id 并集合并再推（规则见 31-dreams.js 的 dreamsMerge），引擎没加载时同样带上云端那份
            if (typeof dreamsSyncApply === 'function') {
                dreamsSyncApply(cloud.dreamsByModel);
                settings.dreamsByModel = state.dreamsByModel;
            } else if (cloud.dreamsByModel && typeof cloud.dreamsByModel === 'object') {
                settings.dreamsByModel = cloud.dreamsByModel;
            }
            // 单词卡：按「语言+正面」合并再推（规则见 22-study.js 的 studySyncApply），引擎没加载时同样带上云端那份
            if (typeof studySyncApply === 'function') {
                studySyncApply(cloud.studyCards, cloud.studyGone, cloud.studyBook);
                settings.studyCards = state.studyCards;
                settings.studyGone = state.studyGone;
                settings.studyBook = state.studyBook;
            } else {
                if (Array.isArray(cloud.studyCards)) settings.studyCards = cloud.studyCards;
                if (cloud.studyGone && typeof cloud.studyGone === 'object') settings.studyGone = cloud.studyGone;
                if (cloud.studyBook !== undefined) settings.studyBook = cloud.studyBook;
            }
            if (typeof wishSyncApply === 'function') {
                wishSyncApply(cloud.wishbook);
                settings.wishbook = state.wishbook;
            } else if (Array.isArray(cloud.wishbook)) {
                settings.wishbook = cloud.wishbook;
            }
            await pushCloudSettings({
                id: currentUser.id,
                settings: settings,
                updated_at: new Date()
            }, { baseVer: existing && existing.ver });
        });
    }

    async function cloudRetry(fn, maxRetries = 2) {
        for (let i = 0; i <= maxRetries; i++) {
            if (!navigator.onLine) return;
            try {
                return await fn();
            } catch (e) {
                if (!isRetryableCloudError(e) || i === maxRetries) throw e;
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }

    // 云端（PostgREST）不收的两种字符，推之前洗掉：
    //   · \0 —— Postgres 的 jsonb 存不了；
    //   · 落单的半个代理对（emoji 被按 UTF-16 截断时留下的 \ud83d）—— 整个请求体被判「Empty or invalid json」。
    //     一条坏字符拖死的是**整包**：09-30 查出电脑上的设置因为两条收藏消息的预览截断，一直推不上云，零报错。
    //     换成 U+FFFD（�），而不是删掉：看得出这里曾经有个字。
    function stripNullBytes(obj) {
        if (typeof obj === 'string') return obj.replace(/\0/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
        if (Array.isArray(obj)) return obj.map(stripNullBytes);
        // 只钻普通对象。Date 这种没有可枚举字段的，拆了就剩 {}——设置那行的 updated_at 被拆成 {}，
        // 云端报「invalid input syntax for type timestamp」（09-30 把它用到设置推送上时实踩）
        if (obj && Object.prototype.toString.call(obj) === '[object Object]') {
            const out = {};
            for (const k in obj) out[k] = stripNullBytes(obj[k]);
            return out;
        }
        return obj;
    }

    async function rawUpsertChats(rows) {
        const session = (await supabaseClient.auth.getSession()).data.session;
        if (!session) return;
        const body = JSON.stringify(stripNullBytes(rows));
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + session.access_token,
            'apikey': SUPABASE_ANON_KEY,
            'Prefer': 'resolution=merge-duplicates'
        };
        // 推送也走电脑中转（手机直连 Supabase 上传只有 ~10KB/s，大对话推不动）。
        // 中转不可达才直连兜底；中转返回 5xx 是数据库侧的错，直连也一样，不重复打
        let res = null;
        try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 60000);
            res = await fetch(SERVER_BASE + '/api/cloud-chats', { method: 'POST', headers, body, signal: ctl.signal });
            clearTimeout(t);
            if (res.status === 404) res = null; // 旧版服务器没有推送中转
        } catch (e) { res = null; }
        if (!res) {
            res = await fetch(SUPABASE_URL + '/rest/v1/chats?on_conflict=user_id,chat_id', {
                method: 'POST', headers, body
            });
        }
        if (!res.ok) {
            let detail = '';
            try { detail = JSON.stringify(await res.json()); } catch {}
            console.error('[云同步] upsert 失败:', res.status, detail);
            throw new Error('upsert failed: ' + res.status + ' ' + detail);
        }
    }

    /* 从云端删掉一批对话，**确认删干净了才回报成功**。
       返回真正删成功的 id 数组，调用方拿它去把墓碑标成 'done'。

       ⚠️ 故意不走 cloudRetry：那个 helper 开头是 `if (!navigator.onLine) return;` ——
          离线时直接返回 undefined，**不抛错**。删除要是走它，离线时会被当成删成功，
          墓碑标 done，可云端那行还在，将来照样把对话拉回来。
          删除这种「必须真的发生」的操作，宁可报失败留着重试，也不能假装成功。

       ⚠️ 也不能只看有没有抛异常。supabase-js 的 delete 是把错误放在返回值的
          error 字段里，不 throw；不查 error 的话一样是假成功。 */
    async function deleteChatsFromCloud(ids) {
        if (!currentUser || !ids || !ids.length) return [];
        if (!navigator.onLine) return [];              // 离线就别试，留给下次
        const done = [];
        // 一次删一批，别一条一条来回跑；但批太大时 in() 的 URL 会超长，20 个一组
        for (let i = 0; i < ids.length; i += 20) {
            const batch = ids.slice(i, i + 20).map(String);
            try {
                const { error } = await supabaseClient.from('chats')
                    .delete().eq('user_id', currentUser.id).in('chat_id', batch);
                if (error) { console.warn('[云同步] 删除失败，下次重试:', error.message); continue; }
                done.push(...batch);
            } catch (e) {
                console.warn('[云同步] 删除异常，下次重试:', e.message);
            }
        }
        return done;
    }

    /* 把还没删干净的墓碑再试一遍。每次同步都跑，直到云端真的没了。
       没有这一步的话，「删除时正好没网」= 这个对话永远会回来，
       而人完全看不出为什么。 */
    async function retryPendingChatDeletes() {
        if (!currentUser || typeof pendingTombstoneIds !== 'function') return;
        const pending = pendingTombstoneIds();
        if (!pending.length) return;
        const done = await deleteChatsFromCloud(pending);
        if (!done.length) return;
        done.forEach(id => markTombstoneCloudDone(id));
        console.log('[云同步] 补删了', done.length, '个已删对话的云端记录');
        if (typeof pruneTombstones === 'function') pruneTombstones();
        save();
    }

    // 把聊天存到云端——只推真正变过的对话。
    // 以前每次 save 都整包重推所有对话（每批 20 个大 JSON 拼一条 SQL upsert），
    // Supabase 数据库端 8 秒 statement timeout 直接 57014
    let _pushedFp = null;
    function _chatFp(chat) {
        /* 长度取 _doSave 刚序列化过的那份（02-state 的 _chatJsonLen），数值和
           JSON.stringify(chat).length 一样。以前这里每次同步都把**全部**对话重新 stringify 一遍，
           是一次 save 序列化三遍里的一遍。 */
        const len = typeof _chatJsonLen === 'function' ? _chatJsonLen(chat) : JSON.stringify(chat).length;
        return (getChatLastTimestamp(chat) || 0) + ':' + len;
    }
    async function syncChatsToCloud() {
        if (!currentUser) return;
        // 先把欠着的删除补掉，再推新的 —— 顺序反了会先把对话推上去又立刻删，白跑一趟
        try { await retryPendingChatDeletes(); } catch (e) { console.warn('[云同步] 补删失败:', e); }
        if (!_pushedFp) {
            try { _pushedFp = JSON.parse(localStorage.getItem('kuro_pushedFp') || '{}'); } catch { _pushedFp = {}; }
        }
        const dirty = state.chats.filter(chat =>
            chat.headId !== null && _pushedFp[chat.id] !== _chatFp(chat)
            /* 有墓碑的绝不往上推。正常情况下它压根不该还在 state.chats 里，
               但只要有一条路径漏了（比如将来新加的删除入口忘了删本地），
               这里一推就等于亲手把它复活回云端，而且是**这台设备**干的，
               查起来会像「云端自己长出来的」。 */
            && !(typeof isChatDeleted === 'function' && isChatDeleted(chat.id)));
        if (dirty.length === 0) return;
        const rows = dirty.map(chat => ({
            user_id: currentUser.id,
            chat_id: chat.id,
            data: chat,
            updated_at: new Date().toISOString()
        }));
        const markPushed = (row) => { _pushedFp[row.chat_id] = _chatFp(row.data); };
        const BATCH = 5;
        for (let i = 0; i < rows.length; i += BATCH) {
            /* 推的途中 mergeCloudChats 可能把某个对话换了号（离线撞号，见 _forkLocalChat）。
               rows 是开头就定好的，chat_id 还是旧号、data 已经是新号 —— 照推会把它写进
               别人那个对话的行里。跳过它，下一轮按新号推。 */
            const batch = rows.slice(i, i + BATCH).filter(r => String(r.data && r.data.id) === String(r.chat_id));
            if (!batch.length) continue;
            try {
                await cloudRetry(() => rawUpsertChats(batch));
                batch.forEach(markPushed);
            } catch (e) {
                // 整批推不动（多半是数据库 statement timeout）→ 降级逐条推，跳过推不动的那条下次再试
                for (const row of batch) {
                    try {
                        await cloudRetry(() => rawUpsertChats([row]));
                        markPushed(row);
                    } catch (e2) {
                        console.warn('[云同步] 对话推送失败，下次重试:', row.chat_id, e2.message);
                    }
                }
            }
        }
        // 清掉已删除对话的指纹，防止 localStorage 越攒越大
        const liveIds = new Set(state.chats.map(c => String(c.id)));
        for (const id of Object.keys(_pushedFp)) {
            if (!liveIds.has(String(id))) delete _pushedFp[id];
        }
        try { localStorage.setItem('kuro_pushedFp', JSON.stringify(_pushedFp)); } catch {}
    }
    async function manualSyncAll() {
        const btn = document.getElementById('manualSyncBtn');
        if (!currentUser) { alert('请先登录账号'); return; }
        // 只改文字那个 span：直接改 btn.textContent 会把图标 svg 一起冲掉
        const label = btn.querySelector('.msync-label') || btn;
        label.textContent = '同步中…';
        btn.disabled = true;
        // 先把欠着的删除补掉，再整包上推
        try { await retryPendingChatDeletes(); } catch (e) { console.warn('[云同步] 补删失败:', e); }
        /* ⚠️ 有墓碑的绝不上推。
           我一开始以为这里不用滤，理由是「有墓碑的本来就不该还在 state.chats 里」——
           **那个前提是错的**，有两条路会让它在：
             ① 收到别的设备的墓碑时，本机故意不自动删本地那份（见 mergeTombstones 的注释）；
             ② 启动时从备份自动恢复，会把旧 id 整包塞回 state.chats。
           这两种情况下点一下「☁ 同步对话」，就把已经删掉的对话亲手推回云端了，
           而且墓碑要是已经 done，之后连自动补删都不会再跑。（Codex 审出来的。） */
        const localChats = (state.chats || []).filter(c =>
            !(typeof isChatDeleted === 'function' && isChatDeleted(c.id)));
        let ok = 0, fail = 0;
        for (const chat of localChats) {
            try {
                await rawUpsertChats([{
                    user_id: currentUser.id, chat_id: chat.id,
                    data: chat, updated_at: new Date().toISOString()
                }]);
                ok++;
            } catch (e) { fail++; }
        }
        label.textContent = fail ? `已同步 ${ok} 条，${fail} 条失败` : `✓ 已同步 ${ok} 条`;
        setTimeout(() => { label.textContent = '同步对话'; btn.disabled = false; }, 3000);
    }
    /* 离线撞号：两台设备都离线时用同一个计数器值各建了一个对话 —— id 相同，内容是两回事。
       mergeCloudChats 按 id 去重、留「最后消息更新」的那份，另一份就静默没了。
       （运行时拉取后的计数器补种只防得住「以后」，防不住离线期间已经撞上的。）

       判据是**消息节点的 (id, timestamp)**：
         · 节点 timestamp 只在创建那一刻 Date.now() 写一次，全仓库没有任何地方改它
           （编辑是另建新节点、删消息是整条删掉），所以它是节点的出生证；
         · 同一个对话在两台设备上各自追加：分叉之前的那些节点两边都有、id 和 timestamp
           完全一样 → 只要找到一个就是同一个对话，走老逻辑；
         · 离线撞号：两边的节点 id 也是同一个计数器发的，常常也撞，但 timestamp 不可能
           恰好是同一毫秒 → 公共 id 全部 timestamp 不同（或者压根没有公共 id）→ 两个对话。
       保守的方向：
         · 任一边没有消息 → 不算（空对话没东西可丢，也没有证据），走老逻辑；
         · 公共节点缺 timestamp（很老的数据 / 导入的）→ 判不了，走老逻辑；
         · 判错的代价：「一台把另一台有的消息**全删光**又写了新的」会被当成两个对话，
           结果是多出一份可以手动删的对话 —— 多一份能删，少一份找不回来。 */
    function _isOfflineIdCollision(local, cloud) {
        const ln = local && local.nodes, cn = cloud && cloud.nodes;
        if (!ln || !cn || typeof ln !== 'object' || typeof cn !== 'object') return false;
        const lk = Object.keys(ln);
        if (!lk.length || !Object.keys(cn).length) return false;
        for (const k of lk) {
            if (!Object.prototype.hasOwnProperty.call(cn, k)) continue;
            const a = ln[k] && ln[k].timestamp, b = cn[k] && cn[k].timestamp;
            if (typeof a !== 'number' || typeof b !== 'number' || !(a > 0) || !(b > 0)) return false;
            if (a === b) return false;          // 同一条消息 → 同一个对话
        }
        return true;
    }

    /* 撞号时把**本机这份**换个新号留下，云端那份占原号。
       为什么换本机的：云端那份别的设备已经有了（或者马上就拉到），它们都认原号；
       本机这份换号后推上去，别的设备拉到的是一个新 id 的新对话，不会再冲突。
       ⚠️ 必须在 reseedIdCounter() **之后**调：新号要越过这批云端对话里的对话 id 和消息 id，
          不然换出来的号又撞上刚拉下来的某一个。万一撞上还没拉到的下一批，下一批合并时
          这里会再判一次、再换一次，不会丢。
       跟着改的引用：
         · activeChatId —— 她正看着的是本机这份，视图跟着它走，而不是突然换成别人的对话；
         · 收藏 —— 节点只在本机这份里有的才迁；两边都有同号节点时用收藏时间夹一下，
           夹不出来就不动（错指一条收藏 < 乱迁收藏）；
         · 回收站里的单条消息 —— 回收站只在本机，里面挂着旧号的消息就是从本机这份删的
           （除非它恰好是云端那份的同一条节点）；
         · 墓碑不用动：旧号有墓碑的话云端那份在上面就被挡掉了，走不到这里；新号是
           reseed 之后发的，reseed 已经把墓碑的键算进去，不会撞上墓碑；
         · _pushedFp 不用动：旧号的指纹是本机那份的，和云端那份对不上 → 顶多把云端那份
           原样推一次（和平常拉下来再推回去一样）；新号没有指纹 → 下次同步推上去。
         · 正在往这个对话里流式写的回复拿的是对象引用，对象没换，只是 id 变了，照样写对地方。 */
    function _forkLocalChat(local, cloud) {
        const oldId = local.id, newId = nextId();
        const same = x => x != null && String(x) === String(oldId);
        local.id = newId;
        if (same(state.activeChatId)) state.activeChatId = newId;
        const cn = (cloud && cloud.nodes) || {};
        (state.favMessages || []).forEach(f => {
            if (!f || !same(f.chatId)) return;
            const a = local.nodes && local.nodes[f.nodeId];
            if (!a) return;
            const b = cn[f.nodeId];
            const t = f.time;
            if (!b || (typeof t === 'number' && a.timestamp <= t && !(b.timestamp <= t))) f.chatId = newId;
        });
        (state.trash || []).forEach(it => {
            if (!it || !it.message || !same(it.chatId)) return;
            const b = cn[it.message.id];
            if (b && b.timestamp != null && b.timestamp === it.message.timestamp) return;
            it.chatId = newId;
        });
        console.warn('[云同步] 对话 id ' + oldId + ' 在两台设备上各建了一个不同的对话（离线撞号），本机这份改为 id ' + newId + ' 保留');
        return newId;
    }

    // 把一批云端对话合并进 state.chats（同 id 时保留最后消息更新的那份）
    function mergeCloudChats(cloudChats) {
        const chatMap = new Map();
        (state.chats || []).forEach(chat => {
            if (chat && chat.id != null) chatMap.set(chat.id, chat);
        });
        const forks = [];   // [本机那份, 云端那份]：同 id 其实是两个对话（见 _isOfflineIdCollision）
        cloudChats.forEach(chat => {
            if (!chat || chat.id == null) return;
            /* ⚠️ 墓碑挡在最前面。这里是纯并集合并 —— 云端有、本地没有的一律加进来，
               而「被人删掉」在这段代码眼里跟「本地还没同步到」长得一模一样。
               没有这一行，删掉的对话每次同步都会原样回来。 */
            if (typeof isChatDeleted === 'function' && isChatDeleted(chat.id)) return;
            const local = chatMap.get(chat.id);
            if (local && local !== chat && _isOfflineIdCollision(local, chat)) {
                forks.push([local, chat]);      // 本机那份不丢，下面换号后放回来
                chatMap.set(chat.id, chat);
                return;
            }
            if (!local || (getChatLastTimestamp(chat) || 0) > (getChatLastTimestamp(local) || 0)) {
                chatMap.set(chat.id, chat);
            }
        });
        state.chats = Array.from(chatMap.values()).concat(forks.map(p => p[0]));
        // 计数器以前只在启动时播种：App 开着时从别的设备拉进来 id=M+1 的对话，本机计数器还停在 M，
        // 下一个新对话又发 M+1 → 推上云按 chat_id 覆盖，别的设备那个对话就没了。只取最大值，不会回退。
        if (typeof reseedIdCounter === 'function') reseedIdCounter();
        forks.forEach(([local, cloud]) => _forkLocalChat(local, cloud));   // 必须在 reseed 之后
        state.chats.sort((a, b) => {
            return (getChatLastTimestamp(b) || 0) - (getChatLastTimestamp(a) || 0);
        });
        const ids = new Set(state.chats.map(c => c.id));
        if (!ids.has(state.activeChatId)) {
            state.activeChatId = state.chats[0]?.id || null;
        }
    }

    // 从云端加载聊天记录
    // 全量数据可能有 10MB+，一次性拉在手机上会卡死超时，所以：
    // ① 分页拉取（每批 20 条），边拉边合并渲染，最近的对话几秒内就能看到
    // ② 全量成功后记录 updated_at 水位线，之后启动只拉有变化的对话（增量）
    const LAST_PULL_KEY = 'grancyan_last_chat_pull';

    // 拉一批云端对话：优先走电脑 server.js 中转（局域网+电脑代理，比手机直连快几十倍），失败再直连
    async function fetchCloudChatBatch(offset, limit, since) {
        const session = (await supabaseClient.auth.getSession()).data.session;
        if (!session) throw new Error('未登录');
        try {
            let u = SERVER_BASE + '/api/cloud-chats?limit=' + limit + '&offset=' + offset;
            if (since) u += '&since=' + encodeURIComponent(since);
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 30000);
            const r = await fetch(u, {
                headers: { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_ANON_KEY },
                signal: ctl.signal
            });
            clearTimeout(t);
            if (r.ok) return await r.json();
        } catch (e) { /* 中转不可用，直连兜底 */ }
        let q = supabaseClient
            .from('chats')
            .select('data, updated_at')
            .order('updated_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (since) q = q.gt('updated_at', since);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
    }

    // 按 id 精确拉取（分页收尾清点用），同样中转优先
    async function fetchCloudChatsByIds(ids) {
        const session = (await supabaseClient.auth.getSession()).data.session;
        if (!session) throw new Error('未登录');
        try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 30000);
            const r = await fetch(SERVER_BASE + '/api/cloud-chats?ids=' + encodeURIComponent(ids.join(',')), {
                headers: { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_ANON_KEY },
                signal: ctl.signal
            });
            clearTimeout(t);
            if (r.ok) return await r.json();
        } catch (e) { /* 中转不可用，直连兜底 */ }
        const { data, error } = await supabaseClient.from('chats')
            .select('data, updated_at').in('chat_id', ids);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async function loadChatsFromCloud() {
        if (!currentUser) return;
        try {
            const lastPull = localStorage.getItem(LAST_PULL_KEY);
            const delta = !!(lastPull && (state.chats || []).length > 0);
            if (!delta) showToast('☁️ 正在从云端同步对话，稍等…', 'info', 4000);
            const BATCH = 20;
            let newestTs = lastPull || '';
            let total = 0;
            for (let from = 0; ; from += BATCH) {
                const data = await fetchCloudChatBatch(from, BATCH, delta ? lastPull : null);
                if (!data.length) break;
                for (const row of data) {
                    if (row.updated_at > newestTs) newestTs = row.updated_at;
                }
                mergeCloudChats(data.map(row => row.data));
                total += data.length;
                renderChatList(); // 边拉边显示
                save();           // 每批落盘，中途被杀也不丢进度
                if (data.length < BATCH) break;
            }
            // 清点补漏：同步期间若有别的设备在推送，分页顺序会被打乱而漏掉对话，按 id 精确补拉
            try {
                const { data: idRows } = await supabaseClient.from('chats').select('chat_id');
                if (idRows && idRows.length) {
                    const localIds = new Set(state.chats.map(c => String(c.id)));
                    /* ⚠️ 这里是「复活引擎」的正身：它把**本地没有而云端有**的一律当成
                       「同步漏了」拉回来。人主动删掉的对话在这个判断里跟漏了一样，
                       所以删一次拉回来一次 —— 用户说的「反复删了十几次又冒出来」。
                       墓碑必须在这里也挡一道，光挡 mergeCloudChats 不够。 */
                    const missing = idRows.map(r => r.chat_id).filter(id =>
                        !localIds.has(String(id))
                        && !(typeof isChatDeleted === 'function' && isChatDeleted(id)));
                    if (missing.length) console.log('[云同步] 补漏', missing.length, '个对话');

                    /* ❗反向清点：本地有墓碑、云端却还有这一行。
                       这说明删除之后又有人把它写回来了 —— 典型是 A 删掉并标了 done，
                       还没收到墓碑的 B 一编辑就把同一个 chat_id 又 upsert 上去。
                       此时 done 不再重试、上面的 missing 又跳过它，那行就一直赖着，
                       等 180 天后墓碑被 prune 就复活了。
                       所以在这里把它打回 pending 并立刻重删 —— 清点是唯一能看见
                       「云端到底还有没有」的地方，光靠删除那一下的返回值不够
                       （Supabase 的 DELETE 没 error 也可能是 RLS 下零行受影响）。 */
                    if (typeof isChatDeleted === 'function') {
                        const zombies = idRows.map(r => r.chat_id).filter(id => isChatDeleted(id));
                        if (zombies.length) {
                            console.warn('[云同步] 云端还留着', zombies.length,
                                '个已删对话的记录，重新删除');
                            zombies.forEach(id => markTombstoneCloudPending(id));
                            try { await retryPendingChatDeletes(); } catch (e) {
                                console.warn('[云同步] 重删失败，下次再试:', e && e.message);
                            }
                        }
                    }
                    for (let i = 0; i < missing.length; i += 20) {
                        const rows = await fetchCloudChatsByIds(missing.slice(i, i + 20));
                        if (!rows.length) continue;
                        for (const row of rows) {
                            if (row.updated_at > newestTs) newestTs = row.updated_at;
                        }
                        mergeCloudChats(rows.map(r => r.data));
                        total += rows.length;
                        renderChatList();
                        save();
                    }
                }
            } catch (e) { console.warn('[云同步] 清点补漏失败:', e); }
            if (total > 0 && !delta) showToast(`✓ 已从云端同步 ${total} 个对话`, 'success');
            // 只有整轮拉取成功才推进水位线，中途失败下次会重拉
            if (newestTs && newestTs !== lastPull) localStorage.setItem(LAST_PULL_KEY, newestTs);
        } catch (err) {
            console.error('加载聊天记录异常:', err);
            showToast('☁️ 云同步暂时不可用，使用本地数据', 'warn');
        }
    }

    /* 4. 从云端加载数据。
       ⚠️ settings 和 chats 原来是**并行**拉的，但墓碑在 settings 里，
          而 chats 那边（mergeCloudChats / 清点补漏）要靠墓碑决定谁不该收 ——
          并行的话就是竞态：新设备第一次登录，chats 先回来，墓碑还没到，
          别的设备删掉的对话原样落地，而且落地之后本机再改一下就又推回云端了。
          所以现在先把 settings 拉回来、把墓碑合进去，再开始拉 chats。
          代价是首屏多等一个 settings 请求（很小），换的是删除在多设备上真的生效。
          （Codex 审出来的。） */
    async function loadFromCloud() {
        /* 先单独把墓碑拿到手，再动 chats。
           ⚠️ **fail closed**：拿不到 settings 就这一轮不拉 chats。
              第一版是 fail-open（拿不到就照拉），有两个洞：
              ① fetchCloudSettings 出错时通常**不抛异常**，而是返回 { data:null, error }
                 —— try/catch 接不住，`_preSettings` 还是 truthy，于是「预取成功」，
                 墓碑却没合上，chats 照拉，新设备原样收进别人删掉的对话；
              ② 就算真抛了异常，退回去重拉的那次是跟 chats **并行**的，墓碑照样可能晚到。
              少同步一轮的代价，比把已删对话灌回来小得多 —— 下次启动会重来。
              （Codex 二审逮到的。同一个道理上一轮在 chat-peek 那条防线上也吃过亏。） */
        let _preSettings = null;
        let tombstonesReady = false;
        try {
            const pre = await fetchCloudSettings();
            // PGRST116 = 这个用户还没有 profile 行（新账号），本来就没有墓碑要合，算正常
            if (pre && (!pre.error || pre.error.code === 'PGRST116')) {
                const s0 = pre.data?.settings;
                if (s0 && s0.deletedChats && typeof mergeTombstones === 'function') {
                    state.deletedChats = mergeTombstones(state.deletedChats, s0.deletedChats);
                }
                _preSettings = pre;
                tombstonesReady = true;
            } else {
                console.warn('[云同步] 预取墓碑失败:', pre && pre.error && pre.error.message);
            }
        } catch (e) {
            console.warn('[云同步] 预取墓碑异常:', e && e.message);
        }
        if (!tombstonesReady) {
            showToast('☁️ 云端设置没拉下来，这次先不同步对话（避免删掉的对话跑回来）', 'warn', 4000);
            return;
        }
        const profilePromise = Promise.resolve(_preSettings)
            .then(({ data, error }) => {
                if (error && error.code !== 'PGRST116') {
                    console.error('加载云端设置失败:', error.message);
                    return;
                }
                if (data && data.settings) {
                    const s = data.settings;
                    state.background = s.background || state.background;
                    state.callBg = s.callBg || state.callBg;
                    state.callBgMask = s.callBgMask ?? state.callBgMask;
                    state.callBgBlur = s.callBgBlur ?? state.callBgBlur;
                    state.brightness = s.brightness ?? state.brightness;
                    state.accentColor = s.accentColor || state.accentColor;
                    state.themeTemperature = s.themeTemperature || state.themeTemperature;
                    // '' 是「跟预设」，也是真值，不能用 || 退回本机的
                    state.customBg = s.customBg ?? state.customBg;
                    state.customText = s.customText ?? state.customText;
                    state.echoOpacity = s.echoOpacity ?? state.echoOpacity;
                    state.fontPreset = s.fontPreset || state.fontPreset;
                    state.uiShape = s.uiShape || state.uiShape;
                    state.bgAutoTint = s.bgAutoTint ?? state.bgAutoTint;
                    state.bgLegibility = s.bgLegibility || state.bgLegibility;
                    state.aiFontSize = s.aiFontSize ?? state.aiFontSize;
                    state.userFontSize = s.userFontSize ?? state.userFontSize;
                    state.webSearchApiKey = s.webSearchApiKey || state.webSearchApiKey;
                    state.webSearchProvider = s.webSearchProvider || state.webSearchProvider;
                    state.tenorApiKey = s.tenorApiKey || state.tenorApiKey;
                    state.thinkSumKey = s.thinkSumKey || state.thinkSumKey;
                    state.voiceApiKey = s.voiceApiKey || state.voiceApiKey;
                    state.voiceProvider = s.voiceProvider || state.voiceProvider;
                    state.voiceApiBase = s.voiceApiBase || state.voiceApiBase;
                    state.voiceModel = s.voiceModel || state.voiceModel;
                    renderVoiceSettings();
                    state.bgBlur = s.bgBlur ?? state.bgBlur;
                    state.uiBlur = s.uiBlur ?? state.uiBlur;
                    /* 模型配置：**不能整包替换**。这行以前是 `state.configs = s.configs || state.configs`，
                       和 memories / favMessages 当年那两次事故是同一个模式 —— settings 是整包
                       upsert「最后写入者赢」，另一台设备（手机上那份没有 Gemini 的 configs）随手
                       存一次，就把这边刚加的模型、分组、上下文窗口、思考模式整套冲回旧值。
                       症状是四件看起来毫不相干的事：右上角胶囊里 Gemini 不见了、分组加几次都留不住、
                       上下文窗口自己变回 8000、本地 Claude 的「始终开启思考」自己弹回默认 ——
                       全都是 configs 上的字段被打回去，而且一次报错都没有。

                       改成逻辑版本号比大小：谁改得晚（ver 大）谁赢，没人改过就各自保留本地。
                       ⚠️ ver 是计数器不是时间戳，理由见 favGroups 那段注释（时钟快的那台会长期压住
                          另一台）。**撞平不能「偏向本地」**：那是「双方都看不见对方那次改动」，
                          两台各改一次就永久互不可见（一次报错都没有），走对称合并裁决。 */
                    const _cloudCfgVer = Number(s.configsVer) || 0;
                    const _localCfgVerRaw = Number(state.configsVer);
                    const _localCfgVer = Number.isFinite(_localCfgVerRaw) ? _localCfgVerRaw : -1;
                    const _cloudCfgOk = s.configs && Array.isArray(s.configs) && s.configs.length;
                    let _nextCfg = null, _nextCfgVer = Math.max(_localCfgVer, _cloudCfgVer);
                    if (_cloudCfgOk && _cloudCfgVer > _localCfgVer) {
                        _nextCfg = s.configs;                    // 云端更新，整份收下
                    } else if (_cloudCfgOk && _cloudCfgVer === _localCfgVer && _localCfgVer >= 0
                               && _cfgCanon(s.configs) !== _cfgCanon(state.configs || [])) {
                        // 平局裁决：两边跑同一个纯函数得到同一份结果，再把 ver 抬一级 → 下一轮判等收敛
                        _nextCfg = _mergeConfigs(state.configs, s.configs);
                        _nextCfgVer = _cloudCfgVer + 1;
                    }
                    if (_nextCfg) {
                        state.configs = _nextCfg;
                        state.configsVer = _nextCfgVer;
                        /* 重置基线 + 落盘，捆在一起：只改内存的话下次启动从 IDB 读回旧值，
                           「改了又弹回去」原样复现；顺序反了则 _doSave 会把它误判成本机编辑。 */
                        if (typeof _persistConfigs === 'function') _persistConfigs();
                        // 这段是异步落的，很可能晚于 boot 那轮渲染，得自己重画一次
                        if (typeof renderModelPills === 'function') renderModelPills();
                        if (typeof renderConvSettingsBar === 'function') renderConvSettingsBar();
                        if (typeof renderConfigs === 'function') renderConfigs();
                    } else {
                        state.configsVer = _nextCfgVer;
                    }
                    // 云端记忆与本地按条目合并（本地优先），而不是整包替换 ——
                    // 整包替换会把"本地刚写入、还没来得及同步"的记忆直接冲掉
                    // 另一台删掉的（memGone 墓碑）这台也拿掉，见 _trashGone
                    state.memories = mergeMemoryLists(state.memories, s.memories).filter(m => _memAlive(m, _memGoneMerge(s.memGone)));
                    state.bandAiEnabled = s.bandAiEnabled ?? state.bandAiEnabled;
                    state.callDnd = s.callDnd ?? state.callDnd;
                    state.ccMemoryEnabled = s.ccMemoryEnabled ?? state.ccMemoryEnabled;
                    state.typingRhythmEnabled = s.typingRhythmEnabled ?? state.typingRhythmEnabled;
                    state.typingDraftPeek = s.typingDraftPeek ?? state.typingDraftPeek;
                    state.showUserAvatar = s.showUserAvatar ?? state.showUserAvatar;
                    state.inkStream = s.inkStream ?? state.inkStream;
                    state.inkRate = s.inkRate ?? state.inkRate;
                    // 小本子：按 id 并集，有变化当场落盘、本机多出来的推上去
                    if (typeof wishSyncApply === 'function') {
                        const _wb = wishSyncApply(s.wishbook);
                        if (_wb.changed || _wb.needPush) save();
                        if (_wb.changed && typeof wishbookRender === 'function') wishbookRender();
                    }
                    // 云端有头像就用云端的（本地没设过时尤其重要）；云端为空则保留本地，不覆盖
                    if (s.userAvatar) { state.userAvatar = s.userAvatar; renderUserAvatar(); }
                    {   // 另一台删掉的收藏（favGone 墓碑）这台也拿掉，见 _favGoneMerge
                        const _gone = _favGoneMerge(s.favGone);
                        state.favMessages = mergeFavLists(state.favMessages, s.favMessages).filter(f => _favAlive(f, _gone));
                    }
                    // 点歌四件套按条合并（24-music 的 musicSyncApply），同样不能整包替换
                    // 有变化要当场落盘：这一段后面没有 save()，不存的话刷新一次就回到合并前
                    // 本机有云端没有的也要 save 一次：save 之后 3 秒会推，另一台才看得到（needPush）
                    if (typeof musicSyncApply === 'function') {
                        const _mr = musicSyncApply(s);
                        if (_mr.changed || _mr.needPush) save();
                        if (_mr.changed && typeof musicRefresh === 'function') musicRefresh();
                    }
                    /* 分组名：按最后编辑时间取新的那一份，不能取并集。
                       并集看着安全（谁都不丢），但**删除永远不收敛**：在 A 删掉的组，
                       下次合并被云端那份原样加回来，用户看到的是"删了又活"。
                       （Codex 审出来的，本来我写的就是并集。）
                       整包替换的代价是并发新建可能丢，所以紧跟着用收藏反查兜一道：
                       只要还有收藏挂在某个组名下，那个名字就必须在列表里。
                       于是真正可能丢的只剩"另一台设备刚建、还空着、且本机同时也改过
                       组列表"这一种，而 favMessages 已经先合并过了。 */
                    /* 分组名的跨设备合并：LWW-Element-Set。每个组名各记两个版本 ——
                       a = 最后一次新建的版本，d = 最后一次删除的版本，a >= d 即存活
                       （撞平时偏向保留）。两边逐名取 max，结果与同步先后无关。

                       ⚠️ 这里前后错过两版，都是"删了又活"，别再改回去：
                       ① 无条件取并集 —— 删除永远不收敛，删掉的名字每次被云端加回来。
                       ② 整包按版本号取新的、平局取并集 —— 我当时以为"真正的删除一定把
                          版本抬得比对方高，走不进平局分支"。**错的**，那只在对方没有并发
                          修改时成立：同在 v5，A 删「甲」抬到 v6，B 新建「乙」也抬到 v6，
                          版本撞平进并集，「甲」就回来了。（Codex 三审给的序列。）
                       版本号本身是逻辑计数器不是时间戳：时间戳靠设备时钟，一台机器时钟
                       快一年就能长期压住另一台。（Codex 二审指出的。）

                       ops 表按"用过的不同组名"增长，删掉的名字留一条墓碑不清理 ——
                       量级是几十条 {a,d}，不值得为它再加一套 prune。 */
                    // 无原型对象：组名可能就叫 `__proto__`，普通 {} 会把它写丢（见
                    // 06-render-msg 的 _favGroupOps 注释）。
                    const _fgOps = Object.create(null);
                    const _fgSee = (n, a, d) => {
                        const c = _fgOps[n] || { a: 0, d: 0 };
                        _fgOps[n] = { a: Math.max(c.a, a || 0), d: Math.max(c.d, d || 0) };
                    };
                    for (const src of [state.favGroupOps || {}, s.favGroupOps || {}]) {
                        for (const n of Object.keys(src)) _fgSee(n, (src[n] || {}).a, (src[n] || {}).d);
                    }
                    /* 老数据没有 ops 表：两边列表里的、以及收藏上还挂着的名字，一律补成
                       "0 版建的"。0 >= 0 成立所以它们存活，等价于本次改动之前的无条件
                       并集 —— 升级/新设备第一次同步行为零变化，云端的空组不会凭空消失。
                       已经有墓碑的名字在这儿补不活：取的是 max，d 还在。 */
                    for (const n of [...(state.favGroups || []), ...(s.favGroups || [])]) _fgSee(n, 0, 0);
                    for (const f of state.favMessages || []) if (f && f.group) _fgSee(f.group, 0, 0);
                    state.favGroupsVer = Math.max(state.favGroupsVer || 0, s.favGroupsVer || 0);
                    state.favGroupOps = _fgOps;
                    /* 顺序按 (新建版本, 名字) 算，不按谁的本地列表 —— 否则 A 得到 [甲,乙]、
                       B 得到 [乙,甲]，chip 顺序会长期对不上。老数据 a 都是 0，按名字排一次。 */
                    state.favGroups = Object.keys(_fgOps)
                        .filter(n => _fgOps[n].a >= _fgOps[n].d)
                        .sort((x, y) => (_fgOps[x].a - _fgOps[y].a) || (x < y ? -1 : x > y ? 1 : 0));
                    /* 组被删掉之后，另一台设备的收藏可能还挂着这个组名。不摘掉的话那条
                       收藏顶着一个筛选条里点不出来的标签，"未分组"也筛不到它，等于失踪。 */
                    const _fgLive = new Set(state.favGroups);
                    for (const f of state.favMessages || []) if (f && f.group && !_fgLive.has(f.group)) delete f.group;
                    updateFavBadge();
                    if (typeof refreshFavPanelIfOpen === 'function') refreshFavPanelIfOpen();
                    state.userName = s.userName ?? state.userName;
                    state.userNameAiVisible = s.userNameAiVisible ?? state.userNameAiVisible;
                    // 表情备注按条目合并（本地优先）：整包替换时云端若是空 {}（truthy）
                    // 会把本地刚写的备注直接冲掉，然后下次推送把"冲掉"固化到云端
                    state.stickerNotes = Object.assign({}, s.stickerNotes || {}, state.stickerNotes || {});
                    state.stickerAiOff = _mergeStickerAiOff(s.stickerAiOff, state.stickerAiOff);
                    state.stickerGroupOf = _mergeStickerGroupOf(s.stickerGroupOf, state.stickerGroupOf);
                    {
                        const m = _mergeStickerGroupState(
                            { groups: state.stickerGroups, ops: state.stickerGroupOps, ver: state.stickerGroupsVer },
                            { groups: s.stickerGroups, ops: s.stickerGroupOps, ver: s.stickerGroupsVer });
                        state.stickerGroups = m.groups;
                        state.stickerGroupOps = m.ops;
                        state.stickerGroupsVer = m.ver;
                    }
                    {
                        const t = _mergeThinkOpen(state.thinkOpen, state.thinkOpenVer,
                                                  s.thinkOpen, s.thinkOpenVer);
                        state.thinkOpen = t.on;
                        state.thinkOpenVer = t.ver;
                        // 只改 state 不刷 body 的类，她这一屏思考会一直糊/一直清晰到下次刷新
                        if (typeof applyThinkVeil === 'function') applyThinkVeil();
                    }
                    {
                        const _g = _memGoneMerge(s.memGone);
                        state.brainMemories = mergeMemoryLists(state.brainMemories, s.brainMemories).filter(m => _memAlive(m, _g));
                    }
                    // 模型日记按条目合并（本地优先并集），别被云端整包覆盖丢页
                    if (typeof _mergeDiaries === 'function') state.modelDiaries = _mergeDiaries(state.modelDiaries, s.modelDiaries);
                    if (typeof _mergeHandover === 'function') state.diaryHandover = _mergeHandover(state.diaryHandover, s.diaryHandover);
                    state.diaryEnabled = s.diaryEnabled ?? state.diaryEnabled;
                    state.diaryDevView = s.diaryDevView ?? state.diaryDevView;
                    /* 墓碑再合一次。
                       ⚠️ 走到这里时上面的预取**一定**已经合过了（预取拿不到墓碑就直接
                          return 了，根本到不了这儿）。留着它是防止以后有人把上面那段
                          挪走或改回并行 —— 那时这里就是最后一道。
                          mergeTombstones 是并集 + done 获胜，幂等，合两次没有副作用。 */
                    if (s.deletedChats && typeof mergeTombstones === 'function') {
                        state.deletedChats = mergeTombstones(state.deletedChats, s.deletedChats);
                    }
                    state.proustMems = _mergeProust(state.proustMems, s.proustMems);
                    // 猫爪日报按条并集合并：本机存档被删光也能从云端拿回来，本机新发的也不会被云端冲掉
                    if (typeof momentsSyncApply === 'function') momentsSyncApply(s.moments);
                    // 梦境同理按 id 并集合并
                    if (typeof dreamsSyncApply === 'function') dreamsSyncApply(s.dreamsByModel);
                    // 单词卡按词合并：本机被清空也能从云端拿回来，删掉的词带着墓碑不会被另一台复活
                    if (typeof studySyncApply === 'function') studySyncApply(s.studyCards, s.studyGone, s.studyBook);
                    // 世界书按条合并（墓碑 + ver），别被云端整包覆盖丢掉本机刚写的条目
                    if (typeof wbMerge === 'function') {
                        const _wbBefore = JSON.stringify(wbNorm(state.worldbook));
                        state.worldbook = wbMerge(state.worldbook, s.worldbook);
                        if (JSON.stringify(state.worldbook) !== _wbBefore) {
                            if (typeof save === 'function') save();
                            if (typeof worldbookRefresh === 'function') worldbookRefresh();
                        }
                    }
                    state.vitalsOn = s.vitalsOn ?? state.vitalsOn;
                    state.vitalsByModel = typeof _mergeVitals === 'function'
                        ? _mergeVitals(state.vitalsByModel, s.vitalsByModel)
                        : Object.assign({}, s.vitalsByModel || {}, state.vitalsByModel || {});
                    if (typeof _vitalsSleepPrefNewer === 'function') state.vitalsSleepPref = _vitalsSleepPrefNewer(state.vitalsSleepPref, s.vitalsSleepPref);
                    state.ttsVoice = s.ttsVoice || state.ttsVoice;
                    state.ttsVoiceZh = s.ttsVoiceZh ?? state.ttsVoiceZh;
                    state.ttsRate = s.ttsRate ?? state.ttsRate;
                    state.ttsPitch = s.ttsPitch ?? state.ttsPitch;
                    syncTtsSettingsUI();
                    applyThemeTemperature();
                    applyFontPreset();
                    applyAccentCSS(state.accentColor);
                    applyUiShape();
                    applyEchoOpacity();
                    applyFontSizeCSS();
                    syncFontSizeUI();
                    renderBackground();
                    renderConfigs();
                }
            }).catch(e => console.warn('加载云端设置异常:', e));

        await Promise.all([profilePromise, loadChatsFromCloud()]);
        renderChatList();
        if (!state.isSelectMode) {
            renderMessages();
        }
    }

    // 5. 更新账号信息显示
    function updateAccountInfo() {
        const emailDisplay = document.getElementById('userEmailDisplay');
        const statusDisplay = document.getElementById('userStatusDisplay');

        if (currentUser) {
            emailDisplay.textContent = currentUser.email || '未知';
            statusDisplay.textContent = '✅ 已登录';
            statusDisplay.style.color = '#10b981';
        } else {
            emailDisplay.textContent = '未登录';
            statusDisplay.textContent = '❌ 未登录';
            statusDisplay.style.color = '#ef4444';
        }
        renderUserName();
    }

    // 5.5 修改密码（Supabase 已登录会话直接改，不用旧密码）
    async function changePassword() {
        if (!currentUser) { showToast('请先登录账号', 'error'); return; }
        const p1 = document.getElementById('newPwdInput').value;
        const p2 = document.getElementById('newPwdConfirmInput').value;
        if (p1.length < 6) { showToast('密码至少 6 位哦', 'error'); return; }
        if (p1 !== p2) { showToast('两次输入的密码不一样 (´•̥ ω •̥`)', 'error'); return; }
        const btn = document.getElementById('changePwdBtn');
        btn.disabled = true; btn.textContent = '修改中…';
        try {
            const { error } = await supabaseClient.auth.updateUser({ password: p1 });
            if (error) {
                let msg = error.message || '';
                if (msg.includes('different from the old')) msg = '新密码不能和旧密码相同';
                else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) msg = '网络连接失败，请稍后重试';
                showToast('修改失败：' + msg, 'error', 4000);
            } else {
                document.getElementById('newPwdInput').value = '';
                document.getElementById('newPwdConfirmInput').value = '';
                showToast('✓ 密码已修改，下次登录用新密码 ♪', 'success', 4000);
            }
        } finally {
            btn.disabled = false; btn.textContent = '确认修改';
        }
    }

    // 6. 注销账号
    async function deleteAccount() {
        if (!currentUser) {
            alert('未登录，无法注销');
            return;
        }

        const email = currentUser.email;
        const confirmText = await appPrompt(
            `⚠️ 注销账号是不可逆操作！\n\n` +
            `将会删除：\n` +
            `• 云端所有对话记录\n` +
            `• 云端所有记忆和设置\n` +
            `• 账号数据（无法恢复）\n\n` +
            `本地数据会保留，但无法再同步。\n\n` +
            `如果确定要注销，请输入你的邮箱确认：\n${email}`
        );

        if (confirmText !== email) {
            if (confirmText) showToast('邮箱不匹配，已取消注销', 'error', 2500);
            return;
        }

        try {
            // 1. 删除云端所有对话
            const { error: chatsError } = await supabaseClient
                .from('chats')
                .delete()
                .eq('user_id', currentUser.id);

            if (chatsError) throw chatsError;

            // 2. 删除云端设置
            const { error: profileError } = await supabaseClient
                .from('profiles')
                .delete()
                .eq('id', currentUser.id);

            if (profileError && profileError.code !== 'PGRST116') throw profileError;

            // 3. 删除账号（Supabase Auth）
            const { error: deleteError } = await supabaseClient.auth.admin.deleteUser(currentUser.id);

            // 如果没有admin权限，使用普通注销
            if (deleteError) {
                await supabaseClient.auth.signOut();
            }

            // 4. 清空当前用户
            currentUser = null;

            // 5. 显示登录框
            document.getElementById('authModal').classList.remove('hidden');

            showToast('✓ 账号已注销，本地数据已保留', 'success', 4000);
            updateAccountInfo();

        } catch (e) {
            console.error('注销失败:', e);
            showToast('✕ 注销失败: ' + e.message, 'error', 3000);
        }
    }

// ═══════════════════════════════════════════════════════
// STREAMING STATE & ABORT CONTROL
// ═══════════════════════════════════════════════════════
const _streamControllers = new Set();

// 电脑操控正在跑的那个「活」的编号。断线重连、按停止都要用它。
// 服务端不再因为客户端断开就杀进程，所以「停止」必须显式告诉它一声。
let _agentRunId = null;

function updateStreamUI() {
  // 按**当前对话**算：后台对话在生成时，这边的发送键不该被藏掉换成停止
  const streaming = typeof chatIsGenerating === 'function'
    ? chatIsGenerating(getActiveChat()) : _streamControllers.size > 0;
  // 发送键已经并进 ＋ 了（.plus-btn 一键两用），所以流式生成时藏的是整个 ＋，换出 ⏹
  const plusWrap = document.querySelector('.plus-menu-wrap');
  const stopBtn = document.getElementById('stopBtn');
  if (plusWrap) plusWrap.style.display = streaming ? 'none' : '';
  if (stopBtn) stopBtn.style.display = streaming ? 'grid' : 'none';
}

function stopGeneration() {
  // 电脑操控：断开连接已经不代表停止了（那是为了锁屏也能接着跑），
  // 所以真要停必须专门喊一声，否则进程会在电脑上一直跑到底。
  // 只停**当前对话**的：以前是把全局所有流一锅端，后台另一个对话正生成着也被掐断、还被贴上「已停止生成」。
  const chat = getActiveChat();
  const mine = typeof _streamBelongsTo === 'function'
    ? [..._streamControllers].filter(c => _streamBelongsTo(c, chat)) : [..._streamControllers];
  const runIds = new Set(mine.map(c => c.gcRunId).filter(Boolean));
  // 没挂上流的活（流已断、活还在电脑上跑）只能靠全局那个兜底 —— 但它得是这个对话的
  if (_agentRunId && !runIds.size && chat && chat.agentRunId === _agentRunId) runIds.add(_agentRunId);
  for (const id of runIds) {
    if (id === _agentRunId) _agentRunId = null;
    fetch(`${SERVER_BASE}/api/agent-run/${id}/stop`, { method: 'POST' }).catch(() => {});
  }
  if (typeof abortChatStreams === 'function') abortChatStreams(chat);
  else { _streamControllers.forEach(ctrl => { try { ctrl.abort(); } catch(e) {} }); _streamControllers.clear(); }
  // Mark all streaming nodes as done
  if (chat) {
    Object.values(chat.nodes).forEach(n => {
      // 只写 content 是不够的：正文一个字没出、但思考已经在流的时候按停止，
      // blocks 里已经有 [{type:'thinking'}]，而渲染在 blocks 非空时完全不看 content
      //（06-render-msg.js 的 `else if (m.blocks?.length)`）→ 她看到的是一个只有折叠 💭、
      // 正文区空白的气泡，「已停止生成」一个字都没有。appendWarnBlock 两边一起写。
      if (n.streaming) {
        n.streaming = false;
        if (!n.content) appendWarnBlock(n, '已停止生成');
      }
      if (n.variants) {
        n.variants.forEach(v => {
          if (v.streaming) {
            v.streaming = false;
            if (!v.content) appendWarnBlock(v, '已停止');
          }
        });
      }
    });
    save(); renderMessages(); renderChatList();
  }
  updateStreamUI();
}

let longPressTimer = null;
let _lastTouchX = 0, _lastTouchY = 0;
// ═══════════════════════════════════════════════════════
// INDEXEDDB 存储层（替代 localStorage）
// ═══════════════════════════════════════════════════════
// 沉浸背景的合法取值。**唯一真源**：持久化的三道关（这里的 loadStateFromDB、
// 02-state 的 _doSave、14-boot 的启动赋值）和 24-music 的轮换顺序都从这里取。
// 三处各抄一份字面量的话，加新模式时漏掉任何一处，那个模式选了就存不住，
// 而且零报错——刷新一下自己弹回 aurora，看着像"设置没保存"。
// 定义在 01-core 是因为它加载最早（01 < 02 < 14 < 24），后面几道门都引用得到。
const MUSIC_VIS_MODES = ['aurora', 'fluid', 'geo', 'off'];
function musicVisNorm(v) { return MUSIC_VIS_MODES.indexOf(v) >= 0 ? v : 'aurora'; }

// 歌词的排版方式。同上，唯一真源。
//   scroll  一行一句，从下往上滚（原来那套）
//   tilt    一句拆成 1~4 段错落排布，其中一段斜体放大（偷自 folia-major 的 Tilt）
//   cinema  只留当前一句，超大字横排、逐字高低错落互相压着，镜头跟着唱到的字横移
const MUSIC_LYRIC_STYLES = ['scroll', 'tilt', 'cinema'];
function musicLyricStyleNorm(v) { return MUSIC_LYRIC_STYLES.indexOf(v) >= 0 ? v : 'scroll'; }

const DB_NAME = 'KuroDB', DB_VER = 1, STORE = 'kv';
let _db = null;
let _dbOpenPromise = null;

async function openDB() {
  if (_db) return _db;
  if (_dbOpenPromise) return _dbOpenPromise;
  const attempt = () => new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = e => {
      const db = e.target.result;
      db.onversionchange = () => { db.close(); if (_db === db) _db = null; };
      _db = db; resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被另一个窗口占用'));
  });
  _dbOpenPromise = (async () => {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await attempt(); }
      catch (e) {
        last = e; _db = null;
        if (i < 2) await new Promise(r => setTimeout(r, 180 * (i + 1)));
      }
    }
    throw last;
  })();
  try { return await _dbOpenPromise; }
  finally { _dbOpenPromise = null; }
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE,'readwrite').objectStore(STORE).put(val, key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function idbDel(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE,'readwrite').objectStore(STORE).delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
// 启动时从 IndexedDB 加载 state，同时兼容旧 localStorage 数据迁移

/* 表情分组的跨设备合并 —— 照搬这个文件里 favGroups 那套 LWW-Element-Set，别再自己发明。

   跟 stickerNotes 那种「本地优先 Object.assign」不是一回事：备注几乎不删，分组会删，
   而整包合并**传不过去删除** —— 这台删掉的，另一台的旧值会原样送回来（删了又活）。

   ⚠️ 我在这儿错过两版，都是 Codex 打回来的，别再改回去：
   ① 本地优先整包合并 —— 删除不收敛。
   ② 用 Date.now() 当版本比大小 —— **时间戳靠设备时钟**，一台机器时钟快一年就能长期
      压住另一台，它之后所有真实的改名/移组/删除全都输。favGroups 当年踩的就是这个，
      注释还在上面躺着。版本必须是**逻辑计数器**（state.stickerGroupsVer，每次写 +1，
      合并时取 max），跟墙钟无关。
   ③ 墓碑 90 天过期 —— 也是错的：A 删掉、B 离线超过 90 天，云端墓碑被清掉之后
      B 一上线就把那个分组原样推回来。量级才几十条，不值得为它冒这个险，**不清理**。

   存活判定走 ops 表：a = 最后一次新建的版本，d = 最后一次删除的版本，a >= d 即存活
   （撞平偏向保留）。两边逐个取 max，结果与同步先后无关。
   属性（名字/图标）另算：取条目自己的 v 大的那份，v 撞平时按 id 排序决定，保证两台设备
   算出来的是同一个结果（不确定的平局规则会让两边长期显示不同的名字）。 */
function _stkOpKey(g) { return (g && g.pack ? 'p:' : 'g:') + (g && g.id); }
/* 思考链那把锁的跨设备合并：ver 大的赢；ver 撞平时**两边都同意才算同意**。
   撞平偏向糊着，理由有两层：一是两台设备算出的结果必须一样（确定性，不许依赖
   谁先同步），二是偏错的方向代价不对称 —— 留着一个本该撤回的「同意」是真的把
   它的内心漏出去了，留着一个本该生效的「同意」她再问一次就好。
   ver 是逻辑计数器不是时间戳（时钟快的那台会长期压住另一台，favGroups 那段
   注释里记着同一个坑）。 */
function _mergeThinkOpen(aOn, aVer, bOn, bVer) {
  const av = aVer || 0, bv = bVer || 0;
  if (av > bv) return { on: !!aOn, ver: av };
  if (bv > av) return { on: !!bOn, ver: bv };
  return { on: !!aOn && !!bOn, ver: av };
}

function _mergeStickerGroupState(local, cloud) {
  const ops = Object.create(null);     // 组 id 可能就叫 __proto__，普通 {} 会把它写丢
  const see = (k, a, d) => {
    const c = ops[k] || { a: 0, d: 0 };
    ops[k] = { a: Math.max(c.a, a || 0), d: Math.max(c.d, d || 0) };
  };
  for (const src of [(local && local.ops) || {}, (cloud && cloud.ops) || {}]) {
    for (const k of Object.keys(src)) see(k, (src[k] || {}).a, (src[k] || {}).d);
  }
  /* 属性：v 大的赢；v 一样时拿**内容**排，两台设备才会算出同一个结果。
     ⚠️ 别再写成按 id 排（我写过一版，Codex 三审逮到）：能进到同一个 attr[k] 的记录
     必然是同一个 id，那个比较永远为假，实际退化成「先遍历到的赢」——
     于是 _merge(本地, 云端) 和 _merge(云端, 本地) 会得出不同的名字，
     两台设备各显示各的，而且怎么同步都不收敛。 */
  const attrKey = g => JSON.stringify([String(g.name == null ? '' : g.name), String(g.icon == null ? '' : g.icon)]);
  const attr = Object.create(null);
  for (const g of [...((cloud && cloud.groups) || []), ...((local && local.groups) || [])]) {
    if (!g || !g.id) continue;
    const k = _stkOpKey(g);
    // 老数据没有 ops 表：一律补成「0 版建的」，0 >= 0 成立所以它们存活，
    // 等价于这次改动之前的行为 —— 升级/新设备第一次同步不会凭空少掉分组。
    if (!ops[k]) see(k, 0, 0);
    const cur = attr[k];
    if (!cur || (g.v || 0) > (cur.v || 0) || ((g.v || 0) === (cur.v || 0) && attrKey(g) < attrKey(cur))) attr[k] = g;
  }
  const groups = Object.keys(ops)
    .filter(k => ops[k].a >= ops[k].d && attr[k])
    .map(k => attr[k]);
  const ver = Math.max((local && local.ver) || 0, (cloud && cloud.ver) || 0);
  return { groups, ops, ver };
}
/* 归属表：每条 { g: 分组id 或 null, v: 逻辑版本 }。g=null 是「已移出」的墓碑，同样不清理 ——
   清掉它，另一台的旧归属就会把这张表情重新塞回分组里。老的裸字符串格式当 0 版处理。*/
function _mergeStickerGroupOf(a, b) {
  const norm = v => (v == null ? null : (typeof v === 'string' ? { g: v, v: 0 } : { g: v.g == null ? null : v.g, v: v.v || 0 }));
  const out = Object.create(null);
  for (const src of [a || {}, b || {}]) {
    for (const k of Object.keys(src)) {
      const cur = out[k], nv = norm(src[k]);
      if (!nv) continue;
      // 平局时按 g 排序，保证两台设备收敛到同一个结果（null 当空串排最前）
      if (!cur || nv.v > cur.v || (nv.v === cur.v && String(nv.g || '') < String(cur.g || ''))) out[k] = nv;
    }
  }
  return out;
}

/* 「这张表情不给 AI 用」：表情名 → { off, v }，v 是 _bumpGroupVer 那个逻辑计数器（跟分组共用，
   它本来就跟着账号同步、合并取 max，拿来当时钟正好）。
   ⚠️ 不能照抄 stickerNotes 那套「本地优先 Object.assign」：备注几乎只加不改，开关却会关了又开。
   本地优先的话，手机上关掉、电脑上再打开，两台各自坚持自己的值、每次同步互相覆盖，
   打开这个动作永远传不过去 —— 所以逐条比版本，「打开」也是一条带版本的记录（off:false），不是删键。
   版本撞平时 off 赢（拿不准就先别给 AI 用），两台设备收敛到同一个结果。
   老数据里没有这张表 = 全部给 AI 用。 */
function _mergeStickerAiOff(a, b) {
  const norm = v => (v == null ? null : (typeof v === 'object' ? { off: !!v.off, v: v.v || 0 } : { off: !!v, v: 0 }));
  const out = Object.create(null);
  for (const src of [a || {}, b || {}]) {
    for (const k of Object.keys(src)) {
      const cur = out[k], nv = norm(src[k]);
      if (!nv) continue;
      if (!cur || nv.v > cur.v || (nv.v === cur.v && nv.off && !cur.off)) out[k] = nv;
    }
  }
  return out;
}

async function loadStateFromDB() {
  const keys = ['kuro_chats','kuro_configs','kuro_memories','kuro_trash',
                 'kuro_autoMemory','kuro_bg','kuro_brightness','kuro_accent','kuro_themeTemperature','kuro_fontPreset',
                 'kuro_aiFontSize','kuro_userFontSize','kuro_webSearchKey','kuro_activeChat','kuro_bgBlur','kuro_uiBlur','kuro_recentMemos'];
  // 若 IndexedDB 里没数据，尝试从旧 localStorage 迁移
  const chatsInDB = await idbGet('kuro_chats');
  if (chatsInDB === null) {
    try {
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v !== null) await idbSet(k, v);
      }
    } catch(e) { console.warn('localStorage 迁移跳过（file:// 协议受限）:', e.message); }
  }
  const g = async (k, fallback) => {
    const v = await idbGet(k);
    if (v === null) return fallback;
    try { return JSON.parse(v); } catch { return v; }
  };
  // 自由文本字段是原样存的（不过 JSON.stringify）。走 g 的话用户名「520」读回来变数字、
  // 「null」变 null，后面一 .trim() 就抛。parse 出字符串才用（兼容以前 stringify 过的旧值），否则原样。
  const gs = async (k, fallback) => {
    const v = await idbGet(k);
    if (v === null) return fallback;
    try { const p = JSON.parse(v); return typeof p === 'string' ? p : String(v); } catch { return String(v); }
  };
  return {
    chats:         await g('kuro_chats', null),
    configs:       await g('kuro_configs', null),
    // configs 的跨设备版本号。持久化三道关的第 2 道；漏了就是「模型配置刷新后
    // 被云端旧值冲回去」，而且零报错（见 02-state.js configsVer 那段注释）
    configsVer:    Number(await g('kuro_configsVer', 0)) || 0,
    memories:      await g('kuro_memories', []),
    recentMemos:   await g('kuro_recentMemos', []),
    trash:         await g('kuro_trash', []),
    // 对话墓碑。⚠️ 持久化三道关的第 2 道，漏了就是「删掉的对话刷新后又回来」，零报错
    deletedChats:  await g('kuro_deletedChats', {}),
    autoMemory:    await g('kuro_autoMemory', false),
    background:    await gs('kuro_bg', ''),
    brightness:    parseFloat(await g('kuro_brightness', 0.88)),
    accentColor:   await g('kuro_accent', '#c89555'),
    themeTemperature: await g('kuro_themeTemperature', 'warm'),
    customBg:      await gs('kuro_customBg', ''),
    customText:    await gs('kuro_customText', ''),
    echoOpacity:   parseFloat(await g('kuro_echoOpacity', 1)),
    fontPreset:    await g('kuro_fontPreset', 'simsun'),
    uiShape:       await g('kuro_uiShape', 'soft'),
    bgAutoTint:    await g('kuro_bgAutoTint', false),
    bgLegibility:  await g('kuro_bgLegibility', 'auto'),
    aiFontSize:    parseFloat(await g('kuro_aiFontSize', 17)),
    userFontSize:  parseFloat(await g('kuro_userFontSize', 17)),
    bgBlur:        parseFloat(await g('kuro_bgBlur', 3)),
    uiBlur:        parseFloat(await g('kuro_uiBlur', 28)),
    webSearchApiKey: await gs('kuro_webSearchKey', ''),
    webSearchProvider: await g('kuro_webSearchProvider', 'tavily'),
    tenorApiKey: await gs('kuro_tenorKey', ''),
    thinkSumKey: await gs('kuro_thinkSumKey', ''),
    voiceApiKey: await gs('kuro_voiceKey', ''),
    voiceProvider: await g('kuro_voiceProvider', 'deepgram'),
    voiceApiBase:  await gs('kuro_voiceBase', ''),
    voiceModel:    await gs('kuro_voiceModel', ''),
    callBg:        await gs('kuro_callBg', ''),
    callBgMask:    await g('kuro_callBgMask', 0.82),
    callBgBlur:    await g('kuro_callBgBlur', 2),
    activeChatId:  await g('kuro_activeChat', null),
    bandAiEnabled: await g('kuro_bandAi', true),
    bandAutoFetch: await g('kuro_bandAuto', false),
    callDnd:       await g('kuro_callDnd', false),
    ccMemoryEnabled: await g('kuro_ccMemory', false),
    typingRhythmEnabled: await g('kuro_typingRhythm_on', true),
    typingDraftPeek: await g('kuro_typingDraftPeek', false),
    userAvatar:    await gs('kuro_userAvatar', ''),
    showUserAvatar: await g('kuro_showUserAvatar', false),
    inkStream:     await g('kuro_inkStream', true),
    inkRate:       await g('kuro_inkRate', 14),
    favMessages:   await g('kuro_favMsgs', []),
    favGroups:     await g('kuro_favGroups', []),
    favGroupsVer:  Number(await g('kuro_favGroupsVer', 0)) || 0,
    favGroupOps:   await g('kuro_favGroupOps', {}),
    userName:      await gs('kuro_userName', ''),
    userNameAiVisible: await g('kuro_userNameAi', true),
    stickerNotes:  await g('kuro_stickerNotes', {}),
    stickerAiOff:  await g('kuro_stickerAiOff', {}),
    stickerGroups: await g('kuro_stickerGroups', []),
    stickerGroupOf:await g('kuro_stickerGroupOf', {}),
    stickerGroupsVer: Number(await g('kuro_stickerGroupsVer', 0)) || 0,
    stickerGroupOps: await g('kuro_stickerGroupOps', {}),
    thinkOpen:     await g('kuro_thinkOpen', false),
    thinkOpenVer:  Number(await g('kuro_thinkOpenVer', 0)) || 0,
    brainMemories: await g('kuro_brainMems', []),
    brainRerank:   await g('kuro_brainRerank', true),
    webDockSrc:    await gs('kuro_webDockSrc', ''),
    webDockItems:  await g('kuro_webDockItems', []),
    webDockRemote: await g('kuro_webDockRemote', []),
    webDockSyncAt: parseInt(await g('kuro_webDockSyncAt', 0)) || 0,
    proustMems:    await g('kuro_proustMems', []),
    proustGate:    await g('kuro_proustGate', {}),
    peekGate:      await g('kuro_peekGate', {}),
    vitalsOn:      await g('kuro_vitalsOn', true),
    vitalsHeartbeatOn: await g('kuro_vitalsHeartbeatOn', false),
    vitalsByModel: await g('kuro_vitalsByModel', {}),
    vitalsSleepPref: await g('kuro_vitalsSleepPref', null),
    dreamsOn:      await g('kuro_dreamsOn', false),
    dreamsByModel: await g('kuro_dreamsByModel', {}),
    dreamGateByModel: await g('kuro_dreamGateByModel', {}),
    dreamMaterialCooldowns: await g('kuro_dreamMaterialCooldowns', {}),
    ttsVoice:      await g('kuro_ttsVoice', 'zh-CN-XiaoxiaoNeural'),
    ttsVoiceZh:    await g('kuro_ttsVoiceZh', 'zh-CN-XiaoxiaoNeural'),
    ttsRate:       parseInt(await g('kuro_ttsRate', 0)) || 0,
    ttsPitch:      parseInt(await g('kuro_ttsPitch', 0)) || 0,
    modelDiaries:  await g('kuro_modelDiaries', {}),
    diaryHandover: await g('kuro_diaryHandover', {}),
    diaryEnabled:  await g('kuro_diaryEnabled', false),
    diaryDevView:  await g('kuro_diaryDevView', false),
    nurseryOn:     await g('kuro_nurseryOn', false),
    nurseryName:   await gs('kuro_nurseryName', ''),
    engawaOn:      await g('kuro_engawaOn', false),
    errandWorker:  await gs('kuro_errandWorker', ''),
    studyOn:       await g('kuro_studyOn', false),
    studyCards:    await g('kuro_studyCards', []),
    studyGroupSize: await g('kuro_studyGroupSize', 10),
    studyGroupIds:  await g('kuro_studyGroupIds', []),
    studyLastKind:  await g('kuro_studyLastKind', 'new'),
    studyBook:      await g('kuro_studyBook', null),
    studyGone:      await g('kuro_studyGone', {}),
    studySeen:      await g('kuro_studySeen', {}),
    musicOn:       await g('kuro_musicOn', false),
    skillsOff:     await g('kuro_skillsOff', {}),
    musicRecent:   await g('kuro_musicRecent', []),
    musicFav:      await g('kuro_musicFav', []),
    uedOn:          await g('kuro_uedOn', true),
    coreadOn:       await g('kuro_coreadOn', true),
    mistakes:       await g('kuro_mistakes', []),
    fcards:         await g('kuro_fcards', {}),
    lifeOn:         await g('kuro_lifeOn', true),
    lifeCycleShare: await g('kuro_lifeCycleShare', true),
    lifeReceipts:   await g('kuro_lifeReceipts', {}),
    lifePeriods:    await g('kuro_lifePeriods', []),
    lifeAnnivs:     await g('kuro_lifeAnnivs', []),
    lifePromises:   await g('kuro_lifePromises', []),
    moments:        await g('kuro_moments', []),
    // 只存索引。图本体在 kuro_bubtheme_<id> 里单独放 ——
    // 一个主题连背景图能到 800KB，塞进 state 的话每次 save() 都要重写一遍。
    bubbleThemes:   await g('kuro_bubbleThemes', []),
    bubbleTheme:    await g('kuro_bubbleTheme', ''),
    bubbleThemeBg:  await g('kuro_bubbleThemeBg', true),
    musicPlaylists: await g('kuro_musicPlaylists', []),
    musicSearchHist: await g('kuro_musicSearchHist', []),
    musicSyncOps:    await g('kuro_musicSyncOps', {}),
    musicLyricTrans: await g('kuro_musicLyricTrans', true),
    musicLyricRoma:  await g('kuro_musicLyricRoma', false),
    musicVis:        await g('kuro_musicVis', 'aurora'),
    musicLyricStyle: await g('kuro_musicLyricStyle', 'scroll'),
    worldbook:     await g('kuro_worldbook', null),
    wishbook:      await g('kuro_wishbook', []),
  };
}
// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let _nodeIdCounter = 0;
function nextId() { return ++_nodeIdCounter; }

// 🛡️ id 计数器重播种：对话 id / 消息 id / 配置 id 全从同一个 nextId() 取号。
// 历史 bug：启动只按「消息 id」播种，漏了「对话 id」——一个刚建、还没长出更大消息 id 的新对话，
// 它的对话 id 会高于当前所有消息 id；重启后计数器退回消息 id 的最大值，下一个新对话就会拿到同一个
// 号 → 两个对话撞成同 id → mergeCloudChats 按 id 去重时静默吞掉一个（就是「(蹭过来」丢失的机制）。
// 修法：把对话 id、配置 id 也并进计数器，nextId() 永远不会再发出与现有 id 相同的号。
function reseedIdCounter() {
  let mx = _nodeIdCounter || 0;
  (state.chats || []).forEach(chat => {
    mx = Math.max(mx, parseInt(chat.id) || 0);
    for (const id in (chat.nodes || {})) mx = Math.max(mx, parseInt(id) || 0);
  });
  const seeArr = arr => (Array.isArray(arr) ? arr : []).forEach(x => { if (x) mx = Math.max(mx, parseInt(x.id) || 0); });
  seeArr(state.configs);
  seeArr(state.moments);
  // 记忆类也从 nextId() 取号：漏了的话重启后新记忆撞上旧 id，filter(m => m.id !== id) 一删删两条
  seeArr(state.memories); seeArr(state.recentMemos); seeArr(state.brainMemories);
  (state.chats || []).forEach(chat => seeArr(chat.groupBoard));
  // 墓碑：删掉的对话 id 如果被新对话再用上，新对话会被当成「已删」永远不上云，零报错
  for (const k of Object.keys(state.deletedChats || {})) mx = Math.max(mx, parseInt(k) || 0);
  // 回收站：单条消息 / 记忆恢复时保留原 id，这些号也不能再发出去
  (state.trash || []).forEach(it => {
    if (!it) return;
    mx = Math.max(mx, parseInt(it.message && it.message.id) || 0, parseInt(it.memoryData && it.memoryData.id) || 0,
      parseInt(it.chatData && it.chatData.id) || 0);
  });
  _nodeIdCounter = mx;
}

// 启动时把上次没收完的回复（含多模型变体）解除 streaming，返回处理的条数。
// 电脑上还能接回的活（agentRunId 未销账）只清标志不加提示 —— 找回时会整条覆写。
function clearStaleStreaming(chats) {
  let n = 0;
  (chats || []).forEach(chat => {
    if (!chat || !chat.nodes) return;
    const recoverable = !!(chat.agentRunId && !chat.agentRunClaimed);
    const fix = node => {
      if (!node || !node.streaming) return;
      node.streaming = false; n++;
      if (!recoverable && typeof appendWarnBlock === 'function') appendWarnBlock(node, '上次没收完（生成途中页面被关掉了）');
    };
    Object.values(chat.nodes).forEach(node => {
      fix(node);
      if (node && Array.isArray(node.variants)) node.variants.forEach(fix);
    });
  });
  return n;
}

// 🛡️ 同 id 对话去重修复：历史数据里若已经有两个对话共用一个 id，它们正处在「下次 merge 就会丢一个」
// 的危险里。这里给靠后的那个重新发一个安全号（reseed 之后 nextId() 保证不撞），并把指向本对话内
// 实际存在消息的收藏迁到新 id 上。返回修复的条数。务必在 reseedIdCounter() 之后调用。
function dedupeChatIds() {
  const seen = new Set();
  let fixed = 0;
  (state.chats || []).forEach(chat => {
    if (chat.id == null) chat.id = nextId();
    if (seen.has(chat.id)) {
      const oldId = chat.id, newId = nextId();
      (state.favMessages || []).forEach(f => {
        if (f.chatId === oldId && chat.nodes && chat.nodes[f.nodeId]) f.chatId = newId;
      });
      chat.id = newId;
      fixed++;
    }
    seen.add(chat.id);
  });
  return fixed;
}
// 移动端布局判断：与 CSS 断点保持一致（≤768px 或 手机横屏矮屏）
function isMobileLayout() {
  return window.innerWidth <= 768 || (window.innerHeight <= 500 && window.matchMedia('(orientation: landscape)').matches);
}

// 「这台设备上 Enter 该发送还是该换行」——**主聊天框和编程工作台必须共用同一份判据**。
//
// 这段原本是写死在 handleInputKeydown（13-trash-ctx-ui.js）里的一行。用户要
// 工作台也能 Enter 发送，抽出来共用而不是抄第二份：抄的话两处迟早漂移，
// 而漂移的表现是「同一个软件里回车行为不一样」，查起来还得先想到有两份。
// 判据本身**一个字没改**，只是搬了个家。
//
// ⚠️ 跟上面的 isMobileLayout() 不是一回事，**别合并**：那个是 CSS **布局**断点（≤768px），
//   不看 UA 也不看触摸，桌面把窗口拉窄就会为真 —— 拿它判 Enter 的话，
//   电脑上把窗口缩小一点，回车就突然不发送了，而且完全没有提示。
function isMobileComposer() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || ('ontouchstart' in window && window.innerWidth <= 900);
}


// ── 拖放兜底：不许把文件拖出一次「整页被换掉」 ───────────────────────────
//
// 2026-08-28 做工作台拖文件时逮到的既有洞（不是新功能引入的）：
// 往窗口里任何一处**没有 drop 处理器**的地方拖一个文件，浏览器/Electron 的默认动作
// 是**导航到那个文件**。代价不是不好看，是整个页面被换成一张图或一段 JSON ——
// 没发出去的输入、滚动位置、打开着的弹窗全丢，exe 里还得重开。
//
// 这里挡的是「默认行为」，不抢任何人的活：各处自己的 drop 处理器（聊天输入框、
// 工作台）都在更靠内的元素上，冒泡到 window 之前早就跑完了，它们照常工作。
// dragover 和 drop **两个都要挡**：只挡 drop 的话，dragover 没被 preventDefault，
// 目标区域根本不算可放置区，drop 事件不会派发，导航照样发生。
['dragover', 'drop'].forEach(type => window.addEventListener(type, e => e.preventDefault()));
