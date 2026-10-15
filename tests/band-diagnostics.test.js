// 手环数据链路的回归测试。
// 跑法：node tests/band-diagnostics.test.js
//
// 守的是这个反复复发的坑：手环数据这条链上有六种完全不同的故障
// （adb 没装 / 没连手机 / 手机没授权 / Gadgetbridge 被 ROM 杀了 / GB 的意图开关没开 /
//   adb pull 失败），以前**全部**被压成同一句「暂无手环数据，请确认手机已通过USB连接」。
// 结果就是每隔一阵子来一句「手环怎么又不可用了」，而界面上一点线索都没有，
// 每次都得从 adb devices 一路手工查到 GB 的开发者选项。
//
// 所以这里守两件事：
//   1. server 端每一步失败都得留下自己的 stage + 人话 msg + 「该去动什么」的 hint；
//   2. 前端真的把 hint 显示出来，并且「有数字但数字是旧的」也要有横幅 —— 那种情况
//      以前会安安静静显示成正常数据，等她发现步数不对已经过去好几天了。
const fs = require('fs'), path = require('path');
const { readSingleSrc } = require('./_src-map');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

// 手环后端已搬进 server/band.js（docs/server-split-plan.md Phase 1 第三块），
// 经 readSingleSrc('band') 取当前真实位置，逻辑名一条不改，映射表在 tests/_src-map.js 里改。
const server = readSingleSrc('band').text;
const band = read('js/07-band-tts.js');
const html = read('index.html');
const css = read('css/grancyan.css');

console.log('\n[1] server 每一步失败都留下 stage / msg / hint');
t('有 bandFail 这个统一出口', /function bandFail\(stage, msg, hint\)/.test(server));
t('失败时不丢缓存（有旧数据先顶着）', /function bandFail[\s\S]{0,300}return bandCache\.data;/.test(server));
t('走通了会把上次卡在哪忘掉', /bandLastFail = null;/.test(server));
// 六个阶段逐个点名 —— 少一个就等于那种故障又退回「笼统一句话」
for (const [stage, what] of [
  ['adb-missing', 'adb 根本不在那个路径'],
  ['adb-dead', 'adb 起不来'],
  ['no-device', '一台设备都没连上'],
  ['unauthorized', '手机没授权这台电脑'],
  ['gb-not-running', 'Gadgetbridge 拉不起来'],
  ['pull-failed', 'adb pull 拉不下来'],
  ['db-read-failed', '读 DB 失败'],
]) {
  t(`认得「${what}」（stage=${stage}）`, new RegExp(`bandFail\\('${stage}'`).test(server));
}
t('设备状态不是 device 的（offline 等）也单独报',
  /bandFail\('device-' \+ dev\.state/.test(server));

console.log('\n[2] 设备状态是**查**出来的，不是等 pull 失败才猜');
t('有 adbDeviceState()', /function adbDeviceState\(\)/.test(server));
t('先看 adb 这个 exe 在不在', /if \(!fs\.existsSync\(ADB_EXE\)\) return \{ state: 'adb-missing' \}/.test(server));
t('解析 adb devices 的输出（跳过表头那行）',
  /adbOut\('devices'\)/.test(server) && /\.split\('\\n'\)\.slice\(1\)/.test(server));
t('设备检查排在拉起 Gadgetbridge 之前',
  server.indexOf('adbDeviceState()') < server.indexOf("Gadgetbridge 未运行，正在拉起"));
// ⚠️ 别把 `await` 写死进这个正则。这条守的是**行为**（拉起之后再确认一次），
//   而不是 adbOut 是同步还是异步 —— 2026-08-28 把 adb 全改成异步（修「窗口未响应」）
//   时这条红了，红的原因跟它要守的东西无关。
//   「每个 adb 调用点都带 await」由 tests/band-async.test.js 单独守着，别在这儿重复。
t('拉起 GB 之后再确认一次真的活了',
  /await new Promise\(r => setTimeout\(r, 4000\)\);\s*\n\s*if \(!(?:await\s+)?adbOut\('shell', 'pidof', GB_PKG\)\)/.test(server));

console.log('\n[3] 导出没触发是「警告」不是「失败」（手机上还有旧文件能用）');
t('导出没触发时记 warn 而不是 fail',
  /bandLastWarn = exported \? null : \{/.test(server) && /stage: 'export-not-triggered'/.test(server));
t('warn 的 hint 直接指到 GB 的意图接口开关',
  /意图接口[\s\S]{0,80}活动同步触发器/.test(server));

console.log('\n[4] 接口把这些原样递给前端');
t('失败时回 stage/msg/hint（不再是写死的一句）',
  /const f = bandLastFail \|\| \{ stage: 'unknown'/.test(server)
  && /res\.json\(\{ ok: false, \.\.\.f \}\)/.test(server)
  && !/ok: false, msg: '暂无手环数据，请确认手机已通过USB连接'/.test(server));
t('成功但数据是旧的 → 带 stale；导出没触发 → 带 warn',
  /stale: bandLastFail \|\| undefined, warn: bandLastWarn \|\| undefined/.test(server));

console.log('\n[5] 前端真的把它显示出来');
t('失败面板显示 hint（「该去动什么」）', /bd\?\.hint \? `<span[\s\S]{0,80}escHtml\(bd\.hint\)/.test(band));
t('有数字但数字是旧的 → 横幅',
  /const trouble = bd\.stale \|\| bd\.warn;/.test(band)
  && /trouble \? `<div class="band-trouble">/.test(band)
  && /escHtml\(trouble\.hint\)/.test(band));
t('横幅样式在，且是琥珀色不是红色（不吓人）',
  /\.band-trouble \{/.test(css) && /color:#d4c084/.test(css));

console.log('\n[6] 手环数据挪进小组件');
t('小组件网格里有手环入口', /widget-item[^>]*openHubSection\('band','widgets'\)/.test(html));
t('图标和名字都在', /<span class="widget-icon">⌚<\/span><span class="widget-copy"><b>手环数据<\/b>/.test(html));
t('左边导航栏里那个已经撤了', !/hub-nav-btn" data-hub="band"/.test(html));
t('但 hub section 本身还在（入口换了位置，功能没搬家）',
  /band:\s+\{ sel:'#bandModal > \.memory-panel'/.test(read('js/14-boot-brain-hub.js'))
  && /band:'手环数据'/.test(read('js/14-boot-brain-hub.js')));

console.log('\n[7] 桌面与安卓副本一致');
for (const f of ['js/07-band-tts.js', 'js/14-boot-brain-hub.js', 'css/grancyan.css']) {
  const a = path.join(ROOT, f);
  const b = path.join(ROOT, 'android/assets', f.replace(/^js\//, 'js/').replace(/^css\//, 'css/'));
  t(`android 副本与 ${f} 一致`, fs.readFileSync(a).equals(fs.readFileSync(b)));
}
t('android 的 index.html 也同步了',
  fs.readFileSync(path.join(ROOT, 'index.html'))
    .equals(fs.readFileSync(path.join(ROOT, 'android/assets/index.html'))));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
