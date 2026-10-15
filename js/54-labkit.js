// ============================================================
// 学习工具箱 ①：聊天里画图 [[PLOT: …]] + GeoGebra 面板
//
// 分工：
//   · 气泡里的小图用 JSXGraph（MIT/LGPL，js/lib/jsxgraphcore.js，第一次用到才加载）。
//     轻、离线、点能拖、滑块能拉，一条消息里画好几张也不卡。
//   · 想细玩就点「GeoGebra」，同一串指令原样喂给 GeoGebra。
//     所以指令**长成 GeoGebra 的样子** —— 模型本来就熟这套写法，两边共用一份，
//     不用再发明一门方言让它学。
//   · GeoGebra 离线包放在 labkit/geogebra（不进 git、不进 exe、不进 APK，
//     由电脑后端当静态文件发；手机也从电脑拿）。拿不到再退回官网（国内直连常超时）。
//
// 这是个**纯渲染**标签：没有副作用，所以不进 processAiCommands，
// 标签原样留在 content 里，由渲染层（stickerTagToHtml）画 —— content 和 blocks 两条路都经过那里。
// 真正把图画出来要等气泡进了 DOM（JSXGraph 要量容器尺寸），挂在 typesetMath 上，
// 同 KaTeX 一个时机。
// ============================================================

// ── 表达式 → JS 函数 ─────────────────────────────────────────
// 自己写一个小解析器，不用 eval、也不用 JSXGraph 自带的 JessieCode：
//   · 要认「2x」「3sin(x)」「ax」这种省略乘号的写法（模型和课本都这么写）
//   · 要认 ln / lg / log(底, 真数) / log_2(x) —— 中国课本的对数写法
//   · 生成的代码只可能含：数字、白名单运算符、Math.* / H.*、x y t 三个变量名、
//     以及 S[…] U[…] P[…] 三张表的查表（键是 JSON 字符串）。
//     模型写什么都拼不出别的标识符，所以 new Function 是安全的。

const _PL_BUILTIN = {
  sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
  asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan',
  arcsin: 'Math.asin', arccos: 'Math.acos', arctan: 'Math.atan',
  sinh: 'Math.sinh', cosh: 'Math.cosh', tanh: 'Math.tanh',
  sqrt: 'Math.sqrt', cbrt: 'Math.cbrt', abs: 'Math.abs', exp: 'Math.exp',
  floor: 'Math.floor', ceil: 'Math.ceil', round: 'Math.round',
  sign: 'Math.sign', sgn: 'Math.sign',
  ln: 'Math.log', lg: 'Math.log10', log10: 'Math.log10', log2: 'Math.log2', ld: 'Math.log2',
  min: 'Math.min', max: 'Math.max',
  cot: 'H.cot', sec: 'H.sec', csc: 'H.csc', log: 'H.log', nroot: 'H.nroot'
};

const _PL_H = {
  cot: x => 1 / Math.tan(x),
  sec: x => 1 / Math.cos(x),
  csc: x => 1 / Math.sin(x),
  // GeoGebra 的约定：log(x) 是自然对数，log(b, x) 是以 b 为底
  log: (a, b) => (b === undefined ? Math.log(a) : Math.log(b) / Math.log(a)),
  nroot: (x, n) => (x < 0 && Math.round(n) % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)),
  // ⚠️ 负数开奇次方：Math.pow(-8, 1/3) 是 NaN，而课本上 x^(1/3) 在 x<0 有定义。
  //    不补的话 y = x^(1/3) 左半边整段消失，看着像「画错了」而不是「没画」。
  pow: (a, b) => {
    if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
    for (let q = 3; q <= 15; q += 2) {
      const p = b * q;
      if (Math.abs(p - Math.round(p)) < 1e-9) {
        const v = Math.pow(-a, b);
        return Math.round(p) % 2 === 0 ? v : -v;
      }
    }
    return NaN;
  }
};

const _PL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*'{0,2}$/;

function _plNorm(s) {
  return String(s == null ? '' : s)
    .replace(/[−–—－]/g, '-').replace(/[×·∙＊]/g, '*').replace(/[÷／]/g, '/').replace(/＋/g, '+')
    .replace(/π/g, 'pi').replace(/²/g, '^2').replace(/³/g, '^3').replace(/√/g, 'sqrt')
    .replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/＝/g, '=')
    .replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/≠/g, '!=').replace(/＜/g, '<').replace(/＞/g, '>')
    .replace(/[“”]/g, '"');
}

