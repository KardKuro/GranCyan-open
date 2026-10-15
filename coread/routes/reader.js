// reader.js — 三张页面:书架 / 目录 / 章节(批注+共读)。
// 服务端直出 HTML,零构建零框架;交互逻辑在 public/reader.js(独立静态文件——
// ⚠️ 防踩坑 #6:别把浏览器 JS 塞进服务端模板字面量,正则和 \n 要转义两层,极易写错)。
const path = require('path');
const express = require('express');
const { fillDigests } = require('../lib/digest');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 与主程序 js/00-config.js 相同的 Supabase anon key（anon key 本来就是公开的），从环境变量 / .env 的
// SUPABASE_ANON_KEY 读。书架页云备份按钮带着它 + 用户登录 token 走 /api/cloud-file 中转；没配就是空串，
// 云备份那两个按钮点了会提示先登录（没配云同步就不会有会话）。
const sbAnonKey = () => String(process.env.SUPABASE_ANON_KEY || '').trim();

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f0f18;--tx:#e4e4f0;--soft:rgba(228,228,240,.66);--faint:rgba(228,228,240,.4);--line:rgba(255,255,255,.07);--card:rgba(255,255,255,.06);--acc:#6366f1;--hl:rgba(99,102,241,.22)}
:root{color-scheme:dark}
body{font-family:'Cormorant Garamond',SimSun,STSong,'Noto Serif SC',serif;background:var(--bg);color:var(--tx);min-height:100vh;padding-bottom:70px}
.wrap{max-width:660px;margin:0 auto;padding:28px 20px}
a{color:inherit;text-decoration:none}
h1{font-size:22px;font-weight:400;letter-spacing:1px;margin-bottom:4px}
.sub{font-size:13px;color:var(--faint);font-style:italic;margin-bottom:24px}
.back{display:inline-block;font-size:13px;color:var(--faint);margin-bottom:16px}
ul.plain{list-style:none}
.row{display:block;padding:12px 4px;border-bottom:1px solid var(--line);font-size:15px}
.row small{color:var(--faint);margin-left:8px;font-size:12px}
.content{font-size:16.5px;line-height:1.9;white-space:pre-wrap;margin:20px 0}
.hl-user{background:var(--hl);border-radius:6px;padding:.06em 2px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.hl-ai{border-bottom:1.5px solid var(--acc);padding-bottom:1px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.nav{display:flex;justify-content:space-between;margin-top:32px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--soft)}
.up{font-size:13px;color:var(--soft);border:1px dashed var(--line);border-radius:8px;padding:10px 14px;display:inline-block;cursor:pointer}
.del{position:absolute;right:2px;top:50%;transform:translateY(-50%);padding:8px 10px;font-size:14px;color:var(--faint);cursor:pointer;border-radius:8px}
.del:hover{color:#e5484d;background:var(--card)}
.x{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));right:14px;z-index:10;width:34px;height:34px;display:grid;place-items:center;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--faint);font-family:system-ui,sans-serif;font-size:15px}
.x:hover{color:var(--acc)}
`;

// 重点色同步。手机上主程序(grancyan.app)和书架(电脑 server 的 IP)是两个源,IndexedDB 互相看不见——
// 所以颜色主要靠主程序在 ?acc= 里带过来,落进书架这个源的 localStorage,翻章节时接着用。
// IndexedDB 那条只在电脑上(主程序和书架同源)有用,留着当兜底。
const ACCENT_SYNC = `<script>(function(){
var OK=/^#[0-9a-fA-F]{6}$/;
function paint(c){if(!c||!OK.test(c))return false;var R=parseInt(c.slice(1,3),16),G=parseInt(c.slice(3,5),16),B=parseInt(c.slice(5,7),16),s=document.documentElement.style;s.setProperty('--acc',c);s.setProperty('--hl','rgba('+R+','+G+','+B+',.2)');return true}
var u=null;try{u=new URLSearchParams(location.search).get('acc')}catch(x){}
if(u&&OK.test(u)){paint(u);try{localStorage.setItem('coread_acc',u)}catch(x){}return}
try{if(paint(localStorage.getItem('coread_acc')))return}catch(x){}
try{var q=indexedDB.open('KuroDB',1);q.onsuccess=function(e){try{var r=e.target.result.transaction('kv').objectStore('kv').get('kuro_accent');r.onsuccess=function(){if(paint(r.result)){try{localStorage.setItem('coread_acc',r.result)}catch(x){}}}}catch(x){}}}catch(x){}
})()<\/script>`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}${ACCENT_SYNC}</body></html>`;
}

