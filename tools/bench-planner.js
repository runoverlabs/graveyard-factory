// Planner benchmark: runs each layout search on a fixed set of plans over
// several seeds, in parallel worker threads, and reports how often everything
// routes, unrouted connections, cost, power and how soon the first fully routed
// layout turns up. Not part of the app.
//   npm run bench -- [--evals n | --iterations n | --time ms] [--seeds 10 | 1,5,9 | 3-12]
//                    [--plans id,id] [--algos sa,ga (default)] [--jobs n] [--options '{"gap":2}']
//                    [--out results.json] [--compare before.json] [--list]
// The default budget is 3000 evaluations (full routings of a placement) per
// run: the same work for every search and every machine, and with a fixed seed
// the same result. --iterations counts the search's own steps (SA also counts
// moves rejected before routing). --time is what the app does, but threads
// compete for the machine (one 10 s run of "iron" got through 9700 SA
// iterations alone and 2600 next to 14 others), so only compare time runs made
// with the same --jobs on the same machine.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { Layout, REPAIRABLE_SECTIONS } from '../src/model.js';
import { factoryFloor } from '../src/floor.js';
import { RECIPES, CELLAR_ITEMS, GARDEN_ITEMS } from '../src/catalog.js';
import { planProduction } from '../src/planner/production.js';
import { Planner, applyResult } from '../src/planner/planner.js';
import { GeneticPlanner } from '../src/planner/genetic.js';

// Every search runs through the same interface as worker.js uses:
// init(), step(n, progress), best { score, failed }, iterations, result(),
// and scores placements with evaluate(), which the harness counts.
const ALGORITHMS = {
  sa: (layout, production, options) => new Planner(layout, production, options),
  ga: (layout, production, options) => new GeneticPlanner(layout, production, options),
};

// Floors the plans run on: the user's real floor and the fully repaired one
// (garden distributors and the cellar included).
const FLOORS = {
  real: () => Layout.fromJSON(fs.readFileSync(new URL('../factory.json', import.meta.url), 'utf8')),
  repaired: () => factoryFloor(REPAIRABLE_SECTIONS),
};

// The suite: small to large, chosen to cover hand-stocked inputs, production
// lines with no station in common, shared distributors, "Supply: ..." outputs
// and the 2x3 Bioreactor (appliances and clothes: many hand-stocked inputs). All at 1 of each target per minute.
const PLANS = [
  { id: 'engineering_kit', floor: 'real', targets: ['engineering_kit'] },
  { id: 'wood+iron_kits', floor: 'real', targets: ['wooden_kit_1', 'iron_kit_1'] },
  { id: 'iron_tools', floor: 'real', targets: ['supply_iron_tools'] },
  { id: 'iron', floor: 'real', targets: ['supply_iron'] },
  { id: 'eng_mechanism', floor: 'repaired', targets: ['supply_engineering_mechanism'] },
  { id: 'appliances', floor: 'real', targets: ['supply_appliances_1'] },
  { id: 'iron+cutlery', floor: 'real', targets: ['supply_iron', 'supply_cutlery_1'] },
  { id: 'clothes', floor: 'real', targets: ['supply_clothes_1'] },
  { id: 'furniture+iron', floor: 'real', targets: ['supply_furniture_1', 'supply_iron'] },
  { id: 'iron+cutlery+furniture', floor: 'real', targets: ['supply_iron', 'supply_cutlery_1', 'supply_furniture_1'] },
  // Ten kits at the game's craft times, as a user ran them in the app.
  ...['real', 'repaired'].map((floor) => ({ id: `kits_${floor}`, floor, gameTimes: true, targets: ['building_kit_1', 'building_kit_2', 'engineering_kit', 'furniture_kit_1', 'furniture_kit_2', 'glass_containers', 'marble_kit', 'sculpture_kit_1', 'sculpture_kit_2', 'tableware'] })),
];

// Recipes pinned to 1 craft per minute, as in the planner tests, so the plans
// (and the numbers) don't move when the game's craft times change; plans with
// `gameTimes` use the game's.
const ONE_PER_MINUTE = Object.fromEntries(RECIPES.map((r) => [r.id, 1]));

