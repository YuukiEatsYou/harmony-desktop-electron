'use strict';

// Headless smoke test. Boots the real app against a throwaway userData
// directory and a local fake Harmony server, then drives the add-server dialog
// through the actual renderer -> IPC -> network -> store path.
//
// Run with: npm run smoke
// Headless machines may need: --no-sandbox --disable-gpu --in-process-gpu

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Keep the test hermetic: never touch the user's real servers.json.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-smoke-'));
app.setPath('userData', userData);

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const hits = { meta: 0, icon: 0 };
const fakeServer = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/api/v1/meta') {
    hits.meta += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'Test Server', apiVersion: 'v1', iconHash: 'hash123' }));
    return;
  }

  if (url.pathname === '/api/v1/icon') {
    hits.icon += 1;
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(PNG_1X1);
    return;
  }

  response.writeHead(404);
  response.end();
});

let failed = false;
function fail(message) {
  failed = true;
  console.error(`FAIL: ${message}`);
}

// Catch renderer errors from the moment the window's contents exist, so early
// load failures (including a broken icon URL) are not missed.
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

/** Drive the add-server dialog exactly as a user would, against `baseUrl`. */
function driveAddDialog(baseUrl) {
  return `(async () => {
    const url = ${JSON.stringify(baseUrl)};
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

    document.getElementById('server-url').value = url + '/';
    document.getElementById('add-form').dispatchEvent(new Event('submit', { cancelable: true }));

    await waitFor(() => document.querySelectorAll('#server-list .rail-button').length === 1);

    const button = document.querySelector('#server-list .rail-button');
    const stored = await window.shell.servers.list();
    const server = stored[0] ?? null;

    // The rail should now show the server's real icon, served over our scheme.
    const iconLoaded = await new Promise((resolve) => {
      if (!server || !server.iconPath) { resolve(false); return; }
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = 'harmony-icon://icon/' + encodeURIComponent(server.id)
        + '?v=' + encodeURIComponent(server.iconHash ?? '');
    });

    if (server) await window.shell.servers.remove(server.id);

    return {
      emptyVisibleBefore,
      dialogOpen,
      railCount: document.querySelectorAll('#server-list .rail-button').length,
      placeholderVisible: !document.getElementById('server-placeholder').hidden,
      storedCount: stored.length,
      storedUrl: server ? server.url : null,
      storedName: server ? server.name : null,
      hasIcon: Boolean(server && server.iconPath),
      iconLoaded,
      railHasImage: Boolean(button && button.querySelector('img')),
    };
  })()`;
}

void app.whenReady().then(async () => {
  await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (fakeServer.address());
  const baseUrl = `http://127.0.0.1:${port}`;

  const window = await waitForWindow();
  if (!window) {
    fail('no window became ready');
    app.exit(1);
    return;
  }

  let result;
  try {
    result = await window.webContents.executeJavaScript(driveAddDialog(baseUrl));
  } catch (error) {
    fail(`executeJavaScript threw: ${error.message}`);
    app.exit(1);
    return;
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.emptyVisibleBefore) fail('empty state was not visible before adding');
  if (!result.dialogOpen) fail('add dialog did not open');
  if (result.railCount !== 1) fail(`expected 1 rail button, got ${result.railCount}`);
  if (!result.placeholderVisible) fail('server placeholder was not shown after adding');
  if (result.storedCount !== 1) fail(`expected 1 stored server, got ${result.storedCount}`);
  if (result.storedUrl === null || !result.storedUrl.startsWith('http://127.0.0.1:')) {
    fail(`URL was not normalised, got ${result.storedUrl}`);
  }
  if (result.storedName !== 'Test Server') fail(`name was not taken from meta: ${result.storedName}`);
  if (!result.hasIcon) fail('icon was not cached');
  if (!result.iconLoaded) fail('cached icon did not load over harmony-icon://');
  if (!result.railHasImage) fail('rail button does not show the icon');
  if (hits.meta < 1) fail('the meta endpoint was never called');
  if (hits.icon < 1) fail('the icon endpoint was never called');

  fakeServer.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
  app.exit(failed ? 1 : 0);
});
