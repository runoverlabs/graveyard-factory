import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Layout, FLOOR, VOID, REPAIRABLE_SECTIONS, FORMAT_VERSION } from '../src/model.js';
import {
  N, E, S, W, RECIPES, ITEM_BY_ID, STATIONS, EXTENSIONS, BUILD_COST, PORTER, CONVEYOR_ART, CHEST_LEVELS, TALENTS, BELT_MASTER_ICON, POWER_ICON, FLOOR_SECTIONS, FLOOR_GRID, FACTORY_DISTRIBUTORS, FACTORY_CELLAR, CELLAR_ITEMS, stationVariants, extensionsFor, extensionArt,
} from '../src/catalog.js';
import { factoryFloor, DEFAULT_REPAIRED } from '../src/floor.js';

const portsOf = (l, e) => l.ports(e).map((p) => `${p.kind}:${p.nx},${p.ny}`).sort();

test('each station layout variant has 2 inputs and 1 output where described', () => {
  const l = Layout.blank(10, 10);
  const at = (variant) => portsOf(l, { kind: 'station', type: 'smithy', level: 1, variant, x: 3, y: 3, rot: N });
  // Footprint is x 3..5, y 3..5.
  assert.deepEqual(at('out_top_left'), ['in:3,6', 'in:5,6', 'out:3,2']);
  assert.deepEqual(at('out_top_right'), ['in:3,6', 'in:5,6', 'out:5,2']);
  assert.deepEqual(at('in_left'), ['in:2,4', 'in:2,5', 'out:6,4']);
  assert.deepEqual(at('in_right'), ['in:6,4', 'in:6,5', 'out:2,4']);
});

test('stations ignore rotation and default to out_top_left', () => {
  const l = Layout.blank(10, 10);
  const st = l.add({ kind: 'station', type: 'smithy', level: 1, x: 3, y: 3, rot: E });
  assert.equal(st.variant, 'out_top_left');
  assert.equal(st.rot, undefined);
  assert.deepEqual(portsOf(l, st), ['in:3,6', 'in:5,6', 'out:3,2']);
});

test('underground conveyor: 1x5, crossable gap, ports at the ends', () => {
  const l = Layout.blank(10, 10);
  const u = l.add({ kind: 'underground', x: 2, y: 4, rot: E }); // cells 2..6, gap at 4
  assert.deepEqual(l.footprint(u), [[2, 4], [3, 4], [5, 4], [6, 4]]);
  assert.equal(l.entityAt(4, 4), null);
  assert.equal(l.gapAt(4, 4), u);
  assert.deepEqual(portsOf(l, u), ['in:1,4', 'out:7,4']);
  // A belt, a chest or another underground's belt cell may sit on the gap;
  // nothing else may, and not on the rest.
  assert.equal(l.canPlace({ kind: 'belt', x: 4, y: 4 }).ok, true);
  assert.equal(l.canPlace({ kind: 'chest', x: 4, y: 4 }).ok, true);
  assert.equal(l.canPlace({ kind: 'underground', x: 4, y: 3, rot: S }).ok, true); // its cell 2 on the gap
  assert.equal(l.canPlace({ kind: 'underground', x: 4, y: 2, rot: S }).ok, false); // gap on gap
  assert.equal(l.canPlace({ kind: 'splitter', x: 4, y: 4 }).ok, false);
  assert.equal(l.canPlace({ kind: 'belt', x: 3, y: 4 }).ok, false);
  assert.equal(l.canPlace({ kind: 'chest', x: 3, y: 4 }).ok, false);
  // Crossing belt line north -> south through the gap is valid.
  for (let y = 2; y <= 6; y++) l.add({ kind: 'belt', x: 4, y, rot: S });
  l.add({ kind: 'belt', x: 1, y: 4, rot: E });
  assert.deepEqual(l.validate(), []);
  // Overlapping existing pieces is rejected.
  assert.equal(l.canPlace({ kind: 'underground', x: 0, y: 0, rot: E }).ok, true);
  assert.equal(l.canPlace({ kind: 'underground', x: 4, y: 7, rot: N }).ok, false);
  // Its belt cells take a belt merging from the side, like a belt.
  l.add({ kind: 'belt', x: 3, y: 5, rot: N });
  l.add({ kind: 'belt', x: 6, y: 3, rot: S });
  assert.deepEqual(l.validate(), []);
  assert.equal(l.acceptsFrom(u, 7, 4), false); // not from in front
  assert.equal(l.acceptsFrom(u, 4, 3), false); // nor beside the gap
  assert.equal(l.acceptsFrom(u, 2, 3), true);
});

test('undergrounds cross at the gap, both ways', () => {
  const l = Layout.blank(10, 10);
  const a = l.add({ kind: 'underground', x: 2, y: 4, rot: E }); // gap at 4,4
  for (const [i, e] of [[0, { x: 4, y: 4, rot: N }], [1, { x: 4, y: 5, rot: N }], [3, { x: 4, y: 7, rot: N }], [4, { x: 4, y: 0, rot: S }]]) {
    const b = /** @type {any} */ ({ kind: 'underground', ...e });
    assert.equal(l.canPlace(b).ok, true, `cell ${i} on the gap`);
    const placed = l.add(b);
    assert.deepEqual(l.validate().filter((x) => x.severity === 'error'), []);
    assert.equal(l.entityAt(4, 4), placed);
    assert.equal(l.gapAt(4, 4), a);
    l.remove(placed.id);
  }
  // And the other way round: its gap under the other's belt cell.
  assert.equal(l.canPlace({ kind: 'underground', x: 3, y: 2, rot: S }).ok, true);
  assert.equal(l.canPlace({ kind: 'underground', x: 2, y: 2, rot: S }).ok, true);
  assert.equal(l.canPlace({ kind: 'underground', x: 4, y: 2, rot: S }).ok, false); // gaps clash
});

