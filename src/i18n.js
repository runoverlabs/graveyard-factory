// @ts-check
// Translations. English is built in (src/lang/en.js); other languages load on
// demand: src/lang/<code>.js has the interface text, src/lang/<code>.names.js
// the game's own names for items, stations and extensions. No DOM, so the
// model, the planner and the tests can use it.
//
// Game names live in the catalog objects, so setLanguage() rewrites their
// `name` in place (keeping the English ones to switch back) and the rest of
// the code keeps reading `.name`.

import {
  ITEM_BY_ID, STATIONS, EXTENSIONS, TALENTS, ENTITY_KINDS, CHEST_LEVELS, FLOOR_SECTIONS, STATION_VARIANTS, KITCHEN_VARIANTS, BIOREACTOR_VARIANTS,
} from './catalog.js';
import EN from './lang/en.js';

/** @typedef {import('./types.js').NameTable} NameTable */
/** @typedef {Record<string, string>} Strings */
/** @typedef {Record<string, string | number>} Params */

/** The languages the game ships with; `label` is how each names itself. */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'pl', label: 'Polski' },
  { code: 'pt-br', label: 'Português (Brasil)' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'zh-cn', label: '简体中文' },
];

/** @type {string} */
let language = 'en';
/** @type {Strings} */
let strings = EN;
/** @type {Intl.PluralRules} */
let plurals = new Intl.PluralRules('en');

export function getLanguage() {
  return language;
}

/**
 * The text for `key`, with `{name}` placeholders filled from `params`. When
 * `params.n` is a number, `<key>.<plural category>` is used if it exists
 * (one, few, many, other…), so counts read right in every language. A missing
 * key falls back to English, then to the key itself.
 * @param {string} key
 * @param {Params} [params]
 * @returns {string}
 */
export function t(key, params) {
  let text;
  if (params && typeof params.n === 'number') {
    const k = `${key}.${plurals.select(params.n)}`;
    text = strings[k] ?? strings[`${key}.other`] ?? EN[k] ?? EN[`${key}.other`];
  }
  text ??= strings[key] ?? EN[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : text;
}

/**
 * Pick the language to start in: the saved choice, else the first browser
 * language we have ('de-AT' → de, 'pt-PT' → pt-br, 'zh-TW' → zh-cn), else English.
 * @param {readonly string[]} preferred browser languages, best first
 * @param {string | null} [saved]
 * @returns {string}
 */
export function pickLanguage(preferred, saved = null) {
  if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    const exact = LANGUAGES.find((l) => l.code === lower);
    if (exact) return exact.code;
    const base = lower.split('-')[0];
    const match = LANGUAGES.find((l) => l.code === base || l.code.split('-')[0] === base);
    if (match) return match.code;
  }
  return 'en';
}

/** English names, saved the first time they're replaced. @type {Map<{ name: string }, string>} */
const ENGLISH_NAMES = new Map();

/** @param {{ name: string }} obj @param {string | undefined} name undefined restores English */
function rename(obj, name) {
  if (!ENGLISH_NAMES.has(obj)) ENGLISH_NAMES.set(obj, obj.name);
  obj.name = name ?? /** @type {string} */ (ENGLISH_NAMES.get(obj));
}

// Catalog names the game doesn't translate come from our own strings.
function localizeCatalog(/** @type {NameTable | null} */ names) {
  for (const [id, item] of Object.entries(ITEM_BY_ID)) rename(item, names?.items[id]);
  for (const [id, station] of Object.entries(STATIONS)) rename(station, names?.stations[id]);
  for (const [id, extension] of Object.entries(EXTENSIONS)) rename(extension, names?.extensions[id]);
  for (const [id, talent] of Object.entries(TALENTS)) rename(talent, names?.talents[id] ?? ownName(`talent.${id}`));
  for (const [id, kind] of Object.entries(ENTITY_KINDS)) rename(kind, ownName(`kind.${id}`));
  for (const [id, level] of Object.entries(CHEST_LEVELS)) rename(level, ownName(`chest.level.${id}`));
  for (const section of FLOOR_SECTIONS) rename(section, ownName(`floor.${section.id}`));
  for (const [id, v] of Object.entries(STATION_VARIANTS)) rename(v, ownName(`variant.${id}`));
  for (const [id, v] of Object.entries(KITCHEN_VARIANTS)) rename(v, ownName(`variant.${id}`));
  for (const [id, v] of Object.entries(BIOREACTOR_VARIANTS)) rename(v, ownName(`variant.bioreactor_${id}`));
}

/** Our own string for a catalog name, or undefined to keep English. @param {string} key */
function ownName(key) {
  return language === 'en' ? undefined : strings[key];
}

/**
 * Switch the language. Loads its files (English needs none) and renames the
 * catalog; the caller redraws.
 * @param {string} code one of LANGUAGES
 */
export async function setLanguage(code) {
  if (!LANGUAGES.some((l) => l.code === code)) code = 'en';
  /** @type {NameTable | null} */
  let names = null;
  /** @type {Strings} */
  let loaded = EN;
  if (code !== 'en') {
    const [ui, game] = await Promise.all([import(`./lang/${code}.js`), import(`./lang/${code}.names.js`)]);
    loaded = ui.default;
    names = game.default;
  }
  language = code;
  strings = loaded;
  plurals = new Intl.PluralRules(code === 'pt-br' ? 'pt-BR' : code === 'zh-cn' ? 'zh-CN' : code);
  localizeCatalog(names);
}
