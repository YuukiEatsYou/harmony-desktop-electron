'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');
const { normalizeUrl } = require('./servers');
const { fetchMeta, fetchIcon } = require('./harmony');

/**
 * The server-management surface the renderer is allowed to call. Every handler
 * returns a plain value, so a thrown error (and its Electron stack noise) never
 * crosses the bridge.
 *
 * @param {import('./servers').ServerStore} store
 * @param {string} iconsDir
 */
function registerIpc(store, iconsDir) {
  ipcMain.handle('servers:list', () => store.list());
  ipcMain.handle('servers:remove', (_event, id) => removeServer(store, id));
  ipcMain.handle('servers:add', (_event, input) => addServer(store, iconsDir, input ?? {}));
}

/**
 * @param {import('./servers').ServerStore} store
 * @param {string} iconsDir
 * @param {{ url?: string, name?: string }} input
 * @returns {Promise<{ ok: true, server: import('./servers').Server } | { ok: false, error: string }>}
 */
async function addServer(store, iconsDir, input) {
  let url;
  try {
    url = normalizeUrl(input.url ?? '');
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }

  if (store.list().some((server) => server.url === url)) {
    return { ok: false, error: 'That server is already in your list.' };
  }

  // Verify the address really is a Harmony instance before we commit to it.
  let meta;
  try {
    meta = await fetchMeta(url);
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }

  const created = store.add({ url, name: meta.name ?? undefined, iconHash: meta.iconHash });
  if (!created.ok) return created;

  // The record (and its id) now exists, so a cached icon can be attached to it.
  if (meta.iconHash) {
    const destination = path.join(iconsDir, `${created.server.id}.png`);
    try {
      fs.mkdirSync(iconsDir, { recursive: true });
    } catch {
      // If the directory cannot be made the icon fetch will fail and we simply
      // keep the initials fallback.
    }
    if (await fetchIcon(url, meta.iconHash, destination)) {
      store.update(created.server.id, { iconPath: destination });
    }
  }

  return { ok: true, server: store.get(created.server.id) ?? created.server };
}

/**
 * Remove a server and any icon it cached on disk.
 *
 * @param {import('./servers').ServerStore} store
 * @param {unknown} id
 * @returns {Promise<boolean>}
 */
async function removeServer(store, id) {
  const server = store.get(String(id));
  const removed = store.remove(String(id));
  if (removed && server?.iconPath) {
    await fs.promises.rm(server.iconPath, { force: true }).catch(() => {});
  }
  return removed;
}

module.exports = { registerIpc };
