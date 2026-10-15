'use strict';
// ==========================================
// 浏览器通道：让 GranCyan 借一个**真实的、登录过的** Chrome 去看和说话
//
// 为什么非要浏览器：
//   小红书的评论区（读和写都是）走 edith.xiaohongshu.com，那些接口要 x-s / x-t 签名，
//   签名是他们混淆过的 JS 现算的。纯 HTTP 拿不到（实测无签名一律 {"code":-1}）。
//   逆向那套签名是持续对抗：会断，断了不报错，而且被判成机器行为封的是用户的号。
//   所以不逆向 —— 让真浏览器自己去签，我们只负责在页面上打字和点击。
//
// ⚠️ **不碰用户日常那个 Chrome**，另起一个专用实例（独立 user-data-dir）。两个理由：
//   1. Chrome 已经在跑的时候，再带 --remote-debugging-port 启动是**不生效的** ——
//      参数被转发给已有实例然后丢掉，端口根本不会开。要生效就得先把用户所有窗口关掉，
//      那不行（用户自己可能开着一堆标签，别一刀切杀 chrome）。
//   2. 日常那个里面装着用户所有账号的登录态。这条通道只需要小红书和 B 站，
//      没必要把其余的一起交出去。
//   代价是用户得在专用实例里扫一次码。一次而已，之后 profile 一直留着。
//
// ⚠️ 只对本机开放。server 监听的是 0.0.0.0（手机版要连），而这几个端点能操作
//   一个登录着的浏览器 —— 同一个 WiFi 下谁都能调的话，等于把用户的账号摆在门口。
// ==========================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');

const PORT = Number(process.env.GRANCYAN_CHROME_PORT || 9333);
const PROFILE_DIR = process.env.GRANCYAN_CHROME_DIR
    || path.join(os.homedir(), '.grancyan', 'chrome-social');
// ⚠️ 账本和锁的位置要能被换掉，**为的是测试别去碰真的那一份**（Codex 三审逮到的）：
//   锁的测试要覆盖和删除锁文件，如果指的是生产那把，那么「用户正在发评论时我跑了一遍测试」
//   就会把真持锁者的锁删掉，另一个进程立刻进入发送区 —— 测试自己制造出并发评论。
//   故障注入还会把整套测试跑十几遍，风险乘以十几。
const STATE_FILE = process.env.GRANCYAN_SAY_STATE
    || path.join(os.homedir(), '.grancyan', 'social-says.json');
const LAN_OK = String(process.env.GRANCYAN_CHROME_LAN || '').toLowerCase() === 'on';

const CHROME_CANDIDATES = [
    process.env.GRANCYAN_CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function chromeBin() {
    for (const p of CHROME_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch {} }
    return '';
}

// ── 说话的额度与闸 ──────────────────────────────────────────
// 需求是「不要每条都评论」。所以这是**硬上限**，不是提示词里的一句叮嘱——
// 提示词不是护栏（同 GAZE_MAX_PER_TURN 那条教训）。用完就是用完。
// ⚠️ 环境变量必须**校验**，不能 Number() 完就用。
//   GRANCYAN_SAY_MAX=three → NaN → `used >= NaN` 恒为 false → **每日上限彻底消失**，
//   而且零报错零征兆（Codex 2026-08-23 逮到的）。一道写错就没了的护栏不算护栏。
//   解析不出来 / 超出合理范围一律退回默认值，并且**吼一声**。
function intEnv(name, def, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        console.warn(`[窗] ${name}=「${raw}」不是 ${min}~${max} 的整数，按默认值 ${def} 处理`);
        return def;
    }
    return n;
}
// 默认值从 3 提到了 8。原来那个 3 是从
// 「不要每条都评论」推出来的保守取值，实际用下来太紧：
// 一次调试就能把一天烧光，而真想说的那句反倒发不出去。
// 上限的意义是「别刷屏」，不是「别说话」。
const SAY_DAILY_MAX = intEnv('GRANCYAN_SAY_MAX', 8, 0, 20);

// ⚠️ 这几道闸（白名单站点、每天上限、禁词、单飞锁）是**损害上限，不是出站授权边界**。
// 它们限制「最多能造成多大的事」，但拦不住这一种：模型读了抓回来的笔记正文，被里面的话
// 诱导，发出一条**完全合规、却不是用户授意**的评论。真要防这个，缺的是发之前跟用户确认
// 一次（绑定站点 + 笔记 id + 正文 + 有效期）。
//
// Codex 四审指出过这一点，当时的决定是**不加确认闸**。
// 所以这是**明知的、被选择的**风险，不是漏掉的。
// 想动这块之前先看这段：加确认闸不是"补一个忘了的洞"，是推翻一个有意的决定。
// ⚠️ 现有的**只有事后审计**：每条都留痕在账本里（STATE_FILE）。它拦不住误发、
// 也撤不回来，更不是授权兜底 —— 别把「查得到」当成「防得住」。（Codex 五审的措辞修正：
// 我原来写的是「现有的兜底是…」，那句话会让人以为已经有一道防线了。）

// 一条普通网友的评论就是一两句。写小作文本身就是「不像普通网友」。
const SAY_MAX_LEN = intEnv('GRANCYAN_SAY_LEN', 80, 1, 300);

// 需求：「评论别把私事说出去，就像普通网友那样」。
//
// ⚠️ 这张表是**闭集**，跟当初拒绝给记忆快照加内容正则不是一回事：
//   那次要判的是「一千条记忆里哪条算私密」——开放问题，只能枚举，必然又漏又误伤，
//   所以宁可不做也不给假的安心。
//   这次要判的是「这几个特定的名字不许出现在公开评论里」——可以穷举，
//   而且普通网友的评论里本来就不会出现「GranCyan」，误伤成本约等于零。
//
// ⚠️ 但要说清它挡不住什么：它挡专有名词，挡不住「我朋友昨天哭了」这种叙述。
//   那种只能靠上下文和提示词，**这里没有护栏**。别把这张表当成万无一失。
// 项目名和默认 AI 名（克克）固定在表里；用户自己的名字 / 昵称这类按部署填进环境变量
// GRANCYAN_SAY_FORBIDDEN（逗号分隔，或写在 .env 里）。代码里不内置用户的名字。
const SAY_FORBIDDEN = [
    'GranCyan', 'Grancyan', 'grancyan', '克克',
    ...String(process.env.GRANCYAN_SAY_FORBIDDEN || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
];

// ⚠️ **哪些站允许说话，按账号归属定，不按技术难度定。**
//   小红书 —— 默认假设是专门给 AI 开的号。那是 AI 自己的位置，说话署的是 AI 的名字。
//   B 站   —— 默认假设用的是**用户自己的号**。拿用户的号说话，就是以用户的名义对陌生人说话，
//             这条线默认不开。
//   这不是提示词里的一句话，是这里的一道判断 —— 提示词不是护栏。
//   哪天给 AI 开了 B 站的号，把 'bili' 加进 GRANCYAN_SAY_SITES 即可，别改别的地方。
const SAY_ALLOWED_SITES = new Set(
    (process.env.GRANCYAN_SAY_SITES || 'xhs').split(',').map(s => s.trim()).filter(Boolean)
);

// 链接和联系方式一律不许出现在评论里。
// 不是怕打广告 —— 是记忆快照那次的教训：一个无鉴权的 ntfy 推送地址就躺在「待办」域里，
// 那种东西一旦被贴进公开评论区，就是永久的、可被任何人使用的。
const SAY_LINKISH = [
    /https?:\/\//i,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,                    // 裸 IP
    /[\w.-]+@[\w.-]+\.\w{2,}/,                        // 邮箱
    // 手机号：带不带国家码、中间有没有空格连字符，都算。
    // 原来只认光秃秃的 11 位数字，「+86 138-0013-8000」直接放行（Codex 一审逮到的）。
    /(?:\+?86[\s-]?)?\b1[3-9](?:[\s-]?\d){9}\b/,
    // 带 + 的国际号码。只认中国大陆的号码等于「新加坡的号可以随便贴」
    // （Codex 二审逮到的 +65 9123 4567）—— 又是一次枚举必漏。
    /\+\d{1,3}[\s-]?(?:\d[\s-]?){6,14}\d/,
    // 光秃秃的域名。原来是后缀白名单（com|cn|net…），`example.xyz` 就绕过去了。
    // 改成**看形状**：字母数字开头 + 点 + 纯字母后缀。
    // 后缀长度也不能卡死在 8 —— `.photography` 有 11 位（Codex 二审逮到的）。
    // 现存最长的 TLD 是 24 位。后缀列表是开放集合（新 TLD 每年都在加），
    // 枚举必漏 —— 这是「安全判据别枚举写法」的同一个坑，换成论证反面：不像域名的才放行。
    /\b[a-z0-9][a-z0-9-]{1,}\.[a-z]{2,24}\b(?![a-z])/i,
];

// 规范化之后再比。**这一步不能省**：
//   全大写的名字、全角的「ＧｒａｎＣｙａｎ」、名字中间插一个零宽字符，
//   在原来的 includes 比较里全都直接放行（Codex 2026-08-23 逮到的）。
//   往禁词表里补大写变体是没有尽头的 —— 该做的是把输入拉平，再拿一张表去比。
// ⚠️ 这里**不许手抄一张控制符清单**。我第一版抄了一串零宽字符，
//   Codex 二审当场拿 U+2066（LRI，方向隔离符）绕过去了 —— 又是枚举必漏。
//   \p{Cf} 是 Unicode 的「格式控制字符」整类，抄不漏，因为不是我抄的。
//   顺手把变体选择符（︀-️）也去掉，那也是能插进名字中间的隐形字符。
//   变体选择符也一样：只删 U+FE00–FE0F 会漏掉补充区 U+E0100–E01EF
//   （Codex 三审拿 名字中间插 U+E0100 绕过去了）。用 \p{Variation_Selector} 整类。
const INVISIBLE = /[\p{Cf}\p{Variation_Selector}​-‍]/gu;
function sayNormalize(s) {
    return String(s || '').normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
}
const SAY_FORBIDDEN_N = SAY_FORBIDDEN.map(sayNormalize);

function sayCheck(text) {
    const t = String(text || '').trim();
    if (!t) return '评论是空的';
    if (t.length > SAY_MAX_LEN) return `${t.length} 个字，超过 ${SAY_MAX_LEN} —— 普通网友不写小作文`;
    // 长度按原文算（她看到的是原文），禁词和链接按规范化后的文本算
    const n = sayNormalize(t);
    for (let i = 0; i < SAY_FORBIDDEN_N.length; i++) {
        if (n.includes(SAY_FORBIDDEN_N[i])) {
            return `里面有「${SAY_FORBIDDEN[i]}」，这是自己人的称呼，不往外说`;
        }
    }
    for (const re of SAY_LINKISH) if (re.test(n)) return '里面有链接或联系方式，评论里一律不带';
    return '';
}

// ── 记账 ──────────────────────────────────────────
// 选的是「直接发，事后能在散步看板里看到」。所以每一条都必须落盘，
// 而且要落**发出去的原文**，不是「发过一条」。看板读的就是这个文件。
// 发一条最多一两分钟。超过这个还挂着 sending，那是**进程崩在半路上**了。
const SENDING_STALE_MS = 5 * 60 * 1000;

// ⚠️ 崩在 sending 上的记录不能永远显示「正在发…」（Codex 二审逮到的）——
//   第二天打开看板还写着正在发，那是在骗人。读出来就归一化成 unknown：
//   那条评论到底发没发出去，确实没人知道，而 unknown 照样占额度。
//   抽成纯函数是为了**能被真测**：写成 loadSays 里的一个 if，测试就只能去
//   验源码里有没有那几个字符串 —— 那种断言我今天已经被故障注入打脸一次了。
function healStaleSending(s, now) {
    const t = now === undefined ? Date.now() : now;
    for (const x of (s && s.says) || []) {
        if (x.state === 'sending' && t - Date.parse(x.at || 0) > SENDING_STALE_MS) {
            x.state = 'unknown';
            x.error = x.error || '发送过程中进程没了 —— 发没发出去不确定';
        }
    }
    return s;
}

function loadSays() {
    let s;
    try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { says: [] }; }
    return healStaleSending(s);
}
function saveSays(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);      // 同记忆桥：原子替换，看板不会读到半个 JSON
}
const today = () => new Date().toLocaleDateString('sv-SE');   // sv-SE 就是 YYYY-MM-DD，还是本地时区

// 哪些记录**占今天的额度**：一切「可能真的发出去了」的。
// rejected（平台明确拒绝）和 notsent（点都没点成）不占 —— 那些确实没发出去。
// unknown 占，而且必须占：判不出来的时候按发出去算，宁可今天少说一句。
const SAY_COUNTS = new Set(['sending', 'pending', 'submitted', 'unknown']);
// ⚠️ waived = 这一笔**确实发出去了，但不算今天的额度**。
//   2026-08-24 加的：昨晚调试把当天 3 条全烧了，其中两笔还是同一句话发了两遍
//   （代码谎报「没发出去」，我信了、手动又点一次）—— 用户想留的那句反而发不出去。
//   当时的处理是「今天重置」。
//
//   ⚠️⚠️ 但重置**不许靠改 state 蒙混**：那三笔是真发出去的，把 submitted 改成 notsent
//   等于在账本上撒谎，而这个账本存在的全部意义就是不撒谎。
//   所以另开一个字段：记录原样留着，额外记「为什么不算」，看板照实显示两者。
//
//   ⚠️⚠️⚠️ 这是护栏上的一道口子，所以它**只能人手开**：
//   没有任何 HTTP 端点会写 waived（tests/social.test.js 有一条断言钉着这件事）。
//   要豁免走 scripts/say-waive.js，跟锁文件只能手动删是同一个道理 ——
//   能被请求打开的护栏不算护栏。
function saysToday(s) {
    return (s.says || []).filter(x => x.date === today() && !x.waived && SAY_COUNTS.has(x.state || 'submitted'));
}

// ── 跨进程的锁 ──────────────────────────────────────────
// ⚠️ 进程内那个 _sayBusy 布尔量**挡不住两个进程**（Codex 2026-08-23 逮到的）。
//   而这台机器上同时跑两个 server 一点都不罕见 —— exe 内嵌一个，开发时再 node server.js
//   一个，我今天就同时开着 3000 和 3099。两边同时读到「今天用了 2 条」，
//   就都会发出第 3 条：外面多一条**撤不回来**的评论，账本还因为读改写互相覆盖而少记一笔。
//
//   没上 SQLite —— 这里要保护的是一个几 KB 的 JSON 和一个每天最多几次的操作，
//   为它拖进一个数据库不划算。排他创建文件（O_EXCL）本身就是原子的，够用。
const LOCK_FILE = STATE_FILE + '.lock';
const LOCK_STALE_MS = 120000;   // 发一条最多几十秒；超过两分钟的锁一定是崩溃留下的

const LOCK_BEAT_MS = 20000;     // 活着的持锁者每 20 秒按一次，证明自己没死
const readLockRawOf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readLockOf = (f) => { try { return JSON.parse(readLockRawOf(f)); } catch { return null; } };
const readLockRaw = () => readLockRawOf(LOCK_FILE);
const readLock = () => readLockOf(LOCK_FILE);

// 锁卡住时给一句**能照着做**的话。fail-closed 的代价是要人动手，
// 那就不能让人对着一个「上一条还在发」干瞪眼。
function lockStuckError(lockFile, what) {
    const f = lockFile || LOCK_FILE;
    const w = what || '发不出去';
    let age = 0, who = '不知道是谁';
    try { age = Math.round((Date.now() - fs.statSync(f).mtimeMs) / 1000); } catch { }
    try { const c = readLockOf(f); if (c && c.pid) who = `pid ${c.pid}`; } catch { }
    if (age > LOCK_STALE_MS / 1000) {
        return new Error(
            `${w}：锁卡住了（持有者 ${who}，已经 ${age} 秒没动静）。多半是上次发评论时进程崩在半路。\n` +
            `确认现在没有别的 GranCyan 在发评论，然后手动删掉这个文件：${f}\n` +
            `（我不自动删 —— 自动删有个时序会让两个进程同时发评论，而评论发出去撤不回来。）`);
    }
    return new Error('上一条还在发，等它发完再说');
}

