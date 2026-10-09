'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const { ServerStore } = require('./servers');
const { registerIpc } = require('./ipc');
const { registerDisplayMediaHandler } = require('./display');

const ICON_SCHEME = 'harmony-icon';

// Permissions a loaded server may have. `media` covers the microphone for voice
// channels and `display-capture` the screen share; both are reached from a click
// the member made. Anything else (geolocation, midi, usb, ...) is refused.
const ALLOWED_PERMISSIONS = new Set(['notifications', 'media', 'display-capture']);

/** @param {string} permission */
function isAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

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
// A permission check runs first and a request is only made if it is denied, so
// both handlers must agree.
app.on('session-created', (session) => {
  session.setPermissionCheckHandler((_contents, permission) => isAllowed(permission));
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isAllowed(permission));
  });
  registerDisplayMediaHandler(session);
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
  // Packaged builds get their icon from the bundle; this covers development.
  const windowIcon = path.join(__dirname, '..', '..', 'build', 'icon.png');

  /** @type {BrowserWindow} */
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1a1b1e',
    show: false,
    icon: fs.existsSync(windowIcon) ? windowIcon : undefined,
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

/**
 * Up to now the app was named `harmony-desktop`, so Electron kept its data in a
 * directory of that name. Carry the server list (and cached icons) over to the
 * new `Harmony` directory the first time the renamed app starts.
 */
function migrateLegacyUserData() {
  const legacy = path.join(app.getPath('appData'), 'harmony-desktop');
  const current = app.getPath('userData');
  if (legacy === current) return;

  const source = path.join(legacy, 'servers.json');
  const destination = path.join(current, 'servers.json');
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;

  try {
    fs.mkdirSync(current, { recursive: true });
    fs.copyFileSync(source, destination);
    const legacyIcons = path.join(legacy, 'icons');
    if (fs.existsSync(legacyIcons)) {
      fs.cpSync(legacyIcons, path.join(current, 'icons'), { recursive: true });
    }
    console.info(`Migrated the previous server list from ${legacy}.`);
  } catch (error) {
    console.error('Could not migrate the previous server list:', error);
  }
}

void app.whenReady().then(() => {
  migrateLegacyUserData();
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
