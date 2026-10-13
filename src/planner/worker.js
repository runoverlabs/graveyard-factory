// @ts-check
// Web Worker running the layout search off the main thread.
// in:  { type: 'start', layout, production, options: { timeMs, seed }, initial? } | { type: 'stop' }
// out: { type: 'progress', evaluations, elapsed, score, failed, result? } | { type: 'done', result }

import { Layout } from '../model.js';
import { Planner } from './planner.js';
import { GeneticPlanner } from './genetic.js';

/** @typedef {import('../types.js').ProductionPlan} ProductionPlan */
/** @typedef {import('../model.js').LayoutJSON} LayoutJSON */
/** @typedef {import('./planner.js').Placement} Placement */
/** @typedef {import('./planner.js').PlannerOptions} PlannerOptions */
/** @typedef {import('./planner.js').PlanResult} PlanResult */

// Message shapes, shared with panel.js.
/** @typedef {{ type: 'start', layout: LayoutJSON, production: ProductionPlan, options: PlannerOptions, initial?: Placement[] | null }} WorkerStart */
/** @typedef {WorkerStart | { type: 'stop' }} WorkerIn */
/** @typedef {{ type: 'progress', evaluations: number, elapsed: number, score: number, failed: number, result?: PlanResult }} WorkerProgress */
/** @typedef {WorkerProgress | { type: 'done', result: PlanResult }} WorkerOut */
// The project's lib is dom, so describe the bits of the worker scope used here.
/** @typedef {{ onmessage: (ev: MessageEvent<WorkerIn>) => void, postMessage: (msg: WorkerOut) => void }} WorkerScope */

let stop = false;

/** @type {WorkerScope} */ (/** @type {unknown} */ (self)).onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'stop') stop = true;
  else if (msg.type === 'start') run(msg);
};

/** @param {WorkerStart} msg */
function run({ layout, production, options, initial }) {
  stop = false;
  const planner = options.algorithm === 'sa' ? new Planner(Layout.fromJSON(layout), production, options) : new GeneticPlanner(Layout.fromJSON(layout), production, options);
  const t0 = performance.now();
  const budget = options.timeMs ?? 20000;
  planner.init(initial);
  let sentScore = Infinity, sentAt = 0;
  const tick = () => {
    const elapsed = performance.now() - t0;
    if (stop || elapsed >= budget) {
      /** @type {WorkerScope} */ (/** @type {unknown} */ (self)).postMessage({ type: 'done', result: planner.result() });
      return;
    }
    // Work in ~60 ms slices so 'stop' messages get through.
    const until = performance.now() + 60;
    while (performance.now() < until) planner.step(5, elapsed / budget);
    const best = planner.best;
    /** @type {WorkerProgress} */
    const msg = { type: 'progress', evaluations: planner.evaluations, elapsed, score: best.score, failed: best.failed };
    // Send the layout itself only when it improved, at most a few times a second.
    if (best.score < sentScore && performance.now() - sentAt > 400) {
      msg.result = planner.result();
      sentScore = best.score;
      sentAt = performance.now();
    }
    /** @type {WorkerScope} */ (/** @type {unknown} */ (self)).postMessage(msg);
    setTimeout(tick, 0);
  };
  tick();
}
