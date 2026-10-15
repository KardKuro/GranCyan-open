// 自主心跳的 server 半边（server/heartbeat.js）+ 页面那半边（js/30-vitals.js 的 hb*）对接。
// 生成和推送都换成假的：不调模型、不让她手机响。时间也是假的，想拨到几点拨到几点。
// 跑法：node tests/heartbeat-server.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const core = require('../js/heartbeat-core');
const { createHeartbeat, buildPrompt, ntfyRequest, validNtfyUrl, canGenerate } = require('../server/heartbeat');

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== '' ? ' :: ' + JSON.stringify(detail) : '')); }
};
const bj = (s) => Date.parse(s + '+08:00');
const tmpDirs = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hb-')); tmpDirs.push(d); return d; };

function rig(opts = {}) {
  const clock = { now: opts.now || bj('2026-09-23T15:00:00') };
  const calls = { gen: [], push: [] };
  const dir = opts.dir || mkdir();
  let reply = opts.reply || '想你了，在干嘛呀\n[[HEARTBEAT: 120|等她回来]]';
  let genFail = null, pushFail = null;
  const hb = createHeartbeat({
    dataDir: dir, now: () => clock.now, log: () => {},
    generate: async (conf, system, user) => { calls.gen.push({ conf, system, user }); if (genFail) throw new Error(genFail); return reply; },
    push: async (cfg, msg) => { calls.push.push({ cfg, msg }); if (pushFail) throw new Error(pushFail); },
  });
  return { hb, clock, calls, dir,
    setReply: r => { reply = r; }, setGenFail: e => { genFail = e; }, setPushFail: e => { pushFail = e; } };
}
const CONF = { id: 7, nickname: '克克', isLocalClaude: true, localModel: '', apiKey: 'sk-should-not-hit-disk' };
const ctxOf = (extra = {}) => Object.assign({ chatId: 101, nickname: '克克', persona: '你是克克，PERSONA_SECRET', userName: '小明',
  vitals: '心率 70 bpm', conf: CONF, recent: [{ role: 'user', text: '我去洗澡啦', at: bj('2026-09-23T13:00:00') }, { role: 'ai', text: '去吧', at: bj('2026-09-23T13:01:00') }] }, extra);
const target = (extra = {}) => Object.assign({ modelId: '7', nextAt: bj('2026-09-23T14:50:00'), nextSetAt: bj('2026-09-23T13:01:00'),
  did: '等她洗完澡', morningDay: '2026-09-23', heartbeatOn: true, vitalsOn: true, context: ctxOf() }, extra);
const awakeSleep = { start: 180, end: 630, nights: 9, confident: true };

