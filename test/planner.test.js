import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Layout, VOID, REPAIRABLE_SECTIONS, FORMAT_VERSION } from '../src/model.js';
import { factoryFloor } from '../src/floor.js';
import { N, E, S, RECIPES, CELLAR_ITEMS, GARDEN_ITEMS, supplyZoneDistance, stationVariants } from '../src/catalog.js';
import { planProduction, chooseRecipe } from '../src/planner/production.js';
import { RouteGrid, NO_CHEST_PORT, NO_CHEST_INPUT, COST, ROUTE_COSTS } from '../src/planner/router.js';
import { Planner, stationInstances, applyResult } from '../src/planner/planner.js';
import { GeneticPlanner } from '../src/planner/genetic.js';
import { plannerSettings, searchesFor } from '../src/planner/panel.js';

const byRecipe = (plan) => Object.fromEntries(plan.recipes.map((r) => [r.recipe, r]));
// The station-count and planner tests run every recipe at 1 craft per minute so
// their numbers don't move with the game's craft times.
const ONE_PER_MINUTE = { craftsPerMinute: Object.fromEntries(RECIPES.map((r) => [r.id, 1])) };
const plan1 = (targets, options = {}) => planProduction(targets, { ...ONE_PER_MINUTE, ...options });
// A planned layout's errors and warnings, except power over the maximum: that's
// the plan's size, not a rule the router broke (the stats report it).
const layoutIssues = (l) => l.validate().filter((i) => i.severity !== 'info' && !/over the factory/.test(i.message)).map((i) => i.message);

test('production: Supply: Iron needs 8 smithies and one bench', () => {
  const plan = plan1([{ item: 'supply_iron', rate: 1 }]);
  const r = byRecipe(plan);
  assert.equal(r.iron_ingot.stations, 8);
  assert.equal(r.iron_ingot.level, 1);
  assert.equal(r.supply_iron.stations, 1);
  assert.deepEqual(plan.supply, { iron_ore: { rate: 8, source: 'distributor' }, coal: { rate: 8, source: 'distributor' } });
  assert.equal(plan.stations, 9);
  assert.deepEqual(plan.recipes.map((x) => x.recipe), ['iron_ingot', 'supply_iron']); // producers first
});

test('production: shared intermediates add up across targets', () => {
  const plan = plan1([{ item: 'supply_iron', rate: 1 }, { item: 'supply_cutlery_1', rate: 1 }]);
  const r = byRecipe(plan);
  // 8 ingots for Supply: Iron + 1 for the Iron Kit I batch behind Cutlery I.
  assert.equal(r.iron_ingot.output, 9);
  assert.equal(r.iron_kit_1.stations, 1);
  assert.equal(r.supply_cutlery_1.level, 2); // Assembly bench II or better
});

test('production: batch outputs round stations up but keep exact rates', () => {
  const plan = plan1([{ item: 'brick', rate: 3 }]);
  const r = byRecipe(plan);
  assert.equal(r.brick.crafts, 1.5); // 2 bricks per craft
  assert.equal(r.brick.stations, 2);
  assert.deepEqual(plan.supply, { clay: { rate: 3, source: 'distributor' }, coal: { rate: 1.5, source: 'distributor' } });
});

test('production: craft times come from the recipes', () => {
  // Iron Ingot takes 8 s: 7.5 crafts per minute per smithy.
  const r = byRecipe(planProduction([{ item: 'iron_ingot', rate: 15 }]));
  assert.equal(r.iron_ingot.craftsPerStation, 7.5);
  assert.equal(r.iron_ingot.stations, 2);
});

test('production: recipe choice, hand-stocked items and level limits', () => {
  assert.equal(chooseRecipe('wooden_kit_1').id, 'wooden_kit_1'); // log only, no Bronze Nails
  const nails = planProduction([{ item: 'wooden_kit_1', rate: 4 }], { recipeChoice: { wooden_kit_1: 'wooden_kit_1_nails' } });
  assert.equal(nails.supply.bronze_nails.source, 'chest');
  const noDist = planProduction([{ item: 'stone_kit', rate: 1 }], { distributors: new Set() });
  assert.equal(noDist.supply.stone.source, 'chest');
  const capped = planProduction([{ item: 'clay_molds', rate: 1 }], { maxLevel: { smithy: 1 } });
  assert.match(capped.errors[0], /No station level available for Clay Molds/);
});

function grid(w, h) {
  const g = new RouteGrid(w, h);
  g.floor.fill(1);
  return g;
}

