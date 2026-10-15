// 锁手机番茄钟。结束时间落 localStorage，App 被系统回收后重开仍能恢复。
var _pomoEndAt = Number(localStorage.getItem('grancyan_pomo_end') || 0);
var _pomoMinutes = Number(localStorage.getItem('grancyan_pomo_minutes') || 25);
var _pomoTick = null;
var _pomoExitHold = null;

function pomoBridge() {
  try { return window.GrancyanFocus && window.GrancyanFocus.available() ? window.GrancyanFocus : null; }
  catch (_) { return null; }
}
function pomoRunning() { return _pomoEndAt > Date.now(); }
function openPomodoro() {
  document.getElementById('pomodoroModal')?.classList.remove('hidden');
  pomoRender();
  if (pomoRunning()) pomoEnsureTick();
}
function closePomodoro() {
  // 正在专注时只关面板，不解除系统固定；从小组件随时能再打开看剩余时间。
  document.getElementById('pomodoroModal')?.classList.add('hidden');
}
function pomoSetMinutes(v) {
  if (pomoRunning()) return;
  _pomoMinutes = Math.max(1, Math.min(180, Math.round(Number(v) || 25)));
  localStorage.setItem('grancyan_pomo_minutes', String(_pomoMinutes));
  pomoRender();
}
function pomoSetCustom(ev) {
  if (ev && ev.type === 'keydown' && ev.key !== 'Enter') return;
  if (ev) ev.preventDefault();
  const input = document.getElementById('pomoCustom');
  if (!input || pomoRunning()) return;
  pomoSetMinutes(input.value);
}
function pomoStart() {
  if (pomoRunning()) return;
  _pomoEndAt = Date.now() + _pomoMinutes * 60000;
  localStorage.setItem('grancyan_pomo_end', String(_pomoEndAt));
  const bridge = pomoBridge();
  if (bridge) bridge.lock();
  else showToast('计时已开始；当前环境不能锁定系统，只保留番茄钟', 'info', 4000);
  pomoEnsureTick(); pomoRender();
}
function pomoEnsureTick() {
  if (_pomoTick) return;
  _pomoTick = setInterval(() => {
    if (pomoRunning()) { pomoPaintClock(); return; }
    pomoFinish();
  }, 500);
}
function pomoFinish() {
  const had = _pomoEndAt > 0;
  _pomoEndAt = 0;
  localStorage.removeItem('grancyan_pomo_end');
  if (_pomoTick) { clearInterval(_pomoTick); _pomoTick = null; }
  try { pomoBridge()?.unlock(); } catch (_) {}
  if (had) {
    try { navigator.vibrate?.([180, 100, 180]); } catch (_) {}
    showToast('🍅 这一颗番茄完成啦，休息一下吧', 'success', 5000);
  }
  pomoRender();
}
function pomoBeginExitHold() {
  if (!pomoRunning() || _pomoExitHold) return;
  _pomoExitHold = setTimeout(() => { _pomoExitHold = null; pomoFinish(); }, 2000);
  document.getElementById('pomoExit')?.classList.add('holding');
}
function pomoCancelExitHold() {
  if (_pomoExitHold) { clearTimeout(_pomoExitHold); _pomoExitHold = null; }
  document.getElementById('pomoExit')?.classList.remove('holding');
}
function pomoLeft() { return Math.max(0, _pomoEndAt - Date.now()); }
function pomoClock(ms) {
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function pomoPaintClock() {
  const el = document.getElementById('pomoClock'); if (el) el.textContent = pomoClock(pomoLeft());
  const ring = document.getElementById('pomoRing');
  if (ring) ring.style.setProperty('--pomo-progress', String(1 - pomoLeft() / (_pomoMinutes * 60000)));
}
function pomoRender() {
  const body = document.getElementById('pomodoroBody'); if (!body) return;
  const running = pomoRunning();
  const locked = (() => { try { return !!pomoBridge()?.locked(); } catch (_) { return false; } })();
  body.innerHTML = `<div class="pomo-card">
    <div class="pomo-window" aria-hidden="true"><i></i><i></i><i></i><span></span></div>
    <div class="pomo-lamp" aria-hidden="true"><i></i></div>
    <div class="pomo-room-label"><span>FOCUS ROOM</span><small>${running ? '请勿打扰，灯正为你亮着' : '把这一小段时间留给自己'}</small></div>
    <div id="pomoRing" class="pomo-ring" style="--pomo-progress:${running ? 1 - pomoLeft() / (_pomoMinutes * 60000) : 0}">
      <div><b id="pomoClock">${pomoClock(running ? pomoLeft() : _pomoMinutes * 60000)}</b><span>${running ? '正在专注' : '准备好了吗'}</span></div>
    </div>
    <div class="pomo-presets">${[15,25,45].map(n => `<button class="pomo-btn ${_pomoMinutes === n ? 'active' : ''}" onclick="pomoSetMinutes(${n})" ${running ? 'disabled' : ''}>${n} 分钟</button>`).join('')}</div>
    <div class="pomo-custom">
      <label for="pomoCustom">自定义</label>
      <input id="pomoCustom" type="number" min="1" max="180" step="1" inputmode="numeric" value="${_pomoMinutes}" onkeydown="pomoSetCustom(event)" ${running ? 'disabled' : ''}>
      <span>分钟</span><button class="pomo-btn" onclick="pomoSetCustom(event)" ${running ? 'disabled' : ''}>确定</button>
    </div>
    ${running ? `<div class="pomo-lock-state">${locked ? '🔒 手机已固定在 Grancyan' : '◌ 正在计时（系统未锁定）'}</div>
      <button id="pomoExit" class="pomo-exit" onpointerdown="pomoBeginExitHold()" onpointerup="pomoCancelExitHold()" onpointerleave="pomoCancelExitHold()">长按 2 秒提前结束</button>`
      : `<button class="pomo-start" onclick="pomoStart()">开始专注并锁定手机</button>
      <div class="pomo-tip">Android 首次开始会弹出系统“屏幕固定”确认；电脑端只计时。</div>`}
  </div>`;
}

// 刷新后恢复；已过期则顺手清掉系统固定。
if (_pomoEndAt) { if (pomoRunning()) pomoEnsureTick(); else pomoFinish(); }
