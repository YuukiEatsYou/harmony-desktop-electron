'use strict';

/**
 * Shell renderer: draws the server rail, and mounts one <webview> per server in
 * its own persistent session partition so sign-in state never leaks between
 * servers. Talks to the main process over the `window.shell` bridge.
 */

/** @typedef {{ id: string, url: string, name: string, iconHash: string | null, iconPath: string | null }} Server */

/** @type {string | null} */
let activeId = null;

/** @type {Server[]} */
let servers = [];

/** @type {Map<string, any>} server id -> <webview> element */
const webviews = new Map();

/** Ids whose webview failed to load and needs a retry. @type {Set<string>} */
const failed = new Set();

/** Unread channel counts reported by each guest. @type {Map<string, number>} */
const unread = new Map();

/**
 * Injected into each guest on load. Harmony has no title or badge of its own,
 * but it draws a `.mention-dot` in every channel holding an unread mention or
 * reply. We mirror that count into `document.title`, which the shell reads back
 * via `page-title-updated`.
 */
const UNREAD_SCRIPT = `(() => {
  if (window.__harmonyUnread) return;
  window.__harmonyUnread = true;
  const base = document.title || location.host;
  let last = -1;
  let scheduled = false;
  const update = () => {
    scheduled = false;
    const count = document.querySelectorAll('.channel .mention-dot').length;
    if (count === last) return;
    last = count;
    document.title = count > 0 ? '(' + count + ') ' + base : base;
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };
  update();
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
})()`;

const listElement = document.getElementById('server-list');
const emptyState = document.getElementById('empty-state');
const emptyTitle = document.getElementById('empty-title');
const emptyCopy = document.getElementById('empty-copy');
const webviewHost = document.getElementById('webview-host');
const loadError = document.getElementById('load-error');
const loadErrorName = document.getElementById('load-error-name');
const loadErrorMessage = document.getElementById('load-error-message');

const screenPicker = document.getElementById('screen-picker');
const screenSources = document.getElementById('screen-sources');

const dialogBackdrop = document.getElementById('dialog-backdrop');
const addForm = document.getElementById('add-form');
const urlInput = document.getElementById('server-url');
const dialogError = document.getElementById('dialog-error');
const submitButton = addForm.querySelector('button[type="submit"]');

/** Two initials, Discord-style, for servers without an icon. */
function initials(name) {
  const words = name.trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word[0] ?? '').join('').toUpperCase() || '?';
}

/** Cached icon served by the main process; the hash busts the cache on change. */
function iconUrl(server) {
  const version = encodeURIComponent(server.iconHash ?? '');
  return `harmony-icon://icon/${encodeURIComponent(server.id)}?v=${version}`;
}

/**
 * Mount the webview for a server on first use. The partition is set before the
 * element is attached, which is when Electron commits to it.
 * @param {Server} server
 */
function ensureWebview(server) {
  const existing = webviews.get(server.id);
  if (existing) return existing;

  const view = document.createElement('webview');
  view.className = 'server-webview';
  view.setAttribute('partition', `persist:harmony-${server.id}`);
  view.setAttribute('src', server.url);

  view.addEventListener('dom-ready', () => {
    view.executeJavaScript(UNREAD_SCRIPT).catch(() => {});
  });

  view.addEventListener('page-title-updated', (event) => {
    const match = /^\((\d+)\)\s+/.exec(event.title ?? '');
    const count = match ? Number(match[1]) : 0;
    if (count === (unread.get(server.id) ?? 0)) return;
    if (count > 0) unread.set(server.id, count);
    else unread.delete(server.id);
    render();
  });

  view.addEventListener('did-start-loading', () => {
    if (failed.delete(server.id)) render();
  });

  view.addEventListener('did-fail-load', (event) => {
    // -3 is ABORTED, which fires on redirects and navigations we initiated.
    if (event.errorCode === -3 || event.isMainFrame === false) return;
    failed.add(server.id);
    render();
  });

  webviewHost.append(view);
  webviews.set(server.id, view);
  return view;
}

function showLoadError(server) {
  loadErrorName.textContent = server.name;
  loadErrorMessage.textContent = `Could not load ${server.url}.`;
  loadError.hidden = false;
}

function hideLoadError() {
  loadError.hidden = true;
}

function render() {
  listElement.replaceChildren();

  // Mount every server, not just the active one: background guests keep their
  // gateway open and report unread, which is the point of the rail badges.
  for (const server of servers) void ensureWebview(server);

  for (const server of servers) {
    const item = document.createElement('li');
    item.className = 'rail-item';
    if (server.id === activeId) item.classList.add('is-active');

    const button = document.createElement('button');
    button.className = 'rail-button';
    button.title = `${server.name}\n${server.url}`;
    button.setAttribute('aria-label', server.name);

    if (server.iconPath) {
      const image = document.createElement('img');
      image.src = iconUrl(server);
      image.alt = '';
      button.append(image);
    } else {
      button.textContent = initials(server.name);
    }

    button.addEventListener('click', () => select(server.id));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void openServerMenu(server);
    });

    item.append(button);

    const count = unread.get(server.id) ?? 0;
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.textContent = count > 99 ? '99+' : String(count);
      item.append(badge);
    }

    listElement.append(item);
  }

  const active = servers.find((server) => server.id === activeId) ?? null;

  for (const [id, view] of webviews) {
    view.classList.toggle('is-active', id === activeId);
    view.classList.toggle('is-failed', failed.has(id));
  }

  if (servers.length === 0) {
    emptyTitle.textContent = 'No servers yet';
    emptyCopy.textContent = 'Add a Harmony server to get started.';
  } else {
    emptyTitle.textContent = 'No server selected';
    emptyCopy.textContent = 'Pick a server from the rail.';
  }
  emptyState.hidden = active !== null;

  if (active && failed.has(active.id)) showLoadError(active);
  else hideLoadError();
}

