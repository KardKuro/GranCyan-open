// ═══════════════════════════════════════════════════════
// 终端小组件 —— 手机敲命令，电脑上跑，输出流回来
// 后端 terminal.js：POST /api/terminal/run 返回 SSE（out / done）。
// 「不同终端窗口」= 这里的标签页：每个标签自己一份 shell + 工作目录（cd 会记住）。
// Windows 没法把命令塞进一个已经开着的终端窗口，所以是我们自己起 shell，不是接管别人的。
// ═══════════════════════════════════════════════════════
// 在跑的命令的 runId / AbortController 挂在**各自的标签对象**上（t.runId / t.abort），不放全局：
// busy 是一个标签一份的，全局那一个会让 1 号的「停止」掐掉 2 号的进程，先跑完的还把别人的 abort 置空。
let _termTabs = [], _termActive = 0, _termShells = null, _termSaveTimer = null;

function _termSave() {
  try {
    localStorage.setItem('grancyanTerm', JSON.stringify(
      _termTabs.map(t => ({ name: t.name, shell: t.shell, cwd: t.cwd, admin: t.admin,
        out: (t.out || []).slice(-500), history: (t.history || []).slice(-200), interrupted: !!t.busy }))
    ));
  } catch {}
}
function _termLoad() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('grancyanTerm') || '[]'); } catch {}
  _termTabs = (saved.length ? saved : [{ name: '终端 1', shell: 'powershell', cwd: '', admin: false }])
    .map(t => ({ ...t,
      out: [...(Array.isArray(t.out) ? t.out : []), ...(t.interrupted ? ['<span class="meta">\n[上次关机时仍在运行，进程已经中断]\n</span>'] : [])],
      history: Array.isArray(t.history) ? t.history : [], histIdx: -1, busy: false }));
  _termActive = 0;
}
const _termTab = () => _termTabs[_termActive];

function openTerminal() {
  document.getElementById('widgetsPanel')?.classList.add('hidden');
  if (!_termTabs.length) _termLoad();
  document.getElementById('terminalModal').classList.remove('hidden');
  if (!_termShells) {
    fetch(SERVER_BASE + '/api/terminal/shells')
      .then(r => r.json())
      .then(d => {
        _termShells = d.shells || [];
        _termTabs.forEach(t => { if (!t.cwd) t.cwd = d.defaultCwd || ''; });
        renderTerm();
      })
      .catch(e => {
        _termShells = [];
        termPrint('连不上电脑的 server.js：' + e.message + '\n（设置里的「电脑地址」填对了吗？start.bat 起来了吗？）', 'bad');
      });
  }
  renderTerm();
  setTimeout(() => document.getElementById('termInput')?.focus(), 60);
}
function closeTerminal() {
  document.getElementById('terminalModal').classList.add('hidden');
}
function termNewTab() {
  _termTabs.push({
    name: '终端 ' + (_termTabs.length + 1),
    shell: _termTab()?.shell || 'powershell',
    cwd: _termTab()?.cwd || '', admin: false,
    out: [], history: [], histIdx: -1, busy: false,
  });
  _termActive = _termTabs.length - 1;
  _termSave(); renderTerm();
}
function termCloseTab(i, e) {
  if (e) e.stopPropagation();
  if (_termTabs.length === 1) return;   // 最后一个不给关，不然界面就空了
  const gone = _termTabs[i];
  if (gone && gone.busy) _termStopRun(gone);   // 标签关了进程别在电脑上接着跑没人管
  _termTabs.splice(i, 1);
  // 关的是当前这个左边的：当前标签整体左移一格，下标不跟着减就跳到它右边那个去了
  if (i < _termActive) _termActive--;
  if (_termActive >= _termTabs.length) _termActive = _termTabs.length - 1;
  _termSave(); renderTerm();
}
function termSwitchTab(i) { _termActive = i; renderTerm(); }
function termSetShell(key) {
  const s = (_termShells || []).find(x => x.key === key);
  if (s && !s.available) { showToast('这台电脑上没装 ' + s.label, 'error'); return; }
  _termTab().shell = key; _termSave(); renderTerm();
}

