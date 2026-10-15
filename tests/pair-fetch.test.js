/* 前端那半截：打到电脑 server 的 fetch 自动带配对码，**打到别处的一个字都不带**。
 *
 * 九十几处 fetch 散在二十个文件里，所以是在 01-core 里包一层 window.fetch。
 * 最要紧的反面：配对码绝不能跟着请求跑到 OpenAI / Supabase / 任何第三方 ——
 * 那等于把 /api 的钥匙递给外人。
 * gcTok 给 <img>/<audio>/整页跳转补 ?gct=，同源时不补（服务端种了 cookie）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', '01-core.js'), 'utf8');
const a = src.indexOf('let PAIR_TOKEN');
const endMark = 'window.fetch = wrapped;';
const b = src.indexOf(endMark, a);
if (a < 0 || b < 0) { console.log('✗ 找不到配对码那段'); process.exit(1); }
const block = src.slice(a, src.indexOf('}', b + endMark.length) + 1);

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + extra : '')); } };

function boot({ href, serverBase, token }) {
  const calls = [], toasts = [];
  const store = token ? { grancyanPairToken: token } : {};
  let nextStatus = 200, nextBody = '{}';
  const rawFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(nextBody, { status: nextStatus, headers: { 'content-type': 'application/json' } });
  };
  const window = { fetch: rawFetch };
  const ctx = vm.createContext({
    window, location: new URL(href), URL, Headers, Request, Response,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    showToast: (m) => toasts.push(m), Date, Object, String, JSON, Promise,
  });
  vm.runInContext(`const SERVER_BASE = ${JSON.stringify(serverBase)};\n${block}\nthis.gcTok = gcTok; this.setPairToken = setPairToken;`, ctx);
  return {
    ctx, calls, toasts, store,
    fetch: (...args) => ctx.window.fetch(...args),
    respond(status, body) { nextStatus = status; nextBody = body; },
    hdr(i) {
      const c = calls[i];
      if (c.init && c.init.headers) return new Headers(c.init.headers).get('X-GC-Token');
      if (c.input && c.input.headers) return c.input.headers.get('X-GC-Token');
      return null;
    },
  };
}

(async () => {
  const PC = 'http://192.168.1.43:3000';
  console.log('— 手机 APK（页面在 https://grancyan.app，server 是电脑 IP）');
  let e = boot({ href: 'https://grancyan.app/index.html', serverBase: PC, token: 'ABCDE23456' });
  await e.fetch(PC + '/api/reading/models');
  t('打电脑 server 带 X-GC-Token', e.hdr(0) === 'ABCDE23456', e.hdr(0));
  await e.fetch(PC + '/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  t('原有的头保留', new Headers(e.calls[1].init.headers).get('content-type') === 'application/json' && e.hdr(1) === 'ABCDE23456');
  t('method/body 不丢', e.calls[1].init.method === 'POST' && e.calls[1].init.body === '{}');
  await e.fetch(new Request(PC + '/api/y', { method: 'PUT', body: 'z' }));
  t('Request 对象也带', e.hdr(2) === 'ABCDE23456');
  await e.fetch('https://api.openai.com/v1/chat/completions', { headers: { Authorization: 'Bearer k' } });
  t('打 OpenAI 不带配对码', e.hdr(3) === null, e.hdr(3));
  await e.fetch('https://abcdefghijklmnop.supabase.co/rest/v1/x');
  t('打 Supabase 不带配对码', e.hdr(4) === null && e.calls[4].init === undefined);
  await e.fetch('http://192.168.1.43:3001/api/z');
  t('同 IP 别的端口不带', e.hdr(5) === null);
  await e.fetch('/index.html');
  t('APK 自己的相对路径（grancyan.app）不带', e.hdr(6) === null);

  t('gcTok 给电脑地址补 gct', e.ctx.gcTok(PC + '/api/tts?text=hi') === PC + '/api/tts?text=hi&gct=ABCDE23456');
  t('gcTok 没问号也补对', e.ctx.gcTok(PC + '/reading') === PC + '/reading?gct=ABCDE23456');
  t('gcTok 第三方不补', e.ctx.gcTok('https://example.com/a.png') === 'https://example.com/a.png');
  t('gcTok 补过的不重复补', e.ctx.gcTok(PC + '/x?gct=ABCDE23456') === PC + '/x?gct=ABCDE23456');

  e.respond(401, '{"error":"要码","pair":true}');
  const r = await e.fetch(PC + '/api/a');
  t('401 原样还给调用方', r.status === 401 && (await r.json()).pair === true);
  await e.fetch(PC + '/api/b');
  t('401 pair 提示一次（不刷屏）', e.toasts.length === 1 && /配对码/.test(e.toasts[0]), JSON.stringify(e.toasts));
  e.respond(401, '{"error":"supabase 没登录"}');
  e = boot({ href: 'https://grancyan.app/index.html', serverBase: PC, token: 'ABCDE23456' });
  e.respond(401, '{"error":"没登录"}');
  await e.fetch(PC + '/api/cloud-chats');
  t('别的 401（不是配对闸的）不弹配对提示', e.toasts.length === 0);

  e.ctx.setPairToken(' abcde-23457 ');
  t('setPairToken 规整大小写横杠空格并存盘', e.store.grancyanPairToken === 'ABCDE23457');
  await e.fetch(PC + '/api/c');
  t('改码后立刻用新码', e.hdr(1) === 'ABCDE23457', e.hdr(1));
  e.ctx.setPairToken('');
  t('清空就删掉', !('grancyanPairToken' in e.store));

  console.log('— 电脑本机（没码）');
  e = boot({ href: 'http://127.0.0.1:3000/', serverBase: 'http://127.0.0.1:3000', token: '' });
  const init = { method: 'POST', headers: { 'Content-Type': 'text/plain' } };
  await e.fetch('/api/x', init);
  t('没码时 init 原样透传', e.calls[0].init === init);
  t('没码时 gcTok 不动', e.ctx.gcTok('http://127.0.0.1:3000/api/tts') === 'http://127.0.0.1:3000/api/tts');

  console.log('— 手机浏览器直接开电脑地址（同源）');
  e = boot({ href: PC + '/', serverBase: PC, token: 'ABCDE23456' });
  await e.fetch('/api/x');
  t('同源相对路径也带头', e.hdr(0) === 'ABCDE23456');
  t('同源 gcTok 不补（靠 cookie）', e.ctx.gcTok(PC + '/api/tts') === PC + '/api/tts');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
