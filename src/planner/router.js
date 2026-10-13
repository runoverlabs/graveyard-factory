// @ts-check
// Belt routing on a grid. A search node is an *arrival*: an item entering cell k
// travelling in direction d. From an arrival we place a belt (continue straight
// or turn) or an underground conveyor (jump 5 cells, crossing whatever belt sits
// in its gap). Goals are arrivals into a target: a station input port, the side
// of a belt already heading to the same consumer (merge), or a chest.
//
// Paths of the same item form a network. Every network cell tracks which
// sources feed it (`up`) and which consumers it leads to (`down`), so a new
// connection can branch off a line coming from its source (splitter at a turn,
// a chest hub in place of a belt, or another side of a chest already in the
// line or of an output chest it fills) and merge into a line that only leads
// to its consumer.

import { UNDERGROUND_LENGTH, UNDERGROUND_GAP } from '../catalog.js';

/** @typedef {import('../types.js').EntitySpec} EntitySpec */
/** @typedef {import('../types.js').SideName} SideName */

// Route and network shapes. planner.js builds requests and reads paths.

/**
 * Where a route begins and what to build there when it is applied.
 * @typedef {object} RouteOrigin
 * @property {'port' | 'splitter' | 'hub' | 'portHub' | 'existingHub' | 'newChest'} type
 * @property {number} [k] cell of the splitter, hub or chest
 */

/**
 * An arrival the route may begin with.
 * @typedef {object} RouteStart
 * @property {number} k cell entered (-1: off the grid, skipped)
 * @property {number} d direction of travel
 * @property {number} cost
 * @property {boolean} [straight] leaving a chest: must lay a straight belt first
 * @property {boolean} [noChest] must lay a belt before ending in a chest
 * @property {number} [exemptFrom] hub cell this start leaves from
 * @property {RouteOrigin} origin
 */

/** @typedef {{ type: 'port' | 'merge' | 'chest' | 'newSupply' }} RouteEnd */

/**
 * Arrivals into cell k that finish a route.
 * @typedef {object} RouteTarget
 * @property {number} mask bit d: arriving travelling in direction d
 * @property {RouteEnd} end
 * @property {number} [cost] extra cost of finishing here
 */

/**
 * @typedef {object} RouteRequest
 * @property {RouteStart[]} starts
 * @property {Map<number, RouteTarget>} targets
 * @property {boolean} [flexChest] end by placing a chest on any suitable free cell
 * @property {boolean} [noPass] never put a chest in the line ("Supply: ..." items can't enter chests)
 * @property {Set<number>} allow reserved cells this route may use
 * @property {Map<number, number>} [exempt] cell -> rotation mask (belts allowed next to chests)
 * @property {number[] | null} [goalCells] for the A* heuristic
 */

/** @typedef {{ k: number, d: number, type: RouteEnd['type'] | 'newChest' }} RouteGoal */

/** A piece placed in cell k, entered travelling din; act 0-3: belt rot, 4 + d: underground, 8 + r: a chest the line leaves from side r. @typedef {{ k: number, din: number, act: number }} RouteStep */

/**
 * @typedef {object} RoutePath
 * @property {number} cost
 * @property {RouteStart} start
 * @property {RouteStep[]} steps
 * @property {RouteGoal} goal
 */

/**
 * A network cell (or a port, k = -1), linked to its neighbours along the item flow.
 * @typedef {object} NetNode
 * @property {number} k
 * @property {'port' | 'splitter' | 'hub' | 'belt' | 'underground' | 'ugExit' | 'pass' | 'chest' | 'supply'} kind
 * @property {string} [item]
 * @property {number} [rot]
 * @property {number} [din]
 * @property {NetNode[]} next
 * @property {NetNode[]} prev
 * @property {Set<string>} up source ids feeding it
 * @property {Set<string>} down consumer ids it leads to
 */

export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
const rev = (/** @type {number} */ d) => (d + 2) % 4;
/** @type {SideName[]} */
const SIDE_NAMES = ['N', 'E', 'S', 'W']; // chest filter keys by direction

// Route costs: one unit per belt, extra for turns and special pieces.
export const COST = {
  belt: 1,
  turn: 0.3,
  // An underground costs 2 power for 5 cells, a bit more than 2 here for the space its body blocks.
  underground: 3,
  splitter: 2,
  hub: 4,
  chest: 3,
  // A chest in the line, in place of a belt: chests use no power.
  passChest: 0.5,
  // Branching off a chest already in the line: just another filtered side.
  passHub: 1,
};

