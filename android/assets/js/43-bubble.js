// ═══════════════════════════════════════════════════════
// 气泡主题（导入 KakaoTalk 的 .ktheme）
// ═══════════════════════════════════════════════════════
// .ktheme 就是个 zip。里面 KakaoTalkTheme.css 写着气泡图的文件名和 cap
// （九宫格里「不许拉伸」的左边距和上边距），Images/ 放图。
//
// 解压不引第三方库：自己读 zip 的中央目录 + DecompressionStream('deflate-raw')。
// 后者 Chrome 80+ 原生，安卓 WebView 同源，Node 18+ 也有 —— 所以测试跑通
// 就等于真机跑通，用的是同一套 API。
//
// 为什么是导入而不是预先解好塞进仓库：一个主题连背景图 60KB~870KB，
// 用户手上就 38 个，全预解仓库和 APK 都要涨十几 MB，而且她以后每下一个新的
// 我都得改一次代码。导入式只多花一个解析器。

// ── zip ────────────────────────────────────────────────
// 从尾部找 EOCD（中央目录结束记录），再顺着它读中央目录。
// 不从头顺序读本地文件头：zip 允许两者不一致，中央目录才是权威的那份。
function _bkEocd(dv) {
  const SIG = 0x06054b50;
  // EOCD 最小 22 字节，注释最长 65535，从尾部往前找这么多就够
  const stop = Math.max(0, dv.byteLength - 22 - 65535);
  for (let i = dv.byteLength - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === SIG) return i;
  }
  return -1;
}

function _bkEntries(buf) {
  const dv = new DataView(buf);
  const eocd = _bkEocd(dv);
  if (eocd < 0) throw new Error('不是 zip 包（找不到 EOCD）');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder('utf-8');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('中央目录项签名不对');
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    out.push({
      name: dec.decode(u8.subarray(off + 46, off + 46 + nlen)),
      method: dv.getUint16(off + 10, true),
      csize: dv.getUint32(off + 20, true),
      lho: dv.getUint32(off + 42, true)
    });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

// 本地文件头是变长的（文件名 + 扩展字段），得先读了才知道数据从哪开始
function _bkRaw(buf, e) {
  const dv = new DataView(buf);
  if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error('本地文件头签名不对: ' + e.name);
  const nlen = dv.getUint16(e.lho + 26, true);
  const elen = dv.getUint16(e.lho + 28, true);
  const start = e.lho + 30 + nlen + elen;
  return new Uint8Array(buf, start, e.csize);
}

async function _bkInflate(u8, method) {
  if (method === 0) return u8;                       // stored，本来就没压
  if (method !== 8) throw new Error('不支持的压缩方式: ' + method);
  // deflate-raw 才对 —— zip 里存的是裸 deflate 流，不是 zlib 包装
  const st = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}

// ⚠️ 必须分块。String.fromCharCode.apply 一次喂 80 万个参数会爆栈，
//    而背景图动辄 800KB —— 直接 apply 整个数组必崩。
function _bkB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

const _bkDataUrl = u8 => 'data:image/png;base64,' + _bkB64(u8);

// PNG 头里就有宽高，不用解码整张图
function _bkPngSize(u8) {
  if (u8.length < 24 || u8[1] !== 0x50 || u8[2] !== 0x4E || u8[3] !== 0x47) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

// ── 主题 css ───────────────────────────────────────────
function _bkParseCss(css) {
  // ⚠️ 注释必须**先整段去掉**，不能等切完 ';' 再从值里删。
  // 真主题长这样：`-ios-title-edgeinsets: 20px 16px 10px 18px;  /* top, left, bottom, right */`
  // 注释在分号之后，按 ';' 切开时它会粘到**下一条声明的键**上，
  // 键变成 "/* … */\n-ios-text-color"，于是字色查不到、静默退回兜底色。
  css = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = {};
  const re = /([A-Za-z-]+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const props = {};
    for (const line of m[2].split(';')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) props[k] = v;
    }
    out[m[1]] = props;
  }
  return out;
}

// 主题包里的颜色写法很野，实测三种都有：
//   #df88f3            规规矩矩
//   FFFFFF             不带 # —— 帕恰狗的底色
//   rgb(74, 56, 42)    딸기 토끼쿠우 的字色
// 只认 #hex 的话后两种会静默退回兜底色：字变成灰的、底变成浅灰，都不报错。
function _bkColor(raw, fallback) {
  const v = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{4}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(v)) return '#' + v;
  if (/^(rgba?|hsla?)\([\d\s.,%/-]+\)$/i.test(v)) return v;
  return fallback;
}