test('underground gap must be floor; off-floor cells under the body block placement', () => {
  const l = Layout.blank(10, 3);
  l.setTerrain(4, 1, VOID);
  assert.equal(l.canPlace({ kind: 'underground', x: 2, y: 1, rot: E }).ok, false); // gap off the floor
  l.setTerrain(4, 1, FLOOR);
  l.setTerrain(6, 1, VOID);
  assert.equal(l.canPlace({ kind: 'underground', x: 2, y: 1, rot: E }).ok, false); // body off the floor
});

test('a chest on an underground gap is valid, and an underground may pass under a chest', () => {
  const l = Layout.blank(10, 10);
  l.add({ kind: 'underground', x: 2, y: 4, rot: E });
  l.add({ kind: 'chest', x: 4, y: 4, stock: ['coal'], filters: { S: 'coal' } });
  l.add({ kind: 'belt', x: 4, y: 3, rot: S }); // into the chest
  l.add({ kind: 'belt', x: 4, y: 5, rot: S }); // out of it
  assert.deepEqual(l.validate(), []);
  const c = l.add({ kind: 'chest', x: 7, y: 7 });
  assert.equal(l.canPlace({ kind: 'underground', x: 5, y: 7, rot: E }).ok, true); // gap at 7,7
  assert.equal(l.canPlace({ kind: 'underground', x: 6, y: 7, rot: E }).ok, false); // body on the chest
  l.add({ kind: 'underground', x: 7, y: 5, rot: S }); // gap at 7,7 under the chest
  assert.deepEqual(l.validate().filter((i) => i.severity === 'error'), []);
  assert.equal(l.entityAt(7, 7), c);
});

test('splitter takes from behind and outputs to both sides', () => {
  const l = Layout.blank(5, 5);
  const sp = l.add({ kind: 'splitter', x: 2, y: 2, rot: N });
  assert.deepEqual(portsOf(l, sp), ['in:2,3', 'out:1,2', 'out:3,2']);
  l.add({ kind: 'belt', x: 2, y: 3, rot: N });
  l.add({ kind: 'belt', x: 2, y: 1, rot: S }); // feeds splitter from the front
  const msgs = l.validate().map((i) => i.message);
  assert.ok(msgs.some((m) => /Belt at 2,1 feeds Conveyor splitter/.test(m)), msgs.join('\n'));
  assert.equal(msgs.length, 1);
});

test('chests accept from and output to any side', () => {
  const l = Layout.blank(5, 5);
  l.add({ kind: 'chest', x: 2, y: 2, stock: ['coal'], filters: { E: 'coal', W: 'iron_ore' } });
  l.add({ kind: 'belt', x: 2, y: 1, rot: S });  // into chest from the north
  l.add({ kind: 'belt', x: 2, y: 3, rot: N });  // into chest from the south
  l.add({ kind: 'belt', x: 3, y: 2, rot: E });  // out east
  l.add({ kind: 'belt', x: 1, y: 2, rot: W });  // out west
  assert.deepEqual(l.validate(), []);
  l.add({ kind: 'chest', x: 0, y: 0, filters: { Q: 'coal' } });
  assert.ok(l.validate().some((i) => /unknown filter side "Q"/.test(i.message)));
});

test('station output can push straight into a chest; chest cannot feed a station input', () => {
  const l = Layout.blank(8, 8);
  // out_top_left at (2,2): inputs below (2,5) and (4,5), output above (2,1).
  l.add({ kind: 'station', type: 'smithy', level: 1, x: 2, y: 2, recipe: 'iron_ingot' });
  l.add({ kind: 'chest', x: 2, y: 1 });
  assert.deepEqual(l.validate(), []);
  l.add({ kind: 'chest', x: 4, y: 5, stock: ['coal'] });
  const msgs = l.validate().map((i) => i.message);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Chest \(Coal\) at 4,5 can't feed Smithy I at 2,2 directly/);
});

test('a chest side filtered towards another chest is a warning: chests only output onto belts', () => {
  const l = Layout.blank(5, 5);
  l.add({ kind: 'chest', x: 1, y: 2, stock: ['coal'] });
  l.add({ kind: 'chest', x: 2, y: 2, stock: ['coal'] }); // unfiltered neighbours: fine
  assert.deepEqual(l.validate(), []);
  l.update(l.entityAt(1, 2).id, { filters: { E: 'coal' } });
  const msgs = l.validate().map((i) => i.message);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Chest \(Coal\) at 1,2 can't pass items to Chest \(Coal\) at 2,2/);
});

test('older files migrate: chest material -> stock, station rotation dropped', () => {
  const l = Layout.fromJSON({ terrain: ['.....'], entities: [
    { id: 1, kind: 'chest', x: 0, y: 0, rot: 1, material: 'coal' },
    { id: 2, kind: 'belt', x: 4, y: 0 },
  ] });
  assert.deepEqual(l.getEntity(1), { id: 1, kind: 'chest', x: 0, y: 0, level: 1, stock: ['coal'], filters: {}, locked: true });
  assert.equal(l.getEntity(2).rot, 0);
});

