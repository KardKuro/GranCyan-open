'use strict';
// TTS 合成缓存：条数 + 总字节双封顶的 LRU。切 server.js 里真实的缓存源码进 vm 跑。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function sourceBetween(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('切不出源码片段：' + from + ' → ' + to);
  return src.slice(a, b);
}
const cacheSrc = sourceBetween(serverSrc, 'const _ttsCache = new Map();', 'const DEEPGRAM_TTS_KEY_FILE');

function load(env) {
  const box = { Buffer, Number, Math, process: { env: env || {} } };
  vm.createContext(box);
  vm.runInContext(cacheSrc + '\nthis.__c = { cache: _ttsCache, get: ttsCacheGet, put: ttsCachePut, bytes: () => _ttsCacheBytes, max: TTS_CACHE_MAX_BYTES, maxN: TTS_CACHE_MAX };', box);
  return box.__c;
}

let fail = 0;
function t(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const buf = n => Buffer.alloc(n);

// 默认上限
{
  const c = load({});
  t('默认总字节上限 48MB', c.max === 48 * 1024 * 1024, c.max);
  const bad = load({ GRANCYAN_TTS_CACHE_BYTES: 'abc' });
  t('环境变量非法时回落默认', bad.max === 48 * 1024 * 1024, bad.max);
}

// 按字节淘汰最久没用的
{
  const c = load({ GRANCYAN_TTS_CACHE_BYTES: '1000' });
  t('环境变量可覆盖上限', c.max === 1000, c.max);
  c.put('a', buf(400));
  c.put('b', buf(400));
  c.get('a');                    // a 变成最近用过
  c.put('c', buf(400));          // 1200 > 1000 → 踢最久没用的 b
  t('超字节上限时按 LRU 踢（踢 b 留 a、c）', c.cache.has('a') && !c.cache.has('b') && c.cache.has('c'), [...c.cache.keys()]);
  t('字节计数与实际一致', c.bytes() === 800, c.bytes());
  t('总字节不超过上限', c.bytes() <= c.max, c.bytes());

  c.put('huge', buf(1001));
  t('单条比上限还大：不缓存，也不把别的挤掉', !c.cache.has('huge') && c.cache.has('a') && c.cache.has('c') && c.bytes() === 800, { keys: [...c.cache.keys()], bytes: c.bytes() });

  c.put('a', buf(100));          // 同 key 覆盖：旧的字节要扣掉
  t('同 key 覆盖时字节按新值记', c.bytes() === 500 && c.cache.get('a').length === 100, c.bytes());

  c.put('c', buf(5000));         // 同 key 换成超大：旧条目也要清掉，计数不能漂
  t('同 key 换成超大条目：旧的也移除、计数正确', !c.cache.has('c') && c.bytes() === 100, { keys: [...c.cache.keys()], bytes: c.bytes() });
}

// 条数上限照旧
{
  const c = load({});
  for (let i = 0; i < c.maxN + 5; i++) c.put('k' + i, buf(10));
  t('条数上限仍然生效', c.cache.size === c.maxN && !c.cache.has('k0') && c.bytes() === c.maxN * 10, { size: c.cache.size, bytes: c.bytes() });
}

// 长文本场景：300 条 × 3MB 以前会常驻 ~900MB
{
  const c = load({});
  for (let i = 0; i < 40; i++) c.put('long' + i, buf(3 * 1024 * 1024));
  t('长文本大条目不会让缓存涨过 48MB', c.bytes() <= c.max && c.cache.size === 16, { size: c.cache.size, mb: c.bytes() / 1048576 });
}

if (fail) { console.error(`\n${fail} 项失败`); process.exit(1); }
console.log('\ntts-cache-bytes: 全部通过');
