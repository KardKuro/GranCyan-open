/* 云设置失败不能刷屏：永久 4xx 只试一次，临时网络/5xx 才重试。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readSingleSrc } = require('./_src-map');

const ROOT = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'js/01-core.js'), 'utf8');
// 云同步(cloud-profile 在内)已搬进 server/cloud.js（docs/server-split-plan.md
// Phase 1 收尾块），经 readSingleSrc('cloud') 取当前真实位置，逻辑名不改，
// 映射表在 tests/_src-map.js 里改。
const server = readSingleSrc('cloud').text;
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const from = core.indexOf('function cloudError(');
const to = core.indexOf('function stripNullBytes(');
if (from < 0 || to < 0) throw new Error('云同步 helper 段锚点变了');
const sandbox = {
  console,
  navigator: { onLine: true },
  setTimeout: fn => { fn(); return 1; },
  clearTimeout() {},
  Promise, Error, Number, String,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(core.slice(from, to)
  + '\nthis.cloudRetry = cloudRetry; this.cloudError = cloudError; this.isRetryableCloudError = isRetryableCloudError;', sandbox);

(async () => {
  let attempts = 0;
  try {
    await sandbox.cloudRetry(() => { attempts++; throw sandbox.cloudError('bad row', 400); });
  } catch {}
  ok(attempts === 1, 'HTTP 400 是永久错误，只执行一次');

  attempts = 0;
  try {
    await sandbox.cloudRetry(() => { attempts++; throw sandbox.cloudError('upstream down', 502); });
  } catch {}
  ok(attempts === 3, 'HTTP 502 是临时错误，按上限重试');
  ok(sandbox.isRetryableCloudError(new Error('Failed to fetch')), '断网错误允许重试');
  ok(!sandbox.isRetryableCloudError(sandbox.cloudError('unauthorized', 401)), 'HTTP 401 不重试');

  const profileStart = server.indexOf("app.get('/api/cloud-profile'");
  const profileEnd = server.indexOf('// 云端文件中转', profileStart);
  const routes = server.slice(profileStart, profileEnd);
  ok((routes.match(/validateStatus: \(\) => true/g) || []).length === 2,
    'cloud-profile GET/POST 都保留上游响应，不让 axios 把 4xx 改写成 502');
  ok(routes.includes('res.status(response.status).json(response.data)'),
    '代理向前端透传 Supabase 状态码与错误正文');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