// ⚠️ 参数化成「哪个文件的锁」，是为了让草稿本子能有**自己的一把**。
//   共用 say 那把会让起草（要等模型几秒）把发送挡在门外 —— 而发送是她点了在等的，
//   起草是后台的活儿，让后台挡住前台是错的。两把锁保护两份不同的文件，互不相干。
async function withFileLock(lockFile, fn, what) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    // ⚠️⚠️ **不自动清理陈旧锁**（Codex 四审的裁决，我同意）。
    //   之前试过两版自动抢占，两版都被逮到同一类洞：`读 → 比较 → unlink` 不是原子的。
    //   第二版把窗口从「解析不出来就删」缩短到「原始字节没变才删」，但窗口还在：
    //   A 比完之后、unlink 之前，B 完全可能已经删掉旧锁并建好自己的新锁，
    //   于是 A 删掉的是 B 的锁，两个人一起进发送区。
    //   文件系统上没有「条件删除」这种原子操作，这条路补不干净。
    //
    //   所以选 fail-closed：**宁可发不出去，也不能两个人同时发。**
    //   这把锁后面是别人评论区里一条撤不回来的话，方向上没得商量。
    //   代价是进程崩过之后要人工删一次锁文件 —— 而且我把话说清楚了（见 lockStuckError）。
    //   顺带：不抢占之后，释放路径那个同款竞态也自动消失了 ——
    //   不存在「两把锁并存」的局面，A 就不可能删到 B 的锁。
    const owner = crypto.randomUUID();
    const deadline = Date.now() + 5000;
    for (;;) {
        try {
            const fd = fs.openSync(lockFile, 'wx');       // wx = 存在就失败，原子的
            try { fs.writeSync(fd, JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() })); }
            finally { fs.closeSync(fd); }
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if (Date.now() > deadline) throw lockStuckError(lockFile, what);
            await sleep(250);
        }
    }
    // 心跳：不是为了让别人来抢（没人会抢了），是为了让「这把锁多久没动静」
    // 这个数字有意义 —— 卡壳的活进程会一直按，死掉的不会。诊断时区分得开。
    const beat = setInterval(() => {
        try { const n = new Date(); fs.utimesSync(lockFile, n, n); } catch { }
    }, LOCK_BEAT_MS);
    if (beat.unref) beat.unref();
    try { return await fn(); }
    finally {
        clearInterval(beat);
        // owner 校验留着当深度防御：正常情况下不可能出现别人的锁，
        // 但万一有人手工删了又建，也不该把他的删掉。
        try { const cur = readLockOf(lockFile); if (cur && cur.owner === owner) fs.unlinkSync(lockFile); } catch { }
    }
}

// 发送那把锁。行为和参数化之前一模一样 —— 现有那一整组锁的测试钉着它。
const withSayLock = (fn) => withFileLock(LOCK_FILE, fn, '发不出去');

// ── CDP：够用就好的最小客户端 ──────────────────────────────────────────
// 不引 puppeteer。要的只有「开个标签、跑段 JS、读回结果」，
// 为这点事拖进一整个浏览器自动化框架（还会自己下载一份 Chromium）不值当。
const cdpHttp = (url, method) => axios({
    url: `http://127.0.0.1:${PORT}${url}`, method: method || 'get',
    timeout: 8000, proxy: false,                     // 本机直连，套代理会把 127.0.0.1 也代理掉
});

async function chromeAlive() {
    try { await cdpHttp('/json/version'); return true; } catch { return false; }
}

let _starting = null;
function ensureChrome() {
    if (_starting) return _starting;                  // 并发请求只拉一次（同檐廊引擎）
    _starting = (async () => {
        // ⚠️ **一进来就记账，在探活之前**（反馈「小红书明明打开了」查出来的）。
        // 原来这条路一次都不打点，于是 kickXhsChromeUp 拉起来的窗口活不过一轮空闲清扫：
        // sweepIdleChrome 每 60 秒扫一次，判据是 now - _chromeLastUse >= 15 分钟 ——
        // 而「浏览器没在跑」这件事本身就意味着上次用它至少是 15 分钟前，条件天然成立。
        // 结果是窗口真的弹出来了、小红书也加载了（她看得见，所以报的是「明明打开了」），
        // 最多 60 秒就被扫走，下一次 [[GAZE: xhs]] 照旧报「专用浏览器没在跑」，死循环。
        // 而且 kick 那边有 60 秒冷却，这段时间里连拉都不会再拉一次，症状更黏。
        //
        // 打在**最前面**而不是等 ok 再打，是为了把下面那 20 秒的等待窗口一起盖住：
        // 等成功再打的话，清扫器可以在 chromeAlive 刚变 true、这个循环还没退出的时候
        // 把它关掉 —— 那一格比原 bug 更难查，因为它只在冷启动慢的时候才犯。
        //
        // 语义上这也是对的：**要求浏览器活着 = 一次使用**。清扫器守的是「没人要它」，
        // 不是「没人正在读页面」；拉起来是给下一次 GAZE 用的，那也是要。
        touchChrome();
        if (await chromeAlive()) return { ok: true, already: true };
        const bin = chromeBin();
        if (!bin) return { ok: false, error: '没找到 Chrome —— 装在别处的话设环境变量 GRANCYAN_CHROME_BIN' };
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
        try {
            spawn(bin, [
                `--remote-debugging-port=${PORT}`,
                `--user-data-dir=${PROFILE_DIR}`,
                '--no-first-run', '--no-default-browser-check',
                '--disable-background-networking',
                'https://www.xiaohongshu.com/explore',   // 落地页就是要登录的地方，省得她自己找
            ], { detached: true, stdio: 'ignore' }).unref();   // server 关了浏览器还活着
        } catch (e) {
            return { ok: false, error: 'Chrome 起不来：' + e.message };
        }
        for (let i = 0; i < 40; i++) {                // 冷启动 + 首次建 profile 会慢
            await new Promise(r => setTimeout(r, 500));
            // 再打一次：空闲要从**真正起来那一刻**算起，不是从开始拉算起
            // （同 withChromeBusy 出来时再打一次的道理）。冷启动吃掉的那 20 秒
            // 不该算进它的 15 分钟寿命里。
            if (await chromeAlive()) { touchChrome(); return { ok: true, started: true }; }
        }
        return { ok: false, error: `Chrome 拉起来了但 ${PORT} 端口一直没开（20 秒）` };
    })().finally(() => { _starting = null; });
    return _starting;
}

// ── 专用浏览器：空闲了要自己关 ────────────────────────────────────
//
// 反馈「exe 老是未响应」，查出来这个专用 Chrome 从前一晚一直挂着：
// 10 个进程、943 MB、累计 3394 秒 CPU（约等于常年占着 7% 的一个核），
// 页面停在小红书 feed 上无限刷。机器一共 15 G，当时只剩 2.5 G。
//
// ⚠️ 根因不是「退出时忘了关」—— 上面 spawn 那行的 detached + unref 是**故意**的
//   （「server 关了浏览器还活着」，为的是跨重启复用，chromeAlive() 会认出来接着用）。
//   真正的洞是：**任何时候都不会关**。点一次「去回一条」就多一棵，一直到重启机器。
//   所以修法不是「退出时杀掉」（那会把复用弄没），是「闲够了自己走」。
const CHROME_IDLE_MS = intEnv('GRANCYAN_CHROME_IDLE_MIN', 15, 1, 24 * 60) * 60 * 1000;
const CHROME_GRACE_MS = intEnv('GRANCYAN_CHROME_LOGIN_GRACE_MIN', 30, 1, 24 * 60) * 60 * 1000;
const CHROME_SWEEP_MS = 60 * 1000;

let _chromeLastUse = Date.now();
let _chromeInFlight = 0;
let _chromeGraceUntil = 0;

// ⚠️ 三个条件**各自**都是必要的，别塌成一句笼统的「空闲就关」：
//   ① inFlight —— 有会话正在飞的时候关，等于把她那次「去回一条」拦腰砍断；
//   ② grace    —— `/open` 是**给用户扫码登录用的**，那段时间服务端一个请求都没有。
//                  按「没请求＝空闲」判的话，会在她扫码扫到一半把窗口关掉。
//                  这条不是想出来的边界，是这个端点自己的注释写着的用途。
//   ③ idle     —— 真正的判据。
// 抽成纯函数，是为了这三条能被故障注入**各自**拆掉。复合条件整条拆只能证明
// 「至少有一道闸」，证不出每一道都必要 —— 这个教训是 gen 租约那次现学的。
function shouldCloseIdleChrome(s) {
    if ((s.inFlight | 0) > 0) return false;
    if (s.now < s.graceUntil) return false;
    return s.now - s.lastUse >= s.idleMs;
}

// 关浏览器走 CDP 的 Browser.close，不按 PID 杀。
// 理由：要关的那一棵**常常不是这个进程拉起来的**（跨重启复用，今天逮到的那棵就比
// 当时的 exe 还老）。手上没有句柄，而按「命令行里含 profile 路径」去 taskkill，
// 是拿字符串匹配决定杀谁 —— 用户自己可能开着十几个 chrome，匹配错一次就是杀用户的窗口。
// Browser.close 只对「监听着我们这个调试端口的那一个浏览器」生效，认的是端口不是名字。
async function closeChrome() {
    const ver = (await cdpHttp('/json/version')).data;
    const ws = ver.webSocketDebuggerUrl;
    if (!ws) throw new Error('/json/version 没给 webSocketDebuggerUrl');
    const s = await openSession(ws);
    try { await s.send('Browser.close'); } finally { try { s.close(); } catch { } }
}

// 「刚用过」的打点。抽成具名函数不是为了省这一行赋值，是为了让故障注入能**单独**
// 拆掉某一处调用 —— 内联成 `_chromeLastUse = Date.now()` 的话，注入只能整片删，
// 证不出「ensureChrome 那一处」本身是必要的（这次的 bug 恰恰就是漏了那一处）。
function touchChrome() { _chromeLastUse = Date.now(); }

// 「这段时间算在用浏览器」的记账。**单独抽出来是为了能测接线**：
// 判据（shouldCloseIdleChrome）守得再严，没人把 inFlight 加上去也是白搭 ——
// 故障注入把 `_chromeInFlight++` 删掉的时候，只测纯函数的断言一条都不会红。
async function withChromeBusy(fn) {
    _chromeInFlight++;
    _chromeLastUse = Date.now();
    try {
        return await fn();
    } finally {
        // ⚠️ 减必须在 finally：抛异常那条路上不减的话，计数只增不减，
        //   浏览器从此**永远**关不掉 —— 比不加这个功能还糟。
        _chromeInFlight = Math.max(0, _chromeInFlight - 1);
        // 出来的时候再打一次点：空闲从**用完**算起，不是从开始用算起。
        // 只在进来时打点的话，一次跑了 10 分钟的抓取一出来就被判成闲了 10 分钟。
        _chromeLastUse = Date.now();
    }
}

// 给测试看真实的模块内部状态（不是副本），否则测的是自己造的数。
function chromeIdleState() {
    return { inFlight: _chromeInFlight, lastUse: _chromeLastUse, graceUntil: _chromeGraceUntil };
}

async function sweepIdleChrome(now) {
    const t = now === undefined ? Date.now() : now;
    if (!shouldCloseIdleChrome({
        now: t, lastUse: _chromeLastUse, inFlight: _chromeInFlight,
        graceUntil: _chromeGraceUntil, idleMs: CHROME_IDLE_MS,
    })) return { closed: false };
    if (!await chromeAlive()) return { closed: false, why: '本来就没开' };
    try {
        await closeChrome();
        console.log(`[social] 专用浏览器闲了 ${Math.round((t - _chromeLastUse) / 60000)} 分钟，关掉了`);
        return { closed: true };
    } catch (e) {
        // 关不掉不算错，下一轮再试。**不许升级成按 PID 杀**（见 closeChrome 的注释）。
        console.warn('[social] 关专用浏览器失败：' + e.message);
        return { closed: false, why: e.message };
    }
}

// 清专用浏览器的浏览记录（聊天里的 AI 经用户同意后帮用户清）。
// 只清「浏览记录」那一类，**Cookie / 登录一个字不碰** —— 清完小红书还登录着。
//
// 为什么是「关浏览器 → 删文件」而不是在浏览器里点：
//   CDP 没有清历史的命令（只有清 Cookie / 缓存 / 某个 origin 的存储），
//   playwright MCP 的 browser_close 在 --cdp-endpoint 下只是断开连接（实测：标签一个不关，
//   历史更不会动）。去 chrome://settings 里点「清除浏览数据」又是一串 shadow DOM 点击，
//   改个版就静默点歪。History 是个 SQLite，Chrome 关着时删掉它，下次启动自己建个空的，最稳。
// ⚠️ 删不动的文件如实报回去，不装作清干净了（多半是关完又被谁拉起来了，文件被锁）。
const HISTORY_FILES = ['History', 'History-journal', 'Visited Links',
    'Top Sites', 'Top Sites-journal', 'Shortcuts', 'Shortcuts-journal'];
async function clearHistory(o = {}) {
    const dir = o.profileDir || PROFILE_DIR;
    // 有一条小红书的活正在飞（去回一条 / 值班员发送）：现在关等于把它拦腰砍断
    if (_chromeInFlight > 0) return { ok: false, error: '浏览器正忙着（有一条小红书的活在跑），等它跑完再清' };
    const wasOpen = await chromeAlive();
    if (wasOpen) {
        await closeChrome();
        for (let i = 0; i < 40 && await chromeAlive(); i++) await new Promise(r => setTimeout(r, 250));
    }
    const removed = [], failed = [];
    for (const name of HISTORY_FILES) {
        const p = path.join(dir, 'Default', name);
        if (!fs.existsSync(p)) continue;
        // 调试端口先断，进程后退：Windows 上文件锁要等进程真退了才放，所以重试几秒
        let err = null;
        for (let i = 0; i < 20; i++) {
            try { fs.rmSync(p, { force: true }); err = null; break; }
            catch (e) { err = e; await new Promise(r => setTimeout(r, 250)); }
        }
        (err ? failed : removed).push(name);
    }
    console.log(`[social] 清专用浏览器历史：删了 ${removed.join('、') || '无'}${failed.length ? '；删不动 ' + failed.join('、') : ''}`);
    return { ok: !failed.length, wasOpen, removed, failed };
}

// 一个页面的 CDP 会话。用完必须 close，否则 ws 一直挂着。
function openSession(wsUrl, onEvent) {
    if (typeof WebSocket !== 'function') {
        return Promise.reject(new Error('这个 Node 里没有全局 WebSocket（要 v21+）'));
    }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const waiting = new Map();
        let id = 0;
        const timer = setTimeout(() => reject(new Error('连 CDP 超时')), 10000);

        ws.onopen = () => {
            clearTimeout(timer);
            resolve({
                send(method, params) {
                    const mid = ++id;
                    return new Promise((res, rej) => {
                        // 每条命令自己带超时 —— 少了这个，页面一卡整个请求就永久挂着，
                        // 症状是「点了发评论没反应也没报错」，最难查的那种
                        const t = setTimeout(() => { waiting.delete(mid); rej(new Error(`${method} 超时`)); }, 30000);
                        waiting.set(mid, { res, rej, t });
                        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
                    });
                },
                close() { try { ws.close(); } catch {} },
            });
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连不上')); };
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            // 没有 id 的是**事件通知**（Network.responseReceived 之类）。
            // 判评论发没发出去全靠它们 —— 页面 DOM 会撒谎，网络层不会。
            if (m.id == null) { if (onEvent) { try { onEvent(m); } catch {} } return; }
            const w = waiting.get(m.id);
            if (!w) return;
            clearTimeout(w.t); waiting.delete(m.id);
            if (m.error) w.rej(new Error(m.error.message || 'CDP 错误'));
            else w.res(m.result);
        };
    });
}

// 开一个标签，把会话交给回调，回调跑完就把标签关掉。
// 页面自己的 JS 环境 = 带着登录 cookie、带着他们那套签名拦截器，
// 这正是我们要借的东西。
async function withTab(url, fn, opts) {
    const o = opts || {};
    // ⚠️ 记账要把 ensureChrome 也**包在里面**。只从「拿到 tab」开始算的话，
    //   「拉起浏览器」那 20 秒是裸的：清扫刚好在这中间跑，就会把正在冷启动的
    //   浏览器关掉，然后这次请求超时失败 —— 而且看着像 Chrome 起不来。
    return await withChromeBusy(async () => {
        const up = await ensureChrome();
        if (!up.ok) throw new Error(up.error);

        const tab = (await cdpHttp(`/json/new?${encodeURIComponent(url)}`, 'put')).data;
        let s;
        try {
            s = await openSession(tab.webSocketDebuggerUrl, o.onEvent);
            await s.send('Runtime.enable');
            await s.send('Network.enable');
            // 等页面把数据渲染出来。这两家都是 SPA，DOMContentLoaded 时正文还没有。
            await new Promise(r => setTimeout(r, o.wait || 4000));
            return await fn(s);
        } finally {
            if (s) s.close();
            // 标签一定要关，否则每读一次就留一个，几十个之后 Chrome 就爬不动了
            if (!o.keepTab) { try { await cdpHttp(`/json/close/${tab.id}`); } catch {} }
        }
    });
}

