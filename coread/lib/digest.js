// digest.js — 章节脉络摘要,懒生成。
// 思路(借自"AI 真听过这首歌再推荐"):与其指望模型记得这本书,不如让它"真读过"——
// 用便宜模型把每章压成 ≤120 字脉络,存进 chapters.digest,聊天时只注入到读者进度为止。
// 一次性成本极低(一本书几十次调用),换来的是:不编书 + 天然防剧透。
//
// ⚠️ 防踩坑 #8:懒生成必须「成功才续下一章、失败就停」。如果失败也无脑重试,
// 没配 key 的部署会 3 秒一次永远空转。停了没关系——下次翻页/聊天再触发。
const { ask } = require('./llm');

let busy = false;
// cfg:书架当前选的模型（models.js 的 resolve() 产物）。不传就走本地 Claude 默认。
function fillDigests(db, bookId, uptoCnum, cfg) {
  if (busy) return;
  const next = db.prepare(
    "SELECT id, content FROM chapters WHERE book_id=? AND chapter_num<=? AND (digest IS NULL OR digest='') AND LENGTH(content)>=200 ORDER BY chapter_num LIMIT 1"
  ).get(bookId, uptoCnum);
  if (!next) return;
  busy = true;
  const raw = String(next.content || '').replace(/\s+/g, ' ').slice(0, 7000);
  ask('下面是一本书某一章的原文。写一段不超过120字的情节脉络摘要（发生了什么、出场人物、关键转折），纯叙述、无标题无列表无markdown，直接输出正文：\n\n' + raw, { maxTokens: 220 }, cfg)
    .then((t) => {
      busy = false;
      if (t && t.length > 10) {
        db.prepare('UPDATE chapters SET digest=? WHERE id=?').run(t.slice(0, 400), next.id);
        setTimeout(() => { try { fillDigests(db, bookId, uptoCnum, cfg); } catch (e) {} }, 3000); // 串行慢补,别打爆限速
      }
    })
    .catch(() => { busy = false; }); // 失败即停
}

module.exports = { fillDigests };
