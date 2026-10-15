#!/usr/bin/env node
/* 行尾恢复器：把「编辑工具顺手统一掉的」行尾改回 HEAD 里原本的样子，让 diff 只剩真实改动。
 *
 *   node scripts/restore-eol.js js/14-boot-brain-hub.js
 *   node scripts/restore-eol.js <文件> [<git-ref>]      # ref 默认 HEAD:<文件>
 *
 * 为什么需要它：
 *   本仓库 core.autocrlf=false（git 原样存储），而有些文件是**混合行尾**——
 *   js/14-boot-brain-hub.js 就是 965 行 CRLF + 29 行 LF。编辑工具写回时会把少数派
 *   统一成多数派，于是那 29 行全部算作改动：git diff 报 112/34，加 -w 只有 49/5。
 *   `sed -i` 是同一个病的另一个方向（把整个文件转成 LF）。
 *   后果：git log -p / git blame / code review 全看不出这次到底改了什么；
 *   diff 撑大还会让 Codex 审查读不完直接超时。
 *
 * 判据（提交前必查，跟用哪个工具无关）：
 *   git diff --shortstat   和   git diff --shortstat -w
 *   两个数字必须一模一样。不一样就是被污染了，跑这个脚本修。
 *
 * 安全性：逐行校验内容，任何一行对不上就整个中止、不写入任何东西。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/restore-eol.js <文件> [<git-ref>]');
  process.exit(2);
}
const ref = process.argv[3] || `HEAD:${file.replace(/\\/g, '/')}`;

let blob;
try {
  blob = execFileSync('git', ['show', ref], { maxBuffer: 1e8 }).toString('utf8');
} catch {
  console.error(`✗ 取不到 ${ref}（文件可能还没进过 git，那就没有"原本的行尾"可恢复）`);
  process.exit(2);
}
const work = fs.readFileSync(file, 'utf8');
const bl = blob.split('\n');
const wl = work.split('\n');
const OFFSET = wl.length - bl.length;

// blob 里以 LF 结尾（即没有 \r）的行，就是要恢复的目标
const targets = [];
bl.forEach((l, i) => { if (i < bl.length - 1 && !l.endsWith('\r')) targets.push([i, l]); });
if (!targets.length) {
  console.log('该文件在 HEAD 里行尾本来就是统一的，无需恢复。');
  process.exit(0);
}

const plan = [];
for (const [bi, content] of targets) {
  // 改动之前的行号不变；之后的整体后移 OFFSET。两个候选里挑内容对得上的那个。
  const cands = [...new Set([bi, bi + OFFSET])];
  const hit = cands.filter(wi => wl[wi] !== undefined && wl[wi].replace(/\r$/, '') === content);
  if (hit.length !== 1) {
    console.error(`✗ 第 ${bi + 1} 行定位失败（候选 ${cands.map(c => c + 1).join('/')} 命中 ${hit.length} 个），已中止，未写入任何内容`);
    console.error(`   内容: ${JSON.stringify(content.slice(0, 60))}`);
    console.error('   多半是这一带的改动太大导致行号对不上，请手工核对。');
    process.exit(1);
  }
  if (wl[hit[0]].endsWith('\r')) plan.push(hit[0]);
}
if (!plan.length) {
  console.log(`✓ ${targets.length} 行目标行尾都已正确，无需改动。`);
  process.exit(0);
}
for (const wi of plan) wl[wi] = wl[wi].replace(/\r$/, '');
fs.writeFileSync(file, wl.join('\n'), 'utf8');
console.log(`✓ 已把 ${plan.length} 行的行尾恢复为 LF（目标 ${targets.length} 行，其余本就正确）`);
