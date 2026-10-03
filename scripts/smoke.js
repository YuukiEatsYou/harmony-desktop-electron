'use strict';

// Headless smoke test. Boots the real app against a throwaway userData
// directory and a local fake Harmony server, then drives the add-server dialog
// through the actual renderer -> IPC -> network -> store path and checks the
// per-server webview, including partition isolation.
//
// Run with: npm run smoke
// Headless machines may need: --no-sandbox --disable-gpu --in-process-gpu

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');

// Keep the test hermetic. The appData root is redirected too, not just the
// data directory, so the legacy-data migration cannot pull in the user's real
// servers from their actual appData location.
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-smoke-'));
app.setPath('appData', appData);
const userData = path.join(appData, 'Harmony');
app.setPath('userData', userData);

// Leave data behind under the old app name so the rename migration is
// exercised. The list is empty, so it does not change what the driver sees.
const legacyData = path.join(appData, 'harmony-desktop');
fs.mkdirSync(path.join(legacyData, 'icons'), { recursive: true });
fs.writeFileSync(path.join(legacyData, 'servers.json'), JSON.stringify({ version: 1, servers: [] }));
fs.writeFileSync(path.join(legacyData, 'icons', 'marker.txt'), 'x');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// One channel that is merely unread, and one holding an unread mention or
// reply. The shell's injected observer counts only the latter, so the guest
// must report a badge of 1 (not 2).
const PAGE_HTML =
  '<!doctype html><html><head><title>Fake Harmony</title></head><body>' +
  '<div class="channel unread"></div>' +
  '<div class="channel unread"><span class="mention-dot"></span></div>' +
  '</body></html>';

const hits = { meta: 0, icon: 0, page: 0 };
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

  if (url.pathname === '/') {
    hits.page += 1;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGE_HTML);
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
// load failures (including a broken icon or webview URL) are not missed.
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 3) {
      fail(`renderer console error: ${event.message}`);
    }
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

/** Drive the add-server dialog and the mounted webview against `baseUrl`. */
function driveShell(baseUrl) {
  return `(async () => {
    const BASE = ${JSON.stringify(baseUrl)};
    const host = document.getElementById('webview-host');

    // Webview methods throw until the guest is attached, hence the swallow.
    const waitFor = async (test, timeout = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          if (test()) return true;
        } catch {
          // not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };

    // A guest rejects executeJavaScript until it has attached and gone dom-ready.
    const guestEval = async (label, view, code) => {
      const start = Date.now();
      let last;
      while (Date.now() - start < 10000) {
        try {
          return await view.executeJavaScript(code);
        } catch (error) {
          last = error;
          if (!/dom-ready|attached/i.test(String(error.message))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error(label + ': ' + (last ? last.message : 'guest never became ready'));
    };

    const emptyVisibleBefore = !document.getElementById('empty-state').hidden;

    document.getElementById('add-server').click();
    const dialogOpen = !document.getElementById('dialog-backdrop').hidden;
    document.getElementById('server-url').value = BASE + '/';
    document.getElementById('add-form').dispatchEvent(new Event('submit', { cancelable: true }));

    await waitFor(() => host.querySelector('webview'));
    const view = host.querySelector('webview');
    const loaded = await waitFor(() => view.getURL() && !view.isLoading());

    const stored = await window.shell.servers.list();
    const server = stored[0] ?? null;

    let guestTitle = null;
    let guestTitleError = null;
    if (loaded) {
      try {
        guestTitle = await guestEval('main-title', view, 'document.title');
      } catch (error) {
        guestTitleError = error.message;
      }
    }
    const partition = view.getAttribute('partition');
    const src = view.getAttribute('src');
    const active = getComputedStyle(view).visibility === 'visible';

    // The injected observer mirrors unread channels into the title, which the
    // shell turns into a rail badge.
    await waitFor(() => document.querySelector('#server-list .rail-badge'));
    const badgeText = document.querySelector('#server-list .rail-badge')?.textContent ?? null;
    const persistedActive = await window.shell.servers.active();

    // Partition isolation: two guests, same origin, separate cookie jars.
    const makeView = (partitionName) => new Promise((resolve, reject) => {
      const element = document.createElement('webview');
      element.className = 'server-webview';
      element.setAttribute('partition', partitionName);
      element.setAttribute('src', BASE);
      const timer = setTimeout(() => reject(new Error('timeout ' + partitionName)), 10000);
      element.addEventListener('dom-ready', () => { clearTimeout(timer); resolve(element); }, { once: true });
      host.append(element);
    });

    let isolated = null;
    let isoError = null;
    try {
      const a = await makeView('persist:smoke-iso-a');
      const b = await makeView('persist:smoke-iso-b');
      await guestEval('iso-a-write', a, "document.cookie = 'probe=A; path=/'");
      await guestEval('iso-b-write', b, "document.cookie = 'probe=B; path=/'");
      const readA = await guestEval('iso-a-read', a, 'document.cookie');
      const readB = await guestEval('iso-b-read', b, 'document.cookie');
      isolated = readA.includes('probe=A') && !readA.includes('probe=B')
        && readB.includes('probe=B') && !readB.includes('probe=A');
      a.remove();
      b.remove();
    } catch (error) {
      isoError = error.message;
    }

    if (server) await window.shell.servers.remove(server.id);
    view.remove();

    return {
      emptyVisibleBefore,
      dialogOpen,
      loaded,
      guestTitle,
      guestTitleError,
      partition,
      src,
      active,
      badgeText,
      persistedActive,
      serverId: server ? server.id : null,
      isolated,
      isoError,
      expectedPartition: server ? 'persist:harmony-' + server.id : null,
      expectedSrc: BASE,
    };
  })()`;
}

