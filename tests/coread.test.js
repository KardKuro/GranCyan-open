'use strict';
// 共读同步（用户改进清单第 4 条里挑出来的那件）
//
// 书架的划线本来就有，缺的只是「递到对话那边」。听起来是接根线的事，
// 但这根线接在**每一轮提示词**上，四种翻法全是静默的：
//   拉不到 → 发消息转圈；旧数据 → 它说「你刚划的」其实是三天前；
//   进错段 → 提示词缓存每轮全废，只体现在账单上；没有上限 → 某天把上下文顶爆。
// 所以这份测试守的是这四样，不是「文案好不好看」。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const cr = read('js/47-coread.js');
const reader = read('coread/routes/reader.js');
const html = read('index.html');
const core = read('js/01-core.js');
const stateJs = read('js/02-state.js');
const boot = read('js/14-boot-brain-hub.js');
const prompts = read('js/05-prompts-api.js');

// 造一份书架近况
function pulse(opts = {}) {
  const n = opts.n == null ? 3 : opts.n;
  const marks = [];
  for (let i = 0; i < n; i++) {
    marks.push({
      who: i % 2 ? 'ai' : 'user', chapter: 3,
      quote: opts.longQuote ? 'Q'.repeat(400) : '当苏菲开始思考有关活着这件事时',
      note: opts.longNote ? 'N'.repeat(400) : ('第 ' + i + ' 条批注'),
      at: new Date(Date.now() - i * 3600000).toISOString()
    });
  }
  return {
    at: new Date().toISOString(),
    book: opts.noBook ? null : { id: 'b1', title: '苏菲的世界', author: '乔斯坦·贾德', chapter: 3, chapters: 37 },
    marks
  };
}

let fetchCalls = 0;
function sandbox(opts = {}) {
  const noop = () => {};
  const el = { style: {}, textContent: '', checked: false, classList: { add: noop, remove: noop, toggle: noop } };
  const box = {
    state: Object.assign({ coreadOn: true, userName: '小明' }, opts.state || {}),
    save: noop, showToast: noop,
    SERVER_BASE: opts.base === undefined ? 'http://127.0.0.1:3000' : opts.base,
    document: { getElementById: () => (opts.noDom ? null : el) },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout, clearTimeout, Math, Date, JSON, console, Object, Array, String, Number,
    Boolean, RegExp, Set, Promise, isNaN,
    fetch: () => {
      fetchCalls++;
      if (opts.fetchFail) return Promise.reject(new Error('boom'));
      if (opts.http500) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.pulse || pulse()) });
    }
  };
  box.window = undefined;      // 别让文件尾那个 setTimeout 自启动，测试自己控节奏
  vm.createContext(box);
  vm.runInContext(cr
    + ';this.coreadEnabled=coreadEnabled;this.coreadRefresh=coreadRefresh;this.coreadStatus=coreadStatus;'
    + 'this.coreadPromptFor=coreadPromptFor;this.toggleCoread=toggleCoread;this.coreadRenderStatus=coreadRenderStatus;'
    + 'this.COREAD_STALE=COREAD_STALE;this.COREAD_MAX_CHARS=COREAD_MAX_CHARS;this.COREAD_TTL=COREAD_TTL;'
    + 'this.__setCache=(v)=>{_crCache=v};this.__getCache=()=>_crCache;this.__el=null;', box);
  box.__el = el;
  return box;
}

console.log('\n【一】绝不能挡住发消息');

{
  const S = sandbox();
  const r = S.coreadPromptFor({});
  t('★ coreadPromptFor 是同步的，不返回 Promise',
    r && typeof r.then !== 'function' && typeof r.volatile === 'string', typeof r);
  t('★ 源码里它不是 async 函数', !/async\s+function\s+coreadPromptFor/.test(cr));
}

{
  // coreadPromptFor 里那句 coreadRefresh 绝不能 await —— await 了就等于
  // 每次发消息都要先等一个网络往返，server 关着的时候直接卡满超时。
  const body = cr.split(/\r?\nfunction /).find(f => f.startsWith('coreadPromptFor('));
  t('★ 它调 coreadRefresh 但不 await', !!body && /coreadRefresh\(false\)/.test(body)
    && !/await\s+coreadRefresh/.test(body));
}

