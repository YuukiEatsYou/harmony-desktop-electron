'use strict';

// Headless renderer smoke test. Loads the shell renderer in an offscreen
// window, reports any console errors, and asserts the rail drew its servers.
// Run with: npm run smoke

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

let failed = false;

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on('console-message', (event, level, message) => {
    // Electron 36+ reports a details object; older versions pass positionals.
    const text = typeof message === 'string' ? message : event.message;
    const severity = typeof level === 'number' ? level : event.level;
    if (severity === 'error' || severity === 3) {
      failed = true;
      console.error(`renderer error: ${text}`);
    }
  });

  window.webContents.on('did-fail-load', (_event, code, description) => {
    failed = true;
    console.error(`did-fail-load: ${code} ${description}`);
  });

  await window.loadFile(rendererPath);

  const railServers = await window.webContents.executeJavaScript(
    "document.querySelectorAll('#server-list .rail-button').length",
  );
  const hasAddButton = await window.webContents.executeJavaScript(
    "Boolean(document.getElementById('add-server'))",
  );

  console.log(`rail servers rendered: ${railServers}`);
  console.log(`add button present: ${hasAddButton}`);

  if (railServers !== 2 || !hasAddButton) failed = true;

  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
  app.exit(failed ? 1 : 0);
});
