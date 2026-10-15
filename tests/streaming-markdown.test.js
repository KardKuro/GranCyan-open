const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'js', '05-prompts-api.js'), 'utf8');
const render = fs.readFileSync(path.join(root, 'js', '06-render-msg.js'), 'utf8');
const input = fs.readFileSync(path.join(root, 'js', '09-appearance-input.js'), 'utf8');

test('streaming rich text masks commands before parsing Markdown', () => {
  assert.match(input, /function renderStreamingRichText[\s\S]*renderRichText\(maskStreamingTags/);
});

test('all AI streaming paths render closed Markdown instead of exposing stars', () => {
  assert.match(api, /streaming && isLast[\s\S]{0,160}renderStreamingRichText\(b\.text\)/);
  assert.match(api, /fullText\s+\? renderStreamingRichText\(fullText\)/);
  assert.match(render, /content\s+\? renderStreamingRichText\(content\)/);
  assert.match(render, /v\.streaming \? renderStreamingRichText\(v\.content\|\|''\)/);
});

test('old plain-text streaming branches are gone', () => {
  assert.doesNotMatch(api, /escHtml\(maskStreamingTags\((?:b\.text|fullText)\)\) \+ '<span class="stream-cursor/);
  assert.doesNotMatch(render, /v\.streaming \? escHtml\(v\.content/);
});