export const MAX_STATIONS_PER_BELT = 3;
export const NO_CHEST_PORT = 1, NO_CHEST_INPUT = 2;
const FREE = 0, BLOCKED = 1, BELT = 2, CHEST = 3;

export class RouteGrid {
  /**
   * @param {number} width
   * @param {number} height
   */
  constructor(width, height) {
    const n = width * height;
    this.W = width;
    this.H = height;
    this.floor = new Uint8Array(n);
    this.occ = new Uint8Array(n);       // FREE / BLOCKED / BELT / CHEST
    this.rot = new Int8Array(n).fill(-1);
    this.gap = new Int8Array(n).fill(-1);      // rot of the underground whose gap is here
    this.body = new Int8Array(n).fill(-1);     // rot of the underground with a belt cell here
    this.reserved = new Int32Array(n).fill(-1); // port access cell, owner token
    // A port's access cell (used or not): NO_CHEST_PORT, plus NO_CHEST_INPUT for
    // a station input's. No chest in the line goes on either; no chest at all on
    // a station input's, since chests can't feed stations (Layout.validate).
    this.noChest = new Uint8Array(n);
    // In front of a distributor: the direction back into it. Only a belt or an
    // underground's belt cell may go there, not pointing back
    // (DISTRIBUTOR_FRONT_KINDS); the planner only puts an underground's entry
    // there, so no other line takes in the distributor's material.
    this.distFront = new Int8Array(n).fill(-1);
    // Bit r set: a belt (or underground belt cell) here with rotation r would be
    // fed by an adjacent chest.
    // A chest pushes into every neighbouring belt not pointing into it, on the
    // sides it outputs from: its filtered sides, or every side with no filters.
    this.chestFeeds = new Uint8Array(n);
    /** @type {Map<number, NetNode>} */
    this.net = new Map();                       // k -> network node
    /** @type {Map<number, EntitySpec>} */
    this.placed = new Map();                    // k -> entity spec (planned pieces)
    // Search scratch space, reused between routes.
    const m = n * 8;
    this.dist = new Float64Array(m);
    this.stamp = new Uint32Array(m);
    this.parent = new Int32Array(m);
    this.action = new Int8Array(m);
    this.round = 0;
  }

  /** @param {number} x @param {number} y */
  key(x, y) { return y * this.W + x; }
  /** @param {number} k @returns {[number, number]} */
  xy(k) { return [k % this.W, (k / this.W) | 0]; }

  /**
   * Cell n steps from k in direction d, or -1 off the grid.
   * @param {number} k
   * @param {number} d
   * @param {number} [n]
   */
  step(k, d, n = 1) {
    const x = (k % this.W) + DX[d] * n, y = ((k / this.W) | 0) + DY[d] * n;
    return x >= 0 && y >= 0 && x < this.W && y < this.H ? y * this.W + x : -1;
  }

  /** @param {number} k */
  neighbours(k) {
    /** @type {number[]} */
    const out = [];
    for (let d = 0; d < 4; d++) { const j = this.step(k, d); if (j >= 0) out.push(j); }
    return out;
  }

  /** @param {number} k */
  block(k) { if (k >= 0) this.occ[k] = BLOCKED; }

  // A chest at k outputting from the sides in mask `sides` (bit d = side d).
  // Chests the planner places for supply or as hubs get a filter on each side
  // they feed, so they output nowhere else (sides = 0); output chests have none.
  /** @param {number} k @param {number} [sides] */
  addChestAt(k, sides = 0b1111) {
    this.occ[k] = CHEST;
    for (let d = 0; d < 4; d++) {
      const j = this.step(k, d);
      if (j >= 0 && sides & (1 << d)) this.chestFeeds[j] |= 0b1111 & ~(1 << rev(d));
    }
  }

  // Filter a planned chest's side d to `item`, so it outputs there.
  /** @param {number} k @param {number} d @param {string} item */
  _filterChest(k, d, item) {
    const c = this.placed.get(k);
    if (c?.kind === 'chest') c.filters[SIDE_NAMES[d]] = item;
  }

  // Can a belt with rotation `r` go in cell k? `allow` = cells reserved for this route.
  // `exempt` = cell -> rotations allowed next to a chest (the chest outputs
  // this route starts from).
  /**
   * @param {number} k
   * @param {number} r
   * @param {Set<number>} allow
   * @param {Map<number, number>} [exempt]
   */
  beltOk(k, r, allow, exempt) {
    if (k < 0 || !this.floor[k] || this.occ[k] !== FREE) return false;
    if (this.reserved[k] !== -1 && !allow.has(k)) return false;
    if (this.chestFeeds[k] & (1 << r) && !((exempt?.get(k) ?? 0) & (1 << r))) return false;
    if (this.gap[k] !== -1 && (this.gap[k] & 1) === (r & 1)) return false; // must cross the gap
    if (this.distFront[k] === r) return false;
    return true;
  }