function renderTerm() {
  const t = _termTab(); if (!t) return;
  document.getElementById('termTabs').innerHTML = _termTabs.map((x, i) => `
    <div class="term-tab ${i === _termActive ? 'active' : ''}" onclick="termSwitchTab(${i})">
      ${escHtml(x.name)}${_termTabs.length > 1 ? `<span class="x" onclick="termCloseTab(${i},event)">✕</span>` : ''}
    </div>`).join('');
  document.getElementById('termShells').innerHTML = (_termShells || []).map(s => `
    <div class="term-shell ${t.shell === s.key ? 'active' : ''} ${s.available ? '' : 'off'}"
         onclick="termSetShell('${s.key}')">${escHtml(s.label)}</div>`).join('');
  document.getElementById('termCwd').textContent = t.cwd || '…';
  document.getElementById('termAdmin').checked = !!t.admin;
  const out = document.getElementById('termOut');
  out.innerHTML = t.out.join('');
  out.scrollTop = out.scrollHeight;
  document.getElementById('termRunBtn').style.display = t.busy ? 'none' : 'block';
  document.getElementById('termStopBtn').style.display = t.busy ? 'block' : 'none';
}

// 输出是一块块 append 的，别每次都重渲染整个面板（长输出会卡）——直接往 DOM 里塞
// tab 传的是跑这条命令的那个标签：跑到一半切走了，输出也得记回它自己名下，
// 屏幕上只有它正好是当前标签时才画（不然就画到别的标签里、还跟着落盘了）。
function termPrint(text, cls, tab) {
  const t = tab || _termTab(); if (!t) return;
  const html = `<span class="${cls || ''}">${escHtml(text)}</span>`;
  t.out.push(html);
  const out = t === _termTab() ? document.getElementById('termOut') : null;
  if (out) {
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;  // 用户往上翻了就别硬拽回底部
    out.insertAdjacentHTML('beforeend', html);
    if (stick) out.scrollTop = out.scrollHeight;
  }
  clearTimeout(_termSaveTimer);
  _termSaveTimer = setTimeout(_termSave, 300);
}

function termKey(e) {
  const t = _termTab(); if (!t) return;
  const inp = e.target;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); termRun(); return; }
  // ↑↓ 翻历史（光标在头/尾时才翻，不然会抢走多行编辑的上下移动）
  if (e.key === 'ArrowUp' && inp.selectionStart === 0 && t.history.length) {
    e.preventDefault();
    t.histIdx = t.histIdx < 0 ? t.history.length - 1 : Math.max(0, t.histIdx - 1);
    inp.value = t.history[t.histIdx]; autoResize(inp);
  } else if (e.key === 'ArrowDown' && inp.selectionStart === inp.value.length && t.histIdx >= 0) {
    e.preventDefault();
    t.histIdx++;
    if (t.histIdx >= t.history.length) { t.histIdx = -1; inp.value = ''; }
    else inp.value = t.history[t.histIdx];
    autoResize(inp);
  }
}

async function termRun() {
  const t = _termTab(); if (!t || t.busy) return;
  const inp = document.getElementById('termInput');
  const cmd = inp.value.trim();
  if (!cmd) return;
  t.admin = document.getElementById('termAdmin').checked;
  t.history.push(cmd); t.histIdx = -1;
  inp.value = ''; autoResize(inp);
  _termSave();

  termPrint(`\n❯ ${cmd}\n`, 'cmd', t);
  t.busy = true; _termSave();
  const runId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const ac = new AbortController();
  t.runId = runId; t.abort = ac;
  renderTerm();

  try {
    const r = await fetch(SERVER_BASE + '/api/terminal/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, shell: t.shell, cwd: t.cwd, admin: t.admin, id: runId }),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);

    // 手搓 SSE 解析：fetch 的流按 \n\n 切事件（EventSource 不支持 POST，只能这么来）
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
        const dataLine = (chunk.match(/^data: (.*)$/m) || [])[1];
        if (!dataLine) continue;
        let d; try { d = JSON.parse(dataLine); } catch { continue; }
        if (ev === 'out') termPrint(d.text, '', t);
        else if (ev === 'done') {
          if (d.cwd && d.cwd !== t.cwd) { t.cwd = d.cwd; _termSave(); }
          termPrint(d.code === 0 ? '\n[完成]\n' : `\n[退出码 ${d.code}]\n`, d.code === 0 ? 'meta' : 'bad', t);
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') termPrint('\n连接断了：' + e.message + '\n', 'bad', t);
  } finally {
    t.busy = false;
    if (t.abort === ac) { t.abort = null; t.runId = null; }
    _termSave();
    renderTerm();
  }
}

// 停的是**这个标签自己**那条命令
function _termStopRun(t) {
  const id = t.runId;
  if (t.abort) t.abort.abort();      // 断流，后端 req.on('close') 会顺手 kill 掉进程
  if (id) fetch(SERVER_BASE + '/api/terminal/kill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

function termKill() {
  const t = _termTab(); if (!t) return;
  _termStopRun(t);
  termPrint('\n[已停止]\n', 'meta', t);
}
