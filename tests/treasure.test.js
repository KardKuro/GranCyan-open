'use strict';
// 藏宝地图（js/68-treasure.js）：[[HIDE_LETTER: 地点 | 标题 | 正文]] 埋纸条、地图坐标、和原生桥对接
//
// 这块最要紧、也最静默的一条：**纸条正文在被找到之前不能露出来**。
// 露的路有很多条，每条都不报错：存进消息正文、blocks 路径没替换（渲染优先用 blocks）、
// 流式途中闪出来、回复被掐断留下半截、思考里抄了一遍、卡片模板手滑带上 body、
// 交给原生的 setLetters 带上 body（通知/SharedPreferences 里就有正文了）。
// 下面每一条路都单独守。stickerTagForApi / _STREAM_MASKS 是从 05-prompts-api.js 抠出来的原代码。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readLF = p => read(p).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}

const src = read('js/68-treasure.js');
const api = readLF('js/05-prompts-api.js');
function extract(s, startSig, endSig) {
  const a = s.indexOf(startSig);
  const b = s.indexOf(endSig, a);
  if (a < 0 || b < 0) throw new Error('抠不到 ' + startSig);
  return s.slice(a, b);
}
const forApiSrc = extract(api, 'function stickerTagForApi(', '// 「系统提示吃爆窗口」');
const maskSrc = extract(api, 'const _STREAM_MASKS', 'function maskStreamingTags(');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 极简假 DOM：只认 getElementById，元素能装 innerHTML / textContent / classList
function fakeDom() {
  const els = {};
  const mk = (id, hidden) => {
    const cls = new Set(hidden ? ['hidden'] : []);
    return {
      id, innerHTML: '', textContent: '', value: '',
      classList: {
        add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
      },
      focus() {},
    };
  };
  for (const id of ['treasureModal', 'treasureCloud', 'treasureSum', 'treasurePerm', 'treasureNote', 'treasureStage', 'treasureFound',
    'treasureSheet', 'treasureLetter', 'treasureTab_map', 'treasureTab_found', 'treasureMap', 'treasureMeBtn', 'treasureGeo']) els[id] = mk(id, id === 'treasureModal');
  return {
    els,
    document: {
      readyState: 'loading',
      getElementById: id => els[id] || null,
      createElement: () => ({}), head: { appendChild() {} },
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible',
    },
  };
}

function sandbox(opts = {}) {
  const dom = fakeDom();
  const store = {};
  const box = {
    console: { log() {}, warn() {}, error() {} },
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, RegExp, Error, Uint8Array,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, escHtml: esc, toasts: [],
    state: { skillsOff: opts.skillsOff || {} },
    document: dom.document,
    localStorage: opts.noStorage ? undefined : {
      getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    },
    window: {},
  };
  if (opts.noStorage) delete box.localStorage;
  box.showToast = (m) => { box.toasts.push(m); };
  box.skillOn = k => !(box.state.skillsOff && box.state.skillsOff[k]);
  if (opts.native) box.window.GrancyanTreasure = opts.native;
  if (opts.supabase) { box.supabaseClient = opts.supabase; box.currentUser = { id: 'u1' }; }
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(src + '\n' + forApiSrc + '\n' + maskSrc
    + '\nthis._tr = _tr; this.stickerTagForApi = stickerTagForApi; this._STREAM_MASKS = _STREAM_MASKS;', box);
  box.dom = dom; box.store = store;
  return box;
}

const PLACE_A = { name: '公园门口', lat: 30.2600, lng: 120.1300 };
const PLACE_B = { name: '图书馆', lat: 30.2540, lng: 120.1240 };
function withPlaces(b) {
  b.treasureAddPlace(PLACE_A.name, PLACE_A.lat, PLACE_A.lng);
  b.treasureAddPlace(PLACE_B.name, PLACE_B.lat, PLACE_B.lng);
  return b;
}
const KURO = { id: 'k1', nickname: '克克' };
const BODY = '今天你走过这里的时候，我在想你。这是只给你一个人看的话。';

