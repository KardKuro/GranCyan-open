// 音标查询回归测试（server.js 的 /api/ipa 那一段）。
// 跑法：node tests/ipa-lookup.test.js  —— 全程 mock，不出网。
//
// 守的是这个静默失败：
//   端点那层的约定是「返回空串 = 词典里确实没有 → 永久缓存」。
//   原来 fetchIpaEn/fetchIpaDe 把 HTTP 非 200 一律 `return ''`，于是批量补音标时
//   dictionaryapi.dev 一次限流（串行打上百个词，很容易 429）就把那一批词
//   **永久钉死成"没有音标"**——之后按多少次「补音标」都补不回来，一声不吭。
//   用户那 27 个补不到的词，二十个是这么来的。
//
// 所以下面每一组都成对写：一个"真查不到"（必须缓存）配一个"没查成"（必须抛）。
// 只测其中一边的话，`return ''` 那个 bug 版本照样全绿。
const fs = require('fs'), vm = require('vm'), path = require('path');
const { readSingleSrc } = require('./_src-map');
const ROOT = path.resolve(__dirname, '..');
// 音标后端已搬进 server/ipa.js（docs/server-split-plan.md Phase 1 第二块），
// 经 readSingleSrc('ipa') 取当前真实位置，逻辑名一条不改，映射表在 tests/_src-map.js 里改。
const SRC = readSingleSrc('ipa').text;

let pass = 0, fail = 0;
const t = (name, cond) => cond
  ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name));

// 把 ipaLookupForm … fetchIpaDe 这一整段切出来单独跑（它们之间只有注释）
const from = SRC.indexOf('function ipaLookupForm');
const to = SRC.indexOf("app.get('/api/ipa'");
if (from < 0 || to < 0 || to <= from) {
  console.log('  ✗ 切不出音标那段代码（server.js 结构变了？）');
  process.exit(1);
}
const slice = SRC.slice(from, to);

// mock 出网。routes: { 'host|标识' : () => ({status, data}) 或 抛错 }
let routes = {}, calls = [];
const ctx = {
  console,
  outboundAgent: async () => null,
  axios: {
    async get(url, cfg) {
      const p = (cfg && cfg.params) || {};
      const key = url.includes('dictionaryapi') ? 'dict|' + decodeURIComponent(url.split('/en/')[1])
                : url.includes('de.wiktionary') ? 'de|' + p.page
                : url.includes('en.wiktionary') ? 'en|' + p.page
                : 'other|' + url;
      calls.push(key);
      const h = routes[key];
      // 没配路由 = 这个源没有这个词。两个源"没有"的长相不一样：
      // dictionaryapi.dev 回 404，MediaWiki 回 **HTTP 200 + error.code=missingtitle**
      //（实测过，不是 404 —— mock 写错就测不到真实路径）
      if (h === undefined) {
        return key.startsWith('dict|') ? { status: 404, data: { title: 'No Definitions Found' } }
                                       : { status: 200, data: { error: { code: 'missingtitle' } } };
      }
      return typeof h === 'function' ? h() : h;
    },
  },
};
vm.createContext(ctx);
// class 声明是词法的，不会像 function 那样自动挂到 vm 的全局对象上 —— 手动导出一下，
// 否则下面的 instanceof 拿到的是 undefined
vm.runInContext(slice + '\nglobalThis.IpaLookupFailed = IpaLookupFailed;', ctx);

const wikiOk = (wikitext) => ({ status: 200, data: { parse: { wikitext } } });
const wikiMissing = { status: 200, data: { error: { code: 'missingtitle' } } };
const dictOk = (phonetic) => ({ status: 200, data: [{ word: 'x', phonetic, phonetics: [{ text: phonetic }] }] });
const notFound = { status: 404, data: { title: 'No Definitions Found' } };

const threw = async (fn) => { try { await fn(); return false; } catch (e) { return e instanceof ctx.IpaLookupFailed; } };
// 端点那层 catch 的是**任何**异常（都走 ok:false、都不写缓存），所以原生的
// 网络异常不必包装成 IpaLookupFailed —— 这里只要求它别被吞成空串
const threwAny = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };
const deSection = (ipa) => `== Land ({{Sprache|Deutsch}}) ==\n{{Lautschrift|${ipa}}}\n`;

