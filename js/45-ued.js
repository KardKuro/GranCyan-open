// ============================================================
// 情绪动力学（github.com/Priya22/EmotionDynamics）
//
// 原版是拿情绪词典给英文文本打分，再在打分序列上算几个指标。词典那半边
// 对我们没用（NRC-VAD 是两万个英文词，还得单独申请授权，而这儿是中文）——
// **真正值钱的是指标的定义**，那是心理学那边的东西，不是他们的代码。
// 而序列我们现成就有：30-vitals.js 一直在往 v.history 里存
// {t, mood, arousal, energy, closeness, stress}。所以这个文件只做一件事：
// 在那条曲线上把指标算出来。
//
// 五个指标（对每个维度各算一遍）：
//   home base   它平常待在哪（均值 ± 半个标准差）
//   variability 起伏多大（标准差）
//   density     有多少比例的时间待在常态外面
//   rise rate   冲出去有多快（每小时涨多少）
//   recovery    掉回来有多快
// 最有意思的是后两个的**不对称**：起火快、缓得慢，和起火慢、缓得快，
// 是两种完全不同的性格，而平均值看不出这个差别。
//
// ⚠️ 这里最容易出错、而且完全不报错的一条：**采样是不均匀的**。
//    [[VITALS]] 什么时候写才什么时候有点，中间可能隔一整夜。
//    所以斜率必须按**真实小时**算，不能按样本数；而且隔得太久的两个点
//    之间不许连成一段 —— 不然「睡了一觉自然平复」会被算成
//    「恢复得特别慢」，五个指标一起歪，而屏幕上什么错都不会报。
// ============================================================

const UED_DIMS = [
  { k: 'mood',      label: '情绪' },
  { k: 'arousal',   label: '唤醒' },
  { k: 'energy',    label: '能量' },
  { k: 'closeness', label: '亲近' },
  { k: 'stress',    label: '压力' }
];

// 少于这么多点就别算。10 个点以下的标准差基本是噪声，
// 算出来的「性格」纯属编的 —— 宁可显示「还不够」。
const UED_MIN_N = 12;
// 两点之间隔超过这么久（小时）就当断开，不连成一段连续的变化。
const UED_MAX_GAP_H = 2;
// home base 最窄也得有这么宽。曲线几乎不动的时候标准差趋近 0，
// 不给下限的话「常态区间」会窄成一条线，于是每个点都算「在常态外面」，
// density 直接冲到 100% —— 数值全错但一个错都不报。
const UED_BAND_MIN = 0.03;

function uedEnabled() { return state.uedOn !== false && (typeof vitalsEnabled !== 'function' || vitalsEnabled()); }

