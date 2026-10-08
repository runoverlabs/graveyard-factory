// @ts-check
// Planner side panel: targets, options, production summary, and running the
// layout search with a live preview on the canvas.

import { STATIONS, ROMAN, ITEM_BY_ID, RECIPES, ITEMS, POWER_ICON, ZOMBIE_POWER, CELLAR_ITEMS, GARDEN_ITEMS } from '../catalog.js';
import { planProduction, recipesProducing } from './production.js';
import { applyResult } from './planner.js';
import { t, getLanguage } from '../i18n.js';

/** @typedef {import('../types.js').Item} Item */
/** @typedef {import('../types.js').StationType} StationType */
/** @typedef {import('../types.js').StationDef} StationDef */
/** @typedef {import('../editor.js').Editor} Editor */
/** @typedef {import('./planner.js').PlanResult} PlanResult */
/** @typedef {import('./planner.js').Failure} Failure */
/** @typedef {import('./worker.js').WorkerStart} WorkerStart */
/** @typedef {import('./worker.js').WorkerOut} WorkerOut */
/** Latest progress report; `done` once the search has finished. @typedef {{ iterations: number, elapsed: number, done?: boolean }} Progress */
/** Attributes for `h()`; values are stringified by setAttribute. @typedef {Record<string, string | number>} Attrs */

const TIME_CHOICES = [10, 30, 60, 180, 600];
/** @type {import('../model.js').PlannerSettings} */
const DEFAULT_SETTINGS = { targets: [], timeSec: 30, maxLevel: {}, recipeChoice: {} };

// Items a target can be: anything a factory recipe makes.
const TARGET_ITEMS = ITEMS.filter((p) => RECIPES.some((r) => p.id in r.outputs));

export class PlannerPanel {
  /**
   * @param {Editor} editor
   * @param {HTMLElement} el
   */
  constructor(editor, el) {
    this.editor = editor;
    this.el = el;
    /** @type {Worker | null} */
    this.worker = null;
    this.running = false;
    /** @type {Progress | null} */
    this.progress = null;
    /** @type {PlanResult | null} */
    this.result = null;
    this.render();
  }

  get settings() {
    const l = this.editor.layout;
    l.planner = { ...DEFAULT_SETTINGS, ...l.planner };
    return l.planner;
  }

  /** @param {Partial<import('../model.js').PlannerSettings>} patch */
  update(patch) {
    Object.assign(this.settings, patch);
    this.editor.save();
    this.render();
  }

  // Base layout to plan on: everything except previous planner output.
  baseLayout() {
    const base = this.editor.layout.clone();
    for (const e of base.entities.filter((x) => x.planned)) base.remove(e.id);
    for (const e of base.entities) if (e.garden) { e.material = ''; delete e.autoMaterial; }
    return base;
  }

  production() {
    const s = this.settings;
    // The planner sets every garden distributor's crop itself.
    const distributors = new Set(this.editor.layout.entities.flatMap((e) => e.garden ? GARDEN_ITEMS : e.kind === 'distributor' ? [e.material] : e.kind === 'cellar' ? CELLAR_ITEMS : []));
    return planProduction(s.targets, { maxLevel: s.maxLevel, recipeChoice: s.recipeChoice, distributors });
  }

  // ---- running --------------------------------------------------------------

  // Search for a layout; `resume` continues from the current best one.
  /** @param {boolean} [resume] */
  start(resume = false) {
    const production = this.production();
    if (!production.stations) return;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    const initial = resume ? this.result?.placements : null;
    if (!resume) this.result = null;
    this.progress = { iterations: 0, elapsed: 0 };
    this.running = true;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => { this.running = false; this.editor.status(t('planner.failed', { message: ev.message }), true); this.render(); };
    this.worker.postMessage(/** @type {WorkerStart} */ ({
      type: 'start',
      layout: this.baseLayout().toJSON(),
      production,
      options: { timeMs: this.settings.timeSec * 1000, seed: Math.floor(Math.random() * 1e9) },
      initial,
    }));
    this.render();
  }