function _plTok(src) {
  const s = _plNorm(src);
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    const rest = s.slice(i);
    let m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (m) { toks.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    m = /^[A-Za-z_][A-Za-z0-9_]*'{0,2}/.exec(rest);
    if (m) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    m = /^(<=|>=|==|!=|&&|\|\|)/.exec(rest);
    if (m) { toks.push({ t: 'op', v: m[0] }); i += 2; continue; }
    if (c === '=') { toks.push({ t: 'op', v: '==' }); i++; continue; }   // If(x=1, …) 里单个 = 也当相等
    if ('+-*/^(),<>!|°'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('看不懂「' + c + '」');
  }
  return toks;
}

// 粘在一起的名字按已知名字切开：ax → a·x，xsin → x·sin，2pix 在分词时已经是 2 和 pix。
// 从左往右每次取最长的已知前缀，切不干净就放弃（返回 null，由调用方报「认不出」）。
function _plSplitIdent(name, known) {
  if (name.length > 24 || /'/.test(name)) return null;
  const out = [];
  let i = 0;
  while (i < name.length) {
    const d = /^\d+/.exec(name.slice(i));
    if (d && out.length) { out.push(d[0]); i += d[0].length; continue; }
    let hit = '';
    for (const k of known) {
      if (k.length > hit.length && name.startsWith(k, i)) hit = k;
    }
    if (!hit) return null;
    out.push(hit);
    i += hit.length;
  }
  return out.length > 1 ? out : null;
}

// ctx: { vars:Set(x/y/t), nums:Set(滑块和常数), funcs:Set(用户函数), points:Set(点名) }
// 返回 { code, used:Set }。used 里记着用到了哪些变量，调用方据此判断 y= 还是隐函数。
function _plCompile(src, ctx) {
  ctx = ctx || {};
  const vars = ctx.vars || new Set(), nums = ctx.nums || new Set(),
    funcs = ctx.funcs || new Set(), points = ctx.points || new Set();
  const toks = _plTok(src);
  let p = 0;
  const used = new Set();
  const peek = () => toks[p];
  const isOp = v => !!toks[p] && toks[p].t === 'op' && toks[p].v === v;
  const expect = v => { if (!isOp(v)) throw new Error('少了「' + v + '」'); p++; };
  const key = n => JSON.stringify(n);
  const known = () => [...vars, ...nums, ...funcs, ...Object.keys(_PL_BUILTIN), 'pi', 'e'];

  function parseOr() { let a = parseAnd(); while (isOp('||')) { p++; a = '(' + a + '||' + parseAnd() + ')'; } return a; }
  function parseAnd() { let a = parseCmp(); while (isOp('&&')) { p++; a = '(' + a + '&&' + parseCmp() + ')'; } return a; }
  // 0 < x < 2 这种连写拆成 (0<x)&&(x<2) —— 分段函数里常见
  function parseCmp() {
    let a = parseAdd();
    const parts = [];
    while (peek() && peek().t === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v)) {
      const op = toks[p++].v;
      const b = parseAdd();
      parts.push('(' + a + (op === '==' ? '===' : op === '!=' ? '!==' : op) + b + ')');
      a = b;
    }
    return parts.length ? '(' + parts.join('&&') + ')' : a;
  }
  function parseAdd() {
    let a = parseMul();
    while (isOp('+') || isOp('-')) { const o = toks[p++].v; a = '(' + a + o + parseMul() + ')'; }
    return a;
  }
  const startsPrimary = tk => !!tk && (tk.t === 'num' || tk.t === 'id' || (tk.t === 'op' && tk.v === '('));
  function parseMul() {
    let a = parseUnary();
    for (;;) {
      if (isOp('*') || isOp('/')) { const o = toks[p++].v; a = '(' + a + o + parseUnary() + ')'; continue; }
      if (startsPrimary(peek())) { a = '(' + a + '*' + parseUnary() + ')'; continue; }   // 省略的乘号
      return a;
    }
  }
  function parseUnary() {
    if (isOp('-')) { p++; return '(-' + parseUnary() + ')'; }
    if (isOp('+')) { p++; return parseUnary(); }
    if (isOp('!')) { p++; return '(!' + parseUnary() + ')'; }
    return parsePow();
  }
  // -x^2 = -(x^2)：负号在 parseUnary 那层，乘方在这层，天然就对
  function parsePow() {
    const a = parsePostfix();
    if (isOp('^')) { p++; return 'H.pow(' + a + ',' + parseUnary() + ')'; }
    return a;
  }
  function parsePostfix() {
    let a = parsePrimary();
    while (isOp('°')) { p++; a = '(' + a + '*Math.PI/180)'; }
    return a;
  }
  function parseArgs() {
    expect('(');
    const args = [];
    if (isOp(')')) { p++; return args; }
    for (;;) {
      args.push(parseOr());
      if (isOp(',')) { p++; continue; }
      expect(')');
      return args;
    }
  }
  function parsePrimary() {
    const tk = toks[p++];
    if (!tk) throw new Error('式子没写完');
    if (tk.t === 'num') return '(' + Number(tk.v) + ')';
    if (tk.t === 'op' && tk.v === '(') { const a = parseOr(); expect(')'); return '(' + a + ')'; }
    if (tk.t === 'op' && tk.v === '|') { const a = parseAdd(); expect('|'); return 'Math.abs(' + a + ')'; }
    if (tk.t !== 'id') throw new Error('这里不该有「' + tk.v + '」');
    return ident(tk.v);
  }
  function ident(name) {
    const low = name.toLowerCase();
    if (low === 'if' && isOp('(')) {
      const a = parseArgs();
      if (a.length < 2 || a.length > 3) throw new Error('If 要写成 If(条件, 值, 否则的值)');
      return '((' + a[0] + ')?(' + a[1] + '):(' + (a[2] || 'NaN') + '))';
    }
    const lb = /^log_(\d+(?:\.\d+)?|e)$/i.exec(name);
    if (lb && isOp('(')) {
      const a = parseArgs();
      if (a.length !== 1) throw new Error(name + ' 只要一个参数');
      return 'H.log(' + (lb[1].toLowerCase() === 'e' ? 'Math.E' : Number(lb[1])) + ',' + a[0] + ')';
    }
    // x(A) / y(A)：取点的坐标。只在括号里正好是一个点名时才这么认，否则 x(x+1) 还是乘法
    if ((name === 'x' || name === 'y') && isOp('(') && toks[p + 1] && toks[p + 1].t === 'id'
        && points.has(toks[p + 1].v) && toks[p + 2] && toks[p + 2].t === 'op' && toks[p + 2].v === ')') {
      const pn = toks[p + 1].v;
      p += 3;
      used.add('pt:' + pn);
      return 'P[' + key(pn) + '].' + (name === 'x' ? 'X' : 'Y') + '()';
    }
    if (funcs.has(name) && isOp('(')) {
      const a = parseArgs();
      if (a.length !== 1) throw new Error(name + ' 只要一个参数');
      used.add('fn:' + name);
      return 'U[' + key(name) + '](' + a[0] + ')';
    }
    if (Object.prototype.hasOwnProperty.call(_PL_BUILTIN, low) && !vars.has(name) && !nums.has(name)) {
      if (isOp('(')) {
        const a = parseArgs();
        if (!a.length) throw new Error(name + ' 后面的括号里是空的');
        return _PL_BUILTIN[low] + '(' + a.join(',') + ')';
      }
      return _PL_BUILTIN[low] + '(' + parseUnary() + ')';    // sin x 这种不带括号的写法
    }
    if (vars.has(name)) { used.add('v:' + name); return name; }
    if (nums.has(name)) { used.add('n:' + name); return 'S[' + key(name) + ']()'; }
    if (low === 'pi') return 'Math.PI';
    if (name === 'e') return 'Math.E';
    const parts = _plSplitIdent(name, known());
    if (parts) {
      toks.splice(p - 1, 1, ...parts.map(v => (/^\d/.test(v) ? { t: 'num', v } : { t: 'id', v })));
      p--;
      return parsePrimary();
    }
    throw new Error('认不出「' + name + '」');
  }

  const code = parseOr();
  if (p < toks.length) throw new Error('「' + toks[p].v + '」后面多出来了');
  return { code, used };
}

// argNames 只会是 x / y / t 的组合（都来自这个文件，不来自标签）
function _plFn(code, argNames) {
  // eslint-disable-next-line no-new-func
  return new Function(...argNames, 'S', 'U', 'P', 'H', '"use strict";return (' + code + ');');
}

// ── 指令 → 作图计划（纯数据，不碰 JSXGraph，测试直接跑这一层）─────
const _PL_CMDS = ['slider', 'midpoint', 'segment', 'line', 'ray', 'vector', 'circle', 'polygon', 'angle',
  'curve', 'integral', 'tangent', 'text', 'zoomin', 'setcolor', 'setlinestyle', 'point'];

// 顶层切分：括号和引号里的分隔符不算
function _plSplitTop(s, seps) {
  const out = [];
  let depth = 0, q = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && seps.includes(c)) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

const _PL_COLORS = {
  red: '#ff6b6b', blue: '#5aa9ff', green: '#5fd38a', orange: '#ff9f43', purple: '#b58cff',
  yellow: '#ffd166', cyan: '#4dd9e8', teal: '#3cc9b0', brown: '#c08457', gray: '#9aa4b2', grey: '#9aa4b2',
  black: '#cfd6e0', white: '#f2f4f8', magenta: '#e879f9', pink: '#f59ac8',
  '红': '#ff6b6b', '蓝': '#5aa9ff', '绿': '#5fd38a', '橙': '#ff9f43', '紫': '#b58cff', '黄': '#ffd166',
  '青': '#4dd9e8', '棕': '#c08457', '灰': '#9aa4b2', '黑': '#cfd6e0', '白': '#f2f4f8', '粉': '#f59ac8'
};
// 深色底上都看得清的一组。没放粉 —— 用户不喜欢粉色，模型点名要才给
const _PL_PALETTE = ['#5aa9ff', '#ff9f43', '#5fd38a', '#b58cff', '#ff6b6b', '#4dd9e8', '#ffd166'];

function _plColor(s) {
  const v = String(s || '').replace(/"/g, '').trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) return v;
  return _PL_COLORS[v.toLowerCase()] || _PL_COLORS[v] || null;
}

function plotParse(src) {
  const plan = { title: '', items: [], errors: [], bbox: null, aspect: false, nums: [] };
  const ctx = { vars: new Set(), nums: new Set(), funcs: new Set(), points: new Set() };
  const byName = {};
  let anon = 0;
  const lines = [];
  String(src || '').split(/\r?\n/).forEach(l => _plSplitTop(l, ';').forEach(x => lines.push(x)));

  const compile = (expr, vars) => _plCompile(expr, Object.assign({}, ctx, { vars: new Set(vars) }));
  const constFn = expr => {
    const c = compile(expr, []);
    return _plFn(c.code, []);
  };
  const add = it => {
    plan.items.push(it);
    if (it.name) byName[it.name] = it;
    return it;
  };
  const pointRef = (arg) => {
    const a = arg.trim();
    if (ctx.points.has(a)) return a;
    const lit = /^\(([\s\S]*)\)$/.exec(a);
    if (lit) {
      const xy = _plSplitTop(lit[1], ',');
      if (xy.length === 2) {
        const name = '_p' + (++anon);
        addPoint(name, xy[0], xy[1], true);
        return name;
      }
    }
    throw new Error('「' + a + '」不是点（先用 A=(1,2) 定义，或者直接写坐标）');
  };
  function addPoint(name, xs, ys, hidden) {
    const cx = compile(xs, []), cy = compile(ys, []);
    const dep = cx.used.size || cy.used.size;
    const fx = _plFn(cx.code, []), fy = _plFn(cy.code, []);
    ctx.points.add(name);
    return add({ k: 'point', name, fx, fy, free: !dep, anon: !!hidden });
  }
  const fnName = s => { if (!_PL_NAME_RE.test(s)) throw new Error('名字「' + s + '」只能用字母数字'); return s; };

  function equation(lhs, rhs, name, raw) {
    lhs = lhs.trim(); rhs = rhs.trim();
    if (lhs === 'y') {
      const c = compile(rhs, ['x', 'y']);
      if (!c.used.has('v:y')) {
        const it = add({ k: 'fn', name: name || '', f: _plFn(c.code, ['x']), label: name || '' });
        if (name) registerFn(name, it);
        return;
      }
    }
    if (lhs === 'x') {
      const c = compile(rhs, ['x', 'y']);
      if (!c.used.has('v:x') && !c.used.has('v:y')) { add({ k: 'vline', name: name || '', f: _plFn(c.code, []) }); return; }
      if (!c.used.has('v:x')) { add({ k: 'xfn', name: name || '', g: _plFn(c.code, ['y']) }); plan.aspect = true; return; }
    }
    const c = compile('(' + lhs + ')-(' + rhs + ')', ['x', 'y']);
    if (!c.used.has('v:x') && !c.used.has('v:y')) throw new Error('这个等式里没有 x 也没有 y：' + raw);
    add({ k: 'implicit', name: name || '', F: _plFn(c.code, ['x', 'y']) });
    plan.aspect = true;
  }
  function registerFn(name, it) {
    ctx.funcs.add(name);
    ctx.funcs.add(name + "'");
    ctx.funcs.add(name + "''");
    it.fnName = name;
  }

  function command(cmd, argStr, name, raw) {
    const c = cmd.toLowerCase();
    const args = argStr.trim() ? _plSplitTop(argStr, ',').map(s => s.trim()) : [];
    const need = (n, m) => { if (args.length < n || args.length > (m || n)) throw new Error(cmd + ' 的参数个数不对'); };
    switch (c) {
      case 'slider': {
        need(2, 4);
        if (!name) throw new Error('Slider 要起个名字：a = Slider(-5, 5)');
        const min = constFn(args[0])(), max = constFn(args[1])();
        const step = args[2] ? constFn(args[2])() : (max - min) / 100;
        let init = args[3] ? constFn(args[3])() : 1;
        if (!(init >= min && init <= max)) init = min + (max - min) / 2;
        if (!(max > min) || !(step > 0)) throw new Error('Slider 的范围不对');
        ctx.nums.add(name);
        const it = { k: 'num', name, slider: true, min, max, step, init };
        plan.nums.push(it);
        add(it);
        return;
      }
      case 'point': {
        need(1);
        const lit = /^\(([\s\S]*)\)$/.exec(args[0]);
        const xy = lit ? _plSplitTop(lit[1], ',') : [];
        if (xy.length !== 2) throw new Error('Point 要写成 Point((x, y))');
        addPoint(name || '_p' + (++anon), xy[0], xy[1], !name);
        return;
      }
      case 'midpoint': {
        need(2);
        const a = pointRef(args[0]), b = pointRef(args[1]);
        const nm = name || '_p' + (++anon);
        ctx.points.add(nm);
        add({ k: 'mid', name: nm, a, b, anon: !name });
        return;
      }
      case 'segment': case 'line': case 'ray': case 'vector': {
        need(2);
        const kind = { segment: 'seg', line: 'line', ray: 'ray', vector: 'vec' }[c];
        add({ k: kind, name: name || '', a: pointRef(args[0]), b: pointRef(args[1]) });
        if (kind !== 'line') plan.aspect = true;
        return;
      }
      case 'circle': {
        need(2, 3);
        plan.aspect = true;
        const center = pointRef(args[0]);
        if (args.length === 3) { add({ k: 'circle3', name: name || '', a: center, b: pointRef(args[1]), c: pointRef(args[2]) }); return; }
        if (ctx.points.has(args[1].trim()) || /^\(/.test(args[1].trim())) { add({ k: 'circle2', name: name || '', c: center, b: pointRef(args[1]) }); return; }
        const r = compile(args[1], []);
        add({ k: 'circle', name: name || '', c: center, r: _plFn(r.code, []) });
        return;
      }
      case 'polygon': {
        if (args.length < 3) throw new Error('Polygon 至少要三个点');
        plan.aspect = true;
        add({ k: 'poly', name: name || '', pts: args.map(pointRef) });
        return;
      }
      case 'angle': {
        need(3);
        plan.aspect = true;
        add({ k: 'angle', name: name || '', a: pointRef(args[0]), b: pointRef(args[1]), c: pointRef(args[2]) });
        return;
      }
      case 'curve': {
        need(5);
        const tv = args[2].trim();
        if (!/^[a-z]$/.test(tv)) throw new Error('Curve 的第三个参数是参数名，比如 t');
        const X = compile(args[0].replace(new RegExp('\\b' + tv + '\\b', 'g'), 't'), ['t']);
        const Y = compile(args[1].replace(new RegExp('\\b' + tv + '\\b', 'g'), 't'), ['t']);
        add({ k: 'curve', name: name || '', X: _plFn(X.code, ['t']), Y: _plFn(Y.code, ['t']),
          t0: constFn(args[3])(), t1: constFn(args[4])() });
        plan.aspect = true;
        return;
      }
      case 'integral': {
        need(3);
        const fnm = args[0];
        const f = byName[fnm];
        if (!f || f.k !== 'fn') throw new Error('Integral 的第一个参数要是前面定义过的函数名，比如 f');
        add({ k: 'integral', f: fnm, a: constFn(args[1])(), b: constFn(args[2])() });
        return;
      }
      case 'tangent': {
        need(2);
        const f = byName[args[1]];
        if (!f || f.k !== 'fn') throw new Error('Tangent 要写成 Tangent(x0, f)，f 是前面定义过的函数');
        const x0 = compile(args[0], []);
        add({ k: 'tangent', name: name || '', f: args[1], x0: _plFn(x0.code, []) });
        return;
      }
      case 'text': {
        need(2);
        const m = /^"([\s\S]*)"$/.exec(args[0]);
        if (!m) throw new Error('Text 的第一个参数要用引号括起来');
        add({ k: 'text', str: m[1].slice(0, 80), at: pointRef(args[1]) });
        return;
      }
      case 'zoomin': {
        need(4);
        const v = args.map(a => constFn(a)());
        if (!(v[2] > v[0] && v[3] > v[1])) throw new Error('ZoomIn 要写成 ZoomIn(xmin, ymin, xmax, ymax)');
        plan.bbox = v;
        return;
      }
      case 'setcolor': {
        need(2);
        const target = byName[args[0]];
        const col = _plColor(args[1]);
        if (!target) throw new Error('SetColor 找不到「' + args[0] + '」');
        if (!col) throw new Error('不认识颜色 ' + args[1]);
        target.color = col;
        return;
      }
      case 'setlinestyle': {
        need(2);
        const target = byName[args[0]];
        if (!target) throw new Error('SetLineStyle 找不到「' + args[0] + '」');
        target.dash = Math.max(0, Math.min(6, Math.round(constFn(args[1])()) || 0));
        return;
      }
    }
    throw new Error('不支持的指令 ' + cmd + (c === 'intersect' ? '（交点请自己算好坐标，用 A=(x,y) 标出来）' : ''));
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const raw = _plNorm(lines[ln]).trim();
    if (!raw) continue;
    if (/^#/.test(raw)) { if (!plan.title) plan.title = raw.replace(/^#+\s*/, '').slice(0, 60); continue; }
    try {
      let m;
      const line = raw.replace(/：/g, ':');
      // f(x) = …
      if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([a-z])\s*\)\s*=([^=][\s\S]*)$/.exec(line))) {
        const name = fnName(m[1]);
        const body = m[3].replace(new RegExp('\\b' + m[2] + '\\b', 'g'), 'x');
        const c = compile(body, ['x']);
        const it = add({ k: 'fn', name, f: _plFn(c.code, ['x']), label: name });
        registerFn(name, it);
        continue;
      }
      // c: x^2 + y^2 = 4
      if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(line))) {
        const eq = _plSplitTop(m[2], '=');
        if (eq.length !== 2) throw new Error('「' + m[1] + ':」后面要是一个等式');
        equation(eq[0], eq[1], fnName(m[1]), raw);
        continue;
      }
      // 名字 = …
      if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=([^=][\s\S]*)$/.exec(line)) && m[1] !== 'y' && m[1] !== 'x') {
        const name = fnName(m[1]);
        const rhs = m[2].trim();
        const cm = /^([A-Za-z]+)\s*\(([\s\S]*)\)$/.exec(rhs);
        if (cm && _PL_CMDS.includes(cm[1].toLowerCase())) { command(cm[1], cm[2], name, raw); continue; }
        const lit = /^\(([\s\S]*)\)$/.exec(rhs);
        if (lit && _plSplitTop(lit[1], ',').length === 2) {
          const xy = _plSplitTop(lit[1], ',');
          addPoint(name, xy[0], xy[1], false);
          continue;
        }
        const c = compile(rhs, ['x']);
        if (c.used.has('v:x')) {
          const it = add({ k: 'fn', name, f: _plFn(c.code, ['x']), label: name });
          registerFn(name, it);
        } else {
          ctx.nums.add(name);
          const it = { k: 'num', name, slider: false, f: _plFn(c.code, []) };
          plan.nums.push(it);
          add(it);
        }
        continue;
      }
      // 不带名字的指令
      if ((m = /^([A-Za-z]+)\s*\(([\s\S]*)\)$/.exec(line)) && _PL_CMDS.includes(m[1].toLowerCase())) {
        command(m[1], m[2], '', raw);
        continue;
      }
      if ((m = /^([A-Za-z]+)\s*\(/.exec(line)) && /^[A-Z]/.test(m[1]) && !_PL_CMDS.includes(m[1].toLowerCase())) {
        command(m[1], '', '', raw);        // 走一遍拿到「不支持」的报错
        continue;
      }
      // 不带名字的点
      const lit = /^\(([\s\S]*)\)$/.exec(line);
      if (lit && _plSplitTop(lit[1], ',').length === 2) {
        const xy = _plSplitTop(lit[1], ',');
        addPoint('_p' + (++anon), xy[0], xy[1], true);
        continue;
      }
      // 等式（y = …、x = …、隐函数）。不等式（涂区域）暂时不画，明说，别让它以为画了
      if (/[<>]|!=|==/.test(line)) throw new Error('不等式/区域还画不了，请改成画边界线');
      const eq = _plSplitTop(line, '=');
      if (eq.length === 2) { equation(eq[0], eq[1], '', raw); continue; }
      throw new Error('没看懂这一行');
    } catch (e) {
      plan.errors.push({ line: raw.slice(0, 80), why: String((e && e.message) || e) });
    }
  }
  return plan;
}

