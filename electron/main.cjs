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
const fs    = require('fs');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// In a packaged Electron app stdout/stderr have no terminal — writes throw EPIPE.
// Suppress it at the stream level so it never becomes an uncaught exception.
process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') throw e; });

// Enforce single instance — if a second copy is launched, focus the existing
// window and quit the new process immediately.  Without this the EADDRINUSE
// handler lets a second instance attach to the running server and open a
// duplicate window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Second instance — hide from Dock immediately so there's no visual flash,
  // then quit.  The first instance's second-instance handler will focus its window.
  if (app.dock) app.dock.hide();
  app.quit();
} else {
  app.on('second-instance', () => {
    if (isWindowAlive(mainWindow)) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Redirect console output to /tmp/seens-debug.log so issues are always capturable.
// Append across launches so context is preserved; rotate when file exceeds 2 MB.
const LOG_PATH = '/tmp/seens-debug.log';
try {
  if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) {
    fs.renameSync(LOG_PATH, LOG_PATH + '.old');
  }
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  logStream.write(`\n=== SEENS start ${new Date().toISOString()} ===\n`);
  const origLog  = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr  = console.error.bind(console);
  const writeLine = (prefix, args) => {
    const line = prefix + args.map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ') + '\n';
    logStream.write(line);
  };
  // Wrap origLog/Warn/Err in try-catch: packaged app stdout may be a broken pipe.
  console.log   = (...a) => { try { origLog(...a); } catch (e) { if (e.code !== 'EPIPE') throw e; } writeLine('', a); };
  console.warn  = (...a) => { try { origWarn(...a); } catch (e) { if (e.code !== 'EPIPE') throw e; } writeLine('[WARN] ', a); };
  console.error = (...a) => { try { origErr(...a); } catch (e) { if (e.code !== 'EPIPE') throw e; } writeLine('[ERR] ', a); };
} catch (e) { /* log redirect failed — continue silently */ }

// Disable Chromium's autoplay policy so DJ audio and music play without a
// prior user gesture on every track (Electron enforces this by default).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOT = path.join(__dirname, '..');
// OAuth redirect URIs are pre-registered against the fixed PORT in .env,
// so we must never swap to an ephemeral port in the packaged app.
const USE_EPHEMERAL_SERVER_PORT = false;

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

let PORT = parseInt(process.env.PORT || '8080', 10);
let serverPort = null;

// Finder-launched apps do not inherit the user's shell PATH. Keep the original
// Homebrew fallback, but also merge login-shell PATH and optional .env entries.
{
  const splitPath = (value) => String(value || '').split(path.delimiter).filter(Boolean);
  const basePath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  let shellPath = '';
  try {
    shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'printf "%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, PATH: basePath },
    });
  } catch (error) {
    console.warn('[Electron] Login shell PATH lookup failed:', error.message);
  }
  process.env.PATH = [...new Set([
    ...splitPath(process.env.SEENS_EXTRA_PATHS),
    ...splitPath(shellPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...splitPath(basePath),
  ])].join(path.delimiter);
}

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
      const port = serverPort || globalThis.SEENS_SERVER_PORT || PORT;
      if (!port || port === 0) {
        if (n > 0) return setTimeout(() => attempt(n - 1), 300);
        return reject(new Error('server port not published'));
      }

      http.get(`http://127.0.0.1:${port}/api/ready`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const ready = res.statusCode === 200 && JSON.parse(body).app === 'seens-radio';
            if (ready) return resolve();
          } catch {}
          if (n > 0) setTimeout(() => attempt(n - 1), 300);
          else reject(new Error('server not ready'));
        });
      }).on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), 300);
        else reject(new Error('server not ready'));
      });
    };
    attempt(retries);
  });
}

// ── Create widget window ──────────────────────────────────────────────────────
function createWindow(port = serverPort || PORT) {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 700,
    minWidth: 380,
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

  mainWindow.loadURL(`http://127.0.0.1:${port}/widget.html`);
  mainWindow.show();

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron] Renderer failed to load:', errorCode, errorDescription, validatedURL);
    createErrorWindow(`Renderer failed to load ${validatedURL}\n${errorCode}: ${errorDescription}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Electron] Renderer process gone:', details);
    createErrorWindow(`Renderer process exited: ${details.reason}`);
  });

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
    // OAuth popups (localhost URLs) must open inside Electron so the /callback/* redirect
    // lands back on the local server and window.close() is detectable by the opener.
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 620, height: 720,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function isWindowAlive(win) {
  return Boolean(win) && !win.isDestroyed();
}

function createErrorWindow(message) {
  const html = `
    <html>
      <body style="margin:0;padding:24px;background:#f5f1e8;color:#1f1a14;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;">
        <h1 style="margin:0 0 12px;font-size:20px;">Seens Radio failed to start</h1>
        <p style="margin:0 0 12px;">The local server did not come up, so the UI could not load.</p>
        <pre style="white-space:pre-wrap;background:#fff;border:1px solid #d7d0c3;border-radius:8px;padding:12px;">${String(message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>
      </body>
    </html>
  `;

  mainWindow = new BrowserWindow({
    width: 560,
    height: 420,
    title: 'Seens Radio Startup Error',
    webPreferences: { contextIsolation: true },
  });
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  mainWindow.show();
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
    { label: 'Show', click: () => { if (isWindowAlive(mainWindow)) mainWindow.show(); else createWindow(serverPort); } },
    { label: 'Hide', click: () => { if (isWindowAlive(mainWindow)) mainWindow.hide(); } },
    { type: 'separator' },
    { label: 'Open DevTools', click: () => { if (isWindowAlive(mainWindow)) mainWindow.webContents.openDevTools({ mode: 'detach' }); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (isWindowAlive(mainWindow) && mainWindow.isVisible()) mainWindow.hide();
    else if (isWindowAlive(mainWindow)) mainWindow.show();
    else createWindow(serverPort);
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

  if (USE_EPHEMERAL_SERVER_PORT) {
    process.env.PORT = '0';
    PORT = 0;
  }

  const serverLoad = startServer();   // kicks off Express in the same process
  createTray();

  try {
    await serverLoad;
    await waitForServer();
    serverPort = globalThis.SEENS_SERVER_PORT || parseInt(process.env.PORT || `${PORT}`, 10) || PORT;
    PORT = serverPort;
    console.log(`[Electron] Server ready on ${serverPort}`);
  } catch (error) {
    console.error('[Electron] Server never became ready:', error);
    createErrorWindow(error.message);
    return;
  }

  createWindow(serverPort);
});

app.on('activate', () => {
  if (!isWindowAlive(mainWindow)) createWindow(serverPort);
  else mainWindow.show();
});

app.on('window-all-closed', () => { /* stay alive in menu bar */ });

app.on('before-quit', () => { app.isQuitting = true; });