test('recipe data is consistent', () => {
  for (const r of RECIPES) {
    for (const id of [...Object.keys(r.inputs), ...Object.keys(r.outputs)]) assert.ok(ITEM_BY_ID[id], `${r.id}: unknown item ${id}`);
    assert.ok(Object.keys(r.inputs).length <= 2, `${r.id} needs more than 2 input types`);
    assert.ok(r.levels.every((lv) => STATIONS[r.station].levels.includes(lv)), `${r.id}: bad level`);
  }
  assert.equal(RECIPES.length, 68);
  for (const r of RECIPES) {
    assert.ok(r.time > 0 && (r.talent > 0 || r.station === 'bioreactor'), `${r.id}: time and talent from the game data`);
    if (r.extension) assert.equal(EXTENSIONS[r.extension]?.station, r.station, `${r.id}: extension ${r.extension}`);
  }
});

test('bioreactor is 2 wide and 3 high with its ports in the middle row, and flips', () => {
  const l = Layout.blank(8, 8);
  const b = l.add({ kind: 'station', type: 'bioreactor', level: 1, x: 2, y: 2, recipe: 'zombie_power' });
  assert.equal(b.variant, 'in_left');
  assert.equal(l.footprint(b).length, 6);
  assert.deepEqual(l.entityAt(3, 4)?.id, b.id);
  assert.equal(l.entityAt(4, 3), null);
  const at = (p) => [p.kind, p.nx, p.ny];
  assert.deepEqual(l.ports(b).map(at), [['in', 1, 3], ['out', 4, 3]]);
  l.update(b.id, { variant: 'in_right' });
  assert.deepEqual(l.ports(b).map(at), [['in', 4, 3], ['out', 1, 3]]);
  const r = RECIPES.find((x) => x.id === 'zombie_power');
  assert.deepEqual([r.inputs, r.outputs, r.time], [{ wheat: 5 }, { zombie_power: 1 }, 10]);
});

test('kitchen is 2x2 with inputs on top or on a side', () => {
  const l = Layout.blank(8, 8);
  const k = l.add({ kind: 'station', type: 'kitchen', level: 1, x: 2, y: 2 });
  assert.equal(k.variant, 'out_bottom_left');
  assert.equal(l.footprint(k).length, 4);
  const at = (p) => [p.kind, p.nx, p.ny];
  assert.deepEqual(l.ports(k).map(at), [['in', 2, 1], ['in', 3, 1], ['out', 2, 4]]);
  l.update(k.id, { variant: 'in_right' });
  assert.deepEqual(l.ports(k).map(at), [['in', 4, 2], ['in', 4, 3], ['out', 1, 2]]);
});

test('station art covers every level and layout, and the files exist', () => {
  for (const [type, def] of Object.entries(STATIONS)) {
    if (!def.sprites) continue;
    assert.deepEqual(Object.keys(def.sprites).map(Number), def.levels, `${type}: art per level`);
    for (const byVariant of Object.values(def.sprites)) {
      assert.deepEqual(Object.keys(byVariant).sort(), Object.keys(stationVariants(type)).sort(), `${type}: art per layout`);
      for (const s of Object.values(byVariant)) assert.ok(fs.existsSync(new URL(`../${s.src}`, import.meta.url)), `missing ${s.src}`);
    }
  }
});

test('every item has an icon file', () => {
  for (const item of Object.values(ITEM_BY_ID)) {
    assert.ok(fs.existsSync(new URL(`../${item.icon}`, import.meta.url)), `${item.id}: missing ${item.icon}`);
  }
});

test('canPlace rejects off-floor cells, overlap and out of bounds', () => {
  const l = Layout.blank(6, 6);
  l.setTerrain(2, 2, VOID);
  l.setTerrain(5, 5, VOID);
  l.add({ kind: 'belt', x: 0, y: 0, rot: E });
  assert.equal(l.canPlace({ kind: 'belt', x: 2, y: 2 }).ok, false);
  assert.equal(l.canPlace({ kind: 'belt', x: 5, y: 5 }).ok, false);
  assert.equal(l.canPlace({ kind: 'belt', x: 0, y: 0 }).ok, false);
  assert.equal(l.canPlace({ kind: 'station', type: 'smithy', x: 4, y: 0 }).ok, false);
  assert.equal(l.canPlace({ kind: 'station', type: 'smithy', x: 3, y: 3 }).ok, false); // covers 5,5 void
  assert.equal(l.canPlace({ kind: 'station', type: 'smithy', x: 3, y: 0 }).ok, true);
});

test('JSON round trip preserves terrain and entities', () => {
  const l = factoryFloor();
  l.add({ kind: 'station', type: 'smithy', level: 1, variant: 'in_left', x: 10, y: 20, recipe: 'iron_ingot' });
  l.add({ kind: 'chest', x: 5, y: 20, stock: ['coal'], filters: { E: 'coal' } });
  l.add({ kind: 'underground', x: 5, y: 25, rot: E });
  const copy = Layout.fromJSON(JSON.stringify(l.toJSON()));
  assert.equal(copy.terrainToText(), l.terrainToText());
  assert.deepEqual(copy.entities, l.entities);
  assert.equal(copy.nextId, l.nextId);
});

test('terrain text: short rows are padded; old walls and columns load as outside', () => {
  const l = Layout.blank(1, 1);
  l.setTerrainFromText('...#\n._oO\n\n');
  assert.equal(l.width, 4);
  assert.equal(l.height, 2);
  assert.equal(l.terrainToText(), '... \n.   ');
  assert.throws(() => l.setTerrainFromText('..?'), /Unknown terrain/);
});

