'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rejectUnsafeEpub } = require('../epub-guard');
const file = path.join(os.tmpdir(), `grancyan-bad-${process.pid}.epub`);
try {
  fs.writeFileSync(file, Buffer.from('not a zip'));
  assert.throws(() => rejectUnsafeEpub(file), /ZIP/);
  console.log('✅ epub guard passed');
} finally { try { fs.unlinkSync(file); } catch {} }
