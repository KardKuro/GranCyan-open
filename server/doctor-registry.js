// server/doctor-registry.js
// ==========================================
// doctor 检查注册器：各分区在自己代码所在位置就地注册检查项，
// runDoctor() 只负责遍历执行，不再横切读取各分区的模块级私有状态。
// 模块顶层零副作用：只定义，不读 env、不摸文件系统、不起定时器。
// ==========================================
const fs = require('fs');

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[0m' };
const ok   = s => `  ${C.g}✓${C.d} ${s}`;
const bad  = s => `  ${C.r}✗${C.d} ${s}`;
const warn = s => `  ${C.y}•${C.d} ${s}`;
const exists = p => { try { return !!p && fs.existsSync(p); } catch { return false; } };

const _checks = new Map();

function register(name, fn) {
    _checks.set(name, fn);
}

function list() {
    return Array.from(_checks.entries()).map(([name, fn]) => ({ name, fn }));
}

function get(name) {
    return _checks.get(name);
}

module.exports = { register, list, get, C, ok, bad, warn, exists };