void app.whenReady().then(async () => {
  await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (fakeServer.address());
  const baseUrl = `http://127.0.0.1:${port}`;

  if (process.platform !== 'darwin' && Menu.getApplicationMenu() !== null) {
    fail('the default application menu was not removed');
  }

  if (!fs.existsSync(path.join(userData, 'servers.json'))) {
    fail('the legacy server list was not migrated');
  }
  if (!fs.existsSync(path.join(userData, 'icons', 'marker.txt'))) {
    fail('the legacy icons were not migrated');
  }

  const window = await waitForWindow();
  if (!window) {
    fail('no window became ready');
    app.exit(1);
    return;
  }

  let result;
  try {
    result = await window.webContents.executeJavaScript(driveShell(baseUrl));
  } catch (error) {
    fail(`executeJavaScript threw: ${error.message}`);
    app.exit(1);
    return;
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.emptyVisibleBefore) fail('empty state was not visible before adding');
  if (!result.dialogOpen) fail('add dialog did not open');
  if (!result.loaded) fail('server webview never finished loading');
  if (result.guestTitle !== '(1) Fake Harmony') {
    fail(`unexpected guest title: ${result.guestTitle}`);
  }
  if (result.badgeText !== '1') fail(`unexpected rail badge: ${result.badgeText}`);
  if (result.persistedActive !== result.serverId) {
    fail(`active server was not persisted: ${result.persistedActive}`);
  }
  if (result.partition !== result.expectedPartition) {
    fail(`wrong partition: ${result.partition} (expected ${result.expectedPartition})`);
  }
  const normalize = (value) => String(value).replace(/\/+$/, '');
  if (normalize(result.src) !== normalize(result.expectedSrc)) {
    fail(`wrong webview src: ${result.src}`);
  }
  if (!result.active) fail('active server webview was not visible');
  if (result.isoError) fail(`partition isolation errored: ${result.isoError}`);
  if (result.isolated !== true) fail('cookies leaked between session partitions');
  if (hits.meta < 1) fail('the meta endpoint was never called');
  if (hits.icon < 1) fail('the icon endpoint was never called');
  if (hits.page < 1) fail('the webview never requested the server page');

  fakeServer.close();
  fs.rmSync(appData, { recursive: true, force: true });
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
  app.exit(failed ? 1 : 0);
});
