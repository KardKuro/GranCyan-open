#!/usr/bin/env node
// mcp-github.js —— 给本地 Claude 的「看 GitHub」能力（stdio MCP 服务器）
//
// 为什么不直接用 WebFetch：
//   CC 的 WebFetch 会把抓到的页面丢给一个小模型做摘要再交回来，读代码必然失真
//   （行号没了、缩进没了、长文件被概括掉）。要「像 cc 一样检索」就得拿到原文。
//   这里全部走 GitHub 官方 API + raw，原样返回，带行号。
//
// 挂载方式：server.js 在 spawn claude 时传 --mcp-config，见 /api/chat/local 那段。
// 手动调试：node mcp-github.js  然后往 stdin 贴 JSON-RPC（一行一条）。
//
// 限速：未认证 60 次/小时。要更多就设环境变量 GITHUB_TOKEN，
//       或在项目根放一个 .github-token 文件（只读 public repo 的 fine-grained token 就够）。
//       ⚠️ 别把 token 提交进仓库。

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const TIMEOUT = 20000;
const MAX_CHARS = 24000;   // 单次返回给模型的上限，超了截断并注明
const MAX_LINES = 400;     // read_file 默认最多给多少行

// ── token（可选） ──────────────────────────────────────────
function loadToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
    try {
        const t = fs.readFileSync(path.join(__dirname, '.github-token'), 'utf8').trim();
        if (t) return t;
    } catch (_) { /* 没有就匿名跑，60 次/小时 */ }
    return '';
}
const TOKEN = loadToken();

