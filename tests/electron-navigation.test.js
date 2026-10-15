const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('Electron external navigation stays outside the chat window', () => {
  assert.match(source, /function isExternalHttpUrl\(rawUrl\)/);
  assert.match(source, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(source, /url\.hostname !== '127\.0\.0\.1'/);
  assert.match(source, /url\.hostname !== 'localhost'/);
  assert.match(source, /setWindowOpenHandler\([\s\S]*?isExternalHttpUrl\(url\)[\s\S]*?shell\.openExternal\(url\)/);
  assert.match(source, /will-navigate[\s\S]*?isExternalHttpUrl\(url\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?shell\.openExternal\(url\)/);
});

test('the feature guide explains desktop external links', () => {
  assert.match(html, /打开外部链接（exe）/);
  assert.match(html, /系统默认浏览器打开/);
});

test('the feature guide includes vitals and dreams', () => {
  assert.match(html, /AI 生命体征/);
  assert.match(html, /允许自主心跳/);
  assert.match(html, /梦境陈列室/);
  assert.match(html, /梦境独立保存，不会混进普通记忆/);
});