{
  const S = sandbox({ fetchFail: true });
  const r = S.coreadPromptFor({});
  t('★ 一次都没拉到时只给固定能力说明，不给半截动态数据', r.stable !== '' && r.volatile === '');
}

{
  const S = sandbox({ base: '' });
  const before = fetchCalls;
  S.coreadPromptFor({});
  t('★ 没配服务器地址时压根不发请求', fetchCalls === before);
}

console.log('\n【二】失败退避');

(async () => {
  const S = sandbox({ fetchFail: true });
  const a = fetchCalls;
  await S.coreadRefresh(true);
  const b = fetchCalls;
  await S.coreadRefresh(false);
  await S.coreadRefresh(false);
  const c = fetchCalls;
  t('★ 失败之后不再每轮去撞（退避生效）', b === a + 1 && c === b, { a, b, c });
  t('★ 但手动「立刻同步」不受退避挡着', await (async () => {
    const d = fetchCalls; await S.coreadRefresh(true); return fetchCalls === d + 1;
  })());

  console.log('\n【三】旧数据比没数据糟');

  {
    const S2 = sandbox();
    await S2.coreadRefresh(true);
    t('★ 拉到了就是 ok', S2.coreadStatus().k === 'ok', S2.coreadStatus());
    // 把缓存的时间戳往回拨到超过保质期
    S2.__setCache({ at: Date.now() - S2.COREAD_STALE - 1000, data: pulse() });
    t('★ 缓存太旧 → 状态是 stale', S2.coreadStatus().k === 'stale', S2.coreadStatus());
    const r = S2.coreadPromptFor({});
    t('★ 而且太旧就不给动态数据（宁可不说，也别说成「你刚划的」）',
      r.volatile === '' && r.stable !== '', r);
  }

  console.log('\n【四】状态要分得清（四种在界面上都长成「什么都没有」）');

  {
    t('★ 关掉 → off', sandbox({ state: { coreadOn: false } }).coreadStatus().k === 'off');
    t('★ 还没拉过 → none', sandbox().coreadStatus().k === 'none');
    const S3 = sandbox({ fetchFail: true });
    await S3.coreadRefresh(true);
    t('★ 拉失败 → fail', S3.coreadStatus().k === 'fail', S3.coreadStatus());
    const S4 = sandbox({ pulse: pulse({ noBook: true }) });
    await S4.coreadRefresh(true);
    t('★ 书架是空的 → empty（跟连不上不是一回事）', S4.coreadStatus().k === 'empty', S4.coreadStatus());
    const S5 = sandbox({ http500: true });
    await S5.coreadRefresh(true);
    t('★ 服务端 500 也算 fail，不当成「书架是空的」', S5.coreadStatus().k === 'fail');
  }

  console.log('\n【五】分段：划线必须进 volatile');

  {
    const SS = sandbox({ base: '' });
    const before = SS.coreadPromptFor({}).stable;
    SS.__setCache({ at: Date.now(), data: pulse() });
    const after = SS.coreadPromptFor({}).stable;
    t('★ enabled 时 stable 在首次拉取前后完全相同（缓存结构不能时有时无）',
      before !== '' && before === after, { before, after });

    const S6 = sandbox();
    await S6.coreadRefresh(true);
    const r = S6.coreadPromptFor({});
    t('★ 书名和划线都在 volatile 里',
      /苏菲的世界/.test(r.volatile) && /第 0 条批注/.test(r.volatile));
    t('★ stable 里一个会变的东西都没有（书名、章号、划线都不许在）',
      !/苏菲的世界/.test(r.stable) && !/批注内容|第 0 条/.test(r.stable) && !/第 3 章/.test(r.stable),
      r.stable);
    t('★ 接线处把 stable 加进 base、volatile 加进 vol',
      /const cr = coreadPromptFor\(conf\);[\s\S]{0,80}base \+= cr\.stable;[\s\S]{0,40}vol \+= cr\.volatile;/.test(prompts));
  }

  console.log('\n【六】硬上限（没有它某天会安静地把上下文顶爆）');

  {
    const S7 = sandbox({ pulse: pulse({ n: 60, longQuote: true, longNote: true }) });
    await S7.coreadRefresh(true);
    const r = S7.coreadPromptFor({});
    // ⚠️ 原来这里允许 900+1200，等于没守住代码声称的上限（Codex 指出的）。
    //    收紧到「上限 + 一行的余量」——「加完才检查」那种写法过不了这条。
    t('★ 灌 60 条超长划线，输出真的收在上限附近',
      r.volatile.length <= S7.COREAD_MAX_CHARS + 160, r.volatile.length);
    t('★ 而且明说了「更早的省略」，不是悄悄丢', /更早的省略/.test(r.volatile));
  }

  console.log('\n【六·续】Codex 逮到的三处');

  {
    // 超长书名：服务端没限过它，一本标题异常长的书能让每轮提示词膨胀到任意长度
    const long = '书'.repeat(500);
    const SL = sandbox({ pulse: { at: new Date().toISOString(),
      book: { id: 'b', title: long, author: long, chapter: 1, chapters: 2 }, marks: [] } });
    await SL.coreadRefresh(true);
    const v = SL.coreadPromptFor({}).volatile;
    t('★ 书名和作者都被截短（服务端从来没限过它们）', v.length < 200, v.length);
  }

  {
    // 计时器必须盖住 r.json()。拿到响应头就 clearTimeout 的话，
    // server 回了头之后卡住 → json() 永远 pending → finally 永远不到 →
    // _crBusy 永久为 true → 功能永久失效，且一声不吭。
    const body = cr.split(/\r?\n(?:async )?function /).find(f => f.startsWith('coreadRefresh('));
    t('★ clearTimeout 在 finally 里（不是拿到响应头就清）',
      !!body && /finally \{[\s\S]*clearTimeout/.test(body));
    t('★ _crBusy 也在 finally 里放（任何失败路径都要还回去）',
      !!body && /finally \{[\s\S]*_crBusy = false/.test(body));
  }

  {
    // 解析阶段炸了也必须把 _crBusy 还回去，否则下一次直接静默 return
    const SJ = sandbox();
    vm.runInContext('fetch = () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("body 断了")) });', SJ);
    await SJ.coreadRefresh(true);
    let again = 0;
    vm.runInContext('fetch = () => { this.__n = (this.__n||0)+1; return Promise.reject(new Error("x")); };', SJ);
    await SJ.coreadRefresh(true);
    t('★ 读 body 时炸了，下一次还能再拉（没被 _crBusy 永久锁住）',
      SJ.__n === 1, SJ.__n);
  }

  {
    // 服务端生成时刻很旧 = 拉到一份陈年回包（缓存 / 代理 / 手机休眠）。
    // 光看「我们拉到它的时刻」会把它当成刚拉的。
    const old = new Date(Date.now() - 5 * 86400000).toISOString();
    const SO = sandbox({ pulse: Object.assign(pulse(), { at: old }) });
    await SO.coreadRefresh(true);
    t('★ 服务端说这份是五天前生成的 → 算 stale，不用它',
      SO.coreadStatus().k === 'stale', SO.coreadStatus());
    t('★ 而且一个字都不给', SO.coreadPromptFor({}).volatile === '');
  }

  console.log('\n【七】划线的归属：自己划的认领，别人划的不许冒领');

  {
    // 2026-09-19 之前的旧批注：库里没记是谁划的（pulse 不带 byName/byModel）。
    // 旧行为是一律写「你」—— 可书架能**单独选模型**，于是每个模型都把 DeepSeek
    // 划的线认领成自己的，语气还很笃定。这是用户逮到的那个 bug。
    // 新规矩：宁可中立，不许瞎认领。
    const S8 = sandbox();
    await S8.coreadRefresh(true);
    const r = S8.coreadPromptFor({ nickname: '克克', modelName: 'claude-opus-5' });
    t('★ 不知道是谁划的时候说中立的，绝不写成「你」',
      /· 书架里的 AI（/.test(r.volatile) && !/· 你（/.test(r.volatile), r.volatile.slice(0, 260));
    t('★ user 那半边用她的名字', /· 小明（/.test(r.volatile));
  }

  {
    // 新数据：pulse 会把 byName/byModel 一起带回来，对得上才认领。
    const withBy = (name, model) => {
      const p = pulse();
      for (const m of p.marks) if (m.who === 'ai') { m.byName = name; m.byModel = model; }
      return p;
    };
    const S8a = sandbox({ pulse: withBy('DeepSeek 读书搭子', 'deepseek-chat') });
    await S8a.coreadRefresh(true);
    const other = S8a.coreadPromptFor({ nickname: '克克', modelName: 'claude-opus-5' }).volatile;
    t('★★ 书架里是 DeepSeek 划的，别的模型读到的是它的名字，不是「你」',
      /· 书架里的 DeepSeek 读书搭子（/.test(other) && !/· 你（/.test(other), other.slice(0, 260));

    const S8b = sandbox({ pulse: withBy('DeepSeek 读书搭子', 'deepseek-chat') });
    await S8b.coreadRefresh(true);
    const self = S8b.coreadPromptFor({ nickname: 'x', modelName: 'deepseek-chat' }).volatile;
    t('★ 正是它自己划的那条要认领成「你」（写成「AI 划了」它会以为在看第三个人的字）',
      /· 你（/.test(self), self.slice(0, 260));
  }

  {
    const S9 = sandbox({ state: { coreadOn: true, userName: '' } });
    await S9.coreadRefresh(true);
    t('★ 没设名字时也有兜底称呼，不是空的「· （2 小时前）」',
      /· 她（/.test(S9.coreadPromptFor({}).volatile));
  }

  console.log('\n【八】只当背景，不许每轮硬聊书');

  {
    const SA = sandbox();
    await SA.coreadRefresh(true);
    t('★ 提示词里明写了「她没提起就别硬往这上面聊」',
      /没提起书的时候别硬往这上面聊/.test(SA.coreadPromptFor({}).volatile));
  }

  console.log('\n【九】开关');

  {
    const SB = sandbox({ state: { coreadOn: false } });
    const r = SB.coreadPromptFor({});
    t('★ 关掉之后一个字都不加', r.stable === '' && r.volatile === '');
    t('★ 关掉之后也不发请求', await (async () => {
      const d = fetchCalls; await SB.coreadRefresh(true); return fetchCalls === d;
    })());
  }

  console.log('\n【十】服务端那一头');

  {
    t('★ /api/reading/pulse 路由在', /'\/api\/reading\/pulse'/.test(reader));
    t('★ 划线条数有上限', /MAX_MARKS\s*=\s*\d+/.test(reader));
    t('★ 引文和批注都截了长度', /slice\(0, QUOTE\)/.test(reader) && /slice\(0, NOTE\)/.test(reader));
    // ⚠️ 原来这条只 grep 服务端源码里有没有 at —— 而前端**根本不读它**，
    //    等于在断言一个没人用的字段（假绿，Codex 指出的）。
    //    现在前端真的读了（见下面「五天前生成的 → stale」），这条改成守两头都在。
    t('★ 回包带 at 时间戳', /at: new Date\(\)\.toISOString\(\)/.test(reader));
    t('★ 而且前端真的读了它，不是摆设', /_crCache\.data && _crCache\.data\.at/.test(cr));
    // ⚠️ 这条本来写成源码正则 /catch\(e\){…status\(500\)…error:/，是**假绿**：
    //    reading-import 路由里本来就有一句一模一样的 status(500)，正则匹配到了那个，
    //    于是把 pulse 的 500 整个删掉它照样绿。故障注入逮到的（红 0 命中 0）。
    //    改成真调一次 handler、让 db 当场炸给它看。
    const routes = {};
    const app = { get: (p, h) => { routes[p] = h; }, post: () => {}, delete: () => {}, use: () => {} };
    const badDb = { prepare() { throw new Error('db 炸了'); } };
    let code = 200, body = null;
    const res = { json: (d) => { body = d; }, status: (c) => { code = c; return res; }, send: () => {} };
    try {
      require(path.join(ROOT, 'coread', 'routes', 'reader.js'))(app, badDb);
      routes['/api/reading/pulse']({}, res);
    } catch (e) { body = { thrown: String(e.message) }; }
    t('★ 服务端自己炸了要给 500 + error，不是一个空壳',
      code === 500 && body && body.error && !body.thrown, { code, body });
    t('★ 而且绝不能把「炸了」伪装成「书架是空的」',
      !(body && body.book === null && !body.error), body);
    t('★ 没书时 book 给 null，不编一本出来', /book: null, marks: \[\]/.test(reader));
  }

  // 真跑一遍服务端 handler：假 app 收路由，假 db 喂数据
  {
    const routes = {};
    const app = { get: (p, h) => { routes[p] = h; }, post: () => {}, delete: () => {}, use: () => {} };
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({
      id: 'a' + i, book_id: 'b1', chapter_num: 3,
      original_text: 'O'.repeat(300), annotation: 'A'.repeat(300),
      annotator: i % 2 ? 'ai' : 'user', created_at: '2026-08-30 10:00:00'
    });
    const db = {
      prepare(sql) {
        return {
          get: () => /COUNT/.test(sql) ? { c: 37 }
            : { id: 'b1', title: '书', author: '作者', last_chapter: 3, last_read_at: '2026-08-30 10:00:00', created_at: '' },
          all: (bid, lim) => /annotations/.test(sql) ? rows.slice(0, lim) : [],
          run: () => {}
        };
      }
    };
    let out = null;
    const res = { json: (d) => { out = d; }, status: () => res, send: () => {} };
    try {
      require(path.join(ROOT, 'coread', 'routes', 'reader.js'))(app, db);
      routes['/api/reading/pulse']({}, res);
    } catch (e) { out = { error: String(e.message) }; }
    t('★ 真调一次 handler 能出结果', !!out && !out.error, out && out.error);
    if (out && !out.error) {
      t('★ 条数被限住了（喂 40 条只出 8 条）', out.marks.length === 8, out.marks.length);
      t('★ 每条的引文都被截短了', out.marks.every(m => m.quote.length <= 60), out.marks[0].quote.length);
      t('★ 每条的批注也被截短了', out.marks.every(m => m.note.length <= 90), out.marks[0].note.length);
      t('★ who 只有 user / ai 两种', out.marks.every(m => m.who === 'user' || m.who === 'ai'));
      t('★ 整包够小（要进每一轮提示词）', JSON.stringify(out).length < 2500, JSON.stringify(out).length);
    }
  }

  console.log('\n【十一】三道门 + 挂载点');

  t('★ coreadOn 三道门都在',
    core.includes('kuro_coreadOn') && stateJs.includes('kuro_coreadOn') && boot.includes('state.coreadOn'),
    { core: core.includes('kuro_coreadOn'), st: stateJs.includes('kuro_coreadOn'), boot: boot.includes('state.coreadOn') });
  t('★ 默认开，所以判据是「!== false」而不是 !!（老档不该被静默关掉）',
    /state\.coreadOn\s*=\s*saved\.coreadOn\s*!==\s*false/.test(boot));
  t('★ 47-coread.js 进了 index.html', html.includes('js/47-coread.js'));
  t('★ 设置里有开关', html.includes('id="coreadToggle"') && /toggleCoread\(this\.checked\)/.test(html));
  t('★ 设置里有状态行和手动同步', html.includes('id="coreadStatus"') && /coreadSyncNow\(\)/.test(html));
  t('★ 帮助里有这一条', /help-key">共读同步/.test(html));
  t('★ 帮助里说清了「连不上就当没有」', /连不上就当没有/.test(html));

  console.log('\n' + (fail ? '✗ ' + fail + ' 条没过' : '✓ 全过') + '（共 ' + (pass + fail) + ' 条）');
  process.exit(fail ? 1 : 0);
})();