function headers(accept) {
    const h = {
        'User-Agent': 'Grancyan-GitHub-MCP',
        'Accept': accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
    return h;
}

// GitHub 的错误信息比 axios 的 "Request failed with status code 404" 有用得多，
// 尤其是限速（403 + 一句 rate limit exceeded），照原样递给模型它才知道该等还是该换招。
async function gh(url, accept) {
    try {
        const r = await axios.get(url, { headers: headers(accept), timeout: TIMEOUT, responseType: 'text', transformResponse: x => x });
        return { ok: true, body: r.data, headers: r.headers };
    } catch (e) {
        const st = e.response && e.response.status;
        let msg = e.message;
        if (e.response && e.response.data) {
            try { msg = JSON.parse(e.response.data).message || msg; } catch (_) { msg = String(e.response.data).slice(0, 300); }
        }
        if (st === 403 && /rate limit/i.test(msg)) {
            const reset = e.response.headers['x-ratelimit-reset'];
            const when = reset ? new Date(reset * 1000).toLocaleTimeString('zh-CN') : '稍后';
            msg = `GitHub API 限速了（匿名 60 次/小时），${when} 恢复。${TOKEN ? '' : '想提额可以在项目根放 .github-token。'}`;
        }
        return { ok: false, status: st, error: msg };
    }
}

function json(body) { try { return JSON.parse(body); } catch (_) { return null; } }

function clip(s, max) {
    max = max || MAX_CHARS;
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n…（已截断，原文还有 ${s.length - max} 个字符）`;
}

// "owner/repo"、完整 URL、带 .git 的，统统认
// ⚠️ 字符集里含 `.`，所以 `..` 也是合法的 owner —— `repo="../../torvalds/linux"` 会被
//    解析成 `../..`，拼进 URL 后 fetch 一规范化就跑去打 https://api.github.com/ 了。
//    GitHub 的用户名/仓库名本来就不可能是纯点，直接把点段拒掉。
function parseRepo(repo) {
    if (!repo) return null;
    let s = String(repo).trim();
    s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '');
    const m = s.match(/^([\w.-]+)\/([\w.-]+)/);
    if (!m) return null;
    const owner = m[1], name = m[2];
    if (/^\.+$/.test(owner) || /^\.+$/.test(name)) return null;
    return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

// repo / path / ref 全是模型给的，直接往 URL 里拼会出事：
//   - encodeURI **不编码** ? 和 #，一个 `README.md?ref=x` 就能改写查询参数；
//   - 更狠的是 `../../torvalds/linux/contents/README` —— fetch 会规范化路径，
//     结果跑去读了另一个仓库。都是公开只读数据，但这属于「参数没管住」，不能留。
// 逐段 encodeURIComponent，并且直接拒掉 .. 和绝对路径。
function safePath(p) {
    const segs = String(p || '').replace(/^\/+/, '').split('/').filter(s => s !== '' && s !== '.');
    if (segs.some(s => s === '..')) return null;
    return segs.map(encodeURIComponent).join('/');
}
// 分支名可以带斜杠（feature/x），所以按段编码而不是整串 encodeURIComponent
const safeRef = r => safePath(r);

// ── 工具实现 ───────────────────────────────────────────────

async function repoOverview({ repo }) {
    const full = parseRepo(repo);
    if (!full) return `参数 repo 不对：${repo}。写成 owner/name（如 P0luz/Ombre-Brain）或仓库链接。`;

    const info = await gh(`${API}/repos/${full}`);
    if (!info.ok) return `读不到 ${full}：${info.error}`;
    const d = json(info.body) || {};

    const out = [
        `# ${d.full_name}`,
        d.description ? `> ${d.description}` : '',
        `语言 ${d.language || '—'} ｜ ★ ${d.stargazers_count} ｜ 默认分支 ${d.default_branch} ｜ 更新于 ${(d.pushed_at || '').slice(0, 10)}`,
        d.license && d.license.spdx_id ? `许可证 ${d.license.spdx_id}` : '',
        d.homepage ? `主页 ${d.homepage}` : '',
        '',
    ];

    const tree = await gh(`${API}/repos/${full}/contents/`);
    if (tree.ok) {
        const items = json(tree.body) || [];
        out.push('## 根目录', items.map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}${i.type === 'file' ? ` (${i.size}B)` : ''}`).join('\n'), '');
    }

    const rd = await gh(`${API}/repos/${full}/readme`, 'application/vnd.github.raw');
    if (rd.ok) out.push('## README', clip(rd.body, 10000));
    else out.push('（这个仓库没有 README）');

    return clip(out.filter(Boolean).join('\n'));
}

async function listFiles({ repo, path: p, ref }) {
    const full = parseRepo(repo);
    if (!full) return `参数 repo 不对：${repo}`;
    const sub = safePath(p);
    if (sub === null) return `路径里不能带 ..：${p}`;
    const url = `${API}/repos/${full}/contents/${sub}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
    const r = await gh(url);
    if (!r.ok) return `列不出 ${full}/${sub}：${r.error}`;
    const items = json(r.body);
    if (!Array.isArray(items)) return `${sub} 是个文件不是目录，用 read_file 读它。`;
    if (!items.length) return `${full}/${sub} 是空目录。`;
    const lines = items
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
        .map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.path}${i.type === 'file' ? `  (${i.size}B)` : ''}`);
    return clip(`${full}${sub ? '/' + sub : ''}${ref ? ` @${ref}` : ''} 共 ${items.length} 项：\n` + lines.join('\n'));
}

async function readFile({ repo, path: p, ref, start, end }) {
    const full = parseRepo(repo);
    if (!full) return `参数 repo 不对：${repo}`;
    if (!p) return '要读哪个文件？path 是必填的（如 src/index.js）。';
    const sub = safePath(p);
    if (!sub) return `路径不对（不能为空、不能带 ..）：${p}`;

    // 先走 raw：不吃 API 限速，也不会把文件 base64 一遍
    let branch = ref ? safeRef(ref) : '';
    if (ref && !branch) return `分支名不对：${ref}`;
    if (!branch) {
        const info = await gh(`${API}/repos/${full}`);
        if (!info.ok) return `读不到 ${full}：${info.error}`;
        branch = safeRef((json(info.body) || {}).default_branch) || 'main';
    }
    const r = await gh(`${RAW}/${full}/${branch}/${sub}`, 'text/plain');
    if (!r.ok) return `读不到 ${full}/${sub} @${branch}：${r.error}（路径或分支写错了？可以先用 list_files 看看）`;

    const all = String(r.body).split('\n');
    const from = Math.max(1, parseInt(start, 10) || 1);
    const to = Math.min(all.length, parseInt(end, 10) || from + MAX_LINES - 1);
    const body = all.slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}\t${l}`)
        .join('\n');
    const more = to < all.length ? `\n…（本文件共 ${all.length} 行，这里只给了 ${from}-${to}；要后面的就再调一次并传 start/end）` : '';
    return clip(`${full}/${sub} @${branch}（${from}-${to} / 共 ${all.length} 行）\n${body}${more}`);
}

async function searchCode({ query, repo }) {
    if (!query) return '要搜什么？query 是必填的。';
    if (!TOKEN) {
        return 'GitHub 的代码搜索接口必须认证才能用，现在是匿名模式。\n' +
            '替代打法：用 list_files 摸清目录结构，再用 read_file 精读；或者用 search_repos 找别的仓库。\n' +
            '想开代码搜索：在项目根放一个 .github-token（只读 public repo 的 token 就够）。';
    }
    const full = parseRepo(repo);
    const q = full ? `${query} repo:${full}` : query;
    const r = await gh(`${API}/search/code?q=${encodeURIComponent(q)}&per_page=15`, 'application/vnd.github.text-match+json');
    if (!r.ok) return `搜不动：${r.error}`;
    const d = json(r.body) || {};
    if (!d.total_count) return `「${q}」没搜到东西。`;
    const lines = (d.items || []).map(it => {
        const frag = (it.text_matches || []).map(m => (m.fragment || '').trim().replace(/\n+/g, ' ⏎ ')).join(' … ');
        return `📄 ${it.repository.full_name}/${it.path}${frag ? `\n    ${frag.slice(0, 300)}` : ''}`;
    });
    return clip(`「${q}」命中 ${d.total_count} 处，前 ${lines.length} 条：\n` + lines.join('\n'));
}

