// Electron runtime smoke test for the code workbench session lifecycle.
// Usage: node tests/workbench-runtime-smoke.js <remote-debugging-port>
'use strict';

const port = Number(process.argv[2] || 0);
if (!port) throw new Error('remote debugging port is required');

const pending = new Map();
let nextId = 1;

async function main() {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const page = pages.find(x => x.type === 'page' && /127\.0\.0\.1/.test(x.url));
  if (!page) throw new Error('Grancyan renderer was not found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.error) job.reject(new Error(msg.error.message)); else job.resolve(msg.result);
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await call('Runtime.enable');
  const expression = String.raw`(async () => {
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const originalState = _cw;
    const originalScheduleSave = cwScheduleSave;
    const originalTrashOpen = _cwTrashOpen;
    const modal = document.getElementById('codeWorkbenchModal');
    try {
      cwScheduleSave = () => {};
      modal.classList.remove('hidden');
      const now = Date.now();
      _cw = {
        version: 1,
        activeProvider: 'codex',
        activeProjectId: 'p-codex',
        activeSessionId: 'keep',
        projects: [
          { id: 'p-codex', name: 'Smoke Codex', cwd: 'C:\\projects\\GranCyan', provider: 'codex', models: { codex: '', claude: '' }, thinkingModes: { codex: 'auto', claude: 'auto' }, sessions: [
            { id: 'keep', title: '保留会话', createdAt: now, updatedAt: now, status: 'idle', messages: [{ id: 'm1', role: 'user', content: 'keep', at: now }], events: [] }
          ] },
          { id: 'p-claude', name: 'Smoke Claude', cwd: 'C:\\projects\\GranCyan', provider: 'claude', models: { codex: '', claude: '' }, thinkingModes: { codex: 'auto', claude: 'auto' }, sessions: [] }
        ],
        trash: [{ id: 'trash-claude', deletedAt: now, project: { id: 'p-claude', name: 'Smoke Claude', cwd: 'C:\\projects\\GranCyan', provider: 'claude' }, session: { id: 'old-claude', title: 'Claude 回收项', status: 'idle', messages: [], events: [] } }]
      };
      _cwTrashOpen = false;
      cwRender();

      cwNewSession();
      const firstBlank = _cw.activeSessionId;
      cwNewSession();
      assert(!cwFindSession(firstBlank), 'leaving an empty session did not prune it');
      assert(cwProject().sessions.length === 2, 'empty-session pruning removed a non-empty session');
      const activeBlank = _cw.activeSessionId;

      const deleting = cwDeleteSession('keep');
      await new Promise(resolve => setTimeout(resolve, 50));
      const promptInput = document.getElementById('appPromptInput');
      const promptOk = document.getElementById('appPromptOk');
      assert(promptInput && promptOk, 'delete confirmation prompt did not open');
      promptInput.value = '删除';
      promptOk.click();
      await Promise.race([
        deleting,
        new Promise((_, reject) => setTimeout(() => reject(new Error('delete confirmation did not resolve')), 2000))
      ]);
      const deleted = _cw.trash.find(x => x.session?.id === 'keep');
      assert(deleted && !cwFindSession('keep'), 'manual delete did not move the session to trash');
      cwToggleTrash();
      const trashText = document.getElementById('cwSessions').textContent;
      assert(trashText.includes('保留会话'), 'Codex trash item was not rendered');
      assert(!trashText.includes('Claude 回收项'), 'Claude trash leaked into the Codex UI');

      cwRestoreSession(deleted.id);
      assert(cwFindSession('keep') && !_cw.trash.some(x => x.id === deleted.id), 'trash restore did not restore the session');

      _cw.activeProjectId = 'p-codex';
      _cw.activeSessionId = activeBlank;
      const running = cwSession();
      running.status = 'running';
      delete running.runId;
      await cwStop();
      assert(running.stopRequested === true, 'stop before runId was not latched');

      return { emptyPruned: true, trashed: true, restored: true, providerIsolated: true, stopLatched: true };
    } finally {
      clearTimeout(_cwSaveTimer);
      _cwSaveTimer = null;
      _cw = originalState;
      cwScheduleSave = originalScheduleSave;
      _cwTrashOpen = originalTrashOpen;
      cwRender();
      modal.classList.add('hidden');
    }
  })()`;
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  console.log(JSON.stringify(result.result.value));
  // Browser.close normally tears down the CDP socket before acknowledging it.
  // Send it as a one-way command so a successful smoke run cannot hang here.
  ws.send(JSON.stringify({ id: nextId++, method: 'Browser.close', params: {} }));
  await new Promise(resolve => setTimeout(resolve, 300));
  try { ws.close(); } catch {}
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
