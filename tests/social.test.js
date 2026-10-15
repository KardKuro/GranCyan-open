// 两扇国内窗（小红书 / B 站）+ 说话的闸。
//
// 写法同 engawa.test.js：能跑真函数就别验源码正则。
// sayCheck 是纯函数，直接 require 进来跑 —— **手抄一份规则来验是没意义的**，
// 那样改坏了 social-browser.js 这边照样绿（记忆：测试变绿≠测试有效）。
//
// ⚠️ 这份测试特意带**对照组**：每一条「该拦」的旁边都有一条「该放行」的。
// 只测拦得住、不测不误伤的话，一个 `return '拦'` 就能让全部断言变绿。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

// ⚠️⚠️ **必须在 require 之前**把账本/锁指到一个临时位置。
//   锁的测试要覆盖和删除锁文件；指着生产那把的话，「用户正在发评论时我跑了一遍测试」
//   就会把真持锁者的锁删掉，另一个进程立刻进入发送区 —— 测试自己造出并发评论
//   （Codex 三审逮到的）。而 fault-inject.js 会把整套跑十几遍，风险乘以十几。
const os = require('node:os');
const TMP_STATE = path.join(os.tmpdir(), `grancyan-say-test-${process.pid}.json`);
process.env.GRANCYAN_SAY_STATE = TMP_STATE;
// 收件箱同理。inboxNoteFailure 会**写盘**，指着生产那份的话，跑一遍测试就把
// 用户看板上的收件箱状态盖成一句假的报错。
const TMP_INBOX = path.join(os.tmpdir(), `grancyan-inbox-test-${process.pid}.json`);
process.env.GRANCYAN_XHS_INBOX = TMP_INBOX;
// 草稿本子同理。
const TMP_DRAFTS = path.join(os.tmpdir(), `grancyan-drafts-test-${process.pid}.json`);
process.env.GRANCYAN_XHS_DRAFTS = TMP_DRAFTS;
// 审计历史调小到 3，好让「截断不许吃掉去重凭据」这件事**用几条草稿就能跑出来**。
// （写死 40 的时候，那条断言只能去比常量大小 —— 而比常量是假绿，2026-08-28 故障注入逮到过。）
process.env.GRANCYAN_DRAFT_KEEP = '3';
// 禁词表里的人名按部署从环境变量来（代码里不内置任何人的名字），这里配一套测试用的：
// 用户叫「小明」（英文名 Alice，昵称「阿明」），AI 叫「克克」。
process.env.GRANCYAN_SAY_FORBIDDEN = '小明,Alice,alice,阿明,克克';

const {
  sayCheck, sayNormalize, SAY_MAX_LEN, SAY_DAILY_MAX, SAY_ALLOWED_SITES, SAY_SENDERS,
  SAY_COUNTS, saysToday, originOk, withSayLock, intEnv, healStaleSending, SENDING_STALE_MS,
  decideSayOutcome, STATE_FILE,
  inboxParse, inboxDiff, inboxNoteFailure, loadInbox, INBOX_FILE,
  draftCandidates, draftClean, draftIsSkip, draftUserPrompt, draftRedact, DRAFT_SYSTEM, mergeSpans,
  shouldCloseIdleChrome, CHROME_IDLE_MS, CHROME_GRACE_MS, withChromeBusy, chromeIdleState,
  ensureChrome, chromeAlive, touchChrome,
  DRAFT_MODEL, DRAFT_DAILY_MAX, DRAFT_FILE, DRAFT_KEEP, DRAFT_SEEN_KEEP, DRAFT_LIVE_MAX,
  healStaleGenerating, draftQuotaUsed,
  GENERATING_STALE_MS,
} = require(path.join(ROOT, 'social-browser.js'));

// 这条断言本身就是那道保险：万一哪天 STATE_FILE 不再认环境变量，
// 下面那些删锁的测试就会去删生产的锁 —— 那时候必须**先红在这里**，别真跑下去。
if (STATE_FILE !== TMP_STATE) {
  console.error('✗ 致命：测试没能把账本指到临时位置，拒绝继续（否则会动到生产锁）');
  process.exit(1);
}
if (INBOX_FILE !== TMP_INBOX) {
  console.error('✗ 致命：测试没能把收件箱指到临时位置，拒绝继续（否则会盖掉真的收件箱状态）');
  process.exit(1);
}
if (DRAFT_FILE !== TMP_DRAFTS) {
  console.error('✗ 致命：测试没能把草稿本子指到临时位置，拒绝继续');
  process.exit(1);
}
process.on('exit', () => {
  for (const f of [TMP_STATE, TMP_STATE + '.lock', TMP_INBOX, TMP_INBOX + '.tmp',
                   TMP_DRAFTS, TMP_DRAFTS + '.tmp']) { try { fs.unlinkSync(f); } catch { } }
});
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const engawaSrc = fs.readFileSync(path.join(ROOT, 'js', '40-engawa.js'), 'utf8');

// ── 闸：该放行的（对照组）────────────────────────────────
// 这一组要是被拦了，说明闸太紧 —— 那比漏更容易被忽略，因为症状是「他怎么老不说话」
console.log('说话的闸 · 该放行的:');
t('普通网友的一句话', sayCheck('这个也太好笑了哈哈哈') === '');
t('夸一句', sayCheck('楼主拍得真好看，收藏了') === '');
t('带表情和标点', sayCheck('救命😂 我笑了三分钟') === '');
t('提到别的名字不受影响', sayCheck('这段配乐是坂本龙一吧') === '');
t('刚好卡在长度上限', sayCheck('好'.repeat(SAY_MAX_LEN)) === '');

// ── 闸：该拦的 ────────────────────────────────
console.log('说话的闸 · 该拦的:');
t('空的', sayCheck('   ') !== '');
t('超一个字就拦', sayCheck('好'.repeat(SAY_MAX_LEN + 1)) !== '');
t('用户的名字', sayCheck('这个小明肯定喜欢') !== '');
t('用户的英文名', sayCheck('Alice 也这么说') !== '');
t('用户的昵称', sayCheck('阿明也这么说') !== '');
t('项目名', sayCheck('我在 GranCyan 里看到的') !== '');
t('AI 自己的名字', sayCheck('克克觉得这个不错') !== '');
t('http 链接', sayCheck('可以看这个 https://example.com/a') !== '');
t('光秃秃的域名', sayCheck('去 example.com 看看') !== '');
t('裸 IP', sayCheck('连 192.168.1.5 就行') !== '');
t('邮箱', sayCheck('发我 someone@mail.com') !== '');
t('手机号', sayCheck('加我 13800138000') !== '');

// 有意的误伤，写进断言名里（同「安全判据别枚举写法」那条教训：
// 有意误伤必须写在断言上，否则下一个人会把它当 bug「修掉」）。
// 代价是偶尔一条评论发不出去，收益是她的名字绝不会被带出门 —— 这个交换是划算的。
t('「小明星」被一起拦掉（有意的误伤，宁可发不出去也不带用户名字出门）',
  sayCheck('那个小明星的新歌') !== '');

// ⚠️ 闸挡不住的东西也要有断言钉住，免得以后误以为它是万无一失的：
t('挡不住叙述性的私事（已知边界，不是 bug）',
  sayCheck('我朋友昨天也因为这个哭了') === '');

// ── 在哪儿能说话：按**账号归属**定，不按技术难度定 ────────────────
// 小红书专门开了个号给AI用；B 站用的是她自己的号，
// 「b站你就先不用发评论了」。所以这两条断言守的是身份，不是功能。
console.log('能在哪儿说话:');
t('小红书能说（那是专门给 AI 开的号）', SAY_ALLOWED_SITES.has('xhs'));
t('B 站只看不说（那是用户本人的号，用它说话＝以用户的名义说话）', !SAY_ALLOWED_SITES.has('bili'));

// ── 两扇窗接进 GAZE 管线 ────────────────────────────────
console.log('两扇国内的窗:');
t('server 认得 xhs / bili 两个工具名', /SOCIAL_TOOLS\s*=\s*new Set\(\['xhs',\s*'bili'\]\)/.test(serverSrc));
t('走 /api/engawa 时先拦下这两扇窗', /if \(SOCIAL_TOOLS\.has\(name\)\)/.test(serverSrc));
t('报错词表把两扇窗也给模型', /allowed: \[\.\.\.ENGAWA_TOOLS, \.\.\.SOCIAL_TOOLS\]/.test(serverSrc));
t('国内站不走代理（套上外网代理是变错不是变慢）', /proxy: false/.test(serverSrc));
t('推荐流解析出 0 条要当失败抛，不能当"今天没内容"',
  /推荐流解析出 0 条/.test(serverSrc));
t('前端参数表有 xhs 的 id 和 bili 的 bv', /xhs: 'id',/.test(engawaSrc) && /bili: 'bv',/.test(engawaSrc));
t('前端有这两扇窗的中文名', /xhs: '小红书', bili: 'B 站'/.test(engawaSrc));
t('提示词教了正牌写法 [[GAZE: xhs]]', /\[\[GAZE: xhs\]\]/.test(engawaSrc));
t('提示词说清 id 只能从推荐流来（否则模型会瞎编 id）', /id 只能从刚刷过的推荐流里来/.test(engawaSrc));

// ── 通道的安全前提 ────────────────────────────────
console.log('浏览器通道:');
const sbSrc = fs.readFileSync(path.join(ROOT, 'social-browser.js'), 'utf8');
t('默认只认 loopback（server 监听的是 0.0.0.0）', /notLocal\(req, res\)/.test(sbSrc) && /127\.0\.0\.1/.test(sbSrc));
t('用独立 profile，不碰她日常那个 Chrome', /GRANCYAN_CHROME_DIR/.test(sbSrc) && /chrome-social/.test(sbSrc));
t('每条 CDP 命令自己带超时（少了它会静默挂死）',
  /waiting\.set\(mid/.test(sbSrc) && /\}, 30000\)/.test(sbSrc));
t('读的通道只开给这两家', /xiaohongshu\|bilibili/.test(sbSrc));
t('每天有硬上限，不是靠提示词自觉', /SAY_DAILY_MAX/.test(sbSrc) && /usedToday/.test(sbSrc));
t('一次只发一条（并发两条会同时读到 0，把每日上限绕过去）', /_sayBusy/.test(sbSrc));
t('发送前先确认按钮不再是灰的（否则点了也白点）', /没接受这次输入/.test(sbSrc));
// 2026-08-23 在判据上连栽两次，两次都是「问页面」：
//   ① 查整个 body.innerText —— 没发出去的那句还在输入框里，输入框也在 body 里；
//   ② 改查 .comment-item —— 页面做了乐观更新，前端先插进列表，服务端拒了也不撤。
// 结论：这件事只能问网络层。下面三条守着这个结论。
t('只认 comment/post 接口的响应，不认页面 DOM',
  /comment\/post/.test(sbSrc) && /Network\.getResponseBody/.test(sbSrc));
t('小红书拒绝时把它的原话报出来', /小红书拒绝了/.test(sbSrc));
t('审核中（status 2）不许报成已发表 —— 那种评论连自己都看不见',
  /'pending'/.test(sbSrc) && /c\.status === 2/.test(sbSrc));
t('status 字段缺失时不许 fail-open 成「公开」（平台改版就会这样）',
  /typeof c\.status === 'number'/.test(sbSrc) && /'unknown'/.test(sbSrc));
t('读不到响应＝unknown，不是「没发出去」', /e\.unknown = true/.test(sbSrc));
t('等的是 loadingFinished，不是 responseReceived（响应头到了 body 还没到）',
  /loadingFinished/.test(sbSrc) && /x\.done \|\| x\.failed/.test(sbSrc));
// ★ 「发出去了没有」的判定跑真函数。这一段前后被逮到三次，
//   每次都是**语义**错而不是字符串错，源码正则守不住（Codex 三审的原话：没有执行这个语义）。
console.log('发出去了没有（decideSayOutcome）:');
const OK = { success: true, data: { comment: { id: 'c1', status: 1 } } };
const NO = { success: false, msg: '被拒了' };
const JUNK = { __raw: '<html>网关错误</html>' };
t('一个请求，成功 → 已发出', decideSayOutcome(1, [OK]).kind === 'sent');
t('一个请求，明确失败 → 确定没发出去（可以退额度）', decideSayOutcome(1, [NO]).kind === 'rejected');
t('一个请求，读不到响应 → unknown', decideSayOutcome(1, []).kind === 'unknown');
t('一个请求，响应读不懂 → unknown', decideSayOutcome(1, [JUNK]).kind === 'unknown');
t('★ 两个请求，先成功后失败（重试场景）→ 已发出', decideSayOutcome(2, [OK, NO]).kind === 'sent');
t('★ 两个请求，先失败后成功 → 已发出', decideSayOutcome(2, [NO, OK]).kind === 'sent');
t('★ 两个请求，一个失败一个读不到 → unknown（**不许**退额度）',
  decideSayOutcome(2, [NO]).kind === 'unknown', decideSayOutcome(2, [NO]));
t('★ 两个请求，一个失败一个读不懂 → unknown',
  decideSayOutcome(2, [NO, JUNK]).kind === 'unknown');