test('router: straight route into a station port', () => {
  const g = grid(10, 3);
  const P = g.key(9, 1); // port cell, entered moving east
  g.block(P);
  const res = g.route({ starts: [{ k: g.key(0, 1), d: E, cost: 0, origin: { type: 'port' } }], targets: new Map([[P, { mask: 1 << E, end: { type: 'port' } }]]), allow: new Set(), goalCells: [P] });
  // Straight on, as belts, underground conveyors or chests.
  assert.ok(res.steps.every((s) => s.act % 4 === E));
});

test('router: crosses a belt line with an underground conveyor', () => {
  const g = grid(12, 7);
  for (let y = 0; y < 7; y++) { const k = g.key(5, y); g.occ[k] = 2; g.rot[k] = S; } // wall of belts
  const P = g.key(11, 3);
  g.block(P);
  const res = g.route({ starts: [{ k: g.key(0, 3), d: E, cost: 0, origin: { type: 'port' } }], targets: new Map([[P, { mask: 1 << E, end: { type: 'port' } }]]), allow: new Set(), goalCells: [P] });
  assert.ok(res, 'route found');
  const ug = res.steps.find((s) => s.act >= 4);
  assert.ok(ug, 'uses an underground');
  assert.equal(g.xy(ug.k)[0] + 2, 5, 'its gap sits on the belt line');
});

test('router: undergrounds cross each other', () => {
  const g = grid(10, 10);
  // An underground east from (2,5): belt cells (2..3,5) and (5..6,5), its gap at (4,5).
  g.apply({ start: { k: g.key(2, 5), d: E, cost: 0, origin: { type: 'port' } }, goal: { k: g.key(7, 5), d: E, type: 'port' }, steps: [{ k: g.key(2, 5), din: E, act: 4 + E }] }, 'coal', 'dist:coal', 's0i0');
  // One going north may put its gap under a belt cell of it, or a belt cell over its gap.
  assert.equal(g._undergroundOk(g.key(3, 7), N, new Set()), true);  // gap at (3,5)
  assert.equal(g._undergroundOk(g.key(4, 6), N, new Set()), true);  // belt cell (4,5) over its gap
  assert.equal(g._undergroundOk(g.key(4, 7), N, new Set()), false); // gap on its gap
  assert.equal(g._undergroundOk(g.key(5, 8), N, new Set()), false); // belt cell on a belt cell
  // Not along it.
  assert.equal(g._undergroundOk(g.key(1, 5), E, new Set()), false);
});

test('router: underground belt cells work like belts next to chests', () => {
  const h = grid(8, 8);
  // A neighbouring chest would feed them, so a route's underground avoids it.
  h.addChestAt(h.key(2, 5));
  assert.equal(h._undergroundOk(h.key(1, 4), E, new Set()), false);
  assert.equal(h._undergroundOk(h.key(1, 3), E, new Set()), true);
  // And an output chest can't go next to one, unless the exit points into it.
  assert.equal(h.chestOk(h.key(2, 2), null, new Set()), true);
  h.body[h.key(2, 3)] = E;
  assert.equal(h.chestOk(h.key(2, 2), null, new Set()), false);
  h.body[h.key(2, 3)] = N;
  assert.equal(h.chestOk(h.key(2, 2), null, new Set()), true);
});

test('router: flags a route that runs into itself', () => {
  const g = grid(8, 8);
  // Hand-made path: a belt at (3,3), then an underground whose body covers (3,3).
  const path = { start: { origin: { type: 'port' } }, goal: { type: 'port' }, steps: [
    { k: g.key(3, 3), din: E, act: N },
    { k: g.key(3, 1), din: S, act: 4 + S },
  ] };
  assert.deepEqual(path.steps.length, 2);
  assert.ok(g.conflicts(path).includes(g.key(3, 3)));
});

test('router: chests feed neighbouring belts on the sides they output from', () => {
  const g = grid(6, 6);
  const q = g.key(2, 2);
  const east = g.key(3, 2);
  g.occ[east] = 2; g.rot[east] = S;                            // runs alongside the chest
  assert.equal(g.chestOk(q, null, new Set()), false);         // an unfiltered chest would feed it
  assert.equal(g.chestOk(q, null, new Set(), true), true);    // a chest filtered to other sides wouldn't
  g.rot[east] = 3;                                             // points into the chest (W)
  assert.equal(g.chestOk(q, null, new Set()), true);
  g.occ[east] = 0; g.rot[east] = -1;
  g.addChestAt(q);                                             // no filters: outputs on every side
  assert.equal(g.beltOk(east, S, new Set()), false);
  assert.equal(g.beltOk(east, E, new Set()), false);
  assert.equal(g.beltOk(east, 3, new Set()), true);
  const h = grid(6, 6);
  h.addChestAt(q, 1 << N);                                     // filtered to its north side only
  assert.equal(h.beltOk(east, S, new Set()), true);
  assert.equal(h.beltOk(h.key(2, 1), E, new Set()), false);
});

