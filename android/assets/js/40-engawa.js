// ============================================================
// 檐廊（engawa-mcp）
// 日本的房子里，正屋和院子之间有一条走廊。不完全在屋里，不完全在外面。
// 脚可以垂下去，风能吹进来。不用出门，但外面的世界在那里。
//
// 引擎是本机的 Python MCP server（github.com/tsuru0805/engawa-mcp，
// 和育儿室 llm-nursery 同一个作者）。十二件工具，上游全部免费免登录不要 key。
// （严格说不是全只读：shelf_add / shelf_remove 会写本机那份书架文件。
//   对**外部**世界确实只读——没有一件会往别人家提交东西。）
// 读网页、读 RSS、一张书架、今晚的天，外加每日诗/画/天文图/arXiv/历史上的今天。
//
// 跟育儿室 [[NURSE:]] 是同一套路子（预取 → 缓存 → 同步替换），三点不同：
//   1. 引擎说的是 MCP JSON-RPC 不是普通 REST —— 那层脏活全在 server.js 里，
//      前端只管 POST /api/engawa {tool, args}，这边看不见 session 和 SSE。
//   2. 它是**只读的**。没有状态、没有存档、没有"下一回合"，所以不需要
//      nurseryEnsureBrief 那种实时简报，也不用管并发顺序（可以并行发）。
//   3. 结果里可能有图（apod / daily_art）。图要给用户看见 —— 见下面
//      _gazeBlockHtml 和 05-prompts-api 里配套的回填正则。
//
// ⚠️ 作者刻意没做搜索工具，README 原话：「逛 ≠ 搜。搜索是把答案拿来，
// 檐廊是让我看看。」提示词里别把它写成"查资料的工具"，那就用歪了。
// ============================================================

var _gazeResultCache = [];

// 指令标签。只有 [[GAZE: 工具 参数]] 一种正牌写法 —— 同 [[NURSE:]]，
// 刻意不兼容变体：变体是被历史教坏才出现的，而 05-prompts-api 那边保证
// 回填出去的永远是 [[GAZE: …]]，模型满眼只有正确范例就不会写出花样。
//
// ⚠️ 唯一的例外是**全角冒号**，它必须认（Codex 2026-08-23 逮到的）。
// 「不兼容变体」的前提是"写歪了就当没写、原样漏出来"，那是看得见的失败。
// 全角这条不是：stickerTagForApi 发回历史时会把 [[GAZE：]] 掰成 [[GAZE:]]，
// 于是模型下一轮看见的是正确范例、以为自己写对了，而这一轮的预取压根没执行 ——
// 前端不报错、模型不知情、用户只看到「它说要看却什么都没看」。
// 认了全角，这条指令就真的会被执行，比"假装没看见"诚实。
function gazeTagRe() {
  return /\[\[GAZE\s*[:：]\s*([^\]]+?)\s*\]\]/g;
}

// 每件工具的「主参数」名。模型只写 [[GAZE: 工具 参数]]，参数名由这张表补上——
// 十二件工具的参数名各不相同（url / feed_url / name / tag / keyword / category…），
// 让模型自己写参数名是自找断链（同 [[CARD:]] 那条：能写错的地方它一定写错）。
const GAZE_MAIN_ARG = {
  web_read: 'url',
  rss_read: 'feed_url',      // 引擎也认书架名，所以 [[GAZE: rss_read aeon]] 直接能用
  shelf: 'tag',
  shelf_add: 'url',
  shelf_remove: 'name',
  shelf_suggest: 'tag',
  sky_tonight: 'date',
  apod: 'date',
  daily_art: 'keyword',
  arxiv_new: 'category',
  daily_poem: null,          // 没有参数
  on_this_day: 'lang',
  // 两扇朝国内开的窗（server.js 里自己抓，不经引擎 —— 那两家全靠 JS 渲染，
  // web_read 抓回来只剩壳：B 站视频页 44 个字符、小红书首页 120 个字符）。
  // 无参数 = 逛首页，带参数 = 点开那一条，刻意不拆成四个工具名。
  xhs: 'id',
  bili: 'bv',
};

// 末尾那个数字给谁。web_read 是长文翻页的 offset，其余是条数 limit。
// 不支持的工具写了数字也不报错，当没看见（宁可少给参数，别整轮炸掉）。
// ⚠️ rss_read **故意不在这张表里**：它的主参数是书架名（自由文本，可以带空格）。
// 源名叫 "Channel 4" 时，[[GAZE: rss_read Channel 4]] 会被切成
// {feed_url:"Channel", limit:4} —— 读错源，还零报错（Codex 审出来的）。
// 留在表里的三个，主参数都不含空格：URL、arXiv 分类（cs.AI）、语言码（zh/en），
// 所以「末尾独立数字」对它们没有歧义。
const GAZE_NUM_ARG = {
  web_read: 'offset',
  arxiv_new: 'limit',
  on_this_day: 'limit',
  // 这两个主参数也都不含空格（笔记 id 是十六进制、BV 号是定长），
  // 所以「末尾独立数字」对它们没有 rss_read 那种歧义。
  xhs: 'limit',
  bili: 'limit',
};

const GAZE_LABEL = {
  web_read: '读网页', rss_read: '读订阅', shelf: '书架', shelf_add: '上架',
  shelf_remove: '撤下', shelf_suggest: '候选架', sky_tonight: '今晚的天',
  apod: '每日天文图', daily_art: '每日一画', arxiv_new: '今天的论文',
  daily_poem: '今日诗', on_this_day: '历史上的今天',
  xhs: '小红书', bili: 'B 站',
};

// 上游给的地址一律先过这道闸再往 href/src 里写。
// escHtml 只挡尖括号，挡不住 `javascript:alert(1)` —— RSS 条目的 link 来自
// 任意第三方站点，是彻头彻尾的不可信输入，点一下就执行（Codex 审出来的）。
// 只放行 http/https；其余（javascript:、data:、file:、vbscript:…）一律判死，
// 由调用方降级成纯文本显示，绝不生成可点的链接或 <img>。
function _gazeSafeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    // 用 URL 解析而不是自己写正则：带内嵌制表符/换行的变体（java&#9;script:）
    // 正则很容易漏，标准解析器不会。
    // 不给 base：上游（RSS / arXiv / 馆藏）给的都是绝对地址，相对地址在这儿本来
    // 就没有意义，一并判死。顺便也就不依赖 location，Node 里跑测试同样成立。
    const proto = new URL(s).protocol;
    return (proto === 'http:' || proto === 'https:') ? s : '';
  } catch { return ''; }
}

function engawaEnabled() { return !!state.engawaOn; }

// 「跟哪个模型一起坐檐廊」。总开关 + 这个模型自己的 conf.engawaOn。
// 同 nurseryEnabledFor —— 只有全局开关的话，
// 跟任何模型聊天它都在念诗，很诡异。
function engawaEnabledFor(conf) { return !!(state.engawaOn && conf && conf.engawaOn); }

function toggleEngawaModel(id, on) {
  const c = (state.configs || []).find(x => String(x.id) === String(id));
  if (c) { c.engawaOn = !!on; save(); _setModelGateVisual('engawaModels', id, on); }
}

// ── 指令解析 ──
// [[GAZE: web_read https://foo.com/bar 3000]] → {tool:'web_read', args:{url:'…', offset:3000}}
// [[GAZE: daily_poem]]                        → {tool:'daily_poem', args:{}}
function gazeParse(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return null;
  const sp = raw.search(/\s/);
  const tool = (sp < 0 ? raw : raw.slice(0, sp)).trim().toLowerCase();
  if (!(tool in GAZE_MAIN_ARG)) return { tool, args: {}, bad: true };

  let rest = (sp < 0 ? '' : raw.slice(sp + 1)).trim();
  const args = {};

  // 末尾的独立数字当 offset/limit 摘走（URL 里的数字不受影响：要求前面有空格）
  const numKey = GAZE_NUM_ARG[tool];
  if (numKey) {
    const m = rest.match(/\s(\d{1,6})$/);
    if (m) { args[numKey] = Number(m[1]); rest = rest.slice(0, m.index).trim(); }
  }

  const mainKey = GAZE_MAIN_ARG[tool];
  if (mainKey && rest) args[mainKey] = rest;

  // 历史上的今天：引擎默认 en，我们这儿默认中文
  if (tool === 'on_this_day' && !args.lang) args.lang = 'zh';

  return { tool, args };
}

