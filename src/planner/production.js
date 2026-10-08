// @ts-check
// Production math: turn target outputs (items per minute) into the recipes,
// station counts and material supply needed. Pure, no layout involved.

import { RECIPES, STATIONS, RAW_MATERIALS, ITEM_BY_ID } from '../catalog.js';
import { t } from '../i18n.js';

/** @typedef {import('../types.js').Recipe} Recipe */
/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').ProductionOptions} ProductionOptions */
/** @typedef {import('../types.js').ProductionPlan} ProductionPlan */
/** @typedef {import('../types.js').PlannedRecipe} PlannedRecipe */

// Until real craft times are known every recipe runs at this many crafts per
// minute per station (a recipe's `time` in seconds overrides it).
export const DEFAULT_CRAFTS_PER_MINUTE = 1;
const EPS = 1e-9;

const RAW = new Set(RAW_MATERIALS.map((m) => m.id));

/**
 * @param {string} item
 * @returns {Recipe[]}
 */
export function recipesProducing(item) {
  return RECIPES.filter((r) => item in r.outputs);
}

/**
 * @param {Recipe} recipe
 * @param {ProductionOptions} [options]
 * @returns {number}
 */
export function craftsPerMinute(recipe, options = {}) {
  return options.craftsPerMinute?.[recipe.id] ?? (recipe.time ? 60 / recipe.time : DEFAULT_CRAFTS_PER_MINUTE);
}

// Lowest station level that can run the recipe, capped by the best level the
// player has (options.maxLevel[stationType]); null if none qualifies.
/**
 * @param {Recipe} recipe
 * @param {ProductionOptions} [options]
 * @returns {number | null}
 */
export function stationLevel(recipe, options = {}) {
  const max = options.maxLevel?.[recipe.station] ?? Math.max(...STATIONS[recipe.station].levels);
  const ok = recipe.levels.filter((l) => l <= max);
  return ok.length ? Math.min(...ok) : null;
}

// Recipe used to make `item`: an explicit choice, else the first runnable one,
// preferring recipes that need no hand-stocked ingredients (those with no producer
// and no distributor), then fewer inputs, then fewer items in all.
/**
 * @param {string} item
 * @param {ProductionOptions} [options]
 * @returns {Recipe | null}
 */
export function chooseRecipe(item, options = {}) {
  const choice = options.recipeChoice?.[item];
  const all = recipesProducing(item).filter((r) => stationLevel(r, options) != null);
  if (choice) return all.find((r) => r.id === choice) ?? null;
  const total = (/** @type {Recipe} */ r) => Object.values(r.inputs).reduce((n, q) => n + q, 0);
  const handStocked = (/** @type {Recipe} */ r) => Object.keys(r.inputs).filter((i) => !RAW.has(i) && !recipesProducing(i).length && !options.distributors?.has(i)).length;
  return [...all].sort((a, b) => handStocked(a) - handStocked(b)
    || Object.keys(a.inputs).length - Object.keys(b.inputs).length
    || total(a) - total(b))[0] ?? null;
}

// targets: [{ item, rate }] in items per minute.
// options: { maxLevel, recipeChoice, craftsPerMinute, distributors: Set of
//            items with a distribution station or the cellar in the layout }
/**
 * @param {Target[]} targets
 * @param {ProductionOptions} [options]
 * @returns {ProductionPlan}
 */
export function planProduction(targets, options = {}) {
  // A target can name the recipe it's made with.
  const chosen = targets.filter((t) => t.recipe);
  if (chosen.length) options = { ...options, recipeChoice: { ...options.recipeChoice, ...Object.fromEntries(chosen.map((t) => [t.item, t.recipe])) } };
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, number>} */
  const final = new Map();
  for (const t of targets) {
    if (!(t.rate > 0) || !ITEM_BY_ID[t.item]) continue;
    final.set(t.item, (final.get(t.item) ?? 0) + t.rate);
  }

  // Depth-first order over the chosen recipes: producers before consumers.
  /** @type {Map<string, Recipe | null>} */
  const recipeOf = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, number>} 1 = visiting, 2 = done */
  const state = new Map();
  /** @param {string} item */
  const visit = (item) => {
    if (state.get(item) === 2) return;
    if (state.get(item) === 1) { errors.push(t('production.cycle', { item: ITEM_BY_ID[item]?.name ?? item })); return; }
    state.set(item, 1);
    const recipe = RAW.has(item) ? null : chooseRecipe(item, options);
    recipeOf.set(item, recipe);
    if (!recipe && !RAW.has(item) && recipesProducing(item).length) {
      errors.push(t('production.noLevel', { item: ITEM_BY_ID[item]?.name ?? item }));
    }
    if (recipe) for (const ing of Object.keys(recipe.inputs)) visit(ing);
    state.set(item, 2);
    order.push(item);
  };
  for (const item of final.keys()) visit(item);

  // Walk consumers first so each item's full demand is known before it is expanded.
  const demand = new Map(final);
  /** @type {PlannedRecipe[]} */
  const recipes = [];
  for (const item of [...order].reverse()) {
    const rate = demand.get(item) ?? 0;
    const recipe = recipeOf.get(item);
    if (!recipe || rate <= EPS) continue;
    const perCraft = recipe.outputs[item];
    const crafts = rate / perCraft;
    const cpm = craftsPerMinute(recipe, options);
    /** @type {Record<string, number>} */
    const inputs = {};
    for (const [ing, qty] of Object.entries(recipe.inputs)) {
      inputs[ing] = crafts * qty;
      demand.set(ing, (demand.get(ing) ?? 0) + crafts * qty);
    }
    recipes.push({
      recipe: recipe.id, item, station: recipe.station, level: stationLevel(recipe, options),
      crafts, craftsPerStation: cpm, stations: Math.ceil(crafts / cpm - EPS),
      output: rate, inputs,
    });
  }

  // Everything without a recipe is supplied: raw materials from distribution
  // stations and beer and wine from the cellar when the layout has them (or
  // every raw material, if not given), the rest from hand-stocked chests.
  /** @type {ProductionPlan['supply']} */
  const supply = {};
  for (const item of order) {
    if (recipeOf.get(item)) continue;
    const rate = demand.get(item) ?? 0;
    if (rate <= EPS) continue;
    const source = (options.distributors ? options.distributors.has(item) : RAW.has(item)) ? 'distributor' : 'chest';
    supply[item] = { rate, source };
  }

  return {
    final: Object.fromEntries(final),
    recipes: recipes.reverse(), // producers first
    supply,
    stations: recipes.reduce((n, r) => n + r.stations, 0),
    errors,
  };
}