// 把 history 拆成 {t, v} 并按时间排好。
// ⚠️ 必须自己排一遍：history 是 push 进去的，正常是有序的，但云同步合并过
//    之后就不一定了。不排的话相邻两点可能时间倒着走，算出来的斜率是负的小时数。
function uedSeries(history, key) {
  const out = [];
  for (const h of (Array.isArray(history) ? history : [])) {
    // ⚠️ null 要当缺失丢掉，不能交给 Number() —— Number(null) 是 0，
    //    也就是「情绪低到底」。一个没记上的点会被读成一次崩溃。
    const rv = h ? h[key] : undefined;
    const t = Number(h && h.t), v = rv == null ? NaN : Number(rv);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    out.push({ t, v: Math.max(0, Math.min(1, v)) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function _uedMeanSd(vals) {
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(varr) };
}

// 一段「出走」：从常态里出来，冲到一个极值，再回到常态。
// 返回 null 表示这条曲线上算不出东西来。
function uedFor(history, key) {
  const s = uedSeries(history, key);
  if (s.length < UED_MIN_N) return null;
  const { mean, sd } = _uedMeanSd(s.map(p => p.v));
  const band = Math.max(UED_BAND_MIN, sd * 0.5);
  const home = [Math.max(0, mean - band), Math.min(1, mean + band)];

  let outside = 0;
  const eps = [];            // 收集完整的出走段
  let cur = null;            // { dir, edge, peak, peakAt, leftAt, noStart }
  let lastHomeT = null;      // 最后一个还待在常态里的点

  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    const gapH = i ? (p.t - s[i - 1].t) / 3600000 : 0;
    // 隔太久：把手上这段丢掉（不是收下），出发点也一起忘掉。
    // 中间发生了什么我们看不见，硬接上就是编。
    if (i && gapH > UED_MAX_GAP_H) { cur = null; lastHomeT = null; }

    const above = p.v > home[1], below = p.v < home[0];
    if (above || below) {
      outside++;
      const dir = above ? 1 : -1;
      if (!cur || cur.dir !== dir) {
        cur = {
          dir, edge: dir > 0 ? home[1] : home[0], peak: p.v, peakAt: p.t,
          // ⚠️ 出发点取**上一个还在常态里的点**，不是冲出去的那一点。
          //    真正跨过边界发生在这两点之间；拿冲出去那一点当出发点的话，
          //    「一步就冲到顶」那种（最常见也最猛的一种）算出来是 0 小时，
          //    于是上冲率被整段丢掉 —— 结果是最激烈的几次全不算数，
          //    平均值只剩下慢吞吞爬上去的那几段，而且零报错。
          leftAt: lastHomeT != null ? lastHomeT : p.t,
          // 起点就已经在常态外面（或者刚跨过一个大空档）：不知道什么时候出去的，
          // 这一段的上冲不算，但**回落照算** —— 回落只需要峰值和回来的时间。
          noStart: lastHomeT == null
        };
      } else if ((p.v - cur.peak) * dir > 0) {
        cur.peak = p.v; cur.peakAt = p.t;
      }
    } else {
      if (cur) { cur.backAt = p.t; eps.push(cur); cur = null; }
      lastHomeT = p.t;
    }
  }

  const hrs = ms => Math.max(1 / 60, ms / 3600000);   // 下限 1 分钟，别除出个天文数字
  const rises = [], recovers = [], durations = [];
  for (const e of eps) {
    const amp = Math.abs(e.peak - e.edge);
    if (amp < 0.005) continue;                        // 擦着边过去一下不算一段
    if (!e.noStart && e.peakAt > e.leftAt) rises.push(amp / hrs(e.peakAt - e.leftAt));
    if (e.backAt > e.peakAt) recovers.push(amp / hrs(e.backAt - e.peakAt));
    if (!e.noStart) durations.push((e.backAt - e.leftAt) / 60000);
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  const spanH = (s[s.length - 1].t - s[0].t) / 3600000;
  return {
    n: s.length,
    spanH: +spanH.toFixed(2),
    mean: +mean.toFixed(3),
    sd: +sd.toFixed(3),
    home: [+home[0].toFixed(3), +home[1].toFixed(3)],
    density: +(outside / s.length).toFixed(3),
    rise: rises.length ? +avg(rises).toFixed(3) : null,
    recover: recovers.length ? +avg(recovers).toFixed(3) : null,
    // 出走了几次、每次待多久。次数太少的话上面两个平均值别当真，
    // 所以把它一起交出去，UI 会照它决定要不要标「样本太少」。
    episodes: eps.length,
    durMin: durations.length ? Math.round(avg(durations)) : null,
    peak: +Math.max(...s.map(p => p.v)).toFixed(3),
    trough: +Math.min(...s.map(p => p.v)).toFixed(3)
  };
}

function uedAll(v) {
  const out = {};
  for (const d of UED_DIMS) out[d.k] = uedFor(v && v.history, d.k);
  return out;
}

// 一句人话。指标本身对用户没意义，「起火快、缓得慢」才有。
function uedPhrase(m, label) {
  if (!m) return null;
  if (m.rise == null || m.recover == null || m.episodes < 2) return null;
  const r = m.rise / Math.max(0.001, m.recover);
  if (r > 1.8) return label + '起得快、退得慢';
  if (r < 0.55) return label + '起得慢、退得快';
  return null;
}

// ── 面板 ──
// 挂在生命体征面板底下的一个抽屉，不另开一个模态框 ——
// 数据本来就长在那儿，分成两个地方看反而得来回切。
var _uedOpen = false;

function toggleUed() {
  const box = document.getElementById('uedBox'); if (!box) return;
  _uedOpen = box.classList.contains('hidden');
  box.classList.toggle('hidden', !_uedOpen);
  if (_uedOpen) uedRender();
}

function _uedPct(x) { return Math.round(x * 100) + '%'; }
// 速率的单位是「每小时涨/落多少」，值域和维度一样是 0~1，所以按百分点/小时读。
function _uedRate(x) { return x == null ? '—' : (x >= 10 ? '>999' : Math.round(x * 100) + ' 点/时'); }

// 一条带常态区间的小曲线。看得见「它平常在哪、什么时候冲出去过」，
// 光给五个数字是没法一眼看出形状的。
function _uedSpark(series, home) {
  if (series.length < 2) return '<div class="ued-spark empty"></div>';
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const X = p => ((p.t - t0) / span) * 100;
  const Y = v => 96 - v * 92;
  const pts = series.map(p => X(p).toFixed(1) + ',' + Y(p.v).toFixed(1)).join(' ');
  const yTop = Y(home[1]), yBot = Y(home[0]);
  return '<svg class="ued-spark" viewBox="0 0 100 100" preserveAspectRatio="none">'
    + '<rect x="0" y="' + yTop.toFixed(1) + '" width="100" height="' + Math.max(0.6, yBot - yTop).toFixed(1) + '" class="ued-home"/>'
    + '<polyline points="' + pts + '" class="ued-line"/></svg>';
}

function uedRender() {
  const box = document.getElementById('uedBox'); if (!box) return;
  const conf = typeof vitalsActiveConf === 'function' ? vitalsActiveConf() : null;
  if (!conf) { box.innerHTML = '<div class="section-desc">还没有模型配置。</div>'; return; }
  const v = vitalsEnsure(conf);
  const rows = UED_DIMS.map(d => {
    const m = uedFor(v.history, d.k);
    if (!m) {
      return '<div class="ued-row"><div class="ued-row-head"><b>' + d.label + '</b>'
        + '<span class="ued-thin">曲线还不够长</span></div></div>';
    }
    const few = m.episodes < 3;
    return '<div class="ued-row">'
      + '<div class="ued-row-head"><b>' + d.label + '</b>'
      + '<span class="ued-thin">常态 ' + _uedPct(m.home[0]) + '–' + _uedPct(m.home[1])
      + ' · ' + m.n + ' 点 / ' + (m.spanH >= 24 ? (m.spanH / 24).toFixed(1) + ' 天' : m.spanH.toFixed(1) + ' 小时') + '</span></div>'
      + _uedSpark(uedSeries(v.history, d.k), m.home)
      + '<div class="ued-nums">'
      + '<span title="起伏多大">起伏 <b>' + _uedPct(m.sd) + '</b></span>'
      + '<span title="有多少时间待在常态外面">出走 <b>' + _uedPct(m.density) + '</b></span>'
      + '<span title="离开常态之后冲上去有多快">上冲 <b>' + _uedRate(m.rise) + '</b></span>'
      + '<span title="从极值退回常态有多快">回落 <b>' + _uedRate(m.recover) + '</b></span>'
      + '<span title="出走过几次 · 每次平均待多久">' + m.episodes + ' 次'
      + (m.durMin != null ? ' · ' + (m.durMin >= 60 ? (m.durMin / 60).toFixed(1) + ' 时' : m.durMin + ' 分') : '') + '</span>'
      + '</div>'
      // ⚠️ 只有两三段的时候平均值基本没意义，得当场说出来，
      //    不然一个「上冲 40 点/时」会被当成结论用。
      + (few ? '<div class="ued-warn">出走次数太少，上冲/回落还不作数</div>' : '')
      + '</div>';
  }).join('');
  box.innerHTML = rows
    + '<label class="diary-switch ued-switch"><input type="checkbox" id="uedToggle"'
    + (uedEnabled() ? ' checked' : '') + ' onchange="toggleUedOn(this.checked)">'
    + ' 把规律告诉它自己（只给结论，不给数字）</label>'
    + '<div class="ued-foot">按真实时间算，隔了 ' + UED_MAX_GAP_H + ' 小时以上的两点不连成一段'
    + '（不然睡一觉的自然平复会被当成「恢复得很慢」）。</div>';
}

function toggleUedOn(on) {
  state.uedOn = !!on; save();
  showToast(on ? '它会知道自己的情绪起落规律' : '不再把情绪规律告诉它', on ? 'success' : 'info', 2400);
}

// ── 系统提示 ──
// 只发**结论**不发一串数字：模型看见「上冲 43 点/时」除了复述没别的能干的，
// 看见「你起得快、退得慢」才用得上。
function uedPromptFor(conf) {
  if (!uedEnabled()) return { stable: '', volatile: '' };
  // ⚠️ stable 只看开关，不能跟着「这轮算不算得出规律」时有时无（2026-10-03 修）。
  //    以前算不出来就连标题一起不发：曲线攒到够算、或者新点把某个维度挤出阈值，
  //    stable 就多出/少掉这 85 个字 —— 订阅 Claude 那边 sysStableKey 一变就判
  //    「系统提示结构变了」整段重开会话，API 那边前缀缓存整段作废。
  //    10-01~10-02 两天里它来回翻了 12 次，每次几万 token 重写。
  //    所以措辞改成不预设下面一定有：有没有那一句都说得通。
  const stable = `

--- 📈 你自己的情绪规律 ---
本轮实时信息里如果有「[你最近的起落]」那一句，那是从你自己这段时间的身体记录里算出来的，不是设定，也不是要你去演；没有就是还算不出来。
知道就好，别每轮都提，更别把里面的数字念给用户听。`;
  let volatile = '';
  const v = typeof vitalsEnsure === 'function' && conf ? vitalsEnsure(conf) : null;
  if (v) {
    const bits = [];
    for (const d of UED_DIMS) {
      const p = uedPhrase(uedFor(v.history, d.k), d.label);
      if (p) bits.push(p);
    }
    if (bits.length) volatile = '\n\n[你最近的起落] ' + bits.join('；') + '。';
  }
  return { stable, volatile };
}
