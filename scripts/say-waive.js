#!/usr/bin/env node
'use strict';
// 把说话账本里的某一笔标成「不算额度」。
//
// 为什么要有这个脚本，而不是让某个端点去写：
//   waived 是护栏上的一道口子 —— 能被 HTTP 请求打开的护栏不算护栏。
//   同锁文件只能手动删（social-browser.js 里 lockStuckError 那段）：
//   fail-closed 的代价是要人动手，那就给人一个能照着做的工具，而不是一个自动开关。
//
// 用法：
//   node scripts/say-waive.js --list                     看今天占额度的都有哪些
//   node scripts/say-waive.js <at> "<为什么不算>"        豁免一笔（at 就是 --list 里那串时间戳）
//   node scripts/say-waive.js --undo <at>                撤销豁免
//
// ⚠️ 它**不删记录、不改 state**。那几笔评论是真发出去的，账本必须照实记着；
//    豁免只是额外说明「这一笔不计入当天配额」以及为什么。
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.GRANCYAN_SAY_STATE
    || path.join(os.homedir(), '.grancyan', 'social-says.json');
const COUNTS = new Set(['sending', 'pending', 'submitted', 'unknown']);
const today = () => new Date().toLocaleDateString('sv-SE');

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { console.error(`读不到账本 ${FILE}：${e.message}`); process.exit(2); }
}
function save(s) {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);          // 原子替换，看板不会读到半个 JSON
}

const args = process.argv.slice(2);
const s = load();
const says = s.says || [];

if (!args.length || args[0] === '--list') {
    const t = today();
    const mine = says.filter(x => x.date === t);
    if (!mine.length) { console.log(`今天（${t}）一条都没有。`); process.exit(0); }
    console.log(`今天（${t}）的记录：\n`);
    for (const x of mine) {
        const counts = !x.waived && COUNTS.has(x.state || 'submitted');
        console.log(`  ${counts ? '占额度' : '不占  '}  ${x.at}  [${x.state}]${x.waived ? ' 已豁免' : ''}`);
        console.log(`            「${String(x.text || '').slice(0, 46)}」`);
        if (x.waived) console.log(`            豁免原因：${x.waivedWhy || '(没写)'}（${x.waivedAt || ''}）`);
    }
    console.log(`\n占额度合计：${mine.filter(x => !x.waived && COUNTS.has(x.state || 'submitted')).length}`);
    console.log(`豁免一笔：node scripts/say-waive.js <上面那串 at> "为什么不算"`);
    process.exit(0);
}

if (args[0] === '--undo') {
    const at = args[1];
    if (!at) { console.error('要撤销哪一笔？把 at 那串时间戳给我。'); process.exit(2); }
    const rec = says.find(x => x.at === at);
    if (!rec) { console.error(`账本里没有 at=${at} 这一笔`); process.exit(2); }
    delete rec.waived; delete rec.waivedWhy; delete rec.waivedAt;
    save(s);
    console.log(`已撤销豁免：${at} —— 这一笔重新占额度。`);
    process.exit(0);
}

const [at, why] = args;
// ⚠️ 原因是必填的。少了它，账本上就只剩「这笔不算」而没有「为什么」，
//    过两天谁都说不清是真有理由还是当时想多发一条。
if (!why || !why.trim()) {
    console.error('要写清楚为什么不算，这是必填的。');
    console.error('  node scripts/say-waive.js <at> "重复发送，小红书上那条已删"');
    process.exit(2);
}
const rec = says.find(x => x.at === at);
if (!rec) { console.error(`账本里没有 at=${at} 这一笔（先跑 --list 看看）`); process.exit(2); }
if (rec.waived) { console.log(`${at} 早就豁免过了：${rec.waivedWhy}`); process.exit(0); }

rec.waived = true;
rec.waivedWhy = why.trim();
rec.waivedAt = new Date().toISOString();
save(s);
console.log(`已豁免：${at}\n  原因：${rec.waivedWhy}`);
console.log(`  记录本身没动（state 还是 ${rec.state}）—— 那条评论确实发出去了。`);
const left = says.filter(x => x.date === today() && !x.waived && COUNTS.has(x.state || 'submitted')).length;
console.log(`  今天现在占了 ${left} 条。`);
