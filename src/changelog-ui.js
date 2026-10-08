// @ts-check
// The "What's new" popup. changelog.json is generated at publish time, so
// it's missing when serving locally: then there is simply no popup or button.
// The newest commit hash the visitor has dismissed lives in localStorage.

import { groupByDay, unseenEntries } from './changelog.js';
import { t } from './i18n.js';

/** @typedef {import('./changelog.js').ChangeEntry} ChangeEntry */

const SEEN_KEY = 'gk2-factory-changelog-seen';

/** @returns {string | null} */
function readSeen() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

/** @param {string} hash */
function writeSeen(hash) {
  try { localStorage.setItem(SEEN_KEY, hash); } catch { /* storage unavailable */ }
}

/** @returns {Promise<ChangeEntry[]>} */
async function load() {
  try {
    const res = await fetch('changelog.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {ChangeEntry[]} entries
 * @param {string} title
 */
function render(dialog, entries, title) {
  const body = dialog.querySelector('.changelog-body');
  dialog.querySelector('h2').textContent = title;
  body.replaceChildren();
  for (const day of groupByDay(entries)) {
    const h = document.createElement('h3');
    h.textContent = day.date;
    const ul = document.createElement('ul');
    for (const e of day.entries) {
      const li = document.createElement('li');
      li.textContent = e.subject;
      li.title = e.hash.slice(0, 7);
      ul.append(li);
    }
    body.append(h, ul);
  }
}

/**
 * @param {Document} doc
 * @param {boolean} [welcomed] the welcome screen just opened: skip the popup, but count the log as seen
 */
export async function initChangelog(doc, welcomed = false) {
  const dialog = /** @type {HTMLDialogElement | null} */ (doc.getElementById('changelog'));
  const button = /** @type {HTMLButtonElement | null} */ (doc.getElementById('changelog-button'));
  if (!dialog || !button) return;
  const entries = await load();
  if (!entries.length) return;
  const latest = entries[0].hash;
  button.hidden = false;
  // Closing by any route (button, Esc, backdrop click) marks everything as seen.
  dialog.addEventListener('close', () => writeSeen(latest));
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  button.addEventListener('click', () => {
    render(dialog, entries, t('changelog.fullTitle'));
    dialog.showModal();
  });

  if (welcomed) { writeSeen(latest); return; }
  const fresh = unseenEntries(entries, readSeen());
  if (!fresh.length) return;
  render(dialog, fresh, t('changelog.title'));
  dialog.showModal();
}
