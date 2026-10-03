'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FILE_VERSION = 1;

/**
 * @typedef {object} Server
 * @property {string} id          Stable id; also names the session partition.
 * @property {string} url         Normalised base URL, no trailing slash.
 * @property {string} name        Display name (host until metadata is fetched).
 * @property {string | null} iconHash  Server-reported icon hash, or null.
 * @property {string | null} iconPath  Cached icon on disk, or null.
 * @property {string} addedAt     ISO timestamp.
 */

/**
 * Turn whatever the user typed into a canonical base URL.
 *
 * A missing scheme is filled in — https for real hosts, http for loopback,
 * since a local instance is almost never TLS. Query and hash are dropped and a
 * trailing slash is trimmed so the same server is never stored twice.
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Enter a server address.');

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `${isLoopback ? 'http' : 'https'}://${trimmed}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('That does not look like a valid address.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https servers are supported.');
  }
  if (!url.hostname) {
    throw new Error('That address is missing a host.');
  }

  const basePath = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${basePath}`;
}

/** @param {unknown} value @returns {value is Server} */
function isServer(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {any} */ (value).id) === 'string' &&
    typeof (/** @type {any} */ (value).url) === 'string' &&
    typeof (/** @type {any} */ (value).name) === 'string'
  );
}

/** Owns the persisted list of servers and the last-active one, in one JSON file. */
class ServerStore {
  /** @type {string} */
  #file;
  /** @type {Server[]} */
  #servers = [];
  /** @type {string | null} */
  #lastActiveId = null;

  /** @param {string} directory */
  constructor(directory) {
    this.#file = path.join(directory, 'servers.json');
    this.#load();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        console.error(`Could not read ${this.#file}:`, error);
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error(`Could not parse ${this.#file}:`, error);
      return;
    }

    if (!parsed || !Array.isArray(parsed.servers)) return;
    this.#servers = parsed.servers.filter(isServer);
    const lastActive = parsed.lastActiveId;
    this.#lastActiveId =
      typeof lastActive === 'string' && this.#servers.some((server) => server.id === lastActive)
        ? lastActive
        : null;
  }

  /** Atomic write: a crash mid-save must not leave a half-written file. */
  #write() {
    const payload = JSON.stringify(
      { version: FILE_VERSION, servers: this.#servers, lastActiveId: this.#lastActiveId },
      null,
      2,
    );
    const temporary = `${this.#file}.tmp`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(temporary, payload);
    fs.renameSync(temporary, this.#file);
  }

  /** @returns {Server[]} */
  list() {
    return this.#servers.map((server) => ({ ...server }));
  }

  /**
   * @param {string} id
   * @returns {Server | null}
   */
  get(id) {
    const server = this.#servers.find((candidate) => candidate.id === id);
    return server ? { ...server } : null;
  }

  /**
   * Merge a patch into a stored server. Used to attach a cached icon after the
   * metadata fetch, once the record and its id already exist.
   *
   * @param {string} id
   * @param {Partial<Omit<Server, 'id'>>} patch
   * @returns {Server | null}
   */
  update(id, patch) {
    const index = this.#servers.findIndex((server) => server.id === id);
    if (index === -1) return null;
    this.#servers[index] = { ...this.#servers[index], ...patch, id };
    this.#write();
    return { ...this.#servers[index] };
  }

  /**
   * @param {{ url?: string, name?: string, iconHash?: string | null, iconPath?: string | null }} input
   * @returns {{ ok: true, server: Server } | { ok: false, error: string }}
   */
  add(input) {
    let url;
    try {
      url = normalizeUrl(input.url ?? '');
    } catch (error) {
      return { ok: false, error: /** @type {Error} */ (error).message };
    }

    if (this.#servers.some((server) => server.url === url)) {
      return { ok: false, error: 'That server is already in your list.' };
    }

    /** @type {Server} */
    const server = {
      id: randomUUID(),
      url,
      name: (input.name ?? '').trim() || new URL(url).host,
      iconHash: typeof input.iconHash === 'string' ? input.iconHash : null,
      iconPath: typeof input.iconPath === 'string' ? input.iconPath : null,
      addedAt: new Date().toISOString(),
    };

    this.#servers.push(server);
    this.#write();
    return { ok: true, server: { ...server } };
  }

  /** @returns {string | null} */
  getLastActiveId() {
    return this.#lastActiveId;
  }

  /**
   * Remember which server to show on next launch. An id that is not a known
   * server (or null) clears the selection.
   *
   * @param {string | null} id
   * @returns {boolean} always true, so the renderer can fire and forget.
   */
  setLastActiveId(id) {
    const next =
      typeof id === 'string' && this.#servers.some((server) => server.id === id) ? id : null;
    if (next === this.#lastActiveId) return true;
    this.#lastActiveId = next;
    this.#write();
    return true;
  }

  /**
   * @param {string} id
   * @returns {boolean} true when a server was removed.
   */
  remove(id) {
    const before = this.#servers.length;
    this.#servers = this.#servers.filter((server) => server.id !== id);
    if (this.#servers.length === before) return false;
    if (this.#lastActiveId === id) this.#lastActiveId = null;
    this.#write();
    return true;
  }
}

module.exports = { ServerStore, normalizeUrl };