  stop() {
    if (this.worker && this.running) this.worker.postMessage({ type: 'stop' });
  }

  /** @param {WorkerOut} msg */
  onMessage(msg) {
    this.progress = msg.type === 'progress' ? msg : { ...this.progress, done: true };
    if (!msg.result && msg.type === 'progress') { this.renderProgress(); return; }
    if (msg.result) {
      this.result = msg.result;
      this.editor.setPreview(this.previewLayout());
    }
    if (msg.type === 'done') {
      this.running = false;
      this.worker.terminate();
      this.worker = null;
    }
    this.render();
  }

  previewLayout() {
    const l = this.baseLayout();
    applyResult(l, this.result);
    return l;
  }

  apply() {
    if (!this.result) return;
    const entities = this.result.entities;
    this.editor.setPreview(null);
    this.editor.mutate(() => {
      for (const e of this.editor.layout.entities.filter((x) => x.planned)) this.editor.layout.remove(e.id);
      this.editor.layout.clearAutoMaterials();
      applyResult(this.editor.layout, this.result);
    });
    this.editor.status(t('planner.applied', { n: entities.length }));
    this.result = null;
    this.progress = null;
    this.render();
  }

  discard() {
    this.stop();
    this.editor.setPreview(null);
    this.result = null;
    this.progress = null;
    this.render();
  }

  // ---- UI -------------------------------------------------------------------

  render() {
    const s = this.settings;
    const prod = this.production();
    const el = this.el;
    el.replaceChildren();
    el.append(h('h2', {}, t('planner.title')));

    // Targets.
    const list = h('div', { class: 'targets' });
    s.targets.forEach((target, i) => {
      const sel = itemSelect(target.item, target.recipe, (item, recipe) => {
        s.targets[i] = { item, rate: target.rate, ...(recipe ? { recipe } : {}) };
        this.update({});
      });
      const rate = h('input', { type: 'number', min: 0, step: 0.5, value: target.rate, title: t('planner.rateTitle') });
      rate.addEventListener('change', () => { s.targets[i] = { ...target, rate: Math.max(0, parseFloat(rate.value) || 0) }; this.update({}); });
      const del = h('button', { type: 'button', title: t('action.remove') }, '×');
      del.addEventListener('click', () => { s.targets.splice(i, 1); this.update({}); });
      list.append(h('div', { class: 'target' }, sel, rate, h('span', { class: 'unit' }, t('planner.perMinute', { n: '' })), del));
    });
    const add = h('button', { type: 'button' }, t('planner.addTarget'));
    add.addEventListener('click', () => { s.targets.push({ item: TARGET_ITEMS[0].id, rate: 1 }); this.update({}); });
    el.append(h('h3', {}, t('planner.finalOutputs')), list, add);
    if (!s.targets.length) el.append(h('p', { class: 'hint' }, t('planner.targetsHint')));

    // Options.
    const time = selectEl(TIME_CHOICES.map((t) => [t, `${t} s`]), s.timeSec, (v) => this.update({ timeSec: +v }));
    el.append(h('h3', {}, t('planner.options')), field(t('planner.searchTime'), time));
    for (const [type, def] of /** @type {[StationType, StationDef][]} */ (Object.entries(STATIONS))) {
      const max = s.maxLevel[type] ?? Math.max(...def.levels);
      el.append(field(t('planner.upTo', { name: def.name }), selectEl(def.levels.map((l) => [l, ROMAN[l]]), max,
        (v) => this.update({ maxLevel: { ...s.maxLevel, [type]: +v } }))));
    }
    // Recipe choice where the plan uses an item with alternatives.
    for (const r of prod.recipes) {
      const alts = recipesProducing(r.item);
      if (alts.length < 2 || CROP_VARIANTS.some((v) => v.item.id === r.item)) continue; // those are picked in the target list
      /** @type {[string, string][]} */
      const opts = alts.map((a) => [a.id, Object.keys(a.inputs).map((i) => ITEM_BY_ID[i]?.name ?? i).join(' + ')]);
      el.append(field(ITEM_BY_ID[r.item].name, selectEl(opts, r.recipe,
        (v) => this.update({ recipeChoice: { ...s.recipeChoice, [r.item]: v } }))));
    }

    // Production summary.
    if (prod.recipes.length) {
      const rows = prod.recipes.map((r) => h('tr', {},
        h('td', { class: 'num' }, `${r.stations}×`),
        h('td', {}, `${STATIONS[r.station].name} ${ROMAN[r.level] ?? '?'}`),
        h('td', {}, itemLabel(r.item)),
        h('td', { class: 'num' }, t('planner.perMinute', { n: fmt(r.output) }))));
      const sup = Object.entries(prod.supply).map(([item, v]) => h('tr', {},
        h('td', { class: 'num' }, ''),
        h('td', {}, v.source === 'distributor' ? t('planner.distributor') : t('planner.chest')),
        h('td', {}, itemLabel(item)),
        h('td', { class: 'num' }, t('planner.perMinute', { n: fmt(v.rate) }))));
      el.append(h('h3', {}, t('planner.production', { n: prod.stations })),
        h('table', { class: 'prod' }, h('tbody', {}, ...rows)),
        h('h3', {}, t('planner.supply')),
        h('table', { class: 'prod' }, h('tbody', {}, ...sup)));
    }
    for (const e of prod.errors) el.append(h('p', { class: 'error' }, e));

    // Run.
    const actions = h('div', { class: 'row-actions' });
    if (this.running) {
      const stop = h('button', { type: 'button' }, t('planner.stop'));
      stop.addEventListener('click', () => this.stop());
      actions.append(stop);
    } else {
      const go = h('button', { type: 'button', class: this.result ? '' : 'primary' }, this.result ? t('planner.newSearch') : t('planner.generate'));
      go.disabled = !prod.stations || prod.errors.length > 0;
      go.addEventListener('click', () => this.start());
      actions.append(go);
      if (this.result) {
        const more = h('button', { type: 'button', class: 'primary', title: t('planner.continueTitle') }, t('planner.continue'));
        more.addEventListener('click', () => this.start(true));
        actions.append(more);
      }
    }
    if (this.result) {
      const apply = h('button', { type: 'button' }, t('planner.apply'));
      apply.addEventListener('click', () => this.apply());
      const discard = h('button', { type: 'button' }, t('planner.discard'));
      discard.addEventListener('click', () => this.discard());
      actions.append(apply, discard);
    }
    el.append(actions);
    this.progressEl = h('div', { class: 'progress' });
    el.append(this.progressEl);
    this.renderProgress();
  }