t('两个请求，全都明确失败 → 确定没发出去', decideSayOutcome(2, [NO, NO]).kind === 'rejected');
t('一个请求都没发出去 → unknown（不是「没发出去」）', decideSayOutcome(0, []).kind === 'unknown');
t('拒绝时把平台原话带出来', decideSayOutcome(1, [NO]).j.msg === '被拒了');
t('点击前就失败的（没评论框 / 没 token）标 notSent，不占额度',
  /throw notSent\('这条笔记上没有评论框/.test(sbSrc) && /throw notSent\(`手上没有/.test(sbSrc));
// ⚠️ 这里原本写的是「源码里有没有 SENDING_STALE_MS」，故障注入把判断改成 if(false)
//   之后它照样绿 —— 源码字符串还在。廉价断言的活标本。改成跑真函数。
console.log('崩在半路的 sending:');
t('★ 超时的 sending 变 unknown（不能永远显示「正在发」）', (() => {
  const s = { says: [{ at: new Date(Date.now() - SENDING_STALE_MS - 1000).toISOString(), state: 'sending' }] };
  return healStaleSending(s).says[0].state === 'unknown';
})());
t('还在时限内的 sending 不动它（正在发的就是正在发）', (() => {
  const s = { says: [{ at: new Date().toISOString(), state: 'sending' }] };
  return healStaleSending(s).says[0].state === 'sending';
})());
t('别的状态一概不碰', (() => {
  const s = { says: [{ at: '2020-01-01T00:00:00.000Z', state: 'submitted' },
                     { at: '2020-01-01T00:00:00.000Z', state: 'notsent' }] };
  const r = healStaleSending(s).says;
  return r[0].state === 'submitted' && r[1].state === 'notsent';
})());
t('变成 unknown 之后照样占额度（不能因为崩了就白送一条）', (() => {
  const d = new Date().toLocaleDateString('sv-SE');
  const s = { says: [{ date: d, at: new Date(Date.now() - SENDING_STALE_MS - 1000).toISOString(), state: 'sending' }] };
  return saysToday(healStaleSending(s)).length === 1;
})());
t('响应体可能是 base64', /base64Encoded/.test(sbSrc));
t('挂载失败不影响其它功能', /浏览器通道挂载失败/.test(serverSrc));

// ── Codex 2026-08-23 那一轮（阻断 → 逐条改）────────────────────
// 这一组尽量**跑真函数**，不验源码正则。
console.log('跨站请求（Codex 逮到的真 CSRF）:');
const req = (origin, host) => ({ headers: { origin, host: host || '127.0.0.1:3000' } });
t('恶意网页的 Origin 一律拒', originOk(req('https://evil.example.com')) === false);
t('http 的恶意站也拒', originOk(req('http://evil.example.com')) === false);
t('畸形 Origin 判死不判活', originOk(req('not-a-url')) === false);
t('本机页面放行', originOk(req('http://127.0.0.1:3000')) === true);
t('localhost 也放行', originOk(req('http://localhost:3000')) === true);
// 拿这台机器**真实**的一个网卡地址来测。写死一个 IP 是不行的：
// 现在的判据要求 Host 真的是本机地址（挡 DNS rebinding），写死的 IP 换台机器就红。
const lanIp = (() => {
  for (const l of Object.values(require('node:os').networkInterfaces() || {})) {
    for (const ni of l || []) if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
})();
t('手机隔着局域网连过来（Origin 和 Host 一致、且确实是本机地址）放行',
  lanIp ? originOk(req(`http://${lanIp}:3000`, `${lanIp}:3000`)) === true : true, lanIp);
t('局域网 IP 对不上 Host 就拒（这条不能放水）',
  lanIp ? originOk(req('http://192.168.1.99:3000', `${lanIp}:3000`)) === false : true);
t('Host 是本机、但 Origin 是外站 → 拒',
  lanIp ? originOk(req('https://evil.example.com', `${lanIp}:3000`)) === false : true);
t('没有 Origin 的（curl / 探针）交给 loopback 那一关', originOk({ headers: {} }) === true);
t('说话的端点也走同一道闸', /if \(notLocal\(req, res\)\) return;/.test(
  sbSrc.slice(sbSrc.indexOf("app.post('/api/social-browser/say'"))));

console.log('环境变量不许静默关掉护栏:');
t('写错的值退回默认，不是 NaN', intEnv('__NOPE__', 3, 0, 20) === 3);
t('超出范围退回默认', (() => {
  process.env.__T1__ = '999'; const v = intEnv('__T1__', 3, 0, 20); delete process.env.__T1__; return v === 3;
})());
t('不是整数退回默认', (() => {
  process.env.__T2__ = 'three'; const v = intEnv('__T2__', 3, 0, 20); delete process.env.__T2__; return v === 3;
})());
t('合法值照常生效（别为了安全把功能也关了）', (() => {
  process.env.__T3__ = '5'; const v = intEnv('__T3__', 3, 0, 20); delete process.env.__T3__; return v === 5;
})());

// Codex 二审逮到的：光比「Origin 的 host == 请求的 Host」堵不住 DNS rebinding。
t('★ DNS rebinding：Origin 和 Host 都是 evil.example 也得拒',
  originOk(req('http://evil.example', 'evil.example')) === false);
t('★ 带端口的同名重绑定也拒',
  originOk(req('http://evil.example:3000', 'evil.example:3000')) === false);
t('非 http(s) 的 Origin 拒（file:// / chrome-extension:// 之类）',
  originOk(req('file://')) === false && originOk(req('chrome-extension://abc')) === false);

console.log('禁词绕过（规范化）:');
t('全大写绕不过去', sayCheck('ALICE 说的') !== '');
t('全角绕不过去', sayCheck('我在 ＧｒａｎＣｙａｎ 里看到的') !== '');
t('中间插零宽字符绕不过去', sayCheck('这个小​明肯定喜欢') !== '');
t('大小写混着也绕不过去', sayCheck('AliCE 也这么说') !== '');
t('带国家码和连字符的手机号', sayCheck('打 +86 138-0013-8000') !== '');
t('后缀不在老白名单里的域名（example.xyz）', sayCheck('去 example.xyz 看看') !== '');
// Codex 二审当场拿这三个绕过去了。补的时候一律改成「整类」而不是往清单里添几个。
t('★ U+2066 这类方向控制符也绕不过去（不许手抄控制符清单）',
  sayCheck('我在 Gran⁦Cyan 里看到的') !== '');
t('★ 变体选择符补充区 U+E0100 也绕不过去（只挡 FE00-FE0F 会漏）',
  sayCheck('Ali\u{e0100}ce 也这么说') !== '');
t('★ 长后缀域名（.photography 有 11 位，卡在 8 位就漏了）',
  sayCheck('看 secret.photography') !== '');
t('★ 非中国大陆的手机号（只认 1[3-9] 开头等于新加坡号随便贴）',
  sayCheck('打 +65 9123 4567') !== '');
t('规范化不影响正常中文（对照组）', sayCheck('这段配乐真好听，谁做的') === '');
t('规范化不影响正常英文（对照组）', sayCheck('this is so good lol') === '');
// 有意的误伤，写进断言名 —— 同「用户西」那条。宁可这句发不出去，
// 也不放过一个可能是永久公开地址的东西。
t('英文句号不加空格会被当域名拦掉（有意的误伤，不是 bug）',
  sayCheck('I like it.So good') !== '');

console.log('额度：哪些占、哪些不占:');
const mkSay = (state) => ({ date: new Date().toLocaleDateString('sv-SE'), state });
t('发送中的占额度（不然并发能绕过去）', saysToday({ says: [mkSay('sending')] }).length === 1);
t('审核中的占额度', saysToday({ says: [mkSay('pending')] }).length === 1);
t('提交成功的占额度', saysToday({ says: [mkSay('submitted')] }).length === 1);
t('★ 结果不确定的**也占**额度（判不出来就按发出去算）',
  saysToday({ says: [mkSay('unknown')] }).length === 1);
t('确定没发出去的不占额度', saysToday({ says: [mkSay('notsent')] }).length === 0);
t('昨天的不占今天的额度', saysToday({ says: [{ date: '2020-01-01', state: 'submitted' }] }).length === 0);
t('老记录（没有 state 字段）按已提交算，不会因为升级就白送额度',
  saysToday({ says: [{ date: new Date().toLocaleDateString('sv-SE') }] }).length === 1);

console.log('站点 → 发送函数必须查表:');
t('xhs 有实现', typeof SAY_SENDERS.xhs === 'function');
t('★ bili 没有实现 —— 就算被环境变量放进白名单，也不会错发到小红书',
  SAY_SENDERS.bili === undefined);

// 锁必须**真跑**。「源码里有 withSayLock」证明不了它互斥 ——
// Codex 阻断的第 2 条就是「进程内布尔量挡不住第二个进程」，
// 拿一条源码正则去守这个，等于什么都没守。
const LOCK = TMP_STATE + '.lock';   // 临时的那把，绝不是生产那把（见文件开头）
async function lockTests() {
  console.log('跨进程的锁:');
  const order = [];
  const job = (tag) => withSayLock(async () => {
    order.push(tag + '进');
    await new Promise(r => setTimeout(r, 220));
    order.push(tag + '出');
  });
  await Promise.all([job('A'), job('B')]);
  // 串行的话一定是「x进 x出 y进 y出」；交错就说明没锁住
  t('★ 两个并发的发送被串起来，不会同时进',
    /^(A进,A出,B进,B出|B进,B出,A进,A出)$/.test(order.join(',')), order.join(','));
  t('用完把锁文件删掉（留着的话下一次要等它过期）', !fs.existsSync(LOCK));

  // ★ 四审之后方向变了：**陈旧锁不再自动抢占**。
  //   自动抢占试过两版，两版都栽在同一处：`读 → 比较 → unlink` 不是原子的，
  //   删掉的可能是别人刚建好的新锁，于是两个人一起发评论。
  //   文件系统没有原子的条件删除，这条路补不干净，所以 fail-closed：
  //   宁可发不出去，也不能两个人同时发。代价是要人动手，那就必须把话说清楚。
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ owner: '崩掉的那个', pid: 99999, at: new Date().toISOString() }));
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(LOCK, old, old);
  let got = false, stuckMsg = '';
  try { await withSayLock(async () => { got = true; }); } catch (e) { stuckMsg = e.message; }
  t('★ 陈旧锁不自动抢（自动删有个补不干净的时序，会让两个人同时发评论）', got === false);
  t('★ 陈旧锁还在，没被删掉', fs.existsSync(LOCK));
  t('★ 报错里说清了「这是卡住了」，不是「上一条还在发」', /卡住/.test(stuckMsg), stuckMsg);
  t('★ 报错里给了要删的文件路径（fail-closed 要人动手，就得说清怎么动）',
    stuckMsg.includes(LOCK), stuckMsg);
  t('报错里带上持有者和卡了多久，好判断是不是真死了',
    /99999/.test(stuckMsg) && /\d+ 秒/.test(stuckMsg), stuckMsg);
  try { fs.unlinkSync(LOCK); } catch { }

  // 对照：**新鲜**的锁不该报「卡住了」—— 那是正常排队，不用惊动人
  fs.writeFileSync(LOCK, JSON.stringify({ owner: '正在发的那个', pid: 1, at: new Date().toISOString() }));
  let freshMsg = '';
  try { await withSayLock(async () => { }); } catch (e) { freshMsg = e.message; }
  t('新鲜的锁只说「等它发完」，不喊卡住（别把正常排队报成故障）',
    !/卡住/.test(freshMsg) && /等它发完/.test(freshMsg), freshMsg);
  try { fs.unlinkSync(LOCK); } catch { }
  let got2 = false;
  await withSayLock(async () => { got2 = true; });
  t('锁没了以后照常能发（fail-closed 不等于永久锁死）', got2);

  // ★ Codex 二审逮到的时序：A 慢但活着 → B 判它死了抢走锁 →
  //   A 跑完在 finally 里**无条件删锁**，删掉的是 B 的 → C 立刻也能进来。
  //   现在每把锁带自己的身份，释放时只删自己的。
  // ⚠️ 第一版我把这条测成了「别人持锁时我进不去」—— 那个场景在拿锁阶段就抛了，
  //   压根走不到释放路径，把 finally 改成无条件删也照样绿（故障注入逮到的）。
  //   要测的是：**我正持着锁的时候锁被人抢走了，我跑完不许删掉他的。**
  let ownerAfter = null;
  await withSayLock(async () => {
    // 模拟 B 判定我死了、抢走了锁
    fs.writeFileSync(LOCK, JSON.stringify({ owner: 'B抢走的', pid: 2, at: new Date().toISOString() }));
  });
  ownerAfter = readOwner();
  t('★ 释放时只删自己那把锁 —— 锁被抢走后不许删掉抢锁人的',
    fs.existsSync(LOCK) && ownerAfter === 'B抢走的', ownerAfter);
  try { fs.unlinkSync(LOCK); } catch { }

  // ★ 三审那个竞争窗口现在从根上没了：谁的锁都不删，自然删不到别人的。
  //   这一条守着「不许再把自动抢占加回来」—— 那正是被逮了两轮的地方。
  fs.writeFileSync(LOCK, '这不是 JSON，是坏掉的锁');
  const veryOld = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(LOCK, veryOld, veryOld);
  setTimeout(() => {     // 模拟：等待期间别人拿到了一把新锁
    try { fs.writeFileSync(LOCK, JSON.stringify({ owner: '新来的', pid: 3, at: new Date().toISOString() })); } catch { }
  }, 60);
  let sneaked = false;
  try { await withSayLock(async () => { sneaked = true; }); } catch { }
  t('★ 别人的锁一概不删（坏锁、陈旧锁、新锁，都不删）', readOwner() === '新来的', readOwner());
  t('★ 也不许趁机挤进发送区', sneaked === false);
  try { fs.unlinkSync(LOCK); } catch { }

  // 别人正持着一把新鲜的锁时，我该等不到然后退出，而不是硬闯
  fs.writeFileSync(LOCK, JSON.stringify({ owner: '别人的锁', pid: 1, at: new Date().toISOString() }));
  let inner = false;
  try { await withSayLock(async () => { inner = true; }); } catch { }
  t('别人正持着锁时进不去', inner === false);
  t('也没把别人的锁抢走', readOwner() === '别人的锁');
  try { fs.unlinkSync(LOCK); } catch { }

  // 心跳：慢不等于死。持锁超过陈旧线但还在按心跳的，不该被抢走。
  let held = 0;
  await withSayLock(async () => {
    const first = fs.statSync(LOCK).mtimeMs;
    await new Promise(r => setTimeout(r, 60));
    held = first;
  });
  t('持锁期间锁文件带着自己的身份', typeof held === 'number' && held > 0);
  t('用完清干净', !fs.existsSync(LOCK));
}
function readOwner() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')).owner; } catch { return null; }
}

// ── [[SAY:]] 跑真函数 ────────────────────────────────
// 同 engawa.test.js：能跑就别验源码正则。
// 尤其「两种标签混排时回填不串位」那条 —— 那是整个设计里最容易坏、
// 坏了又最不容易发现的地方（结果填到对方位置上，两个块都长得像正常的）。
const vm = require('node:vm');
const escSrc = fs.readFileSync(path.join(ROOT, 'js', '09-appearance-input.js'), 'utf8')
  .match(/function escHtml\(str\)\s*\{[\s\S]*?\n\}/)[0];

