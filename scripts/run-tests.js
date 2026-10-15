'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(x => x.endsWith('.test.js')).sort();
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const r = spawnSync(process.execPath, [path.join(root, 'tests', file)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`\n✅ ${files.length} 个测试文件全部通过`);
