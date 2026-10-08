// @ts-check
// Factory layout model: terrain grid + placed entities.
// UI-independent so the planner can reuse it (also runs under Node for tests).

import {
  DIRS, STATIONS, ENTITY_KINDS, RECIPE_BY_ID, ITEM_BY_ID, EXTENSIONS, CHEST_LEVELS, POWER_COST, ZOMBIE_POWER, stationVariants, defaultVariant,
  BELT_ACCEPTS_FROM_SIDES, UNDERGROUND_GAP_MUST_BE_FLOOR, UNDERGROUND_GAP_KINDS, DISTRIBUTOR_FRONT_KINDS, FACTORY_DISTRIBUTORS, FACTORY_GARDEN_DISTRIBUTORS, GARDEN_ITEMS, portersFor, FACTORY_CELLAR, CELLAR_ITEMS, FLOOR_SECTIONS, FLOOR_GRID, FLOOR_HOLES, entityCells, recipesFor, isSupplyItem,
} from './catalog.js';
import { t } from './i18n.js';

/** @typedef {import('./types.js').Dir} Dir */
/** @typedef {import('./types.js').Entity} Entity */
/** @typedef {import('./types.js').EntitySpec} EntitySpec */
/** @typedef {import('./types.js').StationType} StationType */
/** @typedef {import('./types.js').Terrain} Terrain */
/** @typedef {import('./types.js').PortDef} PortDef */
/** @typedef {import('./types.js').Port} Port */
/** @typedef {import('./types.js').Issue} Issue */
/** @typedef {import('./types.js').Target} Target */
/** @typedef {[number, number]} XY */

/**
 * Planner settings saved with a layout (the planner panel fills in defaults).
 * @typedef {object} PlannerSettings
 * @property {Target[]} [targets]
 * @property {number} [timeSec]
 * @property {Partial<Record<StationType, number>>} [maxLevel]
 * @property {Record<string, string>} [recipeChoice]
 */

/**
 * @typedef {object} LayoutInit
 * @property {string} [name]
 * @property {number} [width]
 * @property {number} [height]
 * @property {Terrain[]} [terrain]
 * @property {Entity[]} [entities]
 * @property {number} [nextId]
 * @property {PlannerSettings} [planner]
 * @property {boolean} [beltMaster] the player has the Belt Master perk
 * @property {number[] | null} [repaired] floor sections repaired; null when the terrain isn't the factory's sections
 */

/**
 * Exported file format. Older files may lack fields, and their entities ids.
 * @typedef {object} LayoutJSON
 * @property {'factory-layout'} [format]
 * @property {number} [version]
 * @property {string} [name]
 * @property {number} [width]
 * @property {number} [height]
 * @property {Record<string, string>} [legend]
 * @property {string[]} terrain ASCII rows
 * @property {EntitySpec[]} [entities]
 * @property {PlannerSettings} [planner]
 * @property {boolean} [beltMaster]
 * @property {number[]} [repaired]
 */

/** @typedef {{ ok: boolean, reason?: string }} PlaceCheck */
/** @typedef {(severity: Issue['severity'], entity: Entity | null, message: string, cells?: XY[]) => void} AddIssue */

// A cell is either factory floor or not. Older files also had walls ('#') and
// columns ('O'); neither could hold pieces, so they load as outside.
export const VOID = ' ', FLOOR = '.';
/** @type {{ id: Terrain, key: string }[]} key is the `terrain.<…>` string naming it */
export const TERRAIN_TYPES = [
  { id: FLOOR, key: 'terrain.floor' },
  { id: VOID, key: 'terrain.void' },
];
/** @type {Record<string, Terrain>} */
const TERRAIN_ALIASES = { '_': VOID, '#': VOID, 'O': VOID, 'o': VOID, '0': VOID };

// Version 2: the factory grid gained 12 rows on top for the floor sections
// that can be repaired, and the floor comes from `repaired`.
export const FORMAT_VERSION = 2;
// Version 1 files of the factory floor were this size; they move down 12 rows.
const V1_FACTORY = { width: 42, height: 43, shift: 12 };

// Floor sections that start disabled and can be repaired in the game.
export const REPAIRABLE_SECTIONS = FLOOR_SECTIONS.filter((s) => s.repair).map((s) => s.id);

