/* 设置那一行别反复整包下载（2026-10-11 exceed_egress_quota）。
 *
 * profiles.settings 一行 4MB+，以前每次 save 推之前、每次开点歌面板都整包拉一遍，
 * 一天 310 次 ≈ 1.3GB，把 Supabase 免费档 5GB/月的出口流量吃爆、整个项目被停。
 * 现在 fetchCloudSettings 先只问 updated_at，没变就用内存里那份。这里守住：
 *   · 云端没动 → 只发一个小请求，拿到的内容和云端一致
 *   · 另一台推过（updated_at 变了）→ 必须整包拉到新的，绝不能拿旧缓存去合并
 *   · 自己推完 → 下一次不用把刚推的再下载回来
 *   · 旧 server 不认 ?select= → 退回整包，只拉一次
 *   · 调用方改了拿到的对象，不能把缓存改脏
 *
 * 真跑的是 js/01-core.js 里的原函数（vm 抽段），fetch / supabaseClient 是假的，碰不到网。
 * 跑法：node tests/cloud-settings-cache.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readSingleSrc } = require('./_src-map');

const ROOT = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'js/01-core.js'), 'utf8');
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const from = core.indexOf('function cloudError(');
const to = core.indexOf('function stripNullBytes(');
if (from < 0 || to < 0) throw new Error('云同步 helper 段锚点变了');
const strip = core.indexOf('async function rawUpsertChats(');
if (strip < 0) throw new Error('stripNullBytes 段锚点变了');

// 假云端：Postgres 回 timestamptz 的样子是 +00:00，不是 Z —— 比较必须按时间值比，不能按字符串比
const pgTs = d => new Date(d).toISOString().replace('Z', '+00:00');
const cloud = { settings: { a: 1, big: 'x'.repeat(1000) }, updated_at: pgTs('2026-10-11T01:00:00.123Z') };
let oldServer = false;      // 模拟还没更新的 server：不认 ?select=
let reqs = [];
const resp = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
let down = false;           // 模拟断网：中转连不上，直连也 503
function fakeFetch(url, opts = {}) {
  if (down) return Promise.reject(new Error('Failed to fetch'));
  const u = new URL(url);
  if ((opts.method || 'GET') === 'GET') {
    const sel = oldServer ? 'settings' : (u.searchParams.get('select') || 'settings');
    reqs.push(sel);
    const row = {};
    for (const k of sel.split(',')) row[k] = JSON.parse(JSON.stringify(cloud[k]));
    return Promise.resolve(resp(200, [row]));
  }
  const body = JSON.parse(opts.body);
  reqs.push('POST');
  cloud.settings = body.settings;
  cloud.updated_at = pgTs(body.updated_at);
  return Promise.resolve(resp(201, { ok: true }));
}
let uid = 'u1';
const sandbox = {
  console, JSON, Number, String, Object, Array, Date, Promise, Error, URL,
  navigator: { onLine: true },
  setTimeout, clearTimeout, AbortController,
  SERVER_BASE: 'http://127.0.0.1:9',
  SUPABASE_ANON_KEY: 'anon',
  fetch: fakeFetch,
  supabaseClient: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: uid } } } }) },
    from() {
      if (!down) throw new Error('不该走到直连');
      return { select: cols => ({ single: async () => { reqs.push('direct:' + cols); return { data: null, error: { message: 'down', status: 503 } }; } }) };
    },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(core.slice(from, strip)
  + '\nthis.fetchCloudSettings = fetchCloudSettings; this.pushCloudSettings = pushCloudSettings;', sandbox);
const { fetchCloudSettings, pushCloudSettings } = sandbox;

(async () => {
  // ① 冷启动：没缓存，整包拉一次
  reqs = [];
  let r = await fetchCloudSettings();
  t('第一次：整包拉（settings,updated_at），只一个请求', reqs.join('|') === 'settings,updated_at', reqs.join('|'));
  t('第一次拿到的就是云端那份', !r.error && r.data.settings.a === 1);

  // ② 云端没动：只问 updated_at
  reqs = [];
  r = await fetchCloudSettings();
  t('★ 云端没动：只发 select=updated_at 那个小请求', reqs.join('|') === 'updated_at', reqs.join('|'));
  t('没动时给的内容和云端一致', !r.error && JSON.stringify(r.data.settings) === JSON.stringify(cloud.settings));

  // ③ 调用方在拿到的对象上改，不能改脏缓存
  r.data.settings.a = 999;
  r = await fetchCloudSettings();
  t('调用方改了拿到的对象，下次拿到的还是干净的', r.data.settings.a === 1);

  // ④ 另一台推过：updated_at 变了 → 必须整包拉新的
  cloud.settings = { a: 2, fromOther: true };
  cloud.updated_at = pgTs('2026-10-11T02:00:00.000Z');
  reqs = [];
  r = await fetchCloudSettings();
  t('★ 另一台推过：先问时间，对不上再整包拉', reqs.join('|') === 'updated_at|settings,updated_at', reqs.join('|'));
  t('★ 拿到的是另一台推的新内容，不是旧缓存', r.data.settings.a === 2 && r.data.settings.fromOther === true);

  // ⑤ 自己推完：下一次不用把刚推的再下载回来（Date 对象推上去，云端回 +00:00 字符串，也要认得是同一刻）
  reqs = [];
  await pushCloudSettings({ id: uid, settings: { a: 3, mine: 'yes' }, updated_at: new Date('2026-10-11T03:00:00.456Z') });
  r = await fetchCloudSettings();
  t('★ 自己刚推完：下一次只问时间', reqs.join('|') === 'POST|updated_at', reqs.join('|'));
  t('自己推完拿到的就是刚推的那份', r.data.settings.a === 3 && r.data.settings.mine === 'yes');

  // ⑥ 换了账号：缓存不能串到别人身上
  uid = 'u2';
  reqs = [];
  await fetchCloudSettings();
  t('换账号：不用上一个账号的缓存，整包拉', reqs.join('|') === 'settings,updated_at', reqs.join('|'));
  uid = 'u1';

  // ⑦ 旧 server 不认 ?select=：问时间的那一下就整包回来了，直接用，不再拉第二遍
  oldServer = true;
  await pushCloudSettings({ id: uid, settings: { a: 5 }, updated_at: new Date('2026-10-11T04:00:00.000Z') });  // 推完有缓存 → 下一次会走「问时间」
  cloud.settings = { a: 4 };                 // 另一台改了（旧 server 下照样得看见）
  reqs = [];
  r = await fetchCloudSettings();
  t('旧 server：问时间那一下整包回来了，只拉一遍', reqs.join('|') === 'settings', reqs.join('|'));
  t('旧 server：内容照样是最新的', r.data.settings.a === 4);
  reqs = [];
  r = await fetchCloudSettings();
  t('旧 server：之后每次也只拉一遍整包（跟改之前一样，不更费）', reqs.join('|') === 'settings' && r.data.settings.a === 4, reqs.join('|'));
  oldServer = false;

  // ⑦½ 断网：问时间那一下就失败了 → 直接把错误交出去，别再整包拉一遍白等
  await fetchCloudSettings();                // 新 server 下重新建好缓存（旧 server 那段把它清掉了）
  down = true;
  reqs = [];
  r = await fetchCloudSettings();
  t('断网：问时间失败就直接返回错误，不再试整包', !!r.error && reqs.join('|') === 'direct:updated_at', reqs.join('|'));
  down = false;

  // ⑧ server 端白名单：?select= 只认那三种，别的一律退回 settings（不让人拿这个参数拼任意查询）
  const server = readSingleSrc('cloud').text;
  const at = server.indexOf("app.get('/api/cloud-profile'");
  const fnAt = server.indexOf('async (req, res) => {', at);
  let i = server.indexOf('{', fnAt), d = 0, end = -1;
  for (let j = i; j < server.length; j++) {
    if (server[j] === '{') d++;
    else if (server[j] === '}' && --d === 0) { end = j + 1; break; }
  }
  const handler = server.slice(fnAt, end);
  t('cloud-profile GET handler 抠得出来', at >= 0 && end > fnAt);
  async function hit(select) {
    let seen = null;
    const axios = { get: async url => { seen = url; return { status: 200, data: [] }; } };
    const fn = new Function('axios', 'outboundAgent', 'SUPABASE_URL', 'return ' + handler)(axios, async () => null, 'https://sb');
    const res = { status() { return res; }, json() { return res; } };
    await fn({ headers: { authorization: 'Bearer x', apikey: 'k' }, query: select === undefined ? {} : { select } }, res);
    return seen;
  }
  t('server：select=updated_at 照转', (await hit('updated_at')) === 'https://sb/rest/v1/profiles?select=updated_at');
  t('server：select=settings,updated_at 照转', (await hit('settings,updated_at')) === 'https://sb/rest/v1/profiles?select=settings,updated_at');
  t('server：不带 select 还是 settings（老前端照旧能用）', (await hit(undefined)) === 'https://sb/rest/v1/profiles?select=settings');
  t('server：白名单外的 select 退回 settings', (await hit('*,id&or=(x)')) === 'https://sb/rest/v1/profiles?select=settings');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
