// 从命令行（比如一个 Claude Code 会话）往藏宝地图里埋纸条 / 看埋了什么。走 Supabase Management API 跑 SQL，
// 不经过 App，所以桌面端开没开都行；手机下次打开 App 拉表时就会挂上接近提醒。
//
// 配置全部走环境变量，别写进任何文件：
//   SUPABASE_PAT          sbp_ 开头的 Supabase 个人访问令牌
//   SUPABASE_PROJECT_REF  项目 ref（https://<ref>.supabase.co 里那段）
//   LETTER_OWNER_EMAIL    纸条埋给哪个账号（App 里登录用的邮箱）
// 用法：
//   node scripts/letter-hide.js --list
//   node scripts/letter-hide.js --place 公园门口 --title "给你的第一张" --body-file note.txt
//   node scripts/letter-hide.js --sql-file docs/letters.sql      （建表/改表）
// 地点必须是用户自己在地图上标过的（kind='place'），这边不收坐标——位置要用户亲手给。
const fs = require('fs');
const crypto = require('crypto');

const PROJECT = String(process.env.SUPABASE_PROJECT_REF || '').trim();
const OWNER_EMAIL = String(process.env.LETTER_OWNER_EMAIL || '').trim();

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : undefined;
}

async function sql(query) {
    const pat = process.env.SUPABASE_PAT;
    if (!pat || !pat.startsWith('sbp_')) throw new Error('缺 SUPABASE_PAT（sbp_ 开头的个人令牌）');
    if (!/^[a-z0-9]{10,40}$/.test(PROJECT)) throw new Error('缺 SUPABASE_PROJECT_REF（项目 ref）');
    const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
}

// 用随机 tag 的 dollar-quote 把整包 JSON 塞进 SQL，正文里有引号、反斜杠都不用转义
function dollar(s) {
    let tag;
    do tag = 'j' + crypto.randomBytes(6).toString('hex'); while (s.includes(tag));
    return `$${tag}$${s}$${tag}$`;
}

const OWNER = `(select id from auth.users where lower(email) = ${dollar(OWNER_EMAIL)} limit 1)`;

async function main() {
    if (!arg('sql-file') && !OWNER_EMAIL.includes('@')) throw new Error('缺 LETTER_OWNER_EMAIL（纸条埋给哪个账号）');
    const sqlFile = arg('sql-file');
    if (sqlFile) {
        console.log(JSON.stringify(await sql(fs.readFileSync(sqlFile, 'utf8')), null, 1));
        return;
    }
    if (process.argv.includes('--list')) {
        const rows = await sql(`select kind, place, title, hidden_by, created_at, found_at,
                case when kind = 'letter' and found_at is null then '（还埋着）' else left(body, 40) end as body
            from public.letters where user_id = ${OWNER} and deleted_at is null order by kind desc, created_at`);
        console.table(rows);
        return;
    }
    const place = arg('place'), title = arg('title');
    const body = arg('body-file') ? fs.readFileSync(arg('body-file'), 'utf8').trim() : arg('body');
    if (!place || !title || !body) throw new Error('用法见文件头：--place 地点 --title 标题 --body-file 正文.txt');
    const j = dollar(JSON.stringify({ place, title, body }));
    const rows = await sql(`insert into public.letters (user_id, kind, place, lat, lng, radius_m, title, body, hidden_by)
        select p.user_id, 'letter', p.place, p.lat, p.lng, p.radius_m, x.j->>'title', x.j->>'body', 'cc'
        from (select ${j}::jsonb as j) x
        join public.letters p on p.kind = 'place' and p.deleted_at is null
            and p.user_id = ${OWNER} and p.place = x.j->>'place'
        order by p.created_at desc limit 1
        returning id, place, title`);
    if (!rows.length) {
        const places = await sql(`select place from public.letters where kind = 'place' and deleted_at is null and user_id = ${OWNER}`);
        throw new Error(`没有叫「${place}」的地点。已标过的：${places.map(p => p.place).join('、') || '（还一个都没有）'}`);
    }
    console.log('埋好了：', rows[0]);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
