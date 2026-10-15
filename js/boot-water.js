// 启动页的水：水底光纹 + 从水下浮上来的猫脸，整块画在 #bootWater 一张 WebGL 画布上。
//
// 为什么画在 Worker 里：开机后主线程每隔一秒左右就被读存档 / 画聊天列表 / 云端同步占住 0.5~0.7s
// （exe 里实测，headless 空账号测不出来），画在主线程上的东西——rAF、SVG 滤镜、stroke-dashoffset——
// 一定跟着一卡一卡。Worker 有自己的 rAF，OffscreenCanvas 的帧直接交给合成器，主线程再忙也照常出帧。
// 字（Welcome home / 问候）留在 HTML 里，只动 opacity/transform/filter，那几样合成器自己推。
//
// 同一份代码两种用法（index.html 先用 <script> 同步载入这个文件）：
//   · Worker：GCBootWater.src 是这整个函数的源码，index.html 拿它做 Blob 起 Worker，postMessage 传 OffscreenCanvas。
//     别改回 new Worker('./js/boot-water.js')：开机时 80 个脚本把连接占满，Worker 那一个请求要排到 0.4~0.5s 才拿到，
//     开场早开始了，猫脸一露面第一笔已经画完（exe 里实测）
//   · 主线程兜底：Worker 起不来时直接调 GCBootWater(canvas, opt)
(function bootWater(G) {
  'use strict';

  // 猫脸 <^/^> 的五笔，坐标在 viewBox "40 170 660 380" 里（跟 index.html 的 .gc-mark 一致）
  var MARK = [
    [185, 345, 72, 410, 185, 475],
    [195, 300, 240, 200, 285, 300],
    [405, 292, 322, 518],
    [437, 298, 482, 196, 527, 298],
    [545, 345, 658, 410, 545, 475]
  ];
  var VB = [40, 170, 660, 380];
  var DOM = [0, 130, 740, 460];          // 贴图覆盖的范围：比 viewBox 宽一圈，miter 尖角和光晕不被裁
  var STROKE_AT = [0.05, 0.20, 0.34, 0.48, 0.62], STROKE_DUR = 0.5;
  var END = 2.2;                         // 开场多长：猫脸 1.1s 画完、字 1.7s 升完、波纹 2.1s 平

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  // 笔画用 sine 缓动：cubic 起步太慢，笔头会先当一个方点停 100ms 才开始走
  function inOut(x) { return (1 - Math.cos(Math.PI * x)) / 2; }
  function outCubic(x) { return 1 - Math.pow(1 - x, 3); }

  // 开场时间线（秒）。out = 离场进度 0..1，outT = 离场后过了多少秒
  function timeline(t, outT) {
    var p = [];
    for (var i = 0; i < 5; i++) p.push(inOut(clamp01((t - STROKE_AT[i]) / STROKE_DUR)));
    // 蓝影：先错开 (-12,4) 再回到 (-4,2)，透明度 0 → 1 → .55（跟 css 的 gcGhost 同一条）
    var u = clamp01((t - 0.55) / 1.6), ga = u < 0.25 ? outCubic(u / 0.25) : 1 - 0.45 * outCubic((u - 0.25) / 0.75);
    var gu = outCubic(u);
    var out = outT == null ? 0 : clamp01(outT / 0.6);
    var e = outCubic(clamp01(t / 2.1));
    return {
      p: p,
      ghost: [-12 + 8 * gu, 4 - 2 * gu, 0.55 * ga],
      amp: 0.5 * (34 * (1 - e) + 28 * out * out),     // 位移幅度（css px）
      out: out,
      alpha: outT == null ? 1 : 1 - clamp01(outT / 0.45)
    };
  }

  function shaderSrc() {
    // 每一段线段各算一遍：离这个像素多远、最近点沿笔画走到了哪（弧长），跟这一笔画到哪比，
    // 得到「笔头还在前面多远」x（viewBox 单位，负数 = 还没画到）。
    //   · 笔画：每一笔取它最近的那段；这一笔的笔身（离骨架 16 以内）或者最近的就是它（miter 尖角）才算，取几笔里画得最多的
    //   · 光晕：按离各段的远近加权平均。贴图里的光晕是五笔糊在一起的，只认最近那段的话，
    //     拐角的角平分线、两笔交界处都会被「还没画到的那段」切出一道暗边（exe 录屏里看得见）
    var segs = '', near = '', ink = '', glow = '', dm = [], i, j, k = 0;
    for (i = 0; i < MARK.length; i++) {
      var m = MARK[i], acc = 0, first = k, total = 0;
      for (j = 0; j + 3 < m.length; j += 2) total += Math.hypot(m[j + 2] - m[j], m[j + 3] - m[j + 1]);
      for (j = 0; j + 3 < m.length; j += 2, k++) {
        segs += '  float d' + k + ' = sgd(v, vec2(' + m[j] + '., ' + m[j + 1] + '.), vec2(' + m[j + 2] + '., ' + m[j + 3] + '.), ' + acc.toFixed(2) + ', a);\n' +
                '  float x' + k + ' = hd(P[' + i + '], ' + total.toFixed(2) + ', a);\n';
        glow += '  w = (d' + k + ' - dm) / 30.; w = exp(-w * w); gs += w * smoothstep(-28., 20., x' + k + '); ws += w;\n';
        acc += Math.hypot(m[j + 2] - m[j], m[j + 3] - m[j + 1]);
      }
      near += '  float pd' + i + ' = d' + first + ', px' + i + ' = x' + first + ';\n';
      for (j = first + 1; j < k; j++) near += '  if (d' + j + ' < pd' + i + ') { pd' + i + ' = d' + j + '; px' + i + ' = x' + j + '; }\n';
      ink += '  if (pd' + i + ' < 16. || pd' + i + ' <= dm) ink = max(ink, clamp(px' + i + ' / px + .5, 0., 1.));\n';
      dm.push('pd' + i);
    }
    var code = segs + near + '  float dm = ' + dm.reduce(function (s, n) { return 'min(' + s + ', ' + n + ')'; }) + ';\n' +
      '  float ink = 0., gs = 0., ws = 0., w;\n' + ink + glow;
    return [
      '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
      'uniform vec2 R; uniform float T, O, K, A, MA;',
      'uniform vec4 M;',          // 猫脸在页面上的位置（css px）：x, y(上), w, h
      'uniform vec3 GH;',         // 蓝影偏移（viewBox 单位）和透明度
      'uniform float P[5];',      // 每一笔画到哪了 0..1
      'uniform sampler2D S;',     // r: 猫脸, g: 光晕
      'uniform float HM;',        // 有没有猫脸贴图
      // 到线段的距离；arc = 最近点的弧长。弧长夹在这一段里：拐角外侧的 miter 尖角不会算到下一段的「前面」，
      // 不然笔头还没到尖角先亮几个点
      'float sgd(vec2 p, vec2 a, vec2 b, float s0, out float arc) {',
      '  vec2 ab = b - a; float L = length(ab); float h = clamp(dot(p - a, ab) / (L * L), 0., 1.);',
      '  arc = s0 + h * L;',
      '  return length(p - a - ab * h);',
      '}',
      // 笔头在这一点前面多远。画完的那一笔不再切（不然笔尾外面那圈光晕永远缺一块）；笔头比弧长多出 15 = 方头
      'float hd(float p, float L, float arc) { return p >= 1. ? 1e4 : p * L + (p > 0. ? 15. : -1e4) - arc; }',
      // 返回 (笔画露出多少, 光晕露出多少)；px = 一个设备像素是多少 viewBox 单位，笔头切口按一个像素抗锯齿
      'vec2 reveal(vec2 v, float px) {',
      '  float a;',
      code,
      '  return vec2(ink, gs / ws);',
      '}',
      'vec2 uvOf(vec2 v) { return (v - vec2(' + DOM[0] + '., ' + DOM[1] + '.)) / vec2(' + DOM[2] + '., ' + DOM[3] + '.); }',
      'float inside(vec2 uv) { return step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.); }',
      'void main() {',
      // ── 水底光纹（焦散）：几道不同方向的平面波叠成水面，算折射后光被挤得多紧，挤得越紧越亮
      '  vec2 p = (gl_FragCoord.xy - .5 * R) / R.y * 12.;',
      '  p += vec2(.07, .04) * T;',
      '  float t = T * .55;',
      '  vec3 H = vec3(0.);',
      '  for (int i = 0; i < 7; i++) {',
      '    float f = float(i);',
      '    float a = f * 2.39996 + .5;',
      '    vec2 k = vec2(cos(a), sin(a)) * (1.25 + .42 * f);',
      '    float c = sin(dot(k, p) - t * (1. + .18 * f) + f * 1.7) / (1. + .45 * f);',
      '    H -= c * vec3(k.x * k.x, k.y * k.y, k.x * k.y) / dot(k, k);',
      '  }',
      '  float s = 1.5 * smoothstep(0., 1.6, T) * (1. + .35 * O);',
      '  vec3 L = vec3(0.);',
      '  for (int j = 0; j < 3; j++) {',   // 三个颜色折射率差一点点（色散），网边上自己带出 logo 那道蓝
      '    float q = s * (.93 + .07 * float(j));',
      '    float d = (1. + q * H.x) * (1. + q * H.y) - q * q * H.z * H.z;',
      '    float w = max(1. / (abs(d) + .05) - 1.2, 0.) * .034;',
      '    if (j == 0) L.r = w; else if (j == 1) L.g = w; else L.b = w;',
      '  }',
      '  vec3 col = vec3(1., .63, .31) * L.g + vec3(.31, .48, 1.) * max(L.r - L.g, 0.) * 1.4 + vec3(1., .42, .2) * max(L.b - L.g, 0.) * .5;',
      '  vec2 u = gl_FragCoord.xy / R - vec2(.5, .56);',
      '  u.x *= R.x / R.y;',
      '  float r = length(u);',
      '  col *= .9 * exp(-r * r * 2.6) * (.18 + .82 * smoothstep(.1, .42, r)) * (1. + .9 * O);',   // 猫脸和字后面压暗
      '  vec2 cp = vec2(gl_FragCoord.x, R.y - gl_FragCoord.y) / K;',   // 这个像素的页面坐标（css px，y 朝下）
      // ── 猫脸：隔着一层横向的水波看过去（波纹是一道道横的，不是一圈圈）
      '  if (HM > .5) {',
      '    vec2 c = cp;',
      '    vec2 dw = vec2(sin(c.y * .085 + T * 2.1) * .6 + sin(c.y * .041 - T * 1.3 + c.x * .011) * .4,',
      '                   sin(c.x * .019 + c.y * .05 + T * 1.7) * .45);',
      '    vec2 v = vec2(' + VB[0] + '., ' + VB[1] + '.) + (c + A * dw - M.xy) / M.zw * vec2(' + VB[2] + '., ' + VB[3] + '.);',
      '    vec2 uv = uvOf(v), ug = uvOf(v - GH.xy);',
      '    if (inside(uv) + inside(ug) > 0.) {',
      '      vec4 tx = texture2D(S, uv) * inside(uv);',
      '      float gm = texture2D(S, ug).r * inside(ug);',
      '      float px = ' + VB[2] + '. / (M.z * K);',
      '      vec2 rv = tx.r + tx.g > .002 ? reveal(v, px) : vec2(0.);',
      '      float ri = rv.x, rl = rv.y;',
      '      float rg = gm > .002 ? reveal(v - GH.xy, px).x : 0.;',
      '      col = mix(col, vec3(.31, .48, 1.), gm * rg * GH.z * MA);',
      '      col += vec3(.94, .65, .35) * tx.g * rl * .45 * MA;',
      '      vec3 ink = mix(vec3(.89, .54, .23), vec3(1., .77, .49), clamp((v.y - 190.) / 335., 0., 1.));',
      '      col = mix(col, ink, tx.r * ri * MA);',
      '    }',
      '  }',
      // ── 启动页底色（boot.css #bootSplash 的两层 radial-gradient + --gc-ink）在这里算好，再按 screen 叠上去。
      // 以前是 css 的 mix-blend-mode: screen：合成器每帧要多开一张全屏离屏图来混，冷启动时 GPU 本来就挤，
      // 实测那一下会让整个窗口停帧。两边的数要一起改
      '  vec2 W = R / K; float vm = max(W.x, W.y) / 100.;',
      '  float a1 = .10 * (1. - clamp(length((cp - W * vec2(.5, .46)) / (vec2(60., 45.) * vm)) / .62, 0., 1.));',
      '  float a2 = .07 * (1. - clamp(length((cp - W * vec2(.5, 1.2)) / (vec2(80., 60.) * vm)) / .60, 0., 1.));',
      '  vec3 bg = mix(vec3(7., 7., 10.) / 255., vec3(79., 123., 255.) / 255., a2);',
      '  bg = mix(bg, vec3(240., 166., 90.) / 255., a1);',
      '  col = clamp(col, 0., 1.);',
      '  gl_FragColor = vec4(bg + col - bg * col, 1.);',
      '}'
    ].join('\n');
  }

  // 猫脸贴图：r 是笔画本身，g 是 drop-shadow 那圈光晕。按屏幕上实际大小画，不缩放采样，边缘不闪
  // willReadFrequently = 用 CPU 画：GPU 画布的 blur 要等 GPU 主线程光栅化，冷启动实测一次占住它 145ms，
  // 那段时间整个窗口都不上屏。CPU 画在 Worker 自己线程里，第 0 帧之前就画完了
  function drawMark(mkCanvas, cssW, k) {
    var s = cssW * k / VB[2];
    var w = Math.max(2, Math.ceil(DOM[2] * s)), h = Math.max(2, Math.ceil(DOM[3] * s));
    var cv = mkCanvas(w, h), ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);    // 不透明黑底：通道里存的就是强度，上传时不被反乘 alpha
    ctx.setTransform(s, 0, 0, s, -DOM[0] * s, -DOM[1] * s);
    ctx.lineWidth = 30; ctx.lineCap = 'square'; ctx.lineJoin = 'miter'; ctx.miterLimit = 4;
    function strokes(color) {
      ctx.strokeStyle = color;
      for (var i = 0; i < MARK.length; i++) {
        var m = MARK[i];
        ctx.beginPath(); ctx.moveTo(m[0], m[1]);
        for (var j = 2; j < m.length; j += 2) ctx.lineTo(m[j], m[j + 1]);
        ctx.stroke();
      }
    }
    try { ctx.filter = 'blur(' + (7 * k).toFixed(1) + 'px)'; } catch (e) {}
    strokes('#0f0');
    try { ctx.filter = 'none'; } catch (e) {}
    ctx.globalCompositeOperation = 'lighter';
    strokes('#f00');
    return cv;
  }

  // opt: { w, h, k, rect:[x,y,w,h], still, mkCanvas, onFirst? }；开场起点用 .start(at) 给（绝对毫秒）
  function create(cv, opt) {
    var gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return null;
    function sh(type, src) { var o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; }
    var pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }'));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, shaderSrc()));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    var U = {};
    ['R', 'T', 'O', 'K', 'A', 'MA', 'M', 'GH', 'P', 'S', 'HM'].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
    var tex = gl.createTexture(), hasMark = 0, d = null, leaveAt = 0, done = false, firstSeen = false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U.S, 0);

    function size(nd) {
      d = nd; done = false;   // 尺寸变了至少重画一帧（减少动态效果时也是）
      var w = Math.max(1, Math.round(d.w * d.k)), h = Math.max(1, Math.round(d.h * d.k));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      hasMark = 0;
      if (d.rect && d.rect[2] > 0) {
        var img = drawMark(opt.mkCanvas, d.rect[2], d.k);
        if (img) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          hasMark = 1;
        }
      }
    }
    size(opt);

    function frame(abs) {
      if (done) return;
      // 起点由页面给（start）：画布要等主线程提交过一次才真的上屏，开机时主线程常常卡着，
      // Worker 自己从第一帧算的话，猫脸一露面已经画了一半（exe 实测晚了 0.5s）。没给之前停在第 0 帧（什么都看不见）
      if (!firstSeen) { firstSeen = true; if (opt.onFirst) opt.onFirst(); }
      var t = opt.still ? 3 : opt.origin == null ? 0 : Math.max(0, (abs - opt.origin) / 1000);
      var tl = timeline(opt.still ? END : t, leaveAt ? (abs - leaveAt) / 1000 : null);
      if (opt.still) tl.amp = 0;
      gl.uniform2f(U.R, cv.width, cv.height);
      gl.uniform1f(U.T, t); gl.uniform1f(U.O, tl.out); gl.uniform1f(U.K, d.k);
      gl.uniform1f(U.A, tl.amp); gl.uniform1f(U.MA, tl.alpha);
      gl.uniform4f(U.M, d.rect[0], d.rect[1], d.rect[2], d.rect[3]);
      gl.uniform3f(U.GH, tl.ghost[0], tl.ghost[1], tl.ghost[2]);
      gl.uniform1fv(U.P, tl.p);
      gl.uniform1f(U.HM, hasMark);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (opt.still && !leaveAt) done = true;            // 减少动态效果：画一帧就停
      if (leaveAt && abs - leaveAt > 900) done = true;   // 淡出完了
    }
    return {
      frame: frame,
      size: size,
      start: function (at) { if (opt.origin == null) opt.origin = at; },
      leave: function (at) { leaveAt = at; done = false; },
      get done() { return done; },
      free: function () { done = true; var x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); }
    };
  }

  var api = function (cv, opt) {
    opt.mkCanvas = opt.mkCanvas || function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    return create(cv, opt);
  };
  api.timeline = timeline;
  api.END = END;

  var inWorker = typeof WorkerGlobalScope !== 'undefined' && G instanceof WorkerGlobalScope;
  if (!inWorker) { api.src = '(' + bootWater + ')(self);\n'; G.GCBootWater = api; return; }

  // ── Worker 这边：收画布、自己推帧，主线程只在尺寸变了 / 要离场时发个消息
  var r = null, running = false;
  var now = function () { return performance.timeOrigin + performance.now(); };
  var raf = G.requestAnimationFrame ? function (f) { G.requestAnimationFrame(f); } : function (f) { setTimeout(f, 16); };
  // 最多 60 帧：165Hz 屏上每帧都画，GPU 被这张全屏画布吃满，页面后面一光栅化（冷启动还要现编着色器）
  // 整个窗口就排队停帧。exe 冷启动实测开场 3s 里停帧 1.3~1.5s → 限到 60 后 0.2~0.6s；限到 82 还是停 0.7~1.2s。
  // 时间按真实时钟算，少画几帧只是更稀，不会慢
  var last = 0;
  function loop() {
    if (!r) { running = false; return; }
    var t = now();
    if (t - last < 15) { raf(loop); return; }
    last = t;
    r.frame(t);
    running = !r.done;
    if (running) raf(loop);
  }
  function kick() { if (!running) { running = true; raf(loop); } }
  G.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'init') {
      var opt = m.d; opt.still = m.still;
      opt.onFirst = function () { G.postMessage('ready'); };
      opt.mkCanvas = function (w, h) { return new OffscreenCanvas(w, h); };
      try { r = create(m.canvas, opt); } catch (err) { r = null; }
      if (!r) { G.postMessage('fail'); return; }
      kick();
    } else if (m.type === 'start' && r) {
      r.start(m.at);
    } else if (m.type === 'size' && r) {
      r.size(m.d); kick();
    } else if (m.type === 'leave' && r) {
      r.leave(m.at); kick();
    }
  };
})(typeof self !== 'undefined' ? self : this);
