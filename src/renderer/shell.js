'use strict';

/**
 * Shell renderer: draws the server rail and the content area, and talks to the
 * main process over the `window.shell` bridge.
 */

/** @typedef {{ id: string, url: string, name: string, iconHash: string | null, iconPath: string | null }} Server */

/** @type {Server[]} */
let servers = [];

/** @type {string | null} */
let activeId = null;

const listElement = document.getElementById('server-list');
const emptyState = document.getElementById('empty-state');
const placeholder = document.getElementById('server-placeholder');
const placeholderName = document.getElementById('placeholder-name');
const placeholderUrl = document.getElementById('placeholder-url');

const dialogBackdrop = document.getElementById('dialog-backdrop');
const addForm = document.getElementById('add-form');
const urlInput = document.getElementById('server-url');
const dialogError = document.getElementById('dialog-error');

/** Two initials, Discord-style, for servers without an icon. */
function initials(name) {
  const words = name.trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word[0] ?? '').join('').toUpperCase() || '?';
}

function render() {
  listElement.replaceChildren();

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
      image.src = server.iconPath;
      image.alt = '';
      button.append(image);
    } else {
      button.textContent = initials(server.name);
    }

    button.addEventListener('click', () => select(server.id));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void removeServer(server);
    });

    item.append(button);
    listElement.append(item);
  }

  const active = servers.find((server) => server.id === activeId) ?? null;
  emptyState.hidden = active !== null;
  placeholder.hidden = active === null;
  if (active) {
    placeholderName.textContent = active.name;
    placeholderUrl.textContent = active.url;
  }
}

/** @param {string} id */
function select(id) {
  activeId = id;
  render();
}

/** @param {Server} server */
async function removeServer(server) {
  const confirmed = window.confirm(`Remove “${server.name}” from your servers?`);
  if (!confirmed) return;
  await window.shell.servers.remove(server.id);
  servers = servers.filter((candidate) => candidate.id !== server.id);
  if (activeId === server.id) activeId = null;
  render();
}

function openDialog() {
  dialogError.hidden = true;
  dialogError.textContent = '';
  urlInput.value = '';
  dialogBackdrop.hidden = false;
  urlInput.focus();
}

function closeDialog() {
  dialogBackdrop.hidden = true;
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const result = await window.shell.servers.add({ url: urlInput.value });
  if (!result.ok) {
    dialogError.textContent = result.error;
    dialogError.hidden = false;
    return;
  }

  servers.push(result.server);
  closeDialog();
  select(result.server.id);
});

document.getElementById('dialog-cancel').addEventListener('click', closeDialog);

dialogBackdrop.addEventListener('mousedown', (event) => {
  if (event.target === dialogBackdrop) closeDialog();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dialogBackdrop.hidden) closeDialog();
});

document.getElementById('add-server').addEventListener('click', openDialog);
document.getElementById('empty-add').addEventListener('click', openDialog);

async function start() {
  servers = await window.shell.servers.list();
  render();
}

void start();
