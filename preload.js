'use strict';

// 桌面端唯一的 preload。**它存在的唯一理由是拿到「拖进来的文件」的绝对路径。**
//
// 2026-08-28 为「编程工作台支持拖文件取路径」加的。渲染进程自己做不到这件事，
// 而且是三层各自独立挡死的，任何一层都足以让它失败：
//   ① contextIsolation 默认 true（Electron 12+ 起），页面里没有 require；
//   ② nodeIntegration 默认 false，拿不到 node 的 path / fs；
//   ③ File.path —— Electron 早年给 File 打的私有补丁 —— **在 Electron 32 已被移除**，
//      而这个项目跑在 43。网上绝大多数「读 file.path 就行了」的答案在这个版本上
//      只会给出 undefined，**不报错**。照着抄的话，功能会静默地永远返回空。
// 官方替代品是 webUtils.getPathForFile()，且只能在 preload 里调。
//
// 为什么不顺手关掉 sandbox：不需要。webUtils 属于 electron 的 Renderer 命名空间
// （contextBridge / ipcRenderer / webFrame / webUtils 那一组），沙箱 preload 本来就有。
// 为这一个函数去写 sandbox:false 是白送攻击面。
//
// 为什么整个文件只暴露一个函数：preload 里暴露出去的东西，页面上任何一段脚本都能调
// （包括聊天里渲染的第三方内容）。路径查询是只读且无副作用的，给出去代价可控；
// 一旦顺手加上「读文件 / 写文件」，就等于把 fs 开给了整个渲染进程。要加的时候
// 走 ipcRenderer + 主进程校验，不要在这里图省事。
const { contextBridge, webUtils, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grancyanDesktop', {
    // 桌面歌词独立悬浮窗（见 deskly-main.js）：点歌台把状态推出去，悬浮窗上点 ✕ 时通知回来。
    // 只是「推一份数据」和「收一个关闭通知」，主进程那边会验 sender 并把数据洗一遍，这里没有 fs/任意 IPC。
    desk: {
        lyric(st) { try { ipcRenderer.send('desk-lyric:push', st); } catch (e) {} },
        onLyricClosed(cb) { ipcRenderer.on('desk-lyric:closed', () => { try { cb(); } catch (e) {} }); },
        // 悬浮窗上点了「音」「译」：只回一个 'ro' / 'tr'，开关本身存在点歌台这边
        onLyricOpt(cb) { ipcRenderer.on('desk-lyric:opt', (_e, v) => { if (v === 'ro' || v === 'tr') { try { cb(v); } catch (e) {} } }); }
    },
    // 拿绝对路径；**拿不到就返回空串，绝不把异常抛给调用方**。
    // 两种已知的空手而归，都写在 Electron 文档里，且都不是「报错」的形态：
    //   · 传进来的不是真正的 File 对象  → getPathForFile 抛异常；
    //   · File 是 JS 自己 new 出来的、背后没有磁盘文件 → 返回空字符串。
    // 统一成空串，调用方只需要判一种情况（拖进来的到底有没有路径）。
    filePathOf(file) {
        try { return webUtils.getPathForFile(file) || ''; }
        catch { return ''; }
    }
});