// 气泡里有一堆东西是按 --text-muted / --text-dim 上色的（歌名、时间、次要说明）。
// 想让它们跟着主题走，就得由主题字色**派生**出淡两档来。
// 拆成 rgb 自己配 alpha，而不是用 color-mix()：后者要 Chrome 111+，
// 安卓 WebView 版本参差，不支持时整条声明作废 —— 字会退回浅色，还是看不见。
function _bkRgb(c) {
  const v = String(c || '').trim();
  let m = v.match(/^#([0-9a-fA-F]{3})$/);
  if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
  m = v.match(/^#([0-9a-fA-F]{6})[0-9a-fA-F]{0,2}$/);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return [1, 2, 3].map(i => Math.round(parseFloat(m[i])));
  return null;
}
function _bkFade(c, a) {
  const rgb = _bkRgb(c);
  // 认不出来就原样回去：宁可淡一档没生效，也别输出一个非法颜色让整条规则作废
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})` : c;
}

// caps 只给左和上，右和下是「剩下的都归它，中间留一个点给拉伸」。
// 这不是猜的：糖果系 Send 的星星在左上、left cap 更大；Receive 星星在右上、
// right cap 更大 —— 数字和图完全对得上（2026-08-29 看图确认）。
function _bkSlice(caps, size, scale) {
  const left = Math.round((caps[0] || 0) * scale);
  const top = Math.round((caps[1] || 0) * scale);
  const right = size.w - left - scale;
  const bottom = size.h - top - scale;
  // 四个都得非负：caps 比图还大的时候 right/bottom 会算成负数，
  // 而 border-image-slice 不吃负值 —— 写进去整个规则作废，气泡就是不变样，不报错。
  if (left < 0 || top < 0 || right < 0 || bottom < 0) return null;
  if (left + right >= size.w || top + bottom >= size.h) return null;
  return { top, right, bottom, left };
}

// 包里同一张图可能有 @3x / @2x / 无后缀三份，挑最清楚的那份
function _bkPickImage(entries, ref) {
  for (const s of [3, 2, 1]) {
    const nm = ref.replace(/\.png$/i, (s > 1 ? '@' + s + 'x' : '') + '.png');
    const e = entries.find(x => x.name === nm || x.name.endsWith('/' + nm));
    if (e) return { entry: e, scale: s };
  }
  return null;
}

async function _bkSide(buf, entries, props) {
  const ref = String(props['-ios-background-image'] || '').match(/'([^']+)'\s*(.*)$/);
  if (!ref) return null;
  const caps = (ref[2].match(/-?[\d.]+/g) || []).map(Number);
  const pick = _bkPickImage(entries, ref[1]);
  if (!pick) return null;
  const png = await _bkInflate(_bkRaw(buf, pick.entry), pick.entry.method);
  const size = _bkPngSize(png);
  if (!size) return null;
  const slice = _bkSlice(caps, size, pick.scale);
  if (!slice) return null;
  // -ios-title-edgeinsets 的顺序是 top left bottom right（包里的注释写了）。
  // 兜底给一组和 GranCyan 默认气泡差不多的内边距。
  const pad = ((props['-ios-title-edgeinsets'] || '').match(/[\d.]+/g) || []).map(Number);
  const p = pad.length === 4 ? pad : [13, 17, 13, 17];
  return {
    src: _bkDataUrl(png), slice, scale: pick.scale,
    // 存成 css 的 padding 顺序：上 右 下 左。留个下限，别让字贴着边。
    pad: [Math.max(6, p[0]), Math.max(8, p[3]), Math.max(6, p[2]), Math.max(8, p[1])],
    color: _bkColor(props['-ios-text-color'], '#333333')
  };
}

// 解一个 .ktheme。返回 null 表示这个包里没有能用的气泡。
async function parseKtheme(buf, fallbackName) {
  const entries = _bkEntries(buf);
  const ce = entries.find(e => /KakaoTalkTheme\.css$/i.test(e.name));
  if (!ce) throw new Error('包里没有 KakaoTalkTheme.css');
  const css = new TextDecoder('utf-8').decode(await _bkInflate(_bkRaw(buf, ce), ce.method));
  const sheet = _bkParseCss(css);

  const send = await _bkSide(buf, entries, sheet['MessageCellStyle-Send'] || {});
  const recv = await _bkSide(buf, entries, sheet['MessageCellStyle-Receive'] || {});
  if (!send || !recv) throw new Error('包里的气泡图读不出来');

  const room = sheet['BackgroundStyle-ChatRoom'] || {};
  // 有些主题这里写的是个空的 '#'，直接用会画出透明 —— 得兜底
  const bgColor = _bkColor(room['background-color'], '#f2f2f7');

  let bgSrc = '';
  const bgRef = String(room['-ios-background-image'] || '').match(/'([^']+)'/);
  if (bgRef) {
    const pick = _bkPickImage(entries, bgRef[1]);
    if (pick) {
      try { bgSrc = _bkDataUrl(await _bkInflate(_bkRaw(buf, pick.entry), pick.entry.method)); }
      catch (e) { console.warn('气泡主题背景图跳过:', e.message); }   // 背景图不是必需的，坏了也别整包作废
    }
  }

  return {
    // ⚠️ id 绝不能从名字派生。「糖果系」和「简线条」sanitize 之后都是 '___'，
    //    中韩文名撞得非常凶（2026-08-29 在渲染对照页上实撞过，图互相覆盖）。
    id: 'bt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: fallbackName, at: Date.now(),
    send, recv, bgColor, bgSrc, pixel: false
  };
}

// ── 导入 ───────────────────────────────────────────────
function _bkIndex() {
  if (!Array.isArray(state.bubbleThemes)) state.bubbleThemes = [];
  return state.bubbleThemes;
}
const _bkKey = id => 'kuro_bubtheme_' + id;

async function importBubbleFiles(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) return;
  const done = [], failed = [];

  for (const f of files) {
    const base = f.name.replace(/\.(ktheme|zip|apk)$/i, '');
    try {
      const buf = await f.arrayBuffer();
      if (/\.apk$/i.test(f.name)) {
        // 安卓版主题的资源名被 aapt 混淆成了 res/1r.png 这种，没有 resources.arsc
        // 的话对不回原名。与其解出一堆认不出的图，不如直说。
        throw new Error('这是安卓版主题，图片名被混淆了对不回来。找同一个主题的 iOS 版（.ktheme）');
      }
      // 有的分享包是个 zip，里面裹着几个 .ktheme（不少主题合集就是这么打包的）。
      // 已经有 zip 解析器了，顺手递归一层。
      const inner = /\.zip$/i.test(f.name)
        ? _bkEntries(buf).filter(e => /\.ktheme$/i.test(e.name))
        : [];
      if (inner.length) {
        for (const e of inner) {
          const nm = e.name.split('/').pop().replace(/\.ktheme$/i, '');
          try {
            const sub = await _bkInflate(_bkRaw(buf, e), e.method);
            // slice() 拿一份独立的 ArrayBuffer —— subarray 会带着原 buffer 的偏移，
            // 里层解析按绝对偏移读会读错地方
            const t = await parseKtheme(sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength), nm);
            await _bkStore(t); done.push(t.name);
          } catch (e2) { failed.push(nm + '：' + e2.message); }
        }
        continue;
      }
      const t = await parseKtheme(buf, base);
      await _bkStore(t); done.push(t.name);
    } catch (e) {
      failed.push(base + '：' + e.message);
    }
  }

  if (done.length) { save(); renderBubbleThemeList(); }
  const msg = (done.length ? '导入了 ' + done.length + ' 个气泡主题' : '一个都没导进来')
    + (failed.length ? '，' + failed.length + ' 个失败' : '');
  showToast(msg);
  if (failed.length) console.warn('气泡主题导入失败：\n' + failed.join('\n'));
}

async function _bkStore(t) {
  await idbSet(_bkKey(t.id), JSON.stringify(t));
  _bkIndex().unshift({ id: t.id, name: t.name, at: t.at, pixel: false });
}

// null 只表示「IDB 里确实没有 / 存的那份坏了」——调用方会据此把条目从索引里摘掉。
// IDB 读失败要往外抛：以前也返回 null，一次读抖动就把主题永久从列表里删了。
async function _bkLoad(id) {
  const raw = await idbGet(_bkKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { console.warn('气泡主题数据坏了:', e.message); return null; }
}

async function deleteBubbleTheme(id) {
  const it = _bkIndex().find(x => x.id === id);
  if (!it) return;
  if (!confirm('删掉气泡主题「' + it.name + '」？删了要重新导入。')) return;
  state.bubbleThemes = _bkIndex().filter(x => x.id !== id);
  await idbDel(_bkKey(id));
  if (state.bubbleTheme === id) { state.bubbleTheme = ''; applyBubbleTheme(); }
  save(); renderBubbleThemeList();
  showToast('删掉了');
}

// ── 生效 ───────────────────────────────────────────────
// 只往 :root 上写自定义属性，真正的规则写死在 grancyan.css 里。
// 这样级联是在样式表里排好的，不用靠「注入的 style 排在后面」去赌优先级。
function _bkVars(t) {
  const one = (k, s) => {
    const w = o => (s.slice[o] / s.scale).toFixed(2) + 'px';
    return `--bub-${k}-src:url("${s.src}");`
      + `--bub-${k}-slice:${s.slice.top} ${s.slice.right} ${s.slice.bottom} ${s.slice.left} fill;`
      + `--bub-${k}-bw:${w('top')} ${w('right')} ${w('bottom')} ${w('left')};`
      + `--bub-${k}-pad:${s.pad[0]}px ${s.pad[1]}px ${s.pad[2]}px ${s.pad[3]}px;`
      + `--bub-${k}-color:${s.color};`
      + `--bub-${k}-soft:${_bkFade(s.color, 0.72)};`
      + `--bub-${k}-faint:${_bkFade(s.color, 0.52)};`;
  };
  return ':root{' + one('send', t.send) + one('recv', t.recv)
    // 像素风的图放大后会被插值糊掉。没有任何字段能认出「这是像素风」，
    // 所以做成开关让用户自己点，不去猜 —— 猜错了是静默的，看着就是「有点糊」。
    + '--bub-render:' + (t.pixel ? 'pixelated' : 'auto') + ';'
    + '--bub-bg-color:' + t.bgColor + ';'
    + '--bub-bg-src:' + (t.bgSrc ? `url("${t.bgSrc}")` : 'none') + ';'
    + '}';
}

var _bkApplying = 0;   // 连点主题时防止旧的那次后到、把新的盖回去

async function applyBubbleTheme(id) {
  if (id !== undefined) state.bubbleTheme = id || '';
  const seq = ++_bkApplying;
  let el = document.getElementById('bubbleThemeVars');
  if (!el) {
    el = document.createElement('style');
    el.id = 'bubbleThemeVars';
    document.head.appendChild(el);
  }
  const active = state.bubbleTheme;
  if (!active) {
    el.textContent = '';
    document.body.classList.remove('has-bubble-theme', 'has-bubble-bg');
    renderBubbleThemeList();
    return;
  }
  let t;
  try { t = await _bkLoad(active); }
  catch (e) {
    // 读失败：索引和选中都不动，下次启动/再点一次还能读到。这次先不换样式。
    if (seq === _bkApplying) showToast('气泡主题这次没读出来，稍后再试：' + (e && e.message || e));
    return;
  }
  if (seq !== _bkApplying) return;
  if (!t) {
    // 索引里有、IDB 里没有 —— 让索引跟上，别留一条点了没反应的死条目
    state.bubbleThemes = _bkIndex().filter(x => x.id !== active);
    state.bubbleTheme = '';
    el.textContent = '';
    document.body.classList.remove('has-bubble-theme', 'has-bubble-bg');
    save(); renderBubbleThemeList();
    showToast('这个主题的数据丢了，已经从列表里去掉');
    return;
  }
  const it = _bkIndex().find(x => x.id === active);
  t.pixel = !!(it && it.pixel);
  el.textContent = _bkVars(t);
  document.body.classList.add('has-bubble-theme');
  document.body.classList.toggle('has-bubble-bg', state.bubbleThemeBg !== false);
  renderBubbleThemeList();
}

function toggleBubbleThemeBg(on) {
  state.bubbleThemeBg = !!on;
  document.body.classList.toggle('has-bubble-bg', !!on && !!state.bubbleTheme);
  save();
}

function toggleBubbleThemePixel(id, on) {
  const it = _bkIndex().find(x => x.id === id);
  if (!it) return;
  it.pixel = !!on;
  save();
  // 返回 promise：调用方（和测试）要能等它真的铺上去
  return state.bubbleTheme === id ? applyBubbleTheme() : Promise.resolve();
}

// ── 设置里的列表 ───────────────────────────────────────
function renderBubbleThemeList() {
  const box = document.getElementById('bubbleThemeList');
  if (!box) return;
  const list = _bkIndex();
  const act = state.bubbleTheme || '';
  const rows = list.map(it => `
    <div class="bub-row${act === it.id ? ' on' : ''}">
      <button type="button" class="bub-pick" onclick="applyBubbleTheme('${it.id}')">
        <b>${escHtml(it.name)}</b>
        <small>${act === it.id ? '正在用' : '点一下换上'}</small>
      </button>
      <label class="bub-px" title="像素风主题放大会糊，勾上就不平滑了">
        <input type="checkbox" ${it.pixel ? 'checked' : ''}
               onchange="toggleBubbleThemePixel('${it.id}',this.checked)">像素
      </label>
      <button type="button" class="bub-del" onclick="deleteBubbleTheme('${it.id}')" title="删掉">✕</button>
    </div>`).join('');
  box.innerHTML = `
    <div class="bub-row${act ? '' : ' on'}">
      <button type="button" class="bub-pick" onclick="applyBubbleTheme('')">
        <b>默认气泡</b><small>${act ? '点一下换回来' : '正在用'}</small>
      </button>
    </div>${rows}`;
  const bgc = document.getElementById('bubbleThemeBgToggle');
  if (bgc) bgc.checked = state.bubbleThemeBg !== false;
}