  // Cell k can take a chest (reached from direction d, or null for a supply chest).
  // A filtered chest (supply, hub) only feeds the sides it's filtered to, so
  // belts next to it don't matter. A chest may sit on an underground's gap.
  /**
   * @param {number} k
   * @param {number | null} d
   * @param {Set<number>} allow
   * @param {boolean} [filtered]
   */
  chestOk(k, d, allow, filtered = false) {
    if (k < 0 || !this.floor[k] || this.occ[k] !== FREE || this.distFront[k] !== -1 || this.noChest[k] & NO_CHEST_INPUT) return false;
    if (this.reserved[k] !== -1 && !allow.has(k)) return false;
    // An unfiltered chest pushes into every neighbouring belt (or underground
    // belt cell) that doesn't point into it, so none may sit next to it except
    // one feeding it.
    if (filtered) return true;
    for (let dd = 0; dd < 4; dd++) {
      const j = this.step(k, dd);
      if (j >= 0 && this.occ[j] === BELT && this.rot[j] !== rev(dd)) return false;
      if (j >= 0 && this.body[j] !== -1 && this.body[j] !== rev(dd)) return false;
    }
    return true;
  }

  // ---- search ---------------------------------------------------------------

  // req: {
  //   starts:  [{ k, d, cost, straight, noChest, origin }]  arrivals the route may
  //            begin with (noChest: must lay a belt before ending in a chest)
  //   targets: Map k -> { mask, end, cost }         arrivals that finish it (cost: extra
  //            cost of finishing there, e.g. a supply station far from its corner)
  //   flexChest: end by placing a chest on any suitable free cell
  //   allow:   Set of reserved cells this route may use
  //   exempt:  Map k -> rotation mask (belts allowed next to chests)
  //   goalCells: [k] for the A* heuristic (omit when flexChest)
  // }
  /**
   * @param {RouteRequest} req
   * @returns {RoutePath | null}
   */
  route(req) {
    const { starts, targets, flexChest, allow, exempt, noPass } = req;
    const round = ++this.round;
    const heap = new MinHeap();
    const hx = req.goalCells?.map((k) => this.xy(k));
    const h = (/** @type {number} */ k) => {
      if (!hx?.length) return 0;
      const [x, y] = this.xy(k);
      let best = Infinity;
      for (const [gx, gy] of hx) best = Math.min(best, Math.abs(gx - x) + Math.abs(gy - y));
      return best * COST.belt * 0.999;
    };
    /** @param {number} k @param {number} d @param {number} s */
    const node = (k, d, s) => (k * 4 + d) * 2 + s;
    /** @param {number} n @param {number} g @param {number} par @param {number} act */
    const push = (n, g, par, act) => {
      if (this.stamp[n] === round && this.dist[n] <= g) return;
      this.stamp[n] = round;
      this.dist[n] = g;
      this.parent[n] = par;
      this.action[n] = act;
      heap.push(g + h((n >> 3)), n);
    };
    /** @type {Map<number, RouteStart>} */
    const startOf = new Map();
    for (const s of starts) {
      if (s.k < 0) continue;
      const n = node(s.k, s.d, s.straight ? 1 : 0);
      if (!(this.stamp[n] === round && this.dist[n] <= s.cost)) startOf.set(n, s);
      push(n, s.cost, -1, -1);
    }
    let expanded = 0;
    // Targets with an extra cost: keep the cheapest finish found, and stop once
    // nothing left in the queue can beat it.
    /** @type {{ n: number, total: number, goal: RouteGoal } | null} */
    let best = null;
    const finish = () => best && { ...this._path(best.n, startOf, best.goal), cost: best.total };
    while (heap.size) {
      if (best && heap.peekKey() >= best.total) return finish();
      const n = heap.pop();
      const g = this.dist[n];
      const k = n >> 3, d = (n >> 1) & 3, straight = n & 1;
      if (++expanded > 200000) break;
      // A chest only outputs onto a belt, so a route starting at a chest (the
      // `straight` starts) must lay at least one belt before it can finish.
      const fromChest = straight && this.parent[n] === -1;
      // A station's side output can't push straight into a chest.
      const noChestHere = this.parent[n] === -1 && startOf.get(n)?.noChest;
      let t = !fromChest && targets.get(k);
      if (t && noChestHere && t.end.type === 'chest') t = null;
      if (t && t.mask & (1 << d)) {
        if (!t.cost && !best) return this._path(n, startOf, { k, d, ...t.end });
        const total = g + (t.cost ?? 0);
        if (!best || total < best.total) best = { n, total, goal: { k, d, ...t.end } };
      }
      if (flexChest && !fromChest && !noChestHere && this.chestOk(k, d, allow)) return this._path(n, startOf, { k, d, type: 'newChest' });
      // Place a belt here.
      const outs = straight ? [d] : [d, (d + 1) % 4, (d + 3) % 4];
      for (const r of outs) {
        if (!this.beltOk(k, r, allow, exempt)) continue;
        const nk = this.step(k, r);
        if (nk < 0) continue;
        push(node(nk, r, 0), g + COST.belt + (r !== d ? COST.turn : 0), n, r);
      }
      // Or a chest, which uses no power: where the line turns, or right after an
      // underground (straight on too). Filtered to the one side it leaves from, so
      // nothing may already be pushing into the cell, and never on a station's port
      // access cell (a chest can't feed a station directly).
      if (!straight && !noPass && this.parent[n] !== -1 && !this.chestFeeds[k] && this.reserved[k] === -1 && !this.noChest[k] && this.chestOk(k, d, allow, true)) {
        for (const r of [d, (d + 1) % 4, (d + 3) % 4]) {
          if (r === d && this.action[n] < 4) continue;
          const nk = this.step(k, r);
          if (nk >= 0) push(node(nk, r, 1), g + COST.passChest + (r !== d ? COST.turn : 0), n, 8 + r);
        }
      }
      // Or an underground conveyor, entered from behind (not straight out of a
      // chest: chests only output onto belts).
      if (!straight && this._undergroundOk(k, d, allow)) {
        const nk = this.step(k, d, UNDERGROUND_LENGTH);
        if (nk >= 0) push(node(nk, d, 0), g + COST.underground, n, 4 + d);
      }
    }
    return finish();
  }

