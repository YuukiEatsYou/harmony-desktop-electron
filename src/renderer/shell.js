'use strict';

/**
 * Shell renderer: draws the server rail and the content area.
 *
 * For now the server list is hard-coded so the layout can be verified. The next
 * step replaces it with the persisted list from the main process over IPC.
 */

/** @typedef {{ id: string, name: string, icon: string | null }} Server */

/** @type {Server[]} */
const servers = [
  { id: 'sample-a', name: 'Makerspace', icon: null },
  { id: 'sample-b', name: 'Book Club', icon: null },
];

/** @type {string | null} */
let activeId = null;

const listElement = document.getElementById('server-list');
const emptyState = document.getElementById('empty-state');

/** Two initials, Discord-ish, for servers without an icon. */
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
    button.title = server.name;
    button.setAttribute('aria-label', server.name);

    if (server.icon) {
      const image = document.createElement('img');
      image.src = server.icon;
      image.alt = '';
      button.append(image);
    } else {
      button.textContent = initials(server.name);
    }

    button.addEventListener('click', () => select(server.id));
    item.append(button);
    listElement.append(item);
  }

  emptyState.hidden = activeId !== null;
}

/** @param {string} id */
function select(id) {
  activeId = id;
  render();
}

document.getElementById('add-server').addEventListener('click', () => {
  // Wired to the add-server flow in a later step.
  console.info('Add server — not implemented yet');
});

document.getElementById('empty-add').addEventListener('click', () => {
  document.getElementById('add-server').click();
});

render();