test('router: no chest against a station input, used or not', () => {
  const g = grid(6, 6);
  const k = g.key(2, 2);
  g.noChest[k] = NO_CHEST_PORT; // an output's access cell: an output chest may go right there
  assert.equal(g.chestOk(k, null, new Set()), true);
  g.noChest[k] |= NO_CHEST_INPUT; // a station input's: chests can't feed stations
  assert.equal(g.chestOk(k, null, new Set()), false);
  assert.equal(g.chestOk(k, null, new Set(), true), false);
  assert.equal(g.chestStarts('flax', g.key(2, 3), 1).some((s) => s.origin.k === k), false);
});

test('router: branches leave a line from chest hubs at turns, before turns and from chests in the line', () => {
  const g = grid(10, 10);
  const W = 3;
  // A coal line from (1,5): east, a turn north at (2,5), north to a chest in the line at (2,3)
  // that leaves east, then on to a port.
  const path = { start: { k: g.key(1, 5), d: E, cost: 0, origin: { type: 'port' } }, goal: { k: g.key(4, 3), d: E, type: 'port' }, steps: [
    { k: g.key(1, 5), din: E, act: E },
    { k: g.key(2, 5), din: E, act: N },
    { k: g.key(2, 4), din: N, act: N },
    { k: g.key(2, 3), din: N, act: 8 + E },
    { k: g.key(3, 3), din: E, act: E },
  ] };
  g.apply(path, 'coal', 'dist:coal', 's0i0');
  const hubs = () => new Set(g.branchStarts('coal', 'dist:coal').filter((st) => st.origin.type === 'hub').map((st) => `${g.xy(st.origin.k)}>${st.d}`));
  assert.deepEqual(hubs(), new Set([
    '1,5>0', '1,5>2', // a straight belt followed by a turn
    '2,5>1', '2,5>2', // the turn: straight on, or out of the far side
    '2,3>0', `2,3>${W}`, // the chest in the line, from the sides items neither enter nor leave by
  ]));
  // None before a chest (chests only output onto belts) or before the port; the turn still takes a splitter too.
  assert.ok(g.branchStarts('coal', 'dist:coal').some((st) => st.origin.type === 'splitter' && st.origin.k === g.key(2, 5)));
  // Never a hub against a station input.
  g.noChest[g.key(1, 5)] = NO_CHEST_INPUT;
  assert.deepEqual([...hubs()].filter((h) => h.startsWith('1,5')), []);
});

test('router: a chest never hands items to another chest (chests only output onto belts)', () => {
  // Arriving at (2,1) moving east, the cheapest way into the chest at (2,0) would be a
  // chest in the line turning north: it must be a belt.
  const g = grid(5, 3);
  const C = g.key(2, 0);
  g.addChestAt(C);
  g.net.set(C, { k: C, kind: 'chest', item: 'coal', next: [], prev: [], up: new Set(), down: new Set(['final:coal']) });
  const targets = new Map();
  g.chestTarget(C, targets);
  const res = g.route({ starts: [{ k: g.key(0, 1), d: E, cost: 0, origin: { type: 'port' } }], targets, allow: new Set(), goalCells: [C] });
  assert.equal(res.goal.k, C);
  assert.ok(res.steps.at(-1).act < 4, 'the piece before the chest is a belt');
  // A belt right after a chest in the line doesn't become a hub, which the chest couldn't feed.
  const h = grid(10, 10);
  h.apply({ start: { k: h.key(1, 5), d: E, cost: 0, origin: { type: 'port' } }, goal: { k: h.key(5, 3), d: E, type: 'port' }, steps: [
    { k: h.key(1, 5), din: E, act: E },
    { k: h.key(2, 5), din: E, act: 8 + N },
    { k: h.key(2, 4), din: N, act: N },
    { k: h.key(2, 3), din: N, act: E },
    { k: h.key(3, 3), din: E, act: E },
    { k: h.key(4, 3), din: E, act: E },
  ] }, 'coal', 'dist:coal', 's0i0');
  const hubAt = new Set(h.branchStarts('coal', 'dist:coal').filter((st) => st.origin.type === 'hub').map((st) => `${h.xy(st.origin.k)}`));
  assert.ok(!hubAt.has('2,4'), 'not right after the chest');
  assert.ok(hubAt.has('2,3') && hubAt.has('3,3'), 'further along, yes');
});

