'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, Menu, clipboard, BrowserWindow } = require('electron');
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
  ipcMain.handle('servers:active', () => store.getLastActiveId());
  ipcMain.handle('servers:set-active', (_event, id) =>
    store.setLastActiveId(id == null ? null : String(id)),
  );
  ipcMain.handle('servers:menu', (event, input) => showServerMenu(store, event, input ?? {}));
}

/**
 * A native context menu for a rail entry. Resolves with the chosen action, or
 * null when the menu is dismissed. Copying the address happens here; the
 * renderer handles reload and remove.
 *
 * @param {import('./servers').ServerStore} store
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {{ id?: string, hasView?: boolean }} input
 * @returns {Promise<'reload' | 'copy-url' | 'remove' | null>}
 */
function showServerMenu(store, event, input) {
  return new Promise((resolve) => {
    const server = store.get(String(input.id));
    if (!server) {
      resolve(null);
      return;
    }

    const menu = Menu.buildFromTemplate([
      { label: 'Reload', enabled: Boolean(input.hasView), click: () => resolve('reload') },
      {
        label: 'Copy server address',
        click: () => {
          clipboard.writeText(server.url);
          resolve('copy-url');
        },
      },
      { type: 'separator' },
      { label: 'Remove server', click: () => resolve('remove') },
    ]);

    menu.popup({
      window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      // Fires when the menu closes without a choice, or after one already
      // resolved this promise (a second resolve is a no-op).
      callback: () => resolve(null),
    });
  });
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
