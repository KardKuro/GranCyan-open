#!/usr/bin/env node
/* 审计打出来的 asar：该排的排干净了没，该在的还在不在。
 *
 * 为什么要有这个脚本（2026-08-22 两次翻车换来的）：
 *  1. 只查"敏感文件在不在"是查不出问题的 —— 规则整个没生效时，结论看起来同样是"没查到"。
 *     所以必须有**对照组**：断言必需文件确实在包里。两组同时成立，结论才算数。
 *  2. asar 列表在 Windows 上是反斜杠路径，拿正斜杠去 grep 会全部落空，
 *     长得就像"敏感文件一个没有 + 必需文件一个也没有"这种自相矛盾的报告。这里统一成正斜杠。
 *
 * 用法：node scripts/audit-asar.js [dist目录名，默认 dist]
 */
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || 'dist';
const root = path.join(__dirname, '..');
const asar = path.join(root, out, 'Grancyan-win32-x64', 'resources', 'app.asar');

// ── 该排掉的 ───────────────────────────────────────────────
const FORBIDDEN = [
  [/^\/(key|cert)\.pem$/,            '本地 TLS 私钥'],
  [/^\/\.mcp-token$/,                'MCP 远程操控 token'],
  [/^\/\.pair-token$/,               '手机配对码（等同 /api 的钥匙）'],
  [/^\/grancyan\.keystore$/,         'APK 签名密钥库'],
  [/^\/\.env$/,                      '.env（观测坐标这类"住哪儿"的东西）'],
  [/^\/stickers-fav\//,              '用户的私人表情收藏'],
  [/^\/dist(-new|_build)?\//,        '嵌套的旧打包产物'],
  [/^\/(Gadgetbridge|coread)\.db/,   '本地数据库（手环 / 伴读）'],
  [/^\/nursery-saves\//,             '育儿室存档'],
  [/^\/android\//,                   '安卓工程（构建产物，白占体积）'],
  [/^\/history\//,                   '历史目录'],
  [/\.apk(\.idsig)?$/,               'APK'],
  [/^\/tests\/out\//,                '测试截图'],
];

// ── 对照组：这些必须在，否则上面那组的"没查到"毫无意义 ──────
const REQUIRED = [
  [/^\/server\.js$/,                    'server.js'],
  [/^\/electron-main\.js$/,             'electron-main.js'],
  [/^\/index\.html$/,                   'index.html'],
  [/^\/js\/40-engawa\.js$/,             '檐廊接入'],
  [/^\/social-browser\.js$/,            '浏览器通道（小红书/B 站）'],
  [/^\/js\/13-trash-ctx-ui\.js$/,       '星号修复所在文件'],
  [/^\/js\/lib\/marked\.min\.js$/,      '本地化的 marked'],
  [/^\/css\/lib\/katex\.min\.css$/,     '本地化的 KaTeX 样式'],
  [/^\/stickers\/[^/]+$/,               '内置表情素材'],
  [/^\/node_modules\/express\//,        'express 运行时依赖'],
  [/^\/node_modules\/better-sqlite3\//, 'better-sqlite3'],
];

(async () => {
  if (!fs.existsSync(asar)) {
    console.error(`✗ 找不到 ${asar}`);
    process.exit(1);
  }

  // @electron/asar 是 ESM-only 包，CJS 里只能动态 import
  const { listPackage } = await import('@electron/asar');
  const files = listPackage(asar, { isPack: false })
    .map(l => String(l).trim().replace(/\\/g, '/'))
    .filter(Boolean);

  console.log(`asar: ${path.relative(root, asar)}`);
  console.log(`条目: ${files.length}\n`);

  let fail = 0;
  const has = re => files.filter(f => re.test(f));

  console.log('【该排掉的】');
  for (const [re, label] of FORBIDDEN) {
    const hit = has(re);
    if (hit.length) {
      fail++;
      console.log(`  ✗ ${label} —— 混进包里了: ${hit.slice(0, 4).join(', ')}${hit.length > 4 ? ` …共 ${hit.length} 条` : ''}`);
    } else console.log(`  ✓ ${label}`);
  }

  console.log('\n【对照组 · 该在的】');
  for (const [re, label] of REQUIRED) {
    const hit = has(re);
    if (!hit.length) {
      fail++;
      console.log(`  ✗ ${label} —— 不见了，包是坏的（或者路径匹配写错了，上一组的结论同样不可信）`);
    } else console.log(`  ✓ ${label} (${hit.length})`);
  }

  console.log(`\n${fail ? '❌' : '✅'} ${fail ? fail + ' 项不合格' : '两组都成立，审计通过'}`);
  process.exit(fail ? 1 : 0);
})();