test('router: a branch can leave an output chest the source already fills', () => {
  const g = grid(10, 10);
  // A Marble Kit line from (1,5) east into a new output chest at (3,5).
  const path = { start: { k: g.key(1, 5), d: E, cost: 0, origin: { type: 'port' } }, goal: { k: g.key(3, 5), d: E, type: 'newChest' }, steps: [
    { k: g.key(1, 5), din: E, act: E },
    { k: g.key(2, 5), din: E, act: E },
  ] };
  g.apply(path, 'marble_kit', 's4o', 'final:marble_kit');
  const starts = g.branchStarts('marble_kit', 's4o').filter((st) => st.origin.type === 'existingHub' && st.origin.k === g.key(3, 5));
  assert.deepEqual(new Set(starts.map((st) => st.d)), new Set([N, E, S]));
  assert.equal(g.branchStarts('marble_kit', 's9o').length, 0); // another source's chest
});

function smallFactory() {
  const l = Layout.blank(20, 14);
  for (let x = 0; x < 20; x++) l.setTerrain(x, 13, VOID);
  // Distributors sit in the wall below the floor, as in the factory.
  ['stone', 'clay', 'coal', 'iron_ore'].forEach((m, i) => l.add({ kind: 'distributor', x: 2 + i * 4, y: 13, rot: N, material: m }));
  return l;
}

function outLayoutPort(station) {
  const l = Layout.blank(40, 40);
  return l.ports(station).find((p) => p.kind === 'out');
}

const distributorsOf = (l) => new Set(l.entities.flatMap((e) => e.kind === 'distributor' ? [e.material] : e.kind === 'cellar' ? CELLAR_ITEMS : []));

function runPlan(layout, targets, iterations, seed = 1, options = {}) {
  const prod = plan1(targets, { distributors: distributorsOf(layout), ...options });
  const pl = new Planner(layout, prod, { seed });
  pl.init();
  for (let i = 0; i < iterations; i += 50) pl.step(50, i / iterations);
  const res = pl.result();
  const out = layout.clone();
  applyResult(out, res);
  return { res, out, prod };
}

// Routing is noisy: the first of a few seeds that routes everything.
function routedPlan(layout, targets, iterations, seeds = [1, 2, 3, 4, 5, 6], options = {}) {
  for (const seed of seeds) {
    const run = runPlan(layout, targets, iterations, seed, options);
    if (run.res.failures.length === 0) return run;
  }
  return assert.fail('no seed routed everything');
}

test('planner: every port of a placed station faces the floor, used or not', () => {
  // Wooden Kit I takes one ingredient, so one of the bench's two inputs is unused. A
  // notch in the floor leaves spots where one input faces the floor and the other doesn't.
  const layout = smallFactory();
  layout.setTerrain(6, 9, VOID);
  const pl = new Planner(layout, plan1([{ item: 'wooden_kit_1', rate: 1 }], { distributors: distributorsOf(layout) }), { seed: 1 });
  const s = pl.stations[0];
  let checked = 0;
  for (const spot of pl.spots['3x3']) for (const variant of Object.keys(stationVariants(s.type))) for (const swap of [false, true]) {
    const p = { ...spot, variant, swap };
    if (!pl.valid(s, p, [null])) continue;
    checked++;
    const st = { kind: 'station', type: s.type, variant, x: p.x, y: p.y };
    for (const q of layout.ports(st)) assert.ok(layout.isFloor(q.nx, q.ny), `${variant} at ${p.x},${p.y}: port faces ${q.nx},${q.ny}`);
  }
  assert.ok(checked > 0);
});