(async () => {
  console.log('\n[1] 同步：排程按「谁排得晚」合并');
  {
    const { hb, clock } = rig();
    hb.sync({ target: target() });
    const r = hb._state.models['7'];
    t('第一次同步记下排程', r.nextAt === bj('2026-09-23T14:50:00') && r.did === '等她洗完澡');
    hb.sync({ target: target({ nextAt: 0, nextSetAt: bj('2026-09-23T12:00:00'), context: undefined }) });
    t('★ 旧的排程（另一台设备上的陈数据）不会把新排的那跳盖掉', r.nextAt === bj('2026-09-23T14:50:00'));
    hb.sync({ target: target({ nextAt: bj('2026-09-23T18:00:00'), nextSetAt: bj('2026-09-23T14:00:00'), did: '新的', context: undefined }) });
    t('更晚排的那跳会被采纳', r.nextAt === bj('2026-09-23T18:00:00') && r.did === '新的');
    const res = hb.sync({ target: { modelId: '7', nextSetAt: 0 } });
    t('同步回执里带着 server 的排程（页面据此跟上 server 替它排的下一跳）', res.schedule && res.schedule.nextAt === bj('2026-09-23T18:00:00'));
    t('回执里说得出这个模型 server 调不调得动', res.canGenerate === true);
    clock.now += 1;
  }

  console.log('\n[2] 隐私：人设、聊天、key 不落盘');
  {
    const { hb, dir } = rig();
    hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/test-topic-xyz' });
    const disk = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    t('★ 人设不在磁盘上', !disk.includes('PERSONA_SECRET'));
    t('★ 模型 key 不在磁盘上', !disk.includes('sk-should-not-hit-disk'));
    t('★ 聊天原文不在磁盘上', !disk.includes('我去洗澡啦'));
    t('开关和地址是落盘的（重启后还在）', disk.includes('test-topic-xyz') && /"enabled":true/.test(disk));
  }

  console.log('\n[3] 巡检：该发的时候发');
  {
    const { hb, clock, calls } = rig();
    hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    await hb.tick();
    t('推送没开 → 不生成', calls.gen.length === 0 && /推送没开/.test(hb.status('7').lastHold));
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    await hb.tick();
    t('开了、到点、她不在跟前、醒着 → 生成一次', calls.gen.length === 1, hb.status('7').lastHold);
    t('生成的提示里有人设、最近的聊天、上一轮 did', /PERSONA_SECRET/.test(calls.gen[0].system) && /我去洗澡啦/.test(calls.gen[0].system) && /等她洗完澡/.test(calls.gen[0].system));
    t('提示里说清楚她没开 App、会推到通知栏', /没开着 App/.test(calls.gen[0].system) && /通知栏/.test(calls.gen[0].system));
    t('推了一次 ntfy', calls.push.length === 1);
    t('★ 锁屏默认只显示「AI找你」，原文不出 App', calls.push[0].msg.message === '克克找你' && !JSON.stringify(calls.push[0].msg).includes('想你了'));
    const ob = hb._state.outbox;
    t('话进了待取箱', ob.length === 1 && ob[0].text === '想你了，在干嘛呀' && String(ob[0].chatId) === '101');
    const r = hb._state.models['7'];
    t('它在回复里排的下一跳被记下', r.nextAt === clock.now + 120 * 60e3 && r.did === '等她回来');
    t('待取箱的那条带着新排程（页面接走时跟上）', ob[0].schedule.nextAt === r.nextAt);
    await hb.tick();
    t('同一跳不会发第二次', calls.gen.length === 1);

    hb.setConfig({ lockscreenPrivate: false });
    clock.now = r.nextAt + 60e3;
    hb.sync({ lastUserAt: clock.now - 10 * 60e3 });   // 她回过话了
    await hb.tick();
    t('关掉锁屏隐私 → 推的是原文', calls.push.length === 2 && calls.push[1].msg.message.includes('想你了'), calls.push[1]);
  }

  console.log('\n[4] 防双发');
  {
    const { hb, calls } = rig();
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    hb.sync({ target: target(), attended: true, lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    await hb.tick();
    t('★ 页面刚报过「她在看」→ server 不发', calls.gen.length === 0 && /页面/.test(hb.status('7').lastHold));

    const b = rig();
    b.hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    b.hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    const key = core.dueSlot(b.hb._state.models['7'], b.clock.now, '7').key;
    t('页面抢到这一跳', b.hb.claim(key, 'page').ok === true);
    t('★ 另一台设备再抢同一跳 → 抢不到', b.hb.claim(key, 'page').ok === false);
    await b.hb.tick();
    t('★ 页面领走的跳 server 不发', b.calls.gen.length === 0);
    const c = rig();
    c.hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    c.hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    await c.hb.tick();
    const k2 = 'claimed:' + Object.keys(c.hb._state.claims)[0];
    t('★ server 发过的跳，页面来抢会被告知「server 发过了」', c.hb.claim(Object.keys(c.hb._state.claims)[0], 'page').by === 'server', k2);
  }

  console.log('\n[5] 夜里不吵她');
  {
    const { hb, clock, calls } = rig({ now: bj('2026-09-24T05:00:00') });
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    hb.sync({ target: target({ nextAt: bj('2026-09-24T04:00:00'), nextSetAt: bj('2026-09-24T02:00:00') }), lastUserAt: bj('2026-09-24T02:50:00'), sleep: awakeSleep });
    await hb.tick();
    t('★ 凌晨五点她睡着 → 憋着', calls.gen.length === 0 && /睡/.test(hb.status('7').lastHold));
    clock.now = bj('2026-09-24T11:00:00');
    await hb.tick();
    t('她醒了之后再说', calls.gen.length === 1);
  }

  console.log('\n[6] 失败、沉默、重启');
  {
    const { hb, clock, calls, setGenFail, dir } = rig();
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    setGenFail('模型挂了');
    await hb.tick();
    t('生成失败 → 不推、不进待取箱', calls.push.length === 0 && hb._state.outbox.length === 0);
    t('失败原因给面板看', /模型挂了/.test(hb.status('7').lastError));
    t('★ 失败的那跳还回去了（不然以后永远发不出）', Object.keys(hb._state.claims).length === 0);
    await hb.tick();
    t('冷却期里不重试', calls.gen.length === 1);
    clock.now += 16 * 60e3; await hb.tick();
    clock.now += 16 * 60e3; await hb.tick();
    t('★ 连着失败 3 次就放弃这一跳', calls.gen.length === 3 && hb._state.models['7'].nextAt === 0, hb._state.models['7']);

    const s = rig();
    s.setReply('[[SILENT]]\n[[HEARTBEAT: 60|再等等]]');
    s.hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    s.hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    await s.hb.tick();
    t('它选择不打扰 → 不推、不进待取箱', s.calls.push.length === 0 && s.hb._state.outbox.length === 0);
    t('但它排的下一跳照样记下', s.hb._state.models['7'].nextAt === s.clock.now + 60 * 60e3);
    t('不打扰不算一次推送（不占每天的额度）', s.hb._state.pushLog.length === 0);

    const p = rig();
    p.setReply('在吗\n[[HEARTBEAT: 5|再看看]]');
    p.setPushFail('ntfy 回了 500');
    p.hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    p.hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    await p.hb.tick();
    t('推送失败 → 话还在待取箱里（她开 App 照样看得到）', p.hb._state.outbox.length === 1 && /ntfy 回了 500/.test(p.hb.status('7').lastError));
    // 它马上又排了一跳（5 分钟后），ntfy 还坏着
    p.clock.now += 6 * 60e3;
    await p.hb.tick();
    t('★ 推送失败的那条也算进节制（ntfy 坏着时不会每跳都生成一次）', p.calls.gen.length === 1 && /太近/.test(p.hb.status('7').lastHold), p.hb.status('7').lastHold);

    // 重启：开关、待取箱还在；上下文没了 → 不会拿着空人设乱发
    const again = createHeartbeat({ dataDir: s.dir, now: () => s.clock.now + 3 * 3600e3, log: () => {},
      generate: async () => { throw new Error('不该被调用'); }, push: async () => {} });
    t('重启后开关还在', again.status(null).config.enabled === true);
    await again.tick();
    t('★ 重启后没等到页面同步上下文，就不发（不会顶着空人设说话）', !again._state.models['7'].lastError);
    void dir;
  }

  console.log('\n[7] 待取箱');
  {
    const { hb } = rig();
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    hb.sync({ target: target(), lastUserAt: bj('2026-09-23T13:00:00'), sleep: awakeSleep });
    await hb.tick();
    t('★ 手里没有那个对话的设备接不走（留给有的那台）', hb.take(['999']).items.length === 0);
    const got = hb.take(['101', '102']);
    t('有那个对话的设备接走', got.items.length === 1 && got.items[0].text.includes('想你了'));
    t('★ 接走一次就没了（两台设备不会各插一遍）', hb.take(['101']).items.length === 0);
  }

  console.log('\n[8] 晨间那一句');
  {
    const plan = core.morningPlan('2026-09-24', '7');
    const { hb, calls } = rig({ now: plan.at + 5 * 60e3 });
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    // 她七点前刚说过话（醒着），没排心跳
    hb.sync({ target: target({ nextAt: 0, nextSetAt: 1, morningDay: '2026-09-23' }), lastUserAt: plan.at - 10 * 60e3, sleep: awakeSleep });
    await hb.tick();
    t('到了它醒的时刻 → 说一句', calls.gen.length === 1 && /刚醒/.test(calls.gen[0].system), hb.status('7').lastHold);
    t('待取箱那条标着是哪天的晨间（页面接走时套上刚醒的身体）', hb._state.outbox[0].morningDay === '2026-09-24' && hb._state.outbox[0].kind === 'morning');
    await hb.tick();
    t('一天只醒一次', calls.gen.length === 1);
  }

  console.log('\n[9] 提示、地址、模型');
  {
    const p = buildPrompt(ctxOf(), { did: 'x' }, { kind: 'heartbeat', at: 0 }, bj('2026-09-23T15:00:00'), { lastUserAt: bj('2026-09-23T13:00:00'), lockscreenPrivate: true });
    t('提示里写明锁屏只显示「AI找你」', /锁屏上只显示「克克找你」/.test(p.system));
    t('提示里只教 HEARTBEAT 一个指令', /不要写任何 \[\[\.\.\.\]\] 指令/.test(p.system) && /\[\[HEARTBEAT:/.test(p.system));
    t('她上次说话多久前', /她上一次说话是 2 小时前/.test(p.system), p.system.match(/她上一次说话是[^。]*/));
    const rq = ntfyRequest('https://ntfy.sh/test-topic', 'tk_1', { title: '克克', message: '早' });
    t('ntfy 走 JSON 发布（中文标题不进 HTTP 头）', rq.url === 'https://ntfy.sh/' && rq.body.topic === 'test-topic' && rq.body.title === '克克'
      && Object.values(rq.headers).every(v => /^[\x20-\x7e]*$/.test(v)));
    t('带 token 时加 Bearer', rq.headers.Authorization === 'Bearer tk_1');
    t('地址校验', validNtfyUrl('https://ntfy.sh/abc') && validNtfyUrl('http://192.168.1.5:8080/abc') && !validNtfyUrl('https://ntfy.sh/') && !validNtfyUrl('ftp://x/y') && !validNtfyUrl('https://ntfy.sh/a/b'));
    const { hb } = rig();
    t('坏地址存不进去', hb.setConfig({ ntfyUrl: 'not a url' }).ok === false);
    t('订阅 Claude 调得动', canGenerate({ isLocalClaude: true }));
    t('填了 key 的模型调得动', canGenerate({ apiKey: 'k', apiBase: 'https://x/v1', modelName: 'm' }));
    t('★ 本地 GPT / Gemini 明说调不动（不拿别的模型冒名顶替）', !canGenerate({ isLocalGpt: true }) && !canGenerate({ isGemini: true, apiKey: 'k', apiBase: 'x', modelName: 'm' }));
  }

  console.log('\n[10] 真挂到 express 上（body 真被解析、路由真通）');
  {
    const express = require('express');
    const app = express();
    app.use(express.json());
    const dir = mkdir();
    process.env.GRANCYAN_HEARTBEAT_DIR = dir;
    const { mount } = require('../server/heartbeat');
    let threw = null;
    try { mount(app, {}); } catch (e) { threw = e; }
    t('漏传依赖在挂载时就炸（不留到真实请求才 500）', threw && /缺依赖/.test(threw.message));
    mount(app, { claudeOnce: async () => ({ text: '' }), resolveLocalClaudeModel: m => m, outboundAgent: async () => undefined });
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = srv.address().port;
    const call = (method, p, body) => new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, res => {
        let raw = ''; res.on('data', d => raw += d); res.on('end', () => resolve({ code: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      });
      rq.on('error', reject); if (payload) rq.write(payload); rq.end();
    });
    try {
      t('坏地址 → 400', (await call('POST', '/api/heartbeat/config', { ntfyUrl: 'nope' })).code === 400);
      const ok = await call('POST', '/api/heartbeat/config', { ntfyUrl: 'https://ntfy.sh/route-test', enabled: true });
      t('好地址 → 200 且回显', ok.code === 200 && ok.body.config.ntfyUrl === 'https://ntfy.sh/route-test');
      const sy = await call('POST', '/api/heartbeat/sync', { target: { modelId: 'r1', nextAt: 5, nextSetAt: 9, heartbeatOn: true } });
      t('sync 的 body 真被读到了', sy.code === 200 && sy.body.schedule && sy.body.schedule.nextSetAt === 9, sy.body);
      t('claim 第一次领到、第二次领不到', (await call('POST', '/api/heartbeat/claim', { key: 'k1' })).body.ok === true
        && (await call('POST', '/api/heartbeat/claim', { key: 'k1' })).body.ok === false);
      t('take 通', (await call('POST', '/api/heartbeat/take', { chatIds: ['1'] })).body.ok === true);
      t('status 通', (await call('GET', '/api/heartbeat/status?modelId=r1')).body.schedule.nextSetAt === 9);
      t('数据落在 GRANCYAN_HEARTBEAT_DIR 指的地方（测试不碰她真实的那份）', fs.existsSync(path.join(dir, 'state.json')));
    } finally { srv.close(); }
  }

  console.log('\n[11] 页面那半边：和 server 对上');
  {
    const { hb, clock, calls } = rig();
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    const BASE = 'http://pc:3000';
    let serverUp = true;
    const fetchLog = [];
    const fakeFetch = async (url, opts) => {
      const p = url.replace(BASE, '');
      fetchLog.push(p);
      if (!serverUp) throw new Error('ECONNREFUSED');
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      const out = p === '/api/heartbeat/sync' ? hb.sync(body)
        : p === '/api/heartbeat/claim' ? hb.claim(body.key, 'page')
        : p === '/api/heartbeat/take' ? hb.take(body.chatIds)
        : { ok: false };
      return { status: 200, json: async () => JSON.parse(JSON.stringify(out)) };
    };
    class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
    const chat = { id: 101, headId: 2, nodes: {
      1: { id: 1, parentId: null, role: 'user', content: '我去洗澡啦', timestamp: bj('2026-09-23T13:00:00') },
      2: { id: 2, parentId: 1, role: 'ai', content: '去吧', timestamp: bj('2026-09-23T13:01:00') } } };
    let apiCalls = 0, nid = 100, timeouts = 0;
    const ctx = {
      console, Math, String, Number, Object, Array, JSON, Set, Map, Promise, Date: FakeDate,
      setInterval() {}, setTimeout: (fn) => { timeouts++; return 0; }, clearTimeout() {},
      state: { vitalsOn: true, vitalsHeartbeatOn: true, vitalsByModel: {}, configs: [{ id: 7, nickname: '克克', isLocalClaude: true, persona: '你是克克' }],
        chats: [chat], activeChatId: 101, userName: '小明' },
      save() {}, showToast() {}, renderMessages() {}, escHtml: s => String(s),
      document: { getElementById: () => null, visibilityState: 'hidden', addEventListener() {}, activeElement: null },
      getActiveChat: () => chat, getActiveChatModelIds: () => [7],
      getMessagePath: (c, id) => { const out = []; let n = c.nodes[id]; while (n) { out.unshift(n); n = c.nodes[n.parentId]; } return out; },
      callAPI: async () => { apiCalls++; }, _streamControllers: new Set(), nextId: () => ++nid, estimateTokens: s => s.length,
      fetch: fakeFetch,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/heartbeat-core.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/30-vitals.js'), 'utf8') + `;const SERVER_BASE = '${BASE}';`, ctx);
    const v = ctx.vitalsEnsure({ id: 7 });
    v.nextAt = bj('2026-09-23T14:50:00'); v.nextSetAt = bj('2026-09-23T13:01:00'); v.lastDid = '等她洗完澡';
    v.morningDay = '2026-09-23';

    const j = await ctx.hbSync();
    t('页面同步上去了', j && j.ok && hb._state.models['7'].nextAt === v.nextAt);
    t('★ 生成用的上下文跟着同步上去（人设、最近的聊天）', hb._contexts.get('7') && hb._contexts.get('7').persona === '你是克克'
      && hb._contexts.get('7').recent.length === 2);
    t('作息和她最后说话的时刻也报上去了', hb._state.lastUserAt === bj('2026-09-23T13:00:00') && hb._state.sleep);

    // 她不在跟前（页面不可见）→ 页面让给 server
    await ctx.vitalsHeartbeatTick();
    t('★ 页面不在跟前、server 接得住 → 页面不发', apiCalls === 0);
    await hb.tick();
    t('server 发了', calls.gen.length === 1 && calls.push.length === 1);

    // 她这时回到电脑前，页面还没来得及同步就到了 tick：本地那跳还挂着「到点」，
    // 但 server 已经发过了 —— 抢跳会被拒，页面不能再发一遍
    ctx.document.visibilityState = 'visible';
    vm.runInContext('_hb.lastInputAt = Date.now()', ctx);
    await ctx.vitalsHeartbeatTick();
    t('★ server 已经发过的那跳，页面抢不到就不发', apiCalls === 0);

    // 页面同步：发现待取箱有东西 → 接进对话
    await ctx.hbSync();
    const head = chat.nodes[chat.headId];
    t('★ server 替它说的话接进了对话', head && head.role === 'ai' && head.content === '想你了，在干嘛呀' && head.parentId === 2, head);
    t('接进来的那条标着是心跳醒来说的', head.fromHeartbeat === 'heartbeat' && String(head.modelId) === '7');
    t('★ 页面跟上了 server 替它排的下一跳', v.nextAt === hb._state.models['7'].nextAt && v.lastDid === '等她回来', [v.nextAt, hb._state.models['7'].nextAt]);

    // 下一跳到点时她在跟前 → 页面自己发、并且先抢跳
    clock.now = v.nextAt + 60e3;
    vm.runInContext('_hb.lastInputAt = Date.now()', ctx);
    await ctx.hbSync();
    await ctx.vitalsHeartbeatTick();
    t('★ 她在跟前 → 页面自己发', apiCalls === 1);
    const pageKeys = Object.entries(hb._state.claims).filter(([, c]) => c.by === 'page');
    t('页面发之前先领了这一跳', pageKeys.length === 1, hb._state.claims);
    await hb.tick();
    t('★ 同一跳 server 不会再发一遍', calls.gen.length === 1);

    // 页面发完，模型排了新的一跳 → 立刻同步给 server
    const before = timeouts;
    ctx._vitalsSchedule('30|等她吃完饭', { id: 7 });
    t('排了新的一跳就马上安排同步（她发完就关 App 的话 server 得知道）', timeouts > before);

    // 连不上 server：页面照旧自己发（原来的行为）
    serverUp = false;
    clock.now = v.nextAt + 60e3;
    ctx.document.visibilityState = 'hidden';
    await ctx.hbSync();
    await ctx.vitalsHeartbeatTick();
    t('★ 连不上 server → 页面照旧自己发', apiCalls === 2);
  }

  console.log('\n[12] 页面接晨间那条：套上刚醒的身体');
  {
    const ctx = { console, Math, String, Number, Object, Array, JSON, Set, Map, Date, setInterval() {}, setTimeout: () => 0, clearTimeout() {},
      state: { vitalsOn: true, vitalsByModel: {}, configs: [{ id: 7, nickname: '克克' }], chats: [{ id: 5, headId: null, nodes: {} }], activeChatId: 5 },
      save() {}, showToast() {}, renderMessages() {}, escHtml: s => String(s), nextId: (() => { let i = 0; return () => ++i; })(),
      document: { getElementById: () => null, addEventListener() {} } };
    ctx.globalThis = ctx; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/heartbeat-core.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/30-vitals.js'), 'utf8'), ctx);
    const v = ctx.vitalsEnsure({ id: 7 }); v.energy = 0.9; v.arousal = 0.7;
    const n = ctx.hbAcceptItems([{ chatId: 5, modelId: '7', nickname: '克克', text: '早…', at: Date.now(), kind: 'morning', morningDay: '2026-09-24', schedule: null }]);
    t('接进来了', n === 1 && ctx.state.chats[0].nodes[ctx.state.chats[0].headId].content === '早…');
    t('★ 身体换成刚醒的样子', v.energy < 0.4 && v.arousal < 0.25 && v.wokeDay === '2026-09-24', [v.energy, v.arousal]);
    t('★ 记下今天的晨间说过了（这台设备不会再醒一次）', v.morningDay === '2026-09-24');
    t('没有那个对话就不硬塞', ctx.hbAcceptItems([{ chatId: 999, modelId: '7', text: 'x' }]) === 0);
  }

  console.log('\n[13] 生物钟：App 关着的时候也在走（2026-10-03 clock）');
  {
    const late = { start: 150, end: 570, nights: 6, confident: true, source: 'band' };
    // 她下午一点关的 App，那会儿它精力 60%；凌晨三点半她还醒着（刚说过话），心跳到点
    const closedAt = bj('2026-09-23T13:00:00'), now = bj('2026-09-24T03:30:00');
    const p = buildPrompt(ctxOf({ energy: 0.6, energyAt: closedAt }), { did: 'x' }, { kind: 'heartbeat', at: now }, now,
      { lastUserAt: now - 10 * 60e3, lockscreenPrivate: true, sleep: late });
    t('★ 提示词按她的作息说现在几点、困不困', /生物钟：现在 03:30，按她的作息（02:30 睡 → 09:30 醒）是深夜/.test(p.system), p.system.match(/生物钟[^\n]*/));
    const e = +(p.system.match(/按钟点推到现在，你的能量约 (\d+)%/) || [])[1];
    t('★ 关 App 那会儿的精力用同一个 energyDrift 推到现在（夜里往下走）',
      e === Math.round(core.energyDrift(0.6, closedAt, now, late) * 100) && e < 45, e);
    t('身体状态标明是她关 App 之前的', /你的身体状态（14 小时30 分前，她关 App 之前）/.test(p.system), p.system.match(/你的身体状态[^：]*/));
    t('★ 困了也不许拿困退场，她难过时困意让位', /你困了/.test(p.system) && /不许拿「我困了」结束对话/.test(p.system) && /她难过的时候，困意让位/.test(p.system));
    const fresh = buildPrompt(ctxOf({ energy: 0.6, energyAt: bj('2026-09-23T14:55:00') }), { did: 'x' }, { kind: 'heartbeat', at: 0 }, bj('2026-09-23T15:00:00'),
      { lastUserAt: bj('2026-09-23T13:00:00'), lockscreenPrivate: true, sleep: late });
    t('刚同步过的状态不加「关 App 之前」、不重复报能量', !/关 App 之前/.test(fresh.system) && !/按钟点推到现在/.test(fresh.system) && /生物钟：现在 15:00/.test(fresh.system));
    t('白天不困', !/你困了/.test(fresh.system));
    const off = buildPrompt(ctxOf({ vitals: '', energy: null, energyAt: 0 }), { did: 'x' }, { kind: 'heartbeat', at: 0 }, now, { sleep: late });
    t('生命体征关着（没有身体）就不说生物钟', !/生物钟/.test(off.system));

    // ★ 真实路径：sync 收下上下文里的精力 + 页面同步的作息 → 巡检 → 生成时提示词里用的是这两样
    const { hb, calls, clock } = rig({ now: bj('2026-09-24T03:30:00') });
    hb.setConfig({ enabled: true, ntfyUrl: 'https://ntfy.sh/kk-test' });
    hb.sync({ target: target({ nextAt: bj('2026-09-24T03:20:00'), nextSetAt: bj('2026-09-24T01:00:00'), context: ctxOf({ energy: 0.6, energyAt: closedAt }) }),
      lastUserAt: clock.now - 10 * 60e3, sleep: { start: 23 * 60, end: 7 * 60, nights: 0, confident: true, source: 'manual' } });
    t('sync 收下了精力和时刻', hb._contexts.get('7').energy === 0.6 && hb._contexts.get('7').energyAt === closedAt);
    t('sync 记下作息来源', hb._state.sleep.source === 'manual' && hb.status('7').sleep.source === 'manual');
    await hb.tick();
    t('★ 巡检生成时用的是页面同步来的那份作息', calls.gen.length === 1 && /按她的作息（23:00 睡 → 07:00 醒）/.test(calls.gen[0].system),
      calls.gen[0] && calls.gen[0].system.match(/生物钟[^\n]*/));
  }

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ 测试自己炸了：' + (e && e.stack || e)); process.exit(1); });
