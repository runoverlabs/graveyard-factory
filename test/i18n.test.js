import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import EN from '../src/lang/en.js';
import { t, setLanguage, getLanguage, pickLanguage, LANGUAGES } from '../src/i18n.js';
import { ITEM_BY_ID, STATIONS, EXTENSIONS, TALENTS, ENTITY_KINDS } from '../src/catalog.js';

const LANG_DIR = new URL('../src/lang/', import.meta.url);
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;
const baseKey = (k) => k.replace(PLURAL_SUFFIX, '');
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...s.matchAll(/<\/?[a-z]+[^>]*>/g)].map((m) => m[0]).sort().join('');

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'lang' ? [] : sourceFiles(p)) : /\.js$/.test(e.name) ? [p] : [];
  });
}
const root = new URL('..', import.meta.url).pathname;
const sources = [...sourceFiles(path.join(root, 'src')), path.join(root, 'index.html')].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// Keys named by prefix: the code builds them from ids (tool.<id>, kind.<id>, …).
const DYNAMIC = ['tool.', 'kind.', 'chest.level.', 'floor.', 'variant.', 'talent.', 'terrain.', 'slot.', 'port.', 'planner.searching', 'planner.done', 'failure.', 'count.', 'hint.', 'issue.', 'place.'];

test('every key the code asks for is in en.js', () => {
  const asked = new Set();
  for (const m of sources.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) asked.add(m[1]);
  for (const m of sources.matchAll(/data-i18n[a-z-]*="([A-Za-z0-9_.]+)"/g)) asked.add(m[1]);
  for (const m of sources.matchAll(/'((?:hint|field|slot|port|failure|planner)\.[A-Za-z]+)'/g)) asked.add(m[1]);
  const have = new Set(Object.keys(EN).map(baseKey));
  assert.deepEqual([...asked].filter((k) => !have.has(k)), []);
});

test('every key in en.js is used somewhere', () => {
  const unused = [...new Set(Object.keys(EN).map(baseKey))].filter((k) => !sources.includes(`'${k}'`) && !sources.includes(`"${k}"`) && !DYNAMIC.some((p) => k.startsWith(p)));
  assert.deepEqual(unused, []);
});

test('the dynamic key families cover their catalog', () => {
  const need = (prefix, ids) => ids.map((id) => `${prefix}${id}`).filter((k) => !(k in EN));
  assert.deepEqual(need('talent.', Object.keys(TALENTS)), []);
  assert.deepEqual(need('kind.', Object.keys(ENTITY_KINDS)), []);
  assert.deepEqual(need('tool.', ['floor', 'void', 'select', 'erase', 'belt', 'underground', 'splitter', 'station', 'chest', 'supply_station', 'porter']), []);
});

test('t() fills placeholders, picks plurals and falls back to the key', () => {
  assert.equal(t('status.cleared', { n: 1 }), 'Cleared 1 piece (Undo to go back)');
  assert.equal(t('status.cleared', { n: 5 }), 'Cleared 5 pieces (Undo to go back)');
  assert.equal(t('import.done', { name: 'a.json' }), 'Imported a.json');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(t('import.done', {}), 'Imported {name}');
});

test('pickLanguage prefers the saved choice, then the browser language', () => {
  assert.equal(pickLanguage(['de-AT', 'en'], null), 'de');
  assert.equal(pickLanguage(['pt-BR'], null), 'pt-br');
  assert.equal(pickLanguage(['pt-PT'], null), 'pt-br');
  assert.equal(pickLanguage(['zh-CN'], null), 'zh-cn');
  assert.equal(pickLanguage(['zh'], null), 'zh-cn');
  assert.equal(pickLanguage(['xx', 'fr-CA'], null), 'fr');
  assert.equal(pickLanguage(['de'], 'ja'), 'ja');
  assert.equal(pickLanguage(['de'], 'klingon'), 'de');
  assert.equal(pickLanguage([], null), 'en');
});

for (const { code } of LANGUAGES.filter((l) => l.code !== 'en')) {
  const hasFiles = fs.existsSync(new URL(`${code}.js`, LANG_DIR)) && fs.existsSync(new URL(`${code}.names.js`, LANG_DIR));
  test(`${code}: strings cover en.js with the same placeholders and markup`, { skip: !hasFiles && 'not translated yet' }, async () => {
    const strings = (await import(`../src/lang/${code}.js`)).default;
    const enBases = new Set(Object.keys(EN).map(baseKey));
    const bases = new Set(Object.keys(strings).map(baseKey));
    assert.deepEqual([...enBases].filter((k) => !bases.has(k)), [], 'missing keys');
    assert.deepEqual([...bases].filter((k) => !enBases.has(k)), [], 'extra keys');
    for (const [k, v] of Object.entries(strings)) {
      assert.ok(v.trim(), `${k} is empty`);
      const en = EN[k] ?? EN[`${baseKey(k)}.other`] ?? EN[baseKey(k)];
      assert.equal(placeholders(v), placeholders(en), `${k}: placeholders differ`);
      assert.equal(tags(v), tags(en), `${k}: markup differs`);
    }
    // Every base key has a form for 'other' (or is a plain string), so no count falls through.
    for (const k of enBases) assert.ok(k in strings || `${k}.other` in strings, `${k} has no .other form`);
  });

  test(`${code}: game names refer to real catalog ids, and switching language renames and restores`, { skip: !hasFiles && 'not translated yet' }, async () => {
    const names = (await import(`../src/lang/${code}.names.js`)).default;
    for (const id of Object.keys(names.items)) assert.ok(ITEM_BY_ID[id], `unknown item ${id}`);
    for (const id of Object.keys(names.stations)) assert.ok(STATIONS[id], `unknown station ${id}`);
    for (const id of Object.keys(names.extensions)) assert.ok(EXTENSIONS[id], `unknown extension ${id}`);
    for (const id of Object.keys(names.talents)) assert.ok(TALENTS[id], `unknown talent ${id}`);
    for (const v of [...Object.values(names.items), ...Object.values(names.stations), ...Object.values(names.extensions)]) assert.ok(v.trim() && !/[<>]/.test(v), `bad name ${v}`);
    try {
      await setLanguage(code);
      assert.equal(getLanguage(), code);
      assert.equal(ITEM_BY_ID.iron_ore.name, names.items.iron_ore);
      assert.notEqual(ENTITY_KINDS.belt.name, undefined);
    } finally {
      await setLanguage('en');
    }
    assert.equal(ITEM_BY_ID.iron_ore.name, 'Iron ore');
    assert.equal(ENTITY_KINDS.belt.name, 'Conveyor belt');
  });
}
