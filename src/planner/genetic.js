// @ts-check
// Genetic layout search: the same placements, routing and score as the
// annealing in planner.js, searched by a population instead of a single state.
//
// Steady state: each iteration picks two parents by tournament, crosses them
// over (stations inside a random rectangle come from one parent and the rest
// from the other), mutates the child with the
// annealing's moves, repairs it so every station sits on a valid spot, routes
// it once, and swaps it for the worst individual if it does better. Fewer
// unrouted connections always rank first.

import { stationDims, stationVariants } from '../catalog.js';
import { Planner } from './planner.js';

/** @typedef {import('./planner.js').Placement} Placement */
/** @typedef {import('./planner.js').PlannerOptions} PlannerOptions */
/** @typedef {import('./planner.js').StationInstance} StationInstance */
/** @typedef {import('./planner.js').SearchState} SearchState */
/** @typedef {import('../types.js').ProductionPlan} ProductionPlan */
/** @typedef {import('../model.js').Layout} Layout */

/** @typedef {SearchState & { key: string }} Individual */

/** @param {(Placement | null)[]} placements */
const keyOf = (placements) => placements.map((p) => p ? `${p.x},${p.y},${p.variant},${+p.swap}` : '-').join(';');

export class GeneticPlanner extends Planner {
  /**
   * @param {Layout} layout
   * @param {ProductionPlan} production
   * @param {PlannerOptions} [options]
   */
  constructor(layout, production, options = {}) {
    super(layout, production, options);
    // Tuned on the benchmark's hardest plans (npm run bench).
    this.populationSize = options.population ?? 200;
    this.tournament = options.tournament ?? 3;
    /** @type {Individual[]} */
    this.population = [];
    // Seeding: the placement the copies are mutated from, and how many tries are left.
    /** @type {(Placement | null)[]} */
    this.seed = [];
    this.seedTries = 0;
    // Stations that are interchangeable (same recipe), by recipe.
    /** @type {Map<string, number[]>} */
    this.twins = new Map();
    for (const s of this.stations) this.twins.set(s.recipe, [...(this.twins.get(s.recipe) ?? []), s.idx]);
    /** @type {Record<string, Set<string>>} */
    this.spotSet = {};
    for (const [size, spots] of Object.entries(this.spots)) this.spotSet[size] = new Set(spots.map((p) => `${p.x},${p.y}`));
  }

  // ---- population -----------------------------------------------------------

  // The greedy placement (or `initial`). The rest of the population (copies of
  // it with a few mutations, and random placements) is added by the first
  // steps, so a search can be stopped and report progress while it fills up.
  /**
   * @param {(Placement | null)[] | null} [initial]
   * @returns {SearchState}
   */
  init(initial = null) {
    const first = super.init(initial);
    this.population = [];
    this.best = null;
    this.seed = first.placements;
    this.seedTries = this.populationSize * 4;
    const ind = this._individual(first.placements);
    this._admit(ind);
    return ind;
  }

  // One more individual for a population that isn't full yet; false once it is
  // (or the tries ran out: duplicates are skipped).
  _grow() {
    if (this.population.length >= this.populationSize || this.seedTries <= 0) return false;
    this.seedTries--;
    let placements;
    if (this.population.length < this.populationSize / 2) {
      placements = this.seed;
      for (let m = 1 + Math.floor(this.random() * 5); m > 0; m--) placements = this._mutate(placements);
    } else {
      placements = this._repair(new Array(this.stations.length).fill(null));
    }
    if (!this.population.some((x) => x.key === keyOf(placements))) this._admit(this._individual(placements));
    return true;
  }

  /**
   * @param {(Placement | null)[]} placements
   * @param {{ score: number, failed: number }} [r] its evaluation, if already done
   * @returns {Individual}
   */
  _individual(placements, r = this.evaluate(placements)) {
    return { placements: /** @type {Placement[]} */ (placements), score: r.score, failed: r.failed, key: keyOf(placements) };
  }

  // Fewer unrouted connections first, then the score.
  /** @param {{ failed: number, score: number }} a @param {{ failed: number, score: number }} b */
  _compare(a, b) {
    return a.failed - b.failed || a.score - b.score;
  }

  /** @param {Individual} ind */
  _admit(ind) {
    this.population.push(ind);
    if (!this.best || this._compare(ind, this.best) < 0) this.best = ind;
  }

  // ---- search ---------------------------------------------------------------

  // Callers pass the share of the search time used as well; only the
  // annealing needs it (for its temperature), so it's not declared here.
  /**
   * @param {number} n
   * @returns {SearchState}
   */
  step(n) {
    for (let it = 0; it < n; it++) {
      this.iterations++;
      if (this._grow()) continue;
      const a = this._select(), b = this._select();
      let child = this.random() < (this.options.crossover ?? 0.9) && a !== b ? this._cross(a.placements, b.placements) : a.placements;
      // Always mutate a copy of a parent; otherwise sometimes.
      if (child === a.placements || this.random() < (this.options.mutation ?? 0.5)) child = this._mutate(child);
      this._offer(this._repair(child));
    }
    return this.best;
  }

