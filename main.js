const { app, BrowserWindow, Menu, ipcMain, Notification, shell, nativeTheme, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
// Spaces with their own Claude login are read by usage as subscription usage.
try {
  const c = JSON.parse(fs.readFileSync(path.join(process.env.SR_HOME || path.join(os.homedir(), '.situation-room'), 'config.json'), 'utf8'));
  const sp = c.spaces || { personal: { claudeConfigDir: '~/.claude-personal' } };
  process.env.SR_LOGIN_DIRS = Object.values(sp).map((v) => v.claudeConfigDir).filter(Boolean).map((d) => d.replace(/^~(?=\/|$)/, os.homedir())).join(':');
} catch { process.env.SR_LOGIN_DIRS = path.join(os.homedir(), '.claude-personal'); }
const { summary, detail } = require('./usage');

const PORT = Number(process.env.SR_PORT || 7777);
const LOG = path.join(os.homedir(), '.situation-room', 'daemon.log');
let win;

function ping() {
  return new Promise((r) => {
    http.get(`http://127.0.0.1:${PORT}/repos`, (res) => { res.resume(); r(true); }).on('error', () => r(false));
  });
}

// Daemon is detached so quitting the app leaves sessions running.
async function ensureDaemon() {
  if (await ping()) return;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const node = process.env.SR_NODE || 'node';
  spawn(node, [path.join(__dirname, 'daemon.js')], {
    detached: true, stdio: ['ignore', out, out], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  }).unref();
  for (let i = 0; i < 50 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 100));
}

async function restartDaemon() {
  await new Promise((r) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/shutdown', method: 'POST' }, r);
    req.on('error', r);
    req.end();
  });
  for (let i = 0; i < 30 && (await ping()); i++) await new Promise((r) => setTimeout(r, 100));
  await ensureDaemon();
  win?.reload();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 980, minHeight: 600, titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { port: String(PORT) } });
  // Every web link belongs in the default browser, never an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (/^https?:/.test(url)) { e.preventDefault(); shell.openExternal(url); } });
  // Builder edits under ui/ show up without a manual reload.
  let t;
  fs.watch(path.join(__dirname, 'ui'), () => { clearTimeout(t); t = setTimeout(() => win?.reload(), 300); });
}

ipcMain.handle('usage', (_e, ids) => summary(ids));
ipcMain.handle('pickFolder', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: start, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('usageDetail', (_e, opts) => detail(opts));
ipcMain.on('open', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.on('badge', (_e, n) => app.dock?.setBadge(n ? String(n) : ''));
ipcMain.on('notify', (_e, { title, body }) => {
  const n = new Notification({ title, body });
  n.on('click', () => { win?.show(); win?.focus(); });
  n.show();
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' },
        { label: 'Restart Daemon', click: restartDaemon },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]));
  await ensureDaemon();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