export class Layout {
  /** @param {LayoutInit} [init] */
  constructor({ name = 'Untitled factory', width, height, terrain, entities = [], nextId, planner, beltMaster = false, repaired = null } = {}) {
    this.name = name;
    this.beltMaster = beltMaster; // Belt Master perk: more power per zombie
    /** @type {number[] | null} */
    this.repaired = repaired; // repaired floor sections, when the terrain is the factory's (see setRepaired)
    this.planner = planner; // planner settings (targets, options), saved with the layout
    this.width = width;
    this.height = height;
    /** @type {Terrain[]} */
    this.terrain = terrain ?? new Array(width * height).fill(FLOOR);
    /** @type {Entity[]} */
    this.entities = entities.map((e) => ({ ...e }));
    this.nextId = nextId ?? this.entities.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    /** @type {Map<number, Entity> | null} */
    this._occ = null;
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {Terrain} [fill]
   */
  static blank(width, height, fill = FLOOR) {
    return new Layout({ width, height, terrain: new Array(width * height).fill(fill) });
  }

  /** @returns {Layout} */
  clone() {
    return Layout.fromJSON(this.toJSON());
  }

  // ---- terrain -------------------------------------------------------------

  /**
   * @param {number} x
   * @param {number} y
   */
  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  getTerrain(x, y) {
    return this.inBounds(x, y) ? this.terrain[y * this.width + x] : VOID;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {Terrain} t
   */
  setTerrain(x, y, t) {
    if (this.inBounds(x, y)) this.terrain[y * this.width + x] = t;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  isFloor(x, y) {
    return this.getTerrain(x, y) === FLOOR;
  }

  terrainToText() {
    const rows = [];
    for (let y = 0; y < this.height; y++) {
      rows.push(this.terrain.slice(y * this.width, (y + 1) * this.width).join(''));
    }
    return rows.join('\n');
  }

  // Replace terrain (and dimensions) from ASCII rows. Short rows are padded
  // with VOID so trailing-space trimming by text editors is harmless.
  /** @param {string} text */
  setTerrainFromText(text) {
    const rows = parseTerrainRows(text.replace(/\r/g, '').split('\n'));
    while (rows.length && rows[rows.length - 1].every((c) => c === VOID)) rows.pop();
    const width = Math.max(1, ...rows.map((r) => r.length));
    const height = Math.max(1, rows.length);
    this.width = width;
    this.height = height;
    this.terrain = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) this.terrain.push(rows[y]?.[x] ?? VOID);
    }
    this.entities = this.entities.filter((e) => entityCells(e).every((c) => this.inBounds(c.x, c.y)));
    this._occ = null;
  }

  // Grow (positive) or shrink (negative) each side. Entities are shifted and
  // those falling outside the new bounds are removed.
  /**
   * @param {{ left?: number, top?: number, right?: number, bottom?: number }} sides
   * @param {Terrain} [fill]
   */
  resize({ left = 0, top = 0, right = 0, bottom = 0 }, fill = VOID) {
    const nw = this.width + left + right;
    const nh = this.height + top + bottom;
    if (nw < 1 || nh < 1) throw new Error(t('error.minSize'));
    const terrain = new Array(nw * nh).fill(fill);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const ox = x - left, oy = y - top;
        if (this.inBounds(ox, oy)) terrain[y * nw + x] = this.getTerrain(ox, oy);
      }
    }
    this.width = nw;
    this.height = nh;
    this.terrain = terrain;
    for (const e of this.entities) { e.x += left; e.y += top; }
    this.entities = this.entities.filter((e) => entityCells(e).every((c) => this.inBounds(c.x, c.y)));
    this._occ = null;
  }

  // Use the factory's floor plan with these sections repaired (the others that
  // can be repaired are not): the terrain becomes the floor they give, on the
  // fixed grid. Entities are kept, even where the floor goes.
  /** @param {number[]} ids */
  setRepaired(ids) {
    this.repaired = REPAIRABLE_SECTIONS.filter((id) => ids.includes(id));
    if (this.width !== FLOOR_GRID.width || this.height !== FLOOR_GRID.height) {
      this.resize({ right: FLOOR_GRID.width - this.width, bottom: FLOOR_GRID.height - this.height });
    }
    this.terrain = sectionTerrain(this.repaired);
    this._occ = null;
    this._syncDistributors();
  }

  // The factory's distributors are fixed: one for each in FACTORY_DISTRIBUTORS
  // whose floor (the cell it feeds) is repaired, and no others. The same goes
  // for the cellar, which keeps what it holds.
  _syncDistributors() {
    const c = FACTORY_CELLAR;
    const cellarOn = this.isFloor(c.x + DIRS[c.rot].dx, c.y + DIRS[c.rot].dy);
    const isCellar = (/** @type {EntitySpec} */ e) => e.x === c.x && e.y === c.y && e.rot === c.rot;
    this.entities = this.entities.filter((e) => e.kind !== 'cellar' || (cellarOn && isCellar(e)));
    if (cellarOn && !this.entities.some((e) => e.kind === 'cellar')) this.add({ kind: 'cellar', ...c, stock: [], locked: true });
    /** @type {{ x: number, y: number, rot: number, material: string, garden?: boolean }[]} */
    const want = [
      ...FACTORY_DISTRIBUTORS.map((d) => ({ ...d, rot: 0 })),
      ...FACTORY_GARDEN_DISTRIBUTORS.map((d) => ({ ...d, garden: true, material: '' })),
    ].filter((d) => this.isFloor(d.x + DIRS[d.rot].dx, d.y + DIRS[d.rot].dy));
    // A garden distributor keeps the crop it's set to.
    const same = (/** @type {EntitySpec} */ e, /** @type {typeof want[number]} */ d) =>
      e.x === d.x && e.y === d.y && e.rot === d.rot && !!e.garden === !!d.garden && (d.garden || e.material === d.material);
    this.entities = this.entities.filter((e) => e.kind !== 'distributor' || want.some((d) => same(e, d)));
    for (const d of want) {
      if (!this.entities.some((e) => e.kind === 'distributor' && same(e, d))) this.add({ kind: 'distributor', rot: 0, locked: true, ...d });
    }
    this._occ = null;
  }

  // ---- entities ------------------------------------------------------------

  // Occupied cells of an entity (underground gap cells excluded).
  /**
   * @param {EntitySpec} e
   * @returns {XY[]}
   */
  footprint(e) {
    return entityCells(e).filter((c) => !c.gap).map((c) => /** @type {XY} */ ([c.x, c.y]));
  }

  /** @returns {Map<number, Entity>} */
  _index() {
    if (!this._occ) {
      this._occ = new Map();
      /** @type {Map<number, Entity>} underground gap cells */
      this._gaps = new Map();
      for (const e of this.entities) {
        for (const c of entityCells(e)) {
          if (!this.inBounds(c.x, c.y)) continue;
          const map = c.gap ? this._gaps : this._occ;
          const k = c.y * this.width + c.x;
          if (!map.has(k)) map.set(k, e);
        }
      }
    }
    return this._occ;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  entityAt(x, y) {
    // Fixed pieces may sit just off the grid (the cellar).
    if (!this.inBounds(x, y)) return this.entities.find((e) => ENTITY_KINDS[e.kind]?.fixed && e.x === x && e.y === y) ?? null;
    return this._index().get(y * this.width + x) ?? null;
  }

  // Underground conveyor whose gap is at (x, y), if any.
  /**
   * @param {number} x
   * @param {number} y
   */
  gapAt(x, y) {
    if (!this.inBounds(x, y)) return null;
    this._index();
    return this._gaps.get(y * this.width + x) ?? null;
  }

  /**
   * @param {number} id
   * @returns {Entity | null}
   */
  getEntity(id) {
    return this.entities.find((e) => e.id === id) ?? null;
  }

  // Can `e` be placed here? `ignoreIds` are treated as absent (for moves/replacements).
  /**
   * @param {EntitySpec} e
   * @param {number[]} [ignoreIds]
   * @returns {PlaceCheck}
   */
  canPlace(e, ignoreIds = []) {
    /** @param {Entity | null} other */
    const live = (other) => other && !ignoreIds.includes(other.id) ? other : null;
    const fronts = this.distributorFronts();
    for (const [i, c] of entityCells(e).entries()) {
      if (!this.inBounds(c.x, c.y)) return { ok: false, reason: t('place.outside') };
      const front = fronts.get(c.y * this.width + c.x);
      if (front && live(front.dist) && !fitsFront(e, i, front.back)) {
        return { ok: false, reason: t('place.frontOfDist', { dist: describeEntity(front.dist) }) };
      }
      const terrain = this.getTerrain(c.x, c.y);
      const occupant = live(this.entityAt(c.x, c.y));
      const gapOwner = live(this.gapAt(c.x, c.y));
      if (c.gap) {
        if (UNDERGROUND_GAP_MUST_BE_FLOOR && terrain !== FLOOR) return { ok: false, reason: t('place.gapOffFloor') };
        if (occupant && !UNDERGROUND_GAP_KINDS.includes(occupant.kind)) return { ok: false, reason: t('place.gapOnlyBelt', { what: describeEntity(occupant) }) };
        if (gapOwner) return { ok: false, reason: t('place.gapOverlap', { what: describeEntity(gapOwner) }) };
        continue;
      }
      if (terrain !== FLOOR && !ENTITY_KINDS[e.kind]?.fixed) return { ok: false, reason: t('place.offFloor') };
      if (occupant) return { ok: false, reason: t('place.overlaps', { what: describeEntity(occupant) }) };
      if (gapOwner && !UNDERGROUND_GAP_KINDS.includes(e.kind)) return { ok: false, reason: t('place.onGapOf', { what: describeEntity(gapOwner) }) };
    }
    return { ok: true };
  }

  // Cells distributors feed: cell key -> the distributor and the direction
  // pointing back into it.
  /** @returns {Map<number, { dist: Entity, back: Dir }>} */
  distributorFronts() {
    const out = new Map();
    for (const d of this.entities) {
      if (!ENTITY_KINDS[d.kind]?.feeds) continue;
      const p = this.ports(d)[0];
      if (this.inBounds(p.nx, p.ny)) out.set(p.ny * this.width + p.nx, { dist: d, back: mod4(p.dir + 2) });
    }
    return out;
  }

  /**
   * @param {EntitySpec} e
   * @returns {Entity}
   */
  add(e) {
    const { id: _, kind, ...rest } = e;
    const entity = normalizeEntity({ id: this.nextId++, kind, ...rest });
    this.entities.push(entity);
    this._occ = null;
    return entity;
  }

  /** @param {number} id */
  remove(id) {
    const n = this.entities.length;
    this.entities = this.entities.filter((e) => e.id !== id);
    this._occ = null;
    return this.entities.length !== n;
  }

  /**
   * @param {number} id
   * @param {Partial<Entity>} patch
   * @returns {Entity | null}
   */
  update(id, patch) {
    const e = this.getEntity(id);
    if (e) Object.assign(e, patch);
    this._occ = null;
    return e;
  }

  // Fixed world-space ports of an entity: [{kind, x, y, dir, nx, ny}], where
  // (nx, ny) is the neighbouring cell the port connects to. Chests have no fixed
  // ports (any side works); a belt's single port is its output.
  /**
   * @param {EntitySpec} e
   * @returns {Port[]}
   */
  ports(e) {
    /**
     * @param {PortDef['kind']} kind
     * @param {number} x
     * @param {number} y
     * @param {number} dir
     */
    const port = (kind, x, y, dir) => withNeighbour({ kind, x, y, dir: mod4(dir) });
    switch (e.kind) {
      case 'station':
        return (stationVariants(e.type)[e.variant] ?? stationVariants(e.type)[defaultVariant(e.type)]).ports
          .map((p) => port(p.kind, e.x + p.x, e.y + p.y, p.dir));
      case 'belt':
      case 'distributor':
      case 'cellar':
        return [port('out', e.x, e.y, e.rot)];
      case 'supply_station':
        return [port('in', e.x, e.y, e.rot)];
      case 'splitter':
        return [port('in', e.x, e.y, e.rot + 2), port('out', e.x, e.y, e.rot + 1), port('out', e.x, e.y, e.rot + 3)];
      case 'underground': {
        const cells = entityCells(e);
        const exit = cells[cells.length - 1];
        return [port('in', e.x, e.y, e.rot + 2), port('out', exit.x, exit.y, e.rot)];
      }
      default:
        return [];
    }
  }

  // Does entity `t` accept items pushed into it from the neighbouring cell (fx, fy)?
  /**
   * @param {EntitySpec} t
   * @param {number} fx
   * @param {number} fy
   * @returns {boolean}
   */
  acceptsFrom(t, fx, fy) {
    if (t.kind === 'chest') return true;
    // A belt, and each cell of an underground but its gap, takes items from
    // behind and (merging) from the sides.
    if (t.kind === 'belt' || t.kind === 'underground') {
      return entityCells(t).some((c) => {
        if (c.gap) return false;
        const dir = DIRS.findIndex((d) => fx + d.dx === c.x && fy + d.dy === c.y);
        return dir === t.rot || (dir !== -1 && BELT_ACCEPTS_FROM_SIDES && dir !== mod4(t.rot + 2));
      });
    }
    return this.ports(t).some((p) => p.kind === 'in' && p.nx === fx && p.ny === fy);
  }

  /**
   * Factory power the layout uses (POWER_COST per piece).
   * @returns {number}
   */
  power() {
    return powerOf(this.entities);
  }

  /** Power supply: the factory's carousels against the layout's power use. */
  powerSupply() {
    return powerSupply(this.power(), this.beltMaster);
  }

  // ---- validation ----------------------------------------------------------

  // "Supply: ..." items can't enter a chest. Follows what stations making them push
  // along belts, undergrounds and splitters: `belts` are the cells (belt, underground
  // entry and exit, splitter) on a path that ends in a chest, `chests` those chests.
  /** @returns {{ belts: { x: number, y: number, rot: number }[], chests: Entity[] }} */
  supplyIntoChests() {
    /** @type {Map<number, { x: number, y: number, rot: number }>} */
    const belts = new Map();
    /** @type {Set<Entity>} */
    const chests = new Set();
    /** @type {Map<string, boolean>} */
    const memo = new Map();
    const mark = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ rot) => belts.set(y * this.width + x, { x, y, rot });
    // Does what's pushed from (fx, fy) into (x, y) end up in a chest?
    const reaches = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ fx, /** @type {number} */ fy) => {
      const t = this.entityAt(x, y);
      if (!t || !this.acceptsFrom(t, fx, fy)) return false;
      if (t.kind === 'chest') { chests.add(t); return true; }
      if (t.kind !== 'belt' && t.kind !== 'underground' && t.kind !== 'splitter') return false;
      const key = `${t.id}:${t.kind === 'belt' ? '' : `${fx},${fy}`}`;
      if (memo.has(key)) return memo.get(key);
      memo.set(key, false); // loops count as not reaching
      const outs = this.ports(t).filter((p) => p.kind === 'out');
      let hit = false;
      for (const p of outs) if (reaches(p.nx, p.ny, p.x, p.y)) hit = true;
      if (hit) {
        if (t.kind === 'underground') {
          const cells = entityCells(t);
          mark(cells[0].x, cells[0].y, t.rot);
          mark(cells[cells.length - 1].x, cells[cells.length - 1].y, t.rot);
        } else mark(t.x, t.y, t.rot);
      }
      memo.set(key, hit);
      return hit;
    };
    for (const e of this.entities) {
      if (e.kind !== 'station' || !isSupplyItem(Object.keys(RECIPE_BY_ID[e.recipe]?.outputs ?? {})[0] ?? '')) continue;
      for (const p of this.ports(e)) if (p.kind === 'out') reaches(p.nx, p.ny, p.x, p.y);
    }
    return { belts: [...belts.values()], chests: [...chests] };
  }

  // Garden distributors the planner set go back to unset, ready for a new plan.
  clearAutoMaterials() {
    for (const e of this.entities) if (e.garden && e.autoMaterial) { e.material = ''; delete e.autoMaterial; }
  }

  /** @returns {Issue[]} */
  validate() {
    /** @type {Issue[]} */
    const issues = [];
    /**
     * @param {Issue['severity']} severity
     * @param {Entity | null} entity
     * @param {string} message
     * @param {XY[]} [cells] defaults to the entity's footprint
     */
    const add = (severity, entity, message, cells) =>
      issues.push({ severity, entityId: entity?.id ?? null, message, cells: cells ?? (entity ? this.footprint(entity) : []) });

    /** @type {Map<number, Entity>} */
    const seen = new Map();
    for (const e of this.entities) {
      for (const c of entityCells(e)) {
        const { x, y } = c;
        if (!this.inBounds(x, y)) {
          if (!ENTITY_KINDS[e.kind]?.fixed) add('error', e, `${describeEntity(e)} is outside the layout`);
          break;
        }
        if (c.gap) {
          if (UNDERGROUND_GAP_MUST_BE_FLOOR && !this.isFloor(x, y)) add('error', e, t('issue.gapOffFloor', { what: describeEntity(e) }), [[x, y]]);
          const crossing = this.entityAt(x, y);
          if (crossing && !UNDERGROUND_GAP_KINDS.includes(crossing.kind)) add('error', e, t('issue.inGap', { crossing: describeEntity(crossing), what: describeEntity(e) }), [[x, y]]);
          continue;
        }
        if (!this.isFloor(x, y) && !ENTITY_KINDS[e.kind]?.fixed) { add('error', e, t('issue.offFloor', { what: describeEntity(e) }), [[x, y]]); break; }
        const k = y * this.width + x;
        if (seen.has(k)) { add('error', e, t('issue.overlap', { what: describeEntity(e), other: describeEntity(seen.get(k)) }), [[x, y]]); break; }
        seen.set(k, e);
      }

      if (e.garden) {
        if (e.material && !GARDEN_ITEMS.includes(e.material)) add('error', e, t('issue.cantHold', { what: describeEntity(e), item: ITEM_BY_ID[e.material]?.name ?? `"${e.material}"` }));
      } else if (ENTITY_KINDS[e.kind]?.hasMaterial && !ITEM_BY_ID[e.material]) {
        add('warning', e, t('issue.noMaterial', { what: describeEntity(e) }));
      }
      if (e.kind === 'cellar') {
        for (const id of e.stock) if (!CELLAR_ITEMS.includes(id)) add('error', e, t('issue.cantHold', { what: describeEntity(e), item: ITEM_BY_ID[id]?.name ?? `"${id}"` }));
      }
      if (e.kind === 'chest') {
        if (!CHEST_LEVELS[e.level]) add('error', e, t('issue.unknownChestLevel', { what: describeEntity(e), level: e.level }));
        for (const id of e.stock) if (!ITEM_BY_ID[id]) add('error', e, t('issue.unknownStock', { what: describeEntity(e), id }));
        for (const [side, id] of Object.entries(e.filters)) {
          if (!DIRS.some((d) => d.name === side)) add('error', e, t('issue.unknownFilterSide', { what: describeEntity(e), side }));
          if (!ITEM_BY_ID[id]) add('error', e, t('issue.unknownFilterItem', { what: describeEntity(e), id, side }));
        }
      }

      if (e.kind === 'station') {
        if (!STATIONS[e.type].levels.includes(e.level)) add('error', e, t('issue.noLevel', { station: STATIONS[e.type].name, level: e.level }));
        if (!stationVariants(e.type)[e.variant]) add('error', e, t('issue.unknownLayout', { what: describeEntity(e), id: e.variant }));
        /** @type {Map<string, string>} extension slot -> extension id */
        const slots = new Map();
        for (const id of e.extensions) {
          const x = EXTENSIONS[id];
          if (!x) { add('error', e, t('issue.unknownExtension', { what: describeEntity(e), id }), undefined); continue; }
          if (x.station !== e.type) add('error', e, t('issue.cantTakeExtension', { what: describeEntity(e), name: x.name }));
          else if (slots.has(x.slot)) add('error', e, t('issue.slotClash', { what: describeEntity(e), a: EXTENSIONS[slots.get(x.slot)].name, b: x.name, slot: t(`slot.${x.slot}`) }));
          slots.set(x.slot, id);
        }
        const recipe = RECIPE_BY_ID[e.recipe];
        if (!e.recipe) add('info', e, t('issue.noRecipe', { what: describeEntity(e) }));
        else if (!recipe) add('error', e, t('issue.unknownRecipe', { what: describeEntity(e), id: e.recipe }));
        else if (!recipesFor(e.type, e.level).some((r) => r.id === e.recipe)) {
          add('error', e, t('issue.cantRunRecipe', { what: describeEntity(e), id: e.recipe }));
        } else if (recipe.extension && !e.extensions.includes(recipe.extension)) {
          add('error', e, t('issue.needsExtension', { what: describeEntity(e), name: EXTENSIONS[recipe.extension].name }));
        }
      }

      for (const p of this.ports(e)) this._validatePort(e, p, add);
    }
    for (const [k, { dist, back }] of this.distributorFronts()) {
      const x = k % this.width, y = (k / this.width) | 0;
      for (const o of new Set([this.entityAt(x, y), this.gapAt(x, y)])) {
        if (!o) continue;
        const i = entityCells(o).findIndex((c) => c.x === x && c.y === y);
        if (!fitsFront(o, i, back)) add('error', o, t('issue.frontOfDist', { what: describeEntity(o), dist: describeEntity(dist) }), [[x, y]]);
      }
    }
    for (const c of this.supplyIntoChests().chests) add('error', c, t('issue.supplyIntoChest', { what: describeEntity(c) }));
    const supplyStations = this.entities.filter((e) => e.kind === 'supply_station').length;
    const porters = this.entities.filter((e) => e.kind === 'porter').length;
    if (porters < portersFor(supplyStations)) add('info', null, t('issue.porters', { stations: t('count.supplyStations', { n: supplyStations }), porters: t('count.porters', { n: portersFor(supplyStations) }), placed: porters }), []);
    const power = this.powerSupply();
    if (power.over) {
      add('warning', null, t('issue.power', { used: power.used, available: power.available, maxZombies: power.maxZombies, carousels: power.carousels, over: power.over }), []);
    }
    return issues;
  }

  /**
   * @param {Entity} e
   * @param {Port} p
   * @param {AddIssue} add
   */
  _validatePort(e, p, add) {
    const what = e.kind === 'belt' ? t('issue.beltAt', { x: e.x, y: e.y }) : describeEntity(e);
    if (!this.isFloor(p.nx, p.ny)) {
      add('warning', e, e.kind === 'belt' ? t('issue.beltRunsOff', { what }) : t('issue.portFacesOff', { what, port: t(p.kind === 'in' ? 'port.input' : 'port.output'), dir: DIRS[p.dir].name }), [[p.nx, p.ny]]);
      return;
    }
    if (p.kind === 'in') {
      // Chests only output onto belts: one placed against a station input does nothing.
      const source = this.entityAt(p.nx, p.ny);
      if (source?.kind === 'chest' && e.kind === 'station') {
        add('warning', e, t('issue.chestCantFeed', { chest: describeEntity(source), station: describeEntity(e) }), [[p.x, p.y], [p.nx, p.ny]]);
      }
      return;
    }
    const target = this.entityAt(p.nx, p.ny);
    if (e.kind === 'station' && target?.kind === 'chest' && DIRS[p.dir].dx !== 0) {
      add('warning', e, t('issue.sideOutputChest', { what, chest: describeEntity(target) }), [[p.x, p.y], [p.nx, p.ny]]);
      return;
    }
    if (!target || this.acceptsFrom(target, p.x, p.y)) return;
    if (e.kind === 'belt' && target.kind === 'belt' && target.rot === mod4(e.rot + 2)) {
      add('warning', e, t('issue.beltsFaceEachOther', { a: `${e.x},${e.y}`, b: `${p.nx},${p.ny}` }), [[e.x, e.y], [p.nx, p.ny]]);
    } else {
      add('warning', e, t('issue.feedsNoInput', { what, target: describeEntity(target) }), [[p.x, p.y], [p.nx, p.ny]]);
    }
  }

  // ---- serialization -------------------------------------------------------

  /** @returns {LayoutJSON & { entities: Entity[] }} */
  toJSON() {
    const rows = this.terrainToText().split('\n');
    return {
      format: 'factory-layout',
      version: FORMAT_VERSION,
      name: this.name,
      width: this.width,
      height: this.height,
      legend: { '.': 'floor', ' ': 'outside' },
      terrain: rows,
      entities: this.entities.map((e) => ({ ...e })),
      ...(this.repaired ? { repaired: [...this.repaired] } : {}),
      ...(this.planner ? { planner: structuredClone(this.planner) } : {}),
      ...(this.beltMaster ? { beltMaster: true } : {}),
    };
  }

  /**
   * @param {string | LayoutJSON} json
   * @returns {Layout}
   */
  static fromJSON(json) {
    const data = /** @type {LayoutJSON} */ (typeof json === 'string' ? JSON.parse(json) : json);
    if (!Array.isArray(data.terrain)) throw new Error(t('error.missingTerrain'));
    const layout = new Layout({ name: data.name, width: 1, height: 1, entities: [], planner: data.planner, beltMaster: !!data.beltMaster });
    layout.setTerrainFromText(data.terrain.join('\n'));
    if (data.width) layout.resize({ right: data.width - layout.width });
    if (data.height) layout.resize({ bottom: data.height - layout.height });
    for (const e of data.entities ?? []) {
      // Zombie carousels used to be placeable; the factory's are fixed.
      if (/** @type {string} */ (e.kind) === 'carousel') continue;
      if (!ENTITY_KINDS[e.kind]) throw new Error(t('error.unknownKind', { id: e.kind }));
      if (e.kind === 'station' && !STATIONS[e.type]) throw new Error(t('error.unknownStation', { id: e.type }));
      // Ids missing from old files are assigned below.
      layout.entities.push(/** @type {Entity} */ (normalizeEntity({ ...e })));
    }
    layout.nextId = layout.entities.reduce((m, e) => Math.max(m, e.id ?? 0), 0) + 1;
    for (const e of layout.entities) if (e.id == null) e.id = layout.nextId++;
    layout._occ = null;
    if (Array.isArray(data.repaired)) {
      layout.setRepaired(data.repaired);
    } else if ((data.version ?? 1) < 2 && layout.width === V1_FACTORY.width && layout.height === V1_FACTORY.height) {
      // The factory floor before sections: move it down onto the new grid and
      // work out which sections its floor had.
      layout.resize({ top: V1_FACTORY.shift });
      layout.setRepaired(sectionsIn(layout));
    }
    return layout;
  }
}

