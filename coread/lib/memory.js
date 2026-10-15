// memory.js — 记忆回写的「接口形状」。
//
// 共读发生在独立空间,但它不该是记忆孤岛:读者合上书之后,你的 AI 在别的界面
// 应该知道「TA 刚读了哪本书、读到哪、聊了什么」。做法分两层:
//
// 1) 长期记忆(writeMemory):每轮共读后写一条带书名 tag 的轻记录,进你自己的
//    记忆/RAG 系统,靠语义检索被动浮现——平时不注入,提到才想起。
//    要点:独立分类 + tag 打进正文开头(如 `reading/书名 — …`),别混进日常记忆,
//    否则检索噪声互相污染。
//
// 2) 短期余温(recentBrief):最近 N 小时读过书,就给其他会话的注入块加一行
//    「TA 刚在读《X》到第N章,你们聊了…」。过窗自动消失,久远的交还检索。
//    这一层不需要向量库,一句 SQL 就够,却是「刚读完出来还能接上话」的关键。
//
// 这里 writeMemory 默认 no-op——接进你自己的系统(向量库/文件/任何东西)。
function writeMemory(db, { bookTitle, cnum, chapterTitle, userMsg, aiReply }) {
  // 示例形状:
  // yourMemorySystem.add({
  //   content: `reading/${bookTitle} — 共读《${bookTitle}》·读到第${cnum}章${chapterTitle ? ' ' + chapterTitle : ''}。` +
  //            `读者说：「${userMsg.slice(0, 80)}」；我聊了：「${aiReply.slice(0, 120)}」`,
  //   category: 'reading',
  //   tags: ['reading/' + bookTitle],
  // });
}

// 书房余温:最近 hours 小时内读过书 → 一行简报(给你的其他 AI 会话注入用);否则空串。
function recentBrief(db, hours = 3) {
  const b = db.prepare(
    "SELECT id, title, last_chapter, last_read_at FROM books WHERE last_read_at<>'' AND last_read_at >= datetime('now','localtime','-' || ? || ' hours') ORDER BY last_read_at DESC LIMIT 1"
  ).get(hours);
  if (!b) return '';
  const chats = db.prepare(
    "SELECT who, text FROM reading_chats WHERE book_id=? AND created_at >= datetime('now','localtime','-' || ? || ' hours') ORDER BY id DESC LIMIT 4"
  ).all(b.id, hours).reverse();
  let line = `读者刚在读《${b.title}》${b.last_chapter ? `，读到第${b.last_chapter}章` : ''}`;
  if (chats.length) line += '；你们边读边聊了——' + chats.map((c) => `${c.who === 'user' ? 'TA' : '你'}：「${String(c.text).replace(/\s+/g, ' ').slice(0, 60)}」`).join(' ');
  return line + '。（TA 提起这本书就自然接住；不提就别主动汇报。）';
}

module.exports = { writeMemory, recentBrief };
