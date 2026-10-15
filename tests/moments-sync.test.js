'use strict';
// 猫爪日报跨设备同步（momentsMerge）+ 从聊天记录找回（momentsRecoverFromChats）。
// 背景：2026-10-10 电脑的 IndexedDB 被硬杀 exe 弄得整个重建，动态只存本机，一条不剩。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const momentsSrc = read('js/51-moments.js');
const coreSrc = read('js/01-core.js');

let passed = 0;
let failed = 0;
function t(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function makeBox(startId) {
  let next = startId || 1000;
  let saves = 0;
  const box = {
    console, Date,
    state: { moments: [], chars: [], configs: [], chats: [], userName: '小明', userAvatar: '' },
    nextId: () => ++next,
    save: () => { saves++; },
    document: { getElementById: () => null },
    showToast: () => {}
  };
  vm.createContext(box);
  vm.runInContext(momentsSrc, box, { filename: '51-moments.js' });
  box.saves = () => saves;
  return box;
}
const run = (box, code) => vm.runInContext(code, box);
const clone = v => JSON.parse(JSON.stringify(v));

console.log('\n[1] 合并：被删光的一台从云端拿回来，谁也冲不掉谁');
{
  const box = makeBox();
  const cloud = [
    { id: 5, author: 'user', ts: 100, text: '今天天气不错', images: [], likes: [], comments: [] },
    { id: 6, author: '小克', ts: 200, text: '今天读书', images: [], likes: ['user'], comments: [] }
  ];
  box.cloud = clone(cloud);
  const out = run(box, 'momentsMerge([], cloud)');
  t('★ 本机为空 → 云端两条原样回来', out.length === 2 && out[0].text === '今天天气不错' && out[1].likes[0] === 'user');

  box.local = [{ id: 7, author: 'user', ts: 300, text: '本机刚发的', images: [], likes: [], comments: [] }];
  box.cloud = clone(cloud);
  const out2 = run(box, 'momentsMerge(local, cloud)');
  t('★ 本机新发的 + 云端的并集，一条不少', out2.length === 3 && out2.some(m => m.text === '本机刚发的'));

  box.cloud = [];
  box.local = clone(cloud);
  t('★ 云端为空（老版本推上去没这个键）不会冲掉本机', run(box, 'momentsMerge(local, cloud)').length === 2);
}

console.log('\n[2] 撞号：两台各发一条拿到同一个 id，不能吞掉一条');
{
  const box = makeBox(5000);
  box.a = [{ id: 42, author: 'user', ts: 100, text: '电脑发的', images: [], likes: [], comments: [] }];
  box.b = [{ id: 42, author: '小克', ts: 200, text: '手机上 AI 发的', images: [], likes: [], comments: [] }];
  const out = run(box, 'momentsMerge(a, b)');
  const ids = out.map(m => String(m.id));
  t('★ 两条都在', out.length === 2, JSON.stringify(out));
  t('★ 撞号后 id 互不相同，发得早的那条保住原号',
    new Set(ids).size === 2 && out.find(m => m.text === '电脑发的').id === 42);

  // 两台各自给晚的那条换了不同的新号 → 同一条（同作者同时间）取大的号，收敛
  box.x = [{ id: 9001, author: '小克', ts: 200, text: '手机上 AI 发的', images: [], likes: [], comments: [] }];
  box.y = [{ id: 7003, author: '小克', ts: 200, text: '手机上 AI 发的', images: [], likes: [], comments: [] }];
  const conv = run(box, 'momentsMerge(x, y)');
  t('★ 同一条两边号不同 → 取大的，只留一条', conv.length === 1 && conv[0].id === 9001);
}

console.log('\n[3] 评论和爪印');
{
  const box = makeBox();
  const base = { id: 1, author: 'user', ts: 100, text: 'x', images: [] };
  box.a = [Object.assign({}, base, { likes: [], comments: [{ id: 11, author: '小克', ts: 150, text: '电脑上的评论' }] })];
  box.b = [Object.assign({}, base, { likes: [], comments: [{ id: 11, author: 'user', ts: 160, text: '手机上的评论' }] })];
  const out = run(box, 'momentsMerge(a, b)');
  t('★ 两台各自加的评论都留着（评论撞号也不吞）', out[0].comments.length === 2, JSON.stringify(out[0].comments));

  // 老数据：电脑上赞着（没戳），手机上取消了（有戳）→ 取消赢
  box.a = [Object.assign({}, base, { likes: ['user'], comments: [] })];
  box.b = [Object.assign({}, base, { likes: [], likeLog: { user: -1790000000000 }, comments: [] })];
  t('★ 另一台取消的爪印不会被旧副本并回来', run(box, 'momentsMerge(a, b)')[0].likes.length === 0);

  // 先取消、后又点上 → 点上赢
  box.a = [Object.assign({}, base, { likes: [], likeLog: { user: -100 }, comments: [] })];
  box.b = [Object.assign({}, base, { likes: ['user'], likeLog: { user: 200 }, comments: [] })];
  t('★ 后点的爪印赢过先前的取消', run(box, 'momentsMerge(a, b)')[0].likes.join() === 'user');

  // 面板上点爪 / 取消会盖戳
  box.state.moments = [Object.assign({}, base, { likes: [], comments: [] })];
  run(box, 'momentsToggleLike(1)');
  const on = box.state.moments[0].likeLog.user;
  run(box, 'momentsToggleLike(1)');
  const off = box.state.moments[0].likeLog.user;
  t('★ 点爪盖正戳、取消盖负戳', on > 0 && off < 0, on + ' / ' + off);
}

console.log('\n[4] momentsSyncApply：有变化才落盘');
{
  const box = makeBox();
  box.state.moments = [{ id: 1, author: 'user', ts: 100, text: 'x', images: [], likes: [], comments: [] }];
  const before = box.saves();
  const changed = run(box, 'momentsSyncApply([{ id: 1, author: "user", ts: 100, text: "x", images: [], likes: [], comments: [] }])');
  t('★ 云端跟本机一样 → 不改、不落盘', changed === false && box.saves() === before);
  const changed2 = run(box, 'momentsSyncApply([{ id: 2, author: "小克", ts: 50, text: "云上的", images: [], likes: [], comments: [] }])');
  t('★ 云端有新的 → 收进来并落盘', changed2 === true && box.saves() === before + 1 && box.state.moments.length === 2);
}

console.log('\n[5] 从聊天记录找回');
{
  const box = makeBox(1800000000000);
  const card = txt => '<button type="button" class="moment-chat-card" onclick="openMoments()"><span class="moment-chat-kicker">📷 发了条朋友圈</span><span class="moment-chat-text">' + txt + '</span></button>';
  const reply = (id, name, txt) => '<span class="moment-echo" data-moment-kind="reply" data-moment-id="' + id + '" data-moment-text="' + txt + '">💬 评论了 ' + name + '：' + txt + '</span>';
  const like = (id, name) => '<span class="moment-echo" data-moment-kind="like" data-moment-id="' + id + '">👍 赞了 ' + name + ' 的动态</span>';
  const postText = '写这个的人当时十岁。我坐在这儿想了一晚上，没想出更好的收尾。';
  box.state.userName = 'Alice阿明';
  box.state.configs = [{ id: 51274, nickname: '本地 Claude (省Token)' }];
  box.state.chats = [{
    id: 1, nodes: {
      10: { id: 10, role: 'user', content: card('用户消息里的不算'), timestamp: 1 },
      11: {
        id: 11, role: 'ai', modelId: 51274, modelNickname: '旧名字', timestamp: 1788000000000,
        // 正文和 blocks 各存了一份同样的卡片和回执
        content: '好\n\n' + card(postText) + '\n\n' + reply('1700000000000', 'Alice阿明', '好看。不过&quot;收尾&quot;'),
        blocks: [{ type: 'text', text: card(postText) + reply('1700000000000', 'Alice阿明', '好看。不过&quot;收尾&quot;') }]
      },
      12: {
        id: 12, role: 'ai', isMulti: true, timestamp: 1789000000000,
        variants: [{ modelId: 999, modelNickname: 'Gemini', content: reply('1700000000000', 'Alice阿明', '写得真好！🐾') + like('1700000000000', 'Alice阿明') }]
      }
    }
  }];
  const found = run(box, 'momentsRecoverFromChats()');
  const ms = box.state.moments;
  const post = ms.find(m => m.text === postText);
  const lost = ms.find(m => String(m.id) === '1700000000000');
  t('★ AI 发的帖找回来了，作者按现在的模型卡名、时间是那条消息的时间',
    post && post.author === '本地 Claude (省Token)' && post.ts === 1788000000000, JSON.stringify(post));
  t('★ 正文和 blocks 里的同一张卡只算一条', ms.filter(m => m.text === postText).length === 1);
  t('★ 用户消息里的卡不算', !ms.some(m => m.text === '用户消息里的不算'));
  t('★ 她自己那条（帖子本身没了）补了占位，作者认成她', lost && lost.author === 'user' && lost.text === run(box, 'MOMENTS_LOST_TEXT'));
  t('★ 评论挂回去了，HTML 转义还原、多模型变体也认', lost && lost.comments.length === 2
    && lost.comments[0].text === '好看。不过"收尾"' && lost.comments[0].author === '本地 Claude (省Token)'
    && lost.comments[1].author === 'Gemini', JSON.stringify(lost && lost.comments));
  t('★ 爪印也挂回去了', lost && lost.likes.join() === 'Gemini');
  t('★ 返回找回的处数并落盘', found === 5 && box.saves() === 1, String(found));

  const again = run(box, 'momentsRecoverFromChats()');
  t('★ 再点一次不重复', again === 0 && box.state.moments.length === 2);

  // 两台各自找回一遍 → 同一条按「作者 + 时间」认成一条
  const other = makeBox(1800000100000);
  other.state.userName = box.state.userName;
  other.state.configs = box.state.configs;
  other.state.chats = box.state.chats;
  run(other, 'momentsRecoverFromChats()');
  box.o = clone(other.state.moments);
  box.m = clone(box.state.moments);
  const merged = run(box, 'momentsMerge(m, o)');
  t('★ 两台各找回一遍再同步，不会翻倍', merged.length === 2 && merged.find(m => m.text === postText)
    && merged.find(m => String(m.id) === '1700000000000').comments.length === 2, JSON.stringify(merged.map(m => [m.id, m.text])));
}

console.log('\n[6] 01-core.js 推 / 拉两处都接上了');
{
  const pushStart = coreSrc.indexOf('async function syncSettingsToCloud()');
  const pushEnd = coreSrc.indexOf('async function cloudRetry', pushStart);
  const push = coreSrc.slice(pushStart, pushEnd);
  t('★ 推之前合并云端那份', /momentsSyncApply\(cloud\.moments\)/.test(push) && /settings\.moments = state\.moments/.test(push));
  t('★ settings 整包里带着 moments', /moments: state\.moments \|\| \[\]/.test(push));
  const pullStart = coreSrc.indexOf('async function loadFromCloud()');
  const pull = coreSrc.slice(pullStart, pullStart + 30000);
  t('★ 拉下来时合并进本机', /momentsSyncApply\(s\.moments\)/.test(pull));
}

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