test('planner: a port\'s held-free cell never takes another station\'s port', () => {
  // The stone kit bench's side output (access 5,3) points across a one-cell gap at the
  // building kit bench's output (access 6,3): the cell beyond the first is the second's port.
  const layout = smallFactory();
  const pl = new Planner(layout, plan1([{ item: 'building_kit_1', rate: 1 }], { distributors: distributorsOf(layout) }), { seed: 1 });
  const placements = [{ x: 2, y: 2, variant: 'in_left', swap: false }, null, { x: 6, y: 4, variant: 'out_top_left', swap: false }];
  placements[1] = pl.spots['3x3'].map((q) => ({ ...q, variant: Object.keys(stationVariants('smithy'))[0], swap: false })).find((q) => q.x >= 12 && pl.valid(pl.stations[1], q, placements));
  placements.forEach((p, i) => assert.ok(pl.valid(pl.stations[i], p, placements), `station ${i}`));
  assert.deepEqual(pl.ports(pl.stations[0], placements[0]).output, { x: 4, y: 3, dir: E, nx: 5, ny: 3 });
  assert.equal(pl.ports(pl.stations[2], placements[2]).output.ny, 3);
  // The stone kit line (from 5,3) may not use the other bench's output access cell.
  const allowed = [];
  const routeSound = RouteGrid.prototype.routeSound;
  RouteGrid.prototype.routeSound = function (req, tries) {
    if (req.starts.some((st) => st.k === this.key(5, 3) && st.origin.type === 'port')) allowed.push(...req.allow);
    return routeSound.call(this, req, tries);
  };
  try { pl.evaluate(placements, true); } finally { RouteGrid.prototype.routeSound = routeSound; }
  assert.ok(allowed.length);
  assert.ok(!allowed.includes(pl.base.key(6, 3)));
});

test('planner: cells held free in front of ports lose the hold once a line runs over them', () => {
  // A hub can't go on a held cell, so a short line built over them couldn't be branched from.
  const { res } = runPlan(smallFactory(), [{ item: 'building_kit_1', rate: 1 }], 300);
  const layout = smallFactory();
  const pl = new Planner(layout, plan1([{ item: 'building_kit_1', rate: 1 }], { distributors: distributorsOf(layout) }), { seed: 1 });
  const g = pl.evaluate(res.placements, true).grid;
  const held = [...g.placed.keys()].filter((k) => g.placed.get(k).kind === 'belt' && g.reserved[k] === 2);
  assert.deepEqual(held, []);
});

test('planner: builds a valid layout for a small plan', () => {
  const { res, out } = runPlan(smallFactory(), [{ item: 'building_kit_1', rate: 1 }], 300);
  assert.deepEqual(res.failures, []);
  assert.deepEqual(layoutIssues(out), []);
  assert.equal(res.stats.stations, 3); // stone kit + brick + building kit
  assert.ok(res.entities.every((e) => e.planned && !e.locked));
  // The output lands in a chest, and each station records its port assignment.
  assert.ok(res.entities.some((e) => e.kind === 'chest' && e.role === 'output'));
  const kit = res.entities.find((e) => e.recipe === 'building_kit_1');
  // The output chest sits directly against the station's output: no belt in between.
  const outChest = res.entities.find((e) => e.kind === 'chest' && e.role === 'output');
  const port = outLayoutPort(kit);
  assert.deepEqual([outChest.x, outChest.y], [port.nx, port.ny]);
  assert.deepEqual([...kit.inputs].filter(Boolean).sort(), ['brick', 'stone_kit']);
});

test('planner: Supply: Iron on the real factory floor routes everything', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  // The search is seeded and noisy: some seed must route everything.
  const { res, out } = routedPlan(layout, [{ item: 'supply_iron', rate: 1 }], 1500);
  assert.deepEqual(res.failures, []);
  assert.deepEqual(layoutIssues(out), []);
  assert.equal(res.stats.stations, 9);
  // The factory has 200 power (game version 1.010); what the plan uses past that is over.
  assert.ok(res.stats.available === 200 && res.stats.over === Math.max(0, res.stats.power - 200), JSON.stringify(res.stats));
});

test('planner: plans on the fully repaired floor validate', () => {
  const layout = factoryFloor(REPAIRABLE_SECTIONS);
  const runs = [1, 2].map((seed) => runPlan(layout, [{ item: 'building_kit_1', rate: 1 }], 600, seed));
  const { res, out } = runs.find((r) => !r.res.failures.length) ?? runs[0];
  assert.deepEqual(res.failures, []);
  assert.deepEqual(layoutIssues(out), []);
});

