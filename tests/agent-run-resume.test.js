// 电脑操控：断线不丢活 + 产物回传
// 背景：手机锁屏/切后台/被 ROM 杀掉都会掐断 SSE，以前服务端一断开就 proc.kill()，
// 跑到一半的活当场没了。现在断开只算「脱离」，靠 runId 重新挂回去。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'js', path.sep);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const server = read('server.js');
const api = read('js/05-prompts-api.js');
const core = read('js/01-core.js');
const boot = read('js/14-boot-brain-hub.js');

// 两条路各自切一段出来。以前这组断言拿整个 server.js 当干草堆，
// 结果 2026-09-20 我把本地 Claude 那条路改了之后，「纯聊天仍然 kill」那条
// **靠匹配到本地 GPT 那段照样绿**（同一份代码在两处，正是 test-validity 里
// 记的「断言匹配到别处相同的代码」）。切片之后每条断言只问自己那条路。
// 整行注释要剥掉再断言：下面那条「不许再出现 proc.kill()」第一次就被我**自己写的
// 注释**（「这里没有 else 分支的 proc.kill()」）匹配红了。断言看见的是干草堆里的字，
// 不分死活 —— 只剥整行的 `//`，行尾注释和字符串里的 `//`（http://）都不动。
const stripLineComments = s => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const claudeRoute = stripLineComments(
  server.slice(server.indexOf("app.post('/api/local-claude'"),
               server.indexOf("app.post('/api/local-gpt'")));
const gptRoute = server.slice(server.indexOf("app.post('/api/local-gpt'"),
                              server.indexOf("app.get('/api/stickers'"));

