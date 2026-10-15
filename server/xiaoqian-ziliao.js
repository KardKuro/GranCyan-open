'use strict';
// ==========================================
// 本地微调模型（xiaoqian / cookie）的查资料：用户最后那句话里出现 资料/关键词.json 里的词，就把命中最多的两份资料附在那句话前面，
// 只附在发给 Ollama 的这一份请求里 —— 前端存的历史不动，资料不会一轮轮堆进上下文。
//
// 为什么不放进 system：这个模型是照一段固定的 SYSTEM 训出来的，差一个字就跑偏
// （实测：SYSTEM 末尾多加一句颜文字，回答就明显串题）。
// 资料目录由环境变量 GRANCYAN_XIAOQIAN_ZILIAO 指定，和训练侧的查资料脚本读同一份关键词表，规则一致。
// 每次请求现读文件：改了资料不用重打 exe。没配 / 目录不在就什么都不附，照常聊。
// ==========================================

const fs = require('fs');
const path = require('path');

const DIR = process.env.GRANCYAN_XIAOQIAN_ZILIAO || '';
const MAX_FILES = 2;
// r23 起改名饼干；这句和训练数据（gen.js 调的就是这个文件的 attach）必须一字不差
const HEAD = '【资料】下面是饼干的参考资料。和问题有关就以它为准，资料里没写的细节说不确定；和问题无关就当没看见，别提它。';

const norm = s => String(s)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全角数字转半角
    .replace(/\s+/g, '').toLowerCase();

// OpenAI 格式的 content 可能是字符串，也可能是 [{type:'text'},{type:'image_url'}] 数组
const textOf = c => typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n') : '';

function lookup(q, dir = DIR) {
    let kw;
    if (!dir) return [];
    try { kw = JSON.parse(fs.readFileSync(path.join(dir, '关键词.json'), 'utf8')); } catch { return []; }
    const t = norm(q);
    const hits = [];
    for (const [f, words] of Object.entries(kw)) {
        if (f.startsWith('_') || !Array.isArray(words)) continue;
        const n = words.filter(w => t.includes(norm(w))).length;
        if (n) hits.push({ n, f });
    }
    hits.sort((a, b) => b.n - a.n);   // 稳定排序：同分按关键词表里的顺序
    const out = [];
    for (const { f } of hits.slice(0, MAX_FILES)) {
        try { out.push({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').trim() }); } catch {}
    }
    return out;
}

// 返回 { messages, used }：messages 是新数组（不改传进来的），used 是附上的文件名
function attach(messages, dir = DIR) {
    const msgs = [...(messages || [])];
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i]?.role !== 'user') i--;
    if (i < 0) return { messages: msgs, used: [] };
    const docs = lookup(textOf(msgs[i].content), dir);
    if (!docs.length) return { messages: msgs, used: [] };
    const block = `${HEAD}\n\n${docs.map(d => `=== ${d.file} ===\n${d.text}`).join('\n\n')}\n\n【资料完】\n\n`;
    const c = msgs[i].content;
    const content = Array.isArray(c) ? [{ type: 'text', text: block }, ...c] : block + textOf(c);
    msgs[i] = { ...msgs[i], content };
    return { messages: msgs, used: docs.map(d => d.file) };
}

module.exports = { attach, lookup, norm };