async function evalIn(s, js) {
    const r = await s.send('Runtime.evaluate', {
        expression: js, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面里报错了');
    }
    return r.result?.value;
}

function inPage(url, js, opts) { return withTab(url, s => evalIn(s, js), opts); }

// ── 读：小红书推荐流（借登录态）──────────────────────────────
// server.js 那条 axios 抓的是**游客推荐流**：一个 cookie 都不带，拿回来的是算法
// 给陌生人的东西。用户一眼就看得出来 ——「这推的不是我号吧」。
//
// 实测（同一时刻两边对比）：游客流和登录号的推荐流完全是两个世界，
// 而这件事**零报错**：抓取成功、数据结构也对，只是推的不是用户的号。
// 症状只有用户本人认得出来，代码这边一点征兆没有。
//
// ⚠️ 只探活，**不在这里阻塞着拉 Chrome**（冷启动要好几秒，刷推荐流是高频动作）。
//    但「没开」和「开着却读不出来」是两回事，回同一个 null 会让调用方只能一视同仁地
//    端游客流上桌 —— 而游客流正是这次要修的毛病。所以分开报：
//      { chromeDown: true } → 专用浏览器没在跑，调用方该说「暂时看不了你的号」并去拉它
//      null                 → 开着但这条路没走通，调用方可以退回游客流（标明是游客）
async function xhsExploreFeeds() {
    if (!await chromeAlive()) return { chromeDown: true };
    let r;
    try {
        r = await inPage('https://www.xiaohongshu.com/explore', `(function () {
          try {
            var st = window.__INITIAL_STATE__;
            if (!st) return null;
            // ⚠️ **先定身份，再看内容**（Codex 六审逮到的，这是同一个 bug 的上游）。
            // 原来这里第一件事就是取 feeds、空了直接 return null —— 于是「这个号没登录」
            // 这个**已经读到的事实**在页面内就被吞掉了，外层那道「false 无条件带出去」
            // 的守卫（见本函数末尾）永远接不到它，xhsFeed 只能当成读取故障回落游客流。
            // 五审我修的是外层，漏的是这里：推荐流还没加载完、或者 feed 字段改版，
            // 都会让一条明确的「没登录」变成「读不出来」。
            // 身份和内容是两件独立的事，**不许让后者决定前者**。
            // ⚠️ 登录判据**不能**用 a[href^="/user/profile/"] —— 实测这一页上有 34 个
            // 这样的链接，其中 33 个是推荐卡里的作者主页。它这次碰巧排到侧边栏那个是运气，
            // 未登录时第一个就是作者链接，会直接报「已登录」，然后游客流不再显示警告 ——
            // 正好把这次要修的 bug 原样复活一遍。（Codex 2026-08-23 逮到的。）
            // 改用数据层：__INITIAL_STATE__.user 里有 loggedIn 和 userInfo，不看 DOM 顺序。
            var uu = st.user || {};
            var pick = function (v) { return v && typeof v === 'object' && '_value' in v ? v._value : v; };
            var ui = pick(uu.userInfo) || {};
            var who = ui.nickname || '';
            // 两个条件都要：loggedIn 是标志位，userInfo 有人名才说明真的取到了身份。
            // 判不出来就回 null（不是 false）—— 宁可让调用方说「不确定」，
            // 也不能报一个假的「已登录」（同 loginStatus 那段的原则）。
            // ⚠️ 三态别压扁成两态（Codex 三审逮到的）：
            //   标志不是 boolean          → null（读不到，判不出来）
            //   标志是 false              → false（确认没登录）
            //   标志是 true 且拿到人名     → true（确认是她的号）
            //   标志是 true 但人名读不到   → null，**不是 false**
            // 最后那一格最容易写错：登录标志明明是真的，只是 userInfo 还没填/改了版，
            // 报成 false 的话 UI 会说「专用浏览器没开或没登录」—— 一句她照着查也查不出
            // 毛病的假话，比「判不出来」难缠得多。
            var flag = pick(uu.loggedIn);
            var lg;
            if (typeof flag !== 'boolean') lg = null;
            else if (flag === false) lg = false;
            else lg = who ? true : null;
            // ── 身份定完了，才轮到内容 ──────────────────────────
            var fd = st.feed && st.feed.feeds;
            if (fd && !Array.isArray(fd)) fd = fd._value;      // Vue ref 形态的兜底，同 xhsPickFeeds
            if (!Array.isArray(fd)) fd = [];
            // 一条内容都没解析出来时，**只有在身份也没读到的情况下**才算「这条路没走通」。
            // 「确认没登录」本身就是一个完整的答案，要带出去让调用方拿去拒绝 ——
            // 这正是 Codex 六审那条：内容为空不该把身份的事实一起抹掉。
            if (!fd.length && lg !== false) return null;
            return {
              loggedIn: lg,
              who: who,
              // 稳定 id 比昵称可靠：昵称能改、能重名（Codex 五审）。
              // 「是不是用户的号」由调用方拿它跟 GRANCYAN_XHS_ME 比，这里只负责如实取。
              // ⚠️ **只取 userId 这一个来源，不拿 redId 兜底**（Codex 七审逮到的）：
              //   redId 是「小红书号」（自定义的那串），是可以改的展示 id，不是稳定主键。
              //   拿它兜底的话，页面改版一旦只给 redId 不给 userId，uid 就被填成一个
              //   跟配置里那串 24 位 userId 明确不符的值 → meMatch=false → **她自己的号
              //   被硬拒成「别人的号」**。而正确行为是「读不到稳定 uid 就报 null（判不出）」。
              //   读不到就该是空字符串，让上面那条三态逻辑去处理，不许拿次好的字段冒充。
              uid: ui.userId || ui.user_id || '',
              redId: ui.redId || '',            // 只用于显示/排查，**不参与身份判定**
              items: fd.map(function (x) {
                var n = (x && x.noteCard) || {};
                return {
                  id: x.id || '',
                  xsecToken: x.xsecToken || '',
                  title: n.displayTitle || '',
                  author: (n.user && n.user.nickname) || '',
                  likes: (n.interactInfo && n.interactInfo.likedCount) || '',
                };
              }).filter(function (v) { return v.id; }),
            };
          } catch (e) { return null; }
        })()`, { wait: 6000 });
    } catch { return null; }        // 浏览器这条路坏了不该让整个 [[GAZE: xhs]] 失败
    if (!r) return null;
    // ⚠️ **身份的事实不能跟着内容一起丢**（Codex 五审逮到的）。
    // 原来这里是 `!r.items.length → return null`：小红书改一次推荐卡的 id 字段，
    // filter 之后 items 就空了，于是「这个号确认没登录」这个**读到了的事实**
    // 被压成 null，调用方看不到 false，转头回落游客流 —— 内容解析失败居然能
    // 把一条明确的拒绝理由抹掉。false 要无条件带出去。
    if (r.loggedIn === false) return { loggedIn: false, who: r.who || '', uid: r.uid || '', items: [] };
    if (!Array.isArray(r.items) || !r.items.length) return null;
    return r;
}

// ── 读：登录状态 ──────────────────────────────────────────
// ⚠️ 两家的可靠程度**完全不同**，别用同一套判据糊过去：
//
//   B 站  —— api.bilibili.com/x/web-interface/nav 不要签名，直接回 isLogin。权威。
//
//   小红书 —— **没有可靠的免签判据**。实测排除了两条看着都能用的：
//     · 页面里找「扫码登录 / 立即登录」字样 → 未登录首页上根本没这几个字，
//       全新 profile 上它报「已登录」；
//     · cookie 里有没有 web_session → **游客也有**（全新 profile 上就是 38 个字符）；
//     · /api/sns/web/v2/user/me → 也要 x-s 签名，回的是 "create invalid signature"。
//
//   所以这里**不猜**，如实回 known:false。宁可显示「不知道」，也不能显示一个假的
//   「已登录」—— 那会让发评论在毫无预兆的情况下失败，而看板上还写着一切正常。
//   （等真登录过一次，拿两边的 cookie 一对比就能把判据做准，那时候再补。）
async function loginStatus() {
    const out = { chrome: await chromeAlive(), xhs: null, bili: null };
    if (!out.chrome) return out;
    // B 站：nav 接口不要签名，直接回 isLogin 和用户名。权威。
    try {
        const nav = await inPage('https://www.bilibili.com/',
            `fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'})
                .then(r=>r.json()).then(j=>({isLogin:!!(j.data&&j.data.isLogin), uname:(j.data&&j.data.uname)||''}))
                .catch(e=>({error:String(e&&e.message||e)}))`, { wait: 3000 });
        out.bili = (nav && nav.error)
            ? { known: false, error: nav.error }
            : { known: true, loggedIn: !!(nav && nav.isLogin), who: (nav && nav.uname) || '' };
    } catch (e) { out.bili = { known: false, error: e.message }; }

    // 小红书：登录后侧边栏才会出现指向自己主页的链接。
    // 这条是 2026-08-23 拿登录前后两个样本对出来的。之前试过、**全是假阳性**的三条：
    //   · 页面里找「扫码登录」字样 —— 未登录首页上根本没这几个字；
    //   · cookie 里有 web_session —— 游客也有，长度一样是 38 个字符；
    //   · /api/sns/web/v2/user/me —— 也要 x-s 签名，回 "create invalid signature"。
    try {
        const xhs = await inPage('https://www.xiaohongshu.com/explore', `(function(){
            var t=document.body?document.body.innerText:'';
            return { me: !!document.querySelector('a[href*="/user/profile/"]'),
                     loginWord: /扫码登录|立即登录|登录后查看/.test(t) };
        })()`, { wait: 4000 });
        out.xhs = { known: true, loggedIn: !!(xhs && xhs.me && !xhs.loginWord) };
    } catch (e) { out.xhs = { known: false, error: e.message }; }

    return out;
}

// ── 小红书：读评论区 / 说话 ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xhsNoteUrl = (id, tok) =>
    `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(tok)}&xsec_source=pc_feed`;

// ⚠️ 笔记页**必须带 xsec_token**，否则一律 error_code=300031「当前笔记暂时无法浏览」，
// 而且是跳到一个 339 字节的重定向页 —— 看着像笔记被删了，其实只是少了个参数。
// token 从 [[GAZE: xhs]] 刷推荐流时缓存下来（server.js 里的 _xhsTokens）。
function needToken(id, token) {
    // notSent：连页面都还没打开，绝无可能提交出去 —— 这种必须退还额度。
    // （Codex 二审逮到的：原来抛的是普通 Error，会被当成 unknown 永久占掉一条额度。）
    if (!token) throw notSent(`手上没有 ${id} 的 xsec_token —— 先 [[GAZE: xhs]] 刷一下推荐流`);
    return token;
}

async function xhsComments(id, token) {
    return withTab(xhsNoteUrl(id, needToken(id, token)), async (s) => {
        const data = await evalIn(s, `(function(){
            var out=[];
            document.querySelectorAll('.comment-item').forEach(function(e){
                var au=e.querySelector('.name');
                var tx=e.querySelector('.note-text, .content');
                if(tx) out.push({ who:(au&&au.innerText||'').trim(), text:(tx.innerText||'').trim().slice(0,300) });
            });
            var d=document.querySelector('#detail-desc, .note-content .desc');
            return { comments: out.slice(0,40), total: out.length, desc: d?d.innerText.slice(0,800):'' };
        })()`);
        if (!data || data.total === 0) {
            // 评论是 0 条和「页面没打开」长得一样，得分清楚 —— 后者是故障，前者不是
            const ok = await evalIn(s, `!!document.querySelector('#content-textarea, .comment-item, #detail-desc')`);
            if (!ok) throw new Error('笔记页没打开（多半 token 过期了，重刷一次推荐流）');
        }
        return data;
    }, { wait: 6500 });
}

// 「确定一个字都没发出去」的失败。只有这种才退还今天的额度 ——
// 其余一律按「可能已经发出去了」处理，宁可少发一条也不重复发。
function notSent(msg) { const e = new Error(msg); e.notSent = true; return e; }

// 点了发送之后，到底算发出去了没有。
//
// ⚠️ 这是整件事里**最容易判错、判错了代价最大**的一步，我今天已经在它上面栽了三次，
//   Codex 又连着两轮在这里逮到洞。所以抽成纯函数：它不碰浏览器、不碰文件，
//   可以拿各种组合直接跑（源码正则守不住这种语义）。
//
// 规则，按「错的方向哪个更贵」定：
//   · 任何一个明确 success:true  → 发出去了。哪怕另一个失败了，那多半是重试。
//   · 每一个请求都拿到了可解析的响应，而且全是 success:false → 确定没发出去，可以退额度。
//   · 其余一切（有请求读不到响应、响应解析不了、成败混着）→ unknown，占着额度。
//     少发一条的代价是「今天少说一句」；重复发的代价是别人评论区里多一条撤不回的话。
function decideSayOutcome(postCount, seen) {
    if (!postCount) return { kind: 'unknown', why: '点了发送，但没看到 comment/post 请求 —— 发没发出去不确定' };
    const ok = seen.find(x => x && x.success === true);
    if (ok) return { kind: 'sent', j: ok };
    const decided = seen.filter(x => x && typeof x.success === 'boolean');
    // 每个请求都有结论，且全是失败 —— 只有这一种情况敢退额度
    if (decided.length === postCount && decided.every(x => x.success === false)) {
        return { kind: 'rejected', j: decided[decided.length - 1] };
    }
    return {
        kind: 'unknown',
        why: `发了 ${postCount} 个请求，只读到 ${decided.length} 个明确结果 —— 发没发成不确定，去评论区自己看一眼`,
    };
}

// 发一条评论。**每一步都验证**，绝不「点了就当发了」。
async function xhsSay(id, token, text) {
    // ⚠️⚠️ 判据只认这一个接口的响应。2026-08-23 在这上面连栽两次：
    //   第一次：查整个 document.body.innerText 里有没有这句话 —— 假阳性，
    //           因为没发出去的那句还留在**输入框**里，而输入框也在 body 里。
    //   第二次：改成只查 .comment-item —— 还是假阳性，因为页面做了**乐观更新**，
    //           前端先把评论插进列表，服务端拒了也不撤，刷新才消失。
    // 页面 DOM 在这件事上会撒谎，两种撒法。网络层不会。
    //   第三次（Codex 逮到的，还没等它咬人）：只等 responseReceived 就去读 body。
    //           那个事件只说「响应头到了」，body 可能还在路上，getResponseBody 会失败——
    //           而失败在旧代码里被报成「读不到回应」，评论其实早发出去了。
    //           要等的是 loadingFinished。
    const posts = [];
    const find1 = (rid) => posts.find(x => x.requestId === rid);
    const onEvent = (m) => {
        const p = m.params || {};
        // ⚠️ **从「请求发出」就建档，不是从「响应回来」**（Codex 八审逮到的）。
        //   responseReceived 证明的是收到了回应；请求已经离开机器、但连接断了/超时/
        //   只回 loadingFailed 的时候，它一次都不会来 —— 而评论**可能已经提交了**。
        //   拿「没看见响应」当「没发出去」，就是我 2026-08-24 栽的那一跤的机器版。
        if (m.method === 'Network.requestWillBeSent') {
            const u = (p.request && p.request.url) || '';
            if (u.includes('/comment/post') && !find1(p.requestId)) {
                posts.push({ requestId: p.requestId, done: false, failed: false });
            }
        } else if (m.method === 'Network.responseReceived') {
            const u = (p.response && p.response.url) || '';
            if (u.includes('/comment/post') && !find1(p.requestId)) {
                posts.push({ requestId: p.requestId, done: false, failed: false });
            }
        } else if (m.method === 'Network.loadingFinished') {
            const it = find1(p.requestId); if (it) it.done = true;
        } else if (m.method === 'Network.loadingFailed') {
            const it = find1(p.requestId); if (it) it.failed = true;
        }
    };
    // ⚠️ **阶段闸**（Codex 九审逮到的）：点击**之前**的任何意外 —— 标签页被用户关掉、
    //   CDP 断开、Input.insertText 抛错、withTab 压根连不上浏览器 —— 都确定一个字没发出去，
    //   必须标 notSent 把今天的额度退回去。原来它们抛的是**不带标记**的普通 Error，
    //   调用方一律按 unknown 处理，等于白扣一条额度（方向是安全的，但是错的）。
    //   而 clicked 一旦置位就再也不许退款 —— evalIn(click) 抛错**不能证明页面没执行那一下**。
    let clicked = false;
    // ⚠️ **把 withTab 的契约钉死**（Codex 十审提的，我核过今天不成立，但它依赖的是一个没写下来的约定）。
    //   现在的 withTab 是 `return await fn(s)` —— 直着 await，没有 Promise.race、没有超时、
    //   没有重试，fn 只被调用一次。整个 notSent/unknown 的判定都压在这个事实上：
    //   withTab 抛错时 doSay 要么没开始、要么已经跑完，不会有一个「悬空的 doSay」
    //   在外层已经退了额度之后才把评论点出去。
    //   这个约定一旦被后人改掉（加个超时 race、加个重试），上面那套判定会**静默失效** ——
    //   而且失效的方向是最坏的那个：已经发出去了，还告诉调用方可以重发。
    //   ⚠️ 说清楚这道闸管到哪（Codex 十一审说我上一版写得太满）：它挡的是**重复调用**那一半。
    //      要是有人给 withTab 加一个**不取消**的超时 race —— 抛了超时、doSay 却还在后台跑 ——
    //      这里挡不住，那种情况只能由 withTab 自己保证取消。今天两种都不存在，我只钉住其中一半。
    //   所以这里自己拦一道：doSay 被调用第二次就直接 unknown，绝不点第二下。
    let attempts = 0;
    const doSay = async (s) => {
        if (++attempts > 1) {
            const e = new Error(`withTab 把 doSay 调了第 ${attempts} 次 —— 上一次可能已经点过发送了，不许再点（判不出发没发出去，不退额度）`);
            e.unknown = true;
            throw e;
        }
        const hasBox = await evalIn(s, `!!document.querySelector('#content-textarea')`);
        if (!hasBox) throw notSent('这条笔记上没有评论框（作者关了评论，或者登录掉了）');

        await evalIn(s, `(function(){var i=document.querySelector('#content-textarea');i.click();i.focus();return 1;})()`);
        await sleep(700);
        // 用 CDP 的 Input.insertText 而不是改 innerText：
        // 这个走的是浏览器真正的输入管线，页面上那套 Vue 才收得到事件。
        // 直接赋值 innerText 的话字是进去了，但框架不知道，发送按钮永远是灰的。
        await s.send('Input.insertText', { text });
        await sleep(1300);

        // ⚠️ **按钮比评论框渲染得晚**：`#content-textarea` 有了不等于 `.btn.submit` 也有了。
        // 2026-08-24 实测：一次真发被判成「找不到发送按钮（页面结构变了）」，
        // 而同一条笔记手工探测明明有 —— 差别只是我多等了几秒。
        // 当时我还据此误判成「小红书改版了，选择器废了」，其实选择器一直是对的。
        // 所以这里轮询等它出现，最多 6 秒；等不到才是真的没有。
        for (let i = 0; i < 20; i++) {
            if (await evalIn(s, `!!document.querySelector('.btn.submit')`)) break;
            await sleep(300);
        }

        // ⚠️ 发送前的闸：按钮上的 gray 掉了没有。
        // 这是唯一能在**点下去之前**判断「这次输入被页面接受了」的信号。
        // 少了这一步，输入没生效时会照样点、照样报成功，评论却根本没发出去 —— 静默失败。
        const st = await evalIn(s, `(function(){
            var i=document.querySelector('#content-textarea'), b=document.querySelector('.btn.submit');
            return { typed: i?i.innerText:'', disabled: b?(b.className||'').indexOf('gray')>=0:true, hasBtn:!!b };
        })()`);
        // 到这里为止都还**没点**，所以这三种失败可以确定一个字都没发出去。
        // notSent 这个标记后面要用来决定「退不退还今天的额度」—— 只有确定没发出去的才退。
        if (!st.hasBtn) throw notSent('找不到发送按钮（页面结构变了）');
        if (String(st.typed).trim() !== text.trim()) throw notSent(`字没打进去（框里是「${st.typed}」）`);
        if (st.disabled) throw notSent('发送按钮还是灰的 —— 页面没接受这次输入，点了也是白点');

        posts.length = 0;
        // ⚠️⚠️ **点这一下是不可逆的，所以只点一次，任何情况下都不补第二下。**
        //
        // 2026-08-24 我在这里差点犯一个很蠢的错：那天连着两次报「点了发送但没发出请求」，
        // 我先判成「小红书改版、选择器废了」（错，选择器一直是对的），
        // 再判成「合成 click 走不通框架」（也错），于是加了一段
        // 「250ms×6 内没看到请求就补一次真实鼠标点击」的兜底。
        //
        // 两个问题：
        //   1. 真实原因根本不是点击方式 —— 是**用户同时在同一个 Chrome 里抢鼠标切标签页**，
        //      视口坐标当场作废。我为一个不存在的 bug 加了兜底。
        //   2. 那个兜底本身是**真 bug**（Codex 七审逮到的）：判据看的是 posts，而 posts 是
        //      Network.responseReceived 填的 —— 那是**响应**到没到，不是**请求**发没发出去。
        //      小红书响应慢过 1.5 秒，第一次点击其实已经把评论发出去了，兜底却看见 posts 空、
        //      再点一次 → 同一条评论发两遍，撤不回来，而账本还只记一条。
        //
        // 「没看见反馈」和「没发生」是两回事。对不可逆的动作，前者永远不能当后者处理。
        // 点不动的真实原因该去查（并发抢浏览器、按钮 disabled、页面没加载完），不是再点一次。
        // ↓ 置位必须在 await **之前**。await 抛错只说明「我没拿到回执」，
        //   页面那一下可能已经点下去了 —— 这正是「没看见反馈 ≠ 没发生」。
        clicked = true;
        await evalIn(s, `document.querySelector('.btn.submit').click()`);

        // 等到有一个请求**下载完**（或者全都失败了）。最多 15 秒。
        // 只等 responseReceived 是不够的：那时候 body 还没到，读了会报错。
        const settled = () => posts.length && posts.every(x => x.done || x.failed);
        for (let i = 0; i < 50 && !settled(); i++) await sleep(300);
        // ⚠️⚠️ **点下去之后就再也不许说「确定没发出去」了**（Codex 八审）。
        //   notSent 的语义是「一个字都没出去，额度退还」—— 而点击是不可逆的：
        //   请求可能已经离机，只是响应丢了/连接断了/事件没来。这时候报 notSent，
        //   等于告诉调用方「可以重发」，下一次就是同一条评论发两遍。
        //   2026-08-24 我本人就是被这句假话骗去手点了第二下的。
        //   所以这里一律 unknown：**占着额度**，宁可今天少说一条，也不重复说。
        if (!posts.length) {
            const e = new Error('点了发送，之后一个 comment/post 请求都没看见 —— 判不出发没发出去（点击不可逆，按已发出算，不退额度）');
            e.unknown = true;
            throw e;
        }

        // 可能有多个（重试、或者点了两下）。**逐个读，取最后一个有结论的** ——
        // 固定读 posts[0] 的话，第一次失败第二次成功时会报成失败。
        const seen = [];
        for (const p of posts) {
            if (!p.done) continue;
            let r;
            try { r = await s.send('Network.getResponseBody', { requestId: p.requestId }); }
            catch { continue; }
            const raw = r.base64Encoded ? Buffer.from(r.body || '', 'base64').toString('utf8') : r.body;
            try { seen.push(JSON.parse(raw)); } catch { seen.push({ __raw: String(raw).slice(0, 150) }); }
        }
        const verdict = decideSayOutcome(posts.length, seen);
        if (verdict.kind === 'unknown') {
            // ⚠️ 读不到结果 ≠ 没发出去。这正是我今天栽的那三次的镜像：
            // 判不出来的时候必须说判不出来，不能往任何一边猜。
            const e = new Error(verdict.why);
            e.unknown = true;
            throw e;
        }
        if (verdict.kind === 'rejected') {
            throw notSent(`小红书拒绝了：${verdict.j.msg || JSON.stringify(verdict.j).slice(0, 200)}`);
        }
        const j = verdict.j;

        const c = (j.data && j.data.comment) || {};
        // ⚠️ status 2 = 在审核。这种评论**连自己都看不见**（实测过），绝不能报成「已发表」。
        // ⚠️ 而 status **缺失**的时候也不许当成「公开」（原来写的是 `c.status !== 2`，
        //    平台改版把这个字段拿掉就会 fail-open，直接显示成公开可见）。判不出来就说判不出来。
        // ⚠️ 而且这三档都只是**提交那一刻**的状态：pending 的二十分钟后会通过，
        //    这里不会自己更新。看板上必须写清是「提交时」。
        const state = c.status === 2 ? 'pending'
                    : (typeof c.status === 'number' ? 'submitted' : 'unknown');
        return { commentId: c.id || '', status: c.status, state, ipLocation: c.ip_location || '' };
    // ⚠️⚠️ **onEvent 必须传进去**（2026-08-24 实测逮到的活 bug）。
    //   上面那个 onEvent 定义了、posts 也备好了，但 withTab 只收到 { wait: 6500 } ——
    //   监听器一次都没挂上，于是 posts 永远是空的，每一条真发出去的评论都被报成
    //   「点了发送，但压根没发出 comment/post 请求」。
    //   后果比看着严重得多：这是**确定性的假话**（notSent），额度不扣、账本记 notsent，
    //   而评论**真的在外面**。我自己就照着这句假话又手点了一遍，同一条评论发了两遍，
    //   用户手动去删的重复。
    //   decideSayOutcome 被单测验到烂熟，可**没有一条断言验过它的输入是从哪来的**。
    //   ——「验了零件，没验用它的那条路」，第八次。
    };
    try {
        return await withTab(xhsNoteUrl(id, needToken(id, token)), doSay, { wait: 6500, onEvent });
    } catch (e) {
        // 已经带了标记的（页面上那三种确定失败、小红书明确拒绝）原样放行，别覆盖。
        if (!e.notSent && !e.unknown) { if (clicked) e.unknown = true; else e.notSent = true; }
        throw e;
    }
}

// 谁会发。**没有实现就是没有实现** —— 别让 SAY_ALLOWED_SITES 那个环境变量
// 放进来一个站名，就当它能发（那会发到别的站去，见 say 端点里的注释）。
const SAY_SENDERS = { xhs: xhsSay };

// ── 收件箱：有人回我了 ──────────────────────────────────────────
// 需求是「评论/回复/私信有动静的时候 AI 能知道」。
//
// **纯读**。不点开、不标已读、不回。标已读是写操作，而且不可逆 ——
// 一旦把「未读」擦掉，「这条是不是新的」这个判据本身就没了。
//
// ⚠️ 怎么拿到数据：**不自己造签名请求**。
//   小红书这些接口要 x-s/x-t 签名（同这个文件开头那段），伪造不了。
//   但通知页自己会打这些接口 —— 我们只是把浏览器收到的响应体读一遍。
//   实测 2026-08-24：DOM 里**一个字都没有**（整页 innerText 799 字，全是页脚备案号），
//   通知列表是懒渲染的；而网络层四个接口全在，数据完整。
//   所以这里走网络层，不走 DOM —— 跟 xhsSay 判「发没发出去」是同一个道理：
//   页面 DOM 会撒谎，网络层不会。
const INBOX_FILE = process.env.GRANCYAN_XHS_INBOX
    || path.join(os.homedir(), '.grancyan', 'xhs-inbox.json');
const INBOX_KEEP = 60;        // 事件流留多少条
const INBOX_SEEN_KEEP = 400;  // 记住多少条已见过的 mention id（防止翻篇后又当成新的）
// 等页面把那几个接口打完。实测 9 秒够（mentions 是第 24 个请求才回来的）。
// ⚠️ 走 intEnv 校验，理由同 SAY_MAX：写错的护栏不算护栏。等太短的症状是
//   「收件箱一直是空的」，零报错 —— 正是最难查的那种。
const INBOX_WAIT_MS = intEnv('GRANCYAN_XHS_INBOX_WAIT', 9000, 3000, 30000);
// 自己定时刷的间隔（分钟）。0 = 关，默认就是关的 —— 见挂端点那里的理由。
const INBOX_POLL_MIN = intEnv('GRANCYAN_XHS_POLL_MIN', 0, 0, 1440);

// 通知页会打的接口，按用途认。**认前缀不认全等** —— 它们带 query（?num=20&cursor=）。
const INBOX_WANT = {
    me:      /\/api\/sns\/web\/v2\/user\/me/,
    unread:  /\/api\/sns\/web\/unread_count/,
    mentions:/\/api\/sns\/web\/v1\/you\/mentions/,
    chats:   /\/api\/im\/web\/v3\/chats/,
    chatUnread: /\/api\/im\/web\/chat\/get_unread/,
};

// 把一堆响应体解析成结构。
// ⚠️ 同一个 URL 会打好几次（前端重试 / StrictMode），而且**先回来的那几个读不到 body**
//   （CDP 报 "No resource with given identifier found"，资源被回收了）。
//   所以调用方要把每个用途的所有候选都递进来，这里挑**最后一个能解析成功的**。
//   挑第一个的话拿到的是空壳，症状是「一条通知都没有」，而不是报错。
function inboxParse(bodies) {
    const pickJson = (arr) => {
        for (let i = (arr || []).length - 1; i >= 0; i--) {
            let j; try { j = JSON.parse(arr[i]); } catch { continue; }
            // code:0 / success:true 才算数。他们失败时也回 200，靠 body 里的字段分辨。
            if (j && (j.code === 0 || j.success === true) && j.data) return j.data;
        }
        return null;
    };
    const out = { me: null, unread: null, mentions: null, chats: null, missing: [] };

    const me = pickJson(bodies.me);
    // guest 是他们**显式给的布尔**，比猜页面上有没有某个链接靠谱得多。
    // （原来 loginStatus 里那条「侧边栏有没有指向自己主页的链接」是登录前后对样本对出来的，
    //  能用，但这个是人家自己说的。）
    if (me && me.user_id) {
        out.me = { userId: String(me.user_id), nickname: String(me.nickname || ''),
                   redId: String(me.red_id || ''), guest: me.guest === true };
    } else out.missing.push('me');

    const un = pickJson(bodies.unread);
    if (un) out.unread = { likes: un.likes | 0, connections: un.connections | 0, mentions: un.mentions | 0 };
    else out.missing.push('unread');

    const mn = pickJson(bodies.mentions);
    if (mn && Array.isArray(mn.message_list)) {
        out.mentions = mn.message_list.map(m => {
            const it = m.item_info || {}, ci = m.comment_info || {}, ui = m.user_info || {};
            const ill = it.illegal_info || {};
            return {
                // 这个 id 是**每条通知**的唯一号，去重就靠它
                id: String(m.id || ''),
                at: Number(m.time || 0) * 1000,      // 他们给的是秒
                kind: String(m.type || ''),          // comment/item、comment/comment …
                title: String(m.title || ''),        // 「评论了你的笔记」
                who: { userId: String(ui.userid || ''), nickname: String(ui.nickname || '') },
                text: String(ci.content || '').slice(0, 300),
                note: {
                    id: String(it.id || ''),
                    token: String(it.xsec_token || ''),
                    title: String(it.content || '').slice(0, 120),
                    // 笔记被删了他们照样把通知留着。不标出来的话，
                    // 「去回一条」会失败得莫名其妙。
                    deleted: ill.illegal_status === 'DELETE' || ill.status === 1,
                },
            };
        }).filter(x => x.id);
    } else out.missing.push('mentions');

    const ch = pickJson(bodies.chats);
    const cu = pickJson(bodies.chatUnread) || {};
    const counts = cu.user_chat_unread_counts || {};
    if (ch && Array.isArray(ch.chats)) {
        out.chats = ch.chats.map(c => {
            const i = c.info || {};
            const uid = String(c.chat_user_id || '');
            return {
                userId: uid,
                nickname: String(i.nickname || i.user_name || ''),
                lastText: String(c.last_msg_content || '').slice(0, 200),
                lastAt: Number(c.last_msg_time || 0),
                // 没给未读数就是 null，**不是 0**。0 是「确定没有未读」，
                // null 是「不知道」——两个在下面 inboxDiff 里走不同的路。
                unread: Object.prototype.hasOwnProperty.call(counts, uid) ? (counts[uid] | 0) : null,
            };
        }).filter(x => x.userId);
    } else out.missing.push('chats');

    return out;
}

// 算出「这一次比上一次多了什么」。
//
// ⚠️⚠️ 私信这边有个**读不出来的东西**，这里不许猜：
//   chats 接口只给 last_msg_content，**不说这句是谁讲的**。实测那条会话里
//   最后一句是我自己发出去的，数据长得和别人发来的一模一样。
//   要知道是谁讲的只能打开会话拉 history —— 而打开会话会把未读擦掉，那是写操作。
//   所以规则是：
//     unread > 0            → 确定有人找我（未读数就是证据）
//     unread == 0 且时间变新 → **拿不准**，标 unsure，界面上照实说「可能是我自己发的」
//     unread == null         → 连未读数都没读到，一样 unsure
//   宁可显示「拿不准」，也不能把我自己刚发出去的话说成「有人给你留言了」。
function inboxDiff(prev, cur, nowMs) {
    const now = nowMs === undefined ? Date.now() : nowMs;
    const p = prev || {};
    const seen = new Set(p.seen || []);
    const first = !p.lastPollAt;                 // 第一次轮询：存量不算「新」
    const prevChats = p.chats || {};
    const items = [];

    for (const m of cur.mentions || []) {
        if (seen.has(m.id)) continue;
        items.push({
            at: m.at || now, kind: 'mention', sub: m.kind, mid: m.id,
            title: m.title, who: m.who.nickname, whoId: m.who.userId,
            text: m.text, note: m.note,
            fresh: !first,
            // 自己评论自己的笔记也会进 mentions（测试时就是这样）。
            // 标出来，别让看板把我自己的话当成「有人回你了」。
            self: !!(cur.me && m.who.userId && m.who.userId === cur.me.userId),
        });
    }

    for (const c of cur.chats || []) {
        const was = prevChats[c.userId];
        const moved = !was || (c.lastAt || 0) > (was.lastAt || 0);
        const gained = !!was && c.unread != null && (was.unread != null) && c.unread > was.unread;
        if (!moved && !gained) continue;
        const certain = c.unread != null && c.unread > 0;
        items.push({
            at: c.lastAt || now, kind: 'chat', who: c.nickname, whoId: c.userId,
            text: c.lastText, unread: c.unread,
            certain,                       // true = 确定是对方发来的
            fresh: !first,
        });
    }

    items.sort((a, b) => (a.at || 0) - (b.at || 0));

    const chats = {};
    for (const c of cur.chats || []) chats[c.userId] = { nickname: c.nickname, lastAt: c.lastAt, unread: c.unread };

    const nextSeen = (p.seen || []).concat((cur.mentions || []).map(m => m.id).filter(x => !seen.has(x)));

    return {
        state: {
            v: 1, lastPollAt: now, lastPollError: '',
            me: cur.me || p.me || null,
            unread: cur.unread || null,
            missing: cur.missing || [],
            seen: nextSeen.slice(-INBOX_SEEN_KEEP),
            chats,
            items: (p.items || []).concat(items).slice(-INBOX_KEEP),
        },
        added: items,
        first,
    };
}

function loadInbox() {
    try { return JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')); } catch { return null; }
}
// 刷失败了要**留下痕迹**。不留的话看板上永远挂着上一次成功的时间，
// 看着像「一直在正常查」—— 跟把审核中说成已发出是同一类假话。
//
// ⚠️ 抽成函数不是为了好看，是为了**能单跑**：写在端点的 catch 里的话，
//   验它就只剩「源码里有没有 lastPollError 这几个字」，改坏了照样绿。
// ⚠️ 从没成功过（还没有状态文件）也要落一笔，否则第一次就失败的话，
//   看板显示的是「还没查过」，把一次失败说成没发生。
function inboxNoteFailure(msg, nowMs) {
    const now = nowMs === undefined ? Date.now() : nowMs;
    const s = loadInbox() || { v: 1, lastPollAt: 0, items: [], seen: [], chats: {} };
    s.lastPollError = String(msg || '没说原因');
    s.lastPollErrorAt = now;
    try { saveInbox(s); } catch { /* 盘写不了就算了，别让报错本身再炸一次 */ }
    return s;
}
function saveInbox(s) {
    fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true });
    const tmp = INBOX_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, INBOX_FILE);
}

