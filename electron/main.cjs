/**
 * Electron main process (CommonJS — Electron doesn't support ESM main yet).
 * Spawns the Express server as a child process, then opens a frameless widget window.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');

let tray = null;
let mainWindow = null;
let serverProcess = null;

// ── Start Express server ──────────────────────────────────────────────────────
function startServer() {
  // Use the Node.js bundled with Electron to run the ESM server
  const nodeBin = process.execPath;
  serverProcess = spawn(nodeBin, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT, ELECTRON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProcess.stderr.on('data', d => process.stderr.write('[server] ' + d));

  serverProcess.on('exit', (code, signal) => {
    if (code !== 0 && !app.isQuitting) {
      console.error(`[Electron] server exited (${signal ?? code}) — restarting in 2s`);
      setTimeout(startServer, 2000);
    }
  });
}

// ── Wait for server to be ready ───────────────────────────────────────────────
function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://127.0.0.1:${PORT}/widget.html`, (res) => {
        if (res.statusCode < 500) resolve();
        else if (n > 0) setTimeout(() => attempt(n - 1), 300);
        else reject(new Error('server not ready'));
      }).on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), 300);
        else reject(new Error('server not ready'));
      });
    };
    attempt(retries);
  });
}

// ── Create widget window ──────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 700,
    minWidth: 320,
    minHeight: 500,
    frame: false,            // no title bar — widget look
    transparent: false,
    resizable: true,
    vibrancy: 'under-window', // macOS blur effect
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/widget.html`);

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Menu bar tray icon ────────────────────────────────────────────────────────
function createTray() {
  // 16×16 template image (black, macOS auto-inverts for dark menu bar)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADGSURBVEiJ7ZSxDcIwEEVfBCMwCiMwCiMwCiMwAiMQIoqUJkWkdEFFl9KFDgqkSBQp2YCOhoKChobfhYMiJXaIkCjJk07nu3f/7v8kgB07/oQxxhjLBYCU0imlnHPuVlU5pZQzxhjLBYCU0imlnHPuVlU5pZQzxhjLBYCU0imlnHPuVlU5pZQzxhjLBYCU0imlnHPuVlU5pZQzxhjLBYCU0imlnHPuVlU5pZQzxhjLBYCU0imlnHPuVlU5pZQzxhj7tRcAQGfbUjl3RQAAAABJRU5ErkJggg=='
  );
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Seens Radio');

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { label: 'Hide', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else if (mainWindow) mainWindow.show();
    else createWindow();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Allow geolocation and media permissions in the renderer
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['geolocation', 'media', 'microphone'];
    callback(allowed.includes(permission));
  });

  startServer();
  createTray();

  try {
    await waitForServer();
  } catch {
    console.error('[Electron] server never became ready');
  }

  createWindow();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

// Keep app running when all windows closed (lives in menu bar)
app.on('window-all-closed', () => { /* do nothing */ });

app.on('before-quit', () => {
  app.isQuitting = true;
  serverProcess?.kill();
});
