'use strict';

// Headless smoke test. Boots the real app against a throwaway userData
// directory, then exercises the renderer -> IPC -> store round trip through the
// actual bridge. Reports any renderer console errors.
//
// Run with: npm run smoke
// Headless machines may need: --no-sandbox --disable-gpu --in-process-gpu

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Keep the test hermetic: never touch the user's real servers.json.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-smoke-'));
app.setPath('userData', userData);

let failed = false;
function fail(message) {
  failed = true;
  console.error(`FAIL: ${message}`);
}

// Catch renderer errors from the moment the window's contents exist, so early
// load failures are not missed.
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, level, message) => {
    const text = typeof message === 'string' ? message : event.message;
    const severity = typeof level === 'number' ? level : event.level;
    if (severity === 'error' || severity === 3) fail(`renderer console error: ${text}`);
  });
  contents.on('did-fail-load', (_event, code, description) => {
    fail(`did-fail-load ${code} ${description}`);
  });
});

// Boot the real application (creates the window and registers IPC).
require('../src/main/main.js');

async function waitForWindow() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [window] = BrowserWindow.getAllWindows();
    if (window && !window.webContents.isLoading()) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Drive the add-server dialog exactly as a user would. */
const DRIVE_ADD_DIALOG = `(async () => {
  const waitFor = async (test, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (test()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };

  const emptyVisibleBefore = !document.getElementById('empty-state').hidden;

  document.getElementById('add-server').click();
  const dialogOpen = !document.getElementById('dialog-backdrop').hidden;

  // A deliberately scheme-less, trailing-slashed, loopback address.
  document.getElementById('server-url').value = 'http://127.0.0.1:9/';
  document.getElementById('add-form').dispatchEvent(new Event('submit', { cancelable: true }));

  await waitFor(() => document.querySelectorAll('#server-list .rail-button').length === 1);

  const railCount = document.querySelectorAll('#server-list .rail-button').length;
  const placeholderVisible = !document.getElementById('server-placeholder').hidden;
  const stored = await window.shell.servers.list();
  const bridge = Boolean(window.shell && window.shell.servers);

  // Clean up so a rerun starts from empty.
  if (stored[0]) await window.shell.servers.remove(stored[0].id);

  return {
    bridge,
    emptyVisibleBefore,
    dialogOpen,
    railCount,
    placeholderVisible,
    storedCount: stored.length,
    storedUrl: stored[0] ? stored[0].url : null,
  };
})()`;

void app.whenReady().then(async () => {
  const window = await waitForWindow();
  if (!window) {
    fail('no window became ready');
    app.exit(1);
    return;
  }

  let result;
  try {
    result = await window.webContents.executeJavaScript(DRIVE_ADD_DIALOG);
  } catch (error) {
    fail(`executeJavaScript threw: ${error.message}`);
    app.exit(1);
    return;
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.bridge) fail('window.shell.servers bridge is missing');
  if (!result.emptyVisibleBefore) fail('empty state was not visible before adding');
  if (!result.dialogOpen) fail('add dialog did not open');
  if (result.railCount !== 1) fail(`expected 1 rail button, got ${result.railCount}`);
  if (!result.placeholderVisible) fail('server placeholder was not shown after adding');
  if (result.storedCount !== 1) fail(`expected 1 stored server, got ${result.storedCount}`);
  if (result.storedUrl !== 'http://127.0.0.1:9') {
    fail(`URL was not normalised, got ${result.storedUrl}`);
  }

  fs.rmSync(userData, { recursive: true, force: true });
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
  app.exit(failed ? 1 : 0);
});