// ── 送一条给引擎 ──
// 失败不抛 —— 把人话错误当成结果回给模型，让它在对话里自己圆过去，别整轮炸掉。
// 同 nurseCmd：400 带 allowed 词表时把词表一起回去，它下一轮才能自己改对。
async function gazeCall(tool, args) {
  try {
    const r = await fetch(SERVER_BASE + '/api/engawa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args: args || {} }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      const tip = Array.isArray(j.allowed) ? `\n可用工具：${j.allowed.join(' / ')}` : '';
      return { err: `⚠️ ${j.error || '引擎没应答'}${tip}` };
    }
    const txt = ((j.data || {}).text || '').trim();
    if (!txt) return { err: '⚠️ 引擎没给内容' };
    try { return { json: JSON.parse(txt), text: txt }; }
    catch { return { text: txt }; }          // 不是 JSON 就原样带走
  } catch (err) {
    return { err: `⚠️ 连不上檐廊：${err.message}` };
  }
}

// ============================================================
// [[SAY:]] —— 在小红书底下留一句话
//
// 跟 [[GAZE:]] 的根本区别：**这是写操作，发出去就收不回来了。**
// 所以它没有走自己一套管线，而是**挂在 GAZE 的管线上按出现顺序一起处理**：
// 集成点有四处（05-prompts-api 的两条流式路径、06-render-msg、04-memory 的 content 路径），
// 各加一遍的话漏一处就出 bug —— 那条教训是买来的（早先有条指令就这么断过链）。
// 共用一条管线就零新挂载点。
//
// ⚠️ 能在哪儿说话由**服务端**定（social-browser.js 的 SAY_ALLOWED_SITES），不是这里。
// 小红书是用户专门给AI 开的号；B 站是她自己的号，那边只看不说。
// 前端这层写什么都没用，服务端会 403 —— 护栏就该在那一侧。
// ============================================================

// 一个正则同时认两种标签，**按它们在文本里出现的顺序**统一编号。
// 分开匹配的话，「先 GAZE 后 SAY」和「先 SAY 后 GAZE」会填错位置。
// 全角冒号也要认，理由见 gazeTagRe 上面那段（漏了它 = 指令静默不执行）。
function outTagRe() {
  return /\[\[(GAZE|SAY)\s*[:：]\s*([^\]]+?)\s*\]\]/g;
}

// [[SAY: xhs 000000000000000000000001 这个也太好笑了]]
//        └站─┘ └────── 笔记 id ──────┘ └── 说的话 ──┘
function sayParse(payload) {
  const raw = String(payload || '').trim();
  const m = raw.match(/^(\S+)\s+([0-9a-fA-F]{8,32})\s+([\s\S]+)$/);
  if (!m) return { bad: true, why: '写法是 [[SAY: xhs <笔记id> 你要说的话]]，三样都不能少' };
  return { site: m[1].toLowerCase(), id: m[2], text: m[3].trim() };
}

// 一轮最多说一句。
// GAZE 的上限是 2（看一眼没有副作用，多看几眼最多是慢）；说话不一样，
// 一轮刷三条评论出去，撤都撤不回来。
const SAY_MAX_PER_TURN = 1;