// Fill defaults and migrate older files (stations no longer rotate; chests
// used to have a single material and output direction; stations had no
// extensions, so an old station gets the one its recipe needs).
/**
 * @template {EntitySpec} T
 * @param {T} e
 * @returns {T}
 */
function normalizeEntity(e) {
  e.locked ??= true;
  if (e.kind === 'station') {
    e.variant ??= defaultVariant(e.type);
    const needed = RECIPE_BY_ID[e.recipe]?.extension;
    e.extensions ??= needed ? [needed] : [];
    delete e.rot;
  } else if (e.kind === 'chest') {
    e.level ??= 1;
    e.stock ??= e.material ? [e.material] : [];
    e.filters ??= {};
    delete e.material;
    delete e.rot;
  } else {
    e.rot ??= 0;
    if (e.kind === 'cellar') e.stock ??= [];
  }
  return e;
}

// May cell `i` of entity `e` sit in front of a distributor? Only a belt or an
// underground's belt cell (not its gap), not pointing back into it
// (DISTRIBUTOR_FRONT_KINDS).
/** @param {EntitySpec} e @param {number} i @param {Dir} back */
function fitsFront(e, i, back) {
  if (!DISTRIBUTOR_FRONT_KINDS.includes(e.kind) || e.rot === back) return false;
  return !entityCells(e)[i].gap;
}