// ── 求值环境：S 滑块/常数、U 用户函数（含导数）、P 点 ─────────────
// sliderGet(name) 给了就用它（挂载后读 HTML 滑块的当前值），没给就用初值（测试、算视野）。
// points 给了就用它（挂载后是 JSXGraph 的点对象，拖动后坐标跟着变）。
function _plEnv(plan, sliderGet, points) {
  const S = {}, U = {}, P = points || {};
  const H = _PL_H;
  for (const it of plan.items) {
    if (it.k === 'num') {
      if (it.slider) S[it.name] = sliderGet ? () => sliderGet(it.name) : () => it.init;
      else S[it.name] = () => it.f(S, U, P, H);
    } else if (it.k === 'fn' && it.fnName) {
      const f = x => it.f(x, S, U, P, H);
      const h = 1e-4;
      const d1 = x => (f(x + h) - f(x - h)) / (2 * h);
      U[it.fnName] = f;
      U[it.fnName + "'"] = d1;
      U[it.fnName + "''"] = x => (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);
    }
  }
  if (!points) {
    // 没挂载时的点：按定义顺序现算（中点依赖前面的点）
    for (const it of plan.items) {
      if (it.k === 'point') P[it.name] = { X: () => it.fx(S, U, P, H), Y: () => it.fy(S, U, P, H) };
      else if (it.k === 'mid') P[it.name] = { X: () => (P[it.a].X() + P[it.b].X()) / 2, Y: () => (P[it.a].Y() + P[it.b].Y()) / 2 };
    }
  }
  return { S, U, P, H };
}