test('planner: beer and wine come from the cellar, sorted by a filtered chest when there are several', () => {
  const layout = factoryFloor(REPAIRABLE_SECTIONS);
  const near = (out) => out.entities.filter((e) => e.planned && e.x <= 1 && e.y === 14);
  // One item: the cellar holds just that and feeds its belt like a distributor.
  const one = runPlan(layout, [{ item: 'supply_beer', rate: 1 }], 300);
  assert.equal(one.prod.supply.beer.source, 'distributor');
  assert.deepEqual(one.res.failures, []);
  assert.deepEqual(one.res.cellarStock, ['beer']);
  assert.deepEqual(one.out.entities.find((e) => e.kind === 'cellar').stock, ['beer']);
  assert.deepEqual(near(one.out).map((e) => e.kind), ['belt', 'belt']);
  assert.deepEqual(layoutIssues(one.out), []);
  // Two: a belt into a chest at 1,14 that sends each out of its own side.
  const two = runPlan(layout, [{ item: 'supply_beer', rate: 1 }, { item: 'supply_wine', rate: 1 }], 300, 1, { recipeChoice: { supply_wine: 'supply_wine_2' } });
  assert.deepEqual(two.res.failures, []);
  assert.deepEqual(two.res.cellarStock, ['beer', 'wine_2']);
  const [belt, chest] = near(two.out).sort((a, z) => a.x - z.x);
  assert.deepEqual([belt.kind, belt.rot, chest.kind], ['belt', E, 'chest']);
  assert.deepEqual(Object.values(chest.filters).sort(), ['beer', 'wine_2']);
  assert.deepEqual(layoutIssues(two.out), []);
});

test('planner: stationInstances splits fractional crafts over stations', () => {
  const prod = plan1([{ item: 'brick', rate: 3 }]);
  const st = stationInstances(prod);
  assert.equal(st.length, 2);
  assert.deepEqual(st.map((s) => s.outRate), [2, 1]);
});

test('planner: places a 2x2 kitchen and routes it', () => {
  const l = smallFactory();
  l.entities.find((e) => e.material === 'stone').material = 'sand';
  const { res, out } = runPlan(l, [{ item: 'supply_preserves_1', rate: 1 }], 300);
  assert.deepEqual(res.failures, []);
  assert.deepEqual(layoutIssues(out), []);
  assert.ok(res.entities.some((e) => e.kind === 'station' && e.type === 'kitchen'));
});

test('planner: a "Supply: ..." output ends in a supply station on or near row 27, x 23–31', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const { res, out } = runPlan(layout, [{ item: 'supply_iron', rate: 1 }], 600);
  const ss = res.entities.filter((e) => e.kind === 'supply_station');
  assert.equal(ss.length, 1);
  assert.ok(!res.entities.some((e) => e.kind === 'chest' && e.role === 'output'), 'no output chest');
  assert.ok(supplyZoneDistance(ss[0].x, ss[0].y) <= 6, `supply station at ${ss[0].x},${ss[0].y}`);
  assert.deepEqual(layoutIssues(out), []);
});

test('model: a supply station takes items on its input side only', () => {
  const l = Layout.blank(5, 5);
  const ss = l.add({ kind: 'supply_station', x: 2, y: 2, rot: S });
  assert.equal(l.acceptsFrom(ss, 2, 3), true);
  assert.equal(l.acceptsFrom(ss, 1, 2), false);
});

test('planner: a product another station takes several of per craft goes through a buffer chest', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const { res, out } = routedPlan(layout, [{ item: 'supply_iron', rate: 1 }], 1500);
  // Supply: Iron takes 8 ingots per craft; a top output can push straight into the chest.
  const smithies = out.entities.filter((e) => e.kind === 'station' && e.recipe === 'iron_ingot');
  const top = smithies.map((s) => out.ports(s).find((p) => p.kind === 'out')).filter((p) => p.dir % 2 === 0);
  assert.ok(top.length > 0, 'a smithy with a top or bottom output');
  for (const p of top) assert.equal(out.entityAt(p.nx, p.ny)?.kind, 'chest', `buffer chest at ${p.nx},${p.ny}`);
  assert.deepEqual(layoutIssues(out), []);
});

test('planner: garden distributors with no crop are set to the crops the plan needs', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  layout.setRepaired([...layout.repaired, 1]);
  const gardens = layout.entities.filter((e) => e.garden);
  layout.update(gardens[0].id, { material: 'onion_1' }); // set by the player: kept
  const { res, out, prod } = runPlan(layout, [{ item: 'supply_flour', rate: 1 }], 300, 1, { distributors: new Set(['wheat']) });
  assert.equal(prod.supply.wheat.source, 'distributor');
  assert.deepEqual(res.gardenStock.map(([, item]) => item), ['wheat']);
  assert.ok(!res.gardenStock.some(([id]) => id === gardens[0].id));
  assert.equal(out.entities.filter((e) => e.garden).filter((e) => e.material === 'wheat' && e.autoMaterial).length, 1);
  assert.equal(out.entities.find((e) => e.id === gardens[0].id).material, 'onion_1');
  assert.deepEqual(layoutIssues(out), []);
  out.clearAutoMaterials();
  assert.deepEqual(out.entities.filter((e) => e.garden).map((e) => e.material), ['onion_1', '', '']);
});