/**
 * @param {number} v
 * @returns {Dir}
 */
function mod4(v) {
  return /** @type {Dir} */ (((v % 4) + 4) % 4);
}

/**
 * @param {PortDef} p
 * @returns {Port}
 */
function withNeighbour(p) {
  return { ...p, nx: p.x + DIRS[p.dir].dx, ny: p.y + DIRS[p.dir].dy };
}

/**
 * @param {string[]} lines
 * @returns {Terrain[][]}
 */
function parseTerrainRows(lines) {
  const valid = new Set([VOID, FLOOR]);
  return lines.map((line) =>
    [...line].map((c) => {
      const terrain = TERRAIN_ALIASES[c] ?? c;
      if (!valid.has(terrain)) throw new Error(t('error.unknownTerrain', { id: c }));
      return terrain;
    }),
  );
}

/**
 * The factory's floor with the sections there from the start plus `repaired`:
 * one flag per cell of FLOOR_GRID (row-major), set where those sections'
 * rectangles cover the whole cell. Rectangle edges are on half cells, so each
 * quarter of a cell is either inside a rectangle or not.
 * @param {number[]} repaired
 * @returns {boolean[]}
 */
export function sectionFloor(repaired) {
  const rects = FLOOR_SECTIONS.filter((s) => !s.repair || repaired.includes(s.id)).flatMap((s) => s.rects);
  /** @param {number} px @param {number} py */
  const covered = (px, py) => rects.some(([x0, y0, x1, y1]) => px > x0 && px < x1 && py > y0 && py < y1);
  const out = [];
  for (let y = 0; y < FLOOR_GRID.height; y++) {
    for (let x = 0; x < FLOOR_GRID.width; x++) {
      out.push(!FLOOR_HOLES.some((h) => h.x === x && h.y === y) && covered(x + 0.25, y + 0.25) && covered(x + 0.75, y + 0.25) && covered(x + 0.25, y + 0.75) && covered(x + 0.75, y + 0.75));
    }
  }
  return out;
}