// 视野：给了 ZoomIn 就用它；没给就把点、圆、曲线都框进来，函数按采样值的中间 90% 定高度
// （tan、1/x 这种一采样就是 1e16，全框进来整张图就是一条横线）。
function plotAutoBox(plan, env) {
  if (plan.bbox) return plan.bbox.slice();
  env = env || _plEnv(plan);
  const { S, U, P, H } = env;
  const xs = [], ys = [];
  const put = (x, y) => { if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); } };
  const pt = n => { try { return [P[n].X(), P[n].Y()]; } catch (e) { return [NaN, NaN]; } };
  for (const it of plan.items) {
    try {
      if (it.k === 'point' || it.k === 'mid') put(...pt(it.name));
      else if (it.k === 'circle') { const [cx, cy] = pt(it.c); const r = Math.abs(it.r(S, U, P, H)); put(cx - r, cy - r); put(cx + r, cy + r); }
      else if (it.k === 'circle2') { const [cx, cy] = pt(it.c); const [bx, by] = pt(it.b); const r = Math.hypot(bx - cx, by - cy); put(cx - r, cy - r); put(cx + r, cy + r); }
      else if (it.k === 'curve') { for (let i = 0; i <= 60; i++) { const t = it.t0 + (it.t1 - it.t0) * i / 60; put(it.X(t, S, U, P, H), it.Y(t, S, U, P, H)); } }
      else if (it.k === 'integral') { xs.push(it.a, it.b); }
      else if (it.k === 'vline') { const v = it.f(S, U, P, H); if (isFinite(v)) xs.push(v); }
      else if (it.k === 'text') { put(...pt(it.at)); }
    } catch (e) { /* 算不出来的不参与框定 */ }
  }
  let x0, x1;
  if (xs.length) {
    x0 = Math.min(...xs); x1 = Math.max(...xs);
    const pad = Math.max(1, (x1 - x0) * 0.2);
    x0 -= pad; x1 += pad;
    // 离原点不远就把原点框进来：坐标轴在图里读起来才有参照
    if (x0 > 0 && x0 < (x1 - x0)) x0 = -pad;
    if (x1 < 0 && -x1 < (x1 - x0)) x1 = pad;
  } else { x0 = -6; x1 = 6; }
  const fnItems = plan.items.filter(it => it.k === 'fn' || it.k === 'tangent');
  if (fnItems.length) {
    const samp = [];
    for (const it of fnItems) {
      for (let i = 0; i <= 200; i++) {
        const x = x0 + (x1 - x0) * i / 200;
        let v;
        try {
          v = it.k === 'fn' ? it.f(x, S, U, P, H) : NaN;
        } catch (e) { v = NaN; }
        if (isFinite(v)) samp.push(v);
      }
    }
    samp.sort((a, b) => a - b);
    if (samp.length) {
      ys.push(samp[Math.floor(samp.length * 0.05)], samp[Math.floor(samp.length * 0.95)]);
    }
  }
  let y0, y1;
  if (ys.length) {
    y0 = Math.min(...ys); y1 = Math.max(...ys);
    const pad = Math.max(1, (y1 - y0) * 0.18);
    y0 -= pad; y1 += pad;
    if (y0 > 0 && y0 < (y1 - y0)) y0 = -pad;
    if (y1 < 0 && -y1 < (y1 - y0)) y1 = pad;
  } else { y0 = -4; y1 = 4; }
  // 和 ZoomIn 同一个顺序：[xmin, ymin, xmax, ymax]
  return [x0, y0, x1, y1].map(v => Math.round(v * 1000) / 1000);
}