// 服务端把批注嵌进正文:按原文片段找到位置,包上 span(用户=高亮 / AI=下划线)。
// 嵌不进的(原文没匹配上)不丢,前端沉底显示。
function embed(content, anns) {
  let html = esc(content || '');
  const embedded = new Set();
  const groups = new Map();
  for (const a of anns) {
    if (!a.original_text || !a.original_text.trim()) continue;
    const key = esc(a.original_text);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const keys = [...groups.keys()].sort((x, y) => y.length - x.length); // 长引文优先,避免短的先占坑
  for (const key of keys) {
    const idx = html.indexOf(key);
    if (idx < 0) continue;
    const before = html.slice(0, idx);
    if ((before.match(/<span class="hl-/g) || []).length > (before.match(/<\/span>/g) || []).length) continue; // 已在别的标注里,跳过
    const grp = groups.get(key);
    grp.forEach((a) => embedded.add(a.id));
    const cls = [...new Set(grp.map((a) => (a.annotator === 'user' ? 'hl-user' : 'hl-ai')))].join(' ');
    const data = esc(JSON.stringify(grp.map((a) => ({ id: a.id, w: a.annotator, a: a.annotation, t: a.created_at }))));
    html = html.slice(0, idx) + `<span class="${cls}" data-anns="${data}">` + key + '</span>' + html.slice(idx + key.length);
  }
  return { html, floating: anns.filter((a) => !embedded.has(a.id)) };
}

module.exports = function (app, db) {
  app.use('/public', express.static(path.join(__dirname, '..', 'public')));

  // 书架
  app.get('/reading', (q, r) => {
    const books = db.prepare('SELECT b.*, COUNT(c.id) n FROM books b LEFT JOIN chapters c ON c.book_id=b.id GROUP BY b.id ORDER BY b.last_read_at DESC').all();
    const list = books.map((b) => `<li style="position:relative"><a class="row" href="/reading/${b.id}" style="padding-right:40px">${esc(b.title)}<small>${esc(b.author)} · ${b.n}章${b.last_chapter ? ' · 读到第' + b.last_chapter + '章' : ''}</small></a><span class="del" title="删除本书" data-bid="${b.id}" data-title="${esc(b.title)}">✕</span></li>`).join('');
    r.send(page('书架', `<a class="x" href="/#widgets" title="关闭" aria-label="关闭">✕</a><div class="wrap"><a class="back" href="/#widgets">← 返回</a><h1>书架</h1><p class="sub">falling in love on the same page</p><ul class="plain">${list || '<li class="row">书架还是空的。</li>'}</ul>
<p style="margin-top:24px"><label class="up">导入 epub<input type="file" accept=".epub" style="display:none" onchange="var fd=new FormData();fd.append('epub',this.files[0]);fetch('/api/import-epub',{method:'POST',body:fd}).then(r=>r.json()).then(d=>d.success?location.href='/reading/'+d.book_id:alert(d.error))"></label>
<label class="up" style="margin-left:8px" onclick="cloudBackup(this)">☁ 备份到云端</label>
<label class="up" style="margin-left:8px" onclick="cloudRestore(this)">☁ 从云端恢复</label></p></div>
<script>
document.querySelectorAll('.del').forEach(function(el){el.onclick=function(){var t=el.getAttribute('data-title');if(!confirm('删除《'+t+'》？批注和共读记录会一起删掉。'))return;fetch('/api/reading/'+el.getAttribute('data-bid'),{method:'DELETE'}).then(function(r){return r.json()}).then(function(d){d.success?location.reload():alert(d.error||'删除失败')})}});
// 云备份：读主程序存在 localStorage 里的 Supabase 会话（同源共享），经 /api/cloud-file 中转存取 Storage
var SB_ANON=${JSON.stringify(sbAnonKey())};
function _sbSession(){for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(/^sb-.*-auth-token$/.test(k)){try{var v=JSON.parse(localStorage.getItem(k));if(v&&v.access_token&&v.user)return v}catch(e){}}}return null}
function _busy(el,txt){el.dataset.orig=el.textContent;el.textContent=txt;el.style.pointerEvents='none'}
function _idle(el){el.textContent=el.dataset.orig;el.style.pointerEvents=''}
function cloudBackup(el){
  var s=_sbSession();if(!s){alert('请先回主界面登录账号');return}
  _busy(el,'☁ 备份中…');
  fetch('/api/reading-export').then(function(r){return r.json()})
    .then(function(data){return fetch('/api/cloud-file?path='+encodeURIComponent(s.user.id+'/coread-backup.json'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.access_token,apikey:SB_ANON},body:JSON.stringify(data)})})
    .then(function(r){return r.json()})
    .then(function(d){_idle(el);d.ok?alert('✓ 书架已备份到云端'):alert('备份失败: '+(d.error||d.message||JSON.stringify(d)))})
    .catch(function(e){_idle(el);alert('备份失败: '+e.message)});
}
function cloudRestore(el){
  var s=_sbSession();if(!s){alert('请先回主界面登录账号');return}
  if(!confirm('从云端恢复书架？（与本地合并，不会删除现有的书）'))return;
  _busy(el,'☁ 恢复中…');
  fetch('/api/cloud-file?path='+encodeURIComponent(s.user.id+'/coread-backup.json'),{headers:{Authorization:'Bearer '+s.access_token,apikey:SB_ANON}})
    .then(function(r){if(!r.ok)throw new Error(r.status===404||r.status===400?'云端还没有书架备份':'HTTP '+r.status);return r.json()})
    .then(function(d){return fetch('/api/reading-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})})
    .then(function(r){return r.json()})
    .then(function(d){_idle(el);if(!d.success)throw new Error(d.error||'导入失败');alert('✓ 已恢复：新增 书'+d.imported.books+' / 章节'+d.imported.chapters+' / 批注'+d.imported.annotations+' / 共读'+d.imported.reading_chats);location.reload()})
    .catch(function(e){_idle(el);alert('恢复失败: '+e.message)});
}
<\/script>`));
  });

  // 书架云备份：整库导出 / 合并导入（配合 server.js 的 /api/cloud-file Supabase Storage 中转）
  app.get('/api/reading-export', (q, r) => {
    r.json({
      exported_at: new Date().toISOString(),
      books: db.prepare('SELECT * FROM books').all(),
      chapters: db.prepare('SELECT * FROM chapters').all(),
      annotations: db.prepare('SELECT * FROM annotations').all(),
      reading_chats: db.prepare('SELECT * FROM reading_chats').all(),
    });
  });
  app.post('/api/reading-import', (q, r) => {
    const d = q.body || {};
    const n = { books: 0, chapters: 0, annotations: 0, reading_chats: 0 };
    try {
      db.transaction(() => {
        for (const b of d.books || []) {
          if (!b.id || !b.title) continue;
          const ex = db.prepare('SELECT last_read_at FROM books WHERE id=?').get(b.id);
          if (!ex) { db.prepare('INSERT INTO books(id,title,author,last_chapter,last_read_at) VALUES(?,?,?,?,?)').run(b.id, b.title, b.author || '', b.last_chapter || 0, b.last_read_at || ''); n.books++; }
          else if ((b.last_read_at || '') > (ex.last_read_at || '')) db.prepare('UPDATE books SET last_chapter=?, last_read_at=? WHERE id=?').run(b.last_chapter || 0, b.last_read_at || '', b.id);
        }
        for (const c of d.chapters || []) {
          if (!c.id) continue;
          if (!db.prepare('SELECT 1 FROM chapters WHERE id=?').get(c.id)) { db.prepare('INSERT INTO chapters(id,book_id,chapter_num,title,content,digest) VALUES(?,?,?,?,?,?)').run(c.id, c.book_id, c.chapter_num, c.title || '', c.content || '', c.digest || ''); n.chapters++; }
        }
        for (const a of d.annotations || []) {
          if (!a.id || !a.annotation) continue;
          if (!db.prepare('SELECT 1 FROM annotations WHERE id=?').get(a.id)) { db.prepare('INSERT INTO annotations(id,book_id,chapter_num,original_text,annotation,annotator,created_at) VALUES(?,?,?,?,?,?,?)').run(a.id, a.book_id, a.chapter_num || 0, a.original_text || '', a.annotation, a.annotator || 'user', a.created_at || ''); n.annotations++; }
        }
        for (const m of d.reading_chats || []) {
          if (!m.book_id || !m.text) continue;
          if (!db.prepare('SELECT 1 FROM reading_chats WHERE book_id=? AND who=? AND text=? AND created_at=?').get(m.book_id, m.who, m.text, m.created_at || '')) { db.prepare('INSERT INTO reading_chats(book_id,cnum,who,text,created_at) VALUES(?,?,?,?,?)').run(m.book_id, m.cnum || 0, m.who, m.text, m.created_at || ''); n.reading_chats++; }
        }
      })();
      r.json({ success: true, imported: n });
    } catch (e) {
      r.status(500).json({ error: '导入失败: ' + e.message });
    }
  });

  // 删除书本（连带章节/批注/共读记录）
  app.delete('/api/reading/:bid', (q, r) => {
    const b = db.prepare('SELECT id FROM books WHERE id=?').get(q.params.bid);
    if (!b) return r.status(404).json({ error: '书不存在' });
    db.transaction(() => {
      db.prepare('DELETE FROM reading_chats WHERE book_id=?').run(b.id);
      db.prepare('DELETE FROM annotations WHERE book_id=?').run(b.id);
      db.prepare('DELETE FROM chapters WHERE book_id=?').run(b.id);
      db.prepare('DELETE FROM books WHERE id=?').run(b.id);
    })();
    r.json({ success: true });
  });

  // 目录
  app.get('/reading/:bid', (q, r) => {
    const b = db.prepare('SELECT * FROM books WHERE id=?').get(q.params.bid);
    if (!b) return r.status(404).send('Not found');
    const chs = db.prepare('SELECT chapter_num,title FROM chapters WHERE book_id=? ORDER BY chapter_num').all(b.id);
    const list = chs.map((c) => `<li><a class="row" href="/reading/${b.id}/${c.chapter_num}">#${c.chapter_num} ${esc(c.title)}${c.chapter_num === b.last_chapter ? '<small>上次读到</small>' : ''}</a></li>`).join('');
    r.send(page(b.title, `<div class="wrap"><a class="back" href="/reading">← 书架</a><h1>${esc(b.title)}</h1><p class="sub">${esc(b.author)}</p><ul class="plain">${list}</ul></div>`));
  });

  // 章节(阅读+批注+共读聊天)
  app.get('/reading/:bid/:cnum', (q, r) => {
    const b = db.prepare('SELECT * FROM books WHERE id=?').get(q.params.bid);
    const cnum = parseInt(q.params.cnum, 10) || 0;
    const ch = db.prepare('SELECT * FROM chapters WHERE book_id=? AND chapter_num=?').get(q.params.bid, cnum);
    if (!b || !ch) return r.status(404).send('Not found');
    db.prepare("UPDATE books SET last_read_at=datetime('now','localtime'), last_chapter=? WHERE id=?").run(cnum, b.id);
    setImmediate(() => { try { fillDigests(db, b.id, cnum); } catch (e) {} }); // 翻到哪,digest 后台补到哪

    const anns = db.prepare('SELECT * FROM annotations WHERE book_id=? AND chapter_num=? ORDER BY created_at').all(b.id, cnum);
    const { html, floating } = embed(String(ch.content).replace(/[ \t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n'), anns);
    const prev = cnum > 1 ? `<a href="/reading/${b.id}/${cnum - 1}">← 上一章</a>` : '<span></span>';
    const next = db.prepare('SELECT 1 FROM chapters WHERE book_id=? AND chapter_num=?').get(b.id, cnum + 1) ? `<a href="/reading/${b.id}/${cnum + 1}">下一章 →</a>` : '<span></span>';
    const floatH = floating.length
      ? '<div style="margin-top:28px;border-top:1px solid var(--line);padding-top:14px">' + floating.map((a) => `<p style="font-size:13px;color:var(--soft);margin-bottom:10px">${a.annotator === 'user' ? '读者' : 'AI'}：${a.original_text ? '「' + esc(a.original_text) + '」— ' : ''}${esc(a.annotation)}</p>`).join('') + '</div>'
      : '';
    r.send(page(ch.title || b.title, `<div class="wrap"><a class="back" href="/reading/${b.id}">← 目录</a><h1>${esc(ch.title)}</h1><p class="sub">${esc(b.title)} · #${cnum}</p>
<div class="content" id="content">${html}</div>${floatH}<div class="nav">${prev}${next}</div></div>
<script>window.__COREAD={bid:${JSON.stringify(b.id)},cnum:${cnum}}</script><script src="/public/reader.js"></script>`));
  });

  // 书架近况：给主程序的对话用的，不是给这个页面用的。
  //
  // 主对话里的 AI 跟书架里的是同一个"人"，但两边是两套上下文——它在书架里划的线、
  // 你在书架里写的批注，对话那边一个字都看不到。这个接口就是把痕迹递过去。
  //
  // ⚠️ 输出要进**每一轮**提示词，所以三条硬约束：
  //   1) 总量必须小且**有上限**（不是"一般不会很多"）。书越读越多，
  //      没上限的话某天它会安静地把上下文顶爆——症状是 AI 突然不记得前文了，
  //      看着像记忆系统坏了（这个坑仓库里踩过，见上下文裁剪那条）。
  //   2) 带 at 时间戳。对话那边要能判断"这是不是太旧了"——三天前划的线被说成
  //      "你刚划的"，比不说更糟。
  //   3) 空的时候就返回空，不要编。没书就是没书。
  app.get('/api/reading/pulse', (q, r) => {
    const MAX_MARKS = 8, QUOTE = 60, NOTE = 90;
    try {
      const b = db.prepare("SELECT * FROM books WHERE last_read_at != '' ORDER BY last_read_at DESC LIMIT 1").get()
        || db.prepare('SELECT * FROM books ORDER BY created_at DESC LIMIT 1').get();
      if (!b) return r.json({ at: new Date().toISOString(), book: null, marks: [] });

      const total = db.prepare('SELECT COUNT(*) c FROM chapters WHERE book_id=?').get(b.id).c;
      const marks = db.prepare('SELECT * FROM annotations WHERE book_id=? ORDER BY created_at DESC LIMIT ?')
        .all(b.id, MAX_MARKS)
        .map((a) => ({
          who: a.annotator === 'ai' ? 'ai' : 'user',
          // 谁划的。对话那边要靠这两个字段判断「这条到底是不是我划的」——
          // 少了它每个模型都会把书架里别人（比如 DeepSeek）的批注认领成自己的。
          // 旧数据这两个是空的，那边的处理是**宁可说中立**，不许瞎认领。
          byName: String(a.annotator_name || '').slice(0, 40),
          byModel: String(a.annotator_model || '').slice(0, 80),
          chapter: a.chapter_num,
          quote: String(a.original_text || '').slice(0, QUOTE),
          note: String(a.annotation || '').slice(0, NOTE),
          at: a.created_at
        }));

      r.json({
        at: new Date().toISOString(),
        book: {
          id: b.id, title: b.title, author: b.author || '',
          chapter: b.last_chapter || 0, chapters: total,
          last_read_at: b.last_read_at || ''
        },
        marks
      });
    } catch (e) {
      // 拉不到就明说拉不到，别给个空壳让对话那边以为"书架是空的"
      r.status(500).json({ error: String(e && e.message || e) });
    }
  });

  // 手动批注
  app.post('/api/annotate', (q, r) => {
    const { book_id, chapter_num, original_text, annotation } = q.body || {};
    if (!book_id || !annotation) return r.status(400).json({ error: 'missing' });
    db.prepare('INSERT INTO annotations(id,book_id,chapter_num,original_text,annotation,annotator) VALUES(?,?,?,?,?,?)')
      .run(require('crypto').randomUUID(), book_id, parseInt(chapter_num, 10) || 0, String(original_text || '').slice(0, 500), String(annotation).slice(0, 2000), 'user');
    r.json({ success: true });
  });
};
