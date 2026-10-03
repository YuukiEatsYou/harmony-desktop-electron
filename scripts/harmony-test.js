'use strict';

// Plain-Node tests for the metadata/icon fetcher against a local fake server.
// Run with: npm test

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { fetchMeta, fetchIcon } = require('../src/main/harmony');

// A real 1x1 transparent PNG, so the fetch path is exercised with valid bytes.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** @type {'ok' | 'not-harmony' | 'not-json' | 'http-500'} */
let mode = 'ok';

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/api/v1/meta') {
    if (mode === 'not-harmony') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    } else if (mode === 'not-json') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('<html>not json</html>');
    } else if (mode === 'http-500') {
      response.writeHead(500);
      response.end('boom');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ name: '  Unit Server  ', apiVersion: 'v1', iconHash: 'abc123' }),
      );
    }
    return;
  }

  if (url.pathname === '/api/v1/icon') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(PNG_1X1);
    return;
  }

  response.writeHead(404);
  response.end();
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-meta-'));

void (async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const baseUrl = `http://127.0.0.1:${port}`;

    // --- Happy path: name is trimmed, hash is kept --------------------------
    assert.deepEqual(await fetchMeta(baseUrl), {
      name: 'Unit Server',
      iconHash: 'abc123',
      apiVersion: 'v1',
    });

    // --- Rejections ---------------------------------------------------------
    mode = 'not-harmony';
    await assert.rejects(fetchMeta(baseUrl), /Harmony/);

    mode = 'not-json';
    await assert.rejects(fetchMeta(baseUrl), /JSON/);

    mode = 'http-500';
    await assert.rejects(fetchMeta(baseUrl), /HTTP 500/);

    await assert.rejects(fetchMeta('http://127.0.0.1:1'), /Could not reach/);

    // --- Icon download ------------------------------------------------------
    const iconFile = path.join(directory, 'icon.png');
    assert.equal(await fetchIcon(baseUrl, 'abc123', iconFile), true);
    assert.ok(fs.readFileSync(iconFile).equals(PNG_1X1));

    // An unwritable destination must fail softly, never throw.
    const missing = path.join(directory, 'no-such-dir', 'icon.png');
    assert.equal(await fetchIcon(baseUrl, 'abc123', missing), false);

    console.log('HARMONY TESTS PASSED');
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})();
