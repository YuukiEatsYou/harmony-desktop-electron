'use strict';

const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');

let nextRequestId = 0;

/**
 * Let a loaded server capture the screen, but let the user choose the source.
 * `getDisplayMedia` asks us for a stream, so we list the screens and windows and
 * show a picker in the shell window. On macOS 15+ the OS picker is used instead
 * and this handler is never called.
 *
 * @param {Electron.Session} session
 */
function registerDisplayMediaHandler(session) {
  session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 200 },
        });
        const chosenId = await chooseSource(sources);
        const source = sources.find((candidate) => candidate.id === chosenId);
        if (!source) {
          // An empty stream set denies the request, which surfaces to the page
          // as the usual cancellation error.
          callback({});
          return;
        }
        callback({
          video: source,
          audio: request.audioRequested ? 'loopback' : undefined,
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true },
  );
}

/**
 * Ask the shell window to show the source picker. Resolves with the chosen
 * source id, or null when the picker was cancelled or no window is around.
 *
 * @param {Electron.DesktopCapturerSource[]} sources
 * @returns {Promise<string | null>}
 */
function chooseSource(sources) {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return Promise.resolve(null);

  const requestId = (nextRequestId += 1);
  const payload = {
    requestId,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: thumbnailUrl(source),
    })),
  };

  return new Promise((resolve) => {
    const onPicked = (_event, id, sourceId) => {
      if (id !== requestId) return;
      ipcMain.removeListener('display:picked', onPicked);
      resolve(typeof sourceId === 'string' ? sourceId : null);
    };

    ipcMain.on('display:picked', onPicked);
    window.webContents.send('display:pick', payload);
  });
}

/** @param {Electron.DesktopCapturerSource} source */
function thumbnailUrl(source) {
  try {
    return source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL();
  } catch {
    return null;
  }
}

module.exports = { registerDisplayMediaHandler };