// ── 标签协议 ──────────────────────────────────────────────────
function plotTagRe() { return /\[\[PLOT:\s*([\s\S]*?)\s*\]\]/g; }

function _plUnesc(s) {
  // 用户消息那条路先整段 escHtml 过，这里还原回来再解析（If(x<0,…) 里的 < 会变成 &lt;）
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function plotTagToHtml(text) {
  if (!text || text.indexOf('[[PLOT') < 0) return text;
  const esc = (typeof escHtml === 'function') ? escHtml : (s => String(s));
  return String(text).replace(plotTagRe(), (m, body) => {
    const src = _plUnesc(body);
    let title = '';
    const t = /^\s*#+\s*(.+)$/m.exec(src);
    if (t) title = t[1].trim().slice(0, 60);
    // 换行写成 &#10;：属性里的真换行不要紧，但源码里要是有空行，marked 会在那儿把 HTML 块截断
    const attr = esc(src).replace(/\r?\n/g, '&#10;');
    return '\n\n<div class="plot-box" data-src="' + attr + '">'
      + '<div class="plot-head"><span class="plot-title">📈 ' + esc(title || '图') + '</span>'
      + '<span class="plot-tools">'
      + '<button type="button" class="plot-btn" title="拖乱了就复位" onclick="plotReset(this)">⟲</button>'
      + '<button type="button" class="plot-btn plot-grab-btn" title="手机上：点一下才能拖图里的点（不点时滑动是翻聊天）" onclick="plotToggleGrab(this)">✋</button>'
      + '<button type="button" class="plot-btn" title="在 GeoGebra 里打开，细玩" onclick="plotOpenGgb(this)">GeoGebra</button>'
      + '</span></div>'
      + '<div class="plot-stage"><div class="plot-wait">画图中…</div></div>'
      + '<div class="plot-sliders"></div><div class="plot-err"></div></div>\n\n';
  });
}

// 回填给模型：标签原样留着（历史就是教材，留下的正是正确写法），
// 但哪几行没画出来要告诉它 —— 不然它永远不知道自己写错了，下次照错。
function plotTagForApi(text) {
  if (!text || text.indexOf('[[PLOT') < 0) return text;
  return String(text).replace(plotTagRe(), (m, body) => {
    let plan;
    try { plan = plotParse(_plUnesc(body)); } catch (e) { return m; }
    if (!plan.errors.length) return m;
    return m + '\n[这张图有 ' + plan.errors.length + ' 行没画出来：'
      + plan.errors.slice(0, 5).map(e => '「' + e.line + '」' + e.why).join('；') + ']';
  });
}

function maskStreamingPlot(text) {
  if (!text || text.indexOf('[[PL') < 0) return text;
  return String(text).replace(plotTagRe(), '〔📈〕').replace(/\[\[PL(?:OT)?[\s\S]*$/, '〔📈 画图中…〕');
}

// ── 挂载 ─────────────────────────────────────────────────────
let _plLib = null;
let _plSeq = 0;
const _plBoards = new Map();     // 容器 id → board，气泡被重画掉之后要释放

function _plLoadLib() {
  if (typeof JXG !== 'undefined' && JXG.JSXGraph) return Promise.resolve();
  if (_plLib) return _plLib;
  _plLib = new Promise((resolve, reject) => {
    if (!document.getElementById('jsxgraphCss')) {
      const l = document.createElement('link');
      l.id = 'jsxgraphCss'; l.rel = 'stylesheet'; l.href = './js/lib/jsxgraph.css';
      document.head.appendChild(l);
    }
    const s = document.createElement('script');
    s.src = './js/lib/jsxgraphcore.js';
    s.onload = () => resolve();
    s.onerror = () => { _plLib = null; reject(new Error('画图库没加载成功')); };
    document.head.appendChild(s);
  });
  return _plLib;
}

let _plIO = null;
function plotMountIn(root) {
  if (!root || typeof document === 'undefined' || !root.querySelectorAll) return;
  const boxes = root.classList && root.classList.contains('plot-box') ? [root] : root.querySelectorAll('.plot-box:not([data-on])');
  if (!boxes.length) return;
  _plSweep();
  // 翻历史时一屏外的图先不画：一个对话里几十张图同时建 board 会卡一下
  if (typeof IntersectionObserver === 'function') {
    if (!_plIO) {
      _plIO = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (e.isIntersecting) { _plIO.unobserve(e.target); plotMount(e.target); }
        }
      }, { rootMargin: '400px 0px' });
    }
    boxes.forEach(b => { if (!b.dataset.on) _plIO.observe(b); });
  } else {
    boxes.forEach(plotMount);
  }
}

