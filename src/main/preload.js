'use strict';

const { contextBridge } = require('electron');

/**
 * The shell renderer's only door into the main process. It starts deliberately
 * tiny; server management (list/add/remove) will be added to it in a later step.
 */
contextBridge.exposeInMainWorld('shell', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
