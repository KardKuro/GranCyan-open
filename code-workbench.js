'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const HOME = path.join(os.homedir(), '.grancyan', 'code-workbench');
const STATE = path.join(HOME, 'state.json');
const MAX_STATE = 8 * 1024 * 1024;

function emptyState() { return { version: 1, projects: [], activeProjectId: '', activeSessionId: '', updatedAt: Date.now() }; }
// 盘上那份最后一次被确认是好的（我们写的，或读成功的）时的指纹。
// 保存前文件指纹对不上 = 有别人动过它，要先确认它读得出来，读不出来就备份一份再覆盖，
// 不然一次 PUT 就把一份只是暂时读不了的记录永久换掉了。
let _stateSeen = '';
function fileSig() {
  try { const st = fs.statSync(STATE); return st.size + ':' + st.mtimeMs; }
  catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
}
// 只有「文件不存在」才算空状态。以前任何异常都当空的返回，前端拿到空壳再 PUT 回来，
// 一次瞬时的 EBUSY（杀软、同步盘正锁着）就把所有项目盖没了。现在：
//   读盘出错 → 报错，前端这次不保存；
//   内容坏了（写入是 tmp+rename 原子的，坏了就是真坏，重试也不会好）→ 先挪成 .corrupt-时间戳 留底，
//   再当空的开局。挪不动就报错，绝不在原地覆盖。
function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return emptyState(); throw new Error('工作台记录读取失败：' + e.message); }
  let x = null;
  try { x = JSON.parse(raw); } catch {}
  if (!(x && x.version === 1 && Array.isArray(x.projects))) {
    fs.renameSync(STATE, STATE + '.corrupt-' + Date.now());
    _stateSeen = 'missing';
    return emptyState();
  }
  _stateSeen = fileSig();
  return x;
}
function guardExisting() {
  const sig = fileSig();
  if (sig === 'missing' || sig === _stateSeen) return;
  let raw;
  // 读不了（锁着）就不写：这次 PUT 报错，前端下一次保存会再来，比盲写安全。
  try { raw = fs.readFileSync(STATE, 'utf8'); } catch (e) { throw new Error('工作台记录暂时读不了，先不覆盖：' + e.message); }
  let ok = false;
  try { const x = JSON.parse(raw); ok = !!(x && x.version === 1 && Array.isArray(x.projects)); } catch {}
  if (!ok) fs.copyFileSync(STATE, STATE + '.corrupt-' + Date.now());
}
function saveState(x) {
  const body = Buffer.from(JSON.stringify({ ...x, version: 1, updatedAt: Date.now() }, null, 2));
  if (body.length > MAX_STATE) throw new Error('工作台记录超过 8MB，请先归档旧会话');
  fs.mkdirSync(HOME, { recursive: true });
  guardExisting();
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, STATE);
  _stateSeen = fileSig();
}
function existingDir(raw) {
  const p = path.resolve(String(raw || ''));
  if (!raw || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('工作目录不存在');
  return fs.realpathSync(p);
}

function updaterScript() {
  return `param([int]$WaitPid,[string]$InstallDir,[string]$StagingDir,[string]$ExeName)\n` +
    `$ErrorActionPreference='Stop'\n` +
    `while(Get-Process -Id $WaitPid -ErrorAction SilentlyContinue){Start-Sleep -Milliseconds 500}\n` +
    `$parent=Split-Path -Parent $InstallDir\n$stamp=Get-Date -Format yyyyMMdd-HHmmss\n$backup=$InstallDir+'.backup-'+$stamp\n` +
    `try {\n  Move-Item -LiteralPath $InstallDir -Destination $backup\n  Move-Item -LiteralPath $StagingDir -Destination $InstallDir\n  Start-Process -FilePath (Join-Path $InstallDir $ExeName) -WorkingDirectory $InstallDir\n} catch {\n  if(!(Test-Path -LiteralPath $InstallDir) -and (Test-Path -LiteralPath $backup)){Move-Item -LiteralPath $backup -Destination $InstallDir}\n  throw\n}\n`;
}

function mountCodeWorkbench(app) {
  app.get('/api/code-workbench/state', (_req, res) => {
    try { res.json({ ok: true, state: loadState() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.put('/api/code-workbench/state', (req, res) => {
    try { saveState(req.body || emptyState()); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  app.post('/api/code-workbench/check-cwd', (req, res) => {
    try { res.json({ ok: true, cwd: existingDir(req.body?.cwd) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  app.post('/api/code-workbench/install-staged', (req, res) => {
    try {
      const installDir = existingDir(req.body?.installDir);
      const stagingDir = existingDir(req.body?.stagingDir);
      const exeName = path.basename(String(req.body?.exeName || 'Grancyan.exe'));
      if (installDir === stagingDir || installDir.startsWith(stagingDir + path.sep) || stagingDir.startsWith(installDir + path.sep)) {
        throw new Error('安装目录和 staging 目录不能相同或互相嵌套');
      }
      if (!fs.existsSync(path.join(stagingDir, exeName))) throw new Error(`staging 里没有 ${exeName}`);
      const updaterDir = path.join(os.homedir(), '.grancyan', 'updater');
      fs.mkdirSync(updaterDir, { recursive: true });
      const script = path.join(updaterDir, 'swap-install.ps1');
      fs.writeFileSync(script, updaterScript(), 'utf8');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-WaitPid', String(process.pid), '-InstallDir', installDir, '-StagingDir', stagingDir, '-ExeName', exeName],
      { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      res.json({ ok: true, message: '更新器已在外面等候；关闭 Grancyan 后会换目录并重新打开。' });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

module.exports = { mountCodeWorkbench, loadState, saveState, existingDir };