// Base layout and production for a plan, the way the planner panel builds them.
function setup(plan) {
  const layout = FLOORS[plan.floor]();
  const distributors = new Set(layout.entities.flatMap((e) => e.garden ? GARDEN_ITEMS : e.kind === 'distributor' ? [e.material] : e.kind === 'cellar' ? CELLAR_ITEMS : []));
  const production = planProduction(plan.targets.map((item) => ({ item, rate: 1 })), { distributors, ...(plan.gameTimes ? {} : { craftsPerMinute: ONE_PER_MINUTE }) });
  return { layout, production };
}

// ---- one run (in a worker thread) -------------------------------------------

function run({ plan, algo, seed, budget, options }) {
  const { layout, production } = setup(plan);
  const planner = ALGORITHMS[algo](layout, production, { ...options, seed });
  let evals = 0;
  const evaluate = planner.evaluate;
  planner.evaluate = function (...a) { evals++; return evaluate.apply(this, a); };
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  const progress = () => budget.time ? elapsed() / budget.time
    : budget.iterations ? planner.iterations / budget.iterations
      : evals / budget.evals;
  const at = () => ({ ms: elapsed(), iterations: planner.iterations, evals });
  planner.init();
  let routedAt = planner.best.failed === 0 ? at() : null;
  for (let p = progress(); p < 1; p = progress()) {
    planner.step(budget.time ? 5 : budget.iterations ? Math.min(5, budget.iterations - planner.iterations) : 1, p);
    if (!routedAt && planner.best.failed === 0) routedAt = at();
  }
  const ms = elapsed(), iterations = planner.iterations, searchEvals = evals;
  const result = planner.result();
  // Layout rule problems in the result, as the planner tests check them (power
  // over the maximum is the plan's size, not a broken rule).
  const out = layout.clone();
  applyResult(out, result);
  const issues = out.validate().filter((i) => i.severity !== 'info' && !/over the factory/.test(i.message)).map((i) => i.message);
  const s = result.stats;
  return {
    plan: plan.id, algo, seed, failed: result.failures.length, score: result.score,
    stations: s.stations, belts: s.belts, undergrounds: s.undergrounds, splitters: s.splitters, chests: s.chests,
    power: s.power, over: s.over, iterations, evals: searchEvals, ms, routedAt, issues,
    // Why each connection failed: "<why> <branch|first>[+merge]", see Failure in planner.js.
    failures: result.failures.map((f) => f.reason ?? `${f.why} ${f.branch ? 'branch' : 'first'}${f.merge ? '+merge' : ''}`),
  };
}

// ---- command line -----------------------------------------------------------