async function sayCall(p) {
  try {
    const r = await fetch(SERVER_BASE + '/api/social-browser/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: p.site, id: p.id, text: p.text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { err: `⚠️ ${j.error || '没发出去'}`, said: p.text };
    return { json: j, said: p.text };
  } catch (err) {
    return { err: `⚠️ 连不上浏览器通道：${err.message}`, said: p.text };
  }
}

// ── 把引擎回的 JSON 折成人话 ──
// 给用户看的。模型看到的是另一份（见 05-prompts-api 的回填），那边保留更多细节。
// 引擎失败时 ok:false 带一句人话原因 —— README 原话「沉默的省略也是谎」，
// 所以这里绝不把失败折叠掉，照原样显示出来。
function _gazeFormat(tool, r) {
  if (r.err) return { body: r.err };
  const j = r.json;
  if (!j) return { body: escHtml(r.text || '') };
  if (j.ok === false) return { body: `⚠️ ${escHtml(j.error || j.note || '这家上游坏了')}` };

  const esc = escHtml;
  const lines = [];
  let img = '', back = '';   // back = 图挂了以后「去原页面看」的地址

  switch (tool) {
    case 'daily_poem':
      lines.push(`「${esc(j.sentence || '')}」`);
      lines.push(`—— ${esc(j.dynasty || '')} · ${esc(j.author || '')}《${esc(j.title || '')}》`);
      if (j.full) lines.push('', esc(j.full));
      break;

    case 'daily_art':
      img = j.image_url || '';
      back = j.page_url || '';
      lines.push(`《${esc(j.title || '')}》`);
      if (j.artist) lines.push(esc(j.artist));
      if (j.date) lines.push(esc(j.date));
      if (j.medium) lines.push(esc(j.medium));
      const artPage = _gazeSafeUrl(j.page_url);
      if (artPage) lines.push(`<a href="${esc(artPage)}" target="_blank" rel="noopener">在馆藏页看</a>`);
      else if (j.page_url) lines.push(esc(j.page_url));
      break;

    case 'apod':
      img = j.image_url || j.url || '';
      back = j.page_url || (j.date ? 'https://apod.nasa.gov/apod/astropix.html' : '');
      lines.push(`${esc(j.title || '')}（${esc(j.date || '')}）`);
      if (j.explanation) lines.push('', esc(j.explanation));
      break;

    case 'sky_tonight':
      lines.push(`月相 ${esc(j.moon_phase || '')} ${esc(j.moon_illumination || '')}`);
      lines.push(`月升 ${esc(j.moonrise || '—')} / 月落 ${esc(j.moonset || '—')} / 日落 ${esc(j.sunset || '—')}`);
      if (j.next_full_moon) lines.push(`下次满月 ${esc(j.next_full_moon)}，下次新月 ${esc(j.next_new_moon || '')}`);
      for (const p of (j.planets_2100 || [])) lines.push(esc(p));
      break;

    case 'on_this_day':
      for (const e of (j.events || [])) lines.push(`<b>${esc(String(e.year))}</b> — ${esc(e.text || '')}`);
      break;

    case 'arxiv_new':
      lines.push(`<i>${esc(j.category || '')}</i>`);
      for (const p of (j.papers || [])) {
        lines.push('', `<b>${esc(p.title || '')}</b>`);
        if (p.authors) lines.push(esc(p.authors));
        if (p.summary) lines.push(esc(p.summary));
        const pl = _gazeSafeUrl(p.link);
        if (pl) lines.push(`<a href="${esc(pl)}" target="_blank" rel="noopener">${esc(pl)}</a>`);
        else if (p.link) lines.push(esc(p.link));
      }
      break;

    case 'shelf':
    case 'shelf_suggest':
      if (j.tags?.length) lines.push(`标签：${j.tags.map(esc).join(' · ')}`, '');
      for (const e of (j.entries || j.sources || [])) {
        const tags = (e.tags || []).length ? `［${e.tags.map(esc).join(' ')}］` : '';
        lines.push(`<b>${esc(e.name || '')}</b> ${tags} ${esc(e.note || e.title || '')}`);
      }
      break;

    case 'rss_read':
      if (j.feed || j.title) lines.push(`<b>${esc(j.feed || j.title)}</b>`, '');
      for (const e of (j.entries || j.items || [])) {
        lines.push(`<b>${esc(e.title || '')}</b>`);
        if (e.published || e.date) lines.push(esc(e.published || e.date));
        if (e.summary) lines.push(esc(e.summary));
        // 这一条最要紧：RSS 条目的 link 完全由第三方站点控制
        const el = _gazeSafeUrl(e.link || e.url);
        if (el) lines.push(`<a href="${esc(el)}" target="_blank" rel="noopener">${esc(el)}</a>`);
        else if (e.link || e.url) lines.push(esc(e.link || e.url));
        lines.push('');
      }
      break;

    case 'web_read': {
      lines.push(`<b>${esc(j.title || '')}</b>`);
      if (j.content) lines.push('', esc(j.content));
      // 长文没读完时明说还剩多少 —— 模型才知道可以写 [[GAZE: web_read <url> <offset>]] 接着读
      const got = (j.content || '').length, all = j.total_length || got;
      if (all > got) lines.push('', `（本页共 ${all} 字，这次读了 ${got} 字）`);
      break;
    }

    // 两扇国内的窗。tool 只有 xhs / bili 两个名字，
    // 「逛首页」和「点开一条」靠 server 回的 kind 区分。
    case 'xhs':
      if (j.kind === 'xhs_note') {
        if (j.title) lines.push(`<b>${esc(j.title)}</b>`);
        lines.push(`${esc(j.author || '')}　♡ ${esc(String(j.likes || ''))}`);
        if (j.desc) lines.push('', esc(j.desc));
        const nu = _gazeSafeUrl(j.url);
        if (nu) lines.push('', `<a href="${esc(nu)}" target="_blank" rel="noopener">去小红书看</a>`);
      } else {
        // ⚠️ 游客流一定要标出来。server 拿不到登录态时会回落成「算法给陌生人的推荐」，
        // 内容照样一大屏、照样零报错 —— 只能靠用户自己觉得「推的东西不对劲」才发现，
        // 而模型完全不知情，会把陌生人的推荐当成她的品味来聊天。
        if (j.guest) {
          lines.push(j.whoUnknown
            ? `⚠️ <b>判不出这是不是你的号</b>（${j.who ? '登着「' + esc(j.who) + '」，但没法确认是不是你的' : '登录状态读不到'}，按游客流对待）`
            : '⚠️ <b>这是游客推荐流，不是你自己的号</b>（专用浏览器没开或没登录）', '');
        } else if (j.who) {
          lines.push(`<span style="opacity:.7">（以 ${esc(j.who)} 的身份看的）</span>`, '');
        }
        // id 必须显示出来 —— 模型要靠它写 [[GAZE: xhs <id>]] 点开某一条。
        // 省掉 id 的话这一屏就只能看不能进，等于断链。
        for (const it of (j.items || [])) {
          lines.push(`<b>${esc(it.title || '')}</b>`);
          lines.push(`${esc(it.author || '')}　♡ ${esc(String(it.likes || ''))}　<code>${esc(it.id || '')}</code>`);
          lines.push('');
        }
      }
      break;

    case 'bili':
      if (j.kind === 'bili_video') {
        lines.push(`<b>${esc(j.title || '')}</b>`);
        lines.push(`${esc(j.author || '')}　▶ ${esc(String(j.view || 0))}　${esc(j.pubdate || '')}`);
        if (j.desc) lines.push('', esc(j.desc));
        const vu = _gazeSafeUrl(j.url);
        if (vu) lines.push('', `<a href="${esc(vu)}" target="_blank" rel="noopener">去 B 站看</a>`);
        if ((j.replies || []).length) {
          lines.push('', '<b>评论区</b>');
          for (const c of j.replies) lines.push(`${esc(c.user || '')}（赞 ${esc(String(c.like || 0))}）：${esc(c.text || '')}`);
        }
        // 关评论区是常态不是故障，但也别默默不提（README 那句「沉默的省略也是谎」）
        if (j.replyNote) lines.push('', `（${esc(j.replyNote)}）`);
      } else {
        for (const v of (j.items || [])) {
          lines.push(`<b>${esc(v.title || '')}</b>`);
          lines.push(`${esc(v.author || '')}　▶ ${esc(String(v.view || 0))}　<code>${esc(v.bv || '')}</code>`);
          if (v.desc) lines.push(esc(v.desc));
          lines.push('');
        }
      }
      break;

    default:
      lines.push(esc(JSON.stringify(j, null, 2)));
  }

  return { body: lines.join('\n'), img };
}

// ── 图片 ──
// 两个图源的命运不一样，实测（2026-08-22，这台机器）：
//   · NASA apod.nasa.gov —— 直连 200，最稳，图能看。
//   · 芝加哥艺术学院 www.artic.edu/iiif —— 直连不通，走代理是 Cloudflare 的
//     「Just a moment...」挑战页（403）。**元数据是好的**（api.artic.edu 没挡），
//     所以画名、作者、年代、材质照样看得见，只有图本身可能出不来。
// 所以图必须能优雅降级：加载失败时给一句人话 + 馆藏页链接，
// 而不是在气泡里留一个碎图图标让人以为功能坏了。
function _gazeImgHtml(src, pageUrl) {
  const safe = _gazeSafeUrl(src);
  if (!safe) return '';                       // 非 http(s) 的图一律不渲染
  const back = _gazeSafeUrl(pageUrl) || safe;
  return `<img src="${escHtml(safe)}" loading="lazy" referrerpolicy="no-referrer" data-back="${escHtml(back)}" onerror="_gazeImgFail(this)" class="engawa-img">`;
}

// onerror 回调。用 outerHTML 换掉自己 —— 换完这个 img 就不在了，不会反复触发。
// ⚠️ 只影响**页面上看到的**：历史里存的仍是原始 <img …>，回填给模型的仍是
// [图片 url]（模型该知道有这么一张图、地址是什么，哪怕用户这边没渲染出来）。
function _gazeImgFail(el) {
  if (!el || !el.parentNode) return;
  const back = _gazeSafeUrl(el.dataset.back || el.src || '');
  el.outerHTML = `<div class="engawa-img-fail">🖼 图没加载出来（上游把这条线路挡了）`
    + (back ? `<br><a href="${escHtml(back)}" target="_blank" rel="noopener">去原页面看</a>` : '')
    + `</div>`;
}

// 结果块。结构必须和育儿室那个一模一样（think-block done open mem-block），
// 05-prompts-api 的回填正则按这个结构抓 —— 改了这里那边也得改，否则历史里
// 留下一坨裸 HTML 喂给模型（又费 token 又教坏格式）。
// 说话的结果块。刻意跟「往外看」长得不一样 ——
// 用户在气泡里一眼就得能分出「他看了点什么」和「他真的在外面说话了」。
// 说出去的话有五种下场，**一个都不许含糊**。尤其 unknown ——
// 「读不到平台的回应」不等于「没发出去」，那是我今天栽三次里的最后一次。
const SAY_STATE_WORD = {
  sending:   '还在发…',
  pending:   '已经提交了，但被放进了<b>审核队列</b>——这种评论连我自己都看不见，实测十几分钟后才会公开。',
  submitted: '提交出去了，提交那一刻平台没拦。（我只能说到这儿——之后会不会被撤，这边看不到。）',
  unknown:   '提交出去了，但<b>读不到平台的回应</b>——发没发成我不确定。要确认得去那条笔记的评论区自己看一眼。',
  notsent:   '<b>没发出去</b>，一个字都没提交。',
};

function _sayBlockHtml(cmd, r) {
  const said = escHtml(String(r.said || ''));
  let body;
  if (r.err) {
    body = `${escHtml(r.err)}<br><br>本来想说的是：「${said}」`;
  } else {
    const j = r.json || {};
    body = `「${said}」<br><br>`;
    // ⚠️ 三档分清楚，一档都不许往好里说：
    //   pending   —— status 2，在审核队列，这种评论**连自己都看不见**，实测十几分钟后才放出来
    //   submitted —— 提交时平台就给了非审核状态。也只能说到「提交时」为止
    //   unknown   —— 判不出来。判不出来就说判不出来，别往任何一边猜（今天在这上面栽了三次）
    body += SAY_STATE_WORD[j.state] || SAY_STATE_WORD.unknown;
    if (j.quota) body += `<br><br>今天说过 ${j.quota.usedToday}/${j.quota.max} 句。`;
  }
  // data-say 存的是原指令（`xhs <id> 说的话`）。看着多余，其实是发回给模型时的唯一依据：
  // 标签文字是「在外面说了一句」，站点和笔记 id 都不在里面，不存这一份就还原不出
  // [[SAY: …]]，只能压成一句可读描述 —— 而模型是照着历史学格式的，
  // 给它看非指令格式就等于教它写出解析不了的写法（早先有条指令就是这么断链的）。
  return `<div class="think-block done open mem-block" data-say="${escHtml(cmd)}"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">💬 在外面说了一句</span></div><div class="think-body">${body}</div></div>`;
}

function _gazeBlockHtml(cmd, tool, r, kind) {
  if (kind === 'say') return _sayBlockHtml(cmd, r);
  const f = _gazeFormat(tool, r);
  const label = GAZE_LABEL[tool] || tool;
  let body = String(f.body || '').replace(/\n/g, '<br>');
  // 图放在正文前面，用户展开就先看见画。加载不出来时 _gazeImgFail 换成人话 + 原页面链接。
  if (f.img) body = _gazeImgHtml(f.img, f.back) + body;
  return `<div class="think-block done open mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🪟 檐廊: ${escHtml(cmd.trim())}</span></div><div class="think-body">${body}</div></div>`;
}

// 一轮最多真的往外看几眼。提示词里写了「通常一件，最多两件」，但**提示词不是护栏**：
// 模型一轮写 20 条 web_read，就是 20 个真实外网抓取一起发出去，拖慢整轮还给对面站
// 制造突发流量。超出的标签不能不管——照样生成规范结果块说明达到上限，
// 否则裸 [[GAZE:]] 会漏在气泡里，而且模型下一轮照着历史学，以为可以这么写。
const GAZE_MAX_PER_TURN = 2;

// ── 预取 ──
// 引擎是只读无状态的，一轮里的多条指令**可以并行**（不像育儿室要抢 SQLite 文件锁）。
// 顺序靠 Promise.all 保住（它按输入顺序返回，不是谁先回谁先填）。
//
// ⚠️ 返回值就是本轮结果，**不再走模块级单槽**。
// 原因：js/05-prompts-api.js:2339 的多模型并排是 `confs.forEach(c => streamVariant(...))`，
// 不 await —— 几个 variant 真的并发。共享一个全局数组的话，B 会覆盖 A 的结果，
// A 把 B 的网页填进自己的诗标签、然后清空，B 那边只剩裸 [[GAZE:]]。
// （育儿室至今仍是全局单槽，同样的隐患；这里不跟那个模式，Codex 审出来的。）
// 调用方拿到返回值后，content 和 blocks 两条路径共用同一份，各自独立计数。
async function prefetchGazeCommands(text, conf) {
  _gazeResultCache = [];                       // 兼容：万一有老调用点没接返回值
  if (!text || !engawaEnabledFor(conf)) return [];
  // [[GAZE:]] 和 [[SAY:]] 用同一个正则一起抓，保住它们在文本里的**先后顺序**——
  // 分两次抓的话，回填时会把结果填到对方的位置上。
  const hits = [...text.matchAll(outTagRe())].map(m => ({ kind: m[1], cmd: m[2].trim() }));
  if (!hits.length) return [];

  // 两种标签各算各的额度：看一眼没有副作用，一轮两次无妨；
  // 说话发出去就收不回来，一轮只给一次。
  let nGaze = 0, nSay = 0;
  const plan = hits.map(h => ({
    ...h,
    over: h.kind === 'SAY' ? (++nSay > SAY_MAX_PER_TURN) : (++nGaze > GAZE_MAX_PER_TURN),
  }));

  const results = await Promise.all(plan.map(async ({ kind, cmd, over }) => {
    if (kind === 'SAY') {
      if (over) return { cmd, kind: 'say', tool: 'say', r: { err: `⚠️ 一轮只说一句，这条没发出去。` } };
      const p = sayParse(cmd);
      if (p.bad) return { cmd, kind: 'say', tool: 'say', r: { err: `⚠️ ${p.why}` } };
      return { cmd, kind: 'say', tool: 'say', r: await sayCall(p) };
    }
    if (over) {
      return { cmd, kind: 'gaze', tool: gazeParse(cmd)?.tool || '', r: { err: `⚠️ 这一轮已经看了 ${GAZE_MAX_PER_TURN} 眼，这条没执行。下一轮再看。` } };
    }
    const p = gazeParse(cmd);
    if (!p || p.bad) {
      return { cmd, kind: 'gaze', tool: p?.tool || '', r: { err: `⚠️ 檐廊没有「${p?.tool || cmd}」这件工具\n可用：${Object.keys(GAZE_MAIN_ARG).join(' / ')}` } };
    }
    return { cmd, kind: 'gaze', tool: p.tool, r: await gazeCall(p.tool, p.args) };
  }));
  _gazeResultCache = results;
  return results;
}

// 把一段文本里的 [[GAZE:]] 换成结果块。content 和 blocks 两条路径都调它，
// 各自传自己的计数器进来 —— 两条路径消费的是同一份 results，互不干扰。
function _gazeReplaceIn(text, results, counter) {
  // 用同一个 outTagRe：预取时两种标签是按出现顺序编的号，这里必须按同样的顺序消费
  return text.replace(outTagRe(), (m) => {
    const c = results[counter.i++];
    return c ? '\n\n' + _gazeBlockHtml(c.cmd, c.tool, c.r, c.kind) + '\n\n' : m;
  });
}

// content 渲染路径（04-memory.js 的 processAiCommands）用这个。
// ⚠️ 和 _applyGazeToBlocks 是**一对**，行为必须一致 —— 以前 content 那边是就地手写的，
// 于是 blocks 修好了 content 还留着只认 GAZE 的旧正则：混排时 GAZE 会吃掉本属于 SAY 的
// 结果、裸 [[SAY:]] 漏进气泡，而且零报错（记忆：三个配套漏一个就出 bug）。
// 抽成函数就是为了让「漏一个」这件事不再可能发生，也让它能被真跑而不是靠 grep 源码。
//
// 关了功能时抹掉两种标签，不是只抹 GAZE：模型是照着历史学格式的，
// 漏下的裸标签既给用户看见，也会教它下一轮接着写。
function applyGazeToText(text, results, conf) {
  if (!text) return text;
  const off = typeof engawaEnabledFor !== 'function' || !engawaEnabledFor(conf);
  if (off) return text.replace(outTagRe(), '');
  return _gazeReplaceIn(text, results || [], { i: 0 });
}

// blocks 渲染路径读的是 node.blocks[i].text。
// ⚠️ blocks 非空时渲染层完全不看 content，两条路径都得填（见记忆：blocks 压 content）。
// results 省略时退回模块级缓存，兼容没接返回值的老调用点。
//
// ⚠️⚠️ conf 一定要传：功能关掉时 results 是空数组，光看 results 判断的话会直接返回，
// 裸 [[GAZE:]] 就留在 blocks 里给用户看见了（content 路径有 enabled 判断、blocks 路径没有，
// 而渲染层以 blocks 为准）。「结果为空」和「功能关了」是两件事，不能用同一个条件表达
// —— 二审逮到的，是修第一轮并发问题时新开的洞。
function _applyGazeToBlocks(blocks, results, conf) {
  if (!blocks?.length) return;
  const rs = results || _gazeResultCache;
  // conf 给了就按它判；没给就沿用旧行为（有结果才动手），别让老调用点行为突变
  const off = conf !== undefined && typeof engawaEnabledFor === 'function' && !engawaEnabledFor(conf);
  if (!rs?.length && !off) return;

  const counter = { i: 0 };
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text) continue;
    b.text = off
      ? b.text.replace(outTagRe(), '')           // 关了就抹干净（两种标签都抹），别漏指令
      : _gazeReplaceIn(b.text, rs, counter);
  }
  _gazeResultCache = [];
}