  renderProgress() {
    const el = this.progressEl;
    if (!el) return;
    el.replaceChildren();
    if (this.progress) {
      const p = this.progress;
      const r = this.result;
      const lines = [t('planner.progress', { state: t(this.running ? 'planner.searching' : 'planner.done'), seconds: (p.elapsed / 1000).toFixed(1), n: p.iterations })];
      if (r) {
        const st = r.stats;
        const parts = [t('count.stations', { n: st.stations }), t('count.belts', { n: st.belts }), t('count.undergrounds', { n: st.undergrounds }),
          t('count.splitters', { n: st.splitters }), t('count.chests', { n: st.chests })];
        if (st.supplyStations) parts.push(t('count.supplyStations', { n: st.supplyStations }));
        lines.push(t('planner.best', { list: parts.join(t('list.separator')) }));
        lines.push(r.failures.length ? t('planner.unrouted', { n: r.failures.length }) : t('planner.allRouted'));
      }
      el.append(...lines.map((t, i) => h('p', { class: i === 2 && r?.failures.length ? 'error' : 'hint' }, t)));
      if (r) {
        const st = r.stats;
        const over = st.over ? ` · ${t('planner.overMax', { n: st.over })}` : '';
        el.append(h('p', { class: over ? 'error power' : 'hint power', title: t('planner.powerTitle', { carousels: ZOMBIE_POWER.carousels }) },
          h('img', { src: POWER_ICON, alt: '' }), `${t('stats.power')}: ${st.power} / ${st.available} · ${t('count.zombies', { n: st.zombies })}${over}`));
      }
      if (r?.failures.length) {
        el.append(h('ul', { class: 'failures' }, ...r.failures.slice(0, 8).map((f) => h('li', {}, describeFailure(f)))));
      }
    }
  }
}