async function searchRepos({ query, sort }) {
    if (!query) return '要搜什么？query 是必填的。';
    const s = sort === 'updated' ? '&sort=updated' : sort === 'stars' ? '&sort=stars' : '';
    const r = await gh(`${API}/search/repositories?q=${encodeURIComponent(query)}${s}&per_page=10`);
    if (!r.ok) return `搜不动：${r.error}`;
    const d = json(r.body) || {};
    if (!d.total_count) return `「${query}」没搜到仓库。`;
    const lines = (d.items || []).map(it =>
        `${it.full_name}  ★${it.stargazers_count}  ${it.language || '—'}\n    ${it.description || '（没写描述）'}`);
    return clip(`「${query}」共 ${d.total_count} 个仓库，前 ${lines.length} 个：\n` + lines.join('\n'));
}

// ── MCP 协议（stdio JSON-RPC 2.0） ─────────────────────────
// 手写而不引 SDK：这五个只读工具用不着依赖，少一个包 exe 就少一份体积。

const TOOLS = [
    {
        name: 'repo_overview',
        description: 'GitHub 仓库概览：描述、语言、star、默认分支、根目录文件列表和 README 全文。看一个不熟的库先调这个。',
        inputSchema: {
            type: 'object',
            properties: { repo: { type: 'string', description: 'owner/name，或直接给仓库链接' } },
            required: ['repo'],
        },
    },
    {
        name: 'list_files',
        description: '列出仓库里某个目录的文件和子目录（不传 path 就是根目录）。用来摸清项目结构。',
        inputSchema: {
            type: 'object',
            properties: {
                repo: { type: 'string', description: 'owner/name' },
                path: { type: 'string', description: '目录路径，如 src/utils；不传=根目录' },
                ref: { type: 'string', description: '分支/tag/commit，不传用默认分支' },
            },
            required: ['repo'],
        },
    },
    {
        name: 'read_file',
        description: '读仓库里某个文件的原文，逐行带行号。默认给前 400 行，长文件用 start/end 翻页。',
        inputSchema: {
            type: 'object',
            properties: {
                repo: { type: 'string', description: 'owner/name' },
                path: { type: 'string', description: '文件路径，如 src/index.js' },
                ref: { type: 'string', description: '分支/tag/commit，不传用默认分支' },
                start: { type: 'number', description: '起始行号（从 1 开始）' },
                end: { type: 'number', description: '结束行号' },
            },
            required: ['repo', 'path'],
        },
    },
    {
        name: 'search_code',
        description: '在 GitHub 上搜代码，可用 repo 参数限定在某个仓库内。需要配置 token，没配会告诉你怎么办。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' },
                repo: { type: 'string', description: '限定仓库 owner/name，不传就是全站搜' },
            },
            required: ['query'],
        },
    },
    {
        name: 'search_repos',
        description: '按关键词搜 GitHub 仓库，返回名字、star、语言和描述。找轮子用这个。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词，支持 language:python stars:>100 这类限定符' },
                sort: { type: 'string', description: 'stars 或 updated，不传按相关度' },
            },
            required: ['query'],
        },
    },
];

const HANDLERS = { repo_overview: repoOverview, list_files: listFiles, read_file: readFile, search_code: searchCode, search_repos: searchRepos };

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
    const { id, method, params } = msg;
    // 通知（没有 id）不需要也不允许回复，回了对面会当成协议错误
    if (id === undefined || id === null) return;

    if (method === 'initialize') {
        return send({
            jsonrpc: '2.0', id, result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'github', version: '1.0.0' },
            }
        });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
        const fn = HANDLERS[params && params.name];
        if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `没有这个工具：${params && params.name}` } });
        let text;
        try {
            text = await fn(params.arguments || {});
        } catch (e) {
            // 抛给协议层会让整轮对话失败，包成正常返回让模型自己决定换招
            text = `工具执行出错：${e.message}`;
        }
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
    }
    // resources/prompts 这些没实现，按协议回 method not found 而不是装死
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
}

let buf = '';
let inflight = 0;
let stdinDone = false;
// stdin 一关就 exit(0) 的话，最后一条还在等 GitHub 返回的请求会被连人带回复一起扔掉
// （管道调试时表现为「最后一条命令没有任何输出」）。等手上的活干完再走。
function maybeExit() { if (stdinDone && inflight === 0) process.exit(0); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        inflight++;
        handle(msg)
            .catch(e => { try { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); } catch (_) {} })
            .finally(() => { inflight--; maybeExit(); });
    }
});
process.stdin.on('end', () => { stdinDone = true; maybeExit(); });
