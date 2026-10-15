// chat.js — 共读聊天:SSE 全链路 + 讨论落库 + AI 留痕批注。
//
// ⚠️ 防踩坑 #3(全文最重要的一条):浏览器和 LLM 之间只要隔着任何反代/隧道/CDN,
// 长生成就会被当成"死请求"在 ~100s 掐断(Cloudflare 免费层就是 100s)。
// 解法不是加超时,是让字节一直在流:下游对浏览器开 SSE(15s 心跳打底),
// 上游对 LLM 走流式,增量一路透传。掉线的 salvage 补救只配当保险丝,不配当方案。
const crypto = require('crypto');
const { chatStream } = require('../lib/llm');
const { buildSystem } = require('../lib/prompt');
const { fillDigests } = require('../lib/digest');
const { writeMemory } = require('../lib/memory');
const models = require('../lib/models');

// opts.outboundAgent:server.js 探测出来的本机代理（v2rayN 等）。外网模型要走它，
// 否则 DeepSeek/OpenAI 这类在墙内直连会超时。本地 Claude 不需要。
module.exports = function (app, db, opts = {}) {
  const modelCfg = () => ({ ...models.current(db), getAgent: opts.outboundAgent });

  // ── 模型：主程序推配置进来 / 书架列出可选项 / 选一个 ──────────────
  // 主程序（浏览器）把 state.configs 推过来存进 reading_models —— 手机上书架和主程序
  // 不同源，读不到浏览器里的配置，只能靠这条路。也可以直接往表里手填一行。
  app.post('/api/reading/models', (q, r) => {
    try {
      const n = models.replaceModels(db, (q.body || {}).configs);
      // 选中的那个还在就别动；没了（比如配置被删）就清掉，resolve() 会退回本地 Claude
      const sel = models.getSelectedKey(db);
      if (sel && !models.listOptions(db).some((o) => o.key === sel)) models.setSelectedKey(db, '');
      r.json({ success: true, n });
    } catch (e) { r.status(500).json({ error: e.message }); }
  });

  app.get('/api/reading/models', (q, r) => {
    try {
      const options = models.listOptions(db);
      let selected = models.getSelectedKey(db);
      if (!options.some((o) => o.key === selected)) selected = options[0].key;
      r.json({ options, selected });
    } catch (e) { r.json({ options: [{ key: '|', label: '订阅 Claude · 默认 (Sonnet)' }], selected: '|' }); }
  });

  app.post('/api/reading/model', (q, r) => {
    try { models.setSelectedKey(db, (q.body || {}).key || ''); r.json({ success: true }); }
    catch (e) { r.status(500).json({ error: e.message }); }
  });

  // 历史:按书取(讨论是一条连续的河,不按章切),前端开面板先续上——别放内存,刷新就白板。
  app.get('/api/reading/:bid/chats', (q, r) => {
    try {
      r.json({ items: db.prepare('SELECT who,cnum,text,created_at FROM reading_chats WHERE book_id=? ORDER BY id DESC LIMIT 40').all(q.params.bid).reverse() });
    } catch (e) { r.json({ items: [] }); }
  });

  app.post('/api/reading/:bid/chat', async (q, r) => {
    const bid = q.params.bid;
    const b = q.body || {};
    const cnum = parseInt(b.cnum, 10) || 0;
    const msg = String(b.message || '').slice(0, 4000);
    const sel = String(b.selection || '').slice(0, 500);
    if (!msg.trim()) return r.status(400).json({ error: '空消息' });

    const book = db.prepare('SELECT * FROM books WHERE id=?').get(bid);
    if (!book) return r.status(404).json({ error: '没这本书' });
    const chapter = db.prepare('SELECT * FROM chapters WHERE book_id=? AND chapter_num=?').get(bid, cnum);
    // 本章批注优先,再补全书最近的
    const annotations = db.prepare(
      'SELECT annotator,annotator_name,annotator_model,original_text,annotation FROM annotations WHERE book_id=? ORDER BY (chapter_num<>?), created_at DESC LIMIT 12'
    ).all(bid, cnum);

    // ⚠️ cfg 必须在 buildSystem **之前**拿到：书架换过模型的话，
    // 库里那些批注未必是现在这个模型写的，buildSystem 要靠 me 判断哪条能说「你」。
    const cfg = modelCfg();
    // system 每轮重建(时间锚/原文窗口都是易变的);对话历史从库里取——服务端无状态,重启不丢。
    const system = buildSystem(db, { book, chapter, cnum, selection: sel, annRef: b.ann, annotations, me: cfg });
    const history = db.prepare('SELECT who,text FROM reading_chats WHERE book_id=? ORDER BY id DESC LIMIT 24').all(bid).reverse()
      .map((c) => ({ role: c.who === 'user' ? 'user' : 'assistant', content: c.text }));
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: msg }];

    // 用户消息先落库:生成失败也留痕(⚠️ 防踩坑 #7)
    db.prepare('INSERT INTO reading_chats(book_id,cnum,who,text) VALUES(?,?,?,?)').run(bid, cnum, 'user', msg);
    db.prepare("UPDATE books SET last_read_at=datetime('now','localtime'), last_chapter=? WHERE id=?").run(cnum, bid);
    setImmediate(() => { try { fillDigests(db, bid, cnum, cfg); } catch (e) {} });

    // AI 留痕批注:回复里的 [批注:原文|内容] 摘出来入库,原文必须真是本章子串才收(防模型编原文),标记从回复里剥掉。
    function extractAnns(reply) {
      const out = { text: String(reply || ''), n: 0 };
      const content = chapter ? String(chapter.content || '') : '';
      out.text = out.text.replace(/\s*\[批注[:：]([^|\]\n]{2,60})\|([^\]\n]{2,200})\]\s*/g, (_, orig, note) => {
        orig = orig.trim(); note = note.trim();
        if (content && note && content.includes(orig)) {
          // ⚠️ 光存 'ai' 不够：书架这边可能是 DeepSeek，主对话那边是别的模型，
          // 只有 'ai' 的话对话那边会把这条读成「你划的」，每个模型都认领一遍。
          // 所以连**是谁划的**一起存（昵称 + 真模型名）。
          db.prepare('INSERT INTO annotations(id,book_id,chapter_num,original_text,annotation,annotator,annotator_name,annotator_model) VALUES(?,?,?,?,?,?,?,?)')
            .run(crypto.randomUUID(), bid, cnum, orig, note, 'ai',
              String(cfg.label || '').slice(0, 40),
              String(cfg.isLocal ? 'local:' + (cfg.localModel || 'default') : (cfg.modelName || '')).slice(0, 80));
          out.n++;
        }
        return '\n';
      }).replace(/\n{3,}/g, '\n\n').trim();
      return out;
    }

    // 下游 SSE。⚠️ 防踩坑 #3 续:清理定时器挂在 res 的 close 上,不是 req——
    // POST 的 req 读完 body 就触发 close,挂错地方心跳会立刻被拆。
    r.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    const hb = setInterval(() => { try { r.write(': hb\n\n'); } catch (e) {} }, 15000);
    r.on('close', () => { closed = true; clearInterval(hb); });
    const ev = (name, obj) => { if (!closed) try { r.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };

    try {
      let reply = await chatStream(messages, (_, full) => ev('live', { t: full }), cfg);
      const ex = extractAnns(reply);
      reply = ex.text;
      ev('final', { reply: reply || '（没接住，再说一遍？）', ann: ex.n, model: cfg.label });
      if (reply) {
        db.prepare('INSERT INTO reading_chats(book_id,cnum,who,text) VALUES(?,?,?,?)').run(bid, cnum, 'ai', reply);
        setImmediate(() => { try { writeMemory(db, { bookTitle: book.title, cnum, chapterTitle: chapter && chapter.title, userMsg: msg, aiReply: reply }); } catch (e) {} });
      }
    } catch (e) {
      ev('final', { error: '（没接住：' + e.message + '，再说一遍？）' });
    }
    clearInterval(hb);
    try { r.end(); } catch (e) {}
  });
};
