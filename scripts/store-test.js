'use strict';

// Plain-Node test for the server store: no Electron needed. Run with:
// npm run test:store

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ServerStore, normalizeUrl } = require('../src/main/servers');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-store-'));

try {
  // --- URL normalisation ----------------------------------------------------
  assert.equal(normalizeUrl('chat.example.com'), 'https://chat.example.com');
  assert.equal(normalizeUrl('  chat.example.com/  '), 'https://chat.example.com');
  assert.equal(normalizeUrl('https://chat.example.com/'), 'https://chat.example.com');
  assert.equal(normalizeUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeUrl('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeUrl('127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeUrl('chat.example.com/harmony/'), 'https://chat.example.com/harmony');
  assert.equal(normalizeUrl('https://chat.example.com/a/b/?x=1#y'), 'https://chat.example.com/a/b');
  assert.throws(() => normalizeUrl(''));
  assert.throws(() => normalizeUrl('ftp://chat.example.com'));
  assert.throws(() => normalizeUrl('not a url'));

  // --- Add, list, dedupe, remove -------------------------------------------
  const store = new ServerStore(directory);

  assert.deepEqual(store.list(), []);

  const first = store.add({ url: 'chat.example.com' });
  assert.equal(first.ok, true);
  assert.equal(first.server.url, 'https://chat.example.com');
  assert.equal(first.server.name, 'chat.example.com');
  assert.equal(typeof first.server.id, 'string');

  const named = store.add({ url: 'localhost:8787', name: '  My Server  ' });
  assert.equal(named.ok, true);
  assert.equal(named.server.name, 'My Server');
  assert.equal(named.server.url, 'http://localhost:8787');

  // The same URL in a different shape must be rejected as a duplicate.
  const duplicate = store.add({ url: 'https://chat.example.com/' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /already/i);

  const bad = store.add({ url: '' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /address/i);

  assert.equal(store.list().length, 2);

  // --- Persistence ----------------------------------------------------------
  const reopened = new ServerStore(directory);
  assert.equal(reopened.list().length, 2);

  // --- Removal --------------------------------------------------------------
  assert.equal(reopened.remove(first.server.id), true);
  assert.equal(reopened.remove('does-not-exist'), false);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].name, 'My Server');

  // A corrupt file must not crash the store.
  fs.writeFileSync(path.join(directory, 'servers.json'), '{ not json');
  assert.deepEqual(new ServerStore(directory).list(), []);

  console.log('STORE TESTS PASSED');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
