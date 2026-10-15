// db-adapter.js — better-sqlite3 封装
// 打包成 Electron exe 后 better-sqlite3 的原生 .node 常因 ABI 不匹配加载失败
// （npm install 按系统 Node 的 ABI 下载预编译，Electron 的 ABI 是另一个号），
// 这时回退到 Node 24+ 内置的 node:sqlite——接口按本类用到的子集包一层即可。
const fs = require('fs');
const path = require('path');

// node:sqlite 的 DatabaseSync 包成 better-sqlite3 形状（只覆盖本项目用到的 API）
function _openFallback(filepath) {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(filepath);
    return {
        pragma: (cmd) => raw.exec('PRAGMA ' + cmd),
        exec: (sql) => raw.exec(sql),
        prepare: (sql) => raw.prepare(sql), // run/get/all 签名一致
        transaction: (fn) => (...args) => {
            raw.exec('BEGIN');
            try { const out = fn(...args); raw.exec('COMMIT'); return out; }
            catch (e) { try { raw.exec('ROLLBACK'); } catch (_) {} throw e; }
        },
        close: () => raw.close(),
    };
}

function _open(filepath) {
    try {
        const Database3 = require('better-sqlite3');
        return new Database3(filepath);
    } catch (e) {
        console.warn('⚠️ better-sqlite3 加载失败，回退 node:sqlite:', String(e.message).split('\n')[0]);
        return _openFallback(filepath);
    }
}

class Database {
    constructor(filepath) {
        this.filepath = filepath;
        this.db = null;
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        this.db = _open(this.filepath);
        this.initialized = true;
    }

    initSync() {
        if (this.initialized) return;
        this.db = _open(this.filepath);
        this.initialized = true;
    }

    save() {
        // better-sqlite3 自动保存，无需手动操作
    }

    pragma(cmd) {
        if (!this.db) throw new Error('Database not initialized');
        this.db.pragma(cmd);
        return this;
    }

    exec(sql) {
        if (!this.db) throw new Error('Database not initialized');
        this.db.exec(sql);
    }

    prepare(sql) {
        if (!this.db) throw new Error('Database not initialized');
        return this.db.prepare(sql);
    }

    transaction(fn) {
        if (!this.db) throw new Error('Database not initialized');
        return this.db.transaction(fn);
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = Database;
