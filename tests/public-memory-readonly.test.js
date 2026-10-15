// 公开记忆（state.memories）对模型**只读**。
//
// 用户要求：模型一直在往公开记忆里写她的私人事情，而这块是**所有模型
// 都看得见**的。写入权收回给她自己（设置里手动加），模型只能读。
//
// 这件事坏掉的时候是**完全静默**的：模型照样写、界面照样显示一个「存储记忆」的块、
// 一个报错都没有 —— 只有她某天翻记忆列表才会发现私事又躺在那儿了。
// 所以下面第一组用的是**反向断言**：不去枚举「哪些写法被堵住了」（枚举必然漏），
// 而是反过来枚举**所有**写入方，逐个论证它来自她的手，不是来自模型的输出。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failed = 0;
function check(name, yes) {
    console.log(`  ${yes ? '✓' : '✗'} ${name}`);
    if (!yes) failed++;
}

// ⚠️ 扫描前必须剥掉注释。第一版没剥，结果把源码里那句
//   「别改回 addMemory()」的**警告注释本身**当成了真实调用，红得莫名其妙。
//   （同类教训见记忆库 test-validity-fault-injection：验源码的断言会匹配到自己的反例。）
//   只剥整行注释 —— 保守，不会误删任何代码；行尾注释顶多造成误报（红了有人来看），
//   不会造成漏报（那才是真正危险的方向）。
function stripLineComments(src) {
    return src.split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
}

const mem = stripLineComments(read('js/04-memory.js'));
const memRaw = read('js/04-memory.js');
const api = read('js/05-prompts-api.js');

// ── 1. 反向断言：公开记忆的写入方，必须全部来自用户自己 ──────────
{
    // 允许写公开记忆的地方，只有她手动操作的那两个入口。
    // 新增一个写入方而没登记在这里 → 这条断言立刻红，逼人回来想清楚它是谁触发的。
    const HUMAN_ENTRIES = ['addMemoryManual', 'addMemoryFromSettings'];

    // 找出文件里每一处写公开记忆的调用，以及它落在哪个顶层函数里
    const fnStarts = [];
    const fnRe = /^function\s+([A-Za-z_$][\w$]*)/gm;
    for (let m; (m = fnRe.exec(mem));) fnStarts.push({ name: m[1], at: m.index });
    const enclosing = idx => {
        let cur = '(顶层)';
        for (const f of fnStarts) { if (f.at <= idx) cur = f.name; else break; }
        return cur;
    };

    const writers = [];
    for (const call of ['addMemory(', 'deleteMemoryByMatch(']) {
        let from = 0;
        for (;;) {
            const i = mem.indexOf(call, from);
            if (i < 0) break;
            from = i + 1;
            const fn = enclosing(i);
            if (fn === 'addMemory' || fn === 'deleteMemoryByMatch') continue; // 定义本身
            writers.push({ call, fn });
        }
    }

    check('确实找到了写入方（找不到的话这条断言等于没测）', writers.length > 0);
    const rogue = writers.filter(w => !HUMAN_ENTRIES.includes(w.fn));
    check(`★ 公开记忆的每一个写入方都来自用户自己（实测 ${writers.length} 处：${[...new Set(writers.map(w => w.fn))].join('/')}）`,
        rogue.length === 0);
    if (rogue.length) console.log('      不是她触发的:', rogue.map(w => `${w.fn} 里的 ${w.call}`).join(', '));

    // 上面按「函数名白名单」论证；这里再从另一头堵一次：
    // 处理模型输出的那个函数体内，一次都不许出现写公开记忆的调用。
    const pStart = mem.indexOf('function processAiCommands');
    const pEnd = mem.indexOf('\nfunction ', pStart + 1);
    const body = mem.slice(pStart, pEnd > 0 ? pEnd : undefined);
    check('★ 处理模型输出的 processAiCommands 里没有任何公开记忆写入调用',
        !/\baddMemory\s*\(/.test(body) && !/\bdeleteMemoryByMatch\s*\(/.test(body));
}

// ── 2. 行为：把模型写的指令真喂一遍，看记忆有没有被动 ────────────
{
    // 只抠 processAiCommands 里处理 MEM_ADD / MEM_DEL 的那两行出来跑，
    // 不复刻逻辑（复刻的话源码改回去了测试照样绿）。
    const pickLine = tag => {
        const i = mem.indexOf(`text = text.replace(/\\[\\[${tag}:`);
        return i < 0 ? null : mem.slice(i, mem.indexOf('\n', i));
    };
    const lines = ['MEM_ADD', 'MEM_DEL'].map(pickLine);
    check('抠到了 MEM_ADD / MEM_DEL 两行源码', lines.every(Boolean));

    const ctx = {
        text: '好的呀 [[MEM_ADD: 小明今天说了一件很私人的事]] 还有 [[MEM_DEL: 旧的]] 就这样',
        escHtml: s => String(s),
        // 这两个摆在这里当**陷阱**：真被调用了下面的断言就会发现
        addMemory: t => { ctx._wrote.push(t); },
        deleteMemoryByMatch: k => { ctx._deleted.push(k); },
        _wrote: [], _deleted: [],
    };
    vm.createContext(ctx);
    for (const l of lines) if (l) vm.runInContext(l, ctx);

    check('★ 模型写 [[MEM_ADD:]] 时，公开记忆一个字都没被写进去', ctx._wrote.length === 0);
    check('★ 模型写 [[MEM_DEL:]] 时，公开记忆一条都没被删', ctx._deleted.length === 0);

    // 但也不能静默吞掉 —— 她要看得见模型想记什么，才谈得上「自己决定要不要留」
    check('模型想记的内容仍然显示给她看（没有被默默丢掉）',
        ctx.text.includes('小明今天说了一件很私人的事'));
    check('显示上说清楚了这条没被写进去',
        /没写进去|没有写|未写入/.test(ctx.text));
    check('标签本身不会裸奔在正文里', !ctx.text.includes('[[MEM_ADD:'));
}

// ── 3. 提示词里不再教模型写公开记忆 ─────────────────────────────
{
    const i = api.indexOf('[记忆技能]');
    check('找到了记忆技能那段提示词', i > 0);
    const seg = api.slice(i, i + 400);
    check('★ 不再教模型 MEM_ADD（教了它就会写）', !seg.includes('MEM_ADD'));
    check('★ 不再教模型 MEM_DEL', !seg.includes('MEM_DEL'));
    check('明确告诉它公开记忆只能看不能改', /只能看|不能改|只读/.test(seg));
    check('给了它替代出口：想记就直接跟用户说', /跟她说|告诉她|由她/.test(seg));
    // SELF_MEM_SET 是它自己专属的设定库，只有它自己看得见 —— 不在这次收回的范围里
    check('它自己专属的设定库仍然可写（这次收的是公开那块）', seg.includes('SELF_MEM_SET'));
}

// ── 4. 别修过头：她自己的入口必须还在 ───────────────────────────
{
    check('她手动加公开记忆的入口还在', /function addMemoryManual/.test(mem)
        && /function addMemoryFromSettings/.test(mem));
    check('addMemory 这个函数本身没被删（她那两个入口要用）', /function addMemory\s*\(/.test(mem));
    check('按关键词删的函数也还在（她自己要能删）', /function deleteMemoryByMatch/.test(mem));
}

if (failed) process.exitCode = 1;
else console.log('  —— 公开记忆只读 全部通过');
