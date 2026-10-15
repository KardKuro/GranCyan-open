'use strict';
// 桌面歌词悬浮窗的 preload：只暴露它自己要用的几个动作，不碰 fs、不碰别的 IPC 通道。通道名 desk-lyric:*，见 deskly-main.js。
const { contextBridge, ipcRenderer } = require('electron');

function api(kind) {
    return {
        onState(cb) { ipcRenderer.on(`${kind}:state`, (_e, st) => { try { cb(st); } catch (e) {} }); },
        onLock(cb) { ipcRenderer.on(`${kind}:lock`, (_e, v) => { try { cb(!!v); } catch (e) {} }); },
        ready() { ipcRenderer.send(`${kind}:ready`); },
        // 拖把手改大小：整块新矩形（屏幕坐标）
        bounds(b) {
            b = b || {};
            ipcRenderer.send(`${kind}:bounds`, { x: Number(b.x) || 0, y: Number(b.y) || 0, width: Number(b.width) || 0, height: Number(b.height) || 0 });
        },
        lock(v) { ipcRenderer.send(`${kind}:lock`, !!v); },
        hit(v) { ipcRenderer.send(`${kind}:hit`, !!v); },
        close() { ipcRenderer.send(`${kind}:cmd`, 'close'); },
        // 「音」「译」开关：只发 'ro' / 'tr'，主进程转给点歌台
        opt(v) { if (v === 'ro' || v === 'tr') ipcRenderer.send(`${kind}:cmd`, v); }
    };
}
contextBridge.exposeInMainWorld('deskly', api('desk-lyric'));
