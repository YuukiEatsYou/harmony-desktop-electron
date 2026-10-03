'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const { ServerStore } = require('./servers');
const { registerIpc } = require('./ipc');

const ICON_SCHEME = 'harmony-icon';

// Permissions a loaded server may have. Everything else (camera, microphone,
// geolocation, ...) is refused: a chat server has no business asking.
const ALLOWED_PERMISSIONS = new Set(['notifications']);

// Must run before the app is ready. Marking the scheme standard and secure lets
// it behave like http for the renderer and satisfy the page's CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: ICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Server webviews may only open links in the user's real browser, never a new
// Electron window.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Every session includes the per-server partitions, so this covers them all.
app.on('session-created', (session) => {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
});

/**
 * Drop the default File/Edit/View/Window menu bar. On macOS the menu lives in
 * the system menu bar rather than the window, and copy/paste depend on the edit
 * roles, so there we keep a minimal standard menu instead.
 */
function configureApplicationMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

configureApplicationMenu();

/**
 * The renderer asks for webviews, so we never trust the attributes it sets.
 * Whatever it requests, a hardened webview gets a sandbox, no Node, no preload
 * and the same-origin policy. This is our last line of defence against a
 * compromised renderer escalating through an attached guest.
 *
 * @param {Electron.Event} _event
 * @param {Electron.WebPreferences} webPreferences
 */
function hardenWebview(_event, webPreferences) {
  webPreferences.preload = undefined;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
}

function createWindow() {
  /** @type {BrowserWindow} */
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1a1b1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Servers are rendered as <webview> guests, one per session partition.
      webviewTag: true,
    },
  });

  // Avoid a white flash: reveal only once the shell has painted.
  window.once('ready-to-show', () => window.show());

  // The shell itself never navigates away or opens windows; server content
  // lives in guests, which are handled separately later.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  window.webContents.on('will-attach-webview', hardenWebview);

  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

/**
 * Serves cached icons to the renderer as `harmony-icon://icon/<id>?v=<hash>`.
 * Anything unknown or unreadable is a plain 404, so a missing icon quietly
 * falls back to the initials the renderer draws.
 *
 * @param {import('./servers').ServerStore} store
 */
function registerIconProtocol(store) {
  protocol.handle(ICON_SCHEME, (request) => {
    let id;
    try {
      id = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
    } catch {
      return new Response(null, { status: 400 });
    }

    const server = store.get(id);
    if (!server?.iconPath) return new Response(null, { status: 404 });

    try {
      return new Response(fs.readFileSync(server.iconPath), {
        headers: { 'content-type': 'image/png' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

void app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const store = new ServerStore(userData);

  registerIpc(store, path.join(userData, 'icons'));
  registerIconProtocol(store);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
