/* 云对话(/api/cloud-chats) / 云文件(/api/cloud-file) 中转的最小冒烟。
 *
 * 这条线管的是用户的真实数据（对话云备份），方案原文点名"管数据的裸奔最危险"
 * （docs/server-split-plan.md Phase 1 收尾块）。/api/cloud-profile 已经有
 * cloud-profile-retry.test.js 守着，这里补上一直裸奔的 cloud-chats 和 cloud-file。
 *
 * ⚠️ 绝对不许打真 Supabase，所以这里只测「在任何网络调用之前就 return」的分支
 * （缺 Authorization/apikey、cloud-file 的 path 校验），而且刻意**不给 axios /
 * outboundAgent 任何实现**：真正抠出来跑的是 server/cloud.js 里的原函数体。
 * 这不是"再加一层 mock 记录调用次数"式的自证——因为 axios 在这个执行环境里
 * 根本不存在，所以不管校验分支挡没挡住，都物理上碰不到真的网络请求。
 * 万一哪天校验被误删、代码真摸到了网络调用那一行，也不会真的发出请求：
 * handler 自己的 try/catch 会接住 "axios is not defined" 这个 ReferenceError，
 * 变成一个 502——跟期望的 401/400 对不上，断言照样红，只是红得干净（能看见
 * "axios is not defined" 这行字），不是红得吓人（一段没人看的堆栈）。
 * 手测过这条防线：真的把某个 handler 的校验砍掉再跑，得到的是清楚的
 * "实得 status=502 body={"error":"axios is not defined"}"，不是误报通过。
 *
 * 跑法：node tests/cloud-chats-file.test.js
 */
const { readSingleSrc } = require('./_src-map');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const server = readSingleSrc('cloud').text;

// 从 server/cloud.js 里把某条路由的 handler 函数体原样抠出来（配对花括号，不手抄）。
function balanced(s, from) {
  let i = s.indexOf('{', from), d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(from, j + 1);
  }
  return null;
}
function extractHandler(marker) {
  const at = server.indexOf(marker);
  if (at < 0) return null;
  const fnAt = server.indexOf('async (req, res) => {', at);
  if (fnAt < 0) return null;
  return balanced(server, fnAt);
}

const chatsGet   = extractHandler("app.get('/api/cloud-chats'");
const chatsPost  = extractHandler("app.post('/api/cloud-chats'");
const fileGet    = extractHandler("app.get('/api/cloud-file'");
const filePost   = extractHandler("app.post('/api/cloud-file'");

t('四个 handler 都抠得出来（抠不出来下面全是空跑）',
  !!chatsGet && !!chatsPost && !!fileGet && !!filePost);

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = c => { res.statusCode = c; return res; };
  res.json = j => { res.body = j; return res; };
  res.send = j => { res.body = j; return res; };
  res.set = () => res;
  return res;
}

// 故意不注入 axios / outboundAgent —— 见文件头注释。命中网络调用行会抛
// ReferenceError，多数情况下会被 handler 自己的 catch 接住变成 502（断言就按
// "状态码不对"红掉）；万一某条 handler 改得没有 catch 了，异常会从这里
// 原样抛给调用方，checkGuard 会按"跑崩了"报错——两条路都到不了真实网络。
function run(handlerSrc, req) {
  const fn = new Function('return ' + handlerSrc)();
  const res = makeRes();
  return Promise.resolve(fn(req, res)).then(() => res);
}

async function checkGuard(name, handlerSrc, req, wantStatus, wantBody) {
  try {
    const res = await run(handlerSrc, req);
    const ok = res.statusCode === wantStatus &&
      Object.keys(wantBody).every(k => JSON.stringify(res.body && res.body[k]) === JSON.stringify(wantBody[k]));
    t(name, ok, ok ? '' : `实得 status=${res.statusCode} body=${JSON.stringify(res.body)}`);
  } catch (e) {
    // 摸到了没注入的 axios/outboundAgent，或者别的什么意外 —— 都算校验分支没守住
    t(name, false, `跑崩了（多半是校验分支没挡住，摸到了网络调用）：${e.message}`);
  }
}

(async () => {

console.log('\n[cloud-chats] 缺 auth/apikey 直接 401，不摸网络');
await checkGuard('GET /api/cloud-chats 缺 auth+apikey → 401',
  chatsGet, { headers: {}, query: {}, body: {} },
  401, { error: '缺少 Authorization / apikey' });
await checkGuard('POST /api/cloud-chats 缺 auth+apikey → 401',
  chatsPost, { headers: {}, query: {}, body: {} },
  401, { error: '缺少 Authorization / apikey' });
await checkGuard('GET /api/cloud-chats 只给 auth 不给 apikey → 401',
  chatsGet, { headers: { authorization: 'Bearer x' }, query: {}, body: {} },
  401, { error: '缺少 Authorization / apikey' });
await checkGuard('POST /api/cloud-chats 只给 apikey 不给 auth → 401',
  chatsPost, { headers: { apikey: 'k' }, query: {}, body: {} },
  401, { error: '缺少 Authorization / apikey' });

console.log('\n[cloud-file] 缺 auth/apikey 直接 401，不摸网络（排在 path 校验之前）');
await checkGuard('GET /api/cloud-file 缺 auth+apikey → 401（哪怕 path 合法）',
  fileGet, { headers: {}, query: { path: 'a.png' }, body: {} },
  401, { error: '缺少 Authorization / apikey' });
await checkGuard('POST /api/cloud-file 缺 auth+apikey → 401（哪怕 path 合法）',
  filePost, { headers: {}, query: { path: 'a.png' }, body: {} },
  401, { error: '缺少 Authorization / apikey' });

console.log('\n[cloud-file] path 越界/非法直接 400，不摸网络');
const authed = p => ({ headers: { authorization: 'Bearer x', apikey: 'k' }, query: { path: p }, body: {} });
// '..'/'../secret'/'a/../../etc/passwd' 是路径穿越；'a b' 带空格不在允许字符集里；
// '' 是空 path —— 五个都必须在摸到 axios 之前被 400 挡下。
for (const bad of ['../secret', 'a/../../etc/passwd', '..', 'a b', '']) {
  await checkGuard(`GET /api/cloud-file path=${JSON.stringify(bad)} → 400 path 非法`,
    fileGet, authed(bad), 400, { error: 'path 非法' });
  await checkGuard(`POST /api/cloud-file path=${JSON.stringify(bad)} → 400 path 非法`,
    filePost, authed(bad), 400, { error: 'path 非法' });
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

})().catch(e => { console.error('💥 测试文件本身炸了：', e); process.exit(1); });
