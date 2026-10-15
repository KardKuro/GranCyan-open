const fs = require('fs');
const path = require('path');
const assert = require('assert');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

assert.match(source, /async function outboundProxyPort\(\)/,
    '代理端口探测应能被普通 HTTP 请求和 Codex 子进程共同复用');
assert.match(source, /const gptProxyPort = await outboundProxyPort\(\)/,
    '启动 Codex 前应探测当前仍在监听的本地代理');
assert.match(source, /\['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'\]/,
    'Codex 子进程应同时获得大小写两套代理环境变量');
assert.match(source, /env\[key\] = proxyUrl/,
    '探测到代理后应把代理 URL 写入 Codex 子进程环境');

console.log('local-gpt-proxy tests passed');