/** @param {string} id */
function select(id) {
  activeId = id;
  render();
  void window.shell.servers.setActive(id);
}

/**
 * @param {Server} server
 * @param {{ confirm?: boolean }} [options]
 */
async function removeServer(server, options = {}) {
  if (options.confirm !== false) {
    const confirmed = window.confirm(`Remove “${server.name}” from your servers?`);
    if (!confirmed) return;
  }

  await window.shell.servers.remove(server.id);

  servers = servers.filter((candidate) => candidate.id !== server.id);
  webviews.get(server.id)?.remove();
  webviews.delete(server.id);
  failed.delete(server.id);
  unread.delete(server.id);

  if (activeId === server.id) activeId = servers[0]?.id ?? null;
  render();
  void window.shell.servers.setActive(activeId);
}

/** @param {Server} server */
async function openServerMenu(server) {
  const hasView = webviews.has(server.id);
  const action = await window.shell.servers.showMenu({ id: server.id, hasView });

  if (action === 'reload') {
    webviews.get(server.id)?.reload();
  } else if (action === 'remove') {
    await removeServer(server);
  }
}

function openDialog() {
  dialogError.hidden = true;
  dialogError.textContent = '';
  urlInput.value = '';
  dialogBackdrop.hidden = false;
  document.body.classList.add('modal-open');
  urlInput.focus();
}

function closeDialog() {
  dialogBackdrop.hidden = true;
  document.body.classList.remove('modal-open');
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;

  dialogError.hidden = true;
  submitButton.disabled = true;
  const label = submitButton.textContent;
  submitButton.textContent = 'Adding…';

  try {
    // The main process contacts the server, so this can take a moment.
    const result = await window.shell.servers.add({ url: urlInput.value });
    if (!result.ok) {
      dialogError.textContent = result.error;
      dialogError.hidden = false;
      return;
    }

    servers.push(result.server);
    closeDialog();
    select(result.server.id);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = label;
  }
});

document.getElementById('dialog-cancel').addEventListener('click', closeDialog);

document.getElementById('load-error-retry').addEventListener('click', () => {
  const server = servers.find((candidate) => candidate.id === activeId);
  const view = server && webviews.get(server.id);
  if (!server || !view) return;
  failed.delete(server.id);
  render();
  view.reload();
});

dialogBackdrop.addEventListener('mousedown', (event) => {
  if (event.target === dialogBackdrop) closeDialog();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!screenPicker.hidden) closeScreenPicker(null);
  else if (!dialogBackdrop.hidden) closeDialog();
});

/* --- Screen-share picker ------------------------------------------------- */

/** @type {number | null} */
let pickerRequestId = null;

/** @param {{ requestId: number, sources: Array<{ id: string, name: string, kind: string, thumbnail: string | null }> }} payload */
function openScreenPicker(payload) {
  pickerRequestId = payload.requestId;
  screenSources.replaceChildren();

  for (const source of payload.sources) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-source';

    if (source.thumbnail) {
      const image = document.createElement('img');
      image.src = source.thumbnail;
      image.alt = '';
      button.append(image);
    }

    const label = document.createElement('span');
    label.className = 'picker-source-name';
    label.textContent = source.name || source.kind;
    button.append(label);

    button.addEventListener('click', () => closeScreenPicker(source.id));
    screenSources.append(button);
  }

  screenPicker.hidden = false;
  document.body.classList.add('modal-open');
}

/** @param {string | null} sourceId */
function closeScreenPicker(sourceId) {
  screenPicker.hidden = true;
  document.body.classList.remove('modal-open');
  const requestId = pickerRequestId;
  pickerRequestId = null;
  if (requestId !== null) window.shell.display.reply(requestId, sourceId);
}

document.getElementById('screen-picker-cancel').addEventListener('click', () => {
  closeScreenPicker(null);
});

screenPicker.addEventListener('mousedown', (event) => {
  if (event.target === screenPicker) closeScreenPicker(null);
});

void window.shell.display.onPick((payload) => openScreenPicker(payload));

document.getElementById('add-server').addEventListener('click', openDialog);
document.getElementById('empty-add').addEventListener('click', openDialog);

async function start() {
  const [list, lastActive] = await Promise.all([
    window.shell.servers.list(),
    window.shell.servers.active(),
  ]);
  servers = list;

  const restored = servers.find((server) => server.id === lastActive);
  activeId = (restored ?? servers[0])?.id ?? null;

  render();
  if (activeId) void window.shell.servers.setActive(activeId);
}

void start();