// 真去刷一次。开一个通知页，把页面自己打的那几个接口的响应捞回来。
let _inboxBusy = false;
async function xhsInboxPoll() {
    if (_inboxBusy) throw new Error('上一次还在刷，等它刷完');
    _inboxBusy = true;
    try {
        const ids = {};                 // 用途 → [requestId…]，按到达顺序
        for (const k of Object.keys(INBOX_WANT)) ids[k] = [];
        const onEvent = (m) => {
            if (m.method !== 'Network.responseReceived') return;
            const u = (m.params.response && m.params.response.url) || '';
            for (const [k, re] of Object.entries(INBOX_WANT)) if (re.test(u)) ids[k].push(m.params.requestId);
        };
        const bodies = await withTab('https://www.xiaohongshu.com/notification', async (s) => {
            const out = {};
            for (const [k, list] of Object.entries(ids)) {
                out[k] = [];
                for (const rid of list) {
                    // 读不到就跳过 —— 前几个请求的 body 常常已经被回收了（见 inboxParse 上面）
                    try { const b = await s.send('Network.getResponseBody', { requestId: rid }); if (b && b.body) out[k].push(b.body); }
                    catch { /* No resource with given identifier found */ }
                }
            }
            return out;
        }, { wait: INBOX_WAIT_MS, onEvent });

        const cur = inboxParse(bodies);
        // 没登录的话 mentions 是空的，而空和「真没有新消息」长得一样 —— 必须分清楚
        if (cur.me && cur.me.guest) throw new Error('这个浏览器里的小红书是游客态（没登录），收件箱读不了');
        if (!cur.me) throw new Error('读不到「我是谁」—— 多半通知页没加载完或者没登录，这次不算数');

        const d = inboxDiff(loadInbox(), cur, Date.now());
        saveInbox(d.state);
        return { added: d.added.length, first: d.first, state: d.state };
    } finally { _inboxBusy = false; }
}

