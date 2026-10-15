'use strict';

const dns = require('node:dns');
const net = require('node:net');
const axios = require('axios');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function privateAddress(address) {
  let ip = String(address || '').trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const family = net.isIP(ip);
  if (family === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  if (family === 6) {
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
      /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  }
  return true;
}

async function publicUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('地址格式不合法'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许 http/https 地址');
  if (url.username || url.password) throw new Error('地址里不能携带账号或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址');
  const literal = net.isIP(host);
  const found = literal ? [{ address: host, family: literal }] : await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!found.length || found.some(x => privateAddress(x.address))) throw new Error('不允许访问本机或内网地址');
  return url;
}

async function fetchRemoteBuffer(raw, options = {}) {
  const maxBytes = Number(options.maxBytes) || 12 * 1024 * 1024;
  let url = await publicUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await axios({
      url: url.href, method: 'get', responseType: 'arraybuffer',
      timeout: Number(options.timeout) || 20000,
      maxRedirects: 0, maxContentLength: maxBytes, maxBodyLength: maxBytes,
      validateStatus: () => true,
      httpsAgent: options.httpsAgent, headers: options.headers,
    });
    if (!REDIRECTS.has(response.status)) return response;
    if (hop === 3) throw new Error('远程地址重定向次数过多');
    const location = response.headers.location;
    if (!location) throw new Error('远程地址返回了没有目标的重定向');
    url = await publicUrl(new URL(location, url).href);
  }
  throw new Error('远程地址重定向次数过多');
}

module.exports = { privateAddress, publicUrl, fetchRemoteBuffer };