/**
 * @param {number[]} repaired
 * @returns {Terrain[]}
 */
function sectionTerrain(repaired) {
  return sectionFloor(repaired).map((f) => (f ? FLOOR : VOID));
}

// Repairable sections whose floor is all there in a layout on the factory grid
// (for files saved before sections existed).
/** @param {Layout} layout */
function sectionsIn(layout) {
  const base = sectionFloor([]);
  return REPAIRABLE_SECTIONS.filter((id) => sectionFloor([id]).every((f, k) => !f || base[k] || layout.terrain[k] === FLOOR));
}

/**
 * Power the factory's fixed carousels give, against `used` power: the zombies
 * that needs, and how much power is over the maximum.
 * @param {number} used
 * @param {boolean} beltMaster
 */
export function powerSupply(used, beltMaster) {
  const { perZombie, perZombieBeltMaster, zombiesPerCarousel, carousels } = ZOMBIE_POWER;
  const each = beltMaster ? perZombieBeltMaster : perZombie;
  const maxZombies = carousels * zombiesPerCarousel;
  const available = maxZombies * each;
  return { used, perZombie: each, carousels, maxZombies, available, zombies: Math.ceil(used / each), over: Math.max(0, used - available) };
}

/**
 * Factory power a set of pieces uses.
 * @param {EntitySpec[]} entities
 * @returns {number}
 */
export function powerOf(entities) {
  return entities.reduce((n, e) => n + (POWER_COST[e.kind] ?? 0), 0);
}

/**
 * @param {Terrain} terrain
 * @returns {string}
 */
export function terrainName(terrain) {
  const type = TERRAIN_TYPES.find((tt) => tt.id === terrain);
  return t(type ? type.key : 'terrain.unknown');
}

/**
 * @param {EntitySpec} e
 * @returns {string}
 */
export function describeEntity(e) {
  if (e.kind === 'station') {
    const roman = ['', 'I', 'II', 'III'][e.level] ?? e.level;
    return t('entity.at', { what: `${STATIONS[e.type]?.name ?? e.type} ${roman}`, x: e.x, y: e.y });
  }
  const items = e.kind === 'chest' || e.kind === 'cellar' ? e.stock ?? [] : e.material ? [e.material] : [];
  const mat = items.length ? ` (${items.map((id) => ITEM_BY_ID[id]?.name ?? id).join(', ')})` : '';
  return t('entity.at', { what: `${ENTITY_KINDS[e.kind]?.name ?? e.kind}${mat}`, x: e.x, y: e.y });
}