// ── 散步值班员：让小模型起草，用户点了才发 ──────────────────────────────
//
// 需求是「为了省 token，让 sonnet/haiku 负责回小红书」。
//
// ⚠️ 省的**不是那句评论**。评论 80 字封顶，输出便宜到可以忽略。贵的是原来那条路：
//   [[SAY:]] 由主对话模型顺手写出来，而主对话背着完整人格 + 高级记忆 + 整段聊天历史
//   + 收件箱那一坨。为了憋 20 个字，Opus 要把整个上下文吃一遍。
//   所以这里换的不只是模型名，是**把「读收件箱 → 想说什么」整个搬出主对话**。
//   只改模型名不改上下文的话，账单不会怎么降 —— 而且降没降没人看得见。
//
// ⚠️ 起草**不发送**。明确选的是「先起草，用户点了才发」。
//   理由是评论对外不可逆，而模型换小之后失手概率变高。
//   这道闸在代码里的形状是：**这一节里一次都不出现 SAY_SENDERS / xhsSay**。
//   要发只有一条路 —— 用户在看板上点，前端拿草稿去调那个原样没动的 /say 端点，
//   于是禁词、80 字、每天 8 条、跨进程锁全都照旧生效，一个字都没有为草稿放宽。
const DRAFT_FILE = process.env.GRANCYAN_XHS_DRAFTS
    || path.join(os.homedir(), '.grancyan', 'social-drafts.json');
// ⚠️ 可配是为了**能被真测**（2026-08-28 故障注入逮到）：原来 40 写死，于是「去重凭据
//   不跟着审计历史截断」这条只能断言 `DRAFT_SEEN_KEEP > DRAFT_KEEP` —— 那是在**验常量**，
//   把 `.slice(-DRAFT_SEEN_KEEP)` 改成 `.slice(-DRAFT_KEEP)` 注进去，断言照样全绿。
//   调小它就能用几条草稿跑出真实的截断行为，验的是行为不是数字。
const DRAFT_KEEP = intEnv('GRANCYAN_DRAFT_KEEP', 40, 3, 500);
const DRAFT_LOCK = DRAFT_FILE + '.lock';

// ⚠️ 「处理过哪些评论」**单独存，不跟着审计历史截断**（Codex 逮到的）。
//   原来去重是拿 drafts 列表里的 mid 算的，而那个列表 slice(-40)。
//   处理到第 41 条时，最早那条的 mid 就从去重集合里消失了 —— 如果收件箱缓存
//   还留着它（收件箱自己留 60 条），它会**重新变成候选**被再起草一次。
//   要是那条当初已经回过，用户就会对着同一条评论回第二遍。
//   审计历史可以截断（那只是给人看的），去重凭据不能。
const DRAFT_SEEN_KEEP = 500;

// ⚠️⚠️ 截断只许裁**终态**记录（Codex 三审逮到）。
//   原来是无脑 `.slice(-DRAFT_KEEP)`，它不看状态 —— 于是 pending、generating、
//   甚至**正在往外发的 sending** 都可能被新草稿挤出列表。
//   场景：用户点发 A（A 进 sending、请求在飞），同一时刻另一个客户端起草 D，
//   追加之后 A 被挤掉；A 的评论随后真的发出去了，而收尾 `.find()` 已经找不到记录 ——
//   审计和发送租约一起消失，那条评论发出去了却没人知道，账也没记。
//   所以：活着的一条都不裁，只裁终态历史。
const DRAFT_LIVE = new Set(['generating', 'pending', 'sending']);
const trimDrafts = (list) => {
    const keep = new Set((list || []).filter(x => !DRAFT_LIVE.has(x.state)).slice(-DRAFT_KEEP));
    return (list || []).filter(x => DRAFT_LIVE.has(x.state) || keep.has(x));
};
// 活着的不裁 → 它就得有自己的闸，否则「她一直不理看板」会让列表无限长。
// 到顶就不再起草（不是悄悄裁掉）—— 裁掉活的正是上面要防的事。
// 默认 20 远大于每日起草上限 6，正常用一辈子碰不到。
const DRAFT_LIVE_MAX = intEnv('GRANCYAN_DRAFT_LIVE_MAX', 20, 1, 200);

// 起草崩在半路留下的 generating 记录：它占着额度，但永远不会变成草稿。
// 不归一化的话，进程崩几次就把当天的起草额度吃光，而看板上什么都看不到。
// 抽成纯函数同 healStaleSending：写在 loadDrafts 里的 if 只能靠源码正则验，改坏了照样绿。
//
// ⚠️ 阈值要**大于一次合法调用的时间**，否则会把还活着的请求判死。
//   从 server.js 的 claudeOnce 估：claude CLI 进程硬超时 CLAUDE_ONCE_TIMEOUT_MS = 240s，
//   到点整棵进程树掐掉。取 8 分钟。
//   （Codex 二审：原来的 3 分钟卡在这个数之内。）
//
//   ⚠️ 但 240s 是**工程估算，不是绝对的墙钟上界**（Codex 三审纠正我的措辞）——
//   GC 停顿、机器休眠、DNS 卡住都能让真实耗时超出去。所以这个数字只是余量，
//   **正确性一点都不许依赖它** —— 真正兜底的是下面的 gen 租约：
//   判死之后就算原请求活着回来，租约对不上也写不进去。
const GENERATING_STALE_MS = 8 * 60 * 1000;
function healStaleGenerating(d, now, onHeal) {
    const t = now === undefined ? Date.now() : now;
    for (const x of (d && d.drafts) || []) {
        if (x.state === 'generating' && t - Date.parse(x.at || 0) > GENERATING_STALE_MS) {
            x.state = 'failed';
            x.why = x.why || '起草过程中进程没了';
            // 终态就不留 xsec_token 了。这一条以前漏了（Codex 三审），
            // 于是「所有 failed 都不带 token」这句话是假的：崩溃遗留的那些
            // 会一直带着 token 躺到被截断为止。
            delete x.token;
            if (typeof onHeal === 'function') onHeal(x);
        }
    }
    return d;
}

// 用哪个模型。**没有「跟随默认」这一档**（server.js 那边的 claudeOnce 也拒绝空串）：
// 这个功能存在的全部理由就是别用大模型，让它悄悄回退到 Opus 等于白做，
// 而且是静默白做 —— 除非有人去翻账单，否则永远发现不了。
const DRAFT_MODEL = String(process.env.GRANCYAN_DRAFT_MODEL || '').trim()
    || 'claude-haiku-5-5';   // 2026-10-08 从 4.5 换来：便宜约四分之三（server.js 的 claudeOnce 给 Haiku 5 压到 --effort low）

// 起草也要有每日上限，而且要**小于**发送上限（8）。
// 反直觉但必要：起草不占发送额度，于是「反复重抽直到满意」这件事没有任何东西拦着 ——
// 那正好是这次改动要消灭的开销，不设闸就是换个地方烧。
const DRAFT_DAILY_MAX = intEnv('GRANCYAN_DRAFT_MAX', 6, 0, 30);

function loadDrafts() {
    let d;
    try {
        d = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
    } catch (e) {
        // ⚠️ **只有「文件还不存在」才算空本子**（Codex 三审逮到）。
        //   原来是 `catch { return 空 }`，把权限错、瞬时读失败、JSON 写坏了
        //   全都当成「第一次启动」—— 而拿到空本子的调用方接着就会 saveDrafts()，
        //   把原来的 drafts / seen / quota **整本盖掉**。seen 一没，
        //   已经回过的旧评论重新进候选池，值班员会再回一遍。
        //   所以其余错误一律往外抛：功能当场坏掉（看得见）远好过账本被静默清空。
        if (e && e.code === 'ENOENT') return { drafts: [], seen: [] };
        throw e;
    }
    if (!Array.isArray(d.seen)) d.seen = [];
    // 已有身份一旦重复就 fail-closed。发送端用 `.find()` 取第一条；让重复身份继续服务，
    // 就会出现「点第二张卡片，却把第一条的文字发到第一条笔记下」这种不可撤回的错发。
    assertUniqueDraftIds(d);
    return d;
}
function assertUniqueDraftIds(d) {
    const ids = new Set();
    for (const x of (d && d.drafts) || []) {
        if (!x || !x.draftId) continue;       // 缺身份的老记录由持锁恢复过程迁移
        const id = String(x.draftId);
        if (ids.has(id)) throw new Error(`草稿本子里有重复 draftId：${id}`);
        ids.add(id);
    }
}
// 迁移和治愈都会改数据，所以只能在草稿锁里做。返回值告诉调用方是否真的变了，
// GET /drafts 才能在没有变化时保持纯读，不为每次刷新制造一次无谓写盘。
function repairDrafts(d, now) {
    let changed = false;
    for (const x of (d && d.drafts) || []) {
        if (!x.draftId) { x.draftId = crypto.randomUUID(); changed = true; }
    }
    assertUniqueDraftIds(d);
    healStaleGenerating(d, now, () => { changed = true; });
    return changed;
}
function saveDrafts(d) {
    fs.mkdirSync(path.dirname(DRAFT_FILE), { recursive: true });
    const tmp = DRAFT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, DRAFT_FILE);
}
// 今天的草稿记录 —— 给看板显示用。
function draftsToday(d) {
    return ((d && d.drafts) || []).filter(x => x.date === today());
}

// ⚠️⚠️ 额度**单独记一个计数器，不数 drafts 列表**。
//   数列表的话，额度就挂在一个会被 `slice(-DRAFT_KEEP)` 截断的东西上：
//   把 DRAFT_KEEP 调到比每日上限小，今天花掉的记录会被挤出列表，
//   额度检查跟着失效 —— 起草可以无限跑，而且零报错，只有账单会说话。
//   （这个洞是 2026-08-28 把 DRAFT_KEEP 改成可配时**我自己引进来的**，
//    当场堵掉：能被截断的东西不能拿来当账。）
//   计数器只增不减，跨天自动归零。
// ⚠️ 取**计数器和当天记录条数的大值**，不是只看计数器。
//   Codex 二审提的场景：草稿本子里有当天的 drafts 但没有 quota 字段（早期格式、
//   手改过、写了一半），额度直接归零 → 当天又能白花六次模型钱。
//   取大值是安全的，因为 drafts 里每一条当天记录都对应一次真实的 bumpDraftQuota，
//   截断只会让它**少数**、永远不会多数 —— 所以它是个下界，不是替代品。
//   （正常情况下计数器 ≥ 条数，这个 max 什么也不改变。）
function draftQuotaUsed(d) {
    const q = (d && d.quota) || {};
    const counter = q.date === today() ? Math.max(0, q.used | 0) : 0;
    return Math.max(counter, draftsToday(d).length);
}
function bumpDraftQuota(d) {
    const q = (d.quota && d.quota.date === today()) ? d.quota : { date: today(), used: 0 };
    q.used = Math.max(0, q.used | 0) + 1;
    d.quota = q;
    return q.used;
}

// ⚠️⚠️ 「读 → 改 → 写」必须整个在锁里，而且**读要在锁里读**（Codex 逮到的丢更新）。
//   我原来的写法是：端点开头 `const d = loadDrafts()` → await 模型几秒 → 拿这个 d 整本写回。
//   等模型的那几秒里，用户完全可能在看板上把另一条草稿发掉或扔掉；
//   那次 resolve 写进去的状态，会被我这份**调用模型之前读到的**旧副本原样盖回去 ——
//   已经发出去的草稿变回 pending，重新出现在看板上，她再点一次就是重复评论。
//   所以：模型调用在锁外，落盘前重新读。
async function mutateDrafts(fn) {
    return withFileLock(DRAFT_LOCK, async () => {
        const d = loadDrafts();
        // 老格式迁移必须在调用业务逻辑前立即落盘；否则 fn 抛错时，随机 UUID 会随
        // 这次内存对象一起消失，下次读取又换一批身份。
        if (repairDrafts(d)) saveDrafts(d);
        const out = await fn(d);
        saveDrafts(d);
        return out;
    }, '草稿本子写不进去');
}
async function recoverDrafts() {
    return withFileLock(DRAFT_LOCK, async () => {
        const d = loadDrafts();
        if (repairDrafts(d)) saveDrafts(d);
        return d;
    }, '草稿本子恢复不进去');
}