  /** @param {number} k @param {number} d @param {Set<number>} allow */
  _undergroundOk(k, d, allow) {
    if (this.gap[k] !== -1 || this.distFront[k] === d) return false;
    for (let i = 0; i < UNDERGROUND_LENGTH; i++) {
      const c = this.step(k, d, i);
      if (c < 0 || !this.floor[c]) return false;
      if (i > 0 && i !== UNDERGROUND_GAP && this.distFront[c] !== -1) return false; // only its entry and its gap go in front of a distributor
      if (i === UNDERGROUND_GAP) {
        if (this.gap[c] !== -1 || this.reserved[c] !== -1) return false;
        // The gap can pass under a crossing belt, a chest, or a crossing
        // underground's belt cell (UNDERGROUND_GAP_KINDS).
        if (this.body[c] !== -1 && (this.body[c] & 1) !== (d & 1)) continue;
        if (this.occ[c] === BELT ? (this.rot[c] & 1) === (d & 1) : this.occ[c] !== FREE && this.occ[c] !== CHEST) return false;
      } else if (i > 0 && this.gap[c] !== -1 && (this.gap[c] & 1) !== (d & 1) && this.occ[c] === FREE && this.reserved[c] === -1 && !(this.chestFeeds[c] & (1 << d))) {
        continue; // a belt cell over another underground's gap, crossing it
      } else if (this.occ[c] !== FREE || this.gap[c] !== -1
        || (this.reserved[c] !== -1 && !(i === 0 && allow.has(c)))) {
        return false;
      } else if (this.chestFeeds[c] & (1 << d)) {
        return false; // a neighbouring chest would push into it, like into a belt
      }
    }
    return true;
  }

  /**
   * @param {number} end
   * @param {Map<number, RouteStart>} startOf
   * @param {RouteGoal} goal
   * @returns {RoutePath}
   */
  _path(end, startOf, goal) {
    // action[n] is the piece placed in the parent's cell to reach arrival n.
    /** @type {RouteStep[]} */
    const steps = [];
    let n = end;
    while (this.parent[n] !== -1) {
      const p = this.parent[n];
      steps.push({ k: p >> 3, din: (p >> 1) & 3, act: this.action[n] });
      n = p;
    }
    steps.reverse();
    return { cost: this.dist[end], start: startOf.get(n), steps, goal };
  }