(async () => {

console.log('\n[1] 查词形');
t('德语冠词剥掉（der Tisch 查不到，Tisch 才有条目）', ctx.ipaLookupForm('de', 'der Tisch') === 'Tisch');
t('尾部感叹号剥掉（hallo! 会 missingtitle）', ctx.ipaLookupForm('de', 'hallo!') === 'hallo');
t('英语尾部标点同样剥', ctx.ipaLookupForm('en', 'really?') === 'really');
t('词中间的标点不动', ctx.ipaLookupForm('en', "don't") === "don't");
t('空输入返回空', ctx.ipaLookupForm('en', '   ') === '');

console.log('\n[2] 「真查不到」和「没查成」必须分开');
// 对照组 A：两个源都明确说没有 → 空串（会被缓存，这是对的）
routes = {}; calls = [];
t('两个源都 404/missingtitle → 返回空串（可以缓存）', await ctx.fetchIpaEn('zzqxwv') === '');
// 对照组 B：同样拿不到音标，但原因是服务端挂了 → 必须抛，绝不能缓存
routes = { 'dict|boom': { status: 429, data: {} } };
t('dictionaryapi 429 → 抛 IpaLookupFailed（不是悄悄当成"没有音标"）', await threw(() => ctx.fetchIpaEn('boom')));
routes = { 'dict|boom': { status: 503, data: {} } };
t('dictionaryapi 503 → 同样抛', await threw(() => ctx.fetchIpaEn('boom')));
routes = { 'dict|boom': notFound, 'en|boom': { status: 500, data: {} } };
t('主源说没有、兜底源 500 → 抛（不能因为主源 404 就认定"确实没有"）', await threw(() => ctx.fetchIpaEn('boom')));
routes = { 'de|Boom': { status: 502, data: {} } };
t('德语 wiktionary 502 → 抛', await threw(() => ctx.fetchIpaDe('boom')));
routes = { 'de|boom': { status: 200, data: { error: { code: 'ratelimited' } } } };
t('wiktionary 回了个非 missingtitle 的 error → 抛', await threw(() => ctx.fetchIpaDe('boom')));
routes = { 'dict|boom': () => { throw new Error('ECONNRESET'); } };
t('网络直接断 → 异常照样往上抛，不吞成空串', await threwAny(() => ctx.fetchIpaEn('boom')));

// HTTP 200 但响应结构不对：中间代理插 HTML、返回 {}、被墙截胡改写都长这样。
// `d?.parse?.wikitext || ''` 会把它们一律变成空串 → 上层当"确实没有"永久缓存 →
// 本次要修的 bug 换个入口原样复发。**结构不对 = 没查成**。（Codex 审出来的第 2 条）
routes = { 'de|weird': { status: 200, data: {} } };
t('wiktionary 回 200 但响应是空对象 → 抛，不当成"没这个词"', await threw(() => ctx.fetchIpaDe('weird')));
routes = { 'de|weird': { status: 200, data: '<html>被中间页截胡了</html>' } };
t('wiktionary 回 200 但响应是 HTML → 抛', await threw(() => ctx.fetchIpaDe('weird')));
routes = { 'de|weird': { status: 200, data: { parse: {} } } };
t('有 parse 但没有 wikitext → 抛', await threw(() => ctx.fetchIpaDe('weird')));
// 对照组：结构合法、内容确实为空，这是正常结果，不能跟着一起抛
routes = { 'de|weird': { status: 200, data: { parse: { wikitext: '' } } }, 'de|Weird': wikiMissing };
t('结构合法但 wikitext 是空字符串 → 正常返回空串（不误伤）', await ctx.fetchIpaDe('weird') === '');
routes = { 'dict|weird': notFound, 'en|weird': { status: 200, data: {} } };
t('英语兜底源同样按这条走', await threw(() => ctx.fetchIpaEn('weird')));

console.log('\n[3] 英语：主源 → en.wiktionary 兜底');
routes = { 'dict|policy': dictOk('/ˈpɒləsi/') };
t('主源有就用主源', await ctx.fetchIpaEn('policy') === '/ˈpɒləsi/');
// subscription 真实复现：dictionaryapi.dev 有词条、有释义，就是没有读音
routes = {
  'dict|subscription': { status: 200, data: [{ word: 'subscription', phonetics: [] }] },
  'en|subscription': wikiOk('{{IPA|en|/səbˈskɹɪpʃən/}}'),
};
t('主源 200 但一个音标都没有 → 落到 wiktionary 兜底', await ctx.fetchIpaEn('subscription') === '/səbˈskɹɪpʃən/');
routes = { 'dict|freelance': notFound, 'en|freelance': wikiOk('{{IPA|en|/ˈfɹiːlɑːns/}}') };
t('主源 404 也走兜底', await ctx.fetchIpaEn('freelance') === '/ˈfɹiːlɑːns/');
routes = { 'dict|nope': notFound, 'en|nope': wikiOk('没有 IPA 模板的条目') };
t('兜底源有条目但没音标 → 空串', await ctx.fetchIpaEn('nope') === '');

console.log('\n[4] 英语词组');
routes = { 'dict|give': dictOk('/ɡɪv/'), 'dict|up': dictOk('/ʌp/') };
t('词组逐词查了拼起来（give up 没有独立词条）', await ctx.fetchIpaEn('give up') === '/ɡɪv ʌp/');
routes = { 'dict|give': dictOk('/ɡɪv/') };   // up 查不到
t('缺一个词就整体作废——半截音标是在教错读法', await ctx.fetchIpaEn('give up') === '');
routes = {};
t('长句不逐词查（那是例句不是词条）', await ctx.fetchIpaEn('a b c d e') === '');

console.log('\n[5] 德语：只认德语区块');
// land 的真实结构：页面存在，但只有南非荷兰语/英语/冰岛语…… 没有德语。
// 原来那个全文正则会把 Afrikaans 的 /lɑnt/ 当成德语音标交出去 —— 错的音标比没有更难发现。
routes = {
  'de|land': wikiOk('== land ({{Sprache|Afrikaans}}) ==\n{{Lautschrift|lɑnt}}\n== land ({{Sprache|Englisch}}) ==\n{{Lautschrift|lænd}}\n'),
  'de|Land': wikiOk(deSection('lant')),
};
t('同名页面只有外语义项时不拿外语音标充数', await ctx.fetchIpaDe('land') === '/lant/');
t('   （确实去查了首字母大写那一页）', calls.includes('de|Land'));
routes = { 'de|supermarkt': wikiMissing, 'de|Supermarkt': wikiOk(deSection('ˈzuːpɐˌmaʁkt')) };
t('小写名词查不到时自动试首字母大写', await ctx.fetchIpaDe('supermarkt') === '/ˈzuːpɐˌmaʁkt/');
routes = { 'de|gehen': wikiOk('== gehen ({{Sprache|Deutsch}}) ==\n{{Lautschrift|ˈɡeːən}}\n') };
calls = [];   // ⚠️ 清在调用**之前**。第一版写在调用之后，那条断言无论实现怎样都必然通过
t('小写的动词原样就能查到', await ctx.fetchIpaDe('gehen') === '/ˈɡeːən/');
t('   而且查到了就不再多打一次大写', calls.includes('de|gehen') && !calls.includes('de|Gehen'));
routes = {
  'de|nix': wikiOk('== nix ({{Sprache|Deutsch}}) ==\n（这个条目没写发音）\n'),
  'de|Nix': wikiMissing,
};
t('德语区块里没有 Lautschrift → 空串', await ctx.fetchIpaDe('nix') === '');
// 德语区块必须是**这一段**的，不能越界抓到下一门语言的
routes = { 'de|mixed': wikiOk('== mixed ({{Sprache|Deutsch}}) ==\n（没发音）\n== mixed ({{Sprache|Englisch}}) ==\n{{Lautschrift|mɪkst}}\n'), 'de|Mixed': wikiMissing };
t('不越过区块边界去抓下一门语言的音标', await ctx.fetchIpaDe('mixed') === '');

console.log('\n[6] 端点与缓存');
const endpoint = SRC.slice(to, SRC.indexOf('});', SRC.indexOf('res.json({ ok: false, ipa: \'\', reason: e.message })', to)));
t('查到（含空串）才写缓存', /cache\[key\] = ipa;/.test(endpoint));
t('抛错那条走 ok:false 且不碰缓存', /catch \(e\)[\s\S]*ok: false[\s\S]*reason: e\.message/.test(endpoint) && !/catch \(e\)[\s\S]*cache\[key\]/.test(endpoint));
t('缓存有版本号', /IPA_CACHE_VERSION = 2/.test(SRC));
t('升级时丢弃 v1 那些语义不明的空串（真查不到的重查一次就是几秒，被误杀的能回来）',
  /if \(k !== '__v' && !_ipaCache\[k\]\) \{ delete _ipaCache\[k\]/.test(SRC));
t('非空的音标不受影响', !/delete _ipaCache\[k\];\s*\}\s*\}\s*_ipaCache\.__v[\s\S]{0,80}delete/.test(SRC));

// 前端那侧：后端修好了，但客户端的 24 小时重试门会把那批词再挡一天。
// 门必须是**整个拿掉**，不能只在"全体都被挡住"时让路 —— 那样只要有一张卡
// 超过 24 小时，todo 就非空，让路分支根本不触发，剩下的照样被挡一整天。
// （Codex 审出来的第 3 条：注释承诺了让路，第一版实现只在全体被挡时才让。）
const study = fs.readFileSync(path.join(ROOT, 'js/22-study.js'), 'utf8');
t('「补音标」查的是所有缺音标的卡，没有时间门',
  /const todo = studyCards\(\)\.filter\(c => !c\.ipa\);/.test(study));
t('   而且 24 小时门确实拆干净了（没留个半开的条件）',
  !/STUDY_IPA_RETRY_MS\s*[)>]/.test(study) && !/ipaTried \|\| 0\)\) >/.test(study));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