function _plSweep() {
  if (typeof JXG === 'undefined') return;
  for (const [id, board] of _plBoards) {
    if (!document.getElementById(id)) {
      try { JXG.JSXGraph.freeBoard(board); } catch (e) {}
      _plBoards.delete(id);
    }
  }
}

function plotMount(box) {
  if (!box || box.dataset.on) return;
  box.dataset.on = '1';
  _plLoadLib().then(() => _plBuild(box)).catch(e => {
    const st = box.querySelector('.plot-stage');
    if (st) st.innerHTML = '<div class="plot-wait">📈 ' + String(e.message || e).replace(/[<>&]/g, '') + '</div>';
  });
}

function _plCss(name, fb) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch (e) { return fb; }
}

function _plBuild(box) {
  const src = box.dataset.src || '';
  const stage = box.querySelector('.plot-stage');
  const slWrap = box.querySelector('.plot-sliders');
  const errBox = box.querySelector('.plot-err');
  if (!stage) return;
  if (box._plId && _plBoards.has(box._plId)) {
    try { JXG.JSXGraph.freeBoard(_plBoards.get(box._plId)); } catch (e) {}
    _plBoards.delete(box._plId);
  }
  const plan = plotParse(src);
  const errs = plan.errors.slice();

  // 滑块画成 HTML 的，不画进图里：图里的滑块会挡住图，手机上还很难拖
  const slVal = {};
  slWrap.innerHTML = '';
  for (const n of plan.nums.filter(x => x.slider)) {
    slVal[n.name] = n.init;
    const lab = document.createElement('label');
    lab.className = 'plot-sl';
    const nm = document.createElement('span'); nm.className = 'plot-sl-n'; nm.textContent = n.name;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = n.min; inp.max = n.max; inp.step = n.step; inp.value = n.init;
    const out = document.createElement('span'); out.className = 'plot-sl-v';
    const fmt = v => String(Math.round(v * 1000) / 1000);
    out.textContent = fmt(n.init);
    inp.addEventListener('input', () => {
      slVal[n.name] = Number(inp.value);
      out.textContent = fmt(slVal[n.name]);
      const b = _plBoards.get(box._plId);
      if (b) b.update();
    });
    lab.append(nm, inp, out);
    slWrap.appendChild(lab);
  }

  const P = {};
  const env = _plEnv(plan, name => slVal[name], P);
  // 算视野要用「没挂载时」的点，这时候 JSXGraph 的点还没建
  const bbox = plotAutoBox(plan, _plEnv(plan, name => slVal[name]));

  const id = 'plotb' + (++_plSeq);
  box._plId = id;
  stage.innerHTML = '<div class="plot-jxg" id="' + id + '"></div>';

  const textC = _plCss('--text-primary', '#e8e8e8');
  const mutedC = _plCss('--text-muted', '#8b93a1');
  const gridC = 'rgba(160,170,190,0.16)';
  const axisC = 'rgba(200,208,222,0.65)';
  JXG.Options.text.strokeColor = textC;
  JXG.Options.label.strokeColor = textC;
  JXG.Options.text.useMathJax = false;
  JXG.Options.text.useKatex = false;
  JXG.Options.text.parse = false;

  const board = JXG.JSXGraph.initBoard(id, {
    boundingbox: [bbox[0], bbox[3], bbox[2], bbox[1]],
    keepaspectratio: !!plan.aspect,
    axis: true,
    grid: false,
    showCopyright: false,
    showNavigation: false,
    pan: { enabled: true, needShift: false, needTwoFingers: true },
    zoom: { enabled: true, wheel: true, needShift: true, pinch: true },
    defaultAxes: {
      x: { strokeColor: axisC, highlightStrokeColor: axisC,
        ticks: { strokeColor: gridC, majorHeight: -1, minorTicks: 0, label: { strokeColor: mutedC, fontSize: 11 } } },
      y: { strokeColor: axisC, highlightStrokeColor: axisC,
        ticks: { strokeColor: gridC, majorHeight: -1, minorTicks: 0, label: { strokeColor: mutedC, fontSize: 11 } } }
    }
  });
  _plBoards.set(id, board);

  let ci = 0;
  const colorOf = it => it.color || _PL_PALETTE[ci++ % _PL_PALETTE.length];
  const H = _PL_H, S = env.S, U = env.U;
  const lineAttr = (it, col) => ({ strokeColor: col, highlightStrokeColor: col, strokeWidth: 2, dash: it.dash || 0,
    fixed: true, name: it.name && !/^_/.test(it.name) ? it.name : '', withLabel: !!(it.name && !/^_/.test(it.name)) });
  const pointAttr = (it, col, free) => ({
    name: it.anon ? '' : it.name, withLabel: !it.anon, size: it.anon ? 2 : 3,
    strokeColor: col, fillColor: col, highlightStrokeColor: col, highlightFillColor: col,
    fixed: !free, showInfobox: true, label: { strokeColor: textC, fontSize: 13, offset: [6, 8] }
  });
  const need = n => { const o = P[n]; if (!o) throw new Error('找不到点 ' + n); return o; };

  for (const it of plan.items) {
    try {
      const col = (it.k === 'num' || it.k === 'text') ? null : colorOf(it);
      switch (it.k) {
        case 'num': break;
        case 'fn': {
          const g = board.create('functiongraph', [x => it.f(x, S, U, P, H)], Object.assign(lineAttr(it, col), {
            name: it.label || '', withLabel: !!it.label, label: { strokeColor: col, fontSize: 13 }
          }));
          if (it.fnName) it._jx = g;      // Integral 要拿这条曲线本身当父元素
          break;
        }
        case 'vline': {
          const v = () => it.f(S, U, P, H);
          board.create('line', [[() => v(), 0], [() => v(), 1]], lineAttr(it, col));
          break;
        }
        case 'xfn':
          board.create('curve', [y => it.g(y, S, U, P, H), y => y, bbox[1] - 50, bbox[3] + 50], lineAttr(it, col));
          break;
        case 'implicit':
          board.create('implicitcurve', [(x, y) => it.F(x, y, S, U, P, H)], lineAttr(it, col));
          break;
        case 'point': {
          const pt = it.free
            ? board.create('point', [it.fx(S, U, P, H), it.fy(S, U, P, H)], pointAttr(it, col, true))
            : board.create('point', [() => it.fx(S, U, P, H), () => it.fy(S, U, P, H)], pointAttr(it, col, false));
          P[it.name] = pt;
          break;
        }
        case 'mid':
          P[it.name] = board.create('midpoint', [need(it.a), need(it.b)], pointAttr(it, col, false));
          break;
        case 'seg': board.create('segment', [need(it.a), need(it.b)], lineAttr(it, col)); break;
        case 'line': board.create('line', [need(it.a), need(it.b)], lineAttr(it, col)); break;
        case 'ray': board.create('line', [need(it.a), need(it.b)], Object.assign(lineAttr(it, col), { straightFirst: false })); break;
        case 'vec': board.create('arrow', [need(it.a), need(it.b)], lineAttr(it, col)); break;
        case 'circle': board.create('circle', [need(it.c), () => Math.abs(it.r(S, U, P, H))], lineAttr(it, col)); break;
        case 'circle2': board.create('circle', [need(it.c), need(it.b)], lineAttr(it, col)); break;
        case 'circle3': board.create('circumcircle', [need(it.a), need(it.b), need(it.c)], Object.assign(lineAttr(it, col), { center: { visible: false } })); break;
        case 'poly':
          board.create('polygon', it.pts.map(need), {
            fillColor: col, fillOpacity: 0.14, highlightFillColor: col, highlightFillOpacity: 0.2,
            borders: { strokeColor: col, highlightStrokeColor: col, strokeWidth: 2, fixed: true }, fixed: true, withLabel: false
          });
          break;
        case 'angle': {
          const r = Math.max(0.3, Math.min(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.07);
          const ang = board.create('nonreflexangle', [need(it.a), need(it.b), need(it.c)], {
            radius: r, fillColor: col, fillOpacity: 0.22, strokeColor: col, fixed: true,
            name: 'α', withLabel: true, label: { strokeColor: col, fontSize: 12 }
          });
          // 标签显示度数，拖点时跟着变。name 传函数时 this 不是这个角，只能建完再换标签文字
          if (ang.label) ang.label.setText(() => (ang.Value() * 180 / Math.PI).toFixed(1) + '°');
          break;
        }
        case 'curve':
          board.create('curve', [t => it.X(t, S, U, P, H), t => it.Y(t, S, U, P, H), it.t0, it.t1], lineAttr(it, col));
          break;
        case 'integral': {
          const fit = plan.items.find(x => x.k === 'fn' && x.fnName === it.f);
          if (!fit || !fit._jx) throw new Error('Integral 找不到函数 ' + it.f);
          board.create('integral', [[it.a, it.b], fit._jx], {
            fillColor: col, fillOpacity: 0.22, strokeColor: col, withLabel: true,
            label: { strokeColor: textC, fontSize: 12 },
            // 它自己会生四个辅助点，默认顺着字母表起名（B、D、E…），和题里的点撞名，全部不标字
            curveLeft: { visible: true, size: 2, strokeColor: col, fillColor: col, withLabel: false, name: '' },
            curveRight: { visible: true, size: 2, strokeColor: col, fillColor: col, withLabel: false, name: '' },
            baseLeft: { visible: false, withLabel: false, name: '' },
            baseRight: { visible: false, withLabel: false, name: '' }
          });
          break;
        }
        case 'tangent': {
          const f = U[it.f], d = U[it.f + "'"];
          const x0 = () => it.x0(S, U, P, H);
          board.create('functiongraph', [x => f(x0()) + d(x0()) * (x - x0())], Object.assign(lineAttr(it, col), { dash: it.dash || 2 }));
          board.create('point', [() => x0(), () => f(x0())], pointAttr({ anon: true }, col, false));
          break;
        }
        case 'text': {
          const at = need(it.at);
          // display:internal = 画成 SVG 文字（textContent），不是 innerHTML —— 模型写什么都只是字
          board.create('text', [() => at.X(), () => at.Y(), it.str], {
            display: 'internal', parse: false, useMathJax: false, fontSize: 13, strokeColor: it.color || textC, anchorY: 'bottom'
          });
          break;
        }
      }
    } catch (e) {
      errs.push({ line: it.name || it.k, why: String((e && e.message) || e) });
    }
  }
  board.update();

  errBox.innerHTML = '';
  if (errs.length) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = '有 ' + errs.length + ' 行没画出来';
    d.appendChild(s);
    for (const e of errs) {
      const row = document.createElement('div');
      row.textContent = e.line + ' → ' + e.why;
      d.appendChild(row);
    }
    errBox.appendChild(d);
  }
}