test('resize shifts entities and drops those outside', () => {
  const l = Layout.blank(5, 5);
  const a = l.add({ kind: 'belt', x: 0, y: 0 });
  const b = l.add({ kind: 'belt', x: 4, y: 4 });
  l.resize({ left: 2, top: 1, right: -3 });
  assert.equal(l.width, 4);
  assert.equal(l.height, 6);
  assert.deepEqual([l.getEntity(a.id).x, l.getEntity(a.id).y], [2, 1]);
  assert.equal(l.getEntity(b.id), null);
  assert.equal(l.getTerrain(0, 0), VOID);
  assert.equal(l.getTerrain(2, 1), FLOOR);
});

test('validation flags common problems', () => {
  const l = Layout.blank(8, 8);
  l.setTerrain(7, 0, VOID);
  l.add({ kind: 'belt', x: 6, y: 0, rot: E });            // runs off the floor
  l.add({ kind: 'belt', x: 0, y: 7, rot: E });
  l.add({ kind: 'belt', x: 1, y: 7, rot: W });            // head-on
  l.add({ kind: 'distributor', x: 0, y: 5, rot: N });     // no material
  l.add({ kind: 'station', type: 'smithy', level: 1, x: 2, y: 2, recipe: 'clay_molds' }); // needs level II
  l.add({ kind: 'belt', x: 3, y: 1, rot: S });            // feeds station top side (output only)
  l.add({ kind: 'station', type: 'smithy', level: 3, x: 5, y: 4 });                     // smithy has no level III
  const msgs = l.validate().map((i) => `${i.severity}: ${i.message}`);
  const has = (re) => assert.ok(msgs.some((m) => re.test(m)), `missing ${re}\n${msgs.join('\n')}`);
  has(/warning: Belt at 6,0 runs off the factory floor/);
  has(/warning: Belts at 0,7 and 1,7 face each other/);
  has(/warning: Distribution station at 0,5 has no material/);
  has(/error: Smithy I .* cannot run recipe "clay_molds"/);
  has(/error: Smithy has no level 3/);
  has(/warning: Belt at 3,1 feeds Smithy I .* from a side with no input/);
});

test('factory floor is valid and matches factory.json', () => {
  const floor = factoryFloor();
  assert.deepEqual(floor.validate(), []);
  assert.equal(floor.entities.length, FACTORY_DISTRIBUTORS.length);
  const raw = JSON.parse(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  // factory.json (format 1) sits 12 rows higher. The game's sections give the
  // same floor, except 4 cells by the east wall that the screenshot shows as wall
  // and the 2 cells of a column (FLOOR_HOLES).
  const differ = [];
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if ((raw.terrain[y - 12]?.[x] === '.') !== floor.isFloor(x, y)) differ.push(`${x},${y}`);
    }
  }
  assert.deepEqual(differ, ['33,36', '34,36', '33,37', '34,37', '29,41', '30,41']);
  const exported = Layout.fromJSON(raw);
  assert.deepEqual(exported.repaired, DEFAULT_REPAIRED);
  assert.equal(floor.terrainToText(), exported.terrainToText());
});

test('floor sections: a cell is floor only when repaired sections cover all of it', () => {
  const floorCells = (/** @type {number[]} */ ids) => factoryFloor(ids).terrain.filter((t) => t === FLOOR).length;
  assert.equal(floorCells([]), 594);
  assert.equal(floorCells(DEFAULT_REPAIRED), 836);
  assert.equal(floorCells(REPAIRABLE_SECTIONS), 1350);
  // Column 10 straddles sections 5 and 6: floor only with both.
  assert.ok(factoryFloor([5]).isFloor(10, 30));
  assert.ok(!factoryFloor([]).isFloor(10, 30));
  // Row 26 is half section 3/4, half 5/6.
  assert.ok(!factoryFloor(DEFAULT_REPAIRED).isFloor(5, 26));
  assert.ok(factoryFloor([3, 5]).isFloor(5, 26));
  // Every section fits the grid, and the ones there from the start have no repair.
  for (const s of FLOOR_SECTIONS) {
    for (const [x0, y0, x1, y1] of s.rects) assert.ok(x0 >= 0 && y0 >= 0 && x1 <= FLOOR_GRID.width && y1 <= FLOOR_GRID.height && x0 < x1 && y0 < y1, `section ${s.id}`);
    for (const id of Object.keys(s.repair ?? {})) assert.ok(ITEM_BY_ID[id], `section ${s.id}: unknown item ${id}`);
  }
  assert.deepEqual(REPAIRABLE_SECTIONS, [1, 2, 3, 4, 5, 8]);
});

test('format 1 factory files move down 12 rows and get their repaired sections', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  raw.entities.push({ id: 99, kind: 'belt', x: 5, y: 20, rot: 0 });
  const l = Layout.fromJSON(raw);
  assert.equal(l.width, FLOOR_GRID.width);
  assert.equal(l.height, FLOOR_GRID.height);
  assert.deepEqual(l.getEntity(99), { id: 99, kind: 'belt', x: 5, y: 32, rot: 0, locked: true });
  assert.deepEqual(l.entities.filter((e) => e.kind === 'distributor').map((e) => e.y), FACTORY_DISTRIBUTORS.map((d) => d.y));
  // Saved again, it's the current format with the sections, and loads unchanged.
  const json = l.toJSON();
  assert.equal(json.version, FORMAT_VERSION);
  assert.deepEqual(json.repaired, DEFAULT_REPAIRED);
  assert.equal(Layout.fromJSON(json).terrainToText(), l.terrainToText());
  assert.deepEqual(Layout.fromJSON(json).getEntity(99), l.getEntity(99));
  // Layouts with their own floor aren't touched.
  const own = Layout.fromJSON({ terrain: ['....', '.  .'] });
  assert.equal(own.repaired, null);
  assert.equal(own.terrainToText(), '....\n.  .');
  assert.equal(own.toJSON().repaired, undefined);
});