/** @param {Failure} f */
function describeFailure(f) {
  if (f.reason === 'no room') return t('failure.noRoom', { n: f.station + 1 });
  const name = ITEM_BY_ID[f.item]?.name ?? f.item;
  return `${name}: ${t(f.from.startsWith('dist:') ? 'failure.distributor' : f.from === 'chest' ? 'failure.supplyChest' : 'failure.station')} → ${t(f.to.startsWith('final:') ? 'failure.outputChest' : 'failure.station')}`;
}

/** @param {string} id */
function itemLabel(id) {
  const item = ITEM_BY_ID[id];
  const wrap = h('span', { class: 'item' });
  if (item?.icon) wrap.append(h('img', { src: item.icon, alt: '' }));
  else wrap.append(h('i', { style: `background:${item?.color ?? '#888'}` }));
  wrap.append(item?.name ?? id);
  return wrap;
}

// Items with a recipe for each crop or wine quality (Vegetables, Preserves, Wine) get an entry per recipe
// in the target list: "Supply: Preserves II (Onion ★★★)".
const VARIANT_INPUTS = [...GARDEN_ITEMS, ...CELLAR_ITEMS];
const CROP_VARIANTS = TARGET_ITEMS.map((i) => ({ item: i, recipes: recipesProducing(i.id) }))
  .filter(({ recipes }) => recipes.length > 1 && recipes.every((r) => Object.keys(r.inputs).some((k) => VARIANT_INPUTS.includes(k))));

// The crop or wine a recipe is made from, by name ("Onion ★★★").
/** @param {import('../types.js').Recipe} r */
const cropName = (r) => {
  const id = Object.keys(r.inputs).find((k) => VARIANT_INPUTS.includes(k)) ?? '';
  return ITEM_BY_ID[id]?.name ?? id;
};

/**
 * @param {string} value
 * @param {string | undefined} recipe
 * @param {(item: string, recipe?: string) => void} onChange
 */
function itemSelect(value, recipe, onChange) {
  const byName = (/** @type {Item} */ a, /** @type {Item} */ z) => a.name.localeCompare(z.name, getLanguage());
  const supplies = TARGET_ITEMS.filter((i) => i.id.startsWith('supply_')).sort(byName);
  const others = TARGET_ITEMS.filter((i) => !i.id.startsWith('supply_')).sort(byName);
  const s = h('select');
  for (const [label, items] of /** @type {[string, Item[]][]} */ ([[t('group.townSupplies'), supplies], [t('group.products'), others]])) {
    const g = h('optgroup', { label });
    for (const i of items) {
      const variants = CROP_VARIANTS.find((v) => v.item === i)?.recipes;
      if (!variants) { g.append(h('option', { value: i.id }, i.name)); continue; }
      g.append(h('option', { value: i.id }, t('target.anyCrop', { name: i.name })));
      for (const r of [...variants].sort((a, z) => cropName(a).localeCompare(cropName(z), getLanguage()))) {
        g.append(h('option', { value: `${i.id}|${r.id}` }, t('target.crop', { name: i.name, crop: cropName(r) })));
      }
    }
    s.append(g);
  }
  s.value = recipe ? `${value}|${recipe}` : value;
  s.addEventListener('change', () => { const [item, r] = s.value.split('|'); onChange(item, r); });
  return s;
}

/** @param {number} v */
function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs} [attrs]
 * @param {...(Node | string | null)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, /** @type {string} */ (v));
  el.append(...children.filter((c) => c != null));
  return el;
}

/** @param {string} label @param {Node} control */
function field(label, control) {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}

/**
 * @param {[string | number, string][]} options value, label
 * @param {string | number} value
 * @param {(value: string) => void} onChange
 */
function selectEl(options, value, onChange) {
  const s = h('select');
  for (const [v, text] of options) {
    const o = h('option', { value: v }, text);
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