test('planner: a Zombie Supply Porter for every 3 supply stations, along 23,24 to 29,24', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const targets = [{ item: 'supply_iron', rate: 1 }, { item: 'supply_cutlery_1', rate: 1 }, { item: 'supply_furniture_1', rate: 1 }, { item: 'supply_clothes_1', rate: 1 }];
  const { res, out } = runPlan(layout, targets, 400);
  const supply = res.entities.filter((e) => e.kind === 'supply_station').length;
  const porters = res.entities.filter((e) => e.kind === 'porter');
  assert.ok(supply > 0);
  assert.equal(porters.length, Math.ceil(supply / 3));
  for (const p of porters) assert.ok(p.y === 24 && p.x >= 23 && p.x <= 29, `porter at ${p.x},${p.y}`);
  assert.equal(res.stats.power, out.power());
  // (A plan this big may leave connections unrouted at 400 iterations, so only the porter rule is checked.)
  assert.deepEqual(out.validate().filter((i) => /Zombie Supply Porter/.test(i.message)), []);
});

test('planner: chests (no power) stand in for belts at turns and after undergrounds, never on Supply lines', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const { res, out } = routedPlan(layout, [{ item: 'supply_iron', rate: 1 }], 1500);
  const pass = res.entities.filter((e) => e.kind === 'chest' && e.role === 'pass');
  assert.ok(pass.length > 0, 'a chest in the line');
  for (const c of pass) assert.equal(Object.keys(c.filters).length, 1, 'filtered to the one side it leaves from');
  assert.deepEqual(layoutIssues(out), []);
  // The Supply: Iron line itself carries no chest: only the ingots' lines do.
  assert.deepEqual(out.supplyIntoChests().chests, []);
  for (const c of pass) assert.notEqual(Object.values(c.filters)[0], 'supply_iron');
});

test('planner: prioritising build materials makes a chest in the line dearer than a belt', () => {
  assert.equal(plannerSettings().priority, 'power');
  assert.ok(ROUTE_COSTS.materials.passChest > COST.belt);
  assert.equal(ROUTE_COSTS.power, COST);
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const prod = plan1([{ item: 'supply_iron', rate: 1 }], { distributors: distributorsOf(layout) });
  for (const seed of [1, 2, 3]) {
    const pl = new Planner(layout, prod, { seed, priority: 'materials' });
    pl.init();
    for (let i = 0; i < 1500; i += 50) pl.step(50, i / 1500);
    const res = pl.result();
    if (res.failures.length) continue;
    const out = layout.clone();
    applyResult(out, res);
    assert.deepEqual(layoutIssues(out), []);
    return;
  }
  assert.fail('no seed routed everything');
});

test('planner: a recipe whose crop a distributor holds beats one needing a chest', () => {
  const only = (/** @type {string} */ crop) => planProduction([{ item: 'supply_preserves_2', rate: 1 }], { distributors: new Set(['coal', 'sand', 'stone', crop]) });
  assert.equal(only('onion_3').supply.onion_3.source, 'distributor');
  assert.equal(only('pumpkin_2').supply.pumpkin_2.source, 'distributor');
  assert.equal(only('onion_3').supply.onion_1, undefined);
});

test('planner: a target can name its recipe, and the crop comes from the garden', () => {
  const garden = new Set(['coal', 'sand', 'stone', ...GARDEN_ITEMS]);
  const prod = planProduction([{ item: 'supply_preserves_2', rate: 1, recipe: 'supply_preserves_2_onion_1' }], { distributors: garden });
  assert.equal(prod.supply.onion_1.source, 'distributor');
  assert.equal(prod.supply.pumpkin_3, undefined);
});

test('planner: zombie power comes from Bioreactors fed by the garden', () => {
  const layout = factoryFloor(REPAIRABLE_SECTIONS);
  const { res, out } = routedPlan(layout, [{ item: 'supply_appliances_1', rate: 1 }], 1200, undefined, { distributors: new Set([...distributorsOf(layout), ...GARDEN_ITEMS]) });
  const bio = out.entities.filter((e) => e.kind === 'station' && e.type === 'bioreactor');
  assert.equal(bio.length, 1);
  assert.deepEqual(res.failures, []);
  assert.deepEqual(layoutIssues(out), []);
  assert.ok(out.entities.some((e) => e.garden && e.material === 'wheat'));
});

