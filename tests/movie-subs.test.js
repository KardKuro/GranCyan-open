// 看片字幕（server/movie-subs.js）。跑法：node tests/movie-subs.test.js
//
// 守的几件事，都是静默失效：
//   · 挑字幕：界面小字、代码、偏到一边的字混进来 —— 前情被垃圾带偏，它照样信誓旦旦地接
//   · 同一句被连拍几次、OCR 每次差一两个字 —— 一句台词变成五句，前情全是复读
//   · 停了台词还留着 / 停的途中压出来的前情串进下一次 —— 上一部片子的剧情混进这一部
//   · 前端没了（刷新/崩了）还一直在拍屏幕
//   · Qwen 拒答被当成前情
//   · 最后一条：真起 PowerShell 跑一遍 OCR 脚本（Windows 才跑），确认它真能认字、没被 AMSI 拦
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const { EventEmitter } = require('events');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'server/movie-subs.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };
const L = (text, o = {}) => ({ text, cx: 0.5, y: 0.88, h: 0.045, ...o });
const tick = () => new Promise(r => setImmediate(r));

function fakeSpawn() {
  const spawned = [];
  const fn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.killed = false; c.kill = () => { c.killed = true; };
    c.cmd = cmd; c.args = args; c.opts = opts;
    spawned.push(c);
    return c;
  };
  fn.spawned = spawned;
  return fn;
}

