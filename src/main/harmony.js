'use strict';

const fs = require('node:fs');

const API_PREFIX = '/api/v1';
const META_TIMEOUT_MS = 10_000;
const ICON_TIMEOUT_MS = 20_000;

/** @param {unknown} error */
function unreachableMessage(error) {
  const name = /** @type {Error} */ (error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'That server took too long to respond.';
  }
  return 'Could not reach that server. Check the address and try again.';
}

/**
 * Ask a server for its public metadata (`GET /api/v1/meta`, no auth). This is
 * what tells us the instance is really Harmony and gives us its name and icon.
 *
 * @param {string} baseUrl
 * @returns {Promise<{ name: string | null, iconHash: string | null, apiVersion: string }>}
 */
async function fetchMeta(baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}${API_PREFIX}/meta`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(unreachableMessage(error));
  }

  if (!response.ok) {
    throw new Error(
      `That server answered with HTTP ${response.status}; it may not be a Harmony instance.`,
    );
  }

  let meta;
  try {
    meta = await response.json();
  } catch {
    throw new Error('That server did not return valid JSON; it may not be a Harmony instance.');
  }

  if (typeof meta?.apiVersion !== 'string') {
    throw new Error('That address does not look like a Harmony server.');
  }

  return {
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : null,
    iconHash: typeof meta.iconHash === 'string' ? meta.iconHash : null,
    apiVersion: meta.apiVersion,
  };
}

/**
 * Download an instance icon to `destination`. Returns false on any failure —
 * a missing icon is never fatal, the server just falls back to initials.
 *
 * @param {string} baseUrl
 * @param {string} iconHash
 * @param {string} destination
 * @returns {Promise<boolean>}
 */
async function fetchIcon(baseUrl, iconHash, destination) {
  let response;
  try {
    response = await fetch(`${baseUrl}${API_PREFIX}/icon?v=${encodeURIComponent(iconHash)}`, {
      signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
    });
  } catch {
    return false;
  }

  if (!response.ok) return false;

  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destination, bytes);
    return true;
  } catch {
    return false;
  }
}

module.exports = { fetchMeta, fetchIcon };