  // The search does not track the cells a route itself uses, so a route can run
  // into itself. Returns the cells used twice (or the route's own belts leading
  // away from a chest it places); empty if the route is sound. Crossing its own path through an
  // underground's gap (with a belt or another underground) is fine.
  /**
   * @param {RoutePath} path
   * @returns {number[]}
   */
  conflicts(path) {
    /** @type {Map<number, string>} */
    const use = new Map(); // k -> 'belt:<axis>' | 'body:<axis>' | 'gap:<axis>' | 'crossed'
    /** @type {Set<number>} */
    const bad = new Set();
    /** @param {number} k @param {string} what */
    const claim = (k, what) => {
      const had = use.get(k);
      if (had == null) { use.set(k, what); return; }
      /** @param {string} a @param {string} b */
      const gapBelt = (a, b) => a.startsWith('gap:') && /^(belt|body):/.test(b) && a.slice(-1) !== b.slice(-1);
      if (gapBelt(had, what) || gapBelt(what, had)) { use.set(k, 'crossed'); return; }
      bad.add(k);
    };
    for (const s of path.steps) {
      if (s.act < 4) claim(s.k, `belt:${s.act & 1}`);
      else if (s.act >= 8) claim(s.k, 'chest');
      else {
        const d = s.act - 4;
        for (let i = 0; i < UNDERGROUND_LENGTH; i++) {
          const c = this.step(s.k, d, i);
          claim(c, `${i === UNDERGROUND_GAP ? 'gap' : 'body'}:${d & 1}`);
        }
      }
    }
    // Chests this route places. Supply and hub chests are filtered to their
    // outputs, so only their own cell matters. Next to an (unfiltered) output
    // chest, the route's belts may only point into it.
    // Belt cells and their rotation, the undergrounds' included.
    const beltRot = new Map(path.steps.flatMap((st) => st.act < 4 ? [[st.k, st.act]] : st.act >= 8 ? []
      : Array.from({ length: UNDERGROUND_LENGTH }, (_, i) => i).filter((i) => i !== UNDERGROUND_GAP).map((i) => [this.step(st.k, st.act - 4, i), st.act - 4])));
    const o = path.start?.origin;
    const first = path.steps[0];
    /** @type {number[]} */
    const chests = [];
    if (o && ['newChest', 'hub', 'portHub'].includes(o.type) && use.has(o.k)) bad.add(o.k);
    if (path.goal.type === 'newChest') chests.push(path.goal.k);
    if (path.goal.type === 'newSupply' && use.has(path.goal.k)) bad.add(path.goal.k);
    for (const c of chests) {
      if (use.has(c)) bad.add(c);
      for (let d = 0; d < 4; d++) {
        const j = this.step(c, d);
        if (j < 0 || !beltRot.has(j) || beltRot.get(j) === rev(d)) continue;
        bad.add(j);
      }
    }
    return [...bad];
  }

  // Route, retrying with a route's own conflicting cells blocked.
  /**
   * @param {RouteRequest} req
   * @param {number} [tries]
   * @returns {RoutePath | null}
   */
  routeSound(req, tries = 4) {
    /** @type {number[]} */
    const blocked = [];
    let res = null;
    for (let t = 0; t < tries; t++) {
      res = this.route(req);
      if (!res) break;
      const bad = this.conflicts(res);
      if (!bad.length) break;
      for (const k of bad) if (this.occ[k] === FREE) { blocked.push(k); this.occ[k] = BLOCKED; }
      res = null;
    }
    for (const k of blocked) this.occ[k] = FREE;
    return res;
  }

  // ---- applying a route -----------------------------------------------------