function plotReset(btn) {
  const box = btn && btn.closest ? btn.closest('.plot-box') : null;
  if (!box) return;
  _plLoadLib().then(() => _plBuild(box)).catch(() => {});
}

function plotToggleGrab(btn) {
  const box = btn && btn.closest ? btn.closest('.plot-box') : null;
  if (!box) return;
  const on = box.classList.toggle('plot-grab');
  btn.classList.toggle('on', on);
}

// ── 喂给 GeoGebra ────────────────────────────────────────────
// 指令本来就是 GeoGebra 的写法，只有两处要翻：# 标题行不是指令；log_2(x) 是课本写法，
// GeoGebra 认的是 log(2, x)。
function plotToGgb(src) {
  const out = [];
  String(src || '').split(/\r?\n/).forEach(l => _plSplitTop(l, ';').forEach(x => {
    const s = _plNorm(x).trim();
    if (!s || /^#/.test(s)) return;
    out.push(s.replace(/\blog_(\d+(?:\.\d+)?|e)\s*\(/gi, (m, b) => 'log(' + b + ', '));
  }));
  return out;
}

function _plPickApp(plan) {
  if (plan.items.some(it => ['poly', 'angle', 'circle', 'circle2', 'circle3', 'seg', 'mid'].includes(it.k))
      && !plan.items.some(it => it.k === 'fn')) return 'geometry';
  return 'graphing';
}

function plotOpenGgb(btn) {
  const box = btn && btn.closest ? btn.closest('.plot-box') : null;
  if (!box) return;
  const src = box.dataset.src || '';
  let app = 'graphing';
  const cmds = plotToGgb(src);
  try {
    const plan = plotParse(src);
    app = _plPickApp(plan);
    // 没写 ZoomIn 的话 GeoGebra 用它自己的默认视野，图常常偏在一角 —— 带上气泡里算好的那个
    if (!plan.bbox) cmds.push('ZoomIn(' + plotAutoBox(plan).join(', ') + ')');
  } catch (e) {}
  openGeoGebra(app, cmds);
}

// ── GeoGebra 面板 ─────────────────────────────────────────────
const GGB_APPS = [
  { id: 'graphing', name: '函数' },
  { id: 'geometry', name: '几何' },
  { id: '3d', name: '立体' },
  { id: 'classic', name: '经典' }
];
let _ggbApi = null, _ggbApp = '', _ggbQueue = null, _ggbDeploy = null, _ggbSrc = '';

function _ggbSources() {
  const base = (typeof SERVER_BASE === 'string' && SERVER_BASE) ? SERVER_BASE : '';
  const list = [];
  if (base) list.push({ js: base + '/labkit/geogebra/deployggb.js', codebase: base + '/labkit/geogebra/HTML5/5.0/web3d/', name: '电脑上的离线包' });
  list.push({ js: 'https://www.geogebra.org/apps/deployggb.js', codebase: '', name: 'GeoGebra 官网' });
  return list;
}

function _ggbLoadDeploy() {
  if (typeof GGBApplet === 'function') return Promise.resolve(_ggbSrc);
  if (_ggbDeploy) return _ggbDeploy;
  const srcs = _ggbSources();
  _ggbDeploy = new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      const s = srcs[i++];
      if (!s) { _ggbDeploy = null; reject(new Error('GeoGebra 没加载成功（电脑后端没开？官网在国内也常连不上）')); return; }
      const el = document.createElement('script');
      el.src = s.js;
      const timer = setTimeout(() => { el.onload = el.onerror = null; el.remove(); tryNext(); }, 12000);
      el.onload = () => { clearTimeout(timer); _ggbSrc = s; resolve(s); };
      el.onerror = () => { clearTimeout(timer); el.remove(); tryNext(); };
      document.head.appendChild(el);
    };
    tryNext();
  });
  return _ggbDeploy;
}