test('planner: Zombie Power can be a final output, made by a Bioreactor', () => {
  const { res, out } = routedPlan(factoryFloor(REPAIRABLE_SECTIONS), [{ item: 'zombie_power', rate: 1 }], 600);
  assert.equal(out.entities.filter((e) => e.kind === 'station' && e.type === 'bioreactor').length, 1);
  assert.deepEqual(layoutIssues(out), []);
});

test('genetic: builds a valid layout for a small plan', () => {
  const layout = smallFactory();
  const prod = plan1([{ item: 'building_kit_1', rate: 1 }], { distributors: distributorsOf(layout) });
  const ga = new GeneticPlanner(layout, prod, { seed: 1, population: 10 });
  ga.init();
  ga.step(100, 0.5);
  const res = ga.result();
  const out = layout.clone();
  applyResult(out, res);
  assert.deepEqual(res.failures, []);
  assert.deepEqual(layoutIssues(out), []);
  assert.equal(res.stats.stations, 3);
});

test('genetic: repair moves every station to a valid spot', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const ga = new GeneticPlanner(layout, plan1([{ item: 'supply_iron', rate: 1 }], { distributors: distributorsOf(layout) }), { seed: 2 });
  // All nine stations piled on one spot.
  const p = { ...ga.spots['3x3'][200], variant: 'out_top_left', swap: false };
  const fixed = ga._repair(ga.stations.map(() => ({ ...p })));
  assert.equal(fixed.filter(Boolean).length, 9);
  fixed.forEach((q, i) => assert.ok(ga.valid(ga.stations[i], q, fixed), `station ${i} at ${q.x},${q.y}`));
  assert.ok(fixed.some((q) => q.x === p.x && q.y === p.y), 'one keeps the spot');
});

test('genetic: crossover lines up stations with the same recipe by position', () => {
  const layout = Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8'));
  const ga = new GeneticPlanner(layout, plan1([{ item: 'supply_iron', rate: 1 }], { distributors: distributorsOf(layout) }), { seed: 3 });
  const a = ga.init().placements;
  // The same layout with the eight smithies listed in another order.
  const smithies = ga.twins.get('iron_ingot');
  const b = a.slice();
  smithies.forEach((i, j) => { b[i] = a[smithies[(j + 3) % smithies.length]]; });
  assert.notDeepEqual(b, a);
  assert.deepEqual(ga._align(a, b), a);
});

test('planner: a layout saved before the search method option loads with both searches and plans', () => {
  // Settings as the planner panel saved them before `algorithm` existed (format 3),
  // in a format 1 file (factory.json) and in the format 2 file that version wrote.
  const old = { targets: [{ item: 'engineering_kit', rate: 1 }], timeSec: 30, maxLevel: {}, recipeChoice: {} };
  const v1 = { ...JSON.parse(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8')), planner: old };
  const v2 = { ...Layout.fromJSON(JSON.stringify(v1)).toJSON(), version: 2, planner: old };
  for (const file of [v1, v2]) {
    const layout = Layout.fromJSON(JSON.stringify(file));
    assert.deepEqual(layout.planner, { ...old, algorithm: 'both' });
    assert.equal(file.planner.algorithm, undefined); // the file itself isn't touched
    const saved = layout.toJSON();
    assert.equal(saved.version, FORMAT_VERSION);
    assert.equal(saved.planner.algorithm, 'both');
    const settings = plannerSettings(layout.planner);
    assert.equal(settings.timeSec, 30);
    assert.deepEqual(searchesFor(settings), ['sa', 'ga']);
    const prod = plan1(settings.targets, { distributors: distributorsOf(layout) });
    for (const search of [new Planner(layout, prod, { seed: 1 }), new GeneticPlanner(layout, prod, { seed: 1, population: 20 })]) {
      search.init();
      search.step(200, 0.5);
      const res = search.result();
      const out = layout.clone();
      applyResult(out, res);
      assert.deepEqual(res.failures, []);
      assert.deepEqual(layoutIssues(out), []);
    }
  }
  // A current file keeps its choice, and a layout with no settings gets every default.
  assert.equal(Layout.fromJSON(JSON.stringify({ ...v2, version: 3, planner: { ...old, algorithm: 'sa' } })).planner.algorithm, 'sa');
  assert.equal(plannerSettings(undefined).algorithm, 'both');
  assert.deepEqual(searchesFor({ algorithm: 'sa' }), ['sa']);
});
