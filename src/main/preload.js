'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The shell renderer's only door into the main process. It stays deliberately
 * small: each method maps to one named IPC channel, so the renderer can never
 * ask for an arbitrary channel.
 */
contextBridge.exposeInMainWorld('shell', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    add: (input) => ipcRenderer.invoke('servers:add', input),
    remove: (id) => ipcRenderer.invoke('servers:remove', id),
  },
});