const sandbox = {
  console: { log(){}, warn(){}, error(){} }, Date, JSON, Math, String, Number, Array, Object, RegExp,
  state: { engawaOn: true, configs: [] },
  save() {}, showToast() {}, document: { getElementById: () => null },
  URL, setTimeout, clearTimeout, Promise,
  _setModelGateVisual() {}, renderModelGate() {}, SERVER_BASE: '',
  // 假的后端：檐廊回一首诗，说话回「提交了，在审核」
  async fetch(url, opt) {
    if (String(url).includes('/api/social-browser/say')) {
      return { ok: true, json: async () => ({ ok: true, state: 'pending', commentId: 'c1', quota: { usedToday: 1, max: 3 } }) };
    }
    return { ok: true, json: async () => ({ ok: true, data: { text: JSON.stringify({ ok: true, sentence: '空山新雨后', author: '王维' }) } }) };
  },
};
vm.createContext(sandbox);
vm.runInContext(escSrc, sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', '40-engawa.js'), 'utf8'), sandbox);

(async () => {
  console.log('[[SAY:]] 解析:');
  const SP = sandbox.sayParse;
  t('三段齐全', (() => { const r = SP('xhs 0000000000000000000000a0 这个也太好笑了');
    return r.site === 'xhs' && r.id === '0000000000000000000000a0' && r.text === '这个也太好笑了'; })());
  t('说的话里带空格也完整保留', SP('xhs 0000000000000000000000a0 前面 中间 后面').text === '前面 中间 后面');
  t('少了要说的话 → bad', SP('xhs 0000000000000000000000a0').bad === true);
  t('id 不合格 → bad', SP('xhs 不是id 说点什么').bad === true);
  t('站名大写也认', SP('XHS 0000000000000000000000a0 嗨').site === 'xhs');

  console.log('两种标签混排:');
  const txt = '先说 [[SAY: xhs 0000000000000000000000a0 好好笑]] 再看 [[GAZE: daily_poem]] 完';
  const rs = await sandbox.prefetchGazeCommands(txt, { engawaOn: true });
  t('两条都抓到了', rs.length === 2, rs.length);
  t('顺序就是文本里的顺序（SAY 在前 GAZE 在后）',
    rs[0] && rs[0].kind === 'say' && rs[1] && rs[1].kind === 'gaze',
    rs.map(r => r.kind));

  const out = sandbox._gazeReplaceIn(txt, rs, { i: 0 });
  const posSay = out.indexOf('在外面说了一句');
  const posGaze = out.indexOf('檐廊: daily_poem');   // 结果块标题用的是指令原文，不是中文标签
  t('★ 回填不串位：说话的块在前，看的块在后', posSay > 0 && posGaze > 0 && posSay < posGaze, { posSay, posGaze });
  t('回填后没有裸标签漏出来', !/\[\[(GAZE|SAY):/.test(out));
  t('审核中的评论不显示成「已发表」', out.includes('审核队列') && !out.includes('已发表'));
  // 结果块也要分清五档。unknown 那档最要紧：读不到平台的回应时，
  // 气泡里绝不能出现「发出去了」这种话（今天栽的第三次就是这个）。
  const sayBlock = (state) => sandbox._sayBlockHtml('xhs x 嗨', { said: '嗨', json: { state } });
  t('unknown 那档明说「不确定」，不说「发出去了」', (() => {
    const h = sayBlock('unknown');
    return h.includes('不确定') && !h.includes('评论区里能看到');
  })());
  t('submitted 那档也只说到「提交时」为止', sayBlock('submitted').includes('提交'));
  t('notsent 那档明说没发出去', sayBlock('notsent').includes('没发出去'));
  t('后端要是回了个没见过的状态，按 unknown 兜底（不能默认成功）',
    sayBlock('什么鬼').includes('不确定'));

  console.log('一轮只说一句:');
  const txt2 = '[[SAY: xhs 0000000000000000000000a0 一]] [[SAY: xhs 0000000000000000000000a1 二]]';
  const rs2 = await sandbox.prefetchGazeCommands(txt2, { engawaOn: true });
  t('第二句被挡下', rs2.length === 2 && !rs2[1].r.err === false && /只说一句/.test(rs2[1].r.err || ''), rs2[1] && rs2[1].r);
  t('第一句正常发', rs2[0] && !rs2[0].r.err);

  // ── 散步看板显示说过的话 ────────────────────────────────
  // 用户选的是「直接发，事后能在散步看板里看到」。账本记了但看板不显示 = 这一半没做完。
  console.log('散步看板 · 说过的话:');
  const strollBox = { innerHTML: '' };
  sandbox.document.getElementById = (id) => (id === 'engawaBody' ? strollBox : null);
  const strollData = {
    wentToday: true, lastStroll: '08-22', snapshot: { off: false, count: 12, blocked: 2 },
    logs: [{ date: '2026-08-22', title: '看了点东西', chars: 900, anchors: 4 }],
    pending: [], taken: [],
  };
  // 一条公开的 + 一条审核中的
  const saysData = { ok: true, quota: { usedToday: 2, max: 3 }, says: [
    { at: '2026-08-23T06:20:00.000Z', site: 'xhs', id: '0000000000000000000000a0',
      text: '最贵的其实是得把话说清楚这一项', state: 'submitted' },
    { at: '2026-08-23T07:10:00.000Z', site: 'xhs', id: '0000000000000000000000a1',
      text: '工具是自己拿的，美甲是别人给做的', state: 'pending' },
    { at: '2026-08-23T07:30:00.000Z', site: 'xhs', id: '0000000000000000000000a2',
      text: '读不到回应的那一条', state: 'unknown' },
  ] };
  const strollFetch = (saysReply) => async (url) => {
    const u = String(url);
    if (u.includes('/api/social-browser/says')) return saysReply();
    if (u.includes('/api/stroll')) return { ok: true, json: async () => strollData };
    return { ok: true, json: async () => ({}) };
  };

  sandbox.fetch = strollFetch(() => ({ ok: true, json: async () => saysData }));
  await sandbox.engawaStroll();
  const board = strollBox.innerHTML;
  t('看板上有「在外面说过的话」这一栏', board.includes('在外面说过的话'));
  t('评论原文显示出来了（不是「说过 2 条」）', board.includes('最贵的其实是得把话说清楚这一项'));
  t('今天用掉的额度亮出来', /2\/3/.test(board));
  // ★ 今天在这上面栽了三次：status 2 的评论连自己都看不见。
  //   看板把它标成「公开可见」＝让用户去小红书找一条根本找不到的评论。
  // 每条记录只看它自己那一段。**不能按固定字符数往前切** ——
  // 那样会切到隔壁那条的状态上，隔壁是「提交成功」就把这条也蒙混过关了。
  // 按记录的起始标记往前找。
  const segOf = (needle) => {
    const i = board.indexOf(needle);
    if (i < 0) return '';
    const start = board.lastIndexOf('padding:8px 0', i);
    return board.slice(start < 0 ? 0 : start, i);
  };
  t('★ 审核中的标成「在审核队列」，不是「提交成功」', (() => {
    const seg = segOf('工具是自己拿的');
    return seg.includes('审核队列') && !seg.includes('提交成功');
  })());
  t('提交成功的那条才标「提交成功」', segOf('最贵的其实是').includes('提交成功'));
  t('★ 结果不确定的照实说不确定，不许标成成功', (() => {
    const seg = segOf('读不到回应的那一条');
    return seg.includes('不确定') && !seg.includes('提交成功');
  })());
  t('标题写明这些是「提交时的状态」（不会自己刷新）', board.includes('提交时的状态'));
  // ★ 展示层也不许 fail-open：认不出来的状态默认成绿色对勾，
  //   等于后端加个新状态、前端忘了跟，就悄悄变成「成功」（Codex 二审逮到的）。
  saysData.says.push({ at: '2026-08-23T09:00:00.000Z', site: 'xhs', id: 'cafebabe00000000',
    text: '后端加的新状态', state: '还没见过的状态' });
  strollBox.innerHTML = '';
  await sandbox.engawaStroll();
  const boardX = strollBox.innerHTML;
  saysData.says.pop();
  t('★ 看板对认不出来的状态兜底成「不确定」，不是「提交成功」', (() => {
    const i = boardX.indexOf('后端加的新状态');
    const seg = boardX.slice(Math.max(0, boardX.lastIndexOf('padding:8px 0', i)), i);
    return seg.includes('不确定') && !seg.includes('提交成功');
  })());
  // 转义要**用带尖括号的真数据打一遍**才算测。
  // 第一版我写成了「escHtml 自己转不转义」，恒真，等于没测（记忆：测试变绿≠测试有效）。
  saysData.says.push({ at: '2026-08-23T08:00:00.000Z', site: 'xhs', id: 'deadbeef00000000',
    text: '<img src=x onerror=alert(1)>', pending: false });
  strollBox.innerHTML = '';
  await sandbox.engawaStroll();
  saysData.says.pop();
  t('评论正文走了转义（评论内容是外面来的，不能直接进 innerHTML）',
    !/<img src=x/.test(strollBox.innerHTML) && strollBox.innerHTML.includes('&lt;img'));
  strollBox.innerHTML = board;   // 后面几条还在看这一份
  t('免责声明点明这一栏是可外部核对的例外', board.includes('例外') && board.includes('不用信他'));
  t('但也说清只有「提交成功」的才该找得到（别让她去找一条不存在的）',
    board.includes('提交成功」的才该找得到') || board.includes('才该找得到'));

  await lockTests();

  // 取不到的时候：整块看板不能跟着一起挂
  sandbox.fetch = strollFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
  strollBox.innerHTML = '';
  await sandbox.engawaStroll();
  const board404 = strollBox.innerHTML;
  t('浏览器通道没起来时，散步记录照样显示（不是整块「查不到」）',
    board404.includes('散步日志') && board404.includes('看了点东西'));
  t('说话那一栏诚实地说读不到，不是显示成「没说过话」',
    board404.includes('读不到说话记录'));
  sandbox.fetch = strollFetch(() => { throw new Error('连不上'); });
  strollBox.innerHTML = '';
  await sandbox.engawaStroll();
  t('这一路抛异常也不拖垮看板', strollBox.innerHTML.includes('散步日志'));

  t('只读账本的端点不去碰 Chrome（否则每开一次看板就拉起浏览器）', (() => {
    const m = sbSrc.match(/app\.get\('\/api\/social-browser\/says'[\s\S]*?\n    \}\);/);
    return !!m && !/loginStatus|ensureChrome|withTab|inPage/.test(m[0]);
  })());
  t('只读收件箱的端点也不碰 Chrome（同上）', (() => {
    const m = sbSrc.match(/app\.get\('\/api\/social-browser\/inbox'[\s\S]*?\n    \}\);/);
    return !!m && !/loginStatus|ensureChrome|withTab|inPage|xhsInboxPoll/.test(m[0]);
  })());

  // ── 额度豁免（2026-08-24）────────────────────────────────
  // 「这一笔确实发出去了，但不算今天的额度」。加它是因为昨晚调试把当天 3 条烧光了，
  // 其中两笔还是同一句话发了两遍（代码谎报没发出去，我信了、手动又点一次）。
  console.log('\n额度豁免:');
  const mk = (over) => ({ says: [Object.assign({
    date: new Date().toLocaleDateString('sv-SE'), at: 'A', site: 'xhs', id: 'x', text: 't', state: 'submitted' }, over)] });
  t('豁免过的不占额度', saysToday(mk({ waived: true })).length === 0);
  t('没豁免的照旧占（对照组：不能一律不算）', saysToday(mk({})).length === 1);
  t('★ 豁免**不改 state** —— 那条评论确实发出去了，账本不许在这件事上撒谎',
    mk({ waived: true }).says[0].state === 'submitted');

  // ⚠️⚠️ 这条是这个功能的命根子：waived 是护栏上的一道口子，
  //   只要有任何一个端点能写它，闸就等于没有 —— 一轮里写两条 [[SAY:]]，
  //   第二条自己把第一条豁免掉，每日上限当场蒸发，而且零报错。
  //   所以判据取**反面**：整个挂端点那一段里，压根不许出现这个字段名。
  //   （不枚举「哪几个端点不许写」—— 枚举必漏，同禁词那条教训。）
  t('★★ 没有任何 HTTP 端点能写 waived（能被请求打开的护栏不算护栏）', (() => {
    const i = sbSrc.indexOf('function mountSocialBrowser');
    if (i < 0) return false;                       // 找不到就判死，不判活
    return !/waived/.test(sbSrc.slice(i));
  })());
  t('   豁免只能人手来：有一个照着做的脚本', fs.existsSync(path.join(ROOT, 'scripts', 'say-waive.js')));
  t('   而且那个脚本强制写原因（否则账本上只剩「不算」没有「为什么」）', (() => {
    const w = fs.readFileSync(path.join(ROOT, 'scripts', 'say-waive.js'), 'utf8');
    return /if \(!why \|\| !why\.trim\(\)\)/.test(w) && /process\.exit\(2\)/.test(w);
  })());

  // ── 收件箱：解析 ────────────────────────────────
  // 喂进去的是 2026-08-24 从真通知页抓下来的响应体（结构照抄，值改短了）。
  console.log('\n收件箱 · 解析:');
  const B = (o) => JSON.stringify(o);
  const okMe = B({ code: 0, success: true, data: { user_id: 'me1', nickname: '克克', red_id: 'kk', guest: false } });
  const okUnread = B({ code: 0, success: true, data: { likes: 3, connections: 1, mentions: 2, unread_count: 6 } });
  const okMentions = B({ code: 0, success: true, data: { message_list: [{
    id: 'n1', time: 1785146655, type: 'comment/item', title: '评论了你的笔记',
    user_info: { userid: 'other1', nickname: '路人甲' },
    comment_info: { content: '哈哈哈' },
    item_info: { id: 'note1', xsec_token: 'TOK', content: '我是克克',
                 illegal_info: { illegal_status: 'DELETE' } },
  }] } });
  const okChats = B({ code: 0, success: true, data: { chats: [
    { chat_user_id: 'u1', info: { nickname: '甲' }, last_msg_content: '在吗', last_msg_time: 1000 },
    { chat_user_id: 'u2', info: { nickname: '乙' }, last_msg_content: '我说的', last_msg_time: 2000 },
  ] } });
  const okChatUnread = B({ code: 0, success: true, data: { user_chat_unread_counts: { u1: 2, u2: 0 } } });
  const full = { me: [okMe], unread: [okUnread], mentions: [okMentions], chats: [okChats], chatUnread: [okChatUnread] };

  let P = inboxParse(full);
  t('me 带出 userId / guest 布尔（guest 是人家显式给的，比猜页面靠谱）',
    P.me && P.me.userId === 'me1' && P.me.guest === false, P.me);
  t('mention 的时间从秒换成毫秒（原样用会显示成 1970 年）',
    P.mentions[0].at === 1785146655000, P.mentions[0].at);
  t('mention 带着笔记的 xsec_token（没它就回不了那条笔记）', P.mentions[0].note.token === 'TOK');
  t('★ 笔记被删了要标出来（不标的话「去回一条」会失败得莫名其妙）',
    P.mentions[0].note.deleted === true);
  t('私信的未读数按 chat_user_id 对上', P.chats[0].unread === 2 && P.chats[1].unread === 0);
  t('★ 没给未读数是 null，**不是 0** —— 「不知道」和「确定没有」不是一回事',
    inboxParse({ ...full, chatUnread: [] }).chats[0].unread === null);
  t('哪一路没读到就写进 missing（空块和「真没有」不许长一样）',
    B(inboxParse({ ...full, mentions: [] }).missing) === B(['mentions']),
    inboxParse({ ...full, mentions: [] }).missing);

  // ⚠️ 这条是这次真踩到的：同一个 URL 会打好几次，**先回来的那几个 body 读不到**
  //   （CDP 报 No resource with given identifier found）。挑第一个能拿到的就是空壳，
  //   症状是「一条通知都没有」而不是报错。
  t('读不懂的响应要跳过（body 读不到 / 半个 JSON）',
    inboxParse({ ...full, mentions: ['(取 body 失败)', '{坏的', okMentions] }).mentions.length === 1);
  // ⚠️⚠️ 上面那条**分不出正着挑还是倒着挑**（前两个都解析不了，两种走法结果一样）——
  //   2026-08-24 的故障注入逮到它是假绿。真正要防的是「早到的那个也能解析，但它是空壳」：
  //   实测通知页会先回一个 message_list 为空的，几秒后才回真数据。
  const emptyMentions = B({ code: 0, success: true, data: { message_list: [] } });
  t('★★ 早到的空壳也能解析时，要挑**后到**的那个（不然收件箱永远是空的，且零报错）',
    inboxParse({ ...full, mentions: [emptyMentions, okMentions] }).mentions.length === 1,
    inboxParse({ ...full, mentions: [emptyMentions, okMentions] }).mentions.length);
  t('   反过来也成立：真数据在前、空壳在后时，取的是空壳（对照组，证明上一条真在看顺序）',
    inboxParse({ ...full, mentions: [okMentions, emptyMentions] }).mentions.length === 0);

  // ⚠️ 断言一律走 `(x || {}).y` —— 直接写 `.me.userId` 的话，判据被拆坏时
  //   me 变成 null，这里抛 TypeError 把整个测试文件炸掉，
  //   而故障注入是**数 ✗ 行**的：炸掉 = 0 行 ✗ = 看着像「没守住」。
  //   这就是 2026-08-24 那条假绿的真身（顺带在注入器里补了一道判据）。
  t('★ success:false 的不算数（他们失败时也回 HTTP 200，靠 body 分辨）',
    (inboxParse({ ...full, me: [okMe, B({ code: -1, success: false, msg: '签名不对', data: {} })] }).me || {}).userId === 'me1');
  t('   全是失败的话就是没读到，不是编一个出来',
    inboxParse({ ...full, me: [B({ code: -1, success: false, data: {} })] }).me === null);

  // ── 收件箱：差分 ────────────────────────────────
  console.log('\n收件箱 · 什么算「新动静」:');
  const d1 = inboxDiff(null, P, 5000);
  t('第一次查：存量全收下，但一条都不标「新」（不然第一次就炸出一屏假新消息）',
    d1.first === true && d1.added.length === 3 && d1.added.every(x => x.fresh === false), d1.added.length);
  t('原样再查一次：没有新的（去重靠通知自己的 id）', inboxDiff(d1.state, P, 6000).added.length === 0);

  const P2 = inboxParse({ ...full, mentions: [B({ code: 0, success: true, data: { message_list: [
    { id: 'n1', time: 1785146655, type: 'comment/item', title: '评论了你的笔记',
      user_info: { userid: 'other1', nickname: '路人甲' }, comment_info: { content: '哈哈哈' }, item_info: { id: 'note1' } },
    { id: 'n2', time: 1785146999, type: 'comment/item', title: '评论了你的笔记',
      user_info: { userid: 'me1', nickname: '克克' }, comment_info: { content: '这是我自己说的' }, item_info: { id: 'note1' } },
  ] } })] });
  const d2 = inboxDiff(d1.state, P2, 7000);
  t('真有新的 mention 才标「新」', d2.added.length === 1 && d2.added[0].fresh === true, d2.added);
  t('★ 我自己评论自己的笔记也会进通知 —— 标出来，别说成「有人回你了」',
    d2.added[0].self === true);

  // ⚠️⚠️ 这一组是整个收件箱**最要紧**的：私信列表只给「最后一条内容」，
  //   不说这句是谁讲的。要知道只能点开会话，而点开就把未读擦了（写操作，不可逆）。
  //   所以拿不准就得说拿不准 —— 把我自己刚发出去的话显示成「有人给你留言了」，
  //   是这一栏里最容易犯、也最难被发现的假话。
  console.log('\n收件箱 · 私信「是谁说的」判不出来:');
  const chatOnly = (unread, lastAt) => inboxParse({
    me: [okMe], unread: [okUnread], mentions: [B({ code: 0, success: true, data: { message_list: [] } })],
    chats: [B({ code: 0, success: true, data: { chats: [{ chat_user_id: 'u1', info: { nickname: '甲' }, last_msg_content: 'x', last_msg_time: lastAt }] } })],
    chatUnread: unread === null ? [] : [B({ code: 0, success: true, data: { user_chat_unread_counts: { u1: unread } } })],
  });
  const base = inboxDiff(null, chatOnly(0, 1000), 1).state;
  t('★ 未读 > 0 → 确定是对方发来的（未读数就是证据）',
    inboxDiff(base, chatOnly(1, 2000), 2).added[0].certain === true);
  t('★★ 未读 = 0 但时间变新 → 拿不准（很可能是我自己刚发出去的那句）',
    inboxDiff(base, chatOnly(0, 2000), 2).added[0].certain === false);
  t('★★ 连未读数都没读到 → 一样拿不准，不许当成有人找我',
    inboxDiff(base, chatOnly(null, 2000), 2).added[0].certain === false);
  t('未读数涨了但时间没变，也算有动静（漏了的话消息就静默丢了）',
    inboxDiff(base, chatOnly(2, 1000), 2).added.length === 1);
  t('什么都没变就是没动静（对照组：不能只会说「有新消息」）',
    inboxDiff(base, chatOnly(0, 1000), 2).added.length === 0);

  // ── 收件箱：失败要留痕 ────────────────────────────────
  console.log('\n收件箱 · 刷失败了不许装没事:');
  try { fs.unlinkSync(TMP_INBOX); } catch { }
  inboxNoteFailure('没登录', 9000);
  t('★ 从没成功过就先失败：也要落一笔（否则显示「还没查过」，把失败说成没发生）',
    (loadInbox() || {}).lastPollError === '没登录');
  const kept = inboxDiff(null, P, 5000).state;
  require('node:fs').writeFileSync(TMP_INBOX, JSON.stringify(kept));
  inboxNoteFailure('页面没打开', 9001);
  const after = loadInbox();
  t('★ 失败留痕的同时，已经查到的记录不许被冲掉',
    after.lastPollError === '页面没打开' && (after.items || []).length === 3, (after.items || []).length);

  // ── 值班员起草：挑谁来回 ────────────────────────────────
  //
  // ⚠️ 这一组每条「该排除」都配一条「该留下」的对照。只测排除的话，
  //   `return []` 能让它们全绿 —— 而那种实现的症状是「永远不起草」，
  //   零报错，用户只会觉得「它怎么老说没有要回的」。
  console.log('\n值班员 · 挑谁来回:');
  const mkCand = (o) => Object.assign({
    kind: 'mention', mid: 'm1', at: 1000, who: '路人', text: '这个好看',
    self: false, note: { id: 'n1', token: 'tk', title: '一条笔记', deleted: false },
  }, o);

  t('☑ 对照组：正常的评论要留下（不留的话下面每条排除都是假绿）',
    draftCandidates({ items: [mkCand({})] }).length === 1);

  t('★ 自己评论自己的不回（self=true）—— 否则值班员会一本正经回复我自己昨天说的话',
    draftCandidates({ items: [mkCand({ self: true })] }).length === 0);
  t('☑ 对照：同一条 self=false 就该留下', draftCandidates({ items: [mkCand({ self: false })] }).length === 1);

  t('★ 笔记删了的不回（回复会失败得莫名其妙）',
    draftCandidates({ items: [mkCand({ note: { id: 'n1', token: 't', title: '', deleted: true } })] }).length === 0);
  t('☑ 对照：没删的留下',
    draftCandidates({ items: [mkCand({ note: { id: 'n1', token: 't', title: '', deleted: false } })] }).length === 1);

  t('★ 没有笔记 id 的不回（/say 拿它当目标，空的发不出去）',
    draftCandidates({ items: [mkCand({ note: { id: '', token: '', title: '', deleted: false } })] }).length === 0);

  t('★★ 私信整类不起草 —— GranCyan 根本没有发私信的通道，而且 chats 接口连'
    + '「最后一句是谁说的」都给不出来，起草等于对着可能是我自己讲的话作答',
    draftCandidates({ items: [{ kind: 'chat', who: '路人', text: '在吗', at: 2000 }] }).length === 0);

  t('★ 起草过的不重复起草（含扔掉的：不算的话扔一条它就回来一条，每次都真花钱）',
    draftCandidates({ items: [mkCand({ mid: 'm9' })] }, { doneIds: ['m9'] }).length === 0);
  t('☑ 对照：没起草过的 mid 照常留下',
    draftCandidates({ items: [mkCand({ mid: 'm9' })] }, { doneIds: ['别的'] }).length === 1);

  // Codex 逮到的：没有 mid 的通知永远进不了「处理过」集合，会被反复抽中，
  // 一天的额度全烧在同一条上，而且零报错。
  t('★ 没有 mid 的不回（它进不了去重集合，会被无限重抽）',
    draftCandidates({ items: [mkCand({ mid: '' })] }).length === 0);
  t('☑ 对照：有 mid 的留下', draftCandidates({ items: [mkCand({ mid: 'x' })] }).length === 1);

  // ⚠️ 去重集合的容量必须**大于**审计历史的容量。反过来的话，处理到第 41 条时
  //   最早那条的 mid 就从去重集合里消失了，而收件箱还留着它（收件箱自己留 60 条），
  //   于是它重新变成候选被再起草一次 —— 要是当初已经回过，就是对同一条评论回第二遍。
  //
  // ⚠️⚠️ 这一条**原来是验常量的**（`DRAFT_SEEN_KEEP > DRAFT_KEEP`），2026-08-28 被故障注入
  //   逮到是假绿：把 `d.seen = ….slice(-DRAFT_SEEN_KEEP)` 改成 `.slice(-DRAFT_KEEP)` 注进去，
  //   常量一个都没变，断言照样绿。**判据必须触及截断这个动作本身**，所以下面那组去跑真端点。
  t('☑ 去重凭据的容量大于审计历史（这条只是形状检查，真正的判据在下面跑端点那组）',
    DRAFT_SEEN_KEEP > DRAFT_KEEP, { DRAFT_SEEN_KEEP, DRAFT_KEEP });

  t('★ 空评论不回（没内容可回，白花一次调用）',
    draftCandidates({ items: [mkCand({ text: '   ' })] }).length === 0);

  t('☑ 新的排在前面（先回最近的那条）',
    draftCandidates({ items: [mkCand({ mid: 'a', at: 100 }), mkCand({ mid: 'b', at: 900 })] })[0].mid === 'b');

  t('☑ 收件箱空/没刷过不炸', draftCandidates(null).length === 0 && draftCandidates({}).length === 0);

  // ── 值班员起草：话怎么收拾 ────────────────────────────────
  // ⚠️ 小模型比大模型爱加壳。壳没剥干净跟着发出去就是当众露馅，
  //   而且长度检查看的是剥完之后的字数。
  console.log('\n值班员 · 把模型的话收拾干净:');
  t('★ 引号要剥掉', draftClean('「哈哈哈真的」') === '哈哈哈真的', draftClean('「哈哈哈真的」'));
  t('★ 英文引号也剥', draftClean('"确实好看"') === '确实好看', draftClean('"确实好看"'));
  t('★ 「回复：」这种前缀要剥', draftClean('回复：谢谢你啊') === '谢谢你啊', draftClean('回复：谢谢你啊'));
  t('★ 多行只要第一行（模型爱在后面补一段解释，那段跟着发出去就露馅了）',
    draftClean('就这样吧\n\n（这句比较自然，符合你的语气要求）') === '就这样吧',
    draftClean('就这样吧\n\n（这句比较自然）'));
  t('☑ 对照：本来就干净的一句不许被改坏',
    draftClean('哈哈这个我也想要') === '哈哈这个我也想要');
  t('☑ 空的进空的出，不炸', draftClean('') === '' && draftClean(null) === '');

  t('★ 模型说「跳过」要认出来（认不出就把「跳过」两个字当评论发出去了）',
    draftIsSkip('跳过') && draftIsSkip('跳过。') && draftIsSkip('（跳过）'));
  t('☑ 对照：正常评论里带「跳过」两个字不算 skip',
    !draftIsSkip('这关我可跳过了三次') && !draftIsSkip('哈哈'));

  // Codex 提醒的一整类壳：Markdown。小模型很爱裹加粗/列表/代码围栏。
  t('★ 整句加粗要剥（**这句** 跟着发出去就是当众露馅）',
    draftClean('**哈哈确实**') === '哈哈确实', draftClean('**哈哈确实**'));
  t('★ 列表符号要剥', draftClean('- 谢谢啦') === '谢谢啦' && draftClean('1. 谢谢啦') === '谢谢啦');
  t('★ 代码围栏要剥', draftClean('```\n就这样\n```') === '就这样', draftClean('```\n就这样\n```'));
  t('☑ 对照：句中的星号/减号不许被剥坏',
    draftClean('这个 3*4 的排版和 A-B 面都好看') === '这个 3*4 的排版和 A-B 面都好看',
    draftClean('这个 3*4 的排版和 A-B 面都好看'));

  // ── 值班员：省 token 这件事本身 ────────────────────────────────
  // ⚠️ 这个功能存在的**全部理由**就是别用大模型。所以「模型是谁」不是配置细节，
  //   是功能本身 —— 而它坏掉的时候是静默的：账单涨了才会有人发现。
  console.log('\n值班员 · 别偷偷用回大模型:');
  t('★★ 默认模型必须是小的（haiku/sonnet），绝不能是 opus/fable',
    /haiku|sonnet/.test(DRAFT_MODEL) && !/opus|fable/.test(DRAFT_MODEL), DRAFT_MODEL);
  t('★ 起草上限必须严于发送上限 —— 起草不占发送额度，'
    + '不设闸的话「反复重抽直到满意」就是换个地方烧钱',
    DRAFT_DAILY_MAX < SAY_DAILY_MAX, { DRAFT_DAILY_MAX, SAY_DAILY_MAX });

  // ⚠️ 提示词里必须自己也说一遍禁词，理由是**被 sayCheck 拦下来的草稿是废的，
  //   而那次 API 调用照样收费**。事前说一句比事后扔一条便宜。
  //   （但这不替代 sayCheck：提示词是请求，护栏才是保证。上面那一整组闸一条没动。）
  t('☑ 起草提示里要求了「不许提真名/项目名/链接」',
    /真名/.test(DRAFT_SYSTEM) && /链接/.test(DRAFT_SYSTEM));
  t('☑ 起草提示里要求了长度（小模型不给上限就会写小作文，然后被 80 字那道闸全拦掉）',
    /\d+\s*个?字/.test(DRAFT_SYSTEM));

  // ⚠️ 喂给模型的上下文里**不许有用户的名字/项目名**：它们是禁词，
  //   而模型最爱做的事就是照抄上下文里的词。这是在源头上少踩一脚。
  const up = draftUserPrompt({ who: '路人', text: '好可爱', note: { title: '猫' } });
  t('★ 起草的上下文只装这条评论本身，不夹带别的（越短越省，也越不容易抄到禁词）',
    up.length < 200 && up.includes('好可爱') && !/小明|Alice|GranCyan/i.test(up), up);

  // ── 喂进去的上下文要先抹掉禁词 ────────────────────────────────
  // ⚠️ 这不是护栏（护栏是 sayCheck，一个字没动），是**省钱**：用户那条真笔记标题
  //   就叫「我是AI 今天学会上网了」，「AI」在禁词表里。原样喂进去模型会跟着用，
  //   写出来的草稿当场被判死，而那次调用的钱已经花了。
  console.log('\n专用浏览器 · 闲够了自己走:');
  // 用户报「exe 老是未响应」，查出来这个 Chrome 挂了 14 小时、943 MB。
  // 根因是**任何时候都不会关**（detached+unref 是故意的，为了跨重启复用）。
  // ⚠️ 三个条件各写一条 + 各配对照组。整条拆只能证明「至少有一道闸」，
  //   证不出每一道都必要 —— gen 租约那次现学的。
  const IDLE = 15 * 60 * 1000;
  const idleBase = { now: 1e12, lastUse: 1e12 - IDLE - 1, inFlight: 0, graceUntil: 0, idleMs: IDLE };
  t('☑ 前提：闲够了、没人用、不在宽限期 → 该关（不成立的话下面三条全是空气）',
    shouldCloseIdleChrome(idleBase) === true);

  t('★★ 有会话正在飞就不许关（关了等于把她那次「去回一条」拦腰砍断）',
    shouldCloseIdleChrome({ ...idleBase, inFlight: 1 }) === false);
  t('☑ 对照：那个会话跑完了就可以关（不是一律不关）',
    shouldCloseIdleChrome({ ...idleBase, inFlight: 0 }) === true);

  t('★★ /open 的宽限期内不许关（那是给用户扫码用的，服务端看着完全像空闲）',
    shouldCloseIdleChrome({ ...idleBase, graceUntil: 1e12 + 60000 }) === false);
  t('☑ 对照：宽限期过了就可以关（不然登录一次就永远关不掉了）',
    shouldCloseIdleChrome({ ...idleBase, graceUntil: 1e12 - 1 }) === true);

  t('★★ 刚用过的不许关（空闲判据本身）',
    shouldCloseIdleChrome({ ...idleBase, lastUse: 1e12 - 1000 }) === false);
  t('☑ 对照：差一毫秒不到阈值不关、正好到阈值就关（边界不许写反）',
    shouldCloseIdleChrome({ ...idleBase, lastUse: 1e12 - IDLE + 1 }) === false &&
    shouldCloseIdleChrome({ ...idleBase, lastUse: 1e12 - IDLE }) === true);

  // ⚠️ 默认值也要守：这两个数字调错了，上面所有断言照样全绿 ——
  //   它们传的是自己造的 idleMs，碰不到真实默认值。
  t('★ 空闲阈值和登录宽限都是分钟级正数，且宽限 > 空闲（登录比抓取慢得多）',
    CHROME_IDLE_MS >= 60000 && CHROME_GRACE_MS > CHROME_IDLE_MS,
    { idle: CHROME_IDLE_MS / 60000 + '分', grace: CHROME_GRACE_MS / 60000 + '分' });

  // ⚠️ 定时器必须 unref。不 unref 的话 server 收到关闭信号也不退 ——
  //   本来是来修「有东西不肯走」的，别自己再造一个僵尸。
  // ── 接线本身（不是判据）──
  // ⚠️ 判据守得再严，没人把 inFlight 加上去也是白搭。上面那几条只喂自己造的数，
  //   故障注入把 `_chromeInFlight++` 删掉时一条都不会红（2026-08-28 实测命中 0）。
  //   所以这里读**真实的模块内部状态**，并且真的走一遍那个包装。
  await (async () => {
    const before = chromeIdleState();
    t('☑ 前提：现在没有会话在飞（有的话下面测的是别人留下的状态）', before.inFlight === 0, before.inFlight);
    let seen = null;
    await withChromeBusy(async () => { seen = chromeIdleState(); });
    t('★★ 用浏览器的那段时间真的被记成「在飞」（判据再严，没人记账也是白搭）',
      seen && seen.inFlight === 1, seen && seen.inFlight);
    t('★★ 而且这段时间里判据真的会拒绝关（接线和判据接上了，不是各自对）',
      shouldCloseIdleChrome({ now: 1e13, lastUse: 0, inFlight: seen ? seen.inFlight : 0,
        graceUntil: 0, idleMs: 1000 }) === false);
    t('★ 出来之后计数归零（不归零的话浏览器从此永远关不掉）',
      chromeIdleState().inFlight === 0, chromeIdleState().inFlight);

    // ⚠️ 抛异常那条路单独测：减在 finally 里才成立。不在 finally 的话，
    //   一次失败的抓取就把计数永久 +1，比不做这个功能还糟 —— 而且零报错。
    let threw = false;
    try { await withChromeBusy(async () => { throw new Error('抓取炸了'); }); }
    catch { threw = true; }
    t('☑ 前提：那次调用确实抛出来了', threw);
    t('★★ 抓取抛异常之后计数也要归零（不归零＝浏览器永远关不掉，且零报错）',
      chromeIdleState().inFlight === 0, chromeIdleState().inFlight);

    t('★ 用完之后 lastUse 是刚刚（空闲从「用完」算起，不是从「开始用」算起）',
      Date.now() - chromeIdleState().lastUse < 5000, Date.now() - chromeIdleState().lastUse);
  })();

  // ── 拉起浏览器**也**算一次使用（2026-09-05，用户报「小红书明明打开了」查出来的）──
  //
  // kickXhsChromeUp → ensureChrome 这条路原来一次都不打点。而「浏览器没在跑」这个前提
  // 本身就意味着 lastUse 至少是 15 分钟前（不然它还活着），于是清扫器在**最多 60 秒后**
  // 的下一轮就把刚拉起来的窗口关掉：窗口真的弹出来了、小红书也加载了（她看得见，
  // 所以报的是「明明打开了」），然后被扫走，下一次 [[GAZE: xhs]] 照旧报
  // 「专用浏览器没在跑」—— 死循环，且零报错。kick 那边还有 60 秒冷却，更黏。
  await (async () => {
    // ① 先立起「这个洞真的致命」。不先证这一条的话，下面那条绿了也可能
    //    只是因为阈值本来就宽松，跟打没打点没关系。
    const kickAt = 1e12;                        // 假设此刻刚把浏览器拉起来
    t('☑ 前提：不打点的话，刚拉起来的浏览器当场就被判该关（这就是 bug 本身）',
      shouldCloseIdleChrome({ now: kickAt, lastUse: kickAt - IDLE - 1, inFlight: 0,
        graceUntil: 0, idleMs: IDLE }) === true);
    t('★★ 打了点之后同一时刻判据改口说不许关（记账真的挡住了这次误关）',
      shouldCloseIdleChrome({ now: kickAt, lastUse: kickAt, inFlight: 0,
        graceUntil: 0, idleMs: IDLE }) === false);

    // ② 打点函数真的动了**模块内部**那个变量，不是我自己造的数。
    await new Promise(r => setTimeout(r, 12));  // 拉开时间差，否则「变没变」判不出来
    const before = chromeIdleState().lastUse;
    touchChrome();
    t('★★ touchChrome 真的更新了模块内部的 lastUse（读的是真状态，不是副本）',
      chromeIdleState().lastUse > before, { before, after: chromeIdleState().lastUse });

    // ③ 接线：ensureChrome 这条路真的会打点。
    //    ⚠️ 只在专用浏览器**已经活着**的时候跑完整流程 —— 它没活着的话 ensureChrome
    //    会真的 spawn 一个 Chrome 窗口出来，跑个测试不该往用户屏幕上弹东西。
    //    所以这一格是有条件的；下面那条源码断言是**无条件**的兜底，两条都要，
    //    不许因为「有条件那条会跳过」就把兜底那条省掉。
    if (await chromeAlive()) {
      await new Promise(r => setTimeout(r, 12));
      const b2 = chromeIdleState().lastUse;
      await ensureChrome();
      t('★★ 真走一遍 ensureChrome 之后 lastUse 被刷新了（真跑，不是看源码）',
        chromeIdleState().lastUse > b2, { before: b2, after: chromeIdleState().lastUse });
    } else {
      console.log('  （跳过「真走一遍 ensureChrome」：专用浏览器没在跑，跑它会弹出一个真窗口）');
    }
  })();

  // ⚠️ 这条守的是「打点在探活**之前**」，上面那格守不住这一点。
  //   打在 chromeAlive 之后的话，冷启动那 20 秒的等待窗口仍然裸着：清扫器可以在
  //   端口刚开、那个 for 循环还没退出的时候把它关掉 —— 比原 bug 更难查，
  //   因为只有冷启动慢的时候才犯。
  //   取的是「块开头到第一个 await chromeAlive() 之间」这一段，并且**先剥掉注释行**
  //   再找 —— 不剥的话，我在那儿写的说明文字里只要出现这个词就能把断言喂饱。
  const ensHead = ((sbSrc.match(/_starting = \(async \(\) => \{([^]*?)if \(await chromeAlive\(\)\)/) || [])[1] || '')
    .split('\n').filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n').trim();
  t('★★ ensureChrome 一进来就打点，且打在探活之前（否则冷启动那 20 秒仍然裸着）',
    /touchChrome\(\)/.test(ensHead), JSON.stringify(ensHead));

  t('★★ 空闲清扫的定时器 unref 了（否则进程永远退不掉，反而更糟）',
    /sweepIdleChrome[^]{0,200}?timer.unref()/.test(sbSrc));

  console.log('\n值班员 · 喂进去之前先抹掉禁词:');
  t('★★ 笔记标题里的禁词「克克」被抹掉了（不抹的话模型必抄，草稿必被判死）',
    !draftUserPrompt({ who: '路人', text: '好看', note: { title: '我是克克 今天学会上网了' } })
      .includes('克克'));
  t('★★ 全角绕不过去（模型抄的是原文，sayCheck 拦得住的这里也得抹）',
    !/[ＧｇGg][ＲｒRr]/.test(draftRedact('你就是ＧｒａｎＣｙａｎ的作者吧')),
    draftRedact('你就是ＧｒａｎＣｙａｎ的作者吧'));
  t('★★ 大写绕不过去', !/ALICE/i.test(draftRedact('ALICE 的日常')), draftRedact('ALICE 的日常'));
  t('★ 挨着的两个禁词合并成一个 TA（昵称常是两个连着写，否则抹成 TATA）',
    draftRedact('Alice阿明') === 'TA', draftRedact('Alice阿明'));
  // ── 命中区间求并集（Codex 二审）──
  // ⚠️ 这一组**不能走 draftRedact 整条链路测**：现在的禁词表里没有一个词是另一个词的前缀
  //   （常见的是后缀关系，比如「明」和「阿明」），所以整条链路上这个洞根本触发不到，
  //   「起点落在游标之前就整条跳过」的旧写法在真实词表上也是全绿的。
  //   它是潜伏的 —— 往表里加个前缀词（比如再加个「Gran」）当天就活。
  //   所以直接打那个纯函数，用真实词表构造不出来的形状。
  const spanStr = (h) => JSON.stringify(mergeSpans(h));
  t('★★ 同起点时长的那条不许被丢掉（短的先排到，旧写法会让长词后半截原样漏出去）',
    spanStr([[5, 7], [5, 12]]) === '[[5,12]]', spanStr([[5, 7], [5, 12]]));
  t('★★ 交叉重叠要合并，不是跳过（旧写法会漏掉后一条的尾巴）',
    spanStr([[5, 10], [8, 15]]) === '[[5,15]]', spanStr([[5, 10], [8, 15]]));
  t('★ 完全包含的合成一条', spanStr([[3, 20], [7, 9]]) === '[[3,20]]', spanStr([[3, 20], [7, 9]]));
  t('★ 紧挨着的合成一条（这才是「Alice阿明」抹成一个 TA 而不是 TATA 的原因）',
    spanStr([[0, 3], [4, 6]]) === '[[0,6]]', spanStr([[0, 3], [4, 6]]));
  t('☑ 对照：中间隔着字的不许合并（否则会把两个禁词之间的正文一起吞掉）',
    spanStr([[0, 3], [6, 8]]) === '[[0,3],[6,8]]', spanStr([[0, 3], [6, 8]]));
  t('☑ 对照：空进空出', spanStr([]) === '[]');

  t('☑ 对照：不含禁词的一个字都不许动',
    draftRedact('这个配色好好看，是自己调的吗') === '这个配色好好看，是自己调的吗');
  t('☑ 对照：空的进空的出，不炸', draftRedact('') === '' && draftRedact(null) === '');
  // ⚠️ 抹完之后**句子还得是句子**：全抹成 TA 的话模型没有任何可回应的内容，
  //   它要么瞎编要么输出「跳过」，那次调用照样白花。
  t('☑ 抹完之后正文还在（只换掉禁词那几个字，不是整句吞掉）',
    draftRedact('我是克克 今天学会上网了').includes('今天学会上网了'));

  // ── 值班员：起草这条路不许自己会发 ────────────────────────────────
  // ⚠️⚠️  选的是「先起草，我点了才发」。这条断言钉的就是那个决定：
  //   草稿模块里**没有自己的发送实现**，唯一的出路是那个原样没动的 /say 端点。
  //   这条只能验源码（"这一段里没有出现某个调用"这种命题没法拿数据喂），
  //   所以范围划得很窄：只看起草那一节。
  // ── 值班员：并发与幂等（Codex 逮到的三条真 bug，这里是它们的回归测试）──────────
  //
  // ⚠️ 这几条**必须真跑端点**，不能验纯函数：坏掉的地方全在「读—等待—写」的时序里，
  //   而纯函数没有时序。用一个假的 claudeOnce 把「模型要想几秒」这件事做出来。
  console.log('\n值班员 · 并发与幂等:');
  {
    const express = require(path.join(ROOT, 'node_modules', 'express'));
    const { mountSocialBrowser } = require(path.join(ROOT, 'social-browser.js'));
    const { loadDrafts } = require(path.join(ROOT, 'social-browser.js'));

    // 模型：想 300ms 再答。慢是重点 —— 丢更新那个洞就藏在这段等待里。
    let modelCalls = 0;
    let modelDelay = 300;
    let modelText = '哈哈是自己调的';
    const slowModel = async () => {
      modelCalls++;
      await new Promise(r => setTimeout(r, modelDelay));
      return { text: modelText, model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 300, output_tokens: 9 } };
    };

    // 收件箱：两条可回的评论
    fs.writeFileSync(TMP_INBOX, JSON.stringify({
      v: 1, lastPollAt: Date.now(), me: { userId: 'me' }, seen: ['a', 'b'], chats: {},
      items: [
        { kind: 'mention', mid: 'a', at: 1000, who: '甲', text: '好看', self: false, note: { id: 'n_a', token: 'tok_a', title: 'T', deleted: false } },
        { kind: 'mention', mid: 'b', at: 2000, who: '乙', text: '哪买的', self: false, note: { id: 'n_b', token: 'tok_b', title: 'T', deleted: false } },
        // 租约那一组还要再吃掉两条候选，不补的话它会因为「没有新评论」而不是因为被测的行为而红
        { kind: 'mention', mid: 'c', at: 3000, who: '丙0', text: '好看', self: false, note: { id: 'n_c', token: 'tok_c', title: 'T', deleted: false } },
        { kind: 'mention', mid: 'd', at: 4000, who: '丙1', text: '好看', self: false, note: { id: 'n_d', token: 'tok_d', title: 'T', deleted: false } },
        { kind: 'mention', mid: 'e', at: 5000, who: '丙2', text: '好看', self: false, note: { id: 'n_e', token: 'tok_e', title: 'T', deleted: false } },
        { kind: 'mention', mid: 'f', at: 6000, who: '丙3', text: '好看', self: false, note: { id: 'n_f2', token: 'tok_f', title: 'T', deleted: false } },
      ],
    }));
    try { fs.unlinkSync(TMP_DRAFTS); } catch { }
    try { fs.unlinkSync(TMP_STATE); } catch { }

    // 发送：记下来发了几次，不真开浏览器
    let sendCalls = [];
    // ⚠️ 发送要**慢**（2026-08-28 故障注入逮到）。立即返回的话，第一个请求会在第二个
    //   进来之前就跑完并标成 sent，于是第二个撞上的是「已经发过了」——
    //   `sending` 那道闸根本没被走到，拆掉它测试照样全绿（红 0 命中 0）。
    //   慢一点才制造得出「第一个还在发、第二个进来了」这个真实窗口。
    let sendDelay = 250;
    const origXhs = SAY_SENDERS.xhs;
    SAY_SENDERS.xhs = async (id, token, text) => {
      sendCalls.push({ id, token, text });
      await new Promise(r => setTimeout(r, sendDelay));
      return { state: 'submitted', commentId: 'c' + sendCalls.length, status: 200 };
    };

    const app = express();
    app.use(express.json());
    mountSocialBrowser(app, { xhsToken: () => null, claudeOnce: slowModel });
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = (p, body) => fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
    const get = (p) => fetch(base + p).then(r => r.json());

    try {
      // ── 丢更新：起草期间去 resolve 另一条，起草落盘时不许把它盖回来 ──
      const first = await post('/api/social-browser/draft');
      // ⚠️ 这里不能直接 .draft.at。起草一旦整条不落地（比如租约核对恒不成立），
      //   这行就是 TypeError，**整个套件当场炸掉** —— 故障注入报出来是「命中 0」，
      //   看着像断言没守住，其实是断言根本没跑到。前提先摆出来，后面用可选链。
      t('☑ 前提：第一条草稿真的落地了（不落地的话下面整组都测了空气）',
        !!(first.j && first.j.draft), JSON.stringify(first.j).slice(0, 120));
      const atA = first.j.draft?.at;
      const idA = first.j.draft?.draftId;

      const racing = post('/api/social-browser/draft');          // 起草 b，要 300ms
      await new Promise(r => setTimeout(r, 80));                  // 等它读完、进入等模型
      const dropped = await post('/api/social-browser/draft-resolve', { draftId: idA, action: 'dropped' });
      await racing;

      const afterRace = loadDrafts();
      const recA = (afterRace.drafts || []).find(x => x.at === atA);
      t('★★ 起草期间扔掉的草稿，不会被起草落盘时整本盖回 pending（Codex：丢更新→重复评论）',
        dropped.j.ok && recA && recA.state === 'dropped', recA && recA.state);

      // ── 租约：起草还在飞的时候被判死，回来不许把状态翻回去（Codex 二审）──
      // ⚠️ 这里必须打在**同一条记录**上。上面那条丢更新测的是「起草 b 的时候扔掉 a」，
      //   两条不同的记录，CAS 那道闸根本走不到。
      // 场景：合法的调用慢过了陈旧阈值（429 退避就能做到），另一个进程把我这条
      //   归一化成 failed；然后我回来了。旧写法只按 at 找到记录就照写，
      //   于是 failed 被翻回 pending —— 那说明「判死」不是可靠的状态转换。
      {
        const racing2 = post('/api/social-browser/draft');
        await new Promise(r => setTimeout(r, 80));         // 等它写完占位、进入等模型
        // 模拟另一个进程：读本子 → 判死（把时钟推到阈值之后）→ 写回。
        // 此刻起草方**没有持锁**（模型调用在锁外），所以这是真实可发生的交错。
        const mid = JSON.parse(fs.readFileSync(TMP_DRAFTS, 'utf8'));
        const flying = (mid.drafts || []).filter(x => x.state === 'generating');
        healStaleGenerating(mid, Date.now() + GENERATING_STALE_MS + 1000);
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify(mid));
        const r3 = await racing2;

        t('☑ 前提：判死的那一刻，确实有一条起草正在飞（否则下面测了个空气）',
          flying.length === 1, flying.length);
        const killed = (loadDrafts().drafts || []).find(x => x.at === (flying[0] || {}).at);
        t('★★ 被判死的起草回来后不许把自己翻回 pending（租约对不上就什么都不写）',
          killed && killed.state === 'failed', killed && killed.state);
        t('★ 而且要如实告诉调用方这条没落地，不能报成起草成功',
          !r3.j.draft, JSON.stringify(r3.j).slice(0, 120));
      }
      // ── 租约的 gen 那一半（Codex 三审逮到：上面那条只验了 state）──
      // ⚠️ 上面把记录改成 failed，于是把生产代码改成「只看 state」，那条断言照样绿 ——
      //   gen 比较不可缺这件事根本没被证明。这里保持 state 仍是 generating、只把 gen 换掉。
      // 场景：另一个进程用同一个 at 换了一条新的占位（时钟粒度撞车、或者它自己重排了本子）。
      //   .find(x => x.at === claim.at) 会找到**别人的**记录；不比 gen 的话，
      //   我的模型结果会写进别人那条，而真正属于我的那条留在那儿等超时。
      {
        const racing3 = post('/api/social-browser/draft');
        await new Promise(r => setTimeout(r, 80));
        const mid3 = JSON.parse(fs.readFileSync(TMP_DRAFTS, 'utf8'));
        const fly = (mid3.drafts || []).filter(x => x.state === 'generating');
        t('☑ 前提：确实有一条起草在飞（否则下面又是测空气）', fly.length === 1, fly.length);
        if (fly[0]) fly[0].gen = 'someone-elses-lease';      // state 保持 generating
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify(mid3));
        const r4 = await racing3;
        const other = (loadDrafts().drafts || []).find(x => x.at === (fly[0] || {}).at);
        t('★★ gen 对不上就不许写（哪怕 state 还是 generating）—— 否则会把结果写进别人的记录',
          !!(other && other.state === 'generating' && other.gen === 'someone-elses-lease' && !other.text),
          other && { state: other.state, gen: other.gen, text: other.text });
        t('★ 而且如实告诉调用方没落地', !r4.j.draft, JSON.stringify(r4.j).slice(0, 120));
      }

      // ☑ 对照：没有人插手的时候，起草照样正常落成 pending（CAS 不是把所有写都拒了）
      {
        const ok3 = await post('/api/social-browser/draft');
        t('☑ 对照：无人插手时起草正常落地（否则上面那条「拒写」是假的严格）',
          !!(ok3.j.draft && ok3.j.draft.state === 'pending'), JSON.stringify(ok3.j).slice(0, 100));
      }

      // ── 幂等：同一条草稿点两次「发」，只能真发一次 ──
      const pend = (await get('/api/social-browser/drafts')).drafts;
      const target = pend[0];
      sendCalls = [];
      const [s1, s2] = await Promise.all([
        post('/api/social-browser/draft-send', { draftId: target.draftId, text: '哈哈是自己调的' }),
        post('/api/social-browser/draft-send', { draftId: target.draftId, text: '哈哈是自己调的' }),
      ]);
      t('★★ 同时点两次「发出去」，评论只飞出去一条（Codex：并发→重复评论）',
        sendCalls.length === 1, sendCalls.length);
      t('★ 两个请求里恰好一个成功、另一个被明确顶回（不是两个都说成功）',
        [s1.j.ok, s2.j.ok].filter(Boolean).length === 1, [s1.j, s2.j]);

      // ⚠️⚠️ 上面两条**挡不住「抢到手不标 sending」这个洞**（2026-08-28 故障注入逮到：
      //   把 `rec.state = 'sending'` 拆掉，那两条依然全绿）。原因是还有第二道闸救场：
      //   sendComment 里的 `_sayBusy` 会把第二个请求顶回去。
      //   但 `_sayBusy` 是**进程内**的布尔量 —— 这台机器上同时跑两个 server 一点都不罕见
      //   （exe 内嵌一个、开发时再 node server.js 一个），那时两边的 _sayBusy 各是各的，
      //   两个都能进发送区，同一条评论真的会飞出去两遍。
      //   所以判据不能只看「最终发了几条」，得看**第二个是被哪道闸拦下的**：
      //   必须是草稿状态那道（跨进程有效，状态写在文件里），不是 _sayBusy 那道。
      const refused = [s1, s2].find(x => !x.j.ok);
      t('★★ 被顶回的那个，是撞在「这条正在发」上（草稿状态闸，跨进程才管用）—— '
        + '不是撞在进程内的 _sayBusy 上',
        !!refused && /正在发，别重复点|已经发过了/.test(String(refused.j.error || '')),
        refused && refused.j.error);

      sendDelay = 0;                     // 后面几组不需要慢
      const again = await post('/api/social-browser/draft-send', { draftId: target.draftId, text: '再来一次' });
      t('★★ 已经发过的草稿再点一次，直接顶回「发过了」，一次都不再飞出去',
        !again.j.ok && again.j.already === true && sendCalls.length === 1, again.j);

      t('★ 发出去的草稿扔不掉（扔掉等于账本上抹掉一条真发出去的评论）',
        !(await post('/api/social-browser/draft-resolve', { draftId: target.draftId, action: 'dropped' })).j.ok);

      // ── 前端不许凭空标 sent：那等于把幂等键关掉 ──
      // 自己造一条 pending，别指望上面的流程剩下什么（它们都被发掉/扔掉了）
      {
        const d = loadDrafts();
        d.drafts = (d.drafts || []).concat([{
          date: new Date().toLocaleDateString('sv-SE'), at: 'forge-target', draftId: 'forge-target', mid: 'forge',
          state: 'pending', site: 'xhs', id: 'n_f', token: 'tok_f', text: '随便一句', bad: '',
        }]);
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify(d));
      }
      const forged = await post('/api/social-browser/draft-resolve', { draftId: 'forge-target', action: 'sent' });
      t('★★ draft-resolve 不接受 action:sent（能凭空标 sent 的话，幂等键等于没有）',
        !forged.j.ok, forged.j);
      t('☑ 对照：同一条草稿 action:dropped 是可以的（上面那条红不是因为端点全拒）',
        (await post('/api/social-browser/draft-resolve', { draftId: 'forge-target', action: 'dropped' })).j.ok);

      // ── token 不许出海 ──
      // ⚠️ 判据必须打在一条**还 pending 的**草稿上（2026-09-02 故障注入逮到）。
      //   原来查的是前面那几条 tok_a / tok_b，可它们早就发掉/扔掉进了终态，
      //   而终态现在会主动 delete rec.token —— 于是把 draftPublic 的剥离整个拆掉，
      //   这条断言照样绿（红 0 命中 0）。**它守的那件事已经被前面的清理掏空了。**
      //   pending 才是 draftPublic 真正要挡的活路径：本子里必须留着（发送时要用），
      //   给前端的响应里必须没有。
      {
        const d = loadDrafts();
        d.drafts = (d.drafts || []).concat([{
          date: new Date().toLocaleDateString('sv-SE'), at: 'tok-probe', draftId: 'tok-probe', mid: 'm_probe',
          state: 'pending', site: 'xhs', id: 'n_probe', token: 'tok_PROBE', text: '探针', bad: '',
        }]);
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify(d));
      }
      const shown = await get('/api/social-browser/drafts');
      const all = JSON.stringify(shown);
      t('☑ 前提：那条探针草稿确实出现在给前端的列表里（不在的话下面查了个空气）',
        (shown.drafts || []).some(x => x.at === 'tok-probe'), (shown.drafts || []).map(x => x.at));
      t('★★ xsec_token 不出现在给前端的响应里（Codex：短命凭据不该散进持久文件和 DOM）',
        !all.includes('tok_PROBE'), all.slice(0, 200));
      t('☑ 对照：草稿本子**自己**留着 token（发送时服务端要用它，收件箱常常是它唯一的来源）',
        JSON.stringify(loadDrafts()).includes('tok_PROBE'));

      // ── 发送真用上了 token，而且是服务端取的 ──
      t('☑ 发送时带上了 token（前端全程没碰过它）',
        sendCalls.length === 1 && String(sendCalls[0].token || '').startsWith('tok_'), sendCalls[0]);

      // ══ Codex 二审逮到的四条（2026-09-02）══════════════════════════
      // 四条指向同一件事：**发送状态机在异常路径上会把草稿放回看板**，
      // 而放回看板 = 她再点一次 = 同一条评论发两遍，而评论撤不回来。
      {
        const stubXhs = SAY_SENDERS.xhs;
        const LEDGER_TMP = TMP_STATE + '.tmp';
        // 让记账那一步**确定**失败的办法：在 saveSays 要写的临时文件位置上放一个目录，
        // writeFileSync 必然 EISDIR。比 mock fs 干净，而且是真的文件系统错误。
        const breakLedger = () => { try { fs.mkdirSync(LEDGER_TMP); } catch { } };
        const healLedger = () => { try { fs.rmdirSync(LEDGER_TMP); } catch { } };
        const forge = (at, extra) => {
          const d = loadDrafts();
          d.drafts = (d.drafts || []).concat([Object.assign({
            date: new Date().toLocaleDateString('sv-SE'), at, draftId: at, mid: 'm_' + at,
            state: 'pending', site: 'xhs', id: 'n_' + at, token: 'tok_' + at,
            text: '模型原稿', bad: '',
          }, extra || {})]);
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify(d));
        };
        const recOf = (at) => (loadDrafts().drafts || []).find(x => x.at === at);
        try { fs.unlinkSync(TMP_STATE); } catch { }   // 额度重新开始，免得后面几发被日限挡掉
        sendDelay = 0;

        try {
          // ① 评论已经发出去了，只是记账那一步写失败 —— 绝不许退回 pending。
          //    旧写法：patch 抛出普通 fs 错误 → 这个错误没有 unknown 标记 →
          //    收尾判成「确定没发出去」→ 草稿回看板 → 她再点一次 = 第二条评论。
          forge('t-ledger');
          sendCalls = [];
          SAY_SENDERS.xhs = async (id, token, text) => {
            sendCalls.push({ id, token, text });
            breakLedger();                       // 发**成功了**，然后记账才坏
            return { state: 'submitted', commentId: 'cL', status: 200 };
          };
          const rl = await post('/api/social-browser/draft-send', { draftId: 't-ledger', text: '谢谢喜欢' });
          healLedger();
          t('★★ 评论已发出、只是记账写失败 —— 草稿不许回 pending（回了就是邀请她再发一遍）',
            recOf('t-ledger') && recOf('t-ledger').state !== 'pending',
            { state: recOf('t-ledger') && recOf('t-ledger').state, resp: rl.j });
          // ⚠️ 上面那条**单独站不住**（2026-09-02 故障注入逮到：把成功那步的 try/catch
          //   拆掉，它照样绿）—— 因为收尾的 fail-closed 会兜住，状态还是 sent。
          //   两道闸守着同一条断言，等于第一道没人验。真正只有 try/catch 守得住的是这个：
          //   评论确实发出去了，接口就得**如实报成功**。报失败等于当面请她再点一次。
          t('★★ 评论发出去了、只是账没记上 —— 接口要如实报成功（报失败等于请她再点一次）',
            rl.j.ok === true, rl.j);
          const sentOnce = sendCalls.length;
          await post('/api/social-browser/draft-send', { draftId: 't-ledger', text: '谢谢喜欢' });
          t('★★ 而且第二次点下去，发送函数一次都没再被调到（这才是「不重复评论」的定义）',
            sendCalls.length === sentOnce && sentOnce === 1, { sentOnce, now: sendCalls.length });

          // ② 发送抛的错**判不出发没发**，而记账那一步也失败了 —— 原始错误不许被 fs 错误顶掉。
          //    顶掉之后收尾看到的是一个不带标记的错误，fail-closed 才救得回来。
          forge('t-unknown');
          sendCalls = [];
          SAY_SENDERS.xhs = async (id, token, text) => {
            sendCalls.push({ id, token, text });
            breakLedger();
            const e = new Error('网断在半路，判不出发没发'); e.unknown = true; throw e;
          };
          const ru = await post('/api/social-browser/draft-send', { draftId: 't-unknown', text: '谢谢喜欢' });
          healLedger();
          t('★★ 判不出发没发的时候，回给调用方的是原始错误，不是记账的 fs 错误',
            /判不出发没发/.test(String(ru.j.error || '')), ru.j.error);
          t('★★ 判不出发没发 → 草稿留在 sent（宁可少发一条，也不能重复发）',
            recOf('t-unknown') && recOf('t-unknown').state === 'sent',
            recOf('t-unknown') && recOf('t-unknown').state);

          // ②b 发送抛的是一个**什么标记都没有**的错（比如发完之后解析响应时炸了）。
          //    这才是 fail-closed 那行真正守着的场景：旧写法 `err.unknown ? sent : pending`
          //    对这种错判「确定没发出去」→ 退回看板 → 重复评论。
          //    新写法反过来：只有明确说了 notSent 才退回，其余一律当成可能发出去了。
          forge('t-bare');
          sendCalls = [];
          SAY_SENDERS.xhs = async (id, token, text) => {
            sendCalls.push({ id, token, text });
            throw new TypeError('解析响应时炸了（评论可能已经在外面了）');
          };
          const rb = await post('/api/social-browser/draft-send', { draftId: 't-bare', text: '谢谢喜欢' });
          t('★★ 发送抛出的错不带任何标记时，按「可能已发出」算 —— 不许退回看板',
            recOf('t-bare') && recOf('t-bare').state === 'sent',
            recOf('t-bare') && recOf('t-bare').state);
          t('★★ 判不出发没发的 unknown 必须传播给接口（否则看板会谎称「没发出去」并诱导重发）',
            rb.j.unknown === true, rb.j);

          // ☑ 对照：**确定**没发出去的，还是要回 pending —— 否则上面两条只是「一律不回退」，
          //    她的草稿会全部卡死在 sent，功能等于废掉。
          forge('t-notsent');
          SAY_SENDERS.xhs = async () => {
            const e = new Error('浏览器没起来，点都没点成'); e.notSent = true; throw e;
          };
          await post('/api/social-browser/draft-send', { draftId: 't-notsent', text: '她改过的这一版' });
          t('☑ 对照：确定没发出去的草稿要退回 pending（不然上面那条「不回退」是假的严格）',
            recOf('t-notsent') && recOf('t-notsent').state === 'pending',
            recOf('t-notsent') && recOf('t-notsent').state);

          // ③ 退回 pending 之后，看板上显示的必须是**她改过的那一版**，不是模型原稿。
          //    旧写法只写 sentText，rec.text 还是原稿；她把 A 改成 B 才点的发送，
          //    失败回来看到又是 A，再点一次就把她明确否掉的 A 发出去了。
          const shownBack = (await get('/api/social-browser/drafts')).drafts
            .find(x => x.at === 't-notsent');
          t('★★ 发送失败退回看板的，是她改过的正文，不是模型原稿',
            !!shownBack && shownBack.text === '她改过的这一版', shownBack && shownBack.text);

          // ④ 正在飞的草稿不许扔。手机上那块没刷新的看板点「扔了」，界面说扔了、
          //    评论照样飞出去 —— 她被界面骗了；而且收尾还会把 dropped 翻回 pending。
          forge('t-inflight');
          sendCalls = [];
          sendDelay = 200;
          SAY_SENDERS.xhs = stubXhs;
          const flying = post('/api/social-browser/draft-send', { draftId: 't-inflight', text: '谢谢喜欢' });
          await new Promise(r => setTimeout(r, 60));       // 等它标上 sending、请求在飞
          const midState = recOf('t-inflight');
          t('☑ 前提：这一刻它确实处在 sending（否则下面测的是别的状态）',
            midState && midState.state === 'sending', midState && midState.state);
          const dropInFlight = await post('/api/social-browser/draft-resolve',
            { draftId: 't-inflight', action: 'dropped' });
          await flying;
          t('★★ 正在飞的草稿扔不掉（扔得掉的话界面说「扔了」而评论照样发出去）',
            !dropInFlight.j.ok && dropInFlight.status === 409, dropInFlight.j);
          t('★★ 而且它最终是 sent，不是被那次「扔了」改成的 dropped',
            recOf('t-inflight') && recOf('t-inflight').state === 'sent',
            recOf('t-inflight') && recOf('t-inflight').state);
          sendDelay = 0;

          // ④b 发送租约（sendGen）。和起草那边的 gen 同一个理由：收尾**只认自己抢到的那一次**。
          //     场景：发送在飞的时候，另一个进程把这条 sending 归一化掉、又重新抢了一次
          //     （将来给「卡死的 sending」加自愈就会这样）。不比 sendGen 的话，
          //     我这次的结果会盖到别人那一次的记录上。
          forge('t-lease');
          sendCalls = [];
          sendDelay = 200;
          SAY_SENDERS.xhs = stubXhs;
          const leaseFlying = post('/api/social-browser/draft-send', { draftId: 't-lease', text: '谢谢喜欢' });
          await new Promise(r => setTimeout(r, 60));
          {
            const mid = JSON.parse(fs.readFileSync(TMP_DRAFTS, 'utf8'));
            const rec = (mid.drafts || []).find(x => x.at === 't-lease');
            t('☑ 前提：这一刻它拿着一份发送租约（没有的话下面测的是空气）',
              !!(rec && rec.state === 'sending' && rec.sendGen), rec && rec.sendGen);
            if (rec) rec.sendGen = 'someone-elses-send-lease';   // state 保持 sending
            fs.writeFileSync(TMP_DRAFTS, JSON.stringify(mid));
          }
          await leaseFlying;
          t('★★ sendGen 对不上就什么都不写（否则会把这次的结果盖进别人那一次的记录）',
            recOf('t-lease') && recOf('t-lease').state === 'sending'
            && recOf('t-lease').sendGen === 'someone-elses-send-lease',
            recOf('t-lease') && { state: recOf('t-lease').state, gen: recOf('t-lease').sendGen });
          sendDelay = 0;

          // ⑤ unknown 现在能人工退回，所以它必须留着再次发送所需的 token；
          //    只有确定结束的普通 sent 才继续清理短命凭据。
          t('★★ sayState:unknown 的记录必须留着 token（否则人工恢复后草稿发不出去）',
            recOf('t-unknown') && recOf('t-unknown').token === 'tok_t-unknown',
            recOf('t-unknown') && recOf('t-unknown').token);
          t('☑ 对照：普通 sent 的记录 token 照旧被删掉（不能让短命凭据常驻历史）',
            !recOf('t-inflight').token && !recOf('t-ledger').token,
            { inflight: recOf('t-inflight').token, ledger: recOf('t-ledger').token });
          t('☑ 对照：还没发的那条仍然留着 token（发送时服务端要用它）',
            !!recOf('t-notsent').token, recOf('t-notsent').token);
        } finally {
          healLedger();
          SAY_SENDERS.xhs = stubXhs;
          sendDelay = 0;
        }

        // ⑥ 身份不许从时间派生。原来幂等键是 `at`，我给它加过「撞了就往后挪毫秒」——
        //    Codex 三审判这个方案输了：挪毫秒只降低碰撞概率，没有建立身份不变式。
        //    系统时钟回拨之后，新草稿会复用一个旧看板还攥着的时间戳，`.find()` 不会 404，
        //    它会命中**另一条** —— 她在 B 的卡片上点发送，B 的文字发到 A 那条笔记底下。
        //    现在幂等键是 UUID。判据：把时钟**冻死**，两条草稿的身份仍然必须不同。
        //    （拿 `at` 派生的任何方案在这个前提下都必然撞。）
        {
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [], seen: [], quota: null }));
          fs.writeFileSync(TMP_INBOX, JSON.stringify({
            v: 1, lastPollAt: Date.now(), me: { userId: 'me' }, seen: ['g1', 'g2'], chats: {},
            items: ['g1', 'g2'].map((m, i) => ({
              kind: 'mention', mid: m, at: 7000 + i, who: '同毫秒' + i, text: '好看', self: false,
              note: { id: 'n_' + m, token: 'tok_' + m, title: 'T', deleted: false },
            })),
          }));
          const RealDate = Date;
          const FROZEN = RealDate.now();
          // eslint-disable-next-line no-global-assign
          Date = class extends RealDate {
            constructor(...a) { if (a.length) super(...a); else super(FROZEN); }
            static now() { return FROZEN; }
          };
          let g1, g2;
          try {
            g1 = await post('/api/social-browser/draft');
            g2 = await post('/api/social-browser/draft');
          } finally {
            // eslint-disable-next-line no-global-assign
            Date = RealDate;
          }
          t('☑ 前提：时钟冻住了，两条草稿都落地了（不落地的话下面测了空气）',
            !!(g1.j.draft && g2.j.draft), { a: !!g1.j.draft, b: !!g2.j.draft });
          t('☑ 前提：时钟真的冻住了 —— 两条草稿的 at 完全相同（不同就说明没冻上）',
            !!(g1.j.draft && g2.j.draft && g1.j.draft.at === g2.j.draft.at),
            { a: g1.j.draft && g1.j.draft.at, b: g2.j.draft && g2.j.draft.at });
          t('★★ 时钟冻死时两条草稿的 draftId 仍然不同（身份不许从时间派生）',
            !!(g1.j.draft && g2.j.draft && g1.j.draft.draftId && g2.j.draft.draftId
               && g1.j.draft.draftId !== g2.j.draft.draftId),
            { a: g1.j.draft && g1.j.draft.draftId, b: g2.j.draft && g2.j.draft.draftId });
        }

        // ⑦ 发送前的基础设施错误发生在 sender 之前，必须明确标成 notSent。
        //    不然 fail-closed 会把「一个字都没发」记成 sent，草稿永远从看板消失。
        {
          forge('t-pre');
          sendCalls = [];
          SAY_SENDERS.xhs = async (id, token, text) => {
            sendCalls.push({ id, token, text });
            return { state: 'submitted', commentId: 'never', status: 200 };
          };
          breakLedger();
          try {
            await post('/api/social-browser/draft-send', { draftId: 't-pre', text: '发送前先坏掉' });
          } finally {
            healLedger();
          }
          t('★★ 发送前的基础设施错误要退回 pending，且发送器一次没调（否则草稿永久丢失）',
            sendCalls.length === 0 && recOf('t-pre') && recOf('t-pre').state === 'pending',
            { calls: sendCalls.length, state: recOf('t-pre') && recOf('t-pre').state });
        }

        // ⑧ 读坏的草稿本子不许伪装成第一次启动。功能报错是可见的，静默清空 seen
        //    会让已经回过的旧评论重新进候选池，最终重复回复。
        {
          const broken = '{ 坏了';
          fs.writeFileSync(TMP_DRAFTS, broken, 'utf8');
          const badResp = await fetch(base + '/api/social-browser/drafts');
          const badBody = await badResp.text();
          let badJson = null;
          try { badJson = JSON.parse(badBody); } catch { }
          t('★★ 草稿本子读坏时不许谎报 ok:true 空列表（否则下一次保存会整本清空）',
            badResp.status >= 500 && !(badJson && badJson.ok === true
              && Array.isArray(badJson.drafts) && badJson.drafts.length === 0),
            { status: badResp.status, body: badBody.slice(0, 120) });
          t('★★ 草稿本子读失败后坏文件必须原封不动（静默盖成空本子会让旧评论复活）',
            fs.readFileSync(TMP_DRAFTS, 'utf8') === broken,
            fs.readFileSync(TMP_DRAFTS, 'utf8').slice(0, 120));
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [], seen: [], quota: null }));
        }

        const writeOneCandidate = (mid) => fs.writeFileSync(TMP_INBOX, JSON.stringify({
          v: 1, lastPollAt: Date.now(), me: { userId: 'me' }, seen: [mid], chats: {},
          items: [{
            kind: 'mention', mid, at: Date.now(), who: '路人', text: '好看', self: false,
            note: { id: 'n_' + mid, token: 'tok_' + mid, title: 'T', deleted: false },
          }],
        }));

        // ⑨ 截断只裁终态；把活的放在最前面，专门打无脑 slice(-N) 的薄弱处。
        {
          const oldDay = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE');
          const live = [
            { date: oldDay, at: 'trim-sending', draftId: 'trim-sending', mid: 'trim-s', state: 'sending' },
            { date: oldDay, at: 'trim-pending', draftId: 'trim-pending', mid: 'trim-p', state: 'pending' },
          ];
          const done = Array.from({ length: DRAFT_KEEP + 2 }, (_, i) => ({
            date: oldDay, at: 'trim-done-' + i, draftId: 'trim-done-' + i,
            mid: 'trim-d-' + i, state: 'dropped',
          }));
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: live.concat(done), seen: [], quota: null }));
          writeOneCandidate('trim-new');
          modelText = '谢谢你呀';
          await post('/api/social-browser/draft');
          const afterTrim = loadDrafts().drafts || [];
          t('★★ trimDrafts 不许裁掉排在最前面的 sending / pending（否则发送租约或待审草稿会消失）',
            afterTrim.some(x => x.draftId === 'trim-sending' && x.state === 'sending')
              && afterTrim.some(x => x.draftId === 'trim-pending' && x.state === 'pending'),
            afterTrim.map(x => ({ id: x.draftId, state: x.state })));
        }

        // ⑩ 活跃草稿不裁，就用独立上限 fail-closed；必须在花模型钱之前拦住。
        {
          const oldDay = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE');
          const live = Array.from({ length: DRAFT_LIVE_MAX }, (_, i) => ({
            date: oldDay, at: 'live-' + i, draftId: 'live-' + i, mid: 'live-mid-' + i,
            state: 'pending', site: 'xhs', id: 'live-note-' + i, token: 'live-token-' + i, text: '待审',
          }));
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: live, seen: [], quota: null }));
          writeOneCandidate('live-new');
          const beforeLiveMax = modelCalls;
          const overLive = await post('/api/social-browser/draft');
          t('★★ DRAFT_LIVE_MAX 到顶必须拒绝起草且不调模型（否则活跃列表会无限长）',
            !overLive.j.ok && modelCalls === beforeLiveMax,
            { ok: overLive.j.ok, before: beforeLiveMax, now: modelCalls, max: DRAFT_LIVE_MAX });
        }

        // ⑪ 评论已发出去后，草稿销账失败只能作为 bookkeeping 附带说明，不能把成功说成失败。
        {
          const DRAFT_TMP = TMP_DRAFTS + '.tmp';
          forge('t-bookkeeping');
          sendCalls = [];
          healLedger();
          try { fs.unlinkSync(TMP_STATE); } catch { }
          SAY_SENDERS.xhs = async (id, token, text) => {
            sendCalls.push({ id, token, text });
            fs.mkdirSync(DRAFT_TMP);
            return { state: 'submitted', commentId: 'c-bookkeeping', status: 200 };
          };
          let booked;
          try {
            booked = await post('/api/social-browser/draft-send',
              { draftId: 't-bookkeeping', text: '这条已经发出去了' });
          } finally {
            try { fs.rmdirSync(DRAFT_TMP); } catch { }
          }
          t('★★ 草稿销账失败仍然要报成功并带 bookkeeping（报失败会诱导重复评论）',
            booked.j.ok === true && typeof booked.j.bookkeeping === 'string' && booked.j.bookkeeping.length > 0,
            booked.j);
        }

        // ⑫ generating 被判死已经是终态，短命 token 也必须随之清掉。
        {
          const at = new Date(Date.now() - GENERATING_STALE_MS - 1000).toISOString();
          const healed = healStaleGenerating({
            drafts: [{ state: 'generating', at, token: 'tok-stale-generating' }],
          });
          t('★★ healStaleGenerating 判成 failed 时必须删 token（终态不留短命凭据）',
            healed.drafts[0].state === 'failed'
              && !Object.prototype.hasOwnProperty.call(healed.drafts[0], 'token'),
            healed.drafts[0]);
        }

        // ⑬ 四审：sent 只是 fail-closed 的账面终态，sayState:unknown 不能被二次请求
        //     升级成「确定发过」。仍然拒绝重发，但要把不确定性原样说出来。
        {
          forge('t-fourth-unknown', { state: 'sent', sayState: 'unknown' });
          sendCalls = [];
          SAY_SENDERS.xhs = stubXhs;
          const unknownAgain = await post('/api/social-browser/draft-send',
            { draftId: 't-fourth-unknown', text: '绝不能再发一次' });
          t('★★ unknown 记录再次点发送仍拒绝重发，但不许升级成「确定发过」',
            unknownAgain.j.unknown === true && unknownAgain.j.already !== true && sendCalls.length === 0,
            { response: unknownAgain.j, calls: sendCalls.length });
        }

        // ⑭ 四审：需要人确认的记录是 attention，不是可截断的历史。
        {
          const done = Array.from({ length: 16 }, (_, i) => ({
            date: '2020-01-01', at: 'attention-done-' + i, draftId: 'attention-done-' + i,
            mid: 'attention-mid-' + i, state: 'dropped', site: 'xhs', id: 'done-note-' + i,
          }));
          const needsEyes = {
            date: '2020-01-01', at: 'attention-sending', draftId: 'attention-sending',
            mid: 'attention-live', state: 'sending', site: 'xhs', id: 'attention-note',
            from: { who: '还在飞的那条', text: '看我', note: 'T' }, text: '待确认',
          };
          const unknownEyes = {
            date: '2020-01-01', at: 'attention-unknown', draftId: 'attention-unknown',
            mid: 'attention-unknown', state: 'sent', sayState: 'unknown', site: 'xhs', id: 'unknown-note',
          };
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [needsEyes, unknownEyes].concat(done), seen: [] }));
          const attention = await get('/api/social-browser/drafts');
          t('★★ sending / unknown 必须全在不截断的 attention（后面有 15+ 条终态也不能挤掉）',
            (attention.attention || []).some(x => x.draftId === 'attention-sending')
              && (attention.attention || []).some(x => x.draftId === 'attention-unknown')
              && (attention.history || []).length === 10,
            { attention: (attention.attention || []).map(x => x.draftId), history: (attention.history || []).length });
        }

        // ⑮ 四审：老记录的时间戳不是身份；即使两条 at 完全相同，也要一次迁移成不同 UUID。
        {
          const legacy = [0, 1].map(i => ({
            date: '2020-01-01', at: 'same-old-at', mid: 'legacy-' + i, state: 'pending',
            site: 'xhs', id: 'legacy-note-' + i, token: 'legacy-token-' + i, text: '老草稿' + i,
          }));
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: legacy, seen: [] }));
          const migrationResp = await fetch(base + '/api/social-browser/drafts');
          await migrationResp.text();
          const migrated = JSON.parse(fs.readFileSync(TMP_DRAFTS, 'utf8')).drafts || [];
          t('★★ 相同 at 的老记录要在锁里迁移并立即落盘成两个不同 draftId',
            migrationResp.ok && migrated.length === 2 && migrated.every(x => !!x.draftId)
              && migrated[0].draftId !== migrated[1].draftId,
            { status: migrationResp.status, ids: migrated.map(x => x.draftId) });

          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [
            { at: 'dup-a', draftId: 'same-id', state: 'pending' },
            { at: 'dup-b', draftId: 'same-id', state: 'pending' },
          ], seen: [] }));
          let duplicateError = '';
          try { loadDrafts(); } catch (e) { duplicateError = e.message; }
          t('★★ 加载发现重复 draftId 必须 fail-closed，绝不能让发送端 find() 猜第一条',
            /重复 draftId/.test(duplicateError), duplicateError);
        }

        // ⑯ 四审：GET 的持锁恢复要把 stale generating 真正写回磁盘，而不是只改返回对象。
        {
          const at = new Date(Date.now() - GENERATING_STALE_MS - 1000).toISOString();
          fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [{
            date: '2020-01-01', at, draftId: 'stale-on-disk', mid: 'stale-on-disk',
            state: 'generating', token: 'token-must-leave-disk', site: 'xhs', id: 'stale-note',
          }], seen: [] }));
          await get('/api/social-browser/drafts');
          const diskRec = JSON.parse(fs.readFileSync(TMP_DRAFTS, 'utf8')).drafts[0];
          t('★★ /drafts 恢复 stale generating 后必须落盘为 failed 且删掉 token',
            diskRec.state === 'failed' && !Object.prototype.hasOwnProperty.call(diskRec, 'token'),
            diskRec);
        }

        // ⑰ 四审：新一轮发送不继承上一次的错误；成功审计也不能同时挂着旧失败原因。
        {
          forge('t-clear-old-error', {
            error: '上一轮锁超时', sayState: 'unknown', resolvedAt: '2020-01-01T00:00:00.000Z',
          });
          sendCalls = [];
          sendDelay = 150;
          SAY_SENDERS.xhs = stubXhs;
          const retrying = post('/api/social-browser/draft-send',
            { draftId: 't-clear-old-error', text: '第二次这回成功' });
          await new Promise(r => setTimeout(r, 50));
          const whileSending = recOf('t-clear-old-error');
          await retrying;
          const afterSuccess = recOf('t-clear-old-error');
          t('★★ 新发送开始就清上次状态，重试成功后审计记录也不许残留旧 error',
            whileSending && whileSending.state === 'sending'
              && !Object.prototype.hasOwnProperty.call(whileSending, 'error')
              && !Object.prototype.hasOwnProperty.call(whileSending, 'sayState')
              && afterSuccess && afterSuccess.state === 'sent'
              && !Object.prototype.hasOwnProperty.call(afterSuccess, 'error'),
            { whileSending, afterSuccess });
          sendDelay = 0;
        }

        // ⑱ 人工确认 unknown 确实没发出去：只开这一条恢复路，而且恢复本身绝不发送。
        {
          forge('t-recheck-ok', {
            state: 'sent', sayState: 'unknown', text: '她上次提交的这一版', sentText: '她上次提交的这一版',
            error: '网络在 POST 后断了', resolvedAt: '2020-01-01T00:00:00.000Z',
          });
          sendCalls = [];
          SAY_SENDERS.xhs = stubXhs;
          const rechecked = await post('/api/social-browser/draft-recheck',
            { draftId: 't-recheck-ok', action: 'notsent' });
          const recheckedRec = recOf('t-recheck-ok');
          t('★★ unknown 经人工确认后才退回 pending，保留她上次正文且不在恢复时偷发',
            rechecked.status === 200 && rechecked.j.ok === true
              && recheckedRec && recheckedRec.state === 'pending'
              && recheckedRec.text === '她上次提交的这一版' && sendCalls.length === 0
              && !Object.prototype.hasOwnProperty.call(recheckedRec, 'sayState')
              && !Object.prototype.hasOwnProperty.call(recheckedRec, 'error')
              && !Object.prototype.hasOwnProperty.call(recheckedRec, 'resolvedAt')
              && recheckedRec.recheckedFrom === 'unknown'
              && !Number.isNaN(Date.parse(recheckedRec.recheckedAt)),
            { response: rechecked.j, rec: recheckedRec, calls: sendCalls.length });

          forge('t-recheck-ordinary-sent', { state: 'sent', text: '已经确定发出的正文' });
          const ordinaryBefore = JSON.stringify(recOf('t-recheck-ordinary-sent'));
          const ordinary = await post('/api/social-browser/draft-recheck',
            { draftId: 't-recheck-ordinary-sent', action: 'notsent' });
          t('★★ 普通 sent 绝不能人工退回（否则会制造重复评论），且拒绝后记录一个字不变',
            ordinary.status === 409
              && /state「sent」\/ sayState「空」/.test(String(ordinary.j.error || ''))
              && JSON.stringify(recOf('t-recheck-ordinary-sent')) === ordinaryBefore,
            { response: ordinary.j, before: ordinaryBefore, after: recOf('t-recheck-ordinary-sent') });

          const wrongStates = ['pending', 'sending', 'dropped'];
          for (const state of wrongStates) forge('t-recheck-' + state, { state, sayState: 'unknown' });
          const wrongStateResponses = [];
          for (const state of wrongStates) {
            wrongStateResponses.push(await post('/api/social-browser/draft-recheck',
              { draftId: 't-recheck-' + state, action: 'notsent' }));
          }
          t('★ pending / sending / dropped 都不能冒充 sent+unknown 退回草稿（否则状态机可被倒写）',
            wrongStateResponses.every((r, i) => r.status === 409
              && String(r.j.error || '').includes(`state「${wrongStates[i]}」`)),
            wrongStateResponses.map(r => ({ status: r.status, error: r.j.error })));

          const badActions = ['sent', 'dropped', ''];
          for (let i = 0; i < badActions.length; i++) {
            forge('t-recheck-action-' + i, { state: 'sent', sayState: 'unknown' });
          }
          const actionBefore = badActions.map((_, i) => JSON.stringify(recOf('t-recheck-action-' + i)));
          const actionResponses = [];
          for (let i = 0; i < badActions.length; i++) {
            actionResponses.push(await post('/api/social-browser/draft-recheck',
              { draftId: 't-recheck-action-' + i, action: badActions[i] }));
          }
          t('★ draft-recheck 只接受 action:notsent（sent / dropped / 空不能写记录）',
            actionResponses.every(r => r.status === 400)
              && actionBefore.every((before, i) => JSON.stringify(recOf('t-recheck-action-' + i)) === before),
            actionResponses.map(r => ({ status: r.status, error: r.j.error })));

          const missing = await post('/api/social-browser/draft-recheck',
            { draftId: 't-recheck-does-not-exist', action: 'notsent' });
          t('★ draft-recheck 找不到 draftId 必须 404（不能假装恢复成功）',
            missing.status === 404 && !missing.j.ok, missing);

          forge('t-recheck-lease', { state: 'sent', sayState: 'unknown', sendGen: 'still-flying' });
          const leaseBefore = JSON.stringify(recOf('t-recheck-lease'));
          const leased = await post('/api/social-browser/draft-recheck',
            { draftId: 't-recheck-lease', action: 'notsent' });
          t('★ sendGen 还在的 unknown 不能人工退回（未收尾发送不能被另一条路接管）',
            leased.status === 409 && /sendGen/.test(String(leased.j.error || ''))
              && JSON.stringify(recOf('t-recheck-lease')) === leaseBefore,
            { response: leased.j, after: recOf('t-recheck-lease') });

          forge('t-recheck-flow', {
            state: 'sent', sayState: 'unknown', text: '确认没有后再发的这一版',
            error: '回程断了', resolvedAt: '2020-01-01T00:00:00.000Z',
          });
          sendCalls = [];
          const flowRecheck = await post('/api/social-browser/draft-recheck',
            { draftId: 't-recheck-flow', action: 'notsent' });
          const flowSend = await post('/api/social-browser/draft-send',
            { draftId: 't-recheck-flow', text: recOf('t-recheck-flow').text });
          t('★★ unknown → recheck → draft-send 全链路只调用一次发送器并落成 sent（恢复不能双发）',
            flowRecheck.j.ok === true && flowSend.j.ok === true && sendCalls.length === 1
              && sendCalls[0].text === '确认没有后再发的这一版'
              && recOf('t-recheck-flow') && recOf('t-recheck-flow').state === 'sent',
            { recheck: flowRecheck.j, send: flowSend.j, calls: sendCalls, rec: recOf('t-recheck-flow') });

          // ⚠️⚠️ 上面那七条全是用 forge() 手工造出来的 sayState:'unknown' ——
          //   **验了闸，没验闸筛的对象是不是只有一种**。`unknown` 其实有两个来源，语义相反：
          //     ① 发送抛错、发没发出去判不出来（err.unknown）  ← 这种才该退回
          //     ② 发送**成功返回了**，只是小红书回的 status 字段不认识（sendComment 891 行：
          //        `typeof c.status === 'number' ? 'submitted' : 'unknown'`）—— 那一行拿得到
          //        j.data.comment，**评论真的已经发出去了**。
          //   ②被当成①放进 /draft-recheck 的话：用户按提示去评论区看（status 缺失的评论多半
          //   正在审核，她自己都看不见）→ 看不到 → 点退回 → 点发送 → **第二条评论**。
          //   所以收尾那里必须给②改名（'submitted?'），下面这四条守的就是那个改名。
          {
            const okXhs = SAY_SENDERS.xhs;
            SAY_SENDERS.xhs = async (id, token, text) => {
              sendCalls.push({ id, token, text });
              // 成功返回，但状态码不认识 —— 评论已经飞出去了
              return { state: 'unknown', commentId: 'c-nostatus', status: undefined };
            };
            forge('t-sent-nostatus', { state: 'pending', text: '状态码不认识的这一条' });
            sendCalls = [];
            const nsSend = await post('/api/social-browser/draft-send',
              { draftId: 't-sent-nostatus', text: '状态码不认识的这一条' });
            const nsRec = recOf('t-sent-nostatus');
            t('★★ 发送成功但状态码不认识，落成 sent 且 sayState 不许叫 unknown（那是「没发出去」的名字）',
              nsSend.j.ok === true && sendCalls.length === 1
                && nsRec && nsRec.state === 'sent' && nsRec.sayState !== 'unknown',
              { response: nsSend.j, rec: nsRec });

            t('★ 这条不进 attention（它不需要用户去确认，评论已经发出去了）',
              !((await get('/api/social-browser/drafts')).attention || [])
                .some(x => x.draftId === 't-sent-nostatus'),
              (await get('/api/social-browser/drafts')).attention);

            t('★ 这条是终态，token 照样删掉（保 token 的例外只给真的 unknown）',
              nsRec && !Object.prototype.hasOwnProperty.call(nsRec, 'token'), nsRec);

            const nsRecheck = await post('/api/social-browser/draft-recheck',
              { draftId: 't-sent-nostatus', action: 'notsent' });
            const nsAfterRecheck = recOf('t-sent-nostatus');
            const nsAgain = await post('/api/social-browser/draft-send',
              { draftId: 't-sent-nostatus', text: '状态码不认识的这一条' });
            t('★★ 一条真发出去的评论，recheck 退不回、再点发送也顶回「发过了」，发送器一次都不再调',
              nsRecheck.status === 409 && nsRecheck.j.ok !== true
                && nsAfterRecheck && nsAfterRecheck.state === 'sent'
                && nsAgain.j.ok !== true && nsAgain.j.already === true
                && sendCalls.length === 1,
              { recheck: nsRecheck.j, again: nsAgain.j, calls: sendCalls.length, rec: nsAfterRecheck });

            SAY_SENDERS.xhs = okXhs;
          }
        }
      }

      // ── 截断：审计历史可以截，去重凭据不能跟着截 ──────────────
      //
      // ⚠️ 这一组是 2026-08-28 故障注入逼出来的。原来这里只有一句
      //   `DRAFT_SEEN_KEEP > DRAFT_KEEP` —— **验常量**，而注入改的是 `.slice()` 那个动作，
      //   常量一个没变，断言全绿。判据必须触及截断本身，所以这里把 DRAFT_KEEP 调到 3、
      //   真起草 5 条，看最早那条会不会复活。
      {
        modelDelay = 0;                                   // 这一组不需要慢，跑快点
        // ⚠️ 让这五条**落成终态**（模型回「跳过」→ state:'skipped'）。
        //   trimDrafts 现在只裁终态、活着的一条都不裁（Codex 三审：截断把正在发的
        //   草稿挤掉过），所以留成 pending 的话根本不会发生截断，
        //   下面那条「seen 没跟着截断」就证明不了任何东西。
        modelText = '跳过';
        // ⚠️ quota 也要清。带着前面几组用掉的额度进来的话，5 次起草会有几次被额度挡掉，
        //   于是「mid 不在 seen 里」的原因变成了「压根没起草」而不是「被截断吃了」——
        //   断言照样红，但红得**指向错的地方**（第一次跑就是这样：seen 里只有 4 个）。
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [], seen: [], quota: null }));
        const mids = ['t1', 't2', 't3', 't4', 't5'];
        fs.writeFileSync(TMP_INBOX, JSON.stringify({
          v: 1, lastPollAt: Date.now(), me: { userId: 'me' }, seen: mids, chats: {},
          items: mids.map((m, i) => ({
            kind: 'mention', mid: m, at: 1000 + i, who: '路人' + i, text: '第' + i + '条', self: false,
            note: { id: 'n_' + m, token: 'tok_' + m, title: 'T', deleted: false },
          })),
        }));
        for (let i = 0; i < mids.length; i++) await post('/api/social-browser/draft');

        const d = loadDrafts();
        // ⚠️ 判据是「条数真的少于起草次数」，不是「<= DRAFT_KEEP」。
        //   截断只在**插入的那一刻**发生（trimDrafts 在 concat 之后跑），
        //   所以最后一条落成终态之后不会再裁一次 —— 稳定值是 KEEP+1 而不是 KEEP。
        //   这条要证的是「截断确实发生了」，不是那个具体数字。
        t('☑ 审计历史确实被截断了（不截的话下面那条证明不了什么）',
          (d.drafts || []).length < mids.length,
          { drafts: (d.drafts || []).length, 起草了: mids.length, DRAFT_KEEP });
        t('★★ 被截掉的那几条，mid 仍然留在去重集合里（Codex：截断吃掉凭据→旧评论复活）',
          mids.every(m => (d.seen || []).includes(m)),
          { seen: d.seen, 少了: mids.filter(m => !(d.seen || []).includes(m)) });
        t('★★ 而且最早那条真的不会被再抽中（这才是「复活」的定义）',
          draftCandidates(JSON.parse(fs.readFileSync(TMP_INBOX, 'utf8')), { doneIds: d.seen || [] })
            .every(c => c.mid !== 't1'));
        modelDelay = 300;
        modelText = '哈哈是自己调的';
      }

      // ── 额度：每起草一次真的扣一次 ──────────────
      // ⚠️ 下面那组是**手写** quota 再验拦截，它证明不了「起草会扣额度」——
      //   把 bumpDraftQuota 那行删掉，那组照样全绿（2026-08-28 故障注入逮到）。
      //   所以这里单独跑一次真起草，看计数器自己涨没涨。
      {
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify({ drafts: [], seen: [], quota: null }));
        // ⚠️ 这里必须读**原始计数器**（d.quota.used），不能读 draftQuotaUsed。
        //   draftQuotaUsed 是「计数器和当天条数的大值」，起草本身就会往 drafts 里加一条，
        //   于是拿它做判据的话，把 bumpDraftQuota 整个删掉这条断言照样绿 ——
        //   2026-08-28 加那个 max 兜底时我自己把这条弄成假绿的，故障注入当场逮到（红 0 命中 0）。
        const rawUsed = () => ((loadDrafts().quota || {}).used | 0);
        const q0 = rawUsed();
        await post('/api/social-browser/draft');
        t('★★ 每起草一次，额度计数器真的涨一格（不涨的话每天六次的闸等于没有）',
          rawUsed() === q0 + 1, { q0, now: rawUsed() });
      }

      // ── 额度：起草上限到了就不再调模型 ──
      // ⚠️ 额度写的是**独立计数器**，不是数 drafts 列表 —— 列表会被 DRAFT_KEEP 截断，
      //   拿它当账的话，把 KEEP 调到比上限小就能让额度检查静默失效。
      const before = modelCalls;
      const d0 = loadDrafts();
      d0.quota = { date: new Date().toLocaleDateString('sv-SE'), used: DRAFT_DAILY_MAX };
      fs.writeFileSync(TMP_DRAFTS, JSON.stringify(d0));
      const over = await post('/api/social-browser/draft');
      t('★ 起草额度用完就不再调模型（花钱的动作要真被拦住，不是只报个错）',
        !over.j.ok && modelCalls === before, { ok: over.j.ok, before, now: modelCalls });
      t('★★ 额度记在独立计数器上，不随审计历史截断而失效（KEEP=3 < 上限 6，列表里根本放不下）',
        !over.j.ok && (loadDrafts().drafts || []).length <= DRAFT_KEEP, DRAFT_KEEP);

      // ── 额度：没有 quota 字段的本子（早期格式 / 手改过 / 写了一半）──
      // ⚠️ Codex 二审：只看计数器的话，「当天有 6 条记录但没有 quota 字段」= 额度归零，
      //   当天又能白花六次模型钱。所以取**计数器和当天条数的大值**。
      //   这个 max 是安全的：drafts 里每条当天记录都对应一次真实的 bumpDraftQuota，
      //   截断只会让它少数、永远不会多数 —— 它是下界，不是替代品。
      {
        const day = new Date().toLocaleDateString('sv-SE');
        const old = { seen: [], drafts: [] };           // 注意：**没有 quota 字段**
        for (let i = 0; i < DRAFT_DAILY_MAX; i++) {
          old.drafts.push({ date: day, at: 'legacy' + i, mid: 'lg' + i, state: 'pending', text: 'x' });
        }
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify(old));
        t('★★ 旧格式（当天有记录、没 quota 字段）不许把额度算成 0',
          draftQuotaUsed(loadDrafts()) >= DRAFT_DAILY_MAX, draftQuotaUsed(loadDrafts()));
        const b2 = modelCalls;
        const r2 = await post('/api/social-browser/draft');
        t('★★ 而且真的拦住了花钱的那一步（不是只把数字算对）',
          !r2.j.ok && modelCalls === b2, { ok: r2.j.ok, before: b2, now: modelCalls });
      }
      // ☑ 对照：同样没有 quota 字段，但记录是**昨天**的 —— 那今天就该是满额，不能连坐
      {
        const y = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE');
        fs.writeFileSync(TMP_DRAFTS, JSON.stringify({
          seen: [], drafts: [{ date: y, at: 'old1', mid: 'o1', state: 'pending', text: 'x' }],
        }));
        t('☑ 对照：昨天的记录不占今天的额度（跨天要真的重置，否则第二天一次都起草不了）',
          draftQuotaUsed(loadDrafts()) === 0, draftQuotaUsed(loadDrafts()));
      }
    } finally {
      SAY_SENDERS.xhs = origXhs;
      // ⚠️ 先掐掉 keep-alive 再 close。`close()` 只是不再收新连接，**已有的连接不断开它就一直等** ——
      //   而 fetch 默认保持连接，于是整个测试文件挂在这儿，直到注入机制 90 秒超时把它杀掉。
      //   症状是「<tests/social.test.js 跑不起来/挂住>」，看着像测试写坏了，其实只是没关干净。
      //   （2026-08-28 故障注入逮到：某条本该让断言变红的注入，报出来是「命中 0」。）
      srv.closeAllConnections?.();
      await new Promise(r => srv.close(r));
    }
  }

  // ── 起草崩在半路 ────────────────────────────────
  t('★ generating 记录崩过阈值就归一化成 failed（不然崩几次就把当天额度吃光，看板还什么都不显示）',
    (() => {
      const at = new Date(Date.now() - GENERATING_STALE_MS - 60000).toISOString();
      const d = healStaleGenerating({ drafts: [{ state: 'generating', at }] });
      return d.drafts[0].state === 'failed';
    })());
  // ⚠️ 阈值必须**大于一次合法调用的时间上界**，否则会把还活着的请求判死（Codex 二审）。
  //   上界看 server.js 的 claudeOnce：claude CLI 进程硬超时 CLAUDE_ONCE_TIMEOUT_MS = 240s。
  //   这条只是把推导钉在测试里；真正兜底的是上面那条租约 CAS —— 时间上的余量不许当护栏用。
  t('☑ 陈旧阈值大于 claudeOnce 的调用上界 240s（卡在上界之内会把活着的起草判死）',
    GENERATING_STALE_MS > 240 * 1000, GENERATING_STALE_MS / 1000 + 's');
  t('☑ 对照：刚开始起草的（还没超时）不许被判死',
    (() => {
      const d = healStaleGenerating({ drafts: [{ state: 'generating', at: new Date().toISOString() }] });
      return d.drafts[0].state === 'generating';
    })());

  const draftSection = sbSrc.slice(sbSrc.indexOf('散步值班员：让小模型起草'),
                                   sbSrc.indexOf('── 挂端点'));
  // ⚠️ 必须**先把注释剥掉**再找。上面那段注释里就写着「这一节里不出现 SAY_SENDERS」——
  //   连着注释一起搜的话，这条断言会被自己要保护的那句说明弄红（第一次跑就是这样）。
  //   要验的是「代码里没有这个调用」，注释里怎么写不算数。
  const draftCode = draftSection.replace(/\/\/[^\n]*/g, '');
  t('☑ 剥完注释还剩着实打实的代码（剥成空的话下面那条就是假绿）',
    draftCode.replace(/\s/g, '').length > 800, draftCode.length);
  t('★★ 起草那一节的代码里一次都没调过发送函数（起草绝不自己发，这是定好的规矩）',
    !/SAY_SENDERS/.test(draftCode) && !/xhsSay\s*\(/.test(draftCode));

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
