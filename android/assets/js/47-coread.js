// ============================================================
// 共读同步（把书架里的痕迹递到对话这边）
//
// 书架（/reading）里你和它可以在同一段文字上各自划线、写批注，这套早就有了。
// 缺的是：**主对话里的它一个字都看不到**。书架是服务端另起的一套上下文，
// 两边各聊各的，于是会出现「昨天在书上跟你聊了半天，今天在这儿完全不知情」。
//
// 这里做的事很小：拉一份书架近况，塞进提示词。但有四处不小心就静默出错——
//
// 1) **绝不能挡住发消息。** server 没开、地址过期、网络卡住，都不该让发送转圈。
//    所以这条链是**异步预拉 + 同步读缓存**：coreadPromptFor 只读内存里那份，
//    从不 await；刷新在后台跑，失败了就当没有。
//
// 2) **旧数据比没数据糟。** 缓存三天前的划线，它会说「你刚划的那句」——
//    你会以为它在胡说。所以缓存带时间戳，超过 COREAD_STALE 直接当没有。
//
// 3) **必须进 volatile 段。** 划线一变整段就变，留在 stable 里等于每轮把
//    后面的历史缓存全部冲掉（见 buildApiMessages 里的分段）。
//
// 4) **总量要有硬上限。** 服务端已经截了 8 条，这边再截一次字数——
//    两边都截是故意的：服务端改了限额，这边不会跟着失守。
// ============================================================

const COREAD_TTL = 5 * 60 * 1000;          // 缓存新鲜期：超过就后台刷一次
const COREAD_STALE = 36 * 3600 * 1000;     // 超过一天半的旧缓存直接不用
const COREAD_MAX_CHARS = 900;              // 进提示词的硬上限

let _crCache = null;      // { at:毫秒, data:{book,marks} }
let _crBusy = false;
let _crFailAt = 0;        // 上次失败的时刻，用来退避，别每轮都去撞一个开不了的门

function coreadEnabled() {
  return typeof state === 'object' && state && state.coreadOn !== false;
}

