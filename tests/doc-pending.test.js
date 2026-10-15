/* 文档附件还在解析时：
 *   - 不许发出去（以前 handleSend 不看 loading，发给 AI 的是 content:'' 的空文件，
 *     解析完才回填进已经存好的节点，请求早就走了）；
 *   - 解析失败时只删自己的占位（以前 splice(indexOf(占位), 1)，占位已不在时 indexOf=-1，
 *     splice(-1,1) 删掉的是她为下一条消息新加的最后一个附件）。
 * vm 里真跑 05 的 handleSend（只跑到拦截点）和 09 的 addDocFile。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const api = fs.readFileSync(path.join(__dirname, '..', 'js', '05-prompts-api.js'), 'utf8');
const inp = fs.readFileSync(path.join(__dirname, '..', 'js', '09-appearance-input.js'), 'utf8');
function funcBody(s, sig) {
  const i = s.indexOf(sig);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { d++; started = true; }
    else if (s[j] === '}') { d--; if (started && d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

(async () => {
  console.log('\n【一】解析中不许发');
  {
    const seen = { toast: [], typing: 0 };
    const ctx = vm.createContext({
      document: { getElementById: () => ({ value: '看看这个' }) },
      _pendingImgs: [], _pendingFiles: [{ name: 'a.docx', content: '', loading: true }],
      showToast: (m) => seen.toast.push(m),
      popTypingNote: () => { seen.typing++; throw new Error('走过拦截点了'); },
      String,
    });
    vm.runInContext(funcBody(api, 'function handleSend('), ctx);
    let err = null;
    try { vm.runInContext('handleSend()', ctx); } catch (e) { err = e.message; }
    t('被拦下，没走到后面', err === null && seen.typing === 0, err);
    t('给了提示', seen.toast.some(m => /解析/.test(m)), seen.toast);
  }
  {
    const seen = { typing: 0 };
    const ctx = vm.createContext({
      document: { getElementById: () => ({ value: '看看这个' }) },
      _pendingImgs: [], _pendingFiles: [{ name: 'a.docx', content: '正文', loading: false }],
      showToast() {}, popTypingNote: () => { seen.typing++; throw new Error('STOP'); }, String,
    });
    vm.runInContext(funcBody(api, 'function handleSend('), ctx);
    try { vm.runInContext('handleSend()', ctx); } catch (e) {}
    t('对照组：解析完的照常往下走', seen.typing === 1);
  }

  console.log('\n【二】解析失败只删自己');
  {
    let rejectIt;
    const ctx = vm.createContext({
      _pendingFiles: [], renderPendingFiles() {}, alert() {},
      extractDocText: () => new Promise((_, rej) => { rejectIt = rej; }),
    });
    vm.runInContext(funcBody(inp, 'function addDocFile('), ctx);
    vm.runInContext('addDocFile({ name: "坏.docx" })', ctx);
    // 她先把占位 × 掉，又加了一个别的附件
    vm.runInContext('_pendingFiles.splice(0, 1); _pendingFiles.push({ name: "好.txt", content: "x" });', ctx);
    rejectIt(new Error('坏了'));
    await new Promise(r => setTimeout(r, 10));
    const names = vm.runInContext('_pendingFiles.map(f => f.name)', ctx);
    t('新加的附件还在', names.length === 1 && names[0] === '好.txt', names);
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
