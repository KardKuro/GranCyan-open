/* server.js / server/band.js 一批静默故障的回归测试（2026-09-27）。
 *
 * 每一条修的都是「不报错，东西就是没了 / 没生效」那一类：
 *   A 提前 return 时续传索引被消费掉却没放回、临时图片不删
 *   B 本地 GPT 纯聊天一断线就裸 kill → 会话不落盘 → 下一轮整段历史重发
 *   C GPT 的「5 分钟没正文」计时器把正常干活的进程掐掉，还报成鉴权问题
 *   D 候选里的 codex.cmd：不带 shell 的 spawn 同步抛 EINVAL，SSE 连接直接断
 *   E /api/local-gpt 没有 agentSub 单飞锁（工作台以为有）
 *   F 记忆桥把 EBUSY/EPERM 当坏文件隔离
 *   G 没证书时两个端口共用一个 http.Server，第二个 listen 必抛
 *   H hf/ort 代理 fetch 没超时，_hfInflight 永远 pending
 *   I 手环 pull 不单飞 / sql.js 每次重新实例化 wasm
 *   J 订阅 Claude 只走官方 CLI：带图（stream-json 输入）和后台小活（claudeOnce）都不直连 API
 *   K materializeImages 同一毫秒撞名
 *
 * 手法：能真跑的就真跑 —— B/C/D/E/G 真起 server（另起端口、GRANCYAN_ROOT/APPDATA 全指临时目录，
 * 碰不到用户的真实数据和续传索引），GPT_BIN 指到 node.exe，ROOT 里放一个叫 `exec` 的假 codex
 * 脚本（codex 的第一个参数就是 exec，node 会把它当脚本跑）。**不起真 Claude / Codex**。
 * 其余从 server.js 抠真源码进 vm 跑（不复刻，复刻的话源码改坏了照样绿）。
 *
 * 跑法：node tests/server-fixes.test.js      只跑某几组：SF_ONLY=B,C node tests/server-fixes.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const REPO = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const ONLY = (process.env.SF_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const want = g => !ONLY.length || ONLY.includes(g);

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };

// 抠源码：from 到 to（不含 to），after 限定从哪个锚点之后找
function seg(from, to, after) {
  const base = after ? SRC.indexOf(after) : 0;
  const a = SRC.indexOf(from, base < 0 ? 0 : base);
  const b = SRC.indexOf(to, a + 1);
  if (base < 0 || a < 0 || b < 0) throw new Error(`抠不到源码：${from.trim().slice(0, 50)} → ${to.trim().slice(0, 50)}（server.js 结构变了？）`);
  return SRC.slice(a, b);
}
function ctxOf(extra) {
  const ctx = Object.assign({ console: quiet, JSON, String, Number, Math, Object, Array, Map, Set, Error, Buffer, parseInt, decodeURIComponent }, extra);
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-server-fixes-'));
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"commonjs"}');   // exec 按 CJS 跑，别被上层 package.json 左右

(async () => {
  // ══════════════════ K：materializeImages 同毫秒不撞名 ══════════════════
  if (want('K')) {
    console.log('\n[K] 同一毫秒落两张图不撞名');
    const dir = fs.mkdtempSync(path.join(TMP, 'img-'));
    const ctx = ctxOf({
      path, fs, crypto: require('crypto'), Date: { now: () => 1700000000000 },   // 钉死同一毫秒
      axios: {}, gptLog() {},
      require: m => (m === 'os' ? { tmpdir: () => dir } : require(m)),
    });
    vm.runInContext(seg('const GPT_IMG_MIME_EXT = {', '\nfunction cleanupImages'), ctx);
    const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
    const [a, b] = await Promise.all([ctx.materializeImages([png]), ctx.materializeImages([png])]);
    t('★ 两个请求同一毫秒各落一张图，文件名不同', a.length === 1 && b.length === 1 && a[0] !== b[0], [a, b]);
    t('两张都真的在盘上（没有谁覆盖谁）', a.concat(b).every(f => fs.existsSync(f)));
  }

  // ══════════════════ F：记忆桥 I/O 错不隔离 ══════════════════
  if (want('F')) {
    console.log('\n[F] 记忆桥：读不了 ≠ 坏了');
    const moved = [];
    const content = {
      '100-good': JSON.stringify({ id: '100-good', text: '一条好记忆' }),
      '101-bad': '{这不是 json',
      '102-shape': JSON.stringify({ id: '102-shape', text: '' }),
    };
    const ioErr = { '103-busy': 'EBUSY', '104-perm': 'EPERM', '105-gone': 'ENOENT' };
    const fakeFs = {
      readFileSync(p) {
        const id = path.basename(p, '.json');
        if (ioErr[id]) throw Object.assign(new Error(ioErr[id] + ': ' + p), { code: ioErr[id] });
        return content[id];
      },
      mkdirSync() {},
      renameSync(from) { moved.push(path.basename(from, '.json')); },
    };
    const ctx = ctxOf({ fs: fakeFs, path, INBOX_ITEMS: 'X:\\inbox\\items', INBOX_BAD: 'X:\\inbox\\quarantine' });
    vm.runInContext(seg('const INBOX_ID_RE ', '\n\n// server 监听 0.0.0.0，这几个端点'), ctx);
    vm.runInContext(seg('function inboxItemValid(m) {', '\nfunction inboxListIds'), ctx);
    t('★ EBUSY（Defender 正扫着刚落地的文件）→ 这次跳过，不隔离',
      ctx.inboxReadItem('103-busy') === null && !moved.includes('103-busy'), moved);
    t('★ EPERM 同上', ctx.inboxReadItem('104-perm') === null && !moved.includes('104-perm'), moved);
    t('ENOENT（被 sweep 删了）→ null，也不去挪', ctx.inboxReadItem('105-gone') === null && !moved.includes('105-gone'));
    t('对照：JSON 坏了照样隔离', ctx.inboxReadItem('101-bad') === null && moved.includes('101-bad'), moved);
    t('对照：结构不对（text 空）照样隔离', ctx.inboxReadItem('102-shape') === null && moved.includes('102-shape'), moved);
    const good = ctx.inboxReadItem('100-good');
    t('对照：好文件照常读出来', good && good.text === '一条好记忆' && !moved.includes('100-good'));
  }

  // ══════════════════ H：hf 代理上游挂住不会永远 pending ══════════════════
  if (want('H')) {
    console.log('\n[H] hf/ort 缓存代理：上游挂住有超时，在飞表能清掉');
    const timeouts = [];
    const inflight = new Map();
    const ctx = ctxOf({
      path, HF_CACHE_DIR: path.join(TMP, 'hf'), _hfInflight: inflight,
      fsp: { access: async () => { throw new Error('nope'); }, mkdir: async () => {}, writeFile: async () => {}, rename: async () => {} },
      // 上游永远不回：只有 signal 能把它掐断
      fetch: (url, opts) => new Promise((_, rej) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(opts.signal.reason || new Error('aborted')));
      }),
      // 记下源码要的时长，实际给一个 80ms 的，免得真等十分钟
      AbortSignal: { timeout: ms => { timeouts.push(ms); return AbortSignal.timeout(80); } },
    });
    vm.runInContext(seg('async function serveCachedUpstream(', '\napp.get(/^\\/api\\/hf\\/'), ctx);
    let replied = null;
    const res = {
      code: 200, setHeader() {}, type() {}, sendFile() { replied = 'sent'; },
      status(c) { this.code = c; return this; }, json(o) { replied = o; },
    };
    const p = ctx.serveCachedUpstream(res, 'Xenova/bge-small-zh-v1.5/resolve/main/x.json', 'https://hf-mirror.example/x', 'hf');
    const settled = await Promise.race([p.then(() => true), sleep(2000).then(() => false)]);
    t('★ 上游挂住时请求能结束（不再永远 pending）', settled && replied !== null, replied);
    t('结束的方式是 502，不是假装成功', res.code === 502, res.code);
    t('★ 在飞表清掉了（后来的请求不会排在一个死 promise 后面）', inflight.size === 0, inflight.size);
    t('超时量级是分钟级（给大 wasm 留了余量，不是几秒就掐）', timeouts.length === 1 && timeouts[0] >= 60000 && timeouts[0] <= 30 * 60000, timeouts);
  }

  // ══════════════════ J：订阅 Claude 只走官方 CLI（带图、后台小活都一样） ══════════════════
  if (want('J')) {
    console.log('\n[J] 订阅 Claude：不读凭据、不直连 API；带图 / 后台小活都交给 claude CLI');
    t('★ server.js 不再读 Claude Code 的登录凭据', !/credentials\.json|claudeAiOauth/.test(SRC));
    t('★ server.js 不再直接打 api.anthropic.com', !/api\.anthropic\.com/.test(SRC));
    t('★ 不再伪装 claude-cli 的 UA / 身份串 / oauth beta 头',
      !/claude-cli\/|You are Claude Code|oauth-2025|ccUserAgent|CC_UA/.test(SRC));

    // claudeOnce 真跑：spawnOrDead 换成假进程，看它给 CLI 的参数和 stdin，再喂回 stream-json 输出
    const onceSrc = seg('const CLAUDE_ONCE_TIMEOUT_MS', '\n// ── 看图记忆');
    const mkOnce = (reply, extra) => {
      const seen = { args: null, stdin: '', killed: 0, timers: [] };
      const ctx = ctxOf(Object.assign({
        os: { tmpdir: () => TMP }, claudeLog() {},
        resolveClaudeExeWaiting: async () => 'C:\\fake\\claude.exe',
        stopAgentProcess: () => { seen.killed++; },
        setTimeout: (fn, ms) => { seen.timers.push({ fn, ms }); return seen.timers.length; },
        clearTimeout: () => {},
        spawnOrDead: (exe, args) => {
          seen.args = args;
          const p = new EventEmitter();
          p.stdout = new PassThrough(); p.stderr = new PassThrough();
          p.stdin = new PassThrough();
          p.stdin.on('data', d => { seen.stdin += d.toString(); });
          p.stdin.on('finish', () => setImmediate(() => {
            if (!reply) return;                      // 不回 = 卡住，等超时
            p.stdout.write(reply.out);
            setImmediate(() => p.emit('close', reply.code || 0));
          }));
          return p;
        },
      }, extra || {}));
      vm.runInContext(onceSrc + '\nthis.claudeOnce = claudeOnce; this.TMO = CLAUDE_ONCE_TIMEOUT_MS;', ctx);
      return { ctx, seen };
    };
    const ok = [
      JSON.stringify({ type: 'system', subtype: 'init', tools: [] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '一只橘猫' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '一只橘猫', usage: { input_tokens: 12, output_tokens: 5 } }),
    ].join('\n') + '\n';
    {
      const { ctx, seen } = mkOnce({ out: ok });
      const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
      const r = await ctx.claudeOnce({ system: '写备忘', model: 'claude-haiku-5-5', user: [img, { type: 'text', text: '写这张图的备忘。' }] });
      const a = seen.args || [];
      const after = k => a[a.indexOf(k) + 1];
      t('★ 结果从 CLI 的 result 行拿', r.text === '一只橘猫' && r.usage.output_tokens === 5, r);
      t('★ 一个工具都不给（--tools ""）、不挂 MCP、不留会话',
        a.includes('--tools') && after('--tools') === '' && a.includes('--strict-mcp-config') && !a.includes('--mcp-config')
        && a.includes('--no-session-persistence'), a);
      // 不加的话 claude -p 会读用户全局的 ~/.claude/CLAUDE.md、settings.json 和 hooks（实测）。
      // 不能用 --bare 代替：它强制 API key 认证，订阅登录用不了
      t('★ 隔离用户配置：--setting-sources ""（不读全局 CLAUDE.md / settings / hooks），且没用 --bare',
        a.includes('--setting-sources') && after('--setting-sources') === '' && !a.includes('--bare'), a);
      t('模型和系统提示原样交给 CLI', after('--model') === 'claude-haiku-5-5' && after('--system-prompt') === '写备忘', a);
      let msg = null; try { msg = JSON.parse(seen.stdin.trim()); } catch {}
      t('★ 图走 stream-json 的 user 消息（CLI 收得下 base64 图）',
        after('--input-format') === 'stream-json' && msg && msg.type === 'user'
        && msg.message.content[0].type === 'image' && msg.message.content[0].source.data === 'AAAA', seen.stdin.slice(0, 200));
      t('★ 时长上界 240s 没变（social-browser 的陈旧阈值是从它推出来的）', ctx.TMO <= 240 * 1000 && seen.timers[0] && seen.timers[0].ms === ctx.TMO, ctx.TMO);
    }
    {
      // 系统提示很长（心跳带着人设 + 最近聊天）：换 --system-prompt-file，跑完删掉；Haiku 5 压 --effort low
      const { ctx, seen } = mkOnce({ out: ok }, { fs, path, process, Date });
      const longSys = '人设'.repeat(15000);
      await ctx.claudeOnce({ system: longSys, model: 'claude-haiku-5-5', user: 'x' });
      const a = seen.args || [], fi = a.indexOf('--system-prompt-file');
      const file = fi >= 0 ? a[fi + 1] : '';
      t('★ 长系统提示走 --system-prompt-file（命令行有 32767 上限），不再塞命令行',
        fi >= 0 && !a.includes('--system-prompt') && !a.some(x => x === longSys), a.map(x => String(x).slice(0, 30)));
      t('  临时文件跑完就删了', !!file && !fs.existsSync(file), file);
      t('★ Haiku 5 压到 --effort low', a[a.indexOf('--effort') + 1] === 'low', a);
      const { ctx: c2, seen: s2 } = mkOnce({ out: ok });
      await c2.claudeOnce({ system: 's', model: 'claude-opus-5-5', user: 'x' });
      t('  别的型号不传 effort，系统提示短的照旧走命令行',
        !(s2.args || []).includes('--effort') && (s2.args || []).includes('--system-prompt'), s2.args);
      t('  长系统提示那条路也带着 --setting-sources ""', a.includes('--setting-sources') && a[a.indexOf('--setting-sources') + 1] === '', a.map(x => String(x).slice(0, 30)));
      // 聊天主路（/api/local-claude）是有意读用户配置的（记忆互通等），不许被顺手也隔离掉
      const chatArgs = seg("app.post('/api/local-claude'", '\n});\n');
      t('  聊天主路 /api/local-claude 不带 --setting-sources', /--include-partial-messages/.test(chatArgs) && !/--setting-sources/.test(chatArgs), chatArgs.length);
    }
    {
      const { ctx, seen } = mkOnce({ out: JSON.stringify({ type: 'result', subtype: 'success', result: '早' }) + '\n' });
      const r = await ctx.claudeOnce({ system: 's', model: 'claude-haiku-5-5', user: '说句早安' });
      let msg = null; try { msg = JSON.parse(seen.stdin.trim()); } catch {}
      t('纯文字也包成一条 text 块', r.text === '早' && msg && msg.message.content[0].text === '说句早安', seen.stdin);
    }
    {
      const { ctx } = mkOnce({ out: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'model not found' }) + '\n', code: 1 });
      let err = '';
      try { await ctx.claudeOnce({ system: 's', model: 'claude-nope', user: 'x' }); } catch (e) { err = e.message; }
      t('★ CLI 报错 → 抛出来，带上它的原话', /model not found/.test(err), err);
    }
    {
      let err = '';
      try { await mkOnce({ out: ok }).ctx.claudeOnce({ system: 's', model: '', user: 'x' }); } catch (e) { err = e.message; }
      t('不给模型名 → 直接拒（别悄悄回退到 CLI 默认的大模型）', /必须显式指定模型/.test(err), err);
    }
    {
      const { ctx, seen } = mkOnce(null);
      const p = ctx.claudeOnce({ system: 's', model: 'claude-haiku-5-5', user: 'x' });
      await sleep(20);
      seen.timers[0].fn();                           // 到点
      let err = '';
      try { await p; } catch (e) { err = e.message; }
      t('★ 卡住到点 → 整棵进程树掐掉、报超时', seen.killed === 1 && /超时/.test(err), { killed: seen.killed, err });
    }

    // 路由：纯聊天带图 → 图变成内容块交给 CLI；认不了的格式跳过
    {
      const ctx = ctxOf({ claudeLog() {}, axios: { get: async () => { throw new Error('不该联网'); } } });
      vm.runInContext(seg('function parseImageDataUrl(s) {', "\napp.post('/api/img-describe'") + '\n'
        + seg('const CLAUDE_IMG_TYPES', '\n}\n') + '\n}\n', ctx);
      const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
      const blocks = await ctx.imageBlocksFor([png, 'data:image/bmp;base64,Qk0=', 42]);
      t('★ data URL → base64 图块；bmp / 怪东西跳过，不让整轮失败',
        blocks.length === 1 && blocks[0].type === 'image' && blocks[0].source.media_type === 'image/png', blocks);
    }
    const route = seg("app.post('/api/local-claude'", "\napp.post('/api/local-gpt'");
    t('★ 带图的轮才换 stream-json 输入，图和文字同一条 user 消息',
      /if \(inlineImages\.length\) args\.push\('--input-format', 'stream-json'\)/.test(route)
      && /\[\.\.\.inlineImages, \{ type: 'text', text: prompt \}\]/.test(route));
    t('★ 带内联图的轮不登记续传（会话里躺着整张图，续下去每轮都背着它）',
      /chatMsgs\.length && !inlineImages\.length\) \{\s*\n\s*rememberSession/.test(route));
  }

  // ══════════════════ A + E（第二道锁）：路由里 spawn 之前的提前 return ══════════════════
  if (want('A')) {
    console.log('\n[A] 本地 Claude：spawn 之前每个提前 return 都放回续传索引、删临时图');
    const claudeSeg = seg('    const bailBeforeSpawn = () => {', '    // spawn 的工作目录不存在时', "app.post('/api/local-claude'");
    const runClaude = async ({ prompt = 'hi', destroyed = false, runs = [] }) => {
      const calls = { cleanup: [], restore: [] };
      const res = { destroyed, writableEnded: false, frames: [], write(s) { this.frames.push(s); }, end() { this.writableEnded = true; } };
      const entry = { sessionId: 'sess-1234', aliases: ['k1'] };
      const ctx = ctxOf({
        cleanupImages: f => calls.cleanup.push(f), restoreResumeSession: (m, e) => calls.restore.push(e),
        _claudeSessions: new Map(), resumeEntry: entry, agentImageFiles: ['C:\\tmp\\gc-1.png'], prompt, res,
        browser: false, claudeLog() {}, resolveClaudeExeWaiting: async () => 'C:\\fake\\claude.exe',
        agent: true, agentSub: 'cw:1', _agentRuns: new Map(runs.map((r, i) => [String(i), r])),
      });
      const out = await vm.runInContext(`(async () => {\n${claudeSeg}\nreturn 'reached-spawn';\n})()`, ctx);
      return { out, calls, res, entry };
    };
    {
      const r = await runClaude({ destroyed: true });
      t('★ 等 claude.exe 期间她断开 → 索引放回', r.out !== 'reached-spawn' && r.calls.restore[0] === r.entry, r.calls);
      t('★ 同上 → 附图删掉', r.calls.cleanup.length === 1 && r.calls.cleanup[0][0] === 'C:\\tmp\\gc-1.png', r.calls);
    }
    {
      const r = await runClaude({ runs: [{ done: false, kind: 'agent', subId: 'cw:1', id: 'r1' }] });
      t('★ 单飞锁挡下重复启动 → 索引放回 + 附图删掉',
        r.out !== 'reached-spawn' && r.calls.restore[0] === r.entry && r.calls.cleanup.length === 1, r.calls);
      t('单飞锁那条照旧回 duplicate 帧', r.res.frames.some(f => /"duplicate":true/.test(f)));
    }
    {
      const r = await runClaude({ prompt: '' });
      t('空消息那条也放回', r.calls.restore[0] === r.entry && r.calls.cleanup.length === 1, r.calls);
    }
    {
      const r = await runClaude({ runs: [{ done: false, kind: 'chat', subId: 'cw:1', id: 'r2' }] });
      t('对照：正常路径走到 spawn，不放回也不删图（放回了就是重复消费）',
        r.out === 'reached-spawn' && !r.calls.restore.length && !r.calls.cleanup.length, r.calls);
    }

    console.log('\n[A/E] 本地 GPT：代理探测期间取消、spawn 前第二道单飞锁');
    const gptRoute = "app.post('/api/local-gpt'";
    const dupDef = seg('    const gptDuplicateRun = () =>', '    if (gptDuplicateRun()) {', gptRoute);
    const probeSeg = seg('    const gptProxyPort = await outboundProxyPort();', '    if (gptProxyPort) {', gptRoute);
    const emptySeg = seg('    if (!prompt.trim()) {', '    let spawnCwd = agent ? agentWorkDir : ROOT;', gptRoute);
    const runGpt = async ({ destroyed = false, runs = [], prompt = 'hi', code = probeSeg }) => {
      const calls = { cleanup: [], restore: [] };
      const res = { destroyed, writableEnded: false, frames: [], write(s) { this.frames.push(s); }, end() { this.writableEnded = true; } };
      const entry = { threadId: 'thread-abcdef12', aliases: ['g1'] };
      const ctx = ctxOf({
        cleanupImages: f => calls.cleanup.push(f), restoreResumeSession: (m, e) => calls.restore.push(e),
        _gptSessions: new Map(), resumeEntry: entry, imgFiles: ['C:\\tmp\\gc-2.png'], res, prompt,
        gptLog() {}, outboundProxyPort: async () => 0,
        agent: true, agentSub: 'cw:2', _agentRuns: new Map(runs.map((r, i) => [String(i), r])),
      });
      const out = await vm.runInContext(`(async () => {\n${dupDef}\n${code}\nreturn 'reached-spawn';\n})()`, ctx);
      return { out, calls, res, entry };
    };
    {
      const r = await runGpt({ destroyed: true });
      t('★ 代理探测期间她取消 → 索引放回 + 附图删掉',
        r.out !== 'reached-spawn' && r.calls.restore[0] === r.entry && r.calls.cleanup.length === 1, r.calls);
    }
    {
      const r = await runGpt({ runs: [{ done: false, kind: 'agent', subId: 'cw:2', id: 'r3' }] });
      t('★ E 第二道锁：同一 sub 已有电脑操控的活 → 不 spawn、回 duplicate 帧',
        r.out !== 'reached-spawn' && r.res.frames.some(f => /"duplicate":true/.test(f)) && r.res.writableEnded, r.res.frames);
      t('★ 同上 → 索引放回 + 附图删掉', r.calls.restore[0] === r.entry && r.calls.cleanup.length === 1, r.calls);
    }
    {
      const r = await runGpt({ runs: [{ done: false, kind: 'chat', subId: 'cw:2', id: 'r4' }, { done: true, kind: 'agent', subId: 'cw:2', id: 'r5' }] });
      t('对照：同 sub 只有闲聊 / 已跑完的活 → 照常放行', r.out === 'reached-spawn' && !r.calls.restore.length, r.calls);
    }
    {
      const r = await runGpt({ prompt: '   ', code: emptySeg });
      t('空消息那条也放回', r.out !== 'reached-spawn' && r.calls.restore[0] === r.entry, r.calls);
    }
  }

  // ══════════════════ I：手环 pull 单飞 + sql.js 只实例化一次 ══════════════════
  if (want('I')) {
    console.log('\n[I] 手环：并发 pull 只拉一次、sql.js 只初始化一次');
    const cp = require('child_process');
    const origExecFile = cp.execFile, origExists = fs.existsSync;
    const sqlId = require.resolve('sql.js');
    const origSql = require.cache[sqlId];
    let pulls = 0, pullsInFlight = 0, maxParallel = 0, initCalls = 0, mtime = 1000, adbCalls = 0;
    cp.execFile = (exe, args, opts, cb) => {
      adbCalls++;
      const a = args[0] === '-s' ? args.slice(2) : args;
      const ok = out => setImmediate(() => cb(null, out, ''));
      if (a[0] === 'devices') return ok('List of devices attached\nFAKE123\tdevice\n');
      if (a[0] === 'shell' && a[1] === 'pidof') return ok('4242');
      if (a[0] === 'shell' && a[1] === 'stat') return ok(String(mtime++));
      if (a[0] === 'pull') {
        pulls++; pullsInFlight++; maxParallel = Math.max(maxParallel, pullsInFlight);
        return setTimeout(() => { fs.writeFileSync(a[2], 'fake'); pullsInFlight--; cb(null, '', ''); }, 300);
      }
      return ok('');
    };
    fs.existsSync = p => (/adb\.exe$/i.test(String(p)) ? true : origExists(p));
    require.cache[sqlId] = { id: sqlId, filename: sqlId, loaded: true,
      exports: () => { initCalls++; return Promise.resolve({ Database: class { exec() { return []; } close() {} } }); } };
    const bandPath = require.resolve('../server/band.js');
    delete require.cache[bandPath];
    try {
      // 默认关：没配 GRANCYAN_BAND_DB_REMOTE 时一条 adb 都不许跑
      {
        const off = {};
        const offRoot = fs.mkdtempSync(path.join(TMP, 'band-off-'));
        // GRANCYAN_BAND_DIR 也指进临时目录：万一闸门坏了，假 pull 也不会写进真的 ~/.grancyan
        require(bandPath).mount({ get: (p, h) => { off[p] = h; } }, { ROOT: offRoot, env: { GRANCYAN_BAND_DIR: path.join(TMP, 'band-off-dir') } });
        const r0 = await new Promise(resolve => off['/api/band-data']({ query: { force: '1' } }, { json: resolve }));
        t('★ 没配 GRANCYAN_BAND_DB_REMOTE → 回「未启用」，不碰 adb', r0.ok === false && r0.stage === 'not-configured' && adbCalls === 0, { r0, adbCalls });
        t('没配时也不往项目根目录写 Gadgetbridge.db', !fs.existsSync(path.join(offRoot, 'Gadgetbridge.db')));
      }
      const routes = {};
      const bandRoot = fs.mkdtempSync(path.join(TMP, 'band-'));
      const bandDir = path.join(TMP, 'band-data-dir');
      require(bandPath).mount({ get: (p, h) => { routes[p] = h; } },
        { ROOT: bandRoot, env: { GRANCYAN_BAND_DB_REMOTE: '/sdcard/Gadgetbridge/Gadgetbridge.db', GRANCYAN_BAND_DIR: bandDir } });
      const call = () => new Promise(resolve => routes['/api/band-data']({ query: { force: '1' } }, { json: resolve }));
      const [r1, r2] = await Promise.all([call(), call()]);
      t('★ 拉下来的库落在数据目录（GRANCYAN_BAND_DIR），不在项目根目录',
        fs.existsSync(path.join(bandDir, 'Gadgetbridge.db')) && !fs.existsSync(path.join(bandRoot, 'Gadgetbridge.db')));
      t('★ 两个请求同时要数据 → adb pull 只跑一次（不再两条 pull 抢写同一个库）', pulls === 1 && maxParallel === 1, { pulls, maxParallel });
      t('两个请求拿到的是同一份结果', r1.ok === true && r2.ok === true, [r1.ok, r2.ok]);
      await call();
      t('对照：前一趟结束后再要，会重新拉（单飞不是永久缓存）', pulls === 2, pulls);
      t('★ sql.js 只初始化一次（以前每趟都重新实例化 wasm）', initCalls === 1, initCalls);
    } finally {
      cp.execFile = origExecFile; fs.existsSync = origExists;
      if (origSql) require.cache[sqlId] = origSql; else delete require.cache[sqlId];
      delete require.cache[bandPath];
    }
  }

  // ══════════════════ 真起 server：G / B / C / E / D ══════════════════
  const needServer = ['G', 'B', 'C', 'E', 'D'].some(want);
  if (!needServer) return;

  const FAKE_LOG = path.join(TMP, 'fake-codex.log');
  // 假 codex：node 把第一个参数 `exec` 当脚本跑（spawn 的 cwd 是 ROOT / agentCwd，两处都放一份）。
  // 行为由 prompt 里**最后一个** MODE:xxx 决定（整段重发时历史里也有旧的 MODE）。
  const FAKE_CODEX = `
const fs = require('fs');
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const resume = args[0] === 'resume' ? args[1] : null;
  const modes = [...input.matchAll(/MODE:(\\w+)/g)];
  const mode = modes.length ? modes[modes.length - 1][1] : 'ok';
  const tid = resume || ('thread-' + process.pid);
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ pid: process.pid, mode, resume, tid, tag: (/TAG:(\\w+)/.exec(input) || [])[1] || '' }) + '\\n');
  const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: tid });
  out({ type: 'turn.started' });
  const finish = () => {
    out({ type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'fake reply ' + mode } });
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    setTimeout(() => process.exit(0), 20);
  };
  if (mode === 'ok') finish();
  else if (mode === 'slowok') {                                                           // 2.5 秒后出字，期间有心跳
    const iv = setInterval(() => out({ type: 'heartbeat' }), 300);
    setTimeout(() => { clearInterval(iv); finish(); }, 2500);
  }
  else if (mode === 'alive') setInterval(() => out({ type: 'heartbeat' }), 300);          // 一直活着、一直有动静
  else if (mode === 'silent') setInterval(() => {}, 1e6);                                 // 活着但一声不吭
  else if (mode === 'busy') {                                                             // 4.4 秒只有 reasoning，没正文
    let n = 0;
    const iv = setInterval(() => {
      out({ type: 'item.completed', item: { id: 'r' + n, type: 'reasoning', text: 'thinking ' + n } });
      if (++n >= 11) { clearInterval(iv); finish(); }
    }, 400);
  } else if (mode === 'longcmd') {                                                        // 一条命令 4 秒，中间零事件
    out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'sleep 4' } });
    setTimeout(() => {
      out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'sleep 4', aggregated_output: 'done', status: 'completed' } });
      finish();
    }, 4000);
  }
});`;
  const fakeLog = () => { try { return fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const fakeBy = tag => fakeLog().filter(e => e.tag === tag);

  const servers = [];
  async function startServer(name, envExtra) {
    const root = path.join(TMP, name, 'root');
    const appdata = path.join(TMP, name, 'appdata');
    for (const d of [root, appdata, path.join(TMP, name, 'codex'), path.join(TMP, name, 'inbox')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(root, 'exec'), FAKE_CODEX);
    // 端口按 pid 错开，远离 3000/3443（用户正在用的那个实例）和其他本机常驻服务的端口；
    // 撞上别人占着的口也不会误判 —— 下面只认这个进程自己打出来的「已启动」
    const port = 21000 + (process.pid % 1500) * 2 + servers.length * 3001;
    const env = {
      ...process.env,
      GRANCYAN_PORT: String(port), GRANCYAN_PORT_TLS: String(port + 1),
      GRANCYAN_ROOT: root, APPDATA: appdata,
      GPT_CODEX_HOME: path.join(TMP, name, 'codex'), GRANCYAN_INBOX_DIR: path.join(TMP, name, 'inbox'),
      GRANCYAN_GPT_BASE_URL: 'http://127.0.0.1:9/v1', GRANCYAN_GPT_API_KEY: 'fake', GPT_BIN: process.execPath, FAKE_CODEX_LOG: FAKE_LOG,
      GRANCYAN_GPT_IDLE_MS: '1500',
      // 假 codex 只会说 exec 的 JSONL；2026-10-07 起默认走 app-server（逐字流式），这里钉回 exec。
      // app-server 那层翻译由 tests/codex-appserver.test.js 用假 app-server 单独守。
      GRANCYAN_GPT_STREAM: '0',
      ...envExtra,
    };
    delete env.CODEX_BIN;
    const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    const s = { name, port, root, appdata, proc, out: () => out };
    servers.push(s);
    // 只认**这个进程自己**打出来的监听日志，别被别人占着的端口骗了
    for (let i = 0; i < 120; i++) {
      if (out.includes(`端口 ${port} 已启动`) && out.includes(`端口 ${port + 1} 已启动`)) break;
      if (proc.exitCode !== null) break;
      await sleep(250);
    }
    s.up = out.includes(`端口 ${port} 已启动`);
    s.upBoth = s.up && out.includes(`端口 ${port + 1} 已启动`);
    return s;
  }
  function get(port, p) {
    return new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: p }, r => {
        let b = ''; r.on('data', d => { b += d; }); r.on('end', () => resolve({ code: r.statusCode, body: b }));
      });
      req.on('error', e => resolve({ code: 0, body: e.message }));
      req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
  }
  function postJson(port, p, body) {
    return new Promise(resolve => {
      const data = JSON.stringify(body || {});
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
        let b = ''; r.on('data', d => { b += d; }); r.on('end', () => resolve({ code: r.statusCode, body: b }));
      });
      req.on('error', e => resolve({ code: 0, body: e.message }));
      req.end(data);
    });
  }
  // SSE：边收边解析 data: 帧
  function sse(port, p, body) {
    const h = { status: 0, frames: [], ended: false, req: null };
    const data = JSON.stringify(body);
    h.req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
      h.status = r.statusCode;
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2);
          if (f.startsWith('data: ')) { try { h.frames.push(JSON.parse(f.slice(6))); } catch {} }
          else if (f.trim()) h.raw = (h.raw || '') + f;
        }
        if (h.status >= 400) h.raw = (h.raw || '') + buf;
      });
      r.on('end', () => { h.ended = true; });
      r.on('close', () => { h.ended = true; });
    });
    h.req.on('error', () => { h.ended = true; });
    h.req.end(data);
    h.until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred(h)) return true; await sleep(50); } return !!pred(h); };
    h.runId = () => (h.frames.find(f => f.runId) || {}).runId;
    h.done = () => h.frames.some(f => f.done);
    h.text = () => h.frames.filter(f => f.delta).map(f => f.delta).join('');
    h.errors = () => h.frames.filter(f => f.error).map(f => String(f.error));
    return h;
  }
  const resumeIndex = s => { try { return JSON.parse(fs.readFileSync(path.join(s.appdata, 'GranCyan', 'resume-sessions.json'), 'utf8')); } catch { return { claude: [], gpt: [] }; } };
  // 等到条件成立（最多 ms）。别用固定 sleep：机器忙的时候（2026-10-03 六个会话并行）
  // 假 codex 报到、进程树收尸都会晚过 300/500ms，整组假红
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); } return fn(); };
  const base = { systemPrompt: 'test-sys', model: 'fake-model', thinkingMode: 'auto' };
  const U = c => ({ role: 'user', content: c });
  const A = c => ({ role: 'assistant', content: c });

  try {
    const s1 = await startServer('s1', {});
    console.log(`\n[G] 没证书时两个端口都得起来（假 server 在 ${s1.port}/${s1.port + 1}）`);
    t('server 进程自己打出了第一个端口的监听日志', s1.up, s1.out().slice(-600));
    t('两个端口都打出了「已启动」', s1.upBoth, s1.out().slice(-400));
    // ⚠️ 日志不算数：注入实测，共用一个 httpServer 时 Node 24 **不抛** ——
    //   listen 带 host 要先异步 lookup，第二次调用时 _handle 还没建，于是两次都「成功」、
    //   两条「已启动」都打出来，但后一个把前一个顶掉：3000 静默不通、3443 照常。只有真打一枪才看得出来。
    const [g1, g2] = await Promise.all([get(s1.port, '/api/agent-runs'), get(s1.port + 1, '/api/agent-runs')]);
    t('★ 没证书时两个端口都真能答 API（以前共用一个 http.Server，先 listen 的那个口静默不通）',
      g1.code === 200 && g2.code === 200, [g1.code, g2.code]);
    if (!s1.up) throw new Error('server 没起来，后面的不用跑了');

    if (want('B')) {
      console.log('\n[B0] 没有 Codex 登录、也没配自己的端点：开跑前就 400，不 spawn、不走任何默认中转');
      const s0 = await startServer('s0', { GRANCYAN_GPT_BASE_URL: '' });
      t('没配端点的 server 起来了', s0.up, s0.out().slice(-400));
      const r0 = await postJson(s0.port, '/api/local-gpt', { ...base, messages: [U('B0 TAG:nb MODE:ok')] });
      t('★ 400 + 一句说清楚怎么配的人话', r0.code === 400 && /codex login/.test(r0.body) && /GRANCYAN_GPT_BASE_URL/.test(r0.body), r0);
      await sleep(300);
      t('★ 一个 codex 都没起', fakeBy('nb').length === 0, fakeBy('nb').length);
    }

    if (want('B')) {
      console.log('\n[B] 本地 GPT 纯聊天：断线只算脱离，会话照样落盘，下一轮接着续');
      const h1 = sse(s1.port, '/api/local-gpt', { ...base, agentSub: 'dev-b', messages: [U('B 第一句 TAG:b1 MODE:slowok')] });
      await h1.until(h => h.runId(), 5000);
      const f0 = h1.frames.find(f => f.runId) || {};
      t('纯聊天也登记了活，{runId} 帧带 kind=chat（前端据此不写进对话、不弹 🖥）', !!f0.runId && f0.kind === 'chat', f0);
      h1.req.destroy();                               // 网一抖
      // 等假 codex 自己报到（它读完 stdin 才落日志）。被当场 kill 的话它根本活不到报到那一步
      for (let i = 0; i < 30 && !fakeBy('b1').length; i++) await sleep(100);
      const b1 = fakeBy('b1')[0] || {};
      t('断开之后假 codex 进程还活着（没被当场 kill）', !!b1.pid && pidAlive(b1.pid), b1);
      const ok = await (async () => { for (let i = 0; i < 80; i++) { if (resumeIndex(s1).gpt.some(([, e]) => e.threadId === b1.tid)) return true; await sleep(100); } return false; })();
      t('★ 跑完之后会话照样落进续传索引（以前 code=null → rememberGptSession 不执行）', ok, resumeIndex(s1).gpt.length);
      const h2 = sse(s1.port, '/api/local-gpt', { ...base, agentSub: 'dev-b', messages: [U('B 第一句 TAG:b1 MODE:slowok'), A('fake reply slowok'), U('B 第二句 TAG:b2 MODE:ok')] });
      await h2.until(h => h.done(), 8000);
      const b2 = fakeBy('b2')[0] || {};
      // !!b1.tid 不能省：两边都是 undefined 时 === 也成立（注入实测踩过，假绿）
      t('★ 下一轮是续传（exec resume 同一条线程），不是整段历史重发', !!b1.tid && b2.resume === b1.tid, { b1: b1.tid, b2 });
      t('续传这轮正常出字', h2.text() === 'fake reply ok' && !h2.errors().length, { text: h2.text(), err: h2.errors() });
    }

    if (want('B')) {
      console.log('\n[B′] 她按停止：进程树被杀、续传索引放回');
      const h0 = sse(s1.port, '/api/local-gpt', { ...base, messages: [U('S 第一句 TAG:s0 MODE:ok')] });
      await h0.until(h => h.done(), 5000);
      const s0 = fakeBy('s0')[0] || {};
      const hist = [U('S 第一句 TAG:s0 MODE:ok'), A('fake reply ok')];
      const h1 = sse(s1.port, '/api/local-gpt', { ...base, messages: [...hist, U('S 第二句 TAG:s1 MODE:alive')] });
      await h1.until(h => h.runId(), 5000);
      const sA = (await waitFor(() => fakeBy('s1')[0], 5000)) || {};
      t('第二轮续传上了（前提成立）', sA.resume && sA.resume === s0.tid, { s0: s0.tid, sA });
      const stop = await postJson(s1.port, `/api/agent-run/${h1.runId()}/stop`, {});
      t('停止接口应答', stop.code === 200, stop);
      await h1.until(h => h.ended, 5000);
      t('收尾报的是「已停止」，不是拿 stderr 吓人', h1.errors().includes('已停止'), h1.errors());
      await waitFor(() => sA.pid && !pidAlive(sA.pid), 5000);
      t('被停的 codex 进程真死了（stopAgentProcess 杀整棵树）', sA.pid && !pidAlive(sA.pid), sA.pid);
      const h2 = sse(s1.port, '/api/local-gpt', { ...base, messages: [...hist, U('S 第三句 TAG:s2 MODE:ok')] });
      await h2.until(h => h.done(), 8000);
      const sB = fakeBy('s2')[0] || {};
      t('★ 停掉之后再说一句，还能续回同一条线程（索引被放回了）', !!s0.tid && sB.resume === s0.tid, { s0: s0.tid, sB });
    }

    if (want('C')) {
      console.log('\n[C] GPT 空闲计时器：只要有动静就不掐；真没动静才掐（测试里空闲上限 1.5s）');
      const hb = sse(s1.port, '/api/local-gpt', { ...base, messages: [U('C busy TAG:c1 MODE:busy')] });
      await hb.until(h => h.done(), 12000);
      t('★ 4.4 秒全是 reasoning、没有正文 → 不被当成卡死（以前只认 agent_message）',
        hb.text() === 'fake reply busy' && !hb.errors().length, { text: hb.text(), err: hb.errors() });
      const hl = sse(s1.port, '/api/local-gpt', { ...base, messages: [U('C longcmd TAG:c2 MODE:longcmd')] });
      await hl.until(h => h.done(), 12000);
      t('★ 一条命令跑 4 秒、中间零事件 → 还开着的 item 不算空闲',
        hl.text() === 'fake reply longcmd' && !hl.errors().length, { text: hl.text(), err: hl.errors() });
      const hs = sse(s1.port, '/api/local-gpt', { ...base, messages: [U('C silent TAG:c3 MODE:silent')] });
      await hs.until(h => h.done(), 8000);
      t('对照：真的一声不吭 → 照样掐掉并说清楚', hs.errors().some(e => /没有任何动静/.test(e)), hs.errors());
      const c3 = (await waitFor(() => fakeBy('c3')[0], 5000)) || {};
      await waitFor(() => c3.pid && !pidAlive(c3.pid), 5000);
      t('被掐的进程真死了', c3.pid && !pidAlive(c3.pid), c3.pid);
    }

    if (want('E')) {
      console.log('\n[E] /api/local-gpt 的 agentSub 单飞锁');
      const agentBody = tag => ({ ...base, agent: true, agentCwd: s1.root, agentSub: 'cw:e2e', messages: [U(`E TAG:${tag} MODE:alive`)] });
      const e1 = sse(s1.port, '/api/local-gpt', agentBody('e1'));
      await e1.until(h => h.runId(), 5000);
      t('第一个电脑操控的活起来了', !!e1.runId() && (e1.frames.find(f => f.runId) || {}).kind === 'agent');
      const e2 = sse(s1.port, '/api/local-gpt', agentBody('e2'));
      await e2.until(h => h.ended, 5000);
      t('★ 同一个 sub 再来一个 → 409，没有第二个 codex', e2.status === 409 && fakeBy('e2').length === 0, { status: e2.status, spawned: fakeBy('e2').length });
      const ec = sse(s1.port, '/api/local-gpt', { ...base, agentSub: 'cw:e2e', messages: [U('E chat TAG:e3 MODE:ok')] });
      await ec.until(h => h.done(), 5000);
      t('对照：同一个 sub 的闲聊不被这道锁挡', ec.text() === 'fake reply ok', { status: ec.status, err: ec.errors() });
      await postJson(s1.port, `/api/agent-run/${e1.runId()}/stop`, {});
      await e1.until(h => h.ended, 5000);
      // 两个同时进来
      const p1 = sse(s1.port, '/api/local-gpt', { ...agentBody('pair'), agentSub: 'cw:pair' });
      const p2 = sse(s1.port, '/api/local-gpt', { ...agentBody('pair'), agentSub: 'cw:pair' });
      await Promise.all([p1.until(h => h.runId() || h.ended, 5000), p2.until(h => h.runId() || h.ended, 5000)]);
      await sleep(500);
      const runner = [p1, p2].find(h => h.runId());
      const loser = [p1, p2].find(h => h !== runner);
      t('★ 两个同时进来 → 只起一个 codex', fakeBy('pair').length === 1, fakeBy('pair').length);
      t('另一个被挡（409 或 duplicate 帧）', loser && (loser.status === 409 || loser.frames.some(f => f.duplicate)), loser && { status: loser.status, frames: loser.frames });
      if (runner) { await postJson(s1.port, `/api/agent-run/${runner.runId()}/stop`, {}); await runner.until(h => h.ended, 5000); }
    }

    if (want('D')) {
      console.log('\n[D] GPT_BIN 指到 .cmd：同步抛也走同一条收尾');
      // 从 s1 拿一条真实的续传索引过来当种子，这样能看见「放回去」这件事。
      // 用的是 [B] 第二轮落下的那条（第一轮那条已经被第二轮消费掉了），所以 D 要和 B 一起跑。
      const seedFrom = resumeIndex(s1);
      const b1tid = (fakeBy('b1')[0] || {}).tid;
      const seedEntry = b1tid && (seedFrom.gpt.find(([, e]) => e.threadId === b1tid) || [])[1];
      t('种子在（D 依赖 [B] 先跑过）', !!seedEntry);
      const cmd = path.join(TMP, 'fake-codex.cmd');
      fs.writeFileSync(cmd, '@echo off\r\necho should-never-run\r\n');
      const d2 = path.join(TMP, 's2', 'appdata', 'GranCyan');
      fs.mkdirSync(d2, { recursive: true });
      fs.writeFileSync(path.join(d2, 'resume-sessions.json'), JSON.stringify({ claude: [], gpt: seedFrom.gpt }));
      const s2 = await startServer('s2', { GPT_BIN: cmd });
      t('第二个 server（GPT_BIN=.cmd）起来了', s2.up, s2.out().slice(-400));
      const hist = [U('B 第一句 TAG:b1 MODE:slowok'), A('fake reply slowok'), U('B 第二句 TAG:b2 MODE:ok'), A('fake reply ok')];
      const h = sse(s2.port, '/api/local-gpt', { ...base, messages: [...hist, U('D TAG:d1 MODE:ok')] });
      await h.until(x => x.done() || x.ended, 6000);
      t('★ 收到了 error + done（以前同步抛出去，连接直接断，前端只见「连接失败」）',
        h.done() && h.errors().some(e => /是脚本|EINVAL/.test(e)), { frames: h.frames, raw: h.raw });
      t('.cmd 一行都没执行', fakeBy('d1').length === 0);
      await sleep(300);
      t('★ 续传索引放回去了（被消费的那条又在）',
        !!seedEntry && resumeIndex(s2).gpt.some(([, e]) => e.threadId === seedEntry.threadId), { seeded: !!seedEntry, now: resumeIndex(s2).gpt.length });
      const alive = await get(s2.port, '/api/agent-runs');
      t('server 还活着', alive.code === 200, alive.code);
    }
  } finally {
    for (const s of servers) { try { s.proc.kill(); } catch {} }
    for (const e of fakeLog()) if (pidAlive(e.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(e.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {} }
    await sleep(300);
  }
})().catch(e => { fail++; console.error('  ✗ 测试本身抛了:', e && e.stack || e); })
  .finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}\n`);
    process.exit(fail === 0 ? 0 : 1);
  });
