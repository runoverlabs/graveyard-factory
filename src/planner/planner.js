// @ts-check
// Layout planner: places the stations a production plan needs, routes belts
// between them, and improves the placement by simulated annealing.
//
// A placement is scored by routing every connection from scratch: the sum of
// route costs (belts, turns, undergrounds, splitters, chests) plus a large
// penalty per connection that could not be routed.

import { STATIONS, RECIPE_BY_ID, DIRS, ENTITY_KINDS, CELLAR_ITEMS, GARDEN_ITEMS, entityCells, stationDims, stationVariants, isSupplyItem, supplyZoneDistance, PORTER, portersFor } from '../catalog.js';
import { RouteGrid, DX, DY, ROUTE_COSTS, NO_CHEST_PORT, NO_CHEST_INPUT } from './router.js';
import { powerOf, powerSupply } from '../model.js';

/** @typedef {import('../types.js').StationType} StationType */
/** @typedef {import('../types.js').EntitySpec} EntitySpec */
/** @typedef {import('../types.js').ProductionPlan} ProductionPlan */
/** @typedef {import('../model.js').Layout} Layout */
/** @typedef {import('./router.js').RouteStart} RouteStart */
/** @typedef {import('./router.js').RouteTarget} RouteTarget */

/**
 * One station to build.
 * @typedef {object} StationInstance
 * @property {number} idx
 * @property {string} recipe
 * @property {StationType} type
 * @property {number | null} level
 * @property {string} item output
 * @property {{ item: string, rate: number, qty: number }[]} ingredients per minute (and per craft), one per input port
 * @property {number} outRate per minute
 * @property {number} depth crafting steps above raw supply
 */

/** Where a station goes; swap exchanges its two input ports. @typedef {{ x: number, y: number, variant: string, swap: boolean }} Placement */

/** A station port in world coordinates; (nx, ny) is its access cell. @typedef {{ x: number, y: number, dir: number, nx: number, ny: number }} PlacedPort */
/** @typedef {PlacedPort & { item: string, port: number }} PlacedInput */

/**
 * @typedef {object} PlannerOptions
 * @property {number} [seed]
 * @property {number} [gap] free cells kept between stations
 * @property {number} [failCost] penalty per unrouted connection
 * @property {number} [overPowerCost] penalty per point of power over the maximum
 * @property {number} [supplyCornerCost] extra cost per cell from the supply zone
 * @property {'power' | 'materials'} [priority] what the routes save on: power (chests in place of belts) or build materials (few chests)
 * @property {number} [timeMs] search budget (used by the worker)
 * @property {boolean} [earlyStop] false: route every candidate to the end (see Planner.evaluate)
 * @property {'sa' | 'ga'} [algorithm] annealing (Planner) or genetic (GeneticPlanner)
 * @property {number} [population] genetic: population size
 * @property {number} [tournament] genetic: tournament size
 * @property {number} [crossover] genetic: chance a child is a crossover (else a mutated copy)
 * @property {number} [mutation] genetic: chance a crossover child is also mutated
 */

/**
 * One end of a connection: a station port, distributor, supply chest or final
 * output. Which fields are set depends on the kind.
 * @typedef {object} Endpoint
 * @property {string} id
 * @property {string} [item]
 * @property {number} [rate]
 * @property {number} [qty] per craft (an input port: how many of the item one craft takes)
 * @property {number} [n] access cell
 * @property {number} [stub] cell held free straight out of the port (-1: none)
 * @property {number[]} [stubs] distributor stubs
 * @property {boolean} [hub] the cellar's sorting chest: items leave from its sides
 * @property {number} [d] output direction
 * @property {number} [P] input port cell
 * @property {number} [into] direction of travel into an input port
 * @property {number} [station]
 * @property {boolean} [chest] hand-stocked supply chest
 * @property {boolean} [final] final output
 * @property {number} [left] rate not yet assigned to an edge
 */

/** @typedef {{ src: Endpoint, sink: Endpoint, item: string, rate?: number, est?: number, buffer?: boolean }} Edge */

/**
 * A connection that couldn't be made. `why`: no free place to start from (e.g. no turn or free side
 * to branch off the source's line), nothing to arrive at, or no path between them; `branch`: the source
 * already fed a line; `merge`: the sink was already connected. `est`: its estimated length. The score
 * doesn't use them (grading failures didn't help the annealing); the benchmark reports them.
 * @typedef {{ reason?: 'no room', station?: number, item?: string, from?: string, to?: string, why?: 'no start' | 'no target' | 'no path', branch?: boolean, merge?: boolean, est?: number }} Failure
 */

/** @typedef {{ score: number, failed: number, failures: Failure[], grid: RouteGrid, edges: number, power: number, over: number, aborted?: boolean }} Evaluation */
/** @typedef {{ placements: Placement[], score: number, failed: number }} SearchState */

/**
 * @typedef {object} PlanResult
 * @property {EntitySpec[]} entities
 * @property {Placement[]} placements
 * @property {Failure[]} failures
 * @property {string[] | null} cellarStock what the cellar should hold for this plan (null: unused)
 * @property {[number, string][]} gardenStock crop for each garden distributor the plan sets (entity id, item)
 * @property {number} score
 * @property {{ stations: number, belts: number, undergrounds: number, splitters: number, chests: number, supplyStations: number, power: number, available: number, over: number, zombies: number, connections: number, iterations: number }} stats
 */