  // Commit a route found by `route()`. `item` is the item carried, `src`/`sink`
  // the source and consumer ids (for the up/down network bookkeeping).
  /**
   * @param {RoutePath} path
   * @param {string} item
   * @param {string} src
   * @param {string} sink
   */
  apply(path, item, src, sink) {
    const { start, steps, goal } = path;
    const upSet = new Set([src]), downSet = new Set([sink]);
    /** @type {NetNode} */
    let prev = null; // network node items come from

    // Where the route begins.
    const o = start.origin;
    if (o.type === 'port') {
      prev = { k: -1, kind: 'port', next: [], prev: [], up: new Set([src]), down: new Set() };
    } else if (o.type === 'splitter' || o.type === 'hub') {
      const base = this.net.get(o.k);
      if (o.type === 'splitter') {
        base.kind = 'splitter';
        this.placed.set(o.k, { kind: 'splitter', x: this.xy(o.k)[0], y: this.xy(o.k)[1], rot: base.din });
      } else {
        base.kind = 'hub';
        this.placed.set(o.k, { kind: 'chest', x: this.xy(o.k)[0], y: this.xy(o.k)[1], stock: [], filters: {}, role: 'hub' });
        this.addChestAt(o.k, 0);
        this._filterChest(o.k, base.rot, item); // the line carries on out of the front
      }
      prev = base;
      for (const s of base.up) upSet.add(s);
    } else if (o.type === 'portHub') {
      // A chest right on the source's output, sharing out to several belts.
      const [x, y] = this.xy(o.k);
      this.placed.set(o.k, { kind: 'chest', x, y, stock: [], filters: {}, role: 'hub' });
      this.addChestAt(o.k, 0);
      /** @type {NetNode} */
      const port = { k: -1, kind: 'port', next: [], prev: [], up: new Set([src]), down: new Set() };
      prev = { k: o.k, kind: 'hub', item, next: [], prev: [], up: new Set([src]), down: new Set(), din: -1 };
      port.next.push(prev);
      prev.prev.push(port);
      this.net.set(o.k, prev);
    } else if (o.type === 'existingHub') {
      prev = this.net.get(o.k);
      for (const s of prev.up) upSet.add(s);
    } else if (o.type === 'newChest') {
      const [x, y] = this.xy(o.k);
      this.placed.set(o.k, { kind: 'chest', x, y, stock: [item], filters: {}, role: 'supply' });
      this.addChestAt(o.k, 0);
      prev = { k: o.k, kind: 'chest', item, next: [], prev: [], up: upSet, down: new Set(), din: -1 };
      this.net.set(o.k, prev);
    }

    // A chest the route starts from outputs onto its first belt: filter that side.
    if (['newChest', 'hub', 'portHub', 'existingHub'].includes(o.type)) this._filterChest(o.k, start.d, item);

    // Pieces along the way.
    /** @type {NetNode[]} */
    const nodes = [];
    for (const s of steps) {
      const [x, y] = this.xy(s.k);
      if (s.act < 4) {
        this.occ[s.k] = BELT;
        this.rot[s.k] = s.act;
        this.placed.set(s.k, { kind: 'belt', x, y, rot: s.act });
        nodes.push(/** @type {NetNode} */ ({ k: s.k, kind: 'belt', item, rot: s.act, din: s.din }));
      } else if (s.act >= 8) {
        // A chest in the line, filtered to the side the line leaves from.
        this.occ[s.k] = CHEST;
        this.placed.set(s.k, { kind: 'chest', x, y, stock: [], filters: { [SIDE_NAMES[s.act - 8]]: item }, role: 'pass' });
        nodes.push(/** @type {NetNode} */ ({ k: s.k, kind: 'pass', item, rot: s.act - 8, din: s.din }));
      } else {
        const d = s.act - 4;
        this.placed.set(s.k, { kind: 'underground', x, y, rot: d });
        /** @type {number[]} */
        const cells = [];
        for (let i = 0; i < UNDERGROUND_LENGTH; i++) cells.push(this.step(s.k, d, i));
        cells.forEach((c, i) => {
          if (i === UNDERGROUND_GAP) this.gap[c] = d;
          else { this.occ[c] = BLOCKED; this.body[c] = d; }
        });
        // Entry and exit are network nodes; the body in between just blocks.
        nodes.push(/** @type {NetNode} */ ({ k: s.k, kind: 'underground', item, rot: d, din: s.din }));
        nodes.push(/** @type {NetNode} */ ({ k: cells[UNDERGROUND_LENGTH - 1], kind: 'ugExit', item, rot: d, din: d }));
      }
    }

    // Where it ends.
    /** @type {NetNode} */
    let last;
    if (goal.type === 'port') {
      last = { k: -1, kind: 'port', next: [], prev: [], up: new Set(), down: new Set([sink]) };
    } else if (goal.type === 'merge' || goal.type === 'chest') {
      last = this.net.get(goal.k);
      for (const s of last.down) downSet.add(s);
    } else if (goal.type === 'newSupply') {
      // A supply station on the arrival cell, its input facing the incoming belt.
      const [x, y] = this.xy(goal.k);
      this.placed.set(goal.k, { kind: 'supply_station', x, y, rot: rev(goal.d) });
      this.occ[goal.k] = BLOCKED;
      last = { k: goal.k, kind: 'supply', item, next: [], prev: [], up: new Set(), down: downSet, din: goal.d };
      this.net.set(goal.k, last);
    } else if (goal.type === 'newChest') {
      const [x, y] = this.xy(goal.k);
      this.placed.set(goal.k, { kind: 'chest', x, y, stock: [], filters: {}, role: 'output' });
      this.addChestAt(goal.k);
      last = { k: goal.k, kind: 'chest', item, next: [], prev: [], up: new Set(), down: downSet, din: -1 };
      this.net.set(goal.k, last);
    }

    // Link the chain and record up/down sets.
    const chain = [prev, ...nodes, last];
    for (const nd of nodes) {
      nd.next = [];
      nd.prev = [];
      nd.up = new Set(upSet);
      nd.down = new Set(downSet);
      this.net.set(nd.k, nd);
    }
    for (let i = 0; i + 1 < chain.length; i++) {
      chain[i].next.push(chain[i + 1]);
      chain[i + 1].prev.push(chain[i]);
    }
    // Everything upstream of the start now also leads to this consumer, and
    // everything downstream of the end is now also fed by this source.
    /**
     * @param {NetNode} from
     * @param {'up' | 'down'} key
     * @param {Set<string>} values
     * @param {'prev' | 'next'} dir
     */
    const spread = (from, key, values, dir) => {
      const stack = [from];
      /** @type {Set<NetNode>} */
      const seen = new Set();
      while (stack.length) {
        const nd = stack.pop();
        if (!nd || seen.has(nd)) continue;
        seen.add(nd);
        for (const v of values) nd[key].add(v);
        stack.push(...nd[dir]);
      }
    };
    spread(prev, 'down', downSet, 'prev');
    spread(last, 'up', upSet, 'next');
  }