  // Route a child and let it compete with the worst individual.
  /** @param {(Placement | null)[]} child */
  _offer(child) {
    const key = keyOf(child);
    if (this.population.some((x) => x.key === key)) return;
    let rival = this.population[0];
    for (const x of this.population) if (this._compare(x, rival) > 0) rival = x;
    // A child with more unrouted connections than its rival can't get in: stop routing it there.
    const ind = this._individual(child, this.evaluate(child, false, rival.failed));
    if (this._compare(ind, rival) < 0) {
      this.population[this.population.indexOf(rival)] = ind;
      if (!this.best || this._compare(ind, this.best) < 0) this.best = ind;
    }
  }

  _select() {
    let best = this.population[Math.floor(this.random() * this.population.length)];
    for (let i = 1; i < this.tournament; i++) {
      const o = this.population[Math.floor(this.random() * this.population.length)];
      if (this._compare(o, best) < 0) best = o;
    }
    return best;
  }

  // One of the annealing's moves (move, change layout, swap inputs, swap two stations).
  /** @param {(Placement | null)[]} placements */
  _mutate(placements) {
    for (let t = 0; t < 20; t++) {
      const next = this._neighbour(/** @type {Placement[]} */ (placements));
      if (next) return next;
    }
    return placements;
  }

  // ---- crossover ------------------------------------------------------------

  /**
   * @param {(Placement | null)[]} a
   * @param {(Placement | null)[]} b
   * @returns {(Placement | null)[]}
   */
  _cross(a, b) {
    b = this._align(a, b);
    // Stations whose centre lies inside a random rectangle of the floor come from a.
    const W = this.layout.width, H = this.layout.height;
    const w = W * (0.3 + 0.4 * this.random()), h = H * (0.3 + 0.4 * this.random());
    const x0 = this.random() * (W - w), y0 = this.random() * (H - h);
    /** @param {number} i */
    const fromA = (i) => {
      const p = a[i];
      if (!p) return false;
      const d = stationDims(this.stations[i].type);
      const cx = p.x + d.w / 2, cy = p.y + d.h / 2;
      return cx >= x0 && cx < x0 + w && cy >= y0 && cy < y0 + h;
    };
    return a.map((p, i) => fromA(i) ? p : b[i]);
  }

  // Parent b with its interchangeable stations (same recipe) reordered to match
  // a's nearest ones, so crossover swaps like for like.
  /**
   * @param {(Placement | null)[]} a
   * @param {(Placement | null)[]} b
   */
  _align(a, b) {
    const out = b.slice();
    for (const idx of this.twins.values()) {
      if (idx.length < 2) continue;
      const pairs = [];
      for (const i of idx) for (const j of idx) {
        const pa = a[i], pb = b[j];
        pairs.push({ i, j, d: pa && pb ? Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) : 1e9 });
      }
      pairs.sort((p, q) => p.d - q.d);
      const usedI = new Set(), usedJ = new Set();
      for (const { i, j } of pairs) {
        if (usedI.has(i) || usedJ.has(j)) continue;
        usedI.add(i);
        usedJ.add(j);
        out[i] = b[j];
      }
    }
    return out;
  }

  // ---- repair ---------------------------------------------------------------

  // Place the stations one by one in random order: each keeps its spot if
  // it's still valid, or moves to the nearest valid one.
  /**
   * @param {(Placement | null)[]} placements
   * @returns {(Placement | null)[]}
   */
  _repair(placements) {
    const n = this.stations.length;
    /** @type {(Placement | null)[]} */
    const out = new Array(n).fill(null);
    const order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const i of order) {
      const s = this.stations[i], p = placements[i];
      out[i] = p && this.valid(s, p, out) ? p : this._nearestValid(s, p, out);
    }
    return out;
  }

  // The valid placement nearest p (any spot for a station with none), searching
  // outwards ring by ring, with p's layout and inputs first.
  /**
   * @param {StationInstance} s
   * @param {Placement | null} p
   * @param {(Placement | null)[]} placed
   * @returns {Placement | null}
   */
  _nearestValid(s, p, placed) {
    const d = stationDims(s.type), size = `${d.w}x${d.h}`;
    const spots = this.spots[size], set = this.spotSet[size];
    if (!spots?.length) return null;
    const variants = Object.keys(stationVariants(s.type));
    const start = p ?? { ...spots[Math.floor(this.random() * spots.length)], variant: variants[Math.floor(this.random() * variants.length)], swap: this.random() < 0.5 };
    const tries = [[start.variant, start.swap], ...variants.flatMap((v) => [[v, false], [v, true]])];
    const R = this.layout.width + this.layout.height;
    for (let r = 0; r <= R; r++) {
      for (let dx = -r; dx <= r; dx++) {
        const dy = r - Math.abs(dx);
        for (const y of dy ? [start.y - dy, start.y + dy] : [start.y]) {
          const x = start.x + dx;
          if (!set.has(`${x},${y}`)) continue;
          for (const [variant, swap] of tries) {
            const q = { x, y, variant: /** @type {string} */ (variant), swap: /** @type {boolean} */ (swap) };
            if (this.valid(s, q, placed)) return q;
          }
        }
      }
    }
    return null;
  }
}