// Penalty per unrouted connection, far above any realistic belt cost so that
// routing everything always wins.
export const FAIL_COST = 1000;
// Score per point of power over the factory's maximum (its carousels are fixed,
// so more can't be added). Belts cost 1 power each (chests none), so over the
// maximum every piece saved counts this much more.
export const OVER_POWER_COST = 20;
// "Supply: ..." outputs end in a supply station, preferably on or near SUPPLY_ZONE (a weak pull, to save power):
// this much extra cost per cell away from it, and how many of the nearest free
// cells are offered.
const SUPPLY_CORNER_COST = 1;
const SUPPLY_CANDIDATES = 40;
// Extra cost of a buffered output (see `Edge.buffer`) that has no chest: only when a chest can't fit.
const BUFFER_MISS_COST = 30;
const sizeOf = (/** @type {StationInstance} */ s) => stationDims(s.type);
const variantsOf = (/** @type {StationInstance} */ s) => Object.keys(stationVariants(s.type));
// Do two station footprints come closer than `gap` free cells?
/**
 * @param {{ x: number, y: number }} a
 * @param {{ w: number, h: number }} sa
 * @param {{ x: number, y: number }} b
 * @param {{ w: number, h: number }} sb
 * @param {number} gap
 */
const near = (a, sa, b, sb, gap) => a.x < b.x + sb.w + gap && b.x < a.x + sa.w + gap && a.y < b.y + sb.h + gap && b.y < a.y + sa.h + gap;
const dimsKey = (/** @type {{ w: number, h: number }} */ d) => `${d.w}x${d.h}`;
const rev = (/** @type {number} */ d) => (d + 2) % 4;

// One entry per station to build, with the ingredients it needs per minute.
/**
 * @param {ProductionPlan} production
 * @returns {StationInstance[]}
 */
export function stationInstances(production) {
  /** @type {Map<string, number>} */
  const depth = new Map();
  for (const item of Object.keys(production.supply)) depth.set(item, 0);
  for (const r of production.recipes) { // producers come first
    const inputs = Object.keys(r.inputs);
    depth.set(r.item, 1 + Math.max(0, ...inputs.map((i) => depth.get(i) ?? 0)));
  }
  /** @type {StationInstance[]} */
  const out = [];
  for (const r of production.recipes) {
    const recipe = RECIPE_BY_ID[r.recipe];
    let left = r.crafts;
    for (let i = 0; i < r.stations; i++) {
      const crafts = Math.min(r.craftsPerStation, left);
      left -= crafts;
      out.push({
        idx: out.length, recipe: r.recipe, type: r.station, level: r.level, item: r.item,
        ingredients: Object.entries(recipe.inputs).map(([item, qty]) => ({ item, rate: qty * crafts, qty })),
        outRate: recipe.outputs[r.item] * crafts,
        depth: depth.get(r.item),
      });
    }
  }
  return out;
}

// Add a plan's pieces to `layout` (the base it was planned on) and fill the
// cellar with what the plan takes from it.
/** @param {Layout} layout @param {PlanResult} result */
export function applyResult(layout, result) {
  for (const e of result.entities) layout.add(e);
  const cellar = layout.entities.find((e) => e.kind === 'cellar');
  if (cellar && result.cellarStock) layout.update(cellar.id, { stock: [...result.cellarStock] });
  for (const [id, material] of result.gardenStock) layout.update(id, { material, autoMaterial: true });
}

