/**
 * Electron main process (CommonJS — Electron doesn't support ESM main yet).
 *
 * The Express server runs IN this same process via dynamic import() rather than
 * as a child process. Child-process spawn is unreliable in packaged Electron apps
 * because process.execPath is the Electron binary, not Node.js, and piping/
 * ELECTRON_RUN_AS_NODE behaviour varies across builds.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, ipcMain } = require('electron');
const path  = require('path');
const http  = require('http');
const { pathToFileURL } = require('url');

// Disable Chromium's autoplay policy so DJ audio and music play without a
// prior user gesture on every track (Electron enforces this by default).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOT = path.join(__dirname, '..');

// Point all writable data (DB, tts-cache, auth tokens) to the proper user data
// directory so writes survive app updates and aren't blocked inside the bundle.
process.env.SEENS_DATA_DIR = app.getPath('userData');

// Load .env before anything else so process.env.PORT is available to both
// this file and to server.js (which also calls dotenv internally).
const _dotenvResult = require('dotenv').config({ path: path.join(ROOT, '.env') });
if (_dotenvResult.error) {
  console.error('[Electron] .env load FAILED:', _dotenvResult.error.message);
} else {
  console.log('[Electron] .env loaded — PORT:', process.env.PORT, '| OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✓ set' : '✗ MISSING', '| AI_AGENT:', process.env.AI_AGENT);
}

const PORT = process.env.PORT || 8080;

// Ensure Homebrew binaries (yt-dlp, ffmpeg, SwitchAudioSource) are on PATH
// when the app is launched from Finder (which doesn't inherit the shell PATH).
process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;

let tray       = null;
let mainWindow = null;

// ── Start Express server in-process ──────────────────────────────────────────
// Dynamic import() bridges CJS → ESM cleanly without a child process.
function startServer() {
  const serverUrl = pathToFileURL(path.join(ROOT, 'server.js')).href;
  import(serverUrl).catch(err => {
    console.error('[Electron] Server failed to load:', err);
  });
}

// ── Wait for server to be ready ───────────────────────────────────────────────
function waitForServer(retries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://127.0.0.1:${PORT}/widget.html`, (res) => {
        res.resume(); // drain response
        if (res.statusCode < 500) return resolve();
        if (n > 0) setTimeout(() => attempt(n - 1), 300);
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
    minWidth: 300,
    minHeight: 320,
    frame: false,
    transparent: false,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/widget.html`);
  mainWindow.show();

  // Permanently unlock autoplay in the renderer by dispatching a synthetic
  // click after the page loads. Chromium 130+ requires a real user-activation
  // state on the document regardless of the --autoplay-policy switch.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript(
      'document.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))'
    ).catch(() => {});
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Menu bar tray icon ────────────────────────────────────────────────────────
function createTray() {
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
    { label: 'Open DevTools', click: () => mainWindow?.webContents.openDevTools({ mode: 'detach' }) },
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
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['geolocation', 'media', 'microphone'].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['geolocation', 'media', 'microphone'].includes(permission));
  });

  // ── IPC: window resize (for rest/break artwork expansion)
  ipcMain.handle('resize-window', (_e, w, h) => {
    if (mainWindow) mainWindow.setSize(Math.round(w), Math.round(h), true);
  });
  ipcMain.handle('get-window-size', () => {
    if (!mainWindow) return { width: 380, height: 700 };
    const [width, height] = mainWindow.getSize();
    return { width, height };
  });

  startServer();   // kicks off Express in the same process
  createTray();

  try {
    await waitForServer();
    console.log(`[Electron] Server ready on ${PORT}`);
  } catch {
    console.error('[Electron] Server never became ready — opening anyway');
  }

  createWindow();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on('window-all-closed', () => { /* stay alive in menu bar */ });

app.on('before-quit', () => { app.isQuitting = true; });