// 异步刷新。**任何一条失败路径都只是 return，不抛、不弹窗**——
// 它是背景信息，不是功能主线，为它打断用户发消息不值得。
async function coreadRefresh(force) {
  if (!coreadEnabled()) return;
  if (_crBusy) return;
  const now = Date.now();
  if (!force && _crCache && now - _crCache.at < COREAD_TTL) return;
  // 失败之后 2 分钟内不再试。没有这道退避，server 关着的时候每轮都会去撞一次。
  if (!force && _crFailAt && now - _crFailAt < 120000) return;
  if (typeof SERVER_BASE !== 'string' || !SERVER_BASE) return;
  _crBusy = true;
  // ⚠️⚠️ 计时器必须盖住**整个**取回过程，包括 r.json()。
  //    原来是拿到响应头就 clearTimeout —— server 回了头之后连接卡住的话，
  //    r.json() 永远 pending，finally 永远到不了，_crBusy 永久为 true，
  //    从此自动刷新和「立刻同步」全部静默 return，只能重开页面。
  //    Codex 逮到的：一次卡住 = 功能永久失效，且一声不吭。
  const ctrl = new AbortController();
  let t = null;
  try {
    t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 8000);
    const r = await fetch(SERVER_BASE + '/api/reading/pulse', { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();                  // 还在计时器覆盖范围内
    if (!d || d.error) throw new Error(d && d.error || 'bad');
    _crCache = { at: Date.now(), data: d };
    _crFailAt = 0;
  } catch (e) {
    _crFailAt = Date.now();
  } finally {
    if (t != null) clearTimeout(t);
    _crBusy = false;
  }
}

// 缓存还能不能用。分五种，面板要能说清是哪一种，
// 否则「没同步」和「书架是空的」在界面上长得一模一样。
function coreadStatus() {
  if (!coreadEnabled()) return { k: 'off', msg: '没开' };
  if (!_crCache) return _crFailAt ? { k: 'fail', msg: '连不上电脑上的书架' } : { k: 'none', msg: '还没拉过' };
  // 两个时间都要看：_crCache.at 是**我们拉到它的时刻**，
  // d.at 是**服务端生成它的时刻**。正常情况下两者接近，但中间隔了缓存、
  // 代理或者手机休眠时可能拉到一份很旧的回包 —— 那时 _crCache.at 是新的，
  // 光看它会把陈年数据当成刚拉的。取两者里更旧的那个。
  // （原来服务端那个 at 根本没人读，测试却在断言它存在 —— 假绿，Codex 逮到的。）
  const srvAt = Date.parse(String((_crCache.data && _crCache.data.at) || ''));
  const born = Number.isFinite(srvAt) ? Math.min(_crCache.at, srvAt) : _crCache.at;
  const age = Date.now() - born;
  if (age > COREAD_STALE) return { k: 'stale', msg: '拉到的那份太旧了，不用它' };
  const d = _crCache.data || {};
  if (!d.book) return { k: 'empty', msg: '书架里还没有书' };
  return { k: 'ok', msg: '《' + d.book.title + '》第 ' + (d.book.chapter || 0) + ' 章 · ' + ((d.marks || []).length) + ' 条划线' };
}

// 划线归属。
//
// ⚠️ 原来是「who==='ai' 就写『你』」，这在书架和对话用同一个模型时是对的，
// 但书架可以**单独选模型**（DeepSeek 划的线，主对话这边是别的模型），
// 于是每个模型读到的都是「你划了」—— 它们会一致地认领别人写的批注，
// 而且语气笃定，看不出是错的。这是用户逮到的那个 bug。
//
// 现在按 pulse 带回来的 byName/byModel 判断这条到底是不是「我」划的：
//   对得上 → 「你」（该认领的要认领，写成「AI 划了」它会以为在看第三个人的字）
//   对不上 → 点名是谁划的
//   两个字段都空（2026-09-19 之前的旧批注，库里没记）→ 说中立的「书架里的 AI」。
//   **宁可中立，也不许瞎认领** —— 认错了比说不清更糟。
function _crWho(m, conf) {
  const who = m && m.who;
  if (who !== 'ai') return (typeof state === 'object' && state && state.userName) ? state.userName : '她';
  const byName = String((m && m.byName) || '').trim();
  const byModel = String((m && m.byModel) || '').trim().toLowerCase();
  if (!byName && !byModel) return '书架里的 AI';
  const myNick = String((conf && conf.nickname) || '').trim();
  const myModel = String((conf && conf.modelName) || '').trim().toLowerCase();
  if ((byModel && myModel && byModel === myModel) || (byName && myNick && byName === myNick)) return '你';
  return byName ? ('书架里的 ' + byName) : '书架里的另一个 AI';
}

function _crWhen(iso) {
  const t = Date.parse(String(iso || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return '';
  const h = (Date.now() - t) / 3600000;
  if (h < 1.5) return '刚刚';
  if (h < 24) return Math.round(h) + ' 小时前';
  const d = Math.round(h / 24);
  return d + ' 天前';
}

// 同步：只读缓存，顺手在后台捅一下刷新（不等）。
function coreadPromptFor(conf) {
  const empty = { stable: '', volatile: '' };
  if (!coreadEnabled()) return empty;
  // 能力说明只取决于开关，不能跟着「缓存此刻有没有拉到」时有时无；否则第一次拉取成功
  // 就会改变 stable 段结构、打穿后续历史的提示词缓存。动态书名/章号/划线仍只进 volatile。
  const stable = '【书架】你和她可以在同一本书上各自划线、写批注（在书架页面里），'
    + '两边看得见对方留下的痕迹。下面这段是最近的情况。\n';
  try { coreadRefresh(false); } catch {}      // 故意不 await
  const st = coreadStatus();
  if (st.k !== 'ok') return { stable, volatile: '' };

  const d = _crCache.data;
  const b = d.book;
  const marks = Array.isArray(d.marks) ? d.marks : [];

  // 书名和作者也要截 —— 服务端没限过它们，一本标题异常长的书能让
  // 每轮提示词膨胀到任意长度，而且完全不报错（Codex 逮到的）。
  const cut = (v, n) => { const x = String(v == null ? '' : v).trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
  let vol = '你们在读《' + cut(b.title, 40) + '》' + (b.author ? '（' + cut(b.author, 24) + '）' : '')
    + '，读到第 ' + (Number(b.chapter) || 0) + ' 章'
    + (b.chapters ? '（共 ' + b.chapters + ' 章）' : '') + '。\n';

  if (marks.length) {
    vol += '最近的划线，新的在前：\n';
    for (const m of marks) {
      const who = _crWho(m, conf);
      const when = _crWhen(m.at);
      const q = String(m.quote || '').trim();
      const n = String(m.note || '').trim();
      let line = '· ' + who + (when ? '（' + when + '）' : '');
      if (q) line += ' 划了「' + q + '」';
      if (n) line += (q ? '，写：' : ' 写了：') + n;
      // 先看加上这条会不会超，超了就不加 —— 原来是「加完才检查」，
      // 于是总会多放一整条出去，上限根本不硬。
      if (vol.length + line.length + 1 > COREAD_MAX_CHARS) { vol += '（更早的省略）\n'; break; }
      vol += line + '\n';
    }
  }
  // 这一句是给它的行为约束，不是背景：不写的话它会每轮都主动谈书。
  vol += '（这只是背景。她没提起书的时候别硬往这上面聊。）\n';

  // 兜底再切一刀。上面已经按行控制过了，这一刀防的是「将来又加了个字段
  // 忘了算进预算」—— 那种漏洞不会报错，只会让每轮提示词悄悄变长。
  if (vol.length > COREAD_MAX_CHARS + 120) vol = vol.slice(0, COREAD_MAX_CHARS + 120) + '…\n';

  return { stable, volatile: vol };
}

// ── 设置里那一节 ────────────────────────────────────────────
function toggleCoread(on) {
  if (typeof state !== 'object' || !state) return;
  state.coreadOn = !!on;
  try { save(); } catch {}
  if (on) coreadRefresh(true).then(coreadRenderStatus, coreadRenderStatus);
  else coreadRenderStatus();
}

// 状态必须分得清「没开」「连不上」「书架是空的」「拉到的太旧」——
// 这四种在界面上都长成「什么都没有」，混成一句的话根本没法排查。
function coreadRenderStatus() {
  const el = document.getElementById('coreadStatus');
  if (!el) return;
  const st = coreadStatus();
  el.textContent = st.msg;
  el.style.color = (st.k === 'ok') ? 'var(--accent)'
    : (st.k === 'fail' || st.k === 'stale') ? '#e07a7a' : 'var(--text-muted)';
  const box = document.getElementById('coreadToggle');
  if (box) box.checked = coreadEnabled();
}

function coreadSyncNow() {
  const el = document.getElementById('coreadStatus');
  if (el) el.textContent = '同步中…';
  coreadRefresh(true).then(coreadRenderStatus, coreadRenderStatus);
}

// 启动之后拉一次。**故意延后**：启动那一串 IDB 灌完之前 state 还没就位，
// 而且开机瞬间去撞一个可能没开的 server 只会白白拖慢首屏。
// 拉不到也无所谓 —— coreadPromptFor 每次被调用都会顺手再捅一下刷新。
if (typeof window !== 'undefined') {
  setTimeout(function () { try { coreadRefresh(true).then(coreadRenderStatus, function () {}); } catch (e) {} }, 4000);
}