test('distribution stations are fixed in the wall, and follow the floor they feed', () => {
  const l = factoryFloor();
  // One row below the floor, feeding its bottom row.
  for (const d of l.entities) {
    assert.ok(!l.isFloor(d.x, d.y) && l.isFloor(d.x, d.y - 1), `${d.material} at ${d.x},${d.y}`);
    assert.equal(d.y, FLOOR_GRID.height - 2);
  }
  l.setRepaired([5]); // section 8 off: marble and iron ore feed it
  assert.deepEqual(l.entities.map((e) => e.material), ['coal', 'clay', 'sand', 'stone', 'wood_log']);
  l.setRepaired(DEFAULT_REPAIRED);
  assert.deepEqual(l.entities.map((e) => e.material).sort(), FACTORY_DISTRIBUTORS.map((d) => d.material).sort());
  assert.deepEqual(l.validate(), []);
  // Distributors saved somewhere else (or extra ones) are put back where the factory has them.
  const json = l.toJSON();
  json.entities = [{ id: 1, kind: 'distributor', x: 3, y: 52, rot: 0, material: 'marble' }, { id: 2, kind: 'distributor', x: 5, y: 40, rot: 0, material: 'coal' }];
  const back = Layout.fromJSON(json);
  assert.deepEqual(back.entities.map((e) => `${e.material}@${e.x},${e.y}`).sort(), FACTORY_DISTRIBUTORS.map((d) => `${d.material}@${d.x},${d.y}`).sort());
});