(async () => {
  console.log('\n[1] 从一屏字里挑出字幕');
  t('OCR 插在汉字中间的空格挤掉', S.cleanOcr('你 根 本 不 知 道 ， 那 天') === '你根本不知道，那天');
  t('英文单词之间的空格留着', S.cleanOcr('I  don\'t   know') === "I don't know");
  t('居中、够大、在下半截的行 = 字幕', S.pickSubtitle([L('你 根 本 不 知 道')]) === '你根本不知道');
  t('★ 字小的（界面/代码/默认弹幕）不算', S.pickSubtitle([L('文件 编辑 视图', { h: 0.016 })]) === '');
  t('★ 偏到一边的不算（侧栏、时间戳）', S.pickSubtitle([L('推荐视频标题很长很长', { cx: 0.85 })]) === '');
  t('上半截的不算', S.pickSubtitle([L('片头大标题', { y: 0.3 })]) === '');
  t('★ 像代码的不算', S.pickSubtitle([L('const m = JSON.parse(s);')]) === '' && S.pickSubtitle([L('C:\\projects\\x\\y.js')]) === '');
  t('纯数字/符号不算', S.pickSubtitle([L('00:12:31 / 01:45:00')]) === '');
  t('两行字幕按从上到下拼', S.pickSubtitle([L('第二行', { y: 0.92 }), L('第一行台词', { y: 0.86 })]) === '第一行台词 第二行');
  t('英文字幕也认', S.pickSubtitle([L('Where were you last night?')]) === 'Where were you last night?');

  console.log('\n[2] 同一句只记一次');
  t('一模一样', S.sameLine('你走啊', '你走啊'));
  t('OCR 差一个字也算同一句', S.sameLine('你根本不知道那天晚上发生了什么', '你根本不知道那天晚上发生了仆么'));
  t('标点空格不同也算', S.sameLine('你走啊！', '你 走 啊'));
  t('真的换了一句就不算', !S.sameLine('你走啊', '我不会走的'));

  console.log('\n[3] 开、喂样本、停');
  let now = 1_000_000;
  const spawn = fakeSpawn();
  const logs = [];
  const ollama = [];
  let ollamaReply = '男主质问女友那晚去了哪，女友不肯说，两人吵起来。';
  const fetchImpl = async (url, opt) => {
    const body = JSON.parse(opt.body);
    ollama.push({ url, body });
    return { ok: true, json: async () => ({ message: { content: typeof ollamaReply === 'function' ? ollamaReply(body) : ollamaReply } }) };
  };
  let qHold = null;
  const enqueue = job => (qHold ? qHold.then(job) : job());
  const subs = S.create({ spawnImpl: spawn, fetchImpl, enqueue, now: () => now, platform: 'win32', log: m => logs.push(m) });
  t('非 Windows：不起、说清原因', S.create({ spawnImpl: spawn, platform: 'linux' }).start().ok === false && spawn.spawned.length === 0);
  t('GRANCYAN_PEEK=off：不起', S.create({ spawnImpl: spawn, platform: 'win32', disabled: true }).start().ok === false && spawn.spawned.length === 0);
  const r0 = subs.start();
  const child = spawn.spawned[0];
  t('起了一个 PowerShell，脚本走 -EncodedCommand（exe 里 asar 只读，不落 .ps1）', r0.ok && child && child.cmd === 'powershell.exe' && child.args.includes('-EncodedCommand'));
  t('父进程 pid 交给脚本（server 死了它自己退）', child.opts.env.SUB_PARENT === String(process.pid));
  subs.start();
  t('重复 start 不再起第二个', spawn.spawned.length === 1);
  const say = (text, extra = []) => child.stdout.emit('data', JSON.stringify({ ms: 300, lines: [L(text), ...extra] }) + '\n');
  say('你 那 天 晚 上 去 哪 了', [L('文件 编辑', { h: 0.015, cx: 0.1 })]);
  now += 4000; say('你那天晚上去哪了');                 // 同一句又拍到
  now += 4000; say('你 那 天 晚 上 去 哪 了 ？');
  let v = subs.view();
  t('★ 同一句连拍三次只记一次，界面小字没混进来', v.recent.length === 1 && v.recent[0].text === '你那天晚上去哪了？', v.recent);
  t('样本是一行一行 JSON，半截的也能接上', (() => {
    const s = JSON.stringify({ lines: [L('我不想说')] }) + '\n';
    now += 4000;
    child.stdout.emit('data', s.slice(0, 10)); child.stdout.emit('data', s.slice(10));
    return subs.view().recent.length === 2;
  })());
  child.stdout.emit('data', '#< CLIXML\n<Objs Version="1.1.0.1">progress</Objs>\n');
  t('PowerShell 的进度噪音不炸', subs.view().recent.length === 2);
  child.stdout.emit('data', JSON.stringify({ err: 'boom' }) + '\n');
  t('单次 OCR 失败：记个错，不停', subs.view().on === true && /OCR 失败/.test(subs.view().error));

  console.log('\n[4] 压前情');
  // 上面已经记了 2 句，再来 3 句 = 5 句
  const lines = ['你根本不信我', '我信过你一次', '那是我的错吗', '你走吧', '我不会走的', '下着雨你去哪'];
  for (const s of lines.slice(0, 3)) { now += 4000; say(s); }
  t('新台词不够 6 句：不压', ollama.length === 0);
  now += 4000; say(lines[3]);
  await tick(); await tick();
  t('攒够 6 句：交给本地 Qwen 压一次，不开思考', ollama.length === 1 && ollama[0].body.think === false && /11434\/api\/chat$/.test(ollama[0].url));
  const u = ollama[0].body.messages.find(m => m.role === 'user').content;
  t('喂进去的是旧前情 + 新台词', /之前的前情：（刚开始看/.test(u) && /· 你那天晚上去哪了/.test(u) && /· 你走吧/.test(u), u);
  v = subs.view();
  t('前情存下了', v.recap === ollamaReply);
  t('★ 已经压进前情的原句不再重复给', v.recent.length === 0, v.recent);
  for (const s of lines.slice(4)) { now += 4000; say(s); }
  t('新来的句子照常给', subs.view().recent.map(x => x.text).join('|') === '我不会走的|下着雨你去哪');
  // 台词得真的各不相同：只差一个字的会被当成同一句 OCR 抖动
  const SIX = [['电话响了没人接', '门外好像有人', '别出声听我说', '他们已经到楼下', '快把灯关掉', '从后门出去'],
               ['天亮之前必须走', '车钥匙在抽屉里', '你还记得那首歌吗', '妈妈最喜欢唱它', '我们小时候住这', '院子里有棵树'],
               ['警察在问邻居', '照片被撕掉了', '他手上有道疤', '那封信是谁寄的', '地址写错了吧', '邮戳是三年前']];
  for (const s of SIX[0]) { now += 4000; say(s); }
  await tick();
  t('★ 离上次压不到一分钟：先不压（GPU 别被占满）', ollama.length === 1);
  now += 60000; say('隔了一分钟又一句'); await tick(); await tick();
  t('过了一分钟再压：带上旧前情滚动更新', ollama.length === 2 && ollama[1].body.messages[1].content.includes('男主质问女友'));

  ollamaReply = '我无法生成包含此类内容的概括，抱歉。';
  const oldRecap = subs.view().recap;
  for (const s of SIX[1]) { now += 4000; say(s); }
  now += 61000; say('最后一句收尾的话'); await tick(); await tick(); await tick();
  t('★ 两个模型都拒：不把拒绝当前情，旧前情留着', subs.view().recap === oldRecap && ollama.length === 4 && ollama[3].body.model !== ollama[2].body.model, ollama.map(o => o.body.model));

  console.log('\n[5] 停');
  ollamaReply = '上一部片子的剧情';
  let rel; qHold = new Promise(r => { rel = r; });
  for (const s of SIX[2]) { now += 4000; say(s); }
  now += 61000; say('停之前最后一句台词');
  subs.stop();
  t('★ 停了就杀进程', child.killed === true);
  t('★ 停了台词和前情都清空（不留档）', subs.view().recent.length === 0 && subs.view().recap === '' && subs.view().on === false);
  subs.start();
  rel(); await tick(); await tick(); await tick();
  t('★ 停之前排着的那次压缩回来了：作废，不串进新一次', subs.view().recap === '');
  qHold = null;
  const child2 = spawn.spawned[spawn.spawned.length - 1];
  t('重开是一个新进程', child2 !== child);
  child.stdout.emit('data', JSON.stringify({ lines: [L('旧进程最后吐出来的一句')] }) + '\n');
  t('旧进程晚到的输出不算数', subs.view().recent.length === 0);

  console.log('\n[6] 前端没了就自己停');
  now += 60000; subs.watchdog();
  t('一分钟没人来取：还开着', subs.view().on === true);   // view() 自己会续命，所以先看再推时间
  now += S.IDLE_STOP_MS + 1000; subs.watchdog();
  t('★ 90 秒没人来取：自己停、杀进程', subs._st.on === false && child2.killed === true);
  subs.start();
  const child3 = spawn.spawned[spawn.spawned.length - 1];
  child3.stderr.emit('data', 'This script contains malicious content and has been blocked');
  child3.emit('exit', 1);
  t('被杀毒拦了：说清楚是 AMSI', subs.view().on === false && /杀毒/.test(subs.view().error));
  t('日志里不打台词内容', !logs.some(m => /台词|你根本不信我|男主/.test(m)), logs);

  console.log('\n[7] 接口');
  const routes = {};
  const app = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } };
  const mounted = S.mount(app, { spawnImpl: fakeSpawn(), platform: 'win32' });
  const call = (k) => { let out; routes[k]({}, { json: j => { out = j; } }); return out; };
  t('三个接口都挂上了', !!routes['POST /api/movie-subs/start'] && !!routes['POST /api/movie-subs/stop'] && !!routes['GET /api/movie-subs']);
  t('start → on，GET 能读，stop → off', call('POST /api/movie-subs/start').on === true && call('GET /api/movie-subs').on === true && call('POST /api/movie-subs/stop').on === false);
  mounted.stop();

  console.log('\n[8] 真跑一次 OCR 脚本（Windows）');
  if (process.platform !== 'win32') {
    console.log('  （不是 Windows，跳过）');
  } else {
    // 只验「脚本能起来、OCR 引擎能建、能吐一行合法 JSON」——屏幕上有什么字不确定，不断言内容
    const r = await new Promise(res => {
      const p = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(S.PS_SUBS, 'utf16le').toString('base64')],
        { windowsHide: true, env: { ...process.env, SUB_EVERY_MS: '100000', SUB_PARENT: String(process.pid) } });
      let out = '', err = '';
      const timer = setTimeout(() => { p.kill(); res({ out, err, timeout: true }); }, 40000);
      p.stdout.on('data', d => {
        out += d;
        if (out.includes('\n')) { clearTimeout(timer); p.kill(); res({ out, err }); }
      });
      p.stderr.on('data', d => { err += d; });
      p.on('exit', () => { clearTimeout(timer); res({ out, err }); });
    });
    let j = null;
    try { j = JSON.parse(r.out.split('\n')[0]); } catch {}
    t('★ 真脚本起来了、吐出一行 OCR 结果（没被 AMSI 拦、没报错）', j && Array.isArray(j.lines) && !j.err && !j.fatal, (r.out || r.err).slice(0, 300));
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ 测试自己炸了：' + e.stack); process.exit(1); });