(async () => {
  console.log('\n[1] WGS-84 ⇄ GCJ-02');
  {
    const b = sandbox();
    const g = b.wgs2gcj(39.915, 116.404);
    // 对照值：wandergis/coordtransform 的 README 示例 wgs84togcj02(116.404, 39.915)
    t('北京样例和公认实现一致（到 1e-9 度）', Math.abs(g[0] - 39.91640428150164) < 1e-9 && Math.abs(g[1] - 116.41024449916938) < 1e-9, g);
    const off = b.treasureDistance(39.915, 116.404, g[0], g[1]);
    t('国内偏移量级是几百米', off > 300 && off < 800, off);
    let worst = 0;
    for (const [la, ln] of [[39.915, 116.404], [31.2304, 121.4737], [22.5431, 114.0579], [43.8171, 125.3235], [18.2528, 109.512]]) {
      const gg = b.wgs2gcj(la, ln);
      const w = b.gcj2wgs(gg[0], gg[1]);
      worst = Math.max(worst, b.treasureDistance(la, ln, w[0], w[1]));
    }
    t('反算迭代：一来一回误差 < 1 厘米（存库的点不会越点越漂）', worst < 0.01, worst);
    const tokyo = b.wgs2gcj(35.6812, 139.7671);
    t('境外不偏移（东京）', tokyo[0] === 35.6812 && tokyo[1] === 139.7671);
    const lon = b.gcj2wgs(51.5074, -0.1278);
    t('境外反算也不动（伦敦）', lon[0] === 51.5074 && lon[1] === -0.1278);
    t('距离：赤道 1 度纬度 ≈ 111.19km', Math.abs(b.treasureDistance(0, 0, 1, 0) - 111195) < 5);
  }

  console.log('\n[2] 地点');
  {
    const b = sandbox();
    t('标地点', b.treasureAddPlace('公园门口', 30.26, 120.13).ok);
    t('重名不让标', !b.treasureAddPlace(' 公园门口 ', 30.2, 120.1).ok);
    t('空名不让标', !b.treasureAddPlace('  ', 30.2, 120.1).ok);
    const p = b.treasurePlaces()[0];
    t('地点存 kind=place、hidden_by=user、半径 150、坐标原样（WGS-84）',
      p.kind === 'place' && p.hidden_by === 'user' && p.radius_m === 150 && p.lat === 30.26 && p.lng === 120.13, p);
    t('本机缓存写进了 localStorage', /公园门口/.test(b.store.gc_treasure_v1 || ''));
    const b2 = sandbox();
    b2.store.gc_treasure_v1 = b.store.gc_treasure_v1;
    t('换一个页面读得回来（离线可用）', b2.treasurePlaces().length === 1);
    b.treasureRetirePlace(p.id, true);
    t('拿掉地点是软删（deleted_at），列表里没了', b.treasurePlaces().length === 0 && !!b._tr.rows[0].deleted_at);
  }

  console.log('\n[3] 埋：[[HIDE_LETTER: 地点 | 标题 | 正文]]');
  {
    const b = withPlaces(sandbox());
    const ctx = {};
    const out = b.treasureProcessTags(`嗯，给你埋了一张\n[[HIDE_LETTER: 公园门口 | 散步路上 | ${BODY}]]\n去找吧`, null, KURO, ctx);
    const L = b.treasureLetters();
    t('埋下了一张', L.length === 1, L.length);
    const l = L[0];
    t('正文存进了纸条', l && l.body === BODY);
    t('坐标/半径照抄那个地点、hidden_by=chat、还没找到',
      l && l.lat === PLACE_A.lat && l.lng === PLACE_A.lng && l.radius_m === 150 && l.hidden_by === 'chat' && l.found_at === null, l);
    t('★ 消息里不留正文', !out.includes('只给你一个人看') && !out.includes(BODY), out);
    t('换成存储短标签（id + 地点 + 标题 + 谁）', out.includes(`[[TREASURE_HID:${l.id}|公园门口|散步路上|克克]]`), out);
    t('指令前后的话还在', out.startsWith('嗯，给你埋了一张') && out.trim().endsWith('去找吧'));
    t('结果记进 ctx 给 blocks 路径认领', ctx.treasureResults && ctx.treasureResults.length === 1 && ctx.treasureResults[0].ok);

    const out2 = b.treasureProcessTags('[[HIDE_LETTER：园门口｜全角也认｜正文里有 | 竖线也照收]]', null, KURO, {});
    const l2 = b.treasureLetters()[1];
    t('全角冒号/竖线也认，地点多写一两个字（唯一包含）也对得上', l2 && l2.place === '公园门口' && l2.title === '全角也认', l2);
    t('正文里的竖线不当分隔（第三段起全是正文）', l2 && l2.body === '正文里有 | 竖线也照收', l2 && l2.body);
    t('全角那条也没留正文', !out2.includes('竖线也照收'));

    const n0 = b.treasureLetters().length;
    const miss = b.treasureProcessTags('[[HIDE_LETTER: 月球背面 | 到不了 | 秘密]]', null, KURO, {});
    t('地点对不上：不埋', b.treasureLetters().length === n0);
    t('对不上换成失败短标签，也不留正文', miss.includes('[[TREASURE_MISS:noplace|月球背面|到不了]]') && !miss.includes('秘密'), miss);
    t('失败卡片说清楚为什么', b.treasureTagToHtml(miss).includes('地图上没有这个地点'));
    const empty = b.treasureProcessTags('[[HIDE_LETTER: 图书馆 | 空的 |   ]]', null, KURO, {});
    t('正文空着：不埋', b.treasureLetters().length === n0 && empty.includes('TREASURE_MISS:empty'));
    const two = b.treasureProcessTags('[[HIDE_LETTER: 图书馆 | 只有两段的正文]]', null, KURO, {});
    t('只有两段：不埋，也不把第二段当标题露出来', b.treasureLetters().length === n0 && two.includes('TREASURE_MISS:format') && !two.includes('只有两段的正文'), two);
    const many = b.treasureProcessTags([1, 2, 3, 4].map(i => `[[HIDE_LETTER: 图书馆 | 第${i}张 | 正文${i}]]`).join('\n'), null, KURO, {});
    t('一条回复最多埋 3 张', b.treasureLetters().length === n0 + 3 && many.includes('TREASURE_MISS:limit') && !many.includes('正文4'), many);

    // 两个地点名都包含输入 → 认不出是哪个，不埋
    const amb = withPlaces(sandbox());
    amb.treasureAddPlace('公园门口咖啡店', 30.25, 120.12);
    amb.treasureProcessTags('[[HIDE_LETTER: 公园 | 模糊 | 正文]]', null, KURO, {});
    t('模糊地点对上好几处：不埋', amb.treasureLetters().length === 0);

    const off = withPlaces(sandbox({ skillsOff: { treasure: true } }));
    const o = off.treasureProcessTags(`嗯[[HIDE_LETTER: 公园门口 | 关着 | ${BODY}]]`, null, KURO, {});
    t('技能关着：指令连正文一起抹掉、不埋', o === '嗯' && off.treasureLetters().length === 0, o);
  }

  console.log('\n[4] 回复被掐断（停止/断线）');
  {
    const b = withPlaces(sandbox());
    const out = b.treasureProcessTags(`写给你\n[[HIDE_LETTER: 公园门口 | 半截 | ${BODY.slice(0, 12)}`, null, KURO, {});
    t('★ 半截指令连正文一起遮掉', !out.includes(BODY.slice(0, 12)) && out.includes('TREASURE_MISS:cut'), out);
    t('半截的不埋', b.treasureLetters().length === 0);
    t('前面的话还在', out.startsWith('写给你'));
    const both = b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | 完整 | 第一张]]\n[[HIDE_LETTER: 图书馆 | 断了 | 第二张写到`, null, KURO, {});
    t('完整的照埋、后面断掉的遮住', b.treasureLetters().length === 1 && !both.includes('第二张写到') && both.includes('TREASURE_MISS:cut'), both);
  }

  console.log('\n[5] blocks 路径：认领同一批结果，不再埋第二次');
  {
    const b = withPlaces(sandbox());
    const ctx = {};
    const raw1 = `好\n[[HIDE_LETTER: 公园门口 | 第一张 | ${BODY}]]`;
    const raw2 = '[[HIDE_LETTER: 图书馆 | 第二张 | 书架第三排]]';
    const content = b.treasureProcessTags(raw1 + '\n' + raw2, null, KURO, ctx);
    const n = b.treasureLetters().length;
    const saved = b.store.gc_treasure_v1;
    const blocks = [
      { type: 'thinking', text: `我打算写 [[HIDE_LETTER: 公园门口 | 第一张 | ${BODY}]] 给她` },
      { type: 'text', text: raw1 },
      { type: 'tool_use', text: '[[HIDE_LETTER: x | y | z]]' },
      { type: 'text', text: raw2 },
    ];
    b._applyTreasureToBlocks(blocks, ctx);
    t('blocks 里换成和 content 一样的短标签', blocks[1].text.includes('[[TREASURE_HID:') && blocks[3].text.includes('[[TREASURE_HID:'), blocks);
    t('两条路结果一致', content.replace(/\s+/g, '') === (blocks[1].text + blocks[3].text).replace(/\s+/g, ''), [content, blocks[1].text, blocks[3].text]);
    t('★ text 块里没有正文', !blocks[1].text.includes(BODY) && !blocks[3].text.includes('书架第三排'));
    t('★ thinking 里抄的那遍也盖住了（不执行）', !blocks[0].text.includes(BODY) && blocks[0].text.includes('正文藏起来了'), blocks[0].text);
    t('别的类型的块不碰', blocks[2].text === '[[HIDE_LETTER: x | y | z]]');
    t('没有再埋一次（张数、缓存都没动）', b.treasureLetters().length === n && b.store.gc_treasure_v1 === saved);
    // 掐断的那条也走 blocks
    const ctx2 = {};
    const cutRaw = '[[HIDE_LETTER: 图书馆 | 断 | 写到一半的秘';
    b.treasureProcessTags(cutRaw, null, KURO, ctx2);
    const bl2 = [{ type: 'text', text: cutRaw }];
    b._applyTreasureToBlocks(bl2, ctx2);
    t('掐断的半截在 blocks 里也遮住', !bl2[0].text.includes('写到一半的秘') && bl2[0].text.includes('TREASURE_MISS:cut'), bl2[0].text);
  }

  console.log('\n[6] 流式遮挡');
  {
    const b = sandbox();
    t('写完的遮住', b.maskStreamingTreasure(`嗯[[HIDE_LETTER: 公园门口 | 标题 | ${BODY}]]后面`) === '嗯〔🎁 埋纸条…〕后面');
    t('★ 正文写到一半也遮住', b.maskStreamingTreasure(`嗯[[HIDE_LETTER: 公园门口 | 标题 | ${BODY.slice(0, 9)}`) === '嗯〔🎁 埋纸条…〕');
    t('标签名还没写全也遮住', b.maskStreamingTreasure('嗯[[HIDE_LE') === '嗯〔🎁 埋纸条…〕');
    const stored = '嗯\n[[TREASURE_HID:0f0e0d0c-0b0a-4908-8706-050403020100|公园门口|标题|克克]]\n后面的话';
    t('存储短标签不当成没写完的指令（不吞后文）', b.maskStreamingTreasure(stored) === stored);
    t('遮罩进了总表', b._STREAM_MASKS.includes('maskStreamingTreasure'));
    const names = b._STREAM_MASKS;
    t('插在中间、没插末尾（末尾会打断锚着结尾的注入）', names.indexOf('maskStreamingTreasure') > 0 && names[names.length - 1] !== 'maskStreamingTreasure');
  }

  console.log('\n[7] 渲染：卡片上没有正文');
  {
    const b = withPlaces(sandbox());
    const content = b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | 散步<b>路上</b> | ${BODY}]]`, null, KURO, {});
    const id = b.treasureLetters()[0].id;
    const html = b.treasureTagToHtml(content);
    t('卡片：「AI在「公园门口」埋了一张纸条」+ 标题', html.includes('克克在「公园门口」埋了一张纸条') && html.includes('treasure-card-t'), html);
    t('★ 卡片里没有正文', !html.includes(BODY) && !html.includes('只给你一个人看'));
    t('标题转义了', html.includes('散步&lt;b&gt;路上&lt;/b&gt;') && !html.includes('<b>路上'), html);
    t('还埋着的卡片写着走到附近会响', html.includes('还埋着'));
    t('卡片按钮只调 treasureCardTap(字面量 id)：过得了渲染消毒，也不撞拒绝名单',
      html.includes(`onclick="treasureCardTap('${id}')"`) && !/^(delete|remove|clear|wipe|reset|import|restore|open)\w*$/.test('treasureCardTap'));
    await b._treasureOpenIn(id, 0);
    const html2 = b.treasureTagToHtml(content);
    t('找到之后卡片状态变成「你 X 月 X 日找到了」', /你 \d+月\d+日找到了/.test(html2), html2);
    t('找到之后卡片上也不放正文（要看点进去）', !html2.includes(BODY));
    const raw = b.treasureTagToHtml(`老消息 [[HIDE_LETTER: 公园门口 | 标题 | ${BODY}]] 后面`);
    t('★ 兜底：漏到渲染的裸指令只画占位，不画正文', !raw.includes(BODY) && raw.includes('正文藏起来了') && raw.includes('后面'), raw);
    t('兜底：半截裸指令也一样', !b.treasureTagToHtml(`[[HIDE_LETTER: 公园门口 | t | ${BODY}`).includes(BODY));
    const unknown = b.treasureTagToHtml('[[TREASURE_HID:11111111-2222-4333-8444-555555555555|公园门口|别的设备埋的|克克]]');
    t('本机还没同步到的纸条：卡片照样画（埋好了）', unknown.includes('别的设备埋的') && unknown.includes('埋好了'));
    const evil = b.treasureTagToHtml('[[TREASURE_MISS:noplace|"><img src=x onerror=alert(1)>|t]]');
    t('失败卡片里的地点名也转义', !evil.includes('<img src=x'), evil);
  }

  console.log('\n[8] 回填历史：咬回正牌指令（带正文，它要记得自己写了什么）');
  {
    const b = withPlaces(sandbox());
    const content = b.treasureProcessTags(`好\n[[HIDE_LETTER: 公园门口 | 散步路上 | ${BODY}]]\n[[HIDE_LETTER: 月球 | 到不了 | x]]`, null, KURO, {});
    const back = b.stickerTagForApi(content);
    t('咬回 [[HIDE_LETTER: 地点 | 标题 | 正文]]', back.includes(`[[HIDE_LETTER: 公园门口 | 散步路上 | ${BODY}]]`), back);
    t('带上「还埋着」', back.includes('还埋着'));
    t('没埋成的写成一句话（不是指令，免得它照抄又埋一次）', back.includes('没埋成：地图上没有这个地点') && !/\[\[HIDE_LETTER: 月球/.test(back), back);
    t('回填里不留存储短标签', !/TREASURE_(HID|MISS)/.test(back));
    await b._treasureOpenIn(b.treasureLetters()[0].id, 0);
    t('找到之后回填带上「她 X 找到了」', /她 \d+月\d+日找到了/.test(b.stickerTagForApi(content)));
    // 模型照着历史原样抄一遍：是真指令，会再埋一张（这是对的——它确实又写了一次）
    const again = b.treasureProcessTags(back.match(/\[\[HIDE_LETTER:[^\]]+\]\]/)[0], null, KURO, {});
    t('照抄回填的写法解析得了', again.includes('[[TREASURE_HID:'), again);
    const noBody = sandbox().treasureTagForApi('[[TREASURE_HID:11111111-2222-4333-8444-555555555555|公园门口|标题|克克]]');
    t('本机没有那张的正文：写成一句话，不编一个空正文的指令', !noBody.includes('[[HIDE_LETTER') && noBody.includes('正文这台设备上没读到'), noBody);
  }

  console.log('\n[9] 系统提示');
  {
    const none = sandbox({ noStorage: true });
    const p0 = none.treasurePromptFor(KURO);
    t('说明进 stable', p0.stable.includes('[[HIDE_LETTER:') && p0.volatile === '');
    t('没标地点时说清楚现在埋不了', p0.stable.includes('还没标地点'));
    const b = withPlaces(sandbox());
    b.treasureProcessTags('[[HIDE_LETTER: 公园门口 | 第一张 | 秘密甲]][[HIDE_LETTER: 公园门口 | 第二张 | 秘密乙]]', null, KURO, {});
    b.treasureProcessTags('[[HIDE_LETTER: 图书馆 | 书里夹着的 | 秘密丙]]', null, KURO, {});
    await b._treasureOpenIn(b.treasureLetters().find(l => l.place === '图书馆').id, 0);
    const p = b.treasurePromptFor(KURO).stable;
    t('列出地点和每处还埋着几张', p.includes('公园门口（还埋着 2 张）') && /图书馆(?!（还埋着)/.test(p), p);
    t('★ 不给坐标', !/39\.99|116\.31|\d+\.\d{3,}/.test(p), p);
    t('最近找到的标题进提示', p.includes('「书里夹着的」'));
    t('★ 正文不进提示（找没找到都不进）', !/秘密[甲乙丙]/.test(p), p);
    const off = withPlaces(sandbox({ skillsOff: { treasure: true } }));
    t('技能关着一个字都不进', off.treasurePromptFor(KURO).stable === '');
  }

  console.log('\n[10] 打开纸条：找到之前打不开；默认靠「我到这儿了」打卡');
  {
    const b = withPlaces(sandbox());
    b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | 第一张 | ${BODY}]]`, null, KURO, {});
    b.treasureProcessTags('[[HIDE_LETTER: 公园门口 | 第二张 | 第二张的话]]', null, KURO, {});
    b.treasureProcessTags('[[HIDE_LETTER: 图书馆 | 别处的 | 别处的话]]', null, KURO, {});
    const [l1, l2] = b.treasureLetters();
    const id = l1.id;
    t('没打卡、也不是点通知进来的：打不开', b.treasureOpenLetter(id) === false && l1.found_at === null);
    t('打不开时信纸层是空的（DOM 里没有正文）', !b.dom.els.treasureLetter.innerHTML.includes(BODY));
    t("字符串冒充打卡也不行（treasureOpenLetter(id,'checkin')）", b.treasureOpenLetter(id, 'checkin') === false && !l1.found_at);
    b.openTreasure();
    b.treasureCardTap(id);   // 聊天卡片点进来：开着「还埋着」的抽屉，抽屉上有「我到这儿了」
    t('还埋着的抽屉上有「我到这儿了」', b.dom.els.treasureSheet.innerHTML.includes("treasureCheckIn('" + id + "')"));
    const placeA = b.treasurePlaces().find(p => p.place === '公园门口');
    t('打卡：这一处埋着 2 张', b.treasureCheckIn(placeA.id) === 2);
    t('开信时把「还埋着」的抽屉收掉', b.dom.els.treasureSheet.classList.contains('hidden'));
    t('先拆最早埋的那张、写 found_at', !!l1.found_at && !isNaN(Date.parse(l1.found_at)) && !l2.found_at);
    t('found_at 记成待上云的改动', l1._dirty === 'new' || (l1._dirty === 'patch' && l1._patch && l1._patch.found_at === l1.found_at));
    t('信纸上有正文了', b.dom.els.treasureLetter.innerHTML.includes(esc(BODY)));
    b.treasureCloseLetter();
    t('收好一张，接着拆这处的下一张', !!l2.found_at && b.dom.els.treasureLetter.innerHTML.includes('第二张的话'));
    b.treasureCloseLetter();
    t('别处的不跟着拆', !b.treasureLetters().find(l => l.place === '图书馆').found_at && b.dom.els.treasureLetter.classList.contains('hidden'));
    b._trOpenSheet({ kind: 'place', id: placeA.id });
    t('这处拆完了：小旗上不再有「我到这儿了」', !b.dom.els.treasureSheet.innerHTML.includes('treasureCheckIn'));
    // 拨回一个旧时间再开：同一毫秒里连开两次的话「改了」和「没改」看起来一样
    const at = '2026-01-01T00:00:00.000Z';
    l1.found_at = at;
    b.treasureOpenLetter(id);
    t('再打开不改 found_at（第一次找到的时间只有一次）', l1.found_at === at);
    t('找到的列表里有它们', b.treasureFoundList().length === 2 && b.treasureBuried().length === 1);
  }

  console.log('\n[11] DOM 里不出现还埋着的正文（地图抽屉、列表、汇总）');
  {
    const b = withPlaces(sandbox());
    b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | 露得出来的标题 | ${BODY}]]`, null, KURO, {});
    const id = b.treasureLetters()[0].id;
    b.openTreasure();
    b.treasureCardTap(id);          // 聊天卡片点进来：还埋着 → 只开抽屉
    const dump = () => Object.values(b.dom.els).map(e => e.innerHTML + e.textContent).join('\n');
    const withSheet = dump();
    t('抽屉里能看到标题和「还埋着」', b.dom.els.treasureSheet.innerHTML.includes('露得出来的标题') && b.dom.els.treasureSheet.innerHTML.includes('还埋着'));
    b.treasureTab('found');
    const withList = dump();
    b.treasureTab('map');
    const all = withSheet + withList + dump();
    t('★ 打开面板、点卡片、切列表之后，DOM 里没有正文', !all.includes(BODY) && !all.includes(esc(BODY)), all.slice(0, 400));
    t('切页签时把抽屉收掉', b.dom.els.treasureSheet.classList.contains('hidden'));
  }

  console.log('\n[12] 原生桥（开了定位提醒）：setLetters 不含 body；点通知进来能开');
  {
    const calls = [];
    let pending = '';
    const native = {
      available: () => true,
      status: () => JSON.stringify({ fine: true, background: false, notify: true, locationOn: true }),
      requestPermissions() { calls.push(['perm']); },
      locate(cb) { calls.push(['locate', cb]); },
      setLetters(json) { calls.push(['set', json]); },
      takePending() { const p = pending; pending = ''; return p; },
    };
    const b = withPlaces(sandbox({ native }));
    t('页面挂上了 _treasureOpen / _treasureNative 给原生调', typeof b.window._treasureOpen === 'function' && typeof b.window._treasureNative === 'function');
    // 开定位提醒：先出说明（谷歌那边也可能读到位置），点了「知道了，开」才开
    b.openTreasure();
    b.treasureGeoToggle();
    t('开之前先出说明：开了手机定位谷歌也可能读到位置', b.dom.els.treasureSheet.innerHTML.includes('谷歌') && !b.treasureGeoOn());
    calls.length = 0;
    b.treasureGeoToggle(true);
    t('点了才开；接着讲权限（还是先给解释，不直接弹）', b.treasureGeoOn() && b.dom.els.treasureSheet.innerHTML.includes('始终允许') && !calls.some(c => c[0] === 'perm'));
    b.treasureAskPerms(true);
    t('点「好，去开」才调 requestPermissions', calls.some(c => c[0] === 'perm'));
    t('开着时「我在这」按钮出现', !b.dom.els.treasureMeBtn.classList.contains('hidden'));
    calls.length = 0;
    b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | 标题 | ${BODY}]]`, null, KURO, {});
    const sets = calls.filter(c => c[0] === 'set');
    t('埋下之后马上 setLetters 给原生', sets.length >= 1);
    const last = JSON.parse(sets[sets.length - 1][1]);
    t('★ setLetters 的每一项都不含 body', last.length === 1 && last.every(x => !('body' in x)) && !sets[sets.length - 1][1].includes(BODY), last);
    t('setLetters 字段照契约：id/lat/lng/radius_m/title/place',
      JSON.stringify(Object.keys(last[0]).sort()) === JSON.stringify(['id', 'lat', 'lng', 'place', 'radius_m', 'title']), Object.keys(last[0]));
    t('传给原生的坐标是 WGS-84 原样（不是转过的 GCJ）', last[0].lat === PLACE_A.lat && last[0].lng === PLACE_A.lng);
    // 冷启动：点通知进来
    const id = last[0].id;
    pending = id;
    calls.length = 0;
    b.treasureBoot();
    await new Promise(r => setTimeout(r, 450));
    t('冷启动问了 takePending，并打开了那张（写了 found_at）', !!b.treasureLetters()[0].found_at);
    const after = calls.filter(c => c[0] === 'set').pop();
    t('找到之后 setLetters 把它撤掉（传 []）', after && after[1] === '[]', after);
    b.treasureCloseLetter();
    // 热启动：页面开着时点通知
    b.treasureProcessTags('[[HIDE_LETTER: 图书馆 | 第二张 | 书架]]', null, KURO, {});
    const id2 = b.treasureLetters().find(l => l.place === '图书馆').id;
    const ok = await b.window._treasureOpen(id2);
    t('_treasureOpen(id) 直接打开', ok === true && !!b.treasureLetters().find(l => l.id === id2).found_at);
    t('_treasureOpen 不认得的 id 不开、不崩', (await b.window._treasureOpen('not-an-id')) === false);
    // 我在这：手机走原生精确定位；拿到的坐标只挪地图，不存
    calls.length = 0;
    b.treasureLocateMe();
    t('「我在这」在手机上走 GrancyanTreasure.locate(cbId)', calls.some(c => c[0] === 'locate' && /^tr\d+$/.test(c[1])));
    const before = JSON.stringify(b.store) + JSON.stringify(b._tr.rows);
    b._treasureNativeIn('loc', JSON.stringify({ cbId: 'tr1', lat: 39.12345, lng: 116.54321, acc: 8 }));
    t('★ 定位拿到的坐标不进缓存、不进任何一行', JSON.stringify(b.store) + JSON.stringify(b._tr.rows) === before && !/39\.12345|116\.54321/.test(JSON.stringify(b.store)));
    b.treasureRender();
    t('权限缺后台定位：面板上提示还差什么', b.dom.els.treasurePerm.innerHTML.includes('后台定位'));
    // 关掉：原生那边立刻撤干净
    calls.length = 0;
    b.treasureGeoToggle();
    t('关掉定位提醒：setLetters([]) 撤干净、「我在这」藏起来', !b.treasureGeoOn() && calls.some(c => c[0] === 'set' && c[1] === '[]') && b.dom.els.treasureMeBtn.classList.contains('hidden'));
    // 桌面：没有原生桥，处处判空
    const d = withPlaces(sandbox());
    t('桌面没有原生桥：setLetters 静默跳过', d.treasureSyncNative() === false);
    d.openTreasure();
    t('桌面没有原生桥：权限那行不显示', d.dom.els.treasurePerm.classList.contains('hidden'));
  }

  console.log('\n[12b] ★★ 默认（定位提醒关着）：整个文件的执行路径一次定位都不碰');
  {
    const calls = [];
    let pending = '';
    const native = {
      available: () => true,
      status() { calls.push(['status']); return '{}'; },
      requestPermissions() { calls.push(['perm']); },
      locate(cb) { calls.push(['locate', cb]); },
      setLetters(json) { calls.push(['set', json]); },
      takePending() { const p = pending; pending = ''; return p; },
    };
    const geoCalls = [];
    const b = sandbox({ native });
    b.navigator = { geolocation: {
      getCurrentPosition() { geoCalls.push('get'); }, watchPosition() { geoCalls.push('watch'); }, clearWatch() {},
    } };
    t('默认是关着的', b.treasureGeoOn() === false);
    b.treasureBoot();
    t('启动就 setLetters([])，把原生那边以前挂上的提醒撤干净', calls.some(c => c[0] === 'set' && c[1] === '[]'));
    withPlaces(b);
    // 把能点的都点一遍
    b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | 标题 | ${BODY}]]`, null, KURO, {});
    const id = b.treasureLetters()[0].id;
    b.openTreasure(); b.treasureRender(); b.treasureTab('found'); b.treasureTab('map');
    b.treasureCardTap(id);
    b.treasureLocateMe();
    b.treasureAskPerms(); b.treasureAskPerms(true);
    b._treasureNativeIn('loc', JSON.stringify({ cbId: 'x', lat: 39.1, lng: 116.1, acc: 5 }));
    b._treasureNativeIn('perm', '{}');
    b.treasureCheckIn(b.treasurePlaces()[0].id); b.treasureCloseLetter();
    b.treasurePromptFor(KURO); b.treasureTagToHtml('x'); b.treasureSyncNative();
    b.treasureProcessTags('[[HIDE_LETTER: 图书馆 | 第二张 | 书架]]', null, KURO, {});
    await b.window._treasureOpen(b.treasureLetters().find(l => l.place === '图书馆').id, 0);
    await new Promise(r => setTimeout(r, 50));
    t('★★ 没调 GrancyanTreasure.locate', !calls.some(c => c[0] === 'locate'), calls);
    t('★★ 没调 GrancyanTreasure.requestPermissions', !calls.some(c => c[0] === 'perm'));
    t('★★ 没调 navigator.geolocation', geoCalls.length === 0, geoCalls);
    t('连权限状态都没去问', !calls.some(c => c[0] === 'status'));
    t('★ 交给原生的永远是 []（埋了也不挂提醒）', calls.filter(c => c[0] === 'set').every(c => c[1] === '[]'));
    t('「我在这」按钮不出现', b.dom.els.treasureMeBtn.classList.contains('hidden'));
    t('设置那一行写着「定位提醒（要开手机定位）」、关着', b.dom.els.treasureGeo.innerHTML.includes('定位提醒（要开手机定位）') && b.dom.els.treasureGeo.innerHTML.includes('关着'));
    const srcLF = src.replace(/\r\n/g, '\n');
    t('源码里所有 locate / requestPermissions / geolocation 调用都在开关后面（就这三处）',
      /function treasureLocateMe\(\) \{\n  if \(!treasureGeoOn\(\)\) return false;/.test(srcLF)
      && /function treasureAskPerms\(go\) \{\n  if \(!treasureGeoOn\(\)\) return;/.test(srcLF)
      && (srcLF.match(/\.locate\(|\.requestPermissions\(|navigator\.geolocation\.\w+\(/g) || []).length === 3,
      srcLF.match(/\.locate\(|\.requestPermissions\(|navigator\.geolocation\.\w+\(/g));
  }

  console.log('\n[13] 云端（mock supabaseClient）');
  {
    const log = [];
    let serverRows = [];
    let failWith = null;
    const q = (table) => {
      const chain = {
        select() { return chain; }, is() { return chain; },
        order() { log.push(['select', table]); return Promise.resolve(failWith ? { data: null, error: failWith } : { data: serverRows.slice(), error: null }); },
        upsert(row, opt) { row = JSON.parse(JSON.stringify(row)); log.push(['upsert', row, opt]); if (!failWith) serverRows.push(row); return Promise.resolve({ error: failWith }); },
        update(patch) { return { eq(k, v) { log.push(['update', patch, k, v]); return Promise.resolve({ error: failWith }); } }; },
      };
      return chain;
    };
    const supa = { from: q };
    // 表还没建：PostgREST 报 PGRST205
    failWith = { code: 'PGRST205', message: "Could not find the table 'public.letters' in the schema cache" };
    const b = sandbox({ supabase: supa });
    b.treasureAddPlace('公园门口', PLACE_A.lat, PLACE_A.lng);
    await new Promise(r => setTimeout(r, 20));
    const st = await b.treasureRefresh();
    t('表还没建：判成「还没开张」，不抛', st === 'closed', st);
    t('还没开张：本机标的地点还在', b.treasurePlaces().length === 1 && b.treasurePlaces()[0]._dirty === 'new');
    b.openTreasure();
    t('还没开张：面板上说一句，不白屏', b.dom.els.treasureCloud.textContent.includes('还没开张') && !b.dom.els.treasureCloud.classList.contains('hidden'));
    await new Promise(r => setTimeout(r, 20));   // openTreasure 自己也拉了一次，等它落地，别让下面共用到它
    // 断网
    failWith = { message: 'TypeError: Failed to fetch' };
    const stOff = await b.treasureRefresh();
    t('断网判成 offline', stOff === 'offline', stOff);
    // 表建好了：本机没上云的补写上去
    failWith = null;
    log.length = 0;
    const st2 = await b.treasureRefresh();
    t('表建好之后：ok', st2 === 'ok', st2);
    const ups = log.filter(l => l[0] === 'upsert');
    t('本机没上云的地点补写上去了（按 id upsert）', ups.length === 1 && ups[0][1].place === '公园门口' && ups[0][2] && ups[0][2].onConflict === 'id', ups);
    t('上云的行不带本机字段（_dirty/_patch）', ups.length && !('_dirty' in ups[0][1]) && !('_patch' in ups[0][1]));
    t('写上去之后不再是待写', !b.treasurePlaces()[0]._dirty);
    // 服务器上有一张别处（AI从电脑那头）埋的
    serverRows.push({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'letter', place: '公园门口', lat: PLACE_A.lat, lng: PLACE_A.lng, radius_m: 150,
      title: 'CC 埋的', body: '从电脑那头', hidden_by: 'cc', created_at: new Date().toISOString(), found_at: null, deleted_at: null });
    await b.treasureRefresh();
    t('拉下来别处埋的纸条', b.treasureBuried().some(l => l.hidden_by === 'cc'));
    // 打开 → 改 found_at 走 update
    log.length = 0;
    await b._treasureOpenIn('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 0);
    await new Promise(r => setTimeout(r, 20));
    const upd = log.filter(l => l[0] === 'update');
    t('找到时只 update found_at（eq id）', upd.length === 1 && Object.keys(upd[0][1]).join() === 'found_at' && upd[0][3] === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', upd);
    // 本机有、云端没有、也不是待写的 → 别的账号的残留，丢掉
    b._tr.rows.push({ id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'place', place: '旧账号的', lat: 1, lng: 1, radius_m: 150 });
    await b.treasureRefresh();
    t('云端没有的旧行（不是待写的）被清掉', !b.treasurePlaces().some(p => p.place === '旧账号的'));
    // 没登录
    const nl = sandbox();
    t('没登录：nologin，不发请求', (await nl.treasureRefresh()) === 'nologin');
  }

  console.log('\n[13b] 正文里夹着别的 [[…]]、伪造的短标签、开关关着的 blocks');
  {
    const b = withPlaces(sandbox());
    const body = '抱抱你[[STICKER:抱抱]]明天见，记得带伞';
    const ctx = {};
    const raw = `嗯\n[[HIDE_LETTER: 公园门口 | 带伞 | ${body}]]\n后面的话`;
    const out = b.treasureProcessTags(raw, null, KURO, ctx);
    const l = b.treasureLetters()[0];
    t('★ 正文里夹着 [[STICKER:…]]：整条认对，正文完整（按层数配对，不在第一个 ]] 收尾）', l && l.body === body, l && l.body);
    t('★ 后半截正文没露在消息里', !out.includes('明天见') && !out.includes('记得带伞') && out.trim().endsWith('后面的话'), out);
    const bl = [{ type: 'text', text: raw }];
    b._applyTreasureToBlocks(bl, ctx);
    t('blocks 里也一样，没留尾巴', !bl[0].text.includes('明天见') && bl[0].text.includes('[[TREASURE_HID:'), bl[0].text);
    t('流式遮罩同样按层数配对', b.maskStreamingTreasure(raw) === '嗯\n〔🎁 埋纸条…〕\n后面的话', b.maskStreamingTreasure(raw));
    t('兜底遮罩同样按层数配对', !b.treasureVeil(raw).includes('明天见'));
    t('信纸上把正文里的 [[STICKER:抱抱]] 画成〔抱抱〕，不露方括号', b._trLetterText(body) === '抱抱你〔抱抱〕明天见，记得带伞');
    t('写到正文里的 [[STICKER: 还没收口也算没写完', !b.maskStreamingTreasure('[[HIDE_LETTER: 公园门口 | t | 抱抱[[STICKER:抱抱]] 还有').includes('还有'));

    const forged = b.treasureProcessTags('埋好了[[TREASURE_HID:11111111-2222-4333-8444-555555555555|公园门口|假的|克克]][[TREASURE_MISS:noplace|x|y]]', null, KURO, {});
    t('模型自己写的存储短标签不认（不能假装埋好了）', forged === '埋好了', forged);
    const fb = [{ type: 'text', text: '埋好了[[TREASURE_HID:11111111-2222-4333-8444-555555555555|公园门口|假的|克克]]' }];
    b._applyTreasureToBlocks(fb, {});
    t('blocks 里伪造的也拿掉', fb[0].text === '埋好了', fb[0].text);

    const off = withPlaces(sandbox({ skillsOff: { treasure: true } }));
    const octx = {};
    const oraw = `嗯[[HIDE_LETTER: 公园门口 | 关着 | ${BODY}]]`;
    const oc = off.treasureProcessTags(oraw, null, KURO, octx);
    const ob = [{ type: 'text', text: oraw }];
    off._applyTreasureToBlocks(ob, octx);
    t('技能关着：blocks 和 content 说法一致（都抹掉，不画「没埋成」）', ob[0].text === oc && oc === '嗯', [oc, ob[0].text]);

    const node = { content: `x[[HIDE_LETTER: 公园门口 | t | ${BODY}`, reasoning: `想写 [[HIDE_LETTER: 公园门口 | t | ${BODY}]]`,
      blocks: [{ type: 'thinking', text: `[[HIDE_LETTER: a | b | ${BODY}]]` }, { type: 'text', text: `[[HIDE_LETTER: a | b | ${BODY}]]` }] };
    const n0 = b.treasureLetters().length;
    b.treasureVeilNode(node);
    t('★ 出错/找回那几条路：整个节点（content/reasoning/blocks）只遮不埋', !JSON.stringify(node).includes(BODY) && b.treasureLetters().length === n0);
    const live = { content: `[[HIDE_LETTER: a | b | ${BODY}`, reasoning: '', blocks: [{ type: 'text', text: `[[HIDE_LETTER: a | b | ${BODY}` }] };
    b.treasureVeilNode(live, true);
    t('流式回调里只换字符串，不动流还在追加的 blocks', !live.content.includes(BODY) && live.blocks[0].text.includes(BODY));
  }

  console.log('\n[13c] 找到之前打不开：字符串冒充「点通知进来」不行');
  {
    const b = withPlaces(sandbox());
    b.treasureProcessTags(`[[HIDE_LETTER: 公园门口 | t | ${BODY}]]`, null, KURO, {});
    const id = b.treasureLetters()[0].id;
    t("聊天 HTML 里写 treasureOpenLetter(id,'notify') 打不开（只认模块私有的对象）", b.treasureOpenLetter(id, 'notify') === false && !b.treasureLetters()[0].found_at);
    // 点通知进来，但本机还没这张：等它同步过来再开（pending 只给一次，不能丢）
    const later = sandbox();
    const p = later._treasureOpenIn('99999999-2222-4333-8444-555555555555', 4000);
    await new Promise(r => setTimeout(r, 200));
    later._tr.rows.push({ id: '99999999-2222-4333-8444-555555555555', kind: 'letter', place: '公园门口', lat: 1, lng: 1, radius_m: 150,
      title: '晚到的', body: '正文', hidden_by: 'cc', created_at: new Date().toISOString(), found_at: null, deleted_at: null });
    t('★ 本机还没有那张：等到同步过来再打开（不是提示一句就丢了）', (await p) === true && !!later._tr.rows[0].found_at);
    t('等不到就放弃、不崩', (await sandbox()._treasureOpenIn('88888888-2222-4333-8444-555555555555', 0)) === false);
  }

  console.log('\n[13d] 云端合并的时序');
  {
    // select 在路上时本机新埋了一张、而且自己的 flush 先写成功了：快照里没有它，也不能丢
    let release;
    const gate = new Promise(r => { release = r; });
    const rows = [];
    const supa = { from: () => {
      const c = {
        select() { return c; }, is() { return c; },
        order() { const snap = rows.slice(); return gate.then(() => ({ data: snap, error: null })); },
        upsert(row) { rows.push(JSON.parse(JSON.stringify(row))); return Promise.resolve({ error: null }); },
        update() { return { eq: () => Promise.resolve({ error: null }) }; },
      };
      return c;
    } };
    const b = sandbox({ supabase: supa });
    const pr = b.treasureRefresh();
    await new Promise(r => setTimeout(r, 5));
    b.treasureAddPlace('公园门口', PLACE_A.lat, PLACE_A.lng);
    await new Promise(r => setTimeout(r, 5));
    release();
    await pr;
    t('★ refresh 在路上时新标的地点：快照里没有也不丢', b.treasurePlaces().length === 1, b._tr.rows);
    // 请求在路上时又改了：flush 回来不能把新改动的待写标记清掉
    const holds = [];
    const hold = () => holds.shift()();   // 只放行最早那一个请求，第二个还压着
    const slow = { from: () => ({ update() { return { eq: () => new Promise(r => { holds.push(() => r({ error: null })); }) }; }, upsert: () => Promise.resolve({ error: null }) }) };
    const c = sandbox({ supabase: slow });
    c._tr.rows.push({ id: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'letter', place: 'x', lat: 1, lng: 1, radius_m: 150, title: 't', body: 'b', found_at: null, deleted_at: null });
    c._tr.cloud = 'ok';
    c._trPatch('dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', { found_at: '2026-10-12T00:00:00.000Z' });
    await new Promise(r => setTimeout(r, 5));
    c._trPatch('dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', { deleted_at: '2026-10-12T01:00:00.000Z' });
    hold();
    await new Promise(r => setTimeout(r, 10));
    const r0 = c._tr.rows[0];
    t('★ 写的途中又改过：回来不清待写标记，第二处改动留着下回写', r0._dirty === 'patch' && r0._patch && r0._patch.deleted_at, r0);
  }

  console.log('\n[14] 接线');
  {
    const memjs = readLF('js/04-memory.js');
    const render = read('js/12-math-media.js');
    const grp = read('js/06-render-msg.js');
    const html = read('index.html');
    const css = read('css/grancyan.css');
    t('processAiCommands 调了 treasureProcessTags', /treasureProcessTags\(text, chat, conf, studyCtx\)/.test(memjs));
    const pac = memjs.slice(memjs.indexOf('function processAiCommands('));
    t('★ 而且是最先做的（紧跟 normalizeStickerTags，正文不会先被别的指令处理器碰到）',
      /text = normalizeStickerTags\(text\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(typeof treasureProcessTags === 'function'\)/.test(pac));
    t('三处 blocks 收尾都认领了（单聊、重新生成、群聊）',
      (api.match(/_applyTreasureToBlocks\(blocks, studyCtx\)/g) || []).length === 2 && /_applyTreasureToBlocks\(blocks, studyCtx\)/.test(grp));
    t('渲染层挂了', /treasureTagToHtml\(text\)/.test(render));
    t('legacy 思考链也盖住', /treasureVeil\(reasoning\)/.test(grp));
    t('回填链挂了', /treasureTagForApi\(cooked\)/.test(api));
    t('系统提示挂了', /treasurePromptFor\(conf\)/.test(api));
    t('技能开关里有藏宝地图', /key: 'treasure'/.test(api));
    t('index.html 加载了 68-treasure.js', html.includes('<script src="./js/68-treasure.js"></script>'));
    const shelf = html.slice(html.indexOf('<span>我们的小日子</span>'), html.indexOf('<span>一起玩</span>'));
    t('入口挂在我们的小日子那排（openWidget(openTreasure)）', shelf.includes('openWidget(openTreasure)'));
    t('面板容器在', ['treasureModal', 'treasureMap', 'treasureSheet', 'treasureLetter', 'treasureFound'].every(id => html.includes(`id="${id}"`)));
    t('Leaflet 1.9.4 本地带在 js/lib（钉版本）', /version="1\.9\.4"/.test(read('js/lib/leaflet.min.js')) && fs.existsSync(path.join(ROOT, 'js/lib/leaflet.min.css')));
    t('不走 CDN 拉 Leaflet', !/unpkg|cdnjs|jsdelivr/.test(src) && !/leaflet[^"']*\.js["'][^>]*>/.test(html.replace('./js/lib/leaflet.min.js', '')) && src.includes("'./js/lib/leaflet.min.js'"));
    t('Leaflet 用不到 png 图标（divIcon），没带 images/', !fs.existsSync(path.join(ROOT, 'js/lib/images')) && /L\.divIcon/.test(src) && !/L\.icon\(|new L\.Icon/.test(src));
    t('底图是高德 webrd0{s}（style=8）', src.includes("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}") && /subdomains: '1234'/.test(src));
    t('米纸不翻藏宝地图（gen-light-patch 的 SKIP）', /\\\.treasure-/.test(read('scripts/gen-light-patch.js')) && !read('css/light-patch.css').includes('treasure-'));
    t('自带深色样式', /\.treasure-panel \{[^}]*background:#1/.test(css));
    t('速查表里有这条指令', html.includes('<code>[[HIDE_LETTER: 地点 | 标题 | 正文]]</code>'));
    t('★ blocks 收尾三处都是藏宝排第一个（正文先摘走，别的处理器碰不到）',
      (api.match(/_applyTreasureToBlocks\(blocks, studyCtx\);\r?\n\s*if \(typeof _applyWishToBlocks/g) || []).length === 2
      && /_applyTreasureToBlocks\(blocks, studyCtx\);\r?\n\s*if \(typeof _applyWishToBlocks/.test(grp));
    t('出错 / 找回 / 流式回调这些不走 processAiCommands 的路都过了 treasureVeilNode',
      (api.match(/treasureVeilNode\(/g) || []).length >= 9 && (grp.match(/treasureVeilNode\(/g) || []).length >= 3);
    t('思考链：流式画的时候、拿去概括之前都遮', /b = Object\.assign\(\{\}, b, \{ text: treasureVeil\(b\.text\) \}\)/.test(api)
      && /async function summarizeThinking\(reasoningText\) \{[\s\S]{0,200}treasureVeil\(reasoningText\)/.test(api));
    t('拿掉地点的函数名过得了消毒（不叫 delete*/remove*）', /function treasureRetirePlace\(/.test(src) && !/function (delete|remove)\w*Treasure|function treasure(Delete|Remove)/.test(src));
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
