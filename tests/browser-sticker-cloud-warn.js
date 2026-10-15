// 「云端收藏拉不到时不许再静默」的**浏览器**冒烟测试（真跑 loadStickers + renderLocalStickers）。
//
// 起因（2026-08-21）：用户说「收藏的表情包全丢了，只剩表情库里的」。
// 实际一张都没丢 —— 35 张全在 Supabase 的 stickers 桶里躺着，是前端拉不到：
// loadCloudStickers() 掉登录 / 超时的时候 `return []`，只 console.warn 一句，
// 收藏栏就安安静静变成空的，空状态还写着「还没有收藏的表情」——一句假话。
// 这个 bug 全部的伤害就是那份静默，所以守住的就是「必须吭声」。
//
// 为什么不是 *.test.js：要 headless Chrome + 一个跑着的 server，十几秒，
// 不适合混进秒回的静态断言里。但静态断言证明不了「条子真的渲染出来了」。
//
// 跑法：
//   1) 先起一个 server：  GRANCYAN_PORT=3098 node server.js
//   2) node tests/browser-sticker-cloud-warn.js
//   （端口可以用环境变量 STK_PORT 改）

const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9338;
const PORT = process.env.STK_PORT || 3098;
const URL = `http://127.0.0.1:${PORT}/`;

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'gc-stk-profile')}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', URL], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
    if (await ev(`typeof loadStickers === 'function' && typeof renderLocalStickers === 'function'`)) break;
    await sleep(400);
  }

  // 装一套假的云端：想让它成功就给列表，想让它失败就设 mode。
  // 真的打 Supabase 会把测试变成网络测试（网差就假红），这里只关心失败**之后**界面怎么表现。
  const installStub = `(()=>{
    window.__stk = { mode: 'ok', files: ['cloud_a.gif','cloud_b.gif'], listDelay: 0, uploadFails: false };
    window.__toasts = [];
    if (!window.__toastPatched) {           // 记下每条 toast 的**类型**，不然文案警告了颜色还是绿的也测不出来
      const orig = window.showToast;
      window.showToast = (msg, type = 'info', dur) => { window.__toasts.push({ msg, type }); return orig(msg, type, dur); };
      window.__toastPatched = true;
    }
    // 拖慢 **server 那一路** 的开关。装在这里而不是用到时才装 —— 第一版装晚了，
    // 用它的那条竞态用例里包装还不存在，延迟根本没生效（Codex 三审逮到的假绿）。
    if (!window.__fetchPatched) {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        if (String(u).includes('/api/stickers') && window.__serverDelayOnce) {
          const d = window.__serverDelayOnce; window.__serverDelayOnce = 0;
          await new Promise(r => setTimeout(r, d));
        }
        return origFetch(u, o);
      };
      window.__fetchPatched = true;
    }
    supabaseClient.storage.from = (b) => ({
      list: async () => {
        if (window.__stk.listDelay) await new Promise(r => setTimeout(r, window.__stk.listDelay));
        if (window.__stk.mode === 'error') return { data: null, error: { message: '假装网络炸了' } };
        if (window.__stk.mode === 'hang') return await new Promise(() => {});   // 永不 resolve，逼出 8s 超时
        return { data: window.__stk.files.map(n => ({ name: n })), error: null };
      },
      getPublicUrl: (p) => ({ data: { publicUrl: 'http://example.invalid/' + p } }),
      remove: async () => ({ error: null }),
      upload: async () => window.__stk.uploadFails ? { error: { message: '假装云端写不进去' } } : { error: null },
    });
    currentUser = { id: 'test-user' };
    _authChecked = true;
    return true;
  })()`;
  await ev(installStub);

  const favHtml = async () => ev(`(async()=>{
    await loadStickers();
    _stickerTab = 'fav';
    renderLocalStickers();
    return document.getElementById('stickerGrid').innerHTML;
  })()`);
  const hasWarn = h => h.includes('sticker-cloud-warn');

  console.log('\n[1] 云端正常：不许无缘无故挂条子');
  let h = await favHtml();
  t('云端拉到了 → 没有警示条', !hasWarn(h));
  t('云端的表情真的进了收藏栏', h.includes('cloud_a.gif'), h.slice(0, 200));

  console.log('\n[2] ❗云端报错：收藏栏必须吭声（这就是「表情全丢了」那个 bug）');
  await ev(`window.__stk.mode = 'error'`);
  h = await favHtml();
  t('挂出了警示条', hasWarn(h), h.slice(0, 300));
  t('说清楚了云端没加载出来', h.includes('云端收藏没加载出来'));
  // Codex 五审：这里原来断言的是「你云端的收藏还在，没有丢」——一句这一路证明不了的承诺
  // （它区分不了「桶里有但拉不到」和「本来就没同步过 / 换了账号」）。断言改成两件真事：
  // 说清这次没取到不等于丢了，且不许再出现那句绝对保证。
  t('❗说清「没取到 ≠ 丢了」', h.includes('不代表云端的收藏没了'), h.slice(0, 300));
  t('❗不给证明不了的绝对保证', !h.includes('还在，没有丢'), h.slice(0, 300));
  t('带了「重新加载」按钮', h.includes('retryCloudStickers'));
  t('❗不再假称「还没有收藏的表情」', !h.includes('还没有收藏的表情'), h.slice(0, 300));
  t('云端那两张确实不在了（不是靠缓存蒙混过去的）', !h.includes('cloud_a.gif'));

  console.log('\n[3] ❗8 秒超时那条路也算失败（真等 8 秒，别改小）');
  await ev(`window.__stk.mode = 'hang'`);
  const t0 = Date.now();
  h = await favHtml();
  const waited = Date.now() - t0;
  t('超时后同样挂条子', hasWarn(h), h.slice(0, 200));
  t('确实是走的超时（等够了 8 秒）', waited >= 7500, waited + 'ms');
  t('条子里带出了超时原因', h.includes('超时'), h.slice(0, 300));

  console.log('\n[4] 重新加载：真去点那颗按钮（不是直接调函数）');
  await ev(`window.__stk.mode = 'ok'`);
  const clicked = await ev(`(async()=>{
    const btn = document.querySelector('.sticker-cloud-warn button');
    if (!btn) return { clicked:false };
    btn.click();
    for (let i=0;i<60 && document.querySelector('.sticker-cloud-warn');i++) await new Promise(r=>setTimeout(r,100));
    return { clicked:true, html: document.getElementById('stickerGrid').innerHTML };
  })()`);
  t('条子上真有一颗点得着的按钮', clicked.clicked);
  t('点完条子没了', clicked.clicked && !hasWarn(clicked.html), (clicked.html || '').slice(0, 200));
  t('收藏也回来了', clicked.clicked && clicked.html.includes('cloud_a.gif'));

  console.log('\n[5] 掉登录：说的是「没登录」，给的是登录入口');
  await ev(`currentUser = null; _authChecked = true; _authCheckFailed = false;`);
  h = await favHtml();
  t('挂出了警示条', hasWarn(h), h.slice(0, 200));
  t('点名是没登录', h.includes('当前未登录'), h.slice(0, 300));
  t('给的是「去登录」不是「重新加载」', h.includes('去登录') && !h.includes('retryCloudStickers'));

  console.log('\n[6] ❗登录检查还没跑完时不许误报（否则每次开 App 都闪一下，真警告会被当噪音）');
  await ev(`currentUser = null; _authChecked = false;`);
  h = await favHtml();
  t('没挂条子', !hasWarn(h), h.slice(0, 200));
  // 这台电脑的 stickers-fav/ 里可能本来就有几张（那是本地服务器那一路），
  // 空状态文案得自己造个空列表才测得到 —— 别让它跟着磁盘上有几个文件飘。
  h = await ev(`(()=>{ _stickerList = []; _stickerTab='fav'; renderLocalStickers();
                       return document.getElementById('stickerGrid').innerHTML; })()`);
  t('这时候才轮到「还没有收藏的表情」', h.includes('还没有收藏的表情') && !hasWarn(h), h.slice(0, 200));

  console.log('\n[6b] ❗压制解除的那一刻要自己冒出来（Codex 二审逮到的）');
  // 只压不解 = 把真警告永久吃掉：她在登录检查跑完前打开了收藏栏（画的是「还没有收藏的表情」），
  // 随后 checkUser 确认没登录 —— 状态对了，DOM 还停在被压制的那一帧，没人再画一次。
  const lifted = await ev(`(async()=>{
    currentUser = null; _authChecked = false;
    await loadStickers();
    _stickerTab = 'fav'; renderLocalStickers();
    const before = document.getElementById('stickerGrid').innerHTML;
    // 走真实路径：checkUser 拿到「没有 session」的结论
    supabaseClient.auth.getSession = async () => ({ data: { session: null } });
    await checkUser();
    return { before, after: document.getElementById('stickerGrid').innerHTML, authChecked: _authChecked };
  })()`);
  t('前提成立：压制期间确实没条子', !hasWarn(lifted.before), lifted.before.slice(0, 150));
  t('checkUser 之后压制解除了', lifted.authChecked === true);
  t('❗条子自己冒出来了（不用等下一次操作）', hasWarn(lifted.after) && lifted.after.includes('当前未登录'),
    lifted.after.slice(0, 300));

  console.log('\n[9b] ❗作废轮的调用方不能把界面留在旧画面上（Codex 二审逮到的）');
  // 真实时序：收藏栏点「重新加载」发起 A，她转头又在搜索栏收藏了一张 → 发起更新的 B。
  // A 作废、B 提交。如果重绘全靠调用方自己补，A 的调用方画的是旧的、B 的调用方又没画，
  // 收藏栏就永久停在旧画面上。这里**不手动补重绘**，全靠 loadStickers 自己回调。
  const commit = await ev(`(async()=>{
    _authChecked = true; _stickerTab = 'fav';
    // 先让界面停在「云端失败」这一帧
    currentUser = { id:'test-user' }; window.__stk.mode = 'error';
    await loadStickers();
    const before = document.getElementById('stickerGrid').innerHTML;
    // A：慢（server 被拖住），云端仍失败
    const order = [];
    window.__serverDelayOnce = 1500;
    const a = loadStickers().then(() => order.push('A'));
    await new Promise(r => setTimeout(r, 50));
    // B：快，且云端好了
    window.__stk.mode = 'ok';
    const b = loadStickers().then(() => order.push('B'));
    await Promise.all([b, a]);
    // 故意不调 renderLocalStickers()：这一步就是要看 loadStickers 自己有没有把界面画对
    return { before, order, after: document.getElementById('stickerGrid').innerHTML };
  })()`);
  t('前提成立：起点是「云端失败」那一帧', hasWarn(commit.before));
  // 没有这一条，上面那句「A 轮慢」只是我的一厢情愿：第一版就是延迟没生效、A 其实先跑完，
  // 于是「作废轮不留旧画面」压根没测到（Codex 三审逮到的）。
  t('前提成立：A 真的后落地（= 真是作废轮）', JSON.stringify(commit.order) === '["B","A"]',
    JSON.stringify(commit.order));
  t('❗最终界面是提交轮的（条子没了）', !hasWarn(commit.after), commit.after.slice(0, 250));
  t('❗云端收藏画上去了', commit.after.includes('cloud_a.gif'), commit.after.slice(0, 250));

  console.log('\n[7] ❗本地还有收藏时也得挂条子（列表非空 ≠ 没出事）');
  // 这条最容易漏：本地服务器上有几张，收藏栏看着有东西，
  // 但云端那几十张没拉到 —— 不吭声她就以为自己只收藏过这几张。
  await ev(`currentUser = { id:'test-user' }; _authChecked = true; window.__stk.mode = 'error';`);
  h = await ev(`(async()=>{
    await loadStickers();
    _stickerList.push({ name:'local_x', desc:'local_x', emoji:'🖼', file:'local_x.gif',
                        url:'http://example.invalid/local_x.gif', custom:true, source:'server' });
    _stickerTab = 'fav';
    renderLocalStickers();
    return document.getElementById('stickerGrid').innerHTML;
  })()`);
  t('列表非空，条子照样在', hasWarn(h) && h.includes('local_x'), h.slice(0, 300));

  console.log('\n[8] 自带表情库那栏不受影响（别拿云端的事去吓人）');
  h = await ev(`(()=>{ _stickerTab='lib'; renderLocalStickers();
                       return document.getElementById('stickerGrid').innerHTML; })()`);
  t('自带库栏没有警示条', !hasWarn(h), h.slice(0, 200));

  console.log('\n[9] ❗两轮 loadStickers 并发：慢的那轮不许覆盖快的（Codex 一审逮到的）');
  // 真实时序：启动时 12-math-media.js 末尾先跑一轮（那会儿 currentUser 还是 null），
  // checkUser 认出登录后再跑一轮。先发的那轮如果落地更晚，就会把已经拿到的云端收藏盖掉，
  // 而状态还停在成功那轮的 ok —— 收藏栏空着、banner 不吭声，跟没修一样。
  const race = await ev(`(async()=>{
    _authChecked = true; window.__stk.mode = 'ok';
    // 慢的必须是 **server 那一路**：A 轮没登录，loadCloudStickers 压根不发 list 请求，
    // 拖延云端对它无效（第一版测试就栽在这，注掉 gen 检查照样全绿 = 假绿）。
    // 真实里拖住 A 轮的正是局域网 server —— 拿它开刀才复现得出来。
    // A 轮：未登录，且它的 server 请求被拖 1500ms → 保证它最后落地
    window.__serverDelayOnce = 1500;
    currentUser = null;
    const a = loadStickers();
    // B 轮：登录了、两路都快
    await new Promise(r => setTimeout(r, 50));
    currentUser = { id:'test-user' };
    const b = loadStickers();
    await Promise.all([b, a]);          // 等两轮都真的结束
    window.__serverDelayOnce = 0;
    _stickerTab = 'fav'; renderLocalStickers();
    return { names: _stickerList.map(s=>s.name), state: JSON.parse(JSON.stringify(_cloudStickerState)),
             html: document.getElementById('stickerGrid').innerHTML };
  })()`);
  t('❗慢的旧轮没把云端收藏盖掉', race.names.includes('cloud_a'), JSON.stringify(race.names));
  t('状态和列表对得上（都是成功那轮的）', race.state.ok === true, JSON.stringify(race.state));
  t('收藏栏没有假警报', !hasWarn(race.html), race.html.slice(0, 200));

  console.log('\n[10] ❗后台 getUser() 判定会话失效：不能光清 currentUser 就完事（Codex 一审逮到的）');
  // 用户遇到的多半就是这条：缓存 session 先把收藏拉出来了，后台校验才发现 token 已经失效。
  // 以前只把 currentUser 清成 null，收藏栏还挂着上一轮 ok 的状态和已经显示出来的云端表情。
  // 关键时序：后台 getUser() 要**比 checkUser 自己那次 loadStickers 更晚**返回。
  // 不然 checkUser 末尾那次重载会顺手把状态刷对，掩盖住「失效分支什么都没做」这个 bug
  // —— 第一版就是这么假绿的（注掉修复照样全过）。
  const revoked = await ev(`(async()=>{
    currentUser = { id:'test-user' }; _authChecked = true; window.__stk.mode = 'ok';
    await loadStickers();
    const before = _stickerList.some(s => s.source === 'cloud');
    const origLoadFromCloud = loadFromCloud;
    loadFromCloud = async () => { await new Promise(r=>setTimeout(r,1200)); };   // 云端对话拉得慢
    supabaseClient.auth.getSession = async () => ({ data: { session: { user: { id:'test-user' } } } });
    supabaseClient.auth.getUser    = async () => {
      await new Promise(r=>setTimeout(r,1800));      // 比 loadFromCloud 和它后面那次 loadStickers 都晚
      return { data: { user: null } };
    };
    _authChecked = false;                 // 装回「刚启动、还没查登录」——不重置这一下，下面那条断言等于没测
    const done = checkUser();
    // checkUser 还卡在 loadFromCloud 里的时候，登录状态其实早就有结论了
    await new Promise(r=>setTimeout(r,600));
    const authCheckedDuringLoad = _authChecked;
    await done;
    for (let i=0;i<80 && (currentUser || _cloudStickerState.ok);i++) await new Promise(r=>setTimeout(r,100));
    _stickerTab = 'fav'; renderLocalStickers();
    loadFromCloud = origLoadFromCloud;
    return { before, authCheckedDuringLoad, user: currentUser,
             state: JSON.parse(JSON.stringify(_cloudStickerState)),
             html: document.getElementById('stickerGrid').innerHTML };
  })()`);
  t('前提成立：失效前云端收藏确实在栏里', revoked.before);
  t('❗_authChecked 没被 loadFromCloud 拖住（拖住 = 这期间真掉线也不吭声）',
    revoked.authCheckedDuringLoad === true);
  t('会话失效后 currentUser 被清掉', revoked.user === null);
  t('❗表情状态跟着刷成了「没登录」', revoked.state.ok === false && revoked.state.reason === 'logged-out',
    JSON.stringify(revoked.state));
  t('❗收藏栏当场就挂出了条子（不用等下次碰巧重载）', hasWarn(revoked.html) && revoked.html.includes('当前未登录'),
    revoked.html.slice(0, 300));

  console.log('\n[10c] ❗登录后的表情重拉不许被 loadFromCloud 挡住（Codex 三审逮到的）');
  // 她其实已经登录了，但启动那轮把状态记成了 logged-out。checkUser 认出登录之后如果先去
  // await loadFromCloud()（云端对话能卡几十秒、还可能抛错），这段时间收藏栏就一直挂着
  // 「当前未登录」——对已登录的人说她没登录，比不吭声更糟。loadFromCloud 抛错时更是永远轮不到重拉。
  const notBlocked = await ev(`(async()=>{
    currentUser = null; _authChecked = false; window.__stk.mode = 'ok';
    await loadStickers();                       // 启动轮：记成 logged-out
    const origLoadFromCloud = loadFromCloud;
    loadFromCloud = async () => { throw new Error('假装云端对话拉挂了'); };   // 顺带覆盖抛错那条路
    supabaseClient.auth.getSession = async () => ({ data: { session: { user: { id:'test-user' } } } });
    supabaseClient.auth.getUser    = async () => ({ data: { user: { id:'test-user' } } });
    await checkUser();
    for (let i=0;i<60 && !_cloudStickerState.ok;i++) await new Promise(r=>setTimeout(r,100));
    _stickerTab = 'fav'; renderLocalStickers();
    loadFromCloud = origLoadFromCloud;
    return { state: JSON.parse(JSON.stringify(_cloudStickerState)),
             html: document.getElementById('stickerGrid').innerHTML,
             authModalHidden: document.getElementById('authModal').classList.contains('hidden') };
  })()`);
  t('❗loadFromCloud 挂了也照样把云端收藏拉回来了', notBlocked.state.ok === true, JSON.stringify(notBlocked.state));
  t('❗没对着已登录的人说「当前未登录」', !hasWarn(notBlocked.html), notBlocked.html.slice(0, 250));
  // 少了这条就是假绿：表情全对、banner 也不吭声，界面却把登录框弹了出来
  // ——「云端对话拉挂了」被外层 catch 当成了「认证失败」（Codex 四审逮到的）。
  t('❗登录框没被弹出来（云端对话拉挂 ≠ 没登录）', notBlocked.authModalHidden === true);

  console.log('\n[10d] ❗登录状态「没查出来」不许说成「当前未登录」（Codex 四审逮到的）');
  // getSession 自己抛错时，她可能其实登录着。说她没登录 = 撒谎，还会把她引去重新登录，
  // 而真正的毛病在网络/存储 —— 一个错误的修复动作比不说话更坑。
  const unknownAuth = await ev(`(async()=>{
    currentUser = null; _authChecked = false; _authCheckFailed = false; window.__stk.mode = 'ok';
    await loadStickers();
    _stickerTab = 'fav'; renderLocalStickers();
    const before = document.getElementById('stickerGrid').innerHTML;
    // 前提：登录墙此刻是立着的（index.html 里 authModal 没挂 hidden，默认就铺满全屏）。
    // 不先断言这一条，下面「墙被放下了」可能只是因为它本来就没立起来 —— 那是假绿。
    const modal = document.getElementById('authModal');
    modal.classList.remove('hidden');
    const wallBefore = !modal.classList.contains('hidden');
    supabaseClient.auth.getSession = async () => { throw new Error('假装存储读不出来'); };
    await checkUser();
    return { before, after: document.getElementById('stickerGrid').innerHTML,
             failed: _authCheckFailed, checked: _authChecked,
             wallBefore, wallAfter: !modal.classList.contains('hidden') };
  })()`);
  t('前提成立：查之前没条子（压制中）', !hasWarn(unknownAuth.before), unknownAuth.before.slice(0, 150));
  t('前提成立：查之前登录墙是立着的', unknownAuth.wallBefore === true);
  t('标记成了「检查失败」', unknownAuth.failed === true && unknownAuth.checked === true);
  t('❗条子自己冒出来了（catch 分支也得重绘）', hasWarn(unknownAuth.after), unknownAuth.after.slice(0, 250));
  t('❗说的是「没查出来」不是「当前未登录」',
    unknownAuth.after.includes('登录状态没查出来') && !unknownAuth.after.includes('当前未登录'),
    unknownAuth.after.slice(0, 300));
  t('主按钮是「重试」', unknownAuth.after.includes('retryAuthAndStickers'));
  // Codex 五审逮到的：查不出来还立着登录墙 = 把可能正登录着的人锁在自己的本地数据外面，
  // 而且 authModal 铺满全屏没有关闭键，连上面那条子都被它盖住 —— 条子写得再对也没人看得见。
  t('❗登录墙被放下了（查不出来 ≠ 没登录，不许把人锁在外面）', unknownAuth.wallAfter === false);
  // 「还是去登录」是次要出路：万一她真的没登录，得留条路回登录页，不能只有重试。
  // 必须**真点一下**：只断言 HTML 里有这几个字的话，onclick 被删掉/拼错/不再摘 hidden，
  // 按钮就成了一颗按下去毫无反应的死键，而测试照样全绿（Codex 六审逮到的假绿）。
  const backToLogin = await ev(`(async()=>{
    const modal = document.getElementById('authModal');
    const wallBefore = !modal.classList.contains('hidden');   // 前提：此刻墙是放下的
    const btns = Array.from(document.querySelectorAll('.sticker-cloud-warn button'));
    const btn = btns.find(b => b.textContent.includes('还是去登录'));
    if (!btn) return { found: false };
    btn.click();
    return { found: true, wallBefore, wallAfter: !modal.classList.contains('hidden') };
  })()`);
  t('条子上找得到「还是去登录」这颗按钮', backToLogin.found === true);
  t('前提成立：点之前墙是放下的', backToLogin.wallBefore === false);
  t('❗点下去真把登录墙叫回来了（验行为，不是验按钮上的字）', backToLogin.wallAfter === true);

  console.log('\n[11] ❗云端存不进去回退本地时，toast 得是警告色（文案警告、颜色还绿等于没警告）');
  const toasts = await ev(`(async()=>{
    // 还原成正常的登录态，云端 list 好使、但 upload 写不进去
    supabaseClient.auth.getSession = async () => ({ data: { session: null } });
    currentUser = { id:'test-user' }; _authChecked = true;
    window.__stk.mode = 'ok'; window.__stk.uploadFails = true;
    window.__toasts = [];
    const r = await uploadStickerBlob('t_degraded.gif', new Blob(['x'], { type:'image/gif' }));
    // 这一发是真写进了 stickers-fav/，别把垃圾留在用户的收藏夹里
    const del = await fetch(SERVER_BASE + '/api/sticker-delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ file:'t_degraded.gif' })
    }).then(x=>x.json()).catch(e=>({ ok:false, error:e.message }));
    return { r, del, toasts: window.__toasts };
  })()`);
  t('云端失败但本地存下了', toasts.r.ok === true, JSON.stringify(toasts.r));
  t('❗带上了 degraded 标记（调用方靠它选颜色，不是去解析中文）', toasts.r.degraded === true, JSON.stringify(toasts.r));
  t('文案点破了「其它设备看不到」', (toasts.r.where || '').includes('其它设备看不到'), toasts.r.where);
  t('这一发留下的临时表情已清掉', toasts.del.ok === true, JSON.stringify(toasts.del));

  // 走真实的 saveTenorGif：抓一张本机 server 上真存在的图（example.invalid 抓不到，
  // 会一路掉到「收藏失败」，测的就不是这条路了）。它会真的往 stickers-fav/ 写一个文件，测完删掉。
  const upToast = await ev(`(async()=>{
    window.__toasts = [];
    await saveTenorGif(location.origin + '/stickers/happy.png', 'degraded_tmp');
    const toasts = window.__toasts.slice();
    const del = await fetch(SERVER_BASE + '/api/sticker-delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ file:'tenor_degraded_tmp.gif' })
    }).then(r=>r.json()).catch(e=>({ ok:false, error:e.message }));
    return { toasts, del };
  })()`);
  t('❗saveTenorGif 报的是 warning 不是 success',
    upToast.toasts.some(x => x.type === 'warning') && !upToast.toasts.some(x => x.type === 'success'),
    JSON.stringify(upToast.toasts));
  t('测试留下的临时表情已清掉', upToast.del.ok === true, JSON.stringify(upToast.del));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