test('in front of a distributor: empty, a belt or an underground belt cell, not pointing back', () => {
  const l = factoryFloor();
  const front = { x: 11, y: 52 }; // coal distributor at 11,53
  const ok = (/** @type {any} */ e) => l.canPlace({ ...front, ...e }).ok;
  assert.equal(ok({ kind: 'belt', rot: N }), true);
  assert.equal(ok({ kind: 'belt', rot: E }), true);
  assert.equal(ok({ kind: 'belt', rot: W }), true);
  assert.equal(ok({ kind: 'belt', rot: S }), false);       // back into the distributor
  assert.equal(ok({ kind: 'underground', rot: N }), true);  // entry there
  assert.equal(ok({ kind: 'underground', rot: E }), true);  // its exit sits in front of the clay one at 15,53
  assert.equal(ok({ kind: 'underground', rot: W }), true);
  assert.equal(ok({ kind: 'underground', rot: S }), false); // back into it
  assert.equal(ok({ kind: 'chest' }), false);
  assert.equal(ok({ kind: 'splitter', rot: N }), false);
  assert.equal(ok({ kind: 'supply_station', rot: N }), false);
  assert.equal(l.canPlace({ kind: 'station', type: 'smithy', level: 1, x: 10, y: 50 }).ok, false); // covers it
  assert.equal(l.canPlace({ kind: 'underground', x: 9, y: 52, rot: E }).ok, true); // gap over it: it only passes below
  const g = l.add({ kind: 'underground', x: 9, y: 52, rot: E });
  assert.deepEqual(l.validate().filter((i) => i.severity !== 'info'), []);
  l.remove(g.id);
  assert.equal(l.canPlace({ kind: 'underground', x: 10, y: 52, rot: E }).ok, true); // a belt cell over it
  // The distributor feeds that cell like a chest feeds a belt.
  const u = l.add({ kind: 'underground', x: 10, y: 52, rot: E });
  assert.equal(l.acceptsFrom(u, 11, 53), true);
  assert.deepEqual(l.validate().filter((i) => i.severity !== 'info'), []);
  l.remove(u.id);
  // Validation catches what canPlace would refuse (e.g. from a file).
  l.add({ kind: 'chest', ...front });
  assert.match(l.validate().find((i) => i.severity === 'error').message, /Chest at 11,52 can't be in front of Distribution station \(Coal\) at 11,53/);
});

test('the cellar sits off the grid at -1,14, feeding 0,14, when the North-west section is repaired', () => {
  const l = factoryFloor(DEFAULT_REPAIRED);
  assert.ok(!DEFAULT_REPAIRED.includes(3));
  assert.equal(l.entities.some((e) => e.kind === 'cellar'), false);
  l.setRepaired([...DEFAULT_REPAIRED, 3]);
  const cellar = l.entities.find((e) => e.kind === 'cellar');
  assert.deepEqual({ x: cellar.x, y: cellar.y, rot: cellar.rot, stock: cellar.stock }, { ...FACTORY_CELLAR, stock: [] });
  assert.equal(l.isFloor(0, 14), true);
  assert.equal(l.entityAt(-1, 14), cellar);
  assert.equal(l.entityAt(41, 13), null); // no wrap-around
  assert.deepEqual(portsOf(l, cellar), ['out:0,14']);
  // What it holds survives saving, loading and changing other sections.
  l.update(cellar.id, { stock: ['beer', 'wine_2'] });
  const back = Layout.fromJSON(l.toJSON());
  back.setRepaired([3]);
  assert.deepEqual(back.entities.find((e) => e.kind === 'cellar').stock, ['beer', 'wine_2']);
  // Its front takes a belt or an underground's belt cell, like a distributor's.
  assert.equal(l.canPlace({ kind: 'belt', x: 0, y: 14, rot: E }).ok, true);
  assert.equal(l.canPlace({ kind: 'belt', x: 0, y: 14, rot: W }).ok, false);
  assert.equal(l.canPlace({ kind: 'chest', x: 0, y: 14 }).ok, false);
  const belt = l.add({ kind: 'belt', x: 0, y: 14, rot: E });
  assert.equal(l.acceptsFrom(belt, -1, 14), true);
  l.add({ kind: 'chest', x: 1, y: 14, filters: { N: 'beer', E: 'wine_2' } });
  assert.deepEqual(l.validate().filter((i) => i.severity !== 'info'), []);
  // Only beer and wine.
  l.update(cellar.id, { stock: ['iron_ore'] });
  assert.match(l.validate().find((i) => i.severity === 'error').message, /Cellar \(Iron ore\) at -1,14 can't hold Iron ore/);
  assert.deepEqual(CELLAR_ITEMS.map((id) => ITEM_BY_ID[id].name), ['Beer', 'Wine ★', 'Wine ★★', 'Wine ★★★']);
  // Gone again with its section.
  l.setRepaired(DEFAULT_REPAIRED);
  assert.equal(l.entities.some((e) => e.kind === 'cellar'), false);
});

test('extensions: one per slot, only for their station, and recipes need theirs', () => {
  const l = Layout.blank(12, 6);
  const msgs = () => l.validate().filter((i) => i.severity === 'error').map((i) => i.message);
  const s = l.add({ kind: 'station', type: 'smithy', level: 1, x: 1, y: 1, recipe: 'iron_kit_1' });
  assert.deepEqual(s.extensions, ['hammer']); // added for the recipe
  l.update(s.id, { extensions: [] });
  assert.match(msgs()[0], /needs the Hammer extension/);
  l.update(s.id, { extensions: ['bellows', 'hammer'] });
  assert.deepEqual(msgs(), []);
  l.update(s.id, { extensions: ['hammer', 'press'] });
  assert.match(msgs()[0], /Hammer and Press need the same big slot/);
  l.update(s.id, { extensions: ['hammer', 'lathe'] });
  assert.match(msgs()[0], /can't take the Lathe extension/);
});

test('older files migrate: stations get the extension their recipe needs', () => {
  const l = Layout.fromJSON({ terrain: ['....', '....', '....'], entities: [
    { id: 1, kind: 'station', type: 'assembly_bench', level: 2, x: 0, y: 0, recipe: 'zombie_mechanism' },
  ] });
  assert.deepEqual(l.getEntity(1).extensions, ['lathe']);
});

test('conveyor, chest, talent and extension art files exist', () => {
  const exists = (src) => assert.ok(fs.existsSync(new URL(`../${src}`, import.meta.url)), `missing ${src}`);
  for (const [kind, byDir] of Object.entries(CONVEYOR_ART)) {
    for (const [dir, shapes] of Object.entries(byDir)) {
      if (Array.isArray(shapes)) exists(`assets/conveyors/${kind}_${dir}.webp`); // one piece per direction
      else for (const shape of Object.keys(shapes)) exists(`assets/conveyors/${kind}_${dir}_${shape}.webp`);
    }
  }
  for (const c of Object.values(CHEST_LEVELS)) exists(c.art);
  for (const t of Object.values(TALENTS)) exists(t.icon);
  exists(BELT_MASTER_ICON);
  exists(POWER_ICON);
  for (const [type, def] of Object.entries(STATIONS)) {
    for (const id of extensionsFor(type)) {
      exists(EXTENSIONS[id].icon);
      for (const level of def.levels) for (const variant of Object.keys(stationVariants(type))) exists(extensionArt({ type, level, variant }, id));
    }
  }
});

test('render order: conveyors first, then the rest, each top to bottom', async () => {
  const { drawOrder } = await import('../src/render.js');
  const st = { id: 1, kind: 'station', type: 'smithy', level: 1, variant: 'out_top_left', x: 2, y: 2 }; // rows 2-4
  const above = { id: 2, kind: 'belt', x: 3, y: 1, rot: 1 };
  const beside = { id: 3, kind: 'belt', x: 5, y: 3, rot: 1 };
  const below = { id: 4, kind: 'belt', x: 3, y: 5, rot: 1 };
  const chestTop = { id: 5, kind: 'chest', x: 0, y: 0 };
  const chestLow = { id: 6, kind: 'chest', x: 0, y: 6 };
  assert.deepEqual(drawOrder([chestLow, below, st, beside, chestTop, above]).map((e) => e.id), [2, 3, 4, 5, 1, 6]);
  // Conveyors on an underground's gap go over it.
  const ug = { id: 7, kind: 'underground', x: 0, y: 0, rot: 2 }; // gap at 0,2
  const cross = { id: 8, kind: 'belt', x: 0, y: 2, rot: 1 };
  const crossUg = { id: 9, kind: 'underground', x: 0, y: 2, rot: 1 };
  assert.deepEqual(drawOrder([cross, crossUg, ug]).map((e) => e.id), [7, 8, 9]);
});

test('a station side output needs a belt before a chest; a top output does not', () => {
  const warns = (l) => l.validate().filter((i) => i.severity === 'warning').map((i) => i.message);
  const side = Layout.blank(8, 6);
  side.add({ kind: 'station', type: 'smithy', level: 1, variant: 'in_left', x: 1, y: 1, recipe: 'brick' }); // output E at (3,2)
  side.add({ kind: 'chest', x: 4, y: 2 });
  assert.ok(warns(side).some((m) => /side output can't push straight into Chest/.test(m)), warns(side).join('\n'));
  const top = Layout.blank(8, 6);
  top.add({ kind: 'station', type: 'smithy', level: 1, variant: 'out_top_left', x: 1, y: 2, recipe: 'brick' }); // output N at (1,2)
  top.add({ kind: 'chest', x: 1, y: 1 });
  assert.ok(!warns(top).some((m) => /side output/.test(m)));
});

test('factory power: 1 per station and belt, 2 per underground, none for chests', () => {
  const l = Layout.blank(12, 8);
  l.add({ kind: 'station', type: 'smithy', level: 1, x: 1, y: 1 });
  l.add({ kind: 'belt', x: 5, y: 1, rot: E });
  l.add({ kind: 'belt', x: 6, y: 1, rot: E });
  l.add({ kind: 'chest', x: 7, y: 1 });                  // no power
  l.add({ kind: 'splitter', x: 8, y: 3, rot: E });       // no power listed
  l.add({ kind: 'distributor', x: 0, y: 7, rot: N, material: 'coal' });
  assert.equal(l.power(), 3);
  l.add({ kind: 'underground', x: 1, y: 5, rot: E });
  assert.equal(l.power(), 5);
});

test('build materials: every buildable piece has a cost in known items, and a layout adds them up', () => {
  for (const [type, s] of Object.entries(STATIONS)) {
    for (const level of s.levels) assert.ok(BUILD_COST.station[type][level], `${type} ${level}`);
  }
  for (const level of Object.keys(CHEST_LEVELS)) assert.ok(BUILD_COST.chest[level], `chest ${level}`);
  const all = [
    BUILD_COST.belt, BUILD_COST.underground, BUILD_COST.splitter, BUILD_COST.supply_station, BUILD_COST.porter,
    ...Object.values(BUILD_COST.chest), ...Object.values(BUILD_COST.station).flatMap((l) => Object.values(l)),
    ...Object.values(EXTENSIONS).map((x) => x.build),
  ];
  for (const m of all) for (const [id, n] of Object.entries(m)) assert.ok(ITEM_BY_ID[id] && n > 0, id);
  assert.equal(BUILD_COST.porter, PORTER.build);

  const l = Layout.blank(16, 10);
  assert.deepEqual(l.buildMaterials(), {});
  l.add({ kind: 'station', type: 'smithy', level: 2, x: 1, y: 1, extensions: ['bellows'] });
  l.add({ kind: 'belt', x: 5, y: 1, rot: E });
  l.add({ kind: 'belt', x: 6, y: 1, rot: E });
  l.add({ kind: 'underground', x: 1, y: 5, rot: E });
  l.add({ kind: 'splitter', x: 8, y: 3, rot: E });
  l.add({ kind: 'chest', x: 7, y: 1, level: 2 });
  l.add({ kind: 'distributor', x: 0, y: 9, rot: N, material: 'coal' }); // fixed: not built
  assert.deepEqual(l.buildMaterials(), {
    reinforced_beam: 6, steel_screws: 12, engineering_details: 4, // smithy II
    leather_scroll: 4, iron_detail: 2, wooden_plank: 4, // bellows
    bronze_gear: 2 + 4 + 3 + 4, fabric: 2 + 2 + 1, // 2 belts, underground, splitter, chest II
    advanced_detail: 4, wooden_joint: 2, // chest II
  });
});

test('power supply: 5 fixed carousels, 20 zombies, 10 power each (20 with Belt Master)', async () => {
  const { powerSupply } = await import('../src/model.js');
  assert.deepEqual(powerSupply(200, false), { used: 200, perZombie: 10, carousels: 5, maxZombies: 20, available: 200, zombies: 20, over: 0 });
  assert.equal(powerSupply(201, false).over, 1);
  assert.equal(powerSupply(201, false).zombies, 21);
  assert.equal(powerSupply(400, true).over, 0);
  assert.equal(powerSupply(405, true).over, 5);
});

test('power over the maximum is a warning', () => {
  const l = Layout.blank(50, 5);
  for (let x = 0; x < 50; x++) for (let y = 0; y < 5; y++) l.add({ kind: 'belt', x, y, rot: E }); // 250 power
  const warn = () => l.validate().filter((i) => i.severity === 'warning' && /over the factory/.test(i.message));
  assert.match(warn()[0].message, /Power 250 is over the factory's 200 \(20 zombies on 5 carousels\): 50 too many/);
  l.beltMaster = true;
  assert.equal(warn().length, 0); // 400 with Belt Master
});

test('placed zombie carousels from older files are dropped (the factory\'s are fixed)', () => {
  const l = Layout.fromJSON({ terrain: ['.....', '.....', '.....'], entities: [
    { id: 1, kind: 'carousel', x: 0, y: 0 }, { id: 2, kind: 'belt', x: 4, y: 0, rot: 0 },
  ] });
  assert.deepEqual(l.entities.map((e) => e.kind), ['belt']);
});

test('a chest at the end of a belt carrying a Supply item is an error and its belts are flagged', () => {
  const l = Layout.blank(12, 12);
  const st = l.add({ kind: 'station', type: 'assembly_bench', level: 1, x: 4, y: 5, recipe: 'supply_iron' });
  const out = l.ports(st).find((p) => p.kind === 'out');
  l.add({ kind: 'belt', x: out.nx, y: out.ny, rot: N });
  assert.deepEqual(l.supplyIntoChests().belts, []);
  assert.deepEqual(l.validate().filter((i) => i.severity === 'error'), []);
  const chest = l.add({ kind: 'chest', x: out.nx, y: out.ny - 1 });
  const flow = l.supplyIntoChests();
  assert.deepEqual(flow.belts.map((b) => [b.x, b.y]), [[out.nx, out.ny]]);
  assert.deepEqual(flow.chests.map((c) => c.id), [chest.id]);
  assert.ok(l.validate().some((i) => i.severity === 'error' && i.entityId === chest.id));
});

test('garden distributors: 1,-1 3,-1 5,-1 feed 1,0 3,0 5,0 once section 1 is repaired, and keep their crop', () => {
  const l = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const gardens = () => l.entities.filter((e) => e.garden);
  assert.equal(gardens().length, 0);
  l.setRepaired([...l.repaired, 1]);
  assert.deepEqual(gardens().map((e) => [e.x, e.y, e.rot, e.material]), [[1, -1, S, ''], [3, -1, S, ''], [5, -1, S, '']]);
  assert.deepEqual(gardens().map((e) => portsOf(l, e)), [['out:1,0'], ['out:3,0'], ['out:5,0']]);
  assert.equal(l.entityAt(3, -1).kind, 'distributor');
  assert.deepEqual(l.validate().filter((i) => i.severity !== 'info' && /distributor/i.test(i.message)), []);
  l.update(gardens()[1].id, { material: 'onion_2' });
  const again = Layout.fromJSON(JSON.stringify(l.toJSON()));
  assert.deepEqual(again.entities.filter((e) => e.garden).map((e) => e.material), ['', 'onion_2', '']);
  again.setRepaired(again.repaired);
  assert.equal(again.entities.filter((e) => e.garden)[1].material, 'onion_2');
  again.update(again.entities.find((e) => e.garden).id, { material: 'iron_ore' });
  assert.ok(again.validate().some((i) => i.severity === 'error' && /can't hold/.test(i.message)));
  again.setRepaired(again.repaired.filter((id) => id !== 1));
  assert.equal(again.entities.filter((e) => e.garden).length, 0);
});

test('Zombie Supply Porter: 1 wide, 2 high, 1 power, and one is wanted for every 3 supply stations', () => {
  const l = Layout.blank(10, 10);
  const p = l.add({ kind: 'porter', x: 2, y: 2 });
  assert.deepEqual(l.footprint(p), [[2, 2], [2, 3]]);
  assert.equal(l.canPlace({ kind: 'chest', x: 2, y: 3 }).ok, false);
  assert.equal(l.canPlace({ kind: 'porter', x: 2, y: 3 }).ok, false);
  assert.equal(l.canPlace({ kind: 'porter', x: 3, y: 2 }).ok, true);
  assert.equal(l.power(), 0);
  const wanted = () => l.validate().filter((i) => /Zombie Supply Porter/.test(i.message));
  assert.equal(wanted().length, 0);
  for (let i = 0; i < 4; i++) l.add({ kind: 'supply_station', x: 5 + (i % 3), y: 6 + (i >> 1) * 2, rot: S });
  assert.equal(wanted().length, 1); // 4 supply stations need 2 porters
  l.add({ kind: 'porter', x: 3, y: 2 });
  assert.equal(wanted().length, 0);
});

test('a column at 29,41 and 30,41 is not factory floor', () => {
  const l = Layout.blank(FLOOR_GRID.width, FLOOR_GRID.height);
  l.setRepaired([]);
  assert.ok(l.isFloor(28, 41) && l.isFloor(31, 41));
  assert.ok(!l.isFloor(29, 41) && !l.isFloor(30, 41));
});

test('a layout survives a share link, and the link stays short', async () => {
  const { encodeLayout, decodeLayout } = await import('../src/share.js');
  const l = factoryFloor(REPAIRABLE_SECTIONS);
  l.update(l.entities.find((e) => e.garden).id, { material: 'onion_3' });
  l.add({ kind: 'belt', x: 5, y: 5, rot: E });
  l.add({ kind: 'station', x: 8, y: 8, type: 'assembly_bench', level: 1, recipe: 'building_kit_1' });
  l.planner = { targets: [{ item: 'supply_preserves_2', rate: 1, recipe: 'supply_preserves_2_onion_3' }], timeSec: 30, maxLevel: {}, recipeChoice: {} };
  const text = await encodeLayout(l);
  assert.match(text, /^[\w-]+$/);
  assert.ok(text.length < 1500, `${text.length} chars`);
  const back = await decodeLayout(text);
  const strip = (/** @type {Layout} */ x) => { const j = x.toJSON(); return { ...j, entities: j.entities.map(({ id, ...e }) => JSON.stringify(e)).sort() }; };
  assert.deepEqual(strip(back), strip(l));
  assert.equal(back.entities.find((e) => e.garden && e.x === 1).material, 'onion_3');
  // A custom floor (no sections) keeps its own terrain.
  const custom = Layout.blank(6, 5);
  custom.setTerrain(1, 1, FLOOR);
  assert.equal((await decodeLayout(await encodeLayout(custom))).terrainToText(), custom.terrainToText());
});
