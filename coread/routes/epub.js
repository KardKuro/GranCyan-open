// epub.js — epub 导入:spine 顺序抽章节,TOC/标题兜底命名,太短的封面页跳过。
const { EPub } = require('epub2');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { rejectUnsafeEpub } = require('../../epub-guard');

const upload = multer({
  dest: (() => {
    // asar 包内不可写，使用系统临时目录或用户目录
    const tmpDir = path.join(require('os').homedir(), '.grancyan', 'tmp-uploads');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  })(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (q, f, cb) => cb(f.originalname.toLowerCase().endsWith('.epub') ? null : new Error('只支持 .epub'), true),
});

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = function (app, db) {
  app.post('/api/import-epub', upload.single('epub'), async (q, r) => {
    if (!q.file) return r.status(400).json({ error: '未收到文件' });
    try {
      // epub2 的 adm-zip 目前没有已发布的安全版本；进入解析器前先拒绝危险 ZIP。
      rejectUnsafeEpub(q.file.path);
      const epub = new EPub(q.file.path);
      await new Promise((resolve, reject) => {
        epub.on('end', resolve);
        epub.on('error', reject);
        epub.parse();
      });

      const title = epub.metadata.title || '未知书名';
      const tocMap = {};
      (function walk(items) { (items || []).forEach((it) => { if (it.href) tocMap[it.href.split('#')[0]] = it.title || ''; walk(it.subitems); }); })(epub.toc);

      const chapters = [];
      for (const item of epub.flow) {
        let html = '';
        try { html = await new Promise((res, rej) => epub.getChapter(item.id, (e, t) => (e ? rej(e) : res(t || '')))); } catch (e) { continue; }
        const text = htmlToText(html);
        if (text.length < 20) continue; // 封面/版权页
        const heading = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1];
        chapters.push({ title: tocMap[item.href] || (heading ? heading.replace(/<[^>]+>/g, '').trim() : '') || `第${chapters.length + 1}章`, content: text });
      }
      if (!chapters.length) return r.status(400).json({ error: '未提取到章节' });

      const bookId = 'book_' + crypto.randomUUID().slice(0, 8);
      db.prepare('INSERT INTO books(id,title,author) VALUES(?,?,?)').run(bookId, title, epub.metadata.creator || '');
      const ins = db.prepare('INSERT INTO chapters(id,book_id,chapter_num,title,content) VALUES(?,?,?,?,?)');
      db.transaction(() => chapters.forEach((c, i) => ins.run(`${bookId}_ch${i + 1}`, bookId, i + 1, c.title, c.content)))();
      r.json({ success: true, book_id: bookId, chapters: chapters.length });
    } catch (e) {
      r.status(500).json({ error: 'epub 解析失败: ' + e.message });
    } finally {
      try { fs.unlinkSync(q.file.path); } catch (e) {}
    }
  });
};