console.log('\n[1] 服务端：断开不再等于停止');
t('客户端断开时活不被 kill（本地 GPT 那条路）',
  !/proc\.kill\(\)/.test(stripLineComments(gptRoute))
  && /res\.on\('close'[\s\S]{0,400}?run\.detachedAt = Date\.now\(\)/.test(gptRoute)
  && /继续在后台跑/.test(server));
// 2026-09-20 改的就是这里，原来这条叫「纯聊天断开仍然 kill（没被顺手改坏）」。
// 旧行为的代价（local-claude.log 00:24–00:28 连着四条实录）：网一抖 → 客户端
// close → proc.kill() → ① 这一轮文字全丢 ② code!==0 让 rememberSession 不落盘 →
// 下一轮退回「新会话(历史哈希查不到)」，整段历史重发、提示缓存全废，prompt 从
// 8k 涨到 12k ③ 她重发一次再来一遍 ④ Windows 上裸 kill() 只杀启动器，
// claude 的子进程接着烧额度。现在本地 Claude 每一轮（含纯聊天）都登记 run，
// 断开只算脱离。
t('本地 Claude 断开不再杀进程，纯聊天也一样',
  !/proc\.kill\(\)/.test(claudeRoute)
  && /res\.on\('close'[\s\S]{0,400}?run\.detachedAt = Date\.now\(\)/.test(claudeRoute));
// 本地 GPT 以前有意没跟着改（当时没实证）。2026-09-27 实证来了：local-gpt.log
// 2026/9/20 00:13:21 code=null 紧接 00:13:33 new —— 同一个病（裸 kill → 不登记会话 →
// 续传索引丢 → 整段历史重发）。这条断言原来守「有意没改」，现在反过来守「跟上了」。
// 行为层的验证在 tests/server-fixes.test.js（真起 server + 假 codex，断开后照样落会话）。
t('本地 GPT 纯聊天也登记活，断开不再当场 kill',
  /const run = newAgentRun\(proc, latestUserText\(messages\) \|\| prompt, agentSub, gptRunKind\);/.test(gptRoute)
  && !/const run = agent \? newAgentRun/.test(gptRoute));
t('有重新挂上去的入口', /app\.get\('\/api\/agent-run\/:id'/.test(server));
t('有显式停止的入口', /app\.post\('\/api\/agent-run\/:id\/stop'/.test(server));
t('有「还有活在跑吗」的清单', /app\.get\('\/api\/agent-runs'/.test(server));
// 进程起来之后的每一条下行事件都必须走 send()：直接 res.write 的话，
// 客户端断开时那条就只写进空气里，重连的人永远收不到。
// （只查这一段：runId 那条本来就该绕过缓冲，send 内部那条是没活时的兜底）
const claudeCli = server.slice(server.indexOf("app.post('/api/local-claude'"),
                               server.indexOf("app.post('/api/local-gpt'"));
const afterSpawn = claudeCli.slice(claudeCli.indexOf("proc.stdout.on('data'"));
t('进程起来后的事件全走 send()',
  /send\(\{ delta: d\.text \}\)/.test(afterSpawn) && /send\(\{ tool: /.test(afterSpawn)
  && /send\(\{ toolResult: /.test(afterSpawn) && /endStream\(\)/.test(afterSpawn)
  && !/res\.write\(`data:/.test(afterSpawn));
t('丢弃老事件时记了 dropped，重连下标才对得上',
  /run\.dropped \+= run\.events\.length - AGENT_RUN_MAX_EVENTS/.test(server)
  && /parseInt\(from, 10\) \|\| 0\) - run\.dropped/.test(server));
// 2026-09-20 起时限按 kind 分两档（见 [13] 组），所以这里比的是 orphanAfter 那个变量；
// 「它到底取了哪一档」由那组里的断言守，这条只守「脱离了就会被掐掉」这件事本身。
t('没人认领的活会被掐掉，不偷偷烧额度', /AGENT_RUN_ORPHAN/.test(server)
  && /r\.detachedAt && now - r\.detachedAt > orphanAfter/.test(server));
t('用户按的停止报「已停止」不报故障', /run\.stopped\) \{[\s\S]{0,200}?send\(\{ error: '已停止' \}\)/.test(server));
t('同一个活只允许一个客户端挂着', /if \(run\.res && run\.res !== res\)/.test(server));

console.log('\n[2] 服务端：产物回传只放行写过的文件');
t('只认 Write/Edit 这类会落文件的工具', /const ARTIFACT_TOOLS = \{ Write: 1, Edit: 1/.test(server));
t('产物必须在工作目录内', /if \(!isInsideAgentCwd\(abs\)\) return;/.test(server));
t('取文件走白名单而不是只判目录',
  /const known = \[\.\.\._agentRuns\.values\(\)\]\.some\(r => r\.artifacts\.includes\(abs\)\)/.test(server));
t('越界路径直接 403', /if \(!isInsideAgentCwd\(abs\)\) return res\.status\(403\)/.test(server));
t('同一个文件改多次只记一张卡片', /if \(run\.artifacts\.includes\(abs\)\) return;/.test(server));

console.log('\n[3] 前端：断了自己接回来');
// 窗口 2026-09-20 从 2000 放宽到 3600：纯聊天也登记活之后，这个块里多了几段注释
// 解释「chat 的活为什么不记在对话上」，字符数撑破了旧窗口 —— 红的是长度不是行为。
t('runId 是元信息，不算进 evIndex', /if \(j\.runId\) \{[\s\S]{0,3600}?continue;\s*\n\s*\}\s*\n\s*evIndex\+\+;/.test(api));
t('流断了先试重连再当结束', /const next = await reattachAgentRun\(\);/.test(api)
  && /if \(next\) \{ swapReader\(next\); continue; \}/.test(api));
t('重连带上已收到的条数', /\/api\/agent-run\/\$\{runId\}\?from=\$\{evIndex\}/.test(api));
t('用户按了停止（或已让位）就不再重连',
  /if \(sawDone \|\| yielded \|\| !runId \|\| ctrl\.signal\.aborted\s*\n?\s*\|\| reconnects >= 60 \|\| Date\.now\(\) > reattachDeadline\) return null;/.test(api));
t('活过期了给句人话而不是干等', /找不到这个活了/.test(api));
t('停止按钮真的去停（不是只断开）',
  /_agentRunId[\s\S]{0,200}?\/api\/agent-run\/\$\{id\}\/stop/.test(core));
t('这轮结束后清掉 runId', /_agentRunId = null;\s*\/\/ 这轮结束了/.test(api));

console.log('\n[4] 前端：App 被杀掉也能把活认回来');
t('对话上记着自己那个活', /originChat\.agentRunId = j\.runId;\s*\n\s*originChat\.agentRunClaimed = false;/.test(api));
t('streamCompletion 支持直接挂已有的活', /async function streamCompletion\(conf, messages, onUpdate, resumeRunId, originChat\)/.test(api)
  && /resumeRunId \? await fetch\(/.test(api));
t('有找回函数', /async function resumeAgentRun\(chat, runId\)/.test(api));
t('找回时不顺带触发游戏/学习卡那一串', /别让它顺带触发一堆东西/.test(api));
// 只让给**别的**设备。手机断网时服务端那条 TCP 好几分钟都不塌，attached 还是 true，
// 无脑让位的话「回家开 App 自动接回来」在最常见的断网场景里静默失效。
t('别的设备挂着才让位，自己那条僵尸连接要能顶掉',
  /if \(run\.attached && run\.subId !== myDev\) continue;/.test(api)
  && /subId: r\.subId/.test(server));
t('电脑没开时 3 秒放弃，不卡启动', /setTimeout\(\(\) => ctl\.abort\(\), 3000\)/.test(api));
t('启动和回到前台各查一次', /setTimeout\(checkLiveAgentRuns, 1500\)/.test(boot)
  && /visibilityState === 'visible'\) checkLiveAgentRuns\(\)/.test(boot));

console.log('\n[5] 产物清单渲染');
const s = api.indexOf('function agentFileUrl');
const e = api.indexOf('// 通用流式请求', s);
const ctx = { SERVER_BASE: 'http://pc:3000', console };
vm.createContext(ctx);
vm.runInContext(api.slice(s, e), ctx);

const md = ctx.renderAgentArtifacts([
  { name: '图.png', rel: 'out/图.png', size: 2048, image: true, viewable: true },
  { name: 'a.md', rel: 'a.md', size: 500, image: false, viewable: true },
  { name: 'x.zip', rel: 'x.zip', size: 3 * 1024 * 1024, image: false, viewable: false },
]);
t('图片就地显示', /!\[图\.png\]\(http:\/\/pc:3000\/api\/agent-file\?rel=out%2F%E5%9B%BE\.png\)/.test(md), md);
t('文本给可点开的链接', /- \[a\.md\]\(http:\/\/pc:3000\/api\/agent-file\?rel=a\.md\) · 500 B/.test(md), md);
t('打不开的类型给下载', /x\.zip.*download=1.*3\.0 MB.*下载/.test(md), md);
t('体积换算像话', ctx.fmtBytes(2048) === '2.0 KB' && ctx.fmtBytes(900) === '900 B', ctx.fmtBytes(2048));
t('路径里的中文/空格不会把链接搞断', !/ /.test(ctx.agentFileUrl('a b/中 文.png')), ctx.agentFileUrl('a b/中 文.png'));

console.log('\n[6] Codex 打回来的那几条（2026-07-30 修）');
// 真断网时 reader.read() 是抛 TypeError: terminated，不是给 done:true。
// 原来重连只挂在 done 分支上 → 真手机锁屏断网走的是异常路径，整个功能等于没做。
// 这条是本轮最要命的一条，实测证据见 scratchpad/reader-abort-proof.js。
t('reader.read() 的异常也进重连（不只是 done 分支）',
  /\(\{ done, value \} = await reader\.read\(\)\);/.test(api)
  && /\} catch \(e\) \{[\s\S]{0,400}?const next = await reattachAgentRun\(\);/.test(api));
t('decoder 跟着 reader 一起换（防断点切在多字节字符中间）',
  /let decoder = new TextDecoder\(\)/.test(api)
  && /const swapReader = \(next\) => \{[\s\S]{0,200}?decoder = new TextDecoder\(\)/.test(api));
t('停止时自己认领 aborted，不再报成失败',
  /if \(ctrl\.signal\.aborted\) \{\s*\n\s*claimRun = true;[\s\S]{0,120}?return \{ fullText, reasoningText, blocks, error: null, aborted: true \};/.test(api));
t('事件被截断时把 evIndex 推到 resumeFrom（否则二次重连重复回放）',
  /j\.resumeFrom > evIndex\) \{[\s\S]{0,500}?evIndex = j\.resumeFrom;/.test(api));
t('runId 写回发起那轮的对话，不是「当前」对话',
  /async function streamCompletion\(conf, messages, onUpdate, resumeRunId, originChat\)/.test(api)
  && /originChat\.agentRunId = j\.runId;/.test(api)
  && !/const c = getActiveChat\(\);\s*\n\s*if \(c\) \{ c\.agentRunId/.test(api));
t('runId 立刻落盘（save() 是 800ms 防抖，App 被杀就丢了）',
  /originChat\.agentRunClaimed = false;[\s\S]{0,600}?_doSave\(\);/.test(api));
// 409 只能挡「换了设备」。同一台设备断网后重连时，服务端那条死 TCP 可能还挂着，
// 按 run.res 判就会把自己挡在外面永久放弃 —— 所以必须按设备号判。
t('409 按设备号判，同一台设备允许顶掉自己的僵尸连接',
  /if \(!run\.subId \|\| sub !== run\.subId\) \{/.test(server)
  && /subId: String\(subId \|\| ''\)/.test(server)
  && /agentSub,/.test(api) && /&sub=\$\{encodeURIComponent\(agentSub\)\}/.test(api)
  && /r2\.status === 409/.test(api));
// 每次调用现摇一个 sub 的话，「App 被杀重开」是全新的 sub，认不出「还是我」，
// 只能干等服务端 TCP 超时 —— 那正是最需要顶掉僵尸连接的场景
t('设备号跨会话固定（存 localStorage，不是每次现摇）',
  /function agentDeviceId\(\)/.test(api)
  && /localStorage\.getItem\('kuro_agentDeviceId'\)/.test(api)
  && /const agentSub = agentDeviceId\(\);/.test(api));
t('run.res 还活着时不接受身份认领（空 subId 也不放行）',
  /\} else if \(sub\) \{\s*\n\s*run\.subId = sub\.slice\(0, 64\);/.test(server));
// 让位≠失败：设了 sawDone + error 的话 callAPI 会走 error 分支，
// 把这一轮已经收到的几千字正文整个换成一行 ⚠️
t('让给别的设备时保留已收到的正文，不当成错误',
  /yielded = true;/.test(api)
  && /这边不抢/.test(api)
  // 条件里不再有 runId（纯聊天/本地 GPT 也要报错），但 yielded 仍然被排除 —— 让位不是失败
  && /if \(!sawDone && !yielded && !reattachError\)/.test(api));
t('硬上限兜底：连接看着还在也照样回收',
  /AGENT_RUN_HARD_MAX = 60 \* 60 \* 1000/.test(server)
  && /now - r\.startedAt > AGENT_RUN_HARD_MAX/.test(server));
// 2026-09-06：加浏览器档之后这两个闸多了一个 `|| originChat?.browserMode` 分支，
// 断言放宽到只钉「读的是 originChat」这件事本身（那才是这条要守的东西）。
t('电脑操控权限按发起那轮的对话算，不是「当前」对话',
  /agent: !!\(originChat && originChat\.agentMode\)/.test(api)
  && /if \(j\.tool && \(originChat\?\.agentMode/.test(api)
  && /if \(j\.toolResult && \(originChat\?\.agentMode/.test(api));
t('所有 streamCompletion 调用点都传了发起的对话',
  /\}, undefined, chat\);\s+\/\/ 群聊/.test(read('js/06-render-msg.js'))
  && /\}, undefined, chat\);\s+\/\/ 变体重跑/.test(api)
  && /\}, runId, chat\);/.test(api));
// 销账（标记这个活取过了）必须收在一处。散到调用方的话，4 条调用路
// （callAPI / 群聊 / 变体重跑 / resumeAgentRun）加上出错、被停、让位这些早返回，
// 漏一条就变成「每次切回前台重放一遍并落盘」—— 比不做还糟，这坑踩过一次了。
t('销账统一在 finally 里，不散到各调用方',
  /if \(claimRun && runId && originChat && originChat\.agentRunId === runId\) \{\s*\n\s*originChat\.agentRunClaimed = true;/.test(api)
  && !/claimAgentRun/.test(api)
  && !/agentRunDone/.test(api));
t('销账只改内存，靠调用方收尾时的 save 落盘',
  /\*\*只改内存、不落盘\*\*/.test(api)
  && /if \(chat\.agentRunId\) \{\s*\n\s*if \(chat\.agentRunClaimed\) clearAgentRunRefs\(chat\);/.test(api));
// 2026-07-31：条件后面又加了 `&& originChat.agentRunId !== j.runId`（可选6：重连不重复写盘）。
// 这条守的是 `!resumeRunId` 那一半 —— 找回那条路不许重设 claimed。
// `[^\n]*` 打头：2026-09-20 这个条件前面多了一个 `runKind === 'agent' &&`
//（纯聊天的活不记在对话上）。这条要守的是「!resumeRunId 这一项还在」，不是守条件从哪个字开始。
t('找回时不要把 claimed 按回 false（否则每次切前台重放一遍）',
  /if \([^\n]*originChat && !resumeRunId[^)]*\) \{/.test(api));
t('找回检查遍历所有对话，不是只看当前那个',
  /\(state\.chats \|\| \[\]\)\.filter\(c => c && c\.agentRunId && !c\.agentRunClaimed\)/.test(api));
t('她自己叫停的活不再捞回来',
  /if \(run\.stopped\) \{ clearAgentRunRefs\(chat\); dirty = true; continue; \}/.test(api));
t('从 0 找回时也提示开头缺了一段', /if \(evIndex > 0 \|\| resumeRunId\) \{/.test(api));
t('realpath 之前先做词法拒绝（防 UNC 同步阻塞事件循环）',
  /先纯词法判一遍/.test(server)
  && /if \(!\(abs \+ path\.sep\)\.toLowerCase\(\)\.startsWith\(\(rootLex \+ path\.sep\)\.toLowerCase\(\)\)\) return false;/.test(server));
t('回收有常驻定时器（光靠请求触发等于永不触发）',
  /setInterval\(gcAgentRuns, 60 \* 1000\)/.test(server) && /_agentGcTimer\.unref/.test(server));
t('越界判断解开 junction / 软链，不是纯字符串比较',
  /function realpathSafe\(p\)/.test(server)
  && /const root = realpathSafe\(rootLex\) \+ path\.sep;/.test(server)
  && /const target = realpathSafe\(abs\) \+ path\.sep;/.test(server));
t('取文件时用真实路径发送', /res\.sendFile\(real\)/.test(server));

// 四审（2026-07-30）打回来的 2 阻断 + 5 该改 + 2 可选。
// 前两条是**上一轮修出来的回归**：为了「销账收在一处」把 finally 改成无条件销账，
// 结果把「网没接回来」也算成拿到头了 —— 恰好砍掉了这功能唯一的主场景。
console.log('\n[8] 四审打回来的那几条');
t('只有「拿到头」才销账，五条出口都标了',
  // 初值 2026-07-31 从 null 改成 resumeRunId（该改3），claimRun 仍必须从 false 起
  // 结尾从 `;` 放宽到 `[,;]`：2026-09-20 这行后面多了一个 runKind（服务端说这个活是
  // agent 还是 chat）。守的是 runId 的初值和 claimRun 从 false 起，不是守这行到此为止。
  /let runId = resumeRunId \|\| null, claimRun = false[,;]/.test(api)
  && /sawDone = true; claimRun = true;/.test(api)                    // 跑完
  && /claimRun = true;\s*\/\/ 电脑那边真没了/.test(api)               // 404
  && /claimRun = true;\s*\/\/ 让位是「有结论」/.test(api)             // 409 让位
  && /claimRun = true;\s*\/\/ 电脑那边给出结论了/.test(api)           // 服务端 error
  && /claimRun = true;\s*\/\/ 她自己按的停止/.test(api));             // 她叫停
t('网断了 / 非 Abort 异常都不销账（活可能还在电脑上跑）',
  /if \(err\.name === 'AbortError'\) \{ claimRun = true;/.test(api)
  && /非 Abort 的异常[\s\S]{0,60}?不\*\*销账/.test(api)
  && /if \(claimRun && runId/.test(api));
t('找回不再提前销账（resume 自己也可能断在电梯里）',
  !/chat\.agentRunClaimed = true;\s*\n\s*showToast\(run\.done/.test(api)
  && /销账由 streamCompletion 的 finally 在真的拿到头时做/.test(api));
t('找回重试复用同一个气泡，不叠出一堆半截',
  /let aiId = chat\.agentResumeNodeId;/.test(api)
  && /if \(reusable\) \{/.test(api)
  && /chat\.agentResumeNodeId = aiId;/.test(api));
t('找回失败时保住已收到的正文，不整个换成 ⚠️',
  /chat\.nodes\[aiId\]\.content = fullText;/.test(api)
  && /appendWarnBlock\(chat\.nodes\[aiId\], error\);/.test(api));
t('接上了就把重连次数归零（不然一个活总共只准断 60 次）',
  /reconnects = 0;/.test(api) && /reconnects >= 60/.test(api));
t('跑完的活先取回，一轮最多接一个还在跑的',
  /\.sort\(\(a, b\) => \(findRun\(b\)\?\.done \? 1 : 0\) - \(findRun\(a\)\?\.done \? 1 : 0\)\)/.test(api)
  && /if \(tookLive\) \{ leftover = true; continue; \}/.test(api));
// save() = 防抖写盘 + createBackup()。换成 _doSave() 就把备份环甩掉了，
// 而其中一处是**所有模型**共用的报错分支 —— 影响面远超电脑操控。
t('走 _doSave 的地方都补上 createBackup，别把备份环甩掉',
  !/_doSave\(\); renderMessages\(\); return;/.test(api)
  && (api.match(/_doSave\(\); createBackup\(\)/g) || []).length >= 4);
// 硬上限**不能**复用 stopped：stopped 的语义是「她自己按的停止」，前端见了直接丢弃不取，
// 于是缓冲里攒了一小时的输出连同那句掐掉原因一起静默消失。
t('硬上限掐掉时说一声，且不借用 stopped 的语义',
  /r\.hardKilled = true;\s*\n\s*runEmit\(r, \{ error:/.test(server)
  && /!r\.done && !r\.hardKilled && now - r\.startedAt > AGENT_RUN_HARD_MAX/.test(server)
  && /hardKilled: false/.test(server));
t('销账落盘后把 runId 清掉（否则这个对话以后每轮都全量写盘）',
  /function clearAgentRunRefs\(chat\)/.test(api)
  && /chat\.agentResumeNodeId = null;/.test(api)
  && (api.match(/clearAgentRunRefs\(chat\)/g) || []).length >= 5);

// 纯聊天原来是 --tools none（其实 'none' 不是合法值，只是碰巧不匹配任何工具名）。
// 现在给两个只读联网工具，让她能直接甩个 GitHub 链接过来。
console.log('\n[9] 纯聊天也能上网查（只读两件）');
// ⚠️ `--tools none` 实测**不关工具**（'none' 不是合法工具名 → 整个参数被静默忽略 →
//    退回全部工具）。所以这行不只是加功能，它同时把纯聊天从「全工具」收紧到两个只读的。
//    用 --allowed-tools 预授权而不是 bypassPermissions：实测两种都能抓网页，前者面更小。
t('纯聊天只开 WebSearch/WebFetch，用预授权而不是 bypassPermissions',
  /'--tools', 'WebSearch,WebFetch',/.test(server)
  && /'--allowed-tools', `WebSearch,WebFetch,\$\{GH_TOOL_PREFIX\}`/.test(server)
  && !/'--tools', 'none'/.test(server)
  && !/'WebSearch,WebFetch', '--permission-mode'/.test(server));
t('联网工具事件纯聊天也推给前端，别的工具不推',
  /const WEB_TOOLS = \{ WebSearch: 1, WebFetch: 1 \}/.test(server)
  && /if \(!agent && !WEB_TOOLS\[b\.name\] && !String\(b\.name\)\.startsWith\(GH_TOOL_PREFIX\)\) continue;/.test(server));
t('产物只在电脑操控时记（纯聊天没有写文件的能力）',
  /if \(agent\) noteArtifact\(run, b\.name, b\.input\)/.test(server));
t('工具结果（网页正文）不往纯聊天气泡里灌',
  /\} else if \(agent && j\.type === 'user' && j\.message/.test(server));
t('前端把联网工具渲染成 🔍，链接和搜索词看得见',
  /j\.tool\.name === 'WebSearch' \|\| j\.tool\.name === 'WebFetch'/.test(api)
  && /args\.url \|\| args\.query/.test(api)
  && /isWebTool \? '🔍' : '🔧'/.test(api));

// ── GitHub 检索（mcp-github.js） ──────────────────────────
// WebFetch 抓 GitHub 会先被小模型摘要一遍，读代码必然失真。挂个只读 MCP 拿原文。
console.log('\n[9b] 本地 Claude 能翻 GitHub 仓库');
const ghMcp = read('mcp-github.js');
t('mcp-github.js 实现了 MCP 三件套（initialize / tools/list / tools/call）',
  /method === 'initialize'/.test(ghMcp)
  && /method === 'tools\/list'/.test(ghMcp)
  && /method === 'tools\/call'/.test(ghMcp));
t('五个只读工具齐全，一个写操作都没有',
  ['repo_overview', 'list_files', 'read_file', 'search_code', 'search_repos']
    .every(n => new RegExp(`name: '${n}'`).test(ghMcp))
  && !/axios\.(post|put|patch|delete)/.test(ghMcp));
t('read_file 带行号回原文（没行号就没法跟她对着讨论第几行）',
  /padStart\(5\)/.test(ghMcp) && /共 \$\{all\.length\} 行/.test(ghMcp));
// ⚠️ 踩过：--mcp-config 直接塞 JSON 字符串，只要哪一层套了 shell 就被吞成
//    `MCP config file not found: {mcpServers:{...}}`。落成临时文件跟转义彻底无关。
// 2026-09-06：配置构造改成可组合的 mcpConfigFile({github,browser})，缓存从单变量
// 换成按组合名的 Map。要守的还是同一件事——落成文件、把路径交出去。
t('--mcp-config 传的是文件路径，不是 JSON 字符串',
  /fs\.writeFileSync\(p, JSON\.stringify\(\{ mcpServers \}\), 'utf8'\)/.test(server)
  && /_mcpConfigPaths\.set\(key, p\)/.test(server)
  && /'--mcp-config', mcpConfigFile\(\{[^})]*\}\), '--strict-mcp-config'/.test(server)
  // 反面：任何一个调用点直接把 JSON 塞进 --mcp-config 都算破功
  && !/'--mcp-config',\s*JSON\.stringify/.test(server));
// exe 里没有 node，mcp-github.js 又躺在 asar 里 —— 只有 Electron 自己读得到它
t('MCP 子进程走 execPath + ELECTRON_RUN_AS_NODE（exe 里没有 node）',
  /command: process\.execPath/.test(server)
  && /ELECTRON_RUN_AS_NODE: '1'/.test(server)
  && /path\.join\(__dirname, 'mcp-github\.js'\)/.test(server));
t('--strict-mcp-config 在，别把用户装的一堆 MCP 全拉起来',
  /'--strict-mcp-config'/.test(server));
// repo/path/ref 全是模型给的，直接 encodeURI 拼 URL 管不住：encodeURI 不编码 ? 和 #，
// 而 `../..` 会被 fetch 规范化成另一个仓库（都是公开只读 GET，但属于参数没管住）
t('path/ref 逐段编码且拒掉 ..', /function safePath\(p\)/.test(ghMcp)
  && /segs\.some\(s => s === '\.\.'\)\) return null/.test(ghMcp)
  && /map\(encodeURIComponent\)\.join\('\/'\)/.test(ghMcp)
  && !/encodeURI\(/.test(ghMcp));
// ⚠️ Codex 二审逮到的：safePath 修住了 path/ref，repo 却漏了 ——
//    owner/repo 的字符集 [\w.-] 里含点，`../../torvalds/linux` 解析成 `../..`，
//    拼进去一规范化就打到了 https://api.github.com/ 根路径
t('repo 里的纯点段也拒掉（[\\w.-] 放行了 ..）',
  /\/\^\\\.\+\$\/\.test\(owner\) \|\| \/\^\\\.\+\$\/\.test\(name\)\) return null/.test(ghMcp)
  && /encodeURIComponent\(owner\)\}\/\$\{encodeURIComponent\(name\)\}/.test(ghMcp));
t('前端把 GitHub 工具渲染成人话，能看出在翻哪个仓库',
  /mcp__github__list_files: '📁 列目录'/.test(api)
  && /mcp__github__read_file: '📖 读文件'/.test(api)
  && /\[args\.repo, args\.path, args\.query\]/.test(api));

// 五审（2026-07-30）。必改 1 和 5 又是上一轮修出来的新回归 —— 每一轮都有，所以每一条都留断言。
console.log('\n[10] 五审打回来的那几条');
// 必改1：加了 reader 异常兜底之后，没有 runId 的路径（纯聊天、本地 GPT）异常被吃在循环里，
// error 为 null → callAPI 走成功分支 → 半句话被当最终答案落盘、还喂进记忆抽取，界面上一声不吭。
t('没有 runId 的断线也要报错，不能静默当成功',
  /if \(!sawDone && !yielded && !reattachError\)/.test(api)
  // 前面那个 `\(?` ：2026-09-20 纯聊天也登记活之后，条件从 `runId` 变成
  // `(runId && runKind === 'agent')` —— 聊天轮现在也有 runId 了，但它没被记在
  // 对话上（见 server.js 里 kind='chat' 那段），所以没有「回头再捞」这条路，
  // 文案得退回「连接断了」那句。这里守的仍是「必须报错、不许静默当成功」。
  && /reattachError = \(?runId/.test(api)
  && /连接断了，这条回复没收完/.test(api));
// 必改2：06-render-msg.js 是 `else if (m.blocks?.length)` → 只吃 blocks 不看 content，
// 而只要收到过一个字 blocks 就非空。只改 content 的 ⚠️ 永远渲染不出来。
t('⚠️ 必须进 blocks，不然渲染根本看不到',
  /function appendWarnBlock\(node, error\)/.test(api)
  && /node\.blocks = blks;/.test(api)
  && /else if \(m\.blocks\?\.length\)/.test(read('js/06-render-msg.js'))
  && (api.match(/appendWarnBlock\(/g) || []).length >= 3);
// 必改5：上一轮断线没找回成功（气泡号还留着），又在同一对话发一轮 → 新活的全量回放
// 会被写进上一轮那条气泡（时间线上更早的位置），上一轮找回的内容同时被擦掉。
t('新活登记时清掉上一轮留下的气泡号',
  /originChat\.agentRunId = j\.runId;[\s\S]{0,800}?originChat\.agentResumeNodeId = null;/.test(api));
t('找回时的 404/409 给人话并销账，不甩原始状态码',
  /if \(resumeRunId && \(res\.status === 404 \|\| res\.status === 409\)\) \{/.test(api));
t('只在真的清过账时才写盘', /if \(dirty\) \{ _doSave\(\); createBackup\(\); \}/.test(api));
t('没轮到的活自己排一次重试（否则等到 TTL 过期就丢了）',
  /if \(leftover\) setTimeout\(checkLiveAgentRuns, 5000\)/.test(api));
// localStorage 写失败时每次现摇新 id → POST 登记 X、重连带 Y → 409 → 让位销账 → 永久丢活
t('设备号有内存缓存', /let _agentDeviceId = null;/.test(api)
  && /if \(_agentDeviceId\) return _agentDeviceId;/.test(api));
t('重连有总时限兜底（归零之后不能无限重试）',
  /const reattachDeadline = Date\.now\(\) \+ 70 \* 60 \* 1000;/.test(api));
t('纯聊天的工具调用不算「有内容」（只有 🔍 没正文 = 这轮白跑）',
  /if \(agent\) hasContent = true;/.test(server));
t('复用气泡前确认它还在当前分支路径上',
  /getMessagePath\(chat, chat\.headId\)\.some\(n => n\.id === aiId\)/.test(api));
t('硬上限掐掉不再叠一条「异常退出」', /else if \(run && run\.hardKilled\) \{/.test(server));

console.log('\n[11] 六审打回来的那几条');
const render = read('js/06-render-msg.js');
// 必改1：error 分支是所有模型共用的，只问「这对话有没有欠账」会把无关气泡盖章 →
// 找回时把电脑操控一小时的产出写进别的模型、别的提问下面那条气泡里
t('气泡盖章要比对这一轮自己的 runId',
  /runId: turnRunId \} = await streamCompletion/.test(api)
  && /if \(turnRunId && turnRunId === chat\.agentRunId && !chat\.agentRunClaimed\)/.test(api));
t('本地 Claude 那条路的每个 error 返回都带上 runId',
  (api.match(/return \{ fullText, reasoningText, blocks, runId,/g) || []).length >= 3);
// 必改2：blocks 非空时渲染完全不看 content（06-render-msg.js:436 / :552）
t('群聊失败也走 appendWarnBlock（不是只写 content）',
  /if \(error\) \{ appendWarnBlock\(chat\.nodes\[aiId\], error\); /.test(render)
  && !/chat\.nodes\[aiId\]\.content = `⚠️ \$\{error\}`/.test(render));
t('变体重跑失败也走 appendWarnBlock',
  /appendWarnBlock\(variant, `\$\{conf\.nickname\}: \$\{error\}`\)/.test(api)
  && !/variant\.content = `⚠️ \$\{conf\.nickname\}/.test(api));
// 该改3：早返回发生在读流之前，runId 还是 null → finally 的门不成立 → claimRun 白设
t('runId 初值取 resumeRunId，找回那条路的销账才生效',
  // 结尾从 `;` 放宽到 `[,;]`：2026-09-20 这行后面多了一个 runKind（服务端说这个活是
  // agent 还是 chat）。守的是 runId 的初值和 claimRun 从 false 起，不是守这行到此为止。
  /let runId = resumeRunId \|\| null, claimRun = false[,;]/.test(api));
// 该改4：直连那条路没有 agent、没工具、没 AGENT_SAFETY、不登记 run
//
// 2026-09-04 重写：原来这条断言的是源码里存在 `|| (wantThinking && !agent)) {` 这串字符 ——
// 名字讲行为、实现认字符串，于是「思考不再需要绕直连」这个**更彻底的修法**反而把它打红了。
// 现在改成论证反面：不管条件怎么写，只要走直连的那个 if 里**提到了 wantThinking**，
// 就说明思考又成了绕路的理由 → 判红。这样任何写法的退化都逃不掉，而不是只认一种写法。
// 2026-10-15 开源版：直连那条路整个删了（不再读 Claude Code 的登录凭据），带图也走 CLI ——
// 纯聊天的图经 --input-format stream-json 以 base64 块交给 CLI，电脑操控的图落盘后让 Read 工具读。
// 所以守的东西变成：路由里**不许再出现**一个按 hasImages 提前分岔、自己发 SSE 头的 if。
const directRouteIf = server.match(/\n {4}if \(([^\n]*hasImages[^\n]*)\) \{\n {8}res\.setHeader\('Content-Type', 'text\/event-stream'\)/);
t('★ 没有按「带图 / 思考」提前分岔出去的直连 if（只有一条 CLI 路）',
  !directRouteIf && !/handleLocalClaudeWithImages/.test(server),
  directRouteIf ? `又出现了分岔：${directRouteIf[1]}` : '');
t('电脑操控带图成功落盘后留在 CLI 工具链（Read 工具读图）',
  /const agentImageFiles = hasImages && agent \? await materializeImages\(lastUserMsg\.images\) : \[\];/.test(server));
t('★ 其余带图的轮（纯聊天 / 落盘失败）图以内容块交给 CLI，工具照开、不再「只能口头回答」',
  /const inlineImages = hasImages && !agentImageFiles\.length \? await imageBlocksFor\(lastUserMsg\.images\) : \[\];/.test(server)
  && !/notice: '这轮带了图片/.test(server));
t('前端照样认 notice 帧（浏览器没起来那条还在用）', /if \(j\.notice\) \{/.test(api));
// 可选5：加了常驻定时器之后，这条没哨兵就每 60 秒重 kill 一个死 pid、永远删不掉
t('孤儿回收也有哨兵，不会每分钟重 kill',
  /!r\.done && !r\.orphanKilled && !r\.res && r\.detachedAt/.test(server)
  && /orphanKilled: false,/.test(server));
// 可选6：{runId} 帧每次重挂都重发，断 60 次就是 60 次全量写盘
t('runId 没变就不重复全量写盘',
  /originChat && !resumeRunId && originChat\.agentRunId !== j\.runId/.test(api));

console.log('\n[12] 七审打回来的那两条');
// 该改1原文：「带图那条岔路给了 notice，思考那条忘了 —— CLI 路根本不消费 thinkingMode，
// 思考链永远不出现且零解释」。2026-09-04 起这个前提没了：CLI 路会显式发
// --thinking-display summarized，思考链真的出得来，所以那条「明说没有思考链」的 notice
// 已删（留着就是条假提示）。守护点整个换成下面这条——它才是思考链现在能出来的唯一原因。
//
// 为什么必须有人守：不发这个参数时 CLI **不报错也不少东西** —— thinking 块照发、
// thinking_delta 照来，只有文本是空字符串（实测带参数 90 字符 / 不带 0 字符）。
// 纯正的静默失败，前端只会表现成「思考开了却永远不显示」。
t('思考=总是时给 CLI 显式发 --thinking-display summarized',
  /if \(wantThinking\) args\.push\('--thinking-display', 'summarized'\)/.test(server));
// 值只能是 summarized / omitted，传别的 CLI 直接 unknown-value 退出，整轮聊天挂掉
t('--thinking-display 的值是 CLI 认的那两个之一',
  !/--thinking-display'\s*,\s*'(?!summarized'|omitted')/.test(server));
// 这条不变量以前没人守：run 在册时前端对每个非 {runId} 帧都 evIndex++，
// 裸 res.write 不进 run.events → 客户端多一格 → 下次重连 from 多跳 → 静默漏一条真事件。
// 原来它挂在那条已删的 notice 上；规则本身没变，改成守整条 CLI 路（spawn 之前也算，
// 上面 [1] 组那条只查 spawn 之后）。
const cliRoute = server.slice(server.indexOf("app.post('/api/local-claude'"),
                              server.indexOf("app.post('/api/local-gpt'"));
t('CLI 路不许裸 res.write 下行事件，一律走 send()',
  !/res\.write\(`data: \$\{JSON\.stringify\(\{ notice:/.test(
    cliRoute.slice(cliRoute.indexOf('const send = (obj)'))));
// 可选2：⚠️ 只写 content 渲染不出来的第 5、6 处
t('按停止时的提示也走 appendWarnBlock（正文空但思考已在流的那种）',
  /if \(!n\.content\) appendWarnBlock\(n, '已停止生成'\);/.test(core)
  && /if \(!v\.content\) appendWarnBlock\(v, '已停止'\);/.test(core));

// 2026-09-20：修「网一抖本地AI就丢一整轮」。做法是纯聊天也登记 run，
// 但**只在服务端**登记 —— runId 不写进 chat.agentRunId。
// 上面 [1] 组守的是「不再 kill」，这一组守的是「登记之后别把别的东西带塌」，
// 三条各对应一个我真的差点做错（或已经做错过）的地方。
console.log('\n[13] 纯聊天也登记活（2026-09-20）');
// ① 登记这件事本身。以前是 `const run = agent ? newAgentRun(...) : null;`，
//    三元一回来，res.on('close') 的 kill 分支就复活了。
t('本地 Claude 每一轮都登记 run，不看 agent',
  /const run = newAgentRun\(proc, latestUserText\(messages\) \|\| prompt, agentSub, agent \? 'agent' : 'chat'\);/
    .test(claudeRoute)
  && !/const run = agent \? newAgentRun/.test(claudeRoute));
// ② 我自己造的回归，写完才逮到：两处单飞锁按 subId 去重，而 subId 就是同一个
//    agentDeviceId()。不筛掉 chat 的话，一轮**闲聊**还没跑完（或者她断着网、
//    进程还在后台），紧接着的电脑操控请求会被判成「这条任务已经在后台运行」
//    直接拒掉 —— 她根本没起过任务，却被告知重复启动。
//    断言写成「每一处 duplicate 查找都带 kind 筛」，不是数出现了几次：
//    以后再加第三处锁，漏筛照样红。
t('单飞锁只挡电脑操控，不把闲聊算进去',
  server.match(/\[\.\.\._agentRuns\.values\(\)\]\.find\(r => [^\n]*r\.subId/g)
  && server.match(/\[\.\.\._agentRuns\.values\(\)\]\.find\(r => [^\n]*r\.subId/g)
       .every(s => /r\.kind !== 'chat'/.test(s)));
// ③ kind 必须由服务端说了算（{runId} 帧里带），前端不许看自己的 agentMode 猜：
//    找回那条路（App 被杀之后 reattach）根本没有本地 agentMode 可看。
//    而 'chat' 的 runId 不写进 chat.agentRunId —— 写了会连坏三处：
//    每轮聊天多一次全量 _doSave()、checkLiveAgentRuns 弹「🖥 那个活还在电脑上跑着」、
//    30-vitals.js 那句 chat.agentRunId 把自主心跳一直挡在门外。
//    ⚠️ Codex 逮到的：原来这条只钉了 attachRun（重挂那帧），漏了**初次连接那帧**。
//    漏掉的那帧才是要命的 —— 少了 kind，聊天轮第一次连上时 runKind 停在默认
//    'agent'，当场就把 runId 错写进 chat.agentRunId；等重挂时收到正确的 kind
//    已经晚了。两帧都得钉。
t('kind 由服务端下发（初次连接和重挂两帧都带），且 chat 的 runId 不记到对话上',
  /res\.write\(`data: \$\{JSON\.stringify\(\{ runId: run\.id, resumeFrom: 0, kind: run\.kind \}\)\}/
    .test(claudeRoute)
  && /res\.write\(`data: \$\{JSON\.stringify\(\{ runId: run\.id, resumeFrom: run\.dropped, kind: run\.kind \|\| 'agent' \}\)\}/
    .test(server)
  && /if \(j\.kind\) runKind = j\.kind;/.test(api)
  && /if \(runKind === 'agent' && originChat && !resumeRunId/.test(api));
// ⑤ 清单必须在**服务端**就把聊天滤掉。前端滤不算数：老版本前端不认识 kind，
//    会把一条闲聊显示成「电脑上还有活在跑」，另一台同 subId 的设备甚至能去接管它。
t('「电脑上还有活吗」清单只给电脑操控的活',
  /\[\.\.\._agentRuns\.values\(\)\]\.filter\(r => \(r\.kind \|\| 'agent'\) === 'agent'\)\.map/.test(server));
// ⑥ 聊天的活必须有自己那档短回收。它的 runId 只活在那一轮的闭包里，页面一刷新
//    就没人认领得了，却不像电脑操控那样进单飞锁 —— 她断网后连着重发几次，
//    就是几个 claude 进程并排烧额度烧到孤儿回收。这条要同时守住「有这个常量」
//    「它明显短于 agent 那档」「gc 真的按 kind 选了它」。
const orphanChat = server.match(/const AGENT_RUN_ORPHAN_CHAT = (\d+) \* 60 \* 1000;/);
const orphanAgent = server.match(/const AGENT_RUN_ORPHAN = (\d+) \* 60 \* 1000;/);
t('纯聊天的活有单独一档短得多的孤儿回收',
  !!orphanChat && !!orphanAgent && +orphanChat[1] < +orphanAgent[1]
  && /r\.kind === 'chat' \? AGENT_RUN_ORPHAN_CHAT : AGENT_RUN_ORPHAN/.test(server)
  && /now - r\.detachedAt > orphanAfter/.test(server),
  orphanChat && orphanAgent ? `chat=${orphanChat[1]}min agent=${orphanAgent[1]}min` : '常量没找到');
// ⑦ 前端彻底放弃聊天重连时要主动喊停（服务端那档 3 分钟只是兜底）。
//    电脑操控的活相反，一个字都不能停 —— 所以这里必须带着 runKind === 'chat' 的闸。
t('放弃聊天重连时主动喊停，且只停聊天的活',
  /if \(runId && runKind === 'chat'\) \{\s*\n\s*fetch\(`\$\{SERVER_BASE\}\/api\/agent-run\/\$\{runId\}\/stop`, \{ method: 'POST' \}\)\.catch\(\(\) => \{\}\);/
    .test(api));
// ④ 产物白名单是按 run.artifacts 放行下载的，登记 chat run 等于往那个集合里
//    多塞了一批 run。它们的 artifacts 必须恒空 —— 靠的是 noteArtifact 只在
//    agent 分支调用。这条红了说明白名单被悄悄放宽了。
//    写成「调用点有且只有一个，且那一个带 agent 闸」而不是「没有不带闸的调用」：
//    以后有人加第二处（哪怕也带着闸）这条也红，逼人回来重想一遍白名单。
//    （函数声明那行也长得像调用，`function` 开头的那条要先摘出去）
const artifactCalls = (server.match(/^.*\bnoteArtifact\(run,.*$/gm) || [])
  .filter(l => !/function noteArtifact/.test(l));
t('chat 的 run 不可能带产物（noteArtifact 只挂在 agent 分支上）',
  artifactCalls.length === 1 && /if \(agent\) noteArtifact\(run, /.test(artifactCalls[0]));

console.log('\n[7] 桌面与安卓副本一致');
t('android 副本与 js/ 一致', ['01-core.js', '05-prompts-api.js', '06-render-msg.js', '14-boot-brain-hub.js'].every(f =>
  fs.readFileSync(R + f).equals(fs.readFileSync(path.join(ROOT, 'android/assets/js', f)))));

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