function parseArgs(argv) {
  // One thread per two logical CPUs: SMT siblings slow each other down.
  const args = { seeds: '10', jobs: Math.max(1, os.availableParallelism() >> 1) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') { args.list = true; continue; }
    if (!a.startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument: ${a}`);
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

function parseSeeds(spec) {
  if (/^\d+$/.test(spec)) return Array.from({ length: +spec }, (_, i) => i + 1);
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) return Array.from({ length: +range[2] - +range[1] + 1 }, (_, i) => +range[1] + i);
  return spec.split(',').map(Number);
}

function pick(spec, all, what) {
  if (!spec) return all;
  const ids = spec.split(',');
  for (const id of ids) if (!all.some((x) => x.id === id)) throw new Error(`unknown ${what}: ${id} (have ${all.map((x) => x.id).join(', ')})`);
  return all.filter((x) => ids.includes(x.id));
}

function gitVersion() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim() !== '';
    return head + (dirty ? '+dirty' : '');
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const p of PLANS) {
      const { production } = setup(p);
      console.log(`${p.id.padEnd(24)} ${String(production.stations).padStart(3)} stations  ${p.floor.padEnd(8)}  ${p.targets.join(' + ')}`);
    }
    return;
  }
  const kinds = ['evals', 'iterations', 'time'].filter((k) => args[k]);
  if (kinds.length > 1) throw new Error('give one of --evals, --iterations, --time');
  const budget = kinds.length ? { [kinds[0]]: +args[kinds[0]] } : { evals: 3000 };
  const plans = pick(args.plans, PLANS, 'plan');
  const algos = pick(args.algos ?? 'sa,ga', Object.keys(ALGORITHMS).map((id) => ({ id })), 'algorithm').map((a) => a.id);
  const seeds = parseSeeds(args.seeds);
  // Planner options for every run (PlannerOptions), to try a setting without editing code.
  const options = args.options ? JSON.parse(args.options) : {};
  const jobs = [];
  for (const plan of plans) for (const algo of algos) for (const seed of seeds) jobs.push({ plan, algo, seed, budget, options });
  const threads = Math.min(+args.jobs, jobs.length);
  const meta = {
    date: new Date().toISOString(), commit: gitVersion(), budget, seeds, jobs: threads, options,
    node: process.version, cpu: os.cpus()[0]?.model, cpus: os.availableParallelism(),
  };
  console.error(`${jobs.length} runs (${plans.length} plans × ${algos.length} algorithms × ${seeds.length} seeds), ${Object.entries(budget).map(([k, v]) => k === 'time' ? `${v} ms` : `${v} ${k}`)} each, ${threads} threads`);

  const runs = await runAll(jobs, threads);
  const report = { meta, runs };
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
    console.error(`wrote ${args.out}`);
  }
  printTable(summarize(runs), plans.map((p) => p.id), algos);
  printFailures(runs, plans.map((p) => p.id), algos);
  if (args.compare) compare(report, JSON.parse(fs.readFileSync(args.compare, 'utf8')));
}

// Runs the jobs over a pool of worker threads, longest plans first so the
// pool doesn't end with one big run left alone.
function runAll(jobs, threads) {
  const queue = [...jobs].reverse();
  const runs = [];
  let done = 0, failed = false;
  return new Promise((resolve, reject) => {
    let live = threads;
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL(import.meta.url));
      const next = () => {
        const job = queue.shift();
        if (!job) {
          w.terminate();
          if (--live === 0) failed ? reject(new Error('some runs failed')) : resolve(runs);
          return;
        }
        w.postMessage(job);
      };
      w.on('message', (msg) => {
        if (msg.error) { console.error(`\n${msg.error}`); failed = true; } else runs.push(msg.result);
        ++done;
        if (process.stderr.isTTY) process.stderr.write(`\r${done}/${jobs.length}`);
        next();
      });
      w.on('error', reject);
      next();
    }
  }).finally(() => { if (process.stderr.isTTY) process.stderr.write('\n'); });
}

// ---- report -----------------------------------------------------------------

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Per plan and algorithm. Cost and power are over the fully routed runs only:
// an unrouted connection saves its belts, so mixing them in would flatter
// layouts that fail.
function summarize(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.plan}\t${r.algo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = new Map();
  for (const [key, rs] of groups) {
    const routed = rs.filter((r) => r.failed === 0);
    out.set(key, {
      runs: rs.length,
      routed: routed.length,
      unrouted: mean(rs.map((r) => r.failed)),
      worst: Math.max(...rs.map((r) => r.failed)),
      cost: median(routed.map((r) => r.score)),
      power: mean(routed.map((r) => r.power)),
      routedMs: median(routed.map((r) => r.routedAt.ms)),
      routedEvals: median(routed.map((r) => r.routedAt.evals)),
      iterations: mean(rs.map((r) => r.iterations)),
      evals: mean(rs.map((r) => r.evals)),
      ms: mean(rs.map((r) => r.ms)),
      issues: rs.reduce((n, r) => n + r.issues.length, 0),
      stations: rs[0].stations,
    });
  }
  return out;
}

const fmt = (x, digits = 1) => x == null ? '-' : Number.isInteger(x) ? String(x) : x.toFixed(digits);

function printTable(summary, planIds, algos) {
  const head = ['plan', 'st', 'algo', 'routed', 'unrouted', 'worst', 'cost (med)', 'power', 'routed at', 'evals', 'iters', 'time', 'issues'];
  const rows = [];
  for (const plan of planIds) for (const algo of algos) {
    const s = summary.get(`${plan}\t${algo}`);
    if (!s) continue;
    rows.push([plan, s.stations, algo, `${s.routed}/${s.runs}`, fmt(s.unrouted), s.worst, fmt(s.cost), fmt(s.power), fmt(s.routedEvals, 0), fmt(s.evals, 0), fmt(s.iterations, 0), `${(s.ms / 1000).toFixed(1)} s`, s.issues]);
  }
  printRows(head, rows);
  console.log('routed: runs with every connection routed. unrouted, worst: connections per run. cost, power, routed at (evaluations until');
  console.log('everything first routed): median, mean, median over the routed runs only. evals, iters, time: mean per run. issues: layout rule problems.');
}

// Unrouted connections by cause, summed over the seeds.
function printFailures(runs, planIds, algos) {
  const kinds = [...new Set(runs.flatMap((r) => r.failures))].sort();
  if (!kinds.length) return;
  const rows = [];
  for (const plan of planIds) for (const algo of algos) {
    const rs = runs.filter((r) => r.plan === plan && r.algo === algo);
    const n = (k) => rs.reduce((a, r) => a + r.failures.filter((f) => f === k).length, 0);
    if (rs.some((r) => r.failures.length)) rows.push([plan, '', algo, ...kinds.map(n)]);
  }
  console.log('\nunrouted connections by cause, all seeds (no start / no target / no path; branch: off a line the source already feeds; merge: into a line already reaching the sink)');
  printRows(['plan', '', 'algo', ...kinds], rows);
}

function printRows(head, rows) {
  const all = [head, ...rows].map((r) => r.map(String));
  const width = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => i < 1 || i === 2 ? c.padEnd(width[i]) : c.padStart(width[i])).join('  ');
  console.log(line(all[0]));
  console.log(width.map((w) => '-'.repeat(w)).join('  '));
  for (const r of all.slice(1)) console.log(line(r));
}

// Changes against an earlier report, for the plans and algorithms in both.
function compare(report, base) {
  console.log(`\nagainst ${base.meta.commit ?? '?'} (${base.meta.date})`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(report.meta.budget, base.meta.budget)) console.log(`  note: budget differs: ${JSON.stringify(base.meta.budget)} then`);
  if (report.meta.jobs !== base.meta.jobs) console.log(`  note: ${base.meta.jobs} threads then, ${report.meta.jobs} now`);
  if (!same(report.meta.seeds, base.meta.seeds)) console.log('  note: seeds differ');
  if (!same(report.meta.options ?? {}, base.meta.options ?? {})) console.log(`  note: options ${JSON.stringify(base.meta.options ?? {})} then, ${JSON.stringify(report.meta.options)} now`);
  const now = summarize(report.runs), then = summarize(base.runs);
  const delta = (a, b, digits = 1) => a == null || b == null ? '-' : `${a - b > 0 ? '+' : ''}${(a - b).toFixed(digits)}`;
  const rows = [];
  for (const [key, s] of now) {
    const b = then.get(key);
    if (!b) continue;
    const [plan, algo] = key.split('\t');
    rows.push([plan, s.stations, algo, `${b.routed}/${b.runs} → ${s.routed}/${s.runs}`, delta(s.unrouted, b.unrouted), delta(s.cost, b.cost), delta(s.power, b.power), delta(s.routedEvals, b.routedEvals, 0), `${b.issues} → ${s.issues}`]);
  }
  printRows(['plan', 'st', 'algo', 'routed', 'Δ unrouted', 'Δ cost', 'Δ power', 'Δ routed at', 'issues'], rows);
}

// ---- entry -------------------------------------------------------------------

if (!isMainThread) {
  parentPort.on('message', (job) => {
    try {
      parentPort.postMessage({ result: run(job) });
    } catch (err) {
      parentPort.postMessage({ error: `${job.plan.id}/${job.algo}/${job.seed}: ${err.stack ?? err}` });
    }
  });
} else {
  await main();
}
