// 手环数据默认关。跑法：node tests/band-optin.test.js
//
// 电脑端那条链路会对连着的手机跑 adb（拉起 Gadgetbridge、发广播、pull 数据库），
// 所以前后端都必须显式打开才动：
//   · 前端：state.bandAutoFetch 默认 false，启动时和定时器里都不请求 /api/band-data
//   · 开关过三道持久化白名单（_doSave / loadStateFromDB / 启动赋值），且只存本机不上云
//   · 后端：没设 GRANCYAN_BAND_DB_REMOTE 就回「未启用」（行为由 tests/server-fixes.test.js [I] 真跑守着）

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name, extra ?? '')); };

const stateJs = read('js/02-state.js'), core = read('js/01-core.js'), boot = read('js/14-boot-brain-hub.js');
const html = read('index.html'), band = read('server/band.js');

console.log('\n[1] 默认关 + 三道持久化');
t('★ 出厂默认 bandAutoFetch: false', /bandAutoFetch: false,/.test(stateJs));
t('第 1 道：_doSave 写盘', /idbSet\('kuro_bandAuto',\s*JSON\.stringify\(state\.bandAutoFetch === true\)\)/.test(stateJs));
t('第 2 道：loadStateFromDB 读回来（缺省 false）', /bandAutoFetch: await g\('kuro_bandAuto', false\)/.test(core));
t('第 3 道：启动赋进 state（只认 true）', /state\.bandAutoFetch\s*=\s*saved\.bandAutoFetch === true;/.test(boot));
t('只存本机：云同步上下行都不带它', !/bandAutoFetch/.test(core.replace(/bandAutoFetch: await g\('kuro_bandAuto', false\)/, '')));

console.log('\n[2] 真跑：启动那段只在打开时才请求');
{
  const a = boot.indexOf('  async function fetchBandData() {');
  const b = boot.indexOf('  setInterval(fetchBandData, 120000);');
  t('抽得到 fetchBandData 那段（锚点没漂）', a > 0 && b > a);
  const run = (on) => {
    const calls = [];
    const box = {
      state: { bandAutoFetch: on }, SERVER_BASE: 'http://127.0.0.1:1',
      fetch: async (u) => { calls.push(u); return { json: async () => ({ ok: false }) }; },
      document: { getElementById: () => null }, renderBandPanel: () => {},
    };
    vm.createContext(box);
    vm.runInContext(boot.slice(a, b), box);
    return calls;
  };
  t('★ 默认（false）：一次都不请求 /api/band-data', run(false).length === 0);
  t('★ 存了个怪值（"true" 字符串）也不算打开', run('true').length === 0);
  t('打开（true）：请求了 /api/band-data', run(true).some(u => /\/api\/band-data$/.test(u)));
}

console.log('\n[3] 界面开关');
t('手环面板里有「自动同步」开关', /id="bandAutoToggle"[^>]*onchange="state\.bandAutoFetch=this\.checked;save\(\)/.test(html));
t('三个回填点都同步了勾选状态',
  /getElementById\('bandAutoToggle'\)/.test(read('js/07-band-tts.js'))
  && (boot.match(/getElementById\('bandAutoToggle'\)/g) || []).length === 2);

console.log('\n[4] 后端：不配就不动 adb，落盘不进项目根目录');
t('★ 没配 GRANCYAN_BAND_DB_REMOTE → 路由开头直接回 not-configured',
  /if \(!BAND_ENABLED\) \{\s*return res\.json\(\{ ok: false, stage: 'not-configured'/.test(band)
  && band.indexOf("stage: 'not-configured'") < band.indexOf('await pullBandData('));
t('手机上的路径不再写死', !/\/storage\/emulated\/0\//.test(band));
t('本地落盘在数据目录（GRANCYAN_BAND_DIR / ~/.grancyan/band），不用 ROOT',
  /const DB_LOCAL = path\.join\(BAND_DIR, 'Gadgetbridge\.db'\)/.test(band) && !/path\.join\(ROOT, 'Gadgetbridge\.db'\)/.test(band));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