  // ---- start and target helpers ---------------------------------------------

  // Arrivals from which a new branch of `item` fed by `src` can start.
  /**
   * @param {string} item
   * @param {string} src
   * @returns {RouteStart[]}
   */
  branchStarts(item, src) {
    /** @type {RouteStart[]} */
    const out = [];
    // Leave a chest hub at k from each free side other than the ones items come in and go out on.
    /** @param {number} k @param {number} din @param {number} rot @param {number} cost */
    const hubStarts = (k, din, rot, cost) => {
      for (let side = 0; side < 4; side++) {
        if (side === rev(din) || side === rot) continue;
        const s = this.step(k, side);
        if (s >= 0 && this.occ[s] === FREE && this.reserved[s] === -1) {
          out.push({ k: s, d: side, cost, straight: true, origin: { type: 'hub', k } });
        }
      }
    };
    for (const nd of this.net.values()) {
      if (nd.item !== item || !nd.up.has(src)) continue;
      // A belt in front of a distributor stays a belt (no splitter or hub there).
      if (nd.kind === 'belt' && nd.prev.length === 1 && this.gap[nd.k] === -1 && this.distFront[nd.k] === -1) {
        if (nd.din !== nd.rot) {
          // Splitter at a turn: one side keeps the line, the other starts the branch.
          const side = (nd.din + 1) % 4 === nd.rot ? (nd.din + 3) % 4 : (nd.din + 1) % 4;
          out.push({ k: this.step(nd.k, side), d: side, cost: COST.splitter, origin: { type: 'splitter', k: nd.k } });
        }
        // Or a chest hub, at a turn or on a straight: the line carries on out of the side it
        // already left by (a chest only outputs onto a belt, so the next piece must be one,
        // or an underground's entry), the branch leaves from another side. Never against a
        // station input: chests can't feed stations.
        const next = nd.next.length === 1 ? nd.next[0] : null;
        const feedsBelt = next?.kind === 'belt' || (next?.kind === 'underground' && next.rot === nd.rot);
        if (this.reserved[nd.k] === -1 && !(this.noChest[nd.k] & NO_CHEST_INPUT) && feedsBelt) hubStarts(nd.k, nd.din, nd.rot, COST.hub);
      } else if (nd.kind === 'pass' && nd.prev.length === 1) {
        // A chest in the line: filter another side to the item and it's a hub.
        hubStarts(nd.k, nd.din, nd.rot, COST.passHub);
      } else if (nd.kind === 'chest' && nd.prev.length) {
        // An output chest the source already fills: a belt leaving it takes items out too.
        for (let side = 0; side < 4; side++) {
          const s = this.step(nd.k, side);
          if (s >= 0 && this.occ[s] === FREE && this.reserved[s] === -1) {
            out.push({ k: s, d: side, cost: COST.passHub, straight: true, origin: { type: 'existingHub', k: nd.k } });
          }
        }
      } else if (nd.kind === 'hub') {
        for (let side = 0; side < 4; side++) {
          const s = this.step(nd.k, side);
          if (s >= 0 && this.occ[s] === FREE && this.reserved[s] === -1) {
            out.push({ k: s, d: side, cost: 0, straight: true, exemptFrom: nd.k, origin: { type: 'existingHub', k: nd.k } });
          }
        }
      }
    }
    return out;
  }