function clearDraftError(rec) {
    delete rec.error;
}

// 收件箱里哪些**能回**。纯函数，为的是能单测 —— 这几条判据错一个的症状都是
// 「对着不该说话的地方说了话」，而那是发出去就撤不回来的那类错。
//
// ⚠️ self 必须排除：自己评论自己的笔记也会进 mentions（实测过）。不排的话
//   值班员会一本正经地回复我自己昨天说的话。
// ⚠️ deleted 必须排除：笔记删了通知还留着，回复会失败得莫名其妙。
// ⚠️ 没有 note.id 的排除：/say 拿它当评论目标，空的发不出去。
// ⚠️ chat（私信）整类排除：GranCyan 根本没有发私信的通道（记忆里那条天花板），
//   而且 chats 接口连「最后一句是谁说的」都给不出来。让值班员去起草私信回复，
//   等于让它对着一句可能是我自己讲的话作答。
function draftCandidates(inbox, opts) {
    const o = opts || {};
    const done = new Set(o.doneIds || []);
    return ((inbox && inbox.items) || [])
        .filter(it => it
            && it.kind === 'mention'
            && !it.self
            // ⚠️ 没有 mid 的必须排除（Codex 逮到的）：mid 是去重用的唯一凭据，
            //   没有它这条永远进不了「处理过」集合 —— 于是每次起草都抽中它，
            //   一天六次额度全烧在同一条评论上，而且零报错。
            && it.mid
            && it.note && it.note.id && !it.note.deleted
            && String(it.text || '').trim()
            && !done.has(it.mid))
        .sort((a, b) => (b.at || 0) - (a.at || 0));
}

// 给小模型的人格。**故意是短的** —— 完整 persona 有几万字，塞进来就把省下的又花回去了。
// 要的是「像个具体的人随口回一句」，不是「聪明」。
//
// ⚠️ 禁词那句必须写进提示里，不能只靠事后 sayCheck 拦。拦下来的草稿是废的，
//   而废掉的那次 API 调用照样收费 —— 事前说一句比事后扔一条便宜。
//   （但事后那道 sayCheck 一条都不能少：提示词是请求，护栏才是保证。）
const DRAFT_SYSTEM = [
    '你在替一个叫「克克」的人回小红书评论区。克克是个普通网友：说话短、随意、有点小幽默，',
    '不端着、不客套、不写小作文、不用感叹号堆热情、不说「感谢支持」这类客服腔。',
    '',
    '规矩：',
    '- 只回一句话，不超过 40 个字，越自然越好。',
    '- 直接输出这句话本身，不要引号，不要解释，不要写「回复：」。',
    '- 不许提任何人的真名、项目名，不许带链接、微信号、任何联系方式。',
    '- 不确定对方在说什么、或者这条评论根本不需要回（比如只是个表情），就只输出：跳过',
].join('\n');

// 喂给模型的上下文，先把禁词抹掉。
//
// ⚠️ 这**不是护栏** —— 护栏是 sayCheck，它一个字没动，也永远排在发送前面。
//   这是**省钱**：笔记标题里很可能就带着 AI 自己的名字（比如「我是克克 今天学会上网了」），
//   而名字正在禁词表里。原样喂进去，模型十有八九跟着用这个称呼（它最爱抄的
//   就是上下文里的词），写出来的草稿当场被 sayCheck 判死 —— 而那次调用的钱已经花了。
//   DRAFT_SYSTEM 里那句「不许提真名」管的是**输出**，这个管**输入**，两头都要。
//
// ⚠️ 用 sayNormalize 找词，不做朴素的 split/join：禁词表里只有半角，
//   而标题里可能是全角、大写或者夹着零宽字符 —— 那些 sayCheck 拦得住，
//   这里漏掉就等于白抹一场（模型抄的是原文，不是规范化之后的）。
// 命中区间求并集。抽成纯函数是为了**能真被测**：
// 禁词表里常见的是后缀关系（比如「明」和「阿明」），不一定有前缀关系，
// 所以 draftRedact 走整条链路测不出下面这个洞 —— 它是潜伏的，
// 往表里加一个前缀词（比如再加个「Gran」）当天就会活过来。
//
// ⚠️ 必须真求并集，不能「起点落在游标之前就整条跳过」（Codex 二审逮到的）：
//   同起点时短命中排在前，游标停在短词末尾，长命中被丢掉，
//   **长词的后半截原样留在正文里** —— 交叉重叠同理。
//   `<= last[1] + 1` 让重叠和紧挨走同一条路径，于是连着的两个禁词自然合成一个 TA。
function mergeSpans(hits) {
    const sorted = hits.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const spans = [];
    for (const [s0, s1] of sorted) {
        const last = spans[spans.length - 1];
        if (last && s0 <= last[1] + 1) last[1] = Math.max(last[1], s1);
        else spans.push([s0, s1]);
    }
    return spans;
}

function draftRedact(s) {
    const raw = String(s || '');
    if (!raw) return '';
    // 规范化会改变长度（零宽被删、全角转半角），所以不能拿规范化串的下标直接切原串。
    // 逐字符建一张「规范化串位置 → 原串位置」的映射，再回原串上整段替换。
    const map = [];
    let norm = '';
    for (let i = 0; i < raw.length; i++) {
        const n = sayNormalize(raw[i]);
        for (let k = 0; k < n.length; k++) { norm += n[k]; map.push(i); }
    }
    const hits = [];
    for (const w of SAY_FORBIDDEN) {
        const nw = sayNormalize(w);
        if (!nw) continue;
        let from = 0, at;
        while ((at = norm.indexOf(nw, from)) >= 0) {
            hits.push([map[at], map[at + nw.length - 1]]);
            from = at + nw.length;
        }
    }
    if (!hits.length) return raw;
    // ⚠️ 必须先把命中区间做**并集**，不能边排序边跳过重叠的。
    //   Codex 二审逮到的洞：同起点时若短命中排在前，`cur` 停在短词末尾，
    //   长命中因为起点落在 cur 之前被整条丢掉 —— 长词的后半截原样留在正文里。
    //   禁词表里很容易出现这种包含关系（「明」和「阿明」）。
    //   合并时用 `<= last[1] + 1`：重叠**和紧挨**走同一条路径，于是
    //   连着的两个禁词自然抹成一个 TA（昵称「Alice阿明」否则会变「TATA」）。
    let out = '', cur = 0;
    for (const [s0, s1] of mergeSpans(hits)) {
        out += raw.slice(cur, s0) + 'TA';
        cur = s1 + 1;
    }
    return out + raw.slice(cur);
}

function draftUserPrompt(cand) {
    const c = cand || {};
    const note = draftRedact((c.note && c.note.title || '').trim());
    return [
        note ? `我的笔记：${note}` : '我的笔记：（读不到标题）',
        `${draftRedact(c.who || '有人')} 评论说：${draftRedact(String(c.text || '').trim())}`,
        '',
        '你要回的就是这条评论。',
    ].join('\n');
}