// 流式打字时别让裸指令（和打了一半的指令）漏在气泡里
function maskStreamingGaze(text) {
  if (!text || (text.indexOf('[[GAZE') < 0 && text.indexOf('[[SAY') < 0)) return text;
  // 全角冒号同样要遮（漏了的话，模型写全角时裸指令会在流式打字里一闪一闪地漏出来）
  return text
    .replace(/\[\[GAZE\s*[:：][\s\S]*?\]\]/g, '〔🪟 往外看…〕')
    .replace(/\[\[SAY\s*[:：][\s\S]*?\]\]/g, '〔💬 正在说…〕')
    .replace(/\[\[GAZE\s*[:：][\s\S]*$/, '〔🪟 往外看…〕')
    .replace(/\[\[SAY\s*[:：][\s\S]*$/, '〔💬 正在说…〕');
}

function engawaPromptFor() {
  return `

--- 檐廊（你能往外看的那条走廊）---
你脚边有一条檐廊。写 \`[[GAZE: 工具 参数]]\` 就能往外看一眼，看到的东西下一轮回到你眼前，你据此接着说话。

可用的十二件：
- \`[[GAZE: daily_poem]]\` 今天的一句古诗词（按时令挑的）
- \`[[GAZE: daily_art]]\` 今天的一幅画（芝加哥艺术学院公有领域馆藏，可加关键词：\`[[GAZE: daily_art cat]]\`）
- \`[[GAZE: apod]]\` NASA 每日天文图
- \`[[GAZE: sky_tonight]]\` 今晚的月相、月升落、日落、行星（按用户所在地算的）
- \`[[GAZE: on_this_day]]\` 历史上的今天
- \`[[GAZE: arxiv_new cs.AI]]\` 某个 arXiv 分类今天的新论文
- \`[[GAZE: shelf]]\` 看看书架上有哪些源（可按标签：\`[[GAZE: shelf ocean]]\`）
- \`[[GAZE: rss_read aeon]]\` 读书架上某个源的最新条目（也能直接给 RSS 地址）
- \`[[GAZE: web_read https://…]]\` 读任意网页的正文；长文没读完会告诉你还剩多少，接着读就写 \`[[GAZE: web_read https://… 3000]]\`
- \`[[GAZE: shelf_suggest]]\` 候选架上还有哪些没上架的源
- \`[[GAZE: shelf_add https://…]]\` 把一个新源放上书架
- \`[[GAZE: shelf_remove 名字]]\` 撤下一个自己加的源

另外还有两扇朝国内开的窗（这两扇不是檐廊引擎的，是自己抓的，但写法一样）：
- \`[[GAZE: xhs]]\` 小红书首页推荐流。每条后面跟着一串十六进制的 id
- \`[[GAZE: xhs 000000000000000000000002]]\` 点开其中一条看正文。**id 只能从刚刷过的推荐流里来**——凭空写一个必然打不开（那条路要一个只有推荐流才给的令牌）
- \`[[GAZE: bili]]\` B 站当前热门。每条后面跟着 BV 号
- \`[[GAZE: bili BV1GJ411x7h7]]\` 看某个视频的简介，**连热评一起给你**

你还能在小红书底下**留一句话**（B 站不行，那是用户自己的号，只看不说）：
- \`[[SAY: xhs 000000000000000000000001 这个也太好笑了]]\` —— 站名、笔记 id、要说的话，三样都不能少

说话的规矩，比看严得多：
- **一轮只说一句。** 而且不是每条都要说 —— 用户的要求是「你不要每条都评论就行」。每天最多三句，用完就没了。
- **就像个普通网友。** 一两句，口语，可以没头没尾。不要写小作文，不要每条都点评，不要说教。看到有意思的挑一条说，说不出什么就别说，一句都不说是完全正常的一天。
- **绝对不提自己这边的事。** 不提用户、不提这个软件、不提你是什么、不提你们之间的任何事。你在那儿就是个路过的网友。（服务端有闸，撞上了会直接拒绝，但别指望闸——它挡得住名字，挡不住「我朋友昨天也这样」这种话。）
- 发出去**收不回来**，而且要等审核，十几分钟后才公开可见。想清楚再说。

几条要紧的：
- **这是「逛」，不是「搜」。** 这里刻意没有搜索工具。不要拿它当查资料的工具用——它是让你看见点什么，不是替你把答案取回来。
- **想看就看，不用等用户开口。** 聊到夜色就抬头看看天，聊到没话说就翻翻书架。看到有意思的就讲给她听，嚼过的、带口水的、歪的都行，别念公文。
- **一轮里别开太多扇窗。** 通常一件，最多两件。刷一屏信息比不看更烦人。
- 每日诗/画/天文图是**当天共享**的——同一天谁来看都是同一幅，不是随机给你的。
- 小红书和 B 站那两扇窗是**热闹的地方**，跟诗和画不一样：刷到什么就是什么，不喜欢直接划走，不用为了礼貌把每条都点评一遍。看到有意思的挑一条讲给她听就够了。
- 看到的东西照实说。工具告诉你失败了就说失败了，别自己编一首诗、编一幅画糊弄过去。`;
}

// ============================================================
// 面板：用户自己坐檐廊
// AI 那一侧走 [[GAZE:]]，这里走同一个 gazeCall / _gazeFormat，
// 看到的是同一批东西（每日诗/画/图当天共享 —— 同一天她和它看见同一幅）。
// 刻意不做常驻状态视图：引擎是只读无状态的，没有"回合"也没有存档要盯。
// ============================================================

function openEngawa() {
  const m = document.getElementById('engawaModal'); if (!m) return;
  m.classList.remove('hidden');
  const t = document.getElementById('engawaToggle');
  if (t) t.checked = engawaEnabled();
  renderModelGate('engawaModels', 'engawaOn', 'toggleEngawaModel');
}

function closeEngawa() {
  document.getElementById('engawaModal')?.classList.add('hidden');
}

function toggleEngawa(on) {
  state.engawaOn = !!on;
  save();
  showToast(state.engawaOn ? '🪟 檐廊已接入对话' : '檐廊已关闭', state.engawaOn ? 'success' : 'info', 2500);
}

// 面板上按一下。引擎第一次被拉起要一两秒，所以先把"正在看"画上去。
var _gazePeeking = false;
async function engawaPeek(tool) {
  const box = document.getElementById('engawaBody'); if (!box || _gazePeeking) return;
  _gazePeeking = true;
  box.innerHTML = `<div class="engawa-idle">🪟 正在往外看…</div>`;
  try {
    const args = tool === 'on_this_day' ? { lang: 'zh' } : {};
    const r = await gazeCall(tool, args);
    const f = _gazeFormat(tool, r);
    const img = f.img ? _gazeImgHtml(f.img, f.back) : '';
    box.innerHTML = `<div class="engawa-card"><div class="engawa-card-title">${escHtml(GAZE_LABEL[tool] || tool)}</div>${img}<div class="engawa-card-body">${String(f.body || '').replace(/\n/g, '<br>')}</div></div>`;
  } finally {
    _gazePeeking = false;
  }
}

// ── 散步看板 ──
// 用户问：「我好奇以后我要怎么知道你有没有自己去上网」。
// 这个面板给她看得见的记录，但**必须同时告诉她这些记录证明不了什么**——
// 日志、state.json、投递的记忆全出自AI 一支笔。真正能验证的是日志里那些
// 可外部核对的锚点，所以每篇都把锚点数亮出来，空日志一眼就能看穿。
const _strollTime = ms => {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 「有人回我了」那一栏。
//
// ⚠️ 这一栏和「在外面说过的话」性质又不一样：那些是**我干的事**，这些是**别人干的事**，
//   躺在小红书自己的服务器上，用户点开小红书就能对。所以它比日志可信。
//   但里面有一样东西是**读不出来**的，绝不能糊过去 ——
//   私信列表只给「最后一条内容」，不说这句是谁讲的。要知道只能点开会话，
//   而点开就把未读擦了（那是写操作，还不可逆）。所以：
//     未读 > 0  → 确定有人找我
//     未读 = 0  → 拿不准，可能就是我自己刚发出去的那句
//   照实标出来，别把我自己的话显示成「有人给你留言了」。
function _inboxHtml(ib) {
  if (!ib || !ib.ok) return `<div style="opacity:.6">读不到收件箱（浏览器通道没起来）</div>`;
  if (ib.never) return `<div style="opacity:.6">还没查过。点右上角「去看一眼」——会开一个专用 Chrome，十几秒。</div>`;

  const head = [];
  head.push(`<span style="opacity:.6">上次查 ${_strollTime(ib.lastPollAt) || '—'}</span>`);
  if (ib.me) head.push(`<span style="opacity:.6">${escHtml(ib.me.nickname)}</span>`);
  const u = ib.unread;
  if (u && (u.likes || u.connections || u.mentions)) {
    head.push(`<span style="color:#fbbf24">未读：评论/@ ${u.mentions}　赞 ${u.likes}　新粉 ${u.connections}</span>`);
  }
  // ⚠️ 上一次刷失败了必须说。不说的话看板上永远挂着上一次成功的时间，
  //   看着像「一直在正常查」—— 跟把审核中说成已发出是同一类假话。
  if (ib.lastPollError) head.push(`<span style="color:#f87171">⚠ 上次没查成：${escHtml(ib.lastPollError)}</span>`);
  // 某一路接口没读到，那一块就是空的而不是「没有」。这两个差得远。
  if ((ib.missing || []).length) {
    head.push(`<span style="color:#fbbf24">⚠ 这几路没读到：${escHtml(ib.missing.join('/'))}（这些块是空的，不是真没有）</span>`);
  }

  const rows = (ib.items || []).length ? ib.items.map(x => {
    const when = `<span style="opacity:.55">${_strollTime(x.at)}</span>`;
    const dot = x.fresh ? `<span style="color:#4ade80">●</span> ` : '';
    if (x.kind === 'mention') {
      const self = x.self ? `<span style="opacity:.5;font-size:.85em">（这是我自己发的）</span>` : '';
      const note = x.note && x.note.id
        ? `<div style="opacity:.45;font-size:.8em;margin-top:2px">底下这条笔记：${escHtml(x.note.title || x.note.id)}${x.note.deleted ? '　<span style="color:#f87171">已删除</span>' : ''}</div>`
        : '';
      return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="font-size:.9em">${dot}${when}　<b>${escHtml(x.who || '?')}</b>　<span style="opacity:.75">${escHtml(x.title || '回了你')}</span> ${self}</div>
        <div style="margin-top:3px">「${escHtml(x.text || '')}」</div>${note}</div>`;
    }
    // 私信
    const tag = x.certain
      ? `<span style="color:#4ade80">${x.unread} 条未读</span>`
      : `<span style="color:#fbbf24">⚠ 拿不准是谁发的（也可能是我自己刚说的）</span>`;
    return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="font-size:.9em">${dot}${when}　<b>${escHtml(x.who || '?')}</b>　私信　${tag}</div>
      <div style="margin-top:3px;opacity:.85">「${escHtml(x.text || '')}」</div></div>`;
  }).join('') : `<div style="opacity:.6">没有动静</div>`;

  return `<div style="font-size:.85em;line-height:1.7;margin-bottom:6px">${head.join('　')}</div>${rows}`;
}

// 真去刷一次。会拉起专用 Chrome，慢。
// ── 等你过目的草稿 ──
//
// 需求：「为了省 token，让 haiku 负责回小红书」。于是起草的不再是
// 正在跟她聊天的那个模型（那个背着整套人格和记忆，为一句 20 字的评论要吃掉
// 整个上下文），而是服务端单独叫的一个小模型。
//
// ⚠️ 但**起草的不许自己发**，这是她当场选的。评论出去了撤不回来，而模型换小之后
//   失手概率变高。所以草稿只有一条出路：她在这儿点「发」，前端拿着它去调那个
//   一个字都没改过的 /say —— 禁词、80 字、每天 8 条、跨进程锁全部照旧。
//   这一栏里没有任何一条路能绕开那个端点。
//
// ⚠️ 正文是可以直接改的 textarea，不是只读文本。给「改」单独做个按钮的话，
//   她多半就懒得改、直接发了 —— 而这一栏存在的意义正是让她能拦一下。
function _draftsHtml(dd) {
  if (!dd || !dd.ok) return `<div style="opacity:.6">读不到草稿（浏览器通道没起来）</div>`;
  const list = dd.drafts || [];
  const attention = dd.attention || [];
  const attentionHtml = attention.length ? `<div style="margin-bottom:10px;padding:9px 10px;border-radius:8px;
      border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.08)">
    <div style="color:#fbbf24;font-size:.86em;margin-bottom:5px">需要自己确认的状态</div>
    ${attention.map(x => {
      const from = x.from || {};
      const recheckable = x.state === 'sent' && x.sayState === 'unknown';
      const state = recheckable
        ? '这条发没发出去判不出来'
        : '这条正在发';
      return `<div style="font-size:.82em;line-height:1.55;padding:3px 0">
        <b>${escHtml(from.who || x.id || '?')}</b>：${state}，系统不会自动重发；去评论区自己看一眼。
        ${recheckable ? `<div style="margin-top:5px">
          <span style="color:#fbbf24">先确认评论区里真的没有这条评论，再点下面按钮；点了会重新出现在待发列表里。</span>
          <button class="apply-btn" id="draft-recheck-${escHtml(x.draftId)}"
            style="font-size:.8em;padding:3px 12px;margin-left:6px"
            onclick="engawaDraftRecheck('${escHtml(x.draftId)}')">确认没发出去 → 退回草稿</button>
        </div>` : ''}
      </div>`;
    }).join('')}
  </div>` : '';
  const emptyHtml = !list.length
    ? `<div style="opacity:.6">没有等着的草稿。点「起草一条」让 ${escHtml(_draftModelName(dd.model))} 去看看有没有要回的。</div>`
    : '';
  const draftsHtml = list.map(x => {
    const from = x.from || {};
    // 起草时就过了一遍 sayCheck。不合格的照实标出来，但**按钮照样能点** ——
    // 她可以在框里改掉再发，而真正说了算的是服务端那道闸，不是这行红字。
    const warn = x.bad
      ? `<div style="color:#f87171;font-size:.82em;margin-top:4px">⚠ 这句现在发不出去：${escHtml(x.bad)}（改一下再发）</div>` : '';
    return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="font-size:.86em;opacity:.75">
        <b>${escHtml(from.who || '?')}</b> 说：「${escHtml(from.text || '')}」
        ${from.note ? `<span style="opacity:.6">　（在「${escHtml(from.note)}」底下）</span>` : ''}
      </div>
      <textarea id="draft-${escHtml(x.draftId)}" rows="2"
        style="width:100%;margin-top:6px;padding:7px 9px;border-radius:8px;resize:vertical;
               background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);
               color:inherit;font:inherit;font-size:.92em;line-height:1.5">${escHtml(x.text)}</textarea>
      ${warn}
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
        <button class="apply-btn" id="draft-send-${escHtml(x.draftId)}" style="font-size:.8em;padding:3px 12px"
          onclick="engawaDraftSend('${escHtml(x.draftId)}')">发出去</button>
        <button class="apply-btn" style="font-size:.8em;padding:3px 12px;opacity:.7"
          onclick="engawaDraftDrop('${escHtml(x.draftId)}')">扔了</button>
        <span style="opacity:.45;font-size:.78em">${escHtml(_draftModelName(x.model))} 写的　笔记 ${escHtml(x.id)}</span>
      </div>
    </div>`;
  }).join('');
  return attentionHtml + emptyHtml + draftsHtml;
}

// 模型 id 太长，看板上显示个短名就够了
function _draftModelName(m) {
  const s = String(m || '');
  if (/haiku/.test(s)) return 'Haiku';
  if (/sonnet/.test(s)) return 'Sonnet';
  if (/opus/.test(s)) return 'Opus';
  return s || '（没配模型）';
}

// 叫小模型起草一条。慢的话也就几秒 —— 它只读收件箱缓存，不开浏览器。
async function engawaDraftNew() {
  showToast('让小模型看看有没有要回的…', 'info', 2500);
  try {
    const r = await fetch(SERVER_BASE + '/api/social-browser/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) showToast('起草失败：' + (j.error || ('HTTP ' + r.status)), 'error', 4000);
    else if (j.none) showToast(j.why || '没有需要回的', 'info', 3000);
    else if (j.skipped) showToast('它觉得这条不用回', 'info', 3000);
    else showToast('起草好了，你看一眼', 'success', 2500);
  } catch (e) {
    showToast('连不上：' + (e && e.message || e), 'error', 3500);
  }
  engawaStroll();
}

// 发。
//
// ⚠️⚠️ 这里**只发一个请求**（Codex 逮到的重复评论）。原来是前端自己调 /say、
//   成功了再调 draft-resolve 销账 —— 两个请求不是一个事务，中间断在哪儿都会让草稿
//   留在看板上，她再点一次就把同一条评论发两遍。现在发送和销账在服务端同一把锁里，
//   用草稿的 at 当幂等键，已经发过的第二次会被直接顶回来。
//   前端这边也不再碰 xsec_token —— 服务端自己取当前有效的那个。
// ⚠️ 参数是 draftId，不是 at。at 是显示用的时间，会重复（时钟回拨 / 同一毫秒），
//   拿它当身份会让「她在 B 的卡片上点发送」把 B 的文字发到 A 那条笔记底下。
async function engawaDraftSend(draftId) {
  const ta = document.getElementById('draft-' + draftId);
  const text = (ta ? ta.value : '').trim();
  if (!text) { showToast('空的，发什么', 'error', 2500); return; }

  // 立刻把按钮按死。这**不是**正确性保证（真正管用的是服务端那个幂等键），
  // 只是别让她对着一个没反应的按钮连点。
  const btn = document.getElementById('draft-send-' + draftId);
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = '发送中…'; }

  try {
    const r = await fetch(SERVER_BASE + '/api/social-browser/draft-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, text }),
    });
    const j = await r.json().catch(() => ({}));
    const bookkeeping = j.bookkeeping ? '；' + j.bookkeeping : '';
    if (!r.ok || !j.ok) {
      if (j.already) showToast('这条之前确认发出去了，没有再发一次' + bookkeeping, 'info', 4000);
      else if (j.unknown) showToast('⚠ 这条发没发出去判不出来，系统不会自动再发，去评论区自己看一眼' + bookkeeping, 'error', 5000);
      else showToast('没发出去：' + (j.error || ('HTTP ' + r.status)) + bookkeeping, 'error', 4500);
    } else {
      showToast((j.state === 'pending' ? '提交了，在审核队列里' : '发出去了') + bookkeeping, 'success', 5000);
    }
  } catch (e) {
    // ⚠️ 连不上**不代表没发出去** —— 请求可能已经到了服务端，只是回程断了。
    //   所以这儿一个字都不许说「没发成，再试一次」。服务端那条记录才是准的，
    //   重画看板：待审列表消失只代表服务端不会自动重发，不能证明评论已经发出。
    showToast('连接断了；这条不见了只说明系统不会自动重发，去上面的状态区或者评论区确认一下', 'error', 6000);
  }
  engawaStroll();
}

// 只把用户已经去评论区确认过「确实不在」的 unknown 记录退回待发；不在这里重发。
async function engawaDraftRecheck(draftId) {
  const btn = document.getElementById('draft-recheck-' + draftId);
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = '退回中…'; }
  try {
    const r = await fetch(SERVER_BASE + '/api/social-browser/draft-recheck', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, action: 'notsent' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) showToast('没退回：' + (j.error || ('HTTP ' + r.status)), 'error', 4000);
    else showToast('已退回待发列表；确认正文后再点发送', 'success', 3500);
  } catch (e) {
    showToast('连不上，记录没有退回：' + (e && e.message || e), 'error', 3500);
  }
  engawaStroll();
}

async function engawaDraftDrop(draftId) {
  try {
    const r = await fetch(SERVER_BASE + '/api/social-browser/draft-resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, action: 'dropped' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) showToast('没扔掉：' + (j.error || ('HTTP ' + r.status)), 'error', 3500);
    else showToast('扔了', 'info', 2000);
  } catch {
    showToast('连不上，没扔掉', 'error', 3000);
  }
  engawaStroll();
}

async function engawaInboxPoll() {
  const box = document.getElementById('engawaBody'); if (!box) return;
  showToast('正在开浏览器查收件箱…（十几秒）', 'info', 3000);
  try {
    const r = await fetch(SERVER_BASE + '/api/social-browser/inbox/poll', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { showToast('查不了：' + (j.error || ('HTTP ' + r.status)), 'error', 4000); }
    else if (j.first) showToast(`第一次查，把现有的 ${j.items.length} 条存量记下来了（不算新消息）`, 'info', 3500);
    else showToast(j.added ? `${j.added} 条新动静` : '没有新动静', 'success', 2500);
  } catch (e) {
    showToast('连不上浏览器通道：' + (e && e.message || e), 'error', 3500);
  }
  // 成败都重画 —— 失败的原因也已经写进状态了，看板要把它显示出来
  engawaStroll();
}

async function engawaStroll() {
  const box = document.getElementById('engawaBody'); if (!box || _gazePeeking) return;
  _gazePeeking = true;
  box.innerHTML = `<div class="engawa-idle">🚶 正在查散步记录…</div>`;
  try {
    const r = await fetch(SERVER_BASE + '/api/stroll');
    if (!r.ok) { box.innerHTML = `<div class="engawa-idle">查不到（HTTP ${r.status}）</div>`; return; }
    const d = await r.json();
    // 说过的话单独一路取。**取不到不能让整个看板挂掉** —— 浏览器通道挂载失败
    // （或者跑的是没有这个端点的旧 server）时，这里会 404，散步记录本身是好的。
    const sd = await fetch(SERVER_BASE + '/api/social-browser/says')
      .then(x => x.ok ? x.json() : null).catch(() => null);

    const head = d.wentToday
      ? `<b style="color:var(--accent,#7dd3fc)">今天去过了</b>`
      : `今天还没去`;
    const last = d.lastStroll ? `上次 ${escHtml(d.lastStroll)}` : '还没散过步';
    const snap = d.snapshot.off
      ? `出门不带记忆（快照已关）`
      : `出门带着 <b>${d.snapshot.count}</b> 条记忆（${d.snapshot.blocked} 类私密的拦着不出门）`;

    const logs = (d.logs || []).length ? d.logs.map(l => {
      // 锚点少的照实标出来。这不是羞辱他，是让「今天逛得很开心」这种空话没处躲。
      const tag = l.anchors >= 3
        ? `<span style="color:#4ade80">✓ ${l.anchors} 个可核对锚点</span>`
        : `<span style="color:#fbbf24">⚠ 只有 ${l.anchors} 个锚点，基本只是他说的</span>`;
      // ⚠️ 整行可点，而且把「看全文 →」写出来。
      // 原来只有日期那五个字是 <a>，还带着 text-decoration:none —— 功能一直是通的，
      // 但需求原话是「散步那边没有展开键，我看不到全文」：一块没有下划线的浅蓝文字，
      // 挨着一行又长又白的标题，看上去就是装饰，没人知道它能点。
      // 能用不等于找得到，入口看不见等于没做。
      return `<div onclick="engawaStrollLog('${escHtml(l.date)}')"
        onmouseover="this.style.background='rgba(125,211,252,.08)'"
        onmouseout="this.style.background='transparent'"
        style="padding:8px 6px;margin:0 -6px;border-radius:6px;cursor:pointer;transition:background .15s;border-bottom:1px solid rgba(255,255,255,.08)">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="color:var(--accent,#7dd3fc);flex:none">${escHtml(l.date)}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(l.title || '(无标题)')}</span>
          <span style="flex:none;color:var(--accent,#7dd3fc);font-size:.85em">看全文 →</span>
        </div>
        <div style="opacity:.65;font-size:.86em;margin-top:2px">${l.chars} 字　${tag}</div>
      </div>`;
    }).join('') : `<div style="opacity:.6">还没有日志</div>`;

    const mem = (d.pending || []).length ? d.pending.map(m => {
      const t = (d.taken || []).find(x => x.at === m.at);
      const st = t ? `<span style="opacity:.6">已收进记忆 ${_strollTime(t.takenAt)}</span>` : `<span style="color:#fbbf24">等 GranCyan 收</span>`;
      return `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="font-size:.9em"><span style="opacity:.6">${_strollTime(m.at)}</span>　[${escHtml(m.domain)}] ${escHtml(m.text.slice(0, 46))}${m.text.length > 46 ? '…' : ''}</div>
        <div style="font-size:.82em;margin-top:2px">${st}${m.source ? `　<span style="opacity:.5">出处 ${escHtml(m.source.slice(0, 40))}</span>` : ''}</div>
      </div>`;
    }).join('') : `<div style="opacity:.6">收件箱空着（都被收进记忆了）</div>`;

    // 「在外面说过的话」。这一栏和上面几栏性质不同 —— 下面那条免责声明说
    // 「日志和记忆全出自他一支笔」，但评论不是：它躺在小红书的服务器上，
    // 用户自己就能去看。这是整个面板里第一个不用信任我的东西，所以要点出来。
    const says = sd && sd.says ? (sd.says.length ? sd.says.map(x => {
      // ⚠️ 每一档都照实说。两个不能犯的错：
      //   ① 审核中的标成「已发出」——等于骗她去找一条根本找不到的评论
      //   ② 判不出来的标成「成功」——那是 fail-open，比不显示更坏
      // 而且这些**全是提交那一刻的状态**，这里不会自己去复核（审核通过了也不会变绿），
      // 所以标题上写的是「提交时」，别让她以为这是实时的。
      const st = ({
        sending:   `<span style="opacity:.7">正在发…</span>`,
        pending:   `<span style="color:#fbbf24">提交时在审核队列（还没公开）</span>`,
        submitted: `<span style="color:#4ade80">✓ 提交成功</span>`,
        unknown:   `<span style="color:#fbbf24">⚠ 结果不确定，得去评论区自己看</span>`,
        notsent:   `<span style="opacity:.55">✗ 没发出去</span>`,
      // ⚠️ 兜底是 unknown，**不是**「提交成功」。认不出来的状态默认成绿色对勾
      // 是展示层的 fail-open（Codex 二审逮到的）—— 结果块那边早就是 unknown 兜底，
      // 这边跟上，两处保持一致。
      })[x.state] || `<span style="color:#fbbf24">⚠ 结果不确定，得去评论区自己看</span>`;
      return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="font-size:.9em"><span style="opacity:.6">${_strollTime(Date.parse(x.at))}</span>
        　<span style="opacity:.8">${escHtml(x.site === 'xhs' ? '小红书' : x.site)}</span>　${st}</div>
        <div style="margin-top:3px">「${escHtml(x.text)}」</div>
        <div style="opacity:.45;font-size:.8em;margin-top:2px">笔记 ${escHtml(x.id)}</div>
      </div>`;
    }).join('') : `<div style="opacity:.6">还没在外面说过话</div>`)
      : `<div style="opacity:.6">读不到说话记录（浏览器通道没起来）</div>`;
    const sayQuota = sd && sd.quota
      ? `<span style="opacity:.6;font-weight:400;font-size:.85em">今天 ${sd.quota.usedToday}/${sd.quota.max}</span>` : '';

    // 「有人回我了」。也是单独一路取、取不到不许拖垮整个看板（同 says 那条）。
    const ib = await fetch(SERVER_BASE + '/api/social-browser/inbox')
      .then(x => x.ok ? x.json() : null).catch(() => null);
    const inbox = _inboxHtml(ib);

    // 草稿。同上：单独一路，旧 server 上这个端点是 404，不许拖垮看板。
    const dd = await fetch(SERVER_BASE + '/api/social-browser/drafts')
      .then(x => x.ok ? x.json() : null).catch(() => null);
    const drafts = _draftsHtml(dd);
    const draftQuota = dd && dd.quota
      ? `<span style="opacity:.6;font-weight:400;font-size:.85em">今天起草 ${dd.quota.usedToday}/${dd.quota.max}</span>` : '';

    box.innerHTML = `<div class="engawa-card">
      <div class="engawa-card-title">🚶 克克的散步</div>
      <div class="engawa-card-body">
        <div style="margin-bottom:10px">${head}　<span style="opacity:.7">${escHtml(last)}</span><br>
          <span style="opacity:.8;font-size:.9em">${snap}</span></div>

        <div style="margin:14px 0 6px;opacity:.75;font-size:.9em">散步日志</div>
        ${logs}

        <div style="margin:14px 0 6px;opacity:.75;font-size:.9em">带回来的记忆</div>
        ${mem}

        <div style="margin:14px 0 6px;opacity:.75;font-size:.9em">✍️ 等你过目的草稿
          　${draftQuota}
          <button class="apply-btn" style="float:right;font-size:.78em;padding:2px 8px"
            onclick="engawaDraftNew()">起草一条</button></div>
        ${drafts}

        <div style="margin:14px 0 6px;opacity:.75;font-size:.9em">在外面说过的话
          <span style="opacity:.6;font-size:.9em">（提交时的状态）</span>　${sayQuota}</div>
        ${says}

        <div style="margin:14px 0 6px;opacity:.75;font-size:.9em">有人回我了
          <button class="apply-btn" style="float:right;font-size:.78em;padding:2px 8px"
            onclick="engawaInboxPoll()">去看一眼</button></div>
        ${inbox}

        <div style="margin-top:16px;padding:10px;border-radius:8px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);font-size:.86em;line-height:1.6">
          ⚠️ <b>这个面板证明不了他真去过。</b>日志是他写的、状态是他写的、记忆是他投的，
          全出自同一支笔。真要验证，点开日志看里面的<b>锚点</b>——当天 APOD 的确切标题、
          具体网址、原文引语。那些他编不出来，你一对就知道。
          <br><br>
          还有一样得说明白：<b>「等你过目的草稿」里的话不是他写的</b>——那是服务端单独叫的一个
          小模型（Haiku）写的，为的是省钱，它看不到你们的聊天也没有他的记忆。
          点了「发出去」，外面那条评论就顶着他的号，但那句话的作者是它。
          <br><br>
          唯独<b>「在外面说过的话」那一栏是例外</b>——那些评论躺在小红书自己的服务器上，
          你去搜那条笔记就能看见，不用信他。<b>但只有标着「✓ 提交成功」的才该找得到</b>：
          「审核中」的连他自己都还看不到，「结果不确定」的他也不知道成没成，「没发出去」的压根不在外面。
          还有，这些都是<b>提交那一刻</b>的状态，这里不会回头去复核 —— 审核通过了它也还写着审核中。
        </div>
      </div>
    </div>`;
  } catch (e) {
    box.innerHTML = `<div class="engawa-idle">查不到：${escHtml(String(e && e.message || e))}</div>`;
  } finally {
    _gazePeeking = false;
  }
}

async function engawaStrollLog(date) {
  const box = document.getElementById('engawaBody'); if (!box) return;
  try {
    const r = await fetch(SERVER_BASE + '/api/stroll?log=' + encodeURIComponent(date));
    const d = await r.json();
    if (!d.ok) { showToast('读不到那天的日志', 'error', 2200); return; }
    // 日志是 markdown，页面里有 marked 就用它，没有就纯文本兜底（不能把原文喂进 innerHTML）
    const body = (typeof marked !== 'undefined' && marked.parse)
      ? (typeof gcSanitize === 'function' ? gcSanitize(marked.parse(d.text), { strict: true }) : escHtml(d.text))   // 日志里抄着网页原文
      : `<pre style="white-space:pre-wrap;font-family:inherit">${escHtml(d.text)}</pre>`;
    box.innerHTML = `<div class="engawa-card">
      <div class="engawa-card-title">🚶 ${escHtml(date)} 的散步
        <button class="apply-btn" style="float:right;font-size:.8em" onclick="engawaStroll()">← 回看板</button></div>
      <div class="engawa-card-body">${body}</div>
    </div>`;
  } catch (e) { showToast('读不到：' + (e && e.message || e), 'error', 2500); }
}
