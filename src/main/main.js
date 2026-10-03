'use strict';

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

/**
 * The renderer asks for webviews, so we never trust the attributes it sets.
 * Whatever it requests, a harnessed webview gets a sandbox, no Node, no preload
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

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