// 把模型的回复收拾成一句能发的话。
//
// ⚠️ 小模型比大模型更爱加壳 —— 引号、「回复：」前缀、末尾解释、有时候还带上
//   自己的推理。这些跟着发出去就是当众露馅，而且**长度检查看的是收拾之后的字数**，
//   壳没剥干净会让一条本来合格的评论被判超长。
// ⚠️ Codex 提醒还有一整类壳我没剥：Markdown。小模型很爱回 `**这句**` 或者
//   `- 这句`，甚至裹一个代码围栏。这些跟着发出去就是当众露馅。
//   （它建议改成让模型回严格 JSON。我没采纳，理由写在 DRAFT_SYSTEM 那儿。）
function draftClean(raw) {
    let t = String(raw || '').trim();
    // 代码围栏整个剥掉：```/```json 开头那行和结尾那行都不是内容
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    t = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';   // 只要第一行
    t = t.replace(/^[-*•]\s+/, '');                       // 列表符号
    t = t.replace(/^\d+[.)、]\s*/, '');                    // 有序列表
    t = t.replace(/^(回复|评论|回答)\s*[:：]\s*/, '');
    t = t.replace(/^\*\*([\s\S]*?)\*\*$/, '$1').trim();   // 整句加粗
    t = t.replace(/^[“"'「『]+/, '').replace(/[”"'」』]+$/, '');
    return t.trim();
}
// 模型自己说这条不用回。判据放宽一点：它有时会写成「跳过。」或者「（跳过）」。
function draftIsSkip(t) {
    return /^[（(\[]?跳过[）)\]。.]?$/.test(String(t || '').trim());
}

// ── 挂端点 ──────────────────────────────────────────
// ⚠️⚠️ 只看 remoteAddress 是**不够的**（Codex 2026-08-23 逮到，我实测复现了）：
//   server 上挂着全局 app.use(cors())，用户随便打开一个恶意网页，那个页面就能
//   fetch('http://127.0.0.1:3000/api/social-browser/say', …)。请求由她的浏览器发出，
//   在服务端看来源地址就是 127.0.0.1，稳稳通过 loopback 检查 —— 然后用我那个
//   登录着的号发评论。实测：带 Origin: https://evil.example.com 的请求返回 200。
//
//   所以再加一道**同源判据**：浏览器发起的跨源请求一定带 Origin，而且那个 Origin
//   是攻击者自己的域名，永远对不上本机。非浏览器的请求（探针、curl）没有 Origin，
//   走 loopback 那一关。这两条叠起来，网页那条路就关死了。
// 判据在 origin-guard.js，**和 server.js 共用同一份**。
// ⚠️ 这里的白名单是**空的**，比 server 那边严：server 要放行安卓 APK 的
//   https://grancyan.app（它的页面挂在虚拟域名下，天生跨源），而这条通道后面是一个
//   登录着的浏览器，只服务本机，没有理由给任何外部 origin 开口。
const originOk = require('./origin-guard').makeOriginGuard([]);

function notLocal(req, res) {
    if (!originOk(req)) {
        res.status(403).json({ ok: false, error: '这个请求来自别的网站（跨站请求一律拒绝）' });
        return true;
    }
    if (LAN_OK) return false;
    const ip = String(req.socket && req.socket.remoteAddress || '');
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false;
    res.status(403).json({ ok: false, error: '浏览器通道只对本机开放（这条通道后面是一个登录着的浏览器）' });
    return true;
}

// 一次只发一条。
// ⚠️ 少了这把锁，模型一轮里写两条 [[SAY:]] 就能同时通过「今天用了几条」的检查
// （两边都读到 0，两边都发，落盘各记一笔）—— 每日上限直接被绕过去，而且零报错。
let _sayBusy = false;

function mountSocialBrowser(app, deps) {
    // 笔记页必须带 xsec_token，而 token 攥在 server.js 刷推荐流时的那份缓存里。
    // 传函数进来而不是把缓存搬过来：两边各管各的，别让这个模块去 require server.js。
    const getToken = (deps && deps.xhsToken) || (() => null);
    const rememberToken = (deps && deps.rememberXhsToken) || null;

    // 空闲清扫。⚠️ 必须 unref()：不 unref 的话这个定时器会把事件循环永远吊住，
    //   server 收到关闭信号后进程不退，exe 关窗之后留一个僵尸在后台 ——
    //   本来是来修「有东西不肯走」的，别自己再造一个。
    // 测试里不挂（GRANCYAN_NO_CHROME_SWEEP），否则每个用到这个模块的套件都会拖一个定时器。
    if (!process.env.GRANCYAN_NO_CHROME_SWEEP) {
        const timer = setInterval(() => { sweepIdleChrome().catch(() => { }); }, CHROME_SWEEP_MS);
        if (typeof timer.unref === 'function') timer.unref();
    }

    // 通道体检：Chrome 在不在、两家登录了没
    app.get('/api/social-browser/status', async (req, res) => {
        if (notLocal(req, res)) return;
        const s = loadSays();
        try {
            const st = await loginStatus();
            res.json({
                ok: true, port: PORT, profile: PROFILE_DIR, chromeBin: chromeBin(),
                ...st,
                quota: { max: SAY_DAILY_MAX, usedToday: saysToday(s).length },
                allowedSites: [...SAY_ALLOWED_SITES],
                says: (s.says || []).slice(-20).reverse(),
            });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 把专用浏览器拉起来，给用户扫码用
    app.post('/api/social-browser/open', async (req, res) => {
        if (notLocal(req, res)) return;
        // ⚠️ 这个端点的用途就是「拉起来给用户扫码」，接下来的时间**服务端不会有任何请求** ——
        //   她在浏览器里操作，我这边看着完全像空闲。所以这里要给一段宽限，
        //   否则空闲自动关会在她扫码扫到一半把窗口关掉。
        _chromeGraceUntil = Date.now() + CHROME_GRACE_MS;
        _chromeLastUse = Date.now();
        const r = await ensureChrome();
        res.json(r.ok ? { ok: true, ...r, profile: PROFILE_DIR } : { ok: false, error: r.error });
    });

    // 清浏览记录（聊天里 Claude 的 chromecare 工具调这个，见 mcp-chromecare.js）
    app.post('/api/social-browser/clear-history', async (req, res) => {
        if (notLocal(req, res)) return;
        try { res.json(await clearHistory()); }
        catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 用真浏览器读一个页面（拿渲染完的东西 —— 小红书评论区只有这条路看得见）
    app.post('/api/social-browser/read', async (req, res) => {
        if (notLocal(req, res)) return;
        const url = String((req.body || {}).url || '');
        if (!/^https:\/\/(www\.)?(xiaohongshu|bilibili)\.com\//.test(url)) {
            return res.status(400).json({ ok: false, error: '这条通道只开给小红书和 B 站' });
        }
        try {
            const data = await inPage(url, `(() => ({
                title: document.title,
                text: (document.body ? document.body.innerText : '').slice(0, 6000),
            }))()`, { wait: Number((req.body || {}).wait) || 4500 });
            res.json({ ok: true, data });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 干跑：只过闸，不发。给前端和测试用 —— 发之前能先知道会不会被拦。
    app.post('/api/social-browser/check', (req, res) => {
        if (notLocal(req, res)) return;
        const text = String((req.body || {}).text || '');
        const bad = sayCheck(text);
        const used = saysToday(loadSays()).length;
        res.json({
            ok: !bad && used < SAY_DAILY_MAX,
            reason: bad || (used >= SAY_DAILY_MAX ? `今天的 ${SAY_DAILY_MAX} 条已经用完了` : ''),
            quota: { max: SAY_DAILY_MAX, usedToday: used },
        });
    });

    // 读一条笔记的评论区。纯 HTTP 那条路看不到这个（要 x-s 签名），只有真浏览器能。
    app.post('/api/social-browser/comments', async (req, res) => {
        if (notLocal(req, res)) return;
        const id = String((req.body || {}).id || '').trim();
        if (!/^[0-9a-f]{8,32}$/i.test(id)) return res.status(400).json({ ok: false, error: `「${id}」不像小红书笔记 id` });
        try { res.json({ ok: true, data: await xhsComments(id, getToken(id)) }); }
        catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 只读账本。**故意不和 /status 合并**：那个要连 Chrome 查登录态，
    // 会把浏览器拉起来还要等页面渲染（好几秒）。散步看板每次打开都付这个代价
    // 不值当，而且 Chrome 没开的时候看板就整块空了 —— 记录本身跟 Chrome 无关。
    app.get('/api/social-browser/says', (req, res) => {
        if (notLocal(req, res)) return;
        const s = loadSays();
        res.json({
            ok: true,
            quota: { max: SAY_DAILY_MAX, usedToday: saysToday(s).length },
            allowedSites: [...SAY_ALLOWED_SITES],
            says: (s.says || []).slice(-30).reverse(),
        });
    });

    // 收件箱：只读缓存。**不开浏览器** —— 同 /says 那条理由，
    // 散步看板每次打开都去拉一个 Chrome + 等九秒页面渲染，不值当。
    app.get('/api/social-browser/inbox', (req, res) => {
        if (notLocal(req, res)) return;
        const s = loadInbox();
        if (!s) return res.json({ ok: true, never: true, items: [], pollMin: INBOX_POLL_MIN });
        res.json({
            ok: true, lastPollAt: s.lastPollAt || 0, lastPollError: s.lastPollError || '',
            me: s.me || null, unread: s.unread || null, missing: s.missing || [],
            pollMin: INBOX_POLL_MIN,
            items: (s.items || []).slice(-30).reverse(),
        });
    });

    // 真去刷一次（会把专用 Chrome 拉起来，慢，十几秒）
    app.post('/api/social-browser/inbox/poll', async (req, res) => {
        if (notLocal(req, res)) return;
        try {
            const r = await xhsInboxPoll();
            res.json({ ok: true, added: r.added, first: r.first,
                       items: (r.state.items || []).slice(-30).reverse(),
                       me: r.state.me, unread: r.state.unread, missing: r.state.missing,
                       lastPollAt: r.state.lastPollAt, pollMin: INBOX_POLL_MIN });
        } catch (e) {
            inboxNoteFailure(e.message);        // 见它的注释：不留痕就是把失败说成没发生
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 定时轮询。**默认关**（0）—— 开着的话它会时不时自己拉起一个 Chrome 窗口，
    // 那是会打扰人的事，得她自己点头。
    if (INBOX_POLL_MIN > 0) {
        const tick = () => xhsInboxPoll()
            .then(r => { if (r.added) console.log(`[窗] 收件箱：${r.added} 条新动静`); })
            .catch(e => { inboxNoteFailure(e.message); console.log('[窗] 收件箱刷失败：' + e.message); });
        setTimeout(tick, 30000).unref?.();                       // 开机别抢资源
        setInterval(tick, INBOX_POLL_MIN * 60000).unref?.();
        console.log(`[窗] 收件箱每 ${INBOX_POLL_MIN} 分钟自己刷一次`);
    }

    // 说话
    app.post('/api/social-browser/say', async (req, res) => {
        if (notLocal(req, res)) return;
        const b = req.body || {};
        const site = String(b.site || 'xhs').trim();
        const id = String(b.id || '').trim();
        const text = String(b.text || '').trim();

        // 调用方**可以**自带 xsec_token：token 只在推荐流里给，所以不带这个参数的话
        // 「评论一条指定的旧笔记」永远做不到（实测：让它评论一条旧笔记，
        // 当场被这道坎挡住）。
        //
        // ⚠️ **只给这一次用，不马上写进缓存**（Codex 七审逮到的）。
        //    我原来写的是「拿到就 rememberToken」，还在注释里说「塞个假的最多是这条发不出去」——
        //    这句话是错的：缓存里本来可能存着这条笔记的**有效** token，一个过期的/抄错的
        //    外带 token 会当场把它顶掉，于是后面所有不带 token 的 SAY、读笔记也跟着失败，
        //    直到重新刷推荐流才恢复。而且校验在这行之后，非法站点的请求也能污染缓存。
        //    ——「本次请求带来的输入」不该在被验证之前改动**跨请求的共享状态**。
        const tok = String(b.token || '').trim();

        try {
            const out = await sendComment({ site, id, text, tok });
            res.json({ ok: true, ...out.r, quota: { max: SAY_DAILY_MAX, usedToday: out.used + 1 } });
        } catch (e) {
            res.status(e.http || 500).json({ ok: false, error: e.message, unknown: !!e.unknown });
        }
    });

    // 真正发一条评论。**整套护栏都在这里面**，而且只有这一份 ——
    // 「发送草稿」那个端点也走它，不许另写一遍。复制一份护栏出来，
    // 迟早有一天两份会走岔（改了一边忘了另一边），而这道闸后面是撤不回来的评论。
    async function sendComment({ site, id, text, tok }) {
        // ⚠️ 发之前抛的错，一律显式打上 `notSent` —— 这不是装饰，是判据。
        //   调用方（/draft-send）现在是**fail-closed**：只有明确说了「确定没发出去」
        //   才敢把草稿退回 pending，其余一律当成「可能已经发出去了」。
        //   所以漏打一个 notSent 的后果是「她的草稿卡在 sent 发不了」（烦但安全），
        //   而**多打一个**的后果是重复评论（撤不回来）。宁可漏别多打。
        //
        //   ⚠️ 助手**必须写在这个函数里面**。engawa.test.js 用 vm 把 sendComment 的
        //   源码整段抠出来单独跑（就为了防「抠一半、另一半没人守」），写在外面它抠不到，
        //   403 会变成 500。2026-09-02 就这么栽过一次，基线注入逮到的。
        const notSent = (msg, http) => { const e = new Error(msg); e.http = http; e.notSent = true; return e; };

        // 账号归属这一关排在最前面 —— 别的都可以商量，用谁的号说话不行
        if (!SAY_ALLOWED_SITES.has(site)) {
            throw notSent(`${site} 这边只看不说（那是用户自己的号）`, 403);
        }
        const bad = sayCheck(text);
        if (bad) throw notSent(bad, 400);

        // 站点 → 发送函数。**必须查表**，不能认了 site 就无条件调 xhsSay：
        // 那样 GRANCYAN_SAY_SITES=bili 会把评论发到小红书、却在账本里记成 B 站
        // （Codex 2026-08-23 逮到的 —— 一条真 bug，不是理论风险）。
        const send = SAY_SENDERS[site];
        if (!send) throw notSent(`${site} 这边还没有发评论的实现`, 501);

        if (_sayBusy) throw notSent('上一条还在发，等它发完', 429);
        _sayBusy = true;
        // ⚠️ **别靠逐个错误手工打 notSent**（Codex 三审逮到，我上一轮就是这么做的）。
        //   漏网的有一整类：拿锁超时（另一个进程握着 say 锁）、loadSays() 读失败、
        //   占位那次 saveSays() 写失败 —— 这些都发生在 send() 之前，评论一个字都没发出去，
        //   但错误上没有 notSent。收尾的 fail-closed 会把它判成「可能发出去了」，
        //   于是草稿被永久记成 sent、从看板消失，**而评论一次都没发**。
        //   正解是一个阶段变量：只在真正要调发送器的**最后一刻**置位。
        //   在它之前抛的，一律确定没发出去。
        let sendAttempted = false;
        try {
            // 锁一直握到发完为止 —— 跨进程也是一次只有一条在飞
            return await withSayLock(async () => {
                const s = loadSays();
                const used = saysToday(s).length;
                if (used >= SAY_DAILY_MAX) {
                    throw notSent(`今天的 ${SAY_DAILY_MAX} 条已经用完了，明天再说`, 429);
                }

                // ⚠️ **先占额度再发**。原来是「发成功了才落盘」，理由是不想让看板显示
                //   一条不存在的评论 —— 但那是个伪二选一（Codex 点破的）：
                //   进程在发出去之后、落盘之前挂掉，就成了「评论真在外面、账上一笔没有」，
                //   下一次还会照发，配额直接失效。
                //   正解是先写一条 sending 占住位置，再按结果改它的状态。
                //   看板照实显示每一档，不存在的评论也就不会被说成存在。
                const at = new Date().toISOString();
                s.says = (s.says || []).concat([{ date: today(), at, site, id, text, state: 'sending' }]);
                saveSays(s);

                const patch = (fields) => {
                    const s2 = loadSays();
                    const rec = (s2.says || []).find(x => x.at === at);
                    if (rec) Object.assign(rec, fields);
                    saveSays(s2);
                };

                let r;
                sendAttempted = true;     // ← 分水岭。这一行之后抛的错都可能「已经发出去了」
                try {
                    // 外带的 token 优先，但**只用于这一次**：不写回 _xhsTokens。
                    // 写回去的话，一个抄错/过期的 token 会顶掉缓存里原本有效的那个，
                    // 让之后所有不带 token 的请求跟着坏（Codex 七审）。
                    r = await send(id, tok || getToken(id), text);
                } catch (e) {
                    // 确定没发出去 → 标 notsent，不占额度（SAY_COUNTS 里没有它）。
                    // 其余一律 unknown，**继续占着额度** —— 判不出来的时候按发出去算。
                    //
                    // ⚠️ 记账要是也失败了（盘满、临时文件冲突），**不许让文件错误顶掉 e**。
                    //   顶掉之后 e 身上的 notSent/unknown 就没了，调用方看到的是一个
                    //   赤裸裸的 fs 错误 —— 而「判不出发没发」正是这里唯一要传出去的信息。
                    //   （Codex 二审逮到的。）
                    try {
                        patch(e.notSent ? { state: 'notsent', error: e.message }
                                        : { state: 'unknown', error: e.message });
                    } catch (e2) {
                        console.error('[说] 记账失败，但原始结果照原样往上抛：', e2.message);
                    }
                    throw e;
                }
                // ⚠️ 到这里评论**已经在外面了**，撤不回来。所以记账失败绝不能抛 ——
                //   抛出去的话调用方看到一个没有 notSent 的错误，把草稿退回 pending，
                //   她再点一次就是第二条评论。账没记上是可以补的，评论发两遍不可以。
                //   （额度不受影响：上面那条 sending 记录早就落盘占住位置了。）
                try {
                    patch({ state: r.state, commentId: r.commentId || '', status: r.status });
                } catch (e2) {
                    console.error('[说] 评论已发出，但账没记上（状态停在 sending）：', e2.message);
                }
                return { r, used };
            });
        } catch (e) {
            if (!sendAttempted) e.notSent = true;
            // ⚠️ 「判不出发没发」这个语义必须**同时**记进账本和错误对象（Codex 三审逮到）。
            //   原来只写进了 says 账本的 state:'unknown'，错误上没有标记，
            //   于是 /draft-send 回给前端的 `unknown` 是 false ——
            //   看板会明说「没发出去：ECONNRESET」，等于当面请用户手工重发一遍，
            //   而那条评论可能已经在外面了。谎报确定性比报错更危险。
            else if (!e.notSent) e.unknown = true;
            throw e;
        } finally {
            _sayBusy = false;
        }
    }

    // ── 值班员：起草 ──────────────────────────────────
    // 只读收件箱缓存 + 叫一次小模型，**不开浏览器、不发任何东西**。
    const draftOnce = (deps && deps.claudeOnce) || null;

    // ⚠️ 一条草稿在**服务端**能被看见的形状。
    //   `token`（xsec_token）**不在里面** —— Codex 逮到的：把它写进长期文件、
    //   再经 /drafts 发到前端 DOM 里，等于把一个本该短命的东西散出去。
    //   发送时服务端自己从草稿本子里取（见 /draft-send），前端全程碰不到它。
    const draftPublic = (x) => {
        const { token, ...rest } = x || {};
        return rest;
    };

    app.get('/api/social-browser/drafts', async (req, res, next) => {
        if (notLocal(req, res)) return;
        try {
        const d = await recoverDrafts();
        res.json({
            ok: true,
            model: DRAFT_MODEL,
            quota: { max: DRAFT_DAILY_MAX, usedToday: draftQuotaUsed(d) },
            // 只把还在等着的给前端；已发/已扔的留在文件里备查，不占看板
            drafts: (d.drafts || []).filter(x => x.state === 'pending').map(draftPublic).reverse(),
            // 需要用户亲自看一眼的记录不能跟 history 一起截断：较老的 sending / unknown
            // 也仍然占名额、仍然关系到会不会重复发，藏掉一条都不行。
            attention: (d.drafts || []).filter(x => x.state === 'sending' || x.sayState === 'unknown')
                .map(draftPublic).reverse(),
            history: (d.drafts || []).filter(x => x.state !== 'pending').slice(-10).map(draftPublic).reverse(),
        });
        } catch (e) { next(e); }
    });

    app.post('/api/social-browser/draft', async (req, res) => {
        if (notLocal(req, res)) return;
        if (!draftOnce) return res.status(501).json({ ok: false, error: '没接模型通路（server.js 没把 claudeOnce 传进来）' });

        const inbox = loadInbox();
        if (!inbox) return res.json({ ok: true, none: true, why: '收件箱还没刷过，先去刷一次' });

        // ── 第一阶段：占额度（持锁，很短）──────────────
        // ⚠️ 额度检查和落盘必须在**同一把锁**里（Codex 逮到的）。分开的话两个进程
        //   都读到「今天用了 5 次」，两个都通过，两次都真的花钱调模型。
        //   而且这里就**先把位置占住**（写一条 generating），理由同 /say 的「先占额度再发」：
        //   在模型返回之前崩掉的话，钱已经花了，账上不能一笔没有。
        let claim;
        try {
            claim = await mutateDrafts(async (d) => {
                const used = draftQuotaUsed(d);
                if (used >= DRAFT_DAILY_MAX) {
                    const e = new Error(`今天已经起草 ${used} 次了，够了`); e.http = 429; throw e;
                }
                // 去重查的是**单独存的 seen**，不是会被截断的 drafts 列表
                const cand = draftCandidates(inbox, { doneIds: d.seen || [] })[0];
                if (!cand) return null;

                // 活着的草稿不再被截断（见 trimDrafts），所以它得有自己的上限。
                // 到顶就不起草，而不是悄悄裁掉一条 —— 裁掉活的正是 trimDrafts 要防的事。
                const live = (d.drafts || []).filter(x => DRAFT_LIVE.has(x.state)).length;
                if (live >= DRAFT_LIVE_MAX) {
                    const e = new Error(`看板上还堆着 ${live} 条没处理的草稿，先清一清`);
                    e.http = 429; throw e;
                }

                const at = new Date().toISOString();     // 只给人看的时间，**不是身份**
                // ⚠️ 幂等键是 draftId，不是 at（Codex 三审判的，我上一轮的方案输了）。
                //   我原来给 `at` 加了「撞了就往后挪毫秒」，以为够用。它挡得住同一毫秒的
                //   碰撞，但**没有建立身份不变式**：截断会把记录移出列表，而系统时钟回拨之后
                //   新草稿可能复用那个时间戳 —— 这时旧看板拿着老 `at` 点发送，`.find()`
                //   不会 404，它会命中**另一条**，于是 A 的文字发到 B 那条笔记底下。
                //   UUID 没有这个问题：它不从时间派生，回拨、截断、并发都撞不上。
                const draftId = crypto.randomUUID();
                // gen = 这一次起草的租约凭据。落盘时要对得上才准写（见下面 fin 那段）。
                // 没有它的话，健康检查把我这条判死之后，我回来还能把 failed 改回 pending ——
                // 那说明「判死」根本不是一个可靠的状态转换，将来 failed 一旦可重试就会双花。
                const gen = `${at}#${Math.random().toString(36).slice(2, 10)}`;
                d.drafts = trimDrafts((d.drafts || []).concat([{
                    date: today(), at, draftId, gen, mid: cand.mid, state: 'generating',
                    site: 'xhs', id: cand.note.id, token: cand.note.token || '',
                    from: { who: cand.who, text: cand.text, note: cand.note.title || '' },
                    text: '', model: DRAFT_MODEL,
                }]));
                // ⚠️ mid 进 seen 是在**这里**，不是等起草成功。模型答得再烂这条也算处理过了，
                //   否则失败一次它就一直被重抽，一天的额度全烧在同一条评论上。
                d.seen = (d.seen || []).concat([cand.mid]).slice(-DRAFT_SEEN_KEEP);
                // 额度在**这里**就扣掉 —— 同「先占额度再发」那条理由：模型还没回来就崩掉的话，
                // 钱已经花了，账上不能一笔没有。计数器不跟着 drafts 截断。
                bumpDraftQuota(d);
                return { at, draftId, gen, cand, used };
            });
        } catch (e) {
            return res.status(e.http || 500).json({ ok: false, error: e.message });
        }
        if (!claim) return res.json({ ok: true, none: true, why: '没有需要回的新评论' });

        // ── 第二阶段：调模型（**不持锁**）──────────────
        // 要等几秒，握着锁的话用户在看板上扔一条草稿都得干等。
        let out, err = null;
        try {
            out = await draftOnce({
                system: DRAFT_SYSTEM,
                user: draftUserPrompt(claim.cand),
                model: DRAFT_MODEL,
                maxTokens: 200,
            });
        } catch (e) { err = e; }

        // ── 第三阶段：写结果（持锁，而且**重新读**）──────────────
        // ⚠️ 绝不能拿第一阶段那个 d 写回去 —— 等模型的这几秒里，用户可能已经发了/扔了
        //   另一条草稿，那些改动会被整本盖掉，已发出去的重新变回 pending，
        //   她再点一次就是重复评论。
        const fin = await mutateDrafts(async (d) => {
            const rec = (d.drafts || []).find(x => x.draftId === claim.draftId);
            if (!rec) return { gone: true };          // 被清了，那就算了（活着的不会被截断）
            // ⚠️ 租约核对（CAS）。对不上就**什么都不写**，当作这条已经不归我管：
            //   ① gen 变了 —— 这个 at 上是别人的一次起草，我写进去就是踩别人的结果；
            //   ② state 已经不是 generating —— 我被健康检查判死过（合法请求慢过阈值也会），
            //      或者用户在等模型这几秒里把它扔了。她的操作优先，不许我事后翻回来。
            //   代价是这一次的钱白花（额度已经扣了，账是对的），但状态机保持可信。
            if (rec.gen !== claim.gen || rec.state !== 'generating') return { gone: true };
            if (err) { rec.state = 'failed'; rec.why = err.message; delete rec.token; return { failed: err.message }; }

            const text = draftClean(out.text);
            rec.model = out.model;
            rec.usage = out.usage || null;
            if (!text || draftIsSkip(text)) {
                rec.state = 'skipped'; rec.why = '模型说这条不用回'; delete rec.token;
                return { skipped: true };
            }
            // ⚠️ 草稿也要过 sayCheck，而且是**现在就过**。
            //   等到点发送才发现「里面有用户的名字」的话，她已经对着一条发不出去的草稿
            //   点了好几次，还以为是网络问题。
            rec.state = 'pending'; rec.text = text; rec.bad = sayCheck(text) || '';
            return { draft: draftPublic(rec) };
        });

        const quota = { max: DRAFT_DAILY_MAX, usedToday: claim.used + 1 };
        if (fin.failed) return res.status(500).json({ ok: false, error: fin.failed, quota });
        if (fin.gone) return res.json({ ok: true, none: true, why: '这条草稿在起草期间被清掉了', quota });
        if (fin.skipped) return res.json({ ok: true, skipped: true, why: '模型判断这条不用回', quota });
        res.json({ ok: true, draft: fin.draft, quota });
    });

    // ── 值班员：把某条草稿发出去 ──────────────────────────────────
    //
    // ⚠️⚠️ 这个端点存在的理由是**幂等**（Codex 逮到的重复评论）。
    //   原来是前端自己调 /say、成功了再调 draft-resolve 销账 —— 两个请求，不是一个事务。
    //   中间任何一处断（销账请求失败、/say 的响应在回程丢了、她手快点了两下），
    //   草稿都会留在看板上，她再点一次，**同一条评论就发两遍**。
    //   跨进程锁救不了这个：锁只保证一次一条，不保证同一条不发两次。
    //
    //   所以：发送和销账放进同一把草稿锁里，用草稿的 `at` 当幂等键。
    //   已经是 sent 的直接返回「发过了」，一次都不会再飞出去。
    app.post('/api/social-browser/draft-send', async (req, res) => {
        if (notLocal(req, res)) return;
        const b = req.body || {};
        // ⚠️ 认草稿只认 draftId，**不接受 at 回落**（Codex 三审）。回落一开，
        //   时钟回拨造出的重复时间戳就又能把 A 的文字发到 B 那条笔记底下了。
        //   老看板发来的旧请求会 404 —— 刷新一下就好，而 404 是安全的那一侧。
        const draftId = String(b.draftId || '').trim();
        const text = String(b.text || '').trim();      // 她在框里改过的以她为准
        if (!draftId) return res.status(400).json({ ok: false, error: '要发哪条（缺 draftId）' });
        if (!text) return res.status(400).json({ ok: false, error: '空的，发什么' });

        // 第一步：抢下这条草稿（持锁）。抢到手就立刻标 sending ——
        // 第二个请求进来看到的就不是 pending 了，它会被下面那道幂等闸挡掉。
        let claim;
        try {
            claim = await mutateDrafts(async (d) => {
                const rec = (d.drafts || []).find(x => x.draftId === draftId);
                if (!rec) { const e = new Error('没有这条草稿'); e.http = 404; throw e; }
                if (rec.state === 'sent' && rec.sayState === 'unknown') {
                    const e = new Error('这条发没发出去判不出来，系统不会自动再发，去评论区自己看一眼');
                    e.http = 409; e.unknown = true; throw e;
                }
                if (rec.state === 'sent') { const e = new Error('这条已经发过了'); e.http = 409; e.already = true; throw e; }
                if (rec.state === 'sending') { const e = new Error('这条正在发，别重复点'); e.http = 409; throw e; }
                if (rec.state !== 'pending') { const e = new Error(`这条是「${rec.state}」，不能发`); e.http = 409; throw e; }
                rec.state = 'sending';
                clearDraftError(rec);
                delete rec.sayState;
                delete rec.resolvedAt;
                // sendGen = 这一次发送的租约凭据，和起草那边的 gen 同一个套路。
                // 收尾时要对得上才准写：万一将来给「卡死的 sending」加自愈，
                // 被判死的那次回来就不能再把结果盖到别人的记录上。
                rec.sendGen = `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`;
                // ⚠️ 她在框里改过的正文，**现在就存回 rec.text**。
                //   原来只写 sentText，于是发送确定失败、草稿退回 pending 之后，
                //   看板重新渲染的是 `x.text` —— 模型的原稿。她把 A 改成 B 才点的发送，
                //   回来看到的却又是 A，再点一次就把她明确否掉的 A 发出去了。
                //   （Codex 二审逮到的。）
                rec.text = text;
                rec.bad = sayCheck(text) || '';
                rec.sentText = text.slice(0, 300);
                // ⚠️ token 优先用缓存里的**新的**那个：草稿可能是昨天起的，
                //   存着的 token 那时有效、现在未必。缓存没有才回落到草稿里那份 ——
                //   收件箱给的 token 常常是这条笔记**唯一**的来源（推荐流里刷不到旧笔记），
                //   丢掉它等于「回复收件箱里的评论」这件事又做不到了。
                return { site: rec.site, id: rec.id, sendGen: rec.sendGen, token: getToken(rec.id) || rec.token || '' };
            });
        } catch (e) {
            return res.status(e.http || 500).json({
                ok: false, error: e.message, already: !!e.already, unknown: !!e.unknown,
            });
        }

        // 第二步：真发（不持草稿锁 —— sendComment 有自己那把发送锁）
        let out, err = null;
        try {
            out = await sendComment({ site: claim.site, id: claim.id, text, tok: claim.token });
        } catch (e) { err = e; }

        // 第三步：销账（持锁，重新读）
        // ⚠️ 这一步自己也会失败（拿不到草稿锁、saveDrafts 写不进去），而且**失败也不能抛**
        //   （Codex 三审逮到）：抛出去的话，一条已经真发出去的评论会被报成 500，
        //   记录停在 sending，用户在看板上什么都做不了。评论发出去了就得如实说发出去了，
        //   记账没记上是另一件事，单独说。
        let finErr = null;
        try {
            await mutateDrafts(async (d) => {
                const rec = (d.drafts || []).find(x => x.draftId === draftId);
                if (!rec) return null;
                // ⚠️ 租约核对。对不上就什么都不写 —— 这条已经不归这次发送管了。
                //   （现在唯一能走到「对不上」的路是手工改文件，因为 /draft-resolve 也不许
                //   碰 sending 了。留着是给将来的自愈用：那种功能一加，没有这道闸就会
                //   把结果盖到别人的记录上。起草那边的 gen 是同一个理由。）
                if (rec.state !== 'sending' || rec.sendGen !== claim.sendGen) return null;
                delete rec.sendGen;
                if (err) {
                    // ⚠️ **fail-closed**：只有明确说了「确定没发出去」（notSent）才退回 pending，
                    //   其余一律留在 sent。原来的写法是反着的 —— 看 err.unknown 才判 sent，
                    //   于是任何一个没带标记的错误（比如评论已经发出去了、只是记账那一步
                    //   盘满写失败）都会把草稿放回看板，她再点一次就是第二条评论。
                    //   宁可少发一条（她能看见 error 自己判断），也不能重复发：评论撤不回来。
                    //   （Codex 二审逮到的。）
                    rec.state = err.notSent ? 'pending' : 'sent';
                    rec.error = err.message;
                    // 记成 sent 但其实是「判不出来」的，审计里要照实写，别让历史比事实更笃定。
                    if (err.unknown) rec.sayState = 'unknown';
                    if (rec.state === 'sent') rec.resolvedAt = new Date().toISOString();
                } else {
                    rec.state = 'sent';
                    // ⚠️⚠️ 这里必须**改名**，不能直接抄 r.state。
                    //   r.state 的 'unknown' 是「小红书回的 status 字段不认识」——能走到那一行
                    //   说明 j.data.comment 已经拿到手了，**评论真的发出去了**（见 891 行那三条注释，
                    //   「平台改版把 status 拿掉」正是它设想的情形）。
                    //   而 err.unknown 的 'unknown' 是「发没发出去判不出来」。两者语义相反却撞同一个字符串。
                    //   不改名的话 /draft-recheck 会把一条**真发出去的**评论放回待发列表，而用户按提示
                    //   去评论区根本看不到它（status 缺失的评论多半正在审核，886 行实测过自己都看不见），
                    //   于是她点一下就是第二条评论 —— 整套 fail-closed 防的就是这个。
                    rec.sayState = out.r.state === 'unknown' ? 'submitted?' : out.r.state;
                    rec.resolvedAt = new Date().toISOString();
                    clearDraftError(rec);
                }
                // 到终态就把 token 删掉；唯一例外是 sent + unknown：它现在能由用户亲自
                // 确认没发出去后退回 pending，还得靠这份 token 再发。其余终态照旧不留。
                if (rec.state !== 'pending' && rec.sayState !== 'unknown') delete rec.token;
                return null;
            });
        } catch (e) {
            finErr = e;
            console.error('[值班员] 草稿收尾没写进去（记录会停在 sending）：', e.message);
        }

        if (err) {
            return res.status(err.http || 500).json({
                ok: false, error: err.message, unknown: !!err.unknown,
                ...(finErr ? { bookkeeping: '而且草稿账也没记上，这条会停在「正在发」' } : {}),
            });
        }
        res.json({
            ok: true, ...out.r, quota: { max: SAY_DAILY_MAX, usedToday: out.used + 1 },
            // 评论确实发出去了，所以是 ok:true；但账没记上要说出来，
            // 否则她只会看到那条草稿一直卡在「正在发」而不知道为什么。
            ...(finErr ? { bookkeeping: '评论已经发出去了，但草稿账没记上，这条会停在「正在发」' } : {}),
        });
    });

    // 人工确认「没发出去」后，把 fail-closed 的 unknown 记录退回待发。
    // ⚠️ 单独开端点，不借 /draft-resolve：后者仍然只许扔 pending，绝不能凭空标 sent。
    app.post('/api/social-browser/draft-recheck', async (req, res) => {
        if (notLocal(req, res)) return;
        const b = req.body || {};
        const draftId = String(b.draftId || '').trim();
        const action = String(b.action || '');
        try {
            const out = await mutateDrafts(async (d) => {
                // 五道闸全在同一把草稿锁里：校验 action、按 id 找、核对 state、核对
                // sayState、确认没有未收尾的发送租约。任何一项不对都不碰记录。
                if (action !== 'notsent') {
                    const e = new Error(`action 当前是「${action || '空'}」，这里只接受 notsent`);
                    e.http = 400; throw e;
                }
                const rec = (d.drafts || []).find(x => x.draftId === draftId);
                if (!rec) { const e = new Error(`没有这条草稿（draftId: ${draftId || '空'}）`); e.http = 404; throw e; }
                if (rec.state !== 'sent' || rec.sayState !== 'unknown') {
                    const e = new Error(`这条当前是 state「${rec.state || '空'}」/ sayState「${rec.sayState || '空'}」，只有 sent + unknown 能退回草稿`);
                    e.http = 409; throw e;
                }
                if (rec.sendGen) {
                    const e = new Error('这条当前是 state「sent」/ sayState「unknown」，但仍有 sendGen 发送租约，不能人工处置');
                    e.http = 409; throw e;
                }
                rec.state = 'pending';
                delete rec.sayState;
                delete rec.error;
                delete rec.resolvedAt;
                rec.recheckedAt = new Date().toISOString();
                rec.recheckedFrom = 'unknown';
                return draftPublic(rec);
            });
            res.json({ ok: true, draft: out });
        } catch (e) {
            res.status(e.http || 500).json({ ok: false, error: e.message });
        }
    });

    // 扔掉一条草稿。**只改草稿本子**，不发、不撤。
    // ⚠️ 这里不接受 action:'sent' —— 「发过了」只能由 /draft-send 在真发完之后自己写。
    //   让前端能凭空标 sent 的话，那个幂等键就等于没有（谁都能把它标掉再重发）。
    app.post('/api/social-browser/draft-resolve', async (req, res) => {
        if (notLocal(req, res)) return;
        const b = req.body || {};
        const draftId = String(b.draftId || '').trim();
        if (String(b.action || '') !== 'dropped') {
            return res.status(400).json({ ok: false, error: 'action 只能是 dropped（发送走 /draft-send）' });
        }
        try {
            const out = await mutateDrafts(async (d) => {
                const rec = (d.drafts || []).find(x => x.draftId === draftId);
                if (!rec) { const e = new Error('没有这条草稿'); e.http = 404; throw e; }
                if (rec.state === 'sent') {
                    const e = new Error(rec.sayState === 'unknown'
                        ? '这条发没发出去判不出来，系统不会自动再发，去评论区自己看一眼'
                        : '这条已经发出去了，扔不掉');
                    e.http = 409; throw e;
                }
                // ⚠️ **正在飞的也扔不掉**。原来只挡 sent，于是：桌面点了发送（草稿变
                //   sending、请求在飞），手机上那块还没刷新的看板点「扔了」—— 接受了，
                //   界面明说「扔了」，可外面那条评论照样会发出去。她被界面骗了。
                //   反过来也一样：发送确定失败时收尾会把 dropped 翻回 pending，
                //   等于把她扔掉的草稿又捡回来。（Codex 二审逮到的。）
                //   看板本来就只列 pending，所以这道闸不会误伤正常操作。
                if (rec.state !== 'pending') {
                    const e = new Error(rec.state === 'sending'
                        ? '这条正在发，扔不掉（等它发完再看结果）'
                        : `这条是「${rec.state}」，不用扔`);
                    e.http = 409; throw e;
                }
                rec.state = 'dropped';
                rec.resolvedAt = new Date().toISOString();
                delete rec.token;   // 终态，短命凭据不留
                return draftPublic(rec);
            });
            res.json({ ok: true, draft: out });
        } catch (e) {
            res.status(e.http || 500).json({ ok: false, error: e.message });
        }
    });
    console.log(`[窗] 浏览器通道已挂载（专用 Chrome :${PORT}，能说话的站：${[...SAY_ALLOWED_SITES].join('/') || '（无）'}）`);
}

module.exports = {
    mountSocialBrowser,
    // 导出给测试用 —— 闸是这件事里最要紧的部分，必须能单独验。
    // Codex 那一轮的教训之一：安全断言写成「源码里有没有这个正则」是廉价的，
    // 改坏了照样绿。能跑的就得跑，所以把判据函数本身都导出来。
    // 借登录态读推荐流。server.js 的 xhsFeed 先问它，回 null 才退回游客流。
    xhsExploreFeeds,
    // xhsFeed 在「浏览器没跑」时不阻塞地把它拉起来，下一次 [[GAZE: xhs]] 就是她的号。
    ensureChrome, chromeAlive, touchChrome,
    // 端口要**只有一个来源**：server.js 那边给 playwright MCP 配 --cdp-endpoint 时
    // 如果自己再读一次 GRANCYAN_CHROME_PORT，她哪天改了环境变量就会两边对不上 ——
    // 而症状是「浏览器工具连不上」，看着完全像 MCP 坏了。
    CHROME_PORT: PORT,
    sayCheck, sayNormalize, SAY_FORBIDDEN, SAY_LINKISH, SAY_DAILY_MAX, SAY_MAX_LEN,
    SAY_ALLOWED_SITES, SAY_SENDERS, SAY_COUNTS, saysToday, originOk, withSayLock, intEnv,
    healStaleSending, SENDING_STALE_MS, decideSayOutcome, STATE_FILE,
    // 收件箱。解析和差分抽成纯函数就是为了能脱离浏览器跑 —— 同 decideSayOutcome 那条：
    // 「私信最后一句是谁讲的判不出来」这种语义，源码正则守不住，只能拿数据喂进去验。
    inboxParse, inboxDiff, inboxNoteFailure, loadInbox, xhsInboxPoll, INBOX_FILE, INBOX_POLL_MIN,
    // 值班员起草。同上：挑谁来回、话怎么收拾，这两件事错了都是「对着不该说话的地方
    // 说了话」，必须拿数据喂进去验，不能靠读源码放心。
    draftCandidates, draftUserPrompt, draftClean, draftIsSkip, draftRedact, DRAFT_SYSTEM,
    DRAFT_MODEL, DRAFT_DAILY_MAX, DRAFT_FILE, loadDrafts, draftsToday,
    draftQuotaUsed, bumpDraftQuota,
    DRAFT_KEEP, DRAFT_SEEN_KEEP, DRAFT_LIVE_MAX, healStaleGenerating, withFileLock,
    mergeSpans, GENERATING_STALE_MS,
    shouldCloseIdleChrome, CHROME_IDLE_MS, CHROME_GRACE_MS,
    clearHistory, HISTORY_FILES,
    withChromeBusy, chromeIdleState,
};