function openGeoGebra(app, cmds) {
  const modal = document.getElementById('ggbModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // 深浅只是这台设备上的偏好，放 localStorage 就够（不进 state，省得过三道持久化白名单）
  let light = false;
  try { light = localStorage.getItem('gcGgbLight') === '1'; } catch (e) {}
  modal.classList.toggle('ggb-light', light);
  const want = app || _ggbApp || 'graphing';
  if (cmds && cmds.length) _ggbQueue = cmds.slice();
  _ggbRenderTabs(want);
  if (_ggbApi && _ggbApp === want) { _ggbFlush(); return; }
  _ggbStart(want);
}

function closeGeoGebra() {
  const modal = document.getElementById('ggbModal');
  if (modal) modal.classList.add('hidden');
}

function _ggbRenderTabs(cur) {
  const tabs = document.getElementById('ggbTabs');
  if (!tabs) return;
  tabs.innerHTML = GGB_APPS.map(a => '<button type="button" class="ggb-tab' + (a.id === cur ? ' on' : '')
    + '" onclick="ggbSwitch(\'' + a.id + '\')">' + a.name + '</button>').join('');
}

function ggbSwitch(app) {
  if (!GGB_APPS.some(a => a.id === app)) return;
  _ggbRenderTabs(app);
  if (_ggbApp === app && _ggbApi) return;
  _ggbStart(app);
}

function _ggbStart(app) {
  const host = document.getElementById('ggbHost');
  const note = document.getElementById('ggbNote');
  if (!host) return;
  _ggbApi = null;
  _ggbApp = app;
  host.innerHTML = '<div class="ggb-wait">GeoGebra 加载中…（第一次要十几秒）</div>';
  _ggbLoadDeploy().then(src => {
    if (note) note.textContent = '来自' + src.name + ' · GeoGebra 仅限非商业使用';
    host.innerHTML = '<div id="ggbApplet"></div>';
    const r = host.getBoundingClientRect();
    const params = {
      appName: app, id: 'ggbApplet',
      width: Math.max(320, Math.floor(r.width)), height: Math.max(320, Math.floor(r.height)),
      language: 'zh-CN', showToolBar: true, showAlgebraInput: true, showMenuBar: false,
      enableShiftDragZoom: true, showResetIcon: false, enableRightClick: true, useBrowserForJS: false,
      appletOnLoad: api => { if (_ggbApp !== app) return; _ggbApi = api; _ggbFlush(); }
    };
    // eslint-disable-next-line no-undef
    const applet = new GGBApplet(params, true);
    if (src.codebase) applet.setHTML5Codebase(src.codebase, true);
    applet.inject('ggbApplet');
  }).catch(e => {
    host.innerHTML = '<div class="ggb-wait">' + String(e.message || e).replace(/[<>&]/g, '') + '</div>';
  });
}

function _ggbFlush() {
  if (!_ggbApi || !_ggbQueue) return;
  const cmds = _ggbQueue;
  _ggbQueue = null;
  try { _ggbApi.newConstruction(); } catch (e) {}
  for (const c of cmds) { try { _ggbApi.evalCommand(c); } catch (e) {} }
}

function ggbToggleLight() {
  const modal = document.getElementById('ggbModal');
  if (!modal) return;
  const on = modal.classList.toggle('ggb-light');
  try { localStorage.setItem('gcGgbLight', on ? '1' : '0'); } catch (e) {}
}

// 把当前画板截图塞进输入框，问 AI。只填进去不替她发 —— 问什么、发不发是她的事。
function ggbAskAi() {
  if (!_ggbApi) { if (typeof showToast === 'function') showToast('GeoGebra 还没加载好', 'info', 1600); return; }
  let b64 = '';
  try { b64 = _ggbApi.getPNGBase64(1, true, 96); } catch (e) {}
  if (!b64) { if (typeof showToast === 'function') showToast('截不到图', 'info', 1600); return; }
  if (typeof addPendingImg === 'function') addPendingImg({ url: 'data:image/png;base64,' + b64, name: 'geogebra-' + Date.now() + '.png' });
  const input = document.getElementById('userInput');
  if (input && !input.value.trim()) {
    input.value = '帮我看看这张图：';
    try { autoResize(input); } catch (e) {}
    try { updateComposerBtns(); } catch (e) {}
  }
  closeGeoGebra();
  if (input) input.focus();
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (!_ggbApi) return;
    const host = document.getElementById('ggbHost');
    if (!host || !host.offsetParent) return;
    const r = host.getBoundingClientRect();
    try { _ggbApi.setSize(Math.floor(r.width), Math.floor(r.height)); } catch (e) {}
  });
}