  // A belt takes at most this many stations (distributors and supply chests don't count).
  // Whether the route from `src` may still merge into belt cell `nd`.
  /** @param {NetNode} nd @param {string} src */
  canMergeInto(nd, src) {
    const stations = new Set([src, ...nd.up]);
    for (const id of stations) if (id === 'chest' || id.startsWith('dist:')) stations.delete(id);
    return stations.size <= MAX_STATIONS_PER_BELT;
  }

  // Belt cells the route may merge into from the side: lines leading only to `sink`.
  /**
   * @param {string} item
   * @param {string} sink
   * @param {string} src
   * @param {Map<number, RouteTarget>} targets
   */
  mergeTargets(item, sink, src, targets) {
    for (const nd of this.net.values()) {
      if (nd.item !== item || nd.kind !== 'belt' || nd.prev.length !== 1 || nd.down.size !== 1 || !nd.down.has(sink) || !this.canMergeInto(nd, src)) continue;
      const mask = (1 << ((nd.rot + 1) % 4)) | (1 << ((nd.rot + 3) % 4));
      targets.set(nd.k, { mask, end: { type: 'merge' } });
    }
  }

  // Belt cells that only lead to supply stations: any "Supply: ..." item may merge
  // into them from the side, since a supply station takes whatever arrives.
  /**
   * @param {Set<string>} supplySinks
   * @param {string} src
   * @param {Map<number, RouteTarget>} targets
   */
  mergeSupplyTargets(supplySinks, src, targets) {
    for (const nd of this.net.values()) {
      if (nd.kind !== 'belt' || nd.prev.length !== 1 || !nd.down.size || targets.has(nd.k) || !this.canMergeInto(nd, src)) continue;
      if (![...nd.down].every((s) => supplySinks.has(s))) continue;
      const mask = (1 << ((nd.rot + 1) % 4)) | (1 << ((nd.rot + 3) % 4));
      targets.set(nd.k, { mask, end: { type: 'merge' } });
    }
  }

  // A chest already collecting for `sink`: arrive from any free side.
  /** @param {number} k @param {Map<number, RouteTarget>} targets */
  chestTarget(k, targets) {
    let mask = 0;
    for (let d = 0; d < 4; d++) {
      const from = this.step(k, rev(d));
      if (from >= 0 && this.occ[from] === FREE && this.reserved[from] === -1) mask |= 1 << d;
    }
    if (mask) targets.set(k, { mask, end: { type: 'chest' } });
  }

  // Free cells near `k` where a hand-stocked chest could feed a belt.
  /**
   * @param {string} item
   * @param {number} near
   * @param {number} radius
   * @returns {RouteStart[]}
   */
  chestStarts(item, near, radius) {
    /** @type {RouteStart[]} */
    const out = [];
    const [cx, cy] = this.xy(near);
    for (let y = Math.max(0, cy - radius); y <= Math.min(this.H - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(this.W - 1, cx + radius); x++) {
        const q = this.key(x, y);
        if (Math.abs(x - cx) + Math.abs(y - cy) > radius || !this.chestOk(q, null, new Set(), true)) continue;
        for (let d = 0; d < 4; d++) {
          const s = this.step(q, d);
          if (s >= 0 && this.occ[s] === FREE) {
            out.push({ k: s, d, cost: COST.chest, straight: true, origin: { type: 'newChest', k: q } });
          }
        }
      }
    }
    return out;
  }
}

class MinHeap {
  constructor() {
    /** @type {number[]} */ this.keys = [];
    /** @type {number[]} */ this.vals = [];
  }
  get size() { return this.keys.length; }
  peekKey() { return this.keys[0]; }
  /** @param {number} key @param {number} val */
  push(key, val) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key); vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p]; vals[i] = vals[p];
      i = p;
    }
    keys[i] = key; vals[i] = val;
  }
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const key = keys.pop(), val = vals.pop();
    if (keys.length) {
      let i = 0;
      const n = keys.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; vals[i] = vals[c];
        i = c;
      }
      keys[i] = key; vals[i] = val;
    }
    return top;
  }
}