// Mulberry32: small seeded PRNG so runs are reproducible.
/**
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Planner {
  // layout: the base Layout (terrain + entities to keep); planned entities should
  // already be removed. production: result of planProduction().
  /**
   * @param {Layout} layout
   * @param {ProductionPlan} production
   * @param {PlannerOptions} [options]
   */
  constructor(layout, production, options = {}) {
    this.layout = layout;
    this.production = production;
    this.options = options;
    this.random = rng(options.seed ?? 1);
    this.costs = ROUTE_COSTS[options.priority ?? 'power'] ?? ROUTE_COSTS.power;
    this.stations = stationInstances(production);
    // Power the kept pieces already use.
    this.basePower = powerOf(layout.entities);
    this.beltMaster = !!layout.beltMaster;
    this._buildBase();
    this._buildAprons();
    this._buildSupplyCells();
    this.iterations = 0;
    // Placements routed: the same unit for every search (an annealing step may be
    // rejected before routing, a genetic one skip a duplicate).
    this.evaluations = 0;
  }

  // ---- static obstacles from the base layout --------------------------------

  _buildBase() {
    const l = this.layout;
    const g = new RouteGrid(l.width, l.height, this.costs);
    /** @type {Map<string, { k: number, d: number, hub?: boolean }>} distributor output access cell by material */
    this.distributors = new Map();
    /** @type {{ k: number, d: number } | null} the cellar's output access cell */
    let cellar = null;
    /** @type {{ id: number, k: number, d: number }[]} garden distributors with no crop set */
    const freeGarden = [];
    for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) g.floor[g.key(x, y)] = l.isFloor(x, y) ? 1 : 0;
    for (const e of l.entities) {
      const cells = entityCells(e);
      if (e.kind === 'belt') {
        const k = g.key(e.x, e.y);
        g.occ[k] = 2;
        g.rot[k] = e.rot;
        continue;
      }
      for (const c of cells) {
        if (!l.inBounds(c.x, c.y)) continue;
        const k = g.key(c.x, c.y);
        if (c.gap) g.gap[k] = e.rot; else g.block(k);
        if (e.kind === 'underground' && !c.gap) g.body[k] = e.rot;
      }
      // A chest outputs from its filtered sides, or from every side if it has none.
      if (e.kind === 'chest') {
        const filtered = /** @type {const} */ (['N', 'E', 'S', 'W']).map((n, d) => (e.filters?.[n] ? 1 << d : 0)).reduce((a, b) => a | b, 0);
        g.addChestAt(g.key(e.x, e.y), filtered || 0b1111);
      }
      // Keep port access cells of existing pieces clear.
      for (const p of l.ports(e)) {
        if (!l.inBounds(p.nx, p.ny)) continue;
        const k = g.key(p.nx, p.ny);
        if (g.occ[k] === 0) g.reserved[k] = 0;
        g.noChest[k] |= e.kind === 'station' && p.kind === 'in' ? NO_CHEST_INPUT : NO_CHEST_PORT;
        if (ENTITY_KINDS[e.kind].feeds && p.kind === 'out') {
          if (e.kind === 'distributor' && e.garden && !e.material) freeGarden.push({ id: e.id, k, d: p.dir });
          else if (e.kind === 'distributor') this.distributors.set(e.material, { k, d: p.dir });
          else cellar = { k, d: p.dir };
          g.distFront[k] = rev(p.dir);
        }
      }
    }
    this._useCellar(g, cellar);
    this._useGarden(g, freeGarden);
    this._reservePorters(g);
    this.base = g;
    // Footprint positions free of obstacles, per station size.
    /** @type {Record<string, { x: number, y: number }[]>} */
    this.spots = {};
    const free = (/** @type {number} */ k) => g.floor[k] && g.occ[k] === 0 && g.reserved[k] === -1 && g.gap[k] === -1;
    for (const size of new Map(this.stations.map((s) => [dimsKey(sizeOf(s)), sizeOf(s)])).values()) {
      /** @type {{ x: number, y: number }[]} */
      const spots = this.spots[dimsKey(size)] = [];
      for (let y = 0; y + size.h <= l.height; y++) {
        for (let x = 0; x + size.w <= l.width; x++) {
          let ok = true;
          for (let dy = 0; dy < size.h && ok; dy++) for (let dx = 0; dx < size.w && ok; dx++) ok = free(g.key(x + dx, y + dy));
          if (ok) spots.push({ x, y });
        }
      }
    }
  }

  // The cellar puts everything it holds onto one belt. With one item it's a
  // distributor of that item; with more, a filtered chest one cell in sorts
  // them out of its other three sides (so three items at most: any others
  // come from supply chests). It holds just what the plan takes from it.
  /** @param {RouteGrid} g @param {{ k: number, d: number } | null} out */
  _useCellar(g, out) {
    /** @type {{ belt: number, hub: number, d: number } | null} */
    this.cellarHub = null;
    /** @type {string[] | null} */
    this.cellarStock = null;
    const free = (/** @type {number} */ k) => k >= 0 && g.floor[k] && g.occ[k] === 0 && g.gap[k] === -1;
    const items = Object.entries(this.production.supply)
      .filter(([item, s]) => s.source === 'distributor' && CELLAR_ITEMS.includes(item))
      .sort((a, z) => z[1].rate - a[1].rate).map(([item]) => item);
    if (!out || !items.length || !free(out.k)) return;
    if (items.length === 1) {
      this.distributors.set(items[0], out);
      this.cellarStock = items;
      return;
    }
    const hub = g.step(out.k, out.d);
    if (!free(hub) || g.reserved[hub] !== -1) return;
    this.cellarHub = { belt: out.k, hub, d: out.d };
    const sorted = items.slice(0, 3);
    this.cellarStock = CELLAR_ITEMS.filter((item) => sorted.includes(item));
    for (const item of this.cellarStock) this.distributors.set(item, { k: hub, d: out.d, hub: true });
  }

  // Garden distributors with no crop set take the crops the plan needs most; any it
  // has no distributor left for come from supply chests.
  /** @param {RouteGrid} g @param {{ id: number, k: number, d: number }[]} free */
  _useGarden(g, free) {
    /** @type {[number, string][]} */
    this.gardenStock = [];
    const items = Object.entries(this.production.supply)
      .filter(([item, s]) => s.source === 'distributor' && GARDEN_ITEMS.includes(item) && !this.distributors.has(item))
      .sort((a, z) => z[1].rate - a[1].rate).map(([item]) => item);
    free.forEach((d, i) => {
      if (i >= items.length || !g.floor[d.k] || g.occ[d.k] !== 0) return;
      this.distributors.set(items[i], { k: d.k, d: d.d });
      this.gardenStock.push([d.id, items[i]]);
    });
  }

  // Zombie Supply Porters (one per 3 supply stations) go along PORTER.row, each 1 wide and 2
  // high. The plan can't know how many supply stations it ends up with, so room for the most it
  // could need is kept free (blocked for the router) up front, and only the ones needed are built.
  /** @param {RouteGrid} g */
  _reservePorters(g) {
    const l = this.layout;
    const makers = this.stations.filter((s) => this.production.final[s.item] && isSupplyItem(s.item)).length;
    this.supplyHave = l.entities.filter((e) => e.kind === 'supply_station').length;
    this.portersHave = l.entities.filter((e) => e.kind === 'porter').length;
    const need = Math.max(0, portersFor(this.supplyHave + makers) - this.portersHave);
    /** @type {{ x: number, y: number }[]} */
    this.porterSlots = [];
    const { x0, x1, y } = PORTER.row;
    const free = (/** @type {number} */ k) => g.floor[k] && g.occ[k] === 0 && g.reserved[k] === -1 && g.gap[k] === -1;
    for (let x = x0; x <= x1 && this.porterSlots.length < need; x++) {
      const a = g.key(x, y), b = g.key(x, y + 1);
      if (!free(a) || !free(b)) continue;
      g.block(a);
      g.block(b);
      this.porterSlots.push({ x, y });
    }
  }

  // The porters the routed supply stations need beyond the ones already placed (as many as there's room for).
  /** @param {RouteGrid} g */
  _portersToBuild(g) {
    let n = this.supplyHave;
    for (const e of g.placed.values()) if (e.kind === 'supply_station') n++;
    return Math.min(this.porterSlots.length, Math.max(0, portersFor(n) - this.portersHave));
  }

  // Cells in front of each distributor the plan uses, where no station may go:
  // 3 wide and 4 deep, so the supply line can leave and turn.
  _buildAprons() {
    const g = this.base;
    this.apron = new Uint8Array(g.W * g.H);
    for (const [item, sup] of Object.entries(this.production.supply)) {
      const dist = sup.source === 'distributor' && this.distributors.get(item);
      if (!dist) continue;
      const [nx, ny] = g.xy(dist.k);
      const px = DY[dist.d], py = -DX[dist.d]; // perpendicular
      for (let i = 0; i < 4; i++) for (let j = -1; j <= 1; j++) {
        const x = nx + DX[dist.d] * i + px * j, y = ny + DY[dist.d] * i + py * j;
        if (x >= 0 && y >= 0 && x < g.W && y < g.H) this.apron[g.key(x, y)] = 1;
      }
    }
  }

  // Where supply stations may go: the free floor cells nearest SUPPLY_ZONE
  // (outside distributor aprons), with their distance to it. Existing supply
  // stations are targets too.
  _buildSupplyCells() {
    const g = this.base, l = this.layout;
    /** @param {number} x @param {number} y */
    const dist = supplyZoneDistance;
    const cells = [];
    for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) {
      const k = g.key(x, y);
      if (g.floor[k] && g.occ[k] === 0 && g.reserved[k] === -1 && g.gap[k] === -1 && !this.apron[k]) cells.push({ k, dist: dist(x, y) });
    }
    cells.sort((a, b) => a.dist - b.dist);
    this.supplyCells = cells.slice(0, SUPPLY_CANDIDATES);
    this.supplyStations = l.entities.filter((e) => e.kind === 'supply_station').map((e) => ({
      k: g.key(e.x, e.y), into: rev(e.rot), access: g.key(e.x + DIRS[e.rot].dx, e.y + DIRS[e.rot].dy), dist: dist(e.x, e.y),
    }));
  }

  // Route targets for a "Supply: ..." output: a new supply station on a free
  // candidate cell (entered from any side), or an existing station's input.
  /**
   * @param {RouteGrid} g
   * @param {Map<number, RouteTarget>} targets
   * @param {Set<number>} allow
   */
  _supplyTargets(g, targets, allow) {
    for (const c of this.supplyCells) {
      if (g.occ[c.k] !== 0 || g.reserved[c.k] !== -1 || g.gap[c.k] !== -1) continue;
      targets.set(c.k, { mask: 0b1111, cost: (this.options.supplyCornerCost ?? SUPPLY_CORNER_COST) * c.dist, end: { type: 'newSupply' } });
    }
    for (const st of this.supplyStations) {
      if (st.access < 0 || g.occ[st.access] !== 0) continue;
      targets.set(st.k, { mask: 1 << st.into, cost: (this.options.supplyCornerCost ?? SUPPLY_CORNER_COST) * st.dist, end: { type: 'port' } });
      allow.add(st.access);
    }
  }

  // ---- station geometry ---------------------------------------------------

  // Ports used by station s at placement p: inputs per ingredient, and the output.
  /**
   * @param {StationInstance} s
   * @param {Placement} p
   * @returns {{ inputs: PlacedInput[], output: PlacedPort }}
   */
  ports(s, p) {
    const def = stationVariants(s.type)[p.variant].ports;
    const ins = def.filter((q) => q.kind === 'in');
    const out = def.find((q) => q.kind === 'out');
    /** @param {import('../types.js').PortDef} q @returns {PlacedPort} */
    const at = (q) => {
      const x = p.x + q.x, y = p.y + q.y;
      return { x, y, dir: q.dir, nx: x + DX[q.dir], ny: y + DY[q.dir] };
    };
    // A swap exchanges the input ports (a station with one has nothing to exchange).
    const inputs = s.ingredients.map((ing, i) => {
      const port = p.swap ? ins.length - 1 - i : i;
      return { ...at(ins[port]), item: ing.item, port };
    });
    return { inputs, output: at(out) };
  }

  // Is placement p for station s compatible with the base and the other placements?
  /**
   * @param {StationInstance} s
   * @param {Placement} p
   * @param {(Placement | null)[]} placements
   */
  valid(s, p, placements) {
    const g = this.base;
    /** @param {number} x @param {number} y */
    const cellFree = (x, y) => {
      if (x < 0 || y < 0 || x >= g.W || y >= g.H) return false;
      const k = g.key(x, y);
      return g.floor[k] && g.occ[k] === 0 && g.reserved[k] === -1 && g.gap[k] === -1;
    };
    const size = sizeOf(s);
    for (let dy = 0; dy < size.h; dy++) {
      for (let dx = 0; dx < size.w; dx++) {
        if (!cellFree(p.x + dx, p.y + dy) || this.apron[g.key(p.x + dx, p.y + dy)]) return false;
      }
    }
    const { inputs, output } = this.ports(s, p);
    const access = [...inputs, output].map((q) => [q.nx, q.ny]);
    for (const [x, y] of access) if (!cellFree(x, y)) return false;
    // Ports the recipe doesn't use must face the floor too (Layout.validate checks every port).
    for (const q of stationVariants(s.type)[p.variant].ports) {
      const x = p.x + q.x + DX[q.dir], y = p.y + q.y + DY[q.dir];
      if (x < 0 || y < 0 || x >= g.W || y >= g.H || !g.floor[g.key(x, y)]) return false;
    }
    for (let i = 0; i < placements.length; i++) {
      const o = placements[i];
      if (!o || i === s.idx) continue;
      // Keep free rows/columns between stations for belts.
      if (near(p, size, o, sizeOf(this.stations[i]), this.options.gap ?? 1)) return false;
      const other = this.ports(this.stations[i], o);
      for (const q of [...other.inputs, other.output]) {
        if (access.some(([x, y]) => x === q.nx && y === q.ny)) return false;
      }
    }
    return true;
  }

  // ---- initial placement ----------------------------------------------------

  // Start from `initial` placements (to continue an earlier search) when they
  // still fit, otherwise from a greedy placement.
  /**
   * @param {(Placement | null)[] | null} [initial]
   * @returns {SearchState}
   */
  init(initial = null) {
    const order = [...this.stations].sort((a, b) => a.depth - b.depth || a.idx - b.idx);
    /** @type {Placement[]} */
    const placements = new Array(this.stations.length).fill(null);
    if (initial?.length === this.stations.length) {
      initial.forEach((p, i) => { if (p && this.valid(this.stations[i], p, placements)) placements[i] = p; });
    }
    for (const s of order) if (!placements[s.idx]) placements[s.idx] = this._bestSpot(s, placements);
    /** @type {SearchState} */
    this.current = { placements, ...this.evaluate(placements) };
    /** @type {SearchState} */
    this.best = this.current;
    return this.best;
  }

  /**
   * @param {StationInstance} s
   * @param {(Placement | null)[]} placements
   * @returns {Placement | null}
   */
  _bestSpot(s, placements) {
    const placed = placements.map((p, i) => p && { p, s: this.stations[i] }).filter(Boolean);
    const cx = placed.length ? placed.reduce((a, o) => a + o.p.x, 0) / placed.length : null;
    const cy = placed.length ? placed.reduce((a, o) => a + o.p.y, 0) / placed.length : null;
    const outputs = placed.map((o) => ({ item: o.s.item, port: this.ports(o.s, o.p).output }));
    /** @type {Placement | null} */
    let best = null, bestCost = Infinity;
    for (const spot of this.spots[dimsKey(sizeOf(s))]) {
      for (const variant of variantsOf(s)) {
        for (const swap of [false, true]) {
          const p = { x: spot.x, y: spot.y, variant, swap };
          if (!this.valid(s, p, placements)) continue;
          const { inputs } = this.ports(s, p);
          let cost = 0;
          for (const q of inputs) {
            const dist = this.distributors.get(q.item);
            if (dist) {
              const [dx, dy] = this.base.xy(dist.k);
              cost += Math.abs(dx - q.nx) + Math.abs(dy - q.ny);
            } else {
              let m = Infinity;
              for (const o of outputs) if (o.item === q.item) m = Math.min(m, Math.abs(o.port.nx - q.nx) + Math.abs(o.port.ny - q.ny));
              if (m < Infinity) cost += m;
            }
          }
          if (cx != null) cost += 0.3 * (Math.abs(cx - spot.x) + Math.abs(cy - spot.y));
          // Makers of a final "Supply: ..." item start near the supply zone.
          if (this.production.final[s.item] && isSupplyItem(s.item)) {
            const out = this.ports(s, p).output;
            cost += supplyZoneDistance(out.nx, out.ny);
          }
          // Leave room for belts: a one-cell gap fits a single belt only.
          for (const o of placed) {
            if (near(spot, sizeOf(s), o.p, sizeOf(o.s), 2)) cost += 6;
          }
          if (cost < bestCost) { bestCost = cost; best = p; }
        }
      }
    }
    return best;
  }

  // ---- evaluation: route everything for a placement ------------------------

  // Route everything for a placement.
  /**
   * @overload
   * @param {(Placement | null)[]} placements
   * @param {false} [collect]
   * @param {number} [maxFailed]
   * @returns {{ score: number, failed: number }}
   */
  /**
   * @overload
   * @param {(Placement | null)[]} placements
   * @param {true} collect
   * @param {number} [maxFailed]
   * @returns {Evaluation}
   */
  /**
   * @param {(Placement | null)[]} placements
   * @param {boolean} [collect]
   * @param {number} [maxFailed] stop routing once more connections than this have failed: the
   *   caller would reject the placement anyway, and a failed route is the slowest (A* searches
   *   everything it can reach). The result then has an infinite score and `aborted`.
   */
  evaluate(placements, collect = false, maxFailed = Infinity) {
    this.evaluations++;
    const r = this._evaluate(placements, this.options.earlyStop === false ? Infinity : maxFailed);
    if (!collect) return { score: r.score, failed: r.failures.length };
    return r;
  }

  /**
   * @param {(Placement | null)[]} placements
   * @param {number} [maxFailed]
   * @returns {Evaluation}
   */
  _evaluate(placements, maxFailed = Infinity) {
    const b = this.base;
    const g = new RouteGrid(b.W, b.H, this.costs);
    for (const f of /** @type {const} */ (['floor', 'occ', 'rot', 'gap', 'body', 'reserved', 'noChest', 'chestFeeds', 'distFront'])) g[f].set(b[f]);

    // The cellar's belt and sorting chest, with the chest's three outer sides
    // kept free for its lines.
    /** @type {number[]} */
    const hubSides = [];
    if (this.cellarHub) {
      const { belt, hub, d } = this.cellarHub;
      const [bx, by] = g.xy(belt), [hx, hy] = g.xy(hub);
      g.occ[belt] = 2;
      g.rot[belt] = d;
      g.placed.set(belt, { kind: 'belt', x: bx, y: by, rot: d });
      g.placed.set(hub, { kind: 'chest', x: hx, y: hy, stock: [], filters: {}, role: 'hub' });
      g.addChestAt(hub, 0);
      g.net.set(hub, { k: hub, kind: 'hub', next: [], prev: [], up: new Set(), down: new Set(), din: d });
      for (const side of [d, (d + 1) % 4, (d + 3) % 4]) {
        const k = g.step(hub, side);
        if (k < 0 || !g.floor[k] || g.occ[k] !== 0 || g.reserved[k] !== -1) continue;
        g.reserved[k] = 2;
        hubSides.push(side);
      }
    }

    // Stations and their port access cells. Each port also holds the next cell
    // straight out (a "stub") until it is connected, so passing belts can't box
    // it in.
    /** @type {Endpoint[]} */
    const sinks = [], producers = /** @type {Endpoint[]} */ ([]);
    /** @type {number[]} */
    const stubs = [];
    /** @param {number} n @param {number} d */
    const stub = (n, d) => {
      const k = g.step(n, d);
      if (k < 0 || !g.floor[k] || g.occ[k] !== 0 || g.reserved[k] !== -1 || g.gap[k] !== -1) return -1;
      stubs.push(k);
      g.reserved[k] = 2;
      return k;
    };
    // Also once a line runs over it: a hub can't go on a reserved cell.
    const release = (/** @type {number} */ k) => { if (k >= 0) g.reserved[k] = -1; };
    /** @type {Failure[]} */
    const failures = [];
    // Every station and its used ports' access cells first, then the stubs: a
    // stub must not take a cell another station needs (one station's side output
    // can point straight at the next one's port across a one-cell gap).
    this.stations.forEach((s, i) => {
      const p = placements[i];
      if (!p) {
        failures.push({ reason: 'no room', station: i });
        return;
      }
      for (let dy = 0; dy < sizeOf(s).h; dy++) for (let dx = 0; dx < sizeOf(s).w; dx++) g.block(g.key(p.x + dx, p.y + dy));
      for (const q of stationVariants(s.type)[p.variant].ports) {
        const k = g.step(g.key(p.x + q.x, p.y + q.y), q.dir);
        if (k >= 0) g.noChest[k] |= q.kind === 'in' ? NO_CHEST_INPUT : NO_CHEST_PORT;
      }
      const { inputs, output } = this.ports(s, p);
      for (const q of [...inputs, output]) g.reserved[g.key(q.nx, q.ny)] = 1;
    });
    this.stations.forEach((s, i) => {
      const p = placements[i];
      if (!p) return;
      const { inputs, output } = this.ports(s, p);
      inputs.forEach((q, j) => {
        const n = g.key(q.nx, q.ny);
        sinks.push({ id: `s${i}i${j}`, item: q.item, rate: s.ingredients[j].rate, qty: s.ingredients[j].qty, n, stub: stub(n, q.dir), P: g.key(q.x, q.y), into: rev(q.dir), station: i });
      });
      const n = g.key(output.nx, output.ny);
      producers.push({ id: `s${i}o`, item: s.item, rate: s.outRate, n, stub: stub(n, output.dir), d: output.dir, station: i });
    });

    // Distributors the plan uses keep two cells straight out free until connected:
    // they sit side by side along a wall and are easily boxed in.
    const supply = this.production.supply;
    /** @type {Map<string, number[]>} */
    const distStub = new Map();
    for (const [item, sup] of Object.entries(supply)) {
      const dist = sup.source === 'distributor' && this.distributors.get(item);
      if (!dist || dist.hub) continue;
      const a = stub(dist.k, dist.d);
      distStub.set(item, [a, a >= 0 ? stub(a, dist.d) : -1]);
    }

    // Who feeds whom.
    /** @type {Edge[]} */
    const edges = [];
    /** @type {Endpoint[]} */
    const finals = Object.entries(this.production.final).map(([item, rate]) => ({ id: `final:${item}`, item, rate, final: true }));
    for (const sk of sinks) {
      const sup = supply[sk.item];
      if (!sup) continue;
      const dist = sup.source === 'distributor' && this.distributors.get(sk.item);
      if (dist) edges.push({ src: { id: `dist:${sk.item}`, n: dist.k, d: dist.d, stubs: distStub.get(sk.item), hub: dist.hub }, sink: sk, item: sk.item });
      else edges.push({ src: { id: 'chest', chest: true }, sink: sk, item: sk.item });
    }
    /** @type {Map<string, { producers: Endpoint[], consumers: Endpoint[] }>} */
    const byItem = new Map();
    for (const pr of producers) {
      if (!byItem.has(pr.item)) byItem.set(pr.item, { producers: [], consumers: [] });
      byItem.get(pr.item).producers.push({ ...pr, left: pr.rate });
    }
    for (const c of [...sinks.filter((sk) => !supply[sk.item]), ...finals]) {
      byItem.get(c.item)?.consumers.push({ ...c, left: c.rate });
    }
    for (const { producers: ps, consumers: cs } of byItem.values()) {
      // Greedy: nearest producer/consumer pairs first.
      /** @type {{ p: Endpoint, c: Endpoint, dist: number }[]} */
      const pairs = [];
      for (const p of ps) for (const c of cs) pairs.push({ p, c, dist: c.final ? 3 : this._dist(p.n, c.n) });
      pairs.sort((a, z) => a.dist - z.dist);
      for (const { p, c } of pairs) {
        if (p.left <= 1e-9 || c.left <= 1e-9) continue;
        const amount = Math.min(p.left, c.left);
        p.left -= amount;
        c.left -= amount;
        edges.push({ src: p, sink: c, item: c.item, rate: amount });
      }
    }
    // A station's product that another station takes several of per craft goes through a
    // chest on the output, which builds up a buffer for it.
    for (const e of edges) e.buffer = e.src.station != null && !e.sink.final && !isSupplyItem(e.item) && (e.sink.qty ?? 1) > 1;
    for (const e of edges) e.est = e.src.chest ? 2 : e.sink.final ? 3 : this._dist(e.src.n, e.sink.n);
    /** @type {Map<string, number>} */
    const fanout = new Map();
    for (const e of edges) fanout.set(e.src.id, (fanout.get(e.src.id) ?? 0) + 1);
    edges.sort((a, z) => a.est - z.est);

    // Route in order.
    const usedSrc = /** @type {Set<string>} */ (new Set()), connected = /** @type {Set<string>} */ (new Set()), finalChest = /** @type {Map<string, number>} */ (new Map());
    // Lines that only lead to supply stations take any "Supply: ..." item, so they can merge.
    const supplySinks = new Set(finals.filter((f) => isSupplyItem(f.item)).map((f) => f.id));
    let cost = 0;
    for (const e of edges) {
      const { src, sink, item } = e;
      const allow = new Set(), exempt = new Map(), targets = new Map();
      /** @type {RouteStart[]} */
      let starts;
      if (src.chest) {
        starts = g.chestStarts(item, sink.n, 6);
      } else if (src.hub && !usedSrc.has(src.id)) {
        // Out of a free side of the cellar's chest (filtered to this item when applied).
        starts = hubSides.map((side) => ({ k: g.step(src.n, side), d: side, cost: 0, straight: true, origin: { type: 'existingHub', k: src.n } }));
        for (const s of starts) allow.add(s.k);
      } else if (!usedSrc.has(src.id)) {
        // A station output facing left or right needs a belt: it can't push
        // straight into a chest (a top output can).
        const sideOutput = src.station != null && src.d % 2 === 1;
        starts = [{ k: src.n, d: src.d, cost: e.buffer && !sideOutput ? BUFFER_MISS_COST : 0, noChest: sideOutput, origin: { type: 'port' } }];
        allow.add(src.n);
        // Or a chest hub right on the output, worth it when the source feeds several consumers.
        if (!sink.final && !sideOutput && g.chestOk(src.n, src.d, allow, true)) {
          const hubCost = e.buffer || (fanout.get(src.id) ?? 1) > 1 ? 1 : g.cost.hub;
          for (let d = 0; d < 4; d++) {
            if (d === rev(src.d)) continue;
            starts.push({ k: g.step(src.n, d), d, cost: hubCost, straight: true, origin: { type: 'portHub', k: src.n } });
          }
        }
        if (src.stub >= 0) allow.add(src.stub);
        for (const k of src.stubs ?? []) if (k >= 0) allow.add(k);
      } else {
        starts = g.branchStarts(item, src.id);
      }
      for (const s of starts) if (['existingHub', 'portHub'].includes(s.origin.type) && s.k >= 0) exempt.set(s.k, 1 << s.d);
      let flexChest = false;
      if (sink.final && isSupplyItem(item)) {
        this._supplyTargets(g, targets, allow);
        g.mergeTargets(item, sink.id, src.id, targets);
        g.mergeSupplyTargets(supplySinks, src.id, targets);
      } else if (sink.final) {
        const ck = finalChest.get(sink.id);
        if (ck == null) flexChest = true;
        else { g.chestTarget(ck, targets); g.mergeTargets(item, sink.id, src.id, targets); }
      } else if (!connected.has(sink.id)) {
        targets.set(sink.P, { mask: 1 << sink.into, end: { type: 'port' } });
        allow.add(sink.n);
        if (sink.stub >= 0) allow.add(sink.stub);
      } else {
        g.mergeTargets(item, sink.id, src.id, targets);
      }
      const res = starts.length && (flexChest || targets.size)
        ? g.routeSound({ starts, targets, flexChest, allow, exempt, noPass: isSupplyItem(item), goalCells: flexChest ? null : [...targets.keys()] })
        : null;
      if (!res) {
        const why = !starts.length ? 'no start' : !(flexChest || targets.size) ? 'no target' : 'no path';
        failures.push({ item, from: src.id, to: sink.id, why, branch: !src.chest && usedSrc.has(src.id), merge: connected.has(sink.id), est: e.est });
        if (failures.length > maxFailed) return { score: Infinity, failed: failures.length, failures, grid: g, edges: edges.length, power: 0, over: 0, aborted: true };
        continue;
      }
      g.apply(res, item, src.id, sink.id);
      cost += res.cost;
      if (!src.chest) release(src.stub);
      for (const k of src.stubs ?? []) release(k);
      if (!sink.final) release(sink.stub);
      if (!src.chest) usedSrc.add(src.id);
      connected.add(sink.id);
      if (res.goal.type === 'newChest') finalChest.set(sink.id, res.goal.k);
    }

    const placedStations = placements.filter(Boolean).length;
    const power = this.basePower + placedStations + powerOf([...g.placed.values()]);
    const { over } = powerSupply(power, this.beltMaster);
    const score = cost + (this.options.failCost ?? FAIL_COST) * failures.length + (this.options.overPowerCost ?? OVER_POWER_COST) * over;
    return { score, failed: failures.length, failures, grid: g, edges: edges.length, power, over };
  }

  /** @param {number} a @param {number} b */
  _dist(a, b) {
    const [ax, ay] = this.base.xy(a), [bx, by] = this.base.xy(b);
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  // ---- simulated annealing --------------------------------------------------

  // Run `n` iterations; `progress` in [0, 1] sets the temperature.
  /**
   * @param {number} n
   * @param {number} progress
   * @returns {SearchState}
   */
  step(n, progress) {
    const T = 30 * Math.pow(0.02, progress);
    for (let it = 0; it < n; it++) {
      this.iterations++;
      const placements = this._neighbour(this.current.placements);
      if (!placements) continue;
      // A candidate with more unrouted connections is all but never accepted
      // (each costs FAIL_COST, far above the temperature), so stop routing it there.
      const r = this.evaluate(placements, false, this.current.failed);
      const delta = r.score - this.current.score;
      if (delta <= 0 || this.random() < Math.exp(-delta / T)) {
        this.current = { placements, ...r };
        if (r.score < this.best.score) this.best = this.current;
      }
    }
    return this.best;
  }

  /**
   * @param {Placement[]} placements
   * @returns {Placement[] | null}
   */
  _neighbour(placements) {
    const n = this.stations.length;
    if (!n) return null;
    const next = placements.slice();
    const i = Math.floor(this.random() * n);
    const s = this.stations[i];
    const cur = placements[i];
    const move = this.random();
    /** @type {Placement} */
    let p;
    if (!cur || move < 0.45) {
      // Relocate: usually nearby, sometimes anywhere.
      if (cur && this.random() < 0.75) {
        const r = 1 + Math.floor(this.random() * 6);
        p = { ...cur, x: cur.x + Math.round((this.random() * 2 - 1) * r), y: cur.y + Math.round((this.random() * 2 - 1) * r) };
      } else {
        const spots = this.spots[dimsKey(sizeOf(s))];
        const spot = spots[Math.floor(this.random() * spots.length)];
        if (!spot) return null;
        p = { x: spot.x, y: spot.y, variant: cur?.variant ?? variantsOf(s)[0], swap: cur?.swap ?? false };
      }
    } else if (move < 0.7) {
      const variants = variantsOf(s);
      p = { ...cur, variant: variants[Math.floor(this.random() * variants.length)] };
    } else if (move < 0.8) {
      p = { ...cur, swap: !cur.swap };
    } else {
      // Swap positions with another station.
      const j = Math.floor(this.random() * n);
      if (j === i || !placements[j]) return null;
      const a = { ...cur, x: placements[j].x, y: placements[j].y };
      const b = { ...placements[j], x: cur.x, y: cur.y };
      next[i] = null; next[j] = null;
      if (!this.valid(s, a, next)) return null;
      next[i] = a;
      if (!this.valid(this.stations[j], b, next)) return null;
      next[j] = b;
      return next;
    }
    next[i] = null;
    if (!this.valid(s, p, next)) return null;
    next[i] = p;
    return next;
  }

  // ---- result ---------------------------------------------------------------

  // Entities for the best placement found, ready to add to the layout.
  /** @returns {PlanResult} */
  result() {
    const { placements } = this.best;
    const r = this.evaluate(placements, true);
    /** @type {EntitySpec[]} */
    const entities = [];
    this.stations.forEach((s, i) => {
      const p = placements[i];
      if (!p) return;
      const { inputs } = this.ports(s, p);
      /** @type {(string | null)[]} */
      const byPort = [null, null];
      for (const q of inputs) byPort[q.port] = q.item;
      entities.push({ kind: 'station', type: s.type, level: s.level, variant: p.variant, x: p.x, y: p.y, recipe: s.recipe, extensions: RECIPE_BY_ID[s.recipe]?.extension ? [RECIPE_BY_ID[s.recipe].extension] : [], inputs: byPort });
    });
    for (const e of r.grid.placed.values()) entities.push({ ...e });
    for (const slot of this.porterSlots.slice(0, this._portersToBuild(r.grid))) entities.push({ kind: 'porter', ...slot });
    for (const e of entities) { e.planned = true; e.locked = false; }
    const supply = powerSupply(this.basePower + powerOf(entities), this.beltMaster);
    const count = (/** @type {string} */ kind) => entities.filter((e) => e.kind === kind).length;
    return {
      entities,
      placements,
      failures: r.failures,
      cellarStock: this.cellarStock,
      gardenStock: this.gardenStock,
      score: r.score,
      stats: {
        stations: count('station'), belts: count('belt'), undergrounds: count('underground'),
        splitters: count('splitter'), chests: count('chest'), supplyStations: count('supply_station'), power: supply.used, available: supply.available,
        over: supply.over, zombies: supply.zombies, connections: r.edges,
        iterations: this.iterations,
      },
    };
  }
}
