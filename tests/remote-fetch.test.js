'use strict';
const assert = require('node:assert/strict');
const { privateAddress, publicUrl } = require('../remote-fetch');
(async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.2.3', '192.168.1.2', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress('8.8.8.8'), false);
  await assert.rejects(publicUrl('http://localhost:3000/private'), /本机/);
  await assert.rejects(publicUrl('http://127.0.0.1:3000/private'), /本机|内网/);
  await assert.rejects(publicUrl('http://192.168.1.2/file'), /本机|内网/);
  await assert.rejects(publicUrl('file:///etc/passwd'), /http\/https/);
  await assert.rejects(publicUrl('https://user:pass@example.com/a'), /账号/);
  console.log('✅ remote fetch guard passed');
})().catch(e => { console.error(e); process.exit(1); });
