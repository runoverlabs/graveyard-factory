// @ts-check
// Interactive floor-plan editor: tools, input handling, side panels, history.

import {
  DIRS, STATIONS, stationDims, stationVariants, defaultVariant, ROMAN, RAW_MATERIALS, EXTERNAL_ITEMS, PRODUCTS, OTHER_ITEMS,
  ITEM_BY_ID, ENTITY_KINDS, CELLAR_ITEMS, GARDEN_ITEMS, GARDEN_PICKER, RECIPE_BY_ID, TALENTS, EXTENSIONS, CHEST_LEVELS, EXTENSION_SLOTS, POWER_ICON, BELT_MASTER_ICON, ZOMBIE_POWER, FLOOR_SECTIONS, extensionsFor, recipesFor, entityBounds,
} from './catalog.js';
import { Layout, VOID, FLOOR, terrainName, describeEntity } from './model.js';
import { drawLayout, loadArt } from './render.js';
import { factoryFloor } from './floor.js';
import { Background } from './background.js';
import { SHARE_PARAM, encodeLayout, decodeLayout } from './share.js';
import { PlannerPanel } from './planner/panel.js';

/** @typedef {import('./types.js').Entity} Entity */
/** @typedef {import('./types.js').EntitySpec} EntitySpec */
/** @typedef {import('./types.js').EntityKind} EntityKind */
/** @typedef {import('./types.js').StationType} StationType */
/** @typedef {import('./types.js').Dir} Dir */
/** @typedef {import('./types.js').Item} Item */
/** @typedef {import('./types.js').Recipe} Recipe */
/** @typedef {import('./types.js').Issue} Issue */
/** @typedef {import('./types.js').View} View */

/** @typedef {{ x: number, y: number }} XY */
/** Toolbar entry; terrain tools also carry the terrain they paint. @typedef {{ id: string, name: string, key: string, terrain?: string, swatch?: string }} ToolDef */
/**
 * Placement options for the current tool.
 * @typedef {object} ToolOpts
 * @property {StationType} stationType
 * @property {number} level
 * @property {string} variant
 * @property {string} recipe '' for none
 * @property {string[]} extensions
 * @property {string} chestItem
 */
/** @typedef {Pick<ToolOpts, 'stationType' | 'level' | 'variant' | 'extensions' | 'recipe'>} StationOpts */
/** @typedef {{ type?: StationType, level?: number }} StationChange */
/** @typedef {{ entity: EntitySpec, ok: boolean }} Ghost */
/**
 * Pointer drag in progress; `before` is the snapshot to commit as one undo step.
 * @typedef {{ mode: 'pan', sx: number, sy: number, ox: number, oy: number, before?: undefined }
 *   | { mode: 'erase' | 'paint' | 'belt', before: string, last: XY }
 *   | { mode: 'rect', before: string, rect: { x0: number, y0: number, x1: number, y1: number } }
 *   | { mode: 'move', before: string, id: number, gx: number, gy: number, ghost: Ghost }} Drag
 */
/** Attributes for `h()`; values are stringified by setAttribute. @typedef {Record<string, string | number>} Attrs */

const STORAGE_KEY = 'factory-floor-editor/v1';
const MIN_CELL = 4, MAX_CELL = 96;

/** @type {ToolDef[]} */
const TERRAIN_TOOLS = [
  { id: 'floor', name: 'Floor', terrain: FLOOR, key: 'f', swatch: '#d9d4c7' },
  { id: 'void', name: 'Outside', terrain: VOID, key: 'x', swatch: '#15171c' },
];
/** @type {ToolDef[]} */
const ENTITY_TOOLS = [
  { id: 'select', name: 'Select', key: 'v' },
  { id: 'erase', name: 'Erase', key: 'e' },
  { id: 'belt', name: 'Belt', key: 'b' },
  { id: 'underground', name: 'Underground', key: 'u' },
  { id: 'splitter', name: 'Splitter', key: 'p' },
  { id: 'station', name: 'Station', key: 's' },
  { id: 'chest', name: 'Chest', key: 'h' },
  { id: 'supply_station', name: 'Supply station', key: 'l' },
  { id: 'porter', name: 'Supply porter', key: 'o' },
];
const TOOL_BY_KEY = Object.fromEntries([...TERRAIN_TOOLS, ...ENTITY_TOOLS].map((t) => [t.key, t.id]));

export class Editor {
  /** @param {Document} root */
  constructor(root) {
    /** @param {string} id */
    this.$ = (id) => root.getElementById(id);
    this.canvas = /** @type {HTMLCanvasElement} */ (this.$('canvas'));
    this.ctx = this.canvas.getContext('2d');
    /** @type {View} */
    this.view = { cell: 24, ox: 20, oy: 20, dpr: window.devicePixelRatio || 1 };
    /** @type {string} */
    this.tool = 'select';
    // Rotation is remembered per placement tool.
    /** @type {Record<string, number>} */
    this.rots = { belt: 1, underground: 1, splitter: 0, supply_station: 2 };
    /** @type {ToolOpts} */
    this.opts = { stationType: 'assembly_bench', level: 1, variant: defaultVariant('assembly_bench'), recipe: '', extensions: [], chestItem: '' };
    /** @type {number} */
    this.selectedId = null;
    /** @type {XY} */
    this.hover = null;
    /** @type {Drag} */
    this.drag = null;
    this.spaceHeld = false;
    /** @type {string[]} */
    this.undoStack = [];
    /** @type {string[]} */
    this.redoStack = [];
    /** @type {Issue[]} */
    this.issues = [];
    /** @type {ReturnType<typeof setTimeout>} */
    this.shareTimer = undefined;
    /** @type {number | null} floor section highlighted on the canvas */
    this.hoverSection = null;
    this.layout = this.loadSaved() ?? factoryFloor();
    this.background = new Background(() => this.requestDraw());
    loadArt(() => this.requestDraw());
    /** @type {Layout} */
    this.preview = null; // planner result shown instead of the layout until applied
    /** @type {string} */
    this.importFileName = '';

    this.buildToolButtons();
    this.bindTopbar();
    this.bindImportDialog();
    this.bindCanvas();
    this.bindKeyboard();
    new ResizeObserver(() => this.resizeCanvas()).observe(this.$('canvas-wrap'));
    this.resizeCanvas();
    this.fit();
    this.planner = new PlannerPanel(this, this.$('planner'));
    this.setTool('select');
    this.changed({ save: false });
    this.loadShared();
  }

  // ---- state & history -----------------------------------------------------

  snapshot() {
    return JSON.stringify(this.layout.toJSON());
  }

  // Run `fn` as one undoable step.
  /** @param {() => void} fn */
  mutate(fn) {
    const before = this.snapshot();
    fn();
    this.commit(before);
  }

  /** @param {string} before */
  commit(before) {
    if (before === this.snapshot()) { this.requestDraw(); return; }
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
  }

  /** @param {Layout} layout */
  replaceLayout(layout, { fit = true } = {}) {
    this.selectedId = null;
    this.mutate(() => { this.layout = layout; });
    if (fit) this.fit();
  }

  undo() { this.stepHistory(this.undoStack, this.redoStack, 'Undo'); }
  redo() { this.stepHistory(this.redoStack, this.undoStack, 'Redo'); }

  /** @param {string[]} from @param {string[]} to @param {string} label */
  stepHistory(from, to, label) {
    if (!from.length) return;
    to.push(this.snapshot());
    this.layout = Layout.fromJSON(from.pop());
    this.changed();
    this.status(label);
  }

  changed({ save = true } = {}) {
    if (this.selectedId != null && !this.layout.getEntity(this.selectedId)) this.selectedId = null;
    this.issues = this.layout.validate();
    if (save) this.save();
    /** @type {HTMLInputElement} */ (this.$('layout-name')).value = this.layout.name;
    /** @type {HTMLButtonElement} */ (document.querySelector('[data-action=undo]')).disabled = !this.undoStack.length;
    /** @type {HTMLButtonElement} */ (document.querySelector('[data-action=redo]')).disabled = !this.redoStack.length;
    this.renderSections();
    this.renderToolOptions();
    this.renderInspector();
    this.renderIssues();
    this.renderStats();
    if (this.planner && !this.planner.running) this.planner.render();
    this.requestDraw();
  }

  // Show a planner result instead of the layout (null to go back to editing).
  /** @param {Layout} layout */
  setPreview(layout) {
    this.preview = layout;
    /** @type {Issue[]} */
    this.previewIssues = layout ? layout.validate() : null;
    this.$('canvas-wrap').classList.toggle('previewing', !!layout);
    this.requestDraw();
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, this.snapshot()); } catch { /* storage unavailable */ }
    this.updateShareUrl();
  }

  // The address bar always holds the layout (`?f=`), so copying it shares the factory.
  updateShareUrl() {
    clearTimeout(this.shareTimer);
    this.shareTimer = setTimeout(async () => {
      const url = new URL(location.href);
      url.searchParams.set(SHARE_PARAM, await encodeLayout(this.layout));
      history.replaceState(null, '', url);
    }, 400);
  }

  // A shared link replaces what's saved in this browser once the layout is edited
  // (the first save), so it stays out of the undo history.
  async loadShared() {
    const param = new URL(location.href).searchParams.get(SHARE_PARAM);
    if (!param) { this.updateShareUrl(); return; }
    try {
      this.layout = await decodeLayout(param);
      this.undoStack = [];
      this.redoStack = [];
      this.selectedId = null;
      this.changed({ save: false });
      this.fit();
      this.status('Loaded the shared factory');
    } catch (err) {
      this.status(`The link's factory couldn't be loaded: ${/** @type {Error} */ (err).message}`, true);
      this.updateShareUrl();
    }
  }

  async copyShareLink() {
    const url = new URL(location.href);
    url.searchParams.set(SHARE_PARAM, await encodeLayout(this.layout));
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url.href);
      this.status('Link copied');
    } catch {
      this.status('Copy the address bar to share this factory');
    }
  }

  loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? Layout.fromJSON(raw) : null;
    } catch {
      return null;
    }
  }

  // ---- view ----------------------------------------------------------------

  resizeCanvas() {
    const wrap = this.$('canvas-wrap');
    this.view.dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.round(wrap.clientWidth * this.view.dpr));
    const targetH = Math.max(1, Math.round(wrap.clientHeight * this.view.dpr));
    if (this.canvas.width === targetW && this.canvas.height === targetH) return;
    // Resizing clears the canvas: redraw now, not on the next frame, so no blank frame is shown.
    this.canvas.width = targetW;
    this.canvas.height = targetH;
    this.draw();
  }

  fit() {
    const w = this.canvas.width / this.view.dpr, h = this.canvas.height / this.view.dpr;
    // A cell to spare each side when a fixed piece sits just off the grid (the cellar).
    const pad = this.layout.entities.some((e) => e.x < 0) ? 2 : 0;
    // Rows above the floor for the garden distributors and their crop picker.
    const top = this.layout.entities.some((e) => e.garden) ? -GARDEN_PICKER.y + 1 : 0;
    const cell = Math.floor(Math.min((w - 40) / (this.layout.width + pad), (h - 40) / (this.layout.height + top)));
    this.view.cell = clamp(cell, MIN_CELL, 48);
    this.view.ox = Math.round((w - this.layout.width * this.view.cell) / 2);
    this.view.oy = Math.round((h - (this.layout.height + top) * this.view.cell) / 2 + top * this.view.cell);
    this.requestDraw();
  }

  /** @param {number} x @param {number} y */
  centerOn(x, y) {
    const w = this.canvas.width / this.view.dpr, h = this.canvas.height / this.view.dpr;
    this.view.ox = Math.round(w / 2 - (x + 0.5) * this.view.cell);
    this.view.oy = Math.round(h / 2 - (y + 0.5) * this.view.cell);
    this.requestDraw();
  }

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.draw();
    });
  }

  draw() {
    drawLayout(this.ctx, this.preview ?? this.layout, this.view, {
      showGrid: /** @type {HTMLInputElement} */ (this.$('show-grid')).checked,
      showPorts: /** @type {HTMLInputElement} */ (this.$('show-ports')).checked,
      showFlow: /** @type {HTMLInputElement} */ (this.$('show-flow')).checked,
      showIssues: /** @type {HTMLInputElement} */ (this.$('show-issues')).checked,
      issues: this.preview ? this.previewIssues : this.issues,
      background: this.background,
      highlightSection: this.hoverSection,
      editingTerrain: !!this.terrainTool(),
      selectedId: this.selectedId,
      hover: this.hover,
      // Tool ghosts have no id yet; render only draws them.
      ghost: /** @type {{ entity: Entity, ok: boolean }} */ (this.currentGhost()), // the ghost has no id yet; drawing never reads it
      rect: this.drag?.mode === 'rect' ? this.drag.rect : null,
    });
  }

  // ---- tools ---------------------------------------------------------------

  /** @param {string} id */
  setTool(id) {
    this.tool = id;
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tools button'))) b.classList.toggle('active', b.dataset.tool === id);
    this.renderToolOptions();
    this.updateCursor();
    this.requestDraw();
  }

  buildToolButtons() {
    /** @param {ToolDef} t */
    const make = (t) => {
      const b = h('button', { 'data-tool': t.id, title: `${t.name} (${t.key.toUpperCase()})` },
        t.swatch ? h('span', { class: 'swatch', style: `background:${t.swatch}` }) : null,
        t.name, h('kbd', {}, t.key.toUpperCase()));
      b.addEventListener('click', () => this.setTool(t.id));
      return b;
    };
    this.$('terrain-tools').append(...TERRAIN_TOOLS.map(make));
    this.$('entity-tools').append(...ENTITY_TOOLS.map(make));
  }

  terrainTool() {
    return TERRAIN_TOOLS.find((t) => t.id === this.tool);
  }

  // Entity the current tool would place at the hovered cell.
  /** @param {XY} cell @returns {EntitySpec} */
  toolEntity(cell) {
    const { stationType, level, variant, recipe, extensions } = this.opts;
    const rot = this.rots[this.tool];
    switch (this.tool) {
      case 'belt': return { kind: 'belt', x: cell.x, y: cell.y, rot };
      case 'underground': return { kind: 'underground', x: cell.x, y: cell.y, rot };
      case 'splitter': return { kind: 'splitter', x: cell.x, y: cell.y, rot };
      case 'chest': return { kind: 'chest', x: cell.x, y: cell.y, stock: this.opts.chestItem ? [this.opts.chestItem] : [], filters: {} };
      case 'supply_station': return { kind: 'supply_station', x: cell.x, y: cell.y, rot };
      case 'porter': return { kind: 'porter', x: cell.x, y: cell.y };
      case 'station': {
        const { w, h } = stationDims(stationType);
        return { kind: 'station', type: stationType, level, variant, recipe: recipe || null, extensions: [...extensions], x: cell.x - Math.floor(w / 2), y: cell.y - Math.floor(h / 2), rot };
      }
      default: return null;
    }
  }

  /** @returns {Ghost} */
  currentGhost() {
    if (this.drag?.mode === 'move') return this.drag.ghost;
    if (this.drag || !this.hover || this.spaceHeld) return null;
    const entity = this.toolEntity(this.hover);
    if (!entity) return null;
    const ignore = this.tool === 'belt' && this.layout.entityAt(entity.x, entity.y)?.kind === 'belt'
      ? [this.layout.entityAt(entity.x, entity.y).id] : [];
    return { entity, ok: this.layout.canPlace(entity, ignore).ok };
  }

  /** @param {number} delta */
  rotate(delta) {
    const sel = this.tool === 'select' && this.layout.getEntity(this.selectedId);
    if (sel && ENTITY_KINDS[sel.kind].fixed) {
      this.status(`${describeEntity(sel)} is part of the factory: it can't be changed`, true);
    } else if (sel?.kind === 'station') {
      this.mutate(() => this.layout.update(sel.id, { variant: cycleVariant(sel.type, sel.variant, delta) }));
    } else if (sel && ENTITY_KINDS[sel.kind].rotatable) {
      const rotated = { ...sel, rot: mod4(sel.rot + delta) };
      const check = this.layout.canPlace(rotated, [sel.id]);
      if (!check.ok) return this.status(check.reason, true);
      this.mutate(() => this.layout.update(sel.id, { rot: rotated.rot }));
    } else if (!sel && this.tool === 'station') {
      this.opts.variant = cycleVariant(this.opts.stationType, this.opts.variant, delta);
      this.renderToolOptions();
      this.requestDraw();
    } else if (!sel && this.tool in this.rots) {
      this.rots[this.tool] = mod4(this.rots[this.tool] + delta);
      this.renderToolOptions();
      this.requestDraw();
    }
  }

  deleteSelected() {
    if (this.selectedId == null) return;
    const sel = this.layout.getEntity(this.selectedId);
    if (sel && ENTITY_KINDS[sel.kind].fixed) { this.status(`${describeEntity(sel)} is part of the factory: it can't be removed`, true); return; }
    this.mutate(() => this.layout.remove(this.selectedId));
    this.selectedId = null;
    this.changed();
  }

  /** @param {number} id */
  select(id) {
    this.selectedId = id;
    this.renderInspector();
    this.requestDraw();
  }

  // ---- canvas input --------------------------------------------------------

  /** @param {MouseEvent} ev @returns {XY} */
  cellAt(ev) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor((ev.clientX - r.left - this.view.ox) / this.view.cell),
      y: Math.floor((ev.clientY - r.top - this.view.oy) / this.view.cell),
    };
  }

  bindCanvas() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    c.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    c.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    c.addEventListener('pointercancel', (ev) => this.onPointerUp(ev));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.updateStatusCell(); this.requestDraw(); } });
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      const cell = clamp(this.view.cell * Math.exp(-ev.deltaY * 0.0015), MIN_CELL, MAX_CELL);
      const k = cell / this.view.cell;
      this.view.ox = Math.round(sx - (sx - this.view.ox) * k);
      this.view.oy = Math.round(sy - (sy - this.view.oy) * k);
      this.view.cell = cell;
      this.requestDraw();
    }, { passive: false });
  }

  // A click on the strip of crops above the top wall sets the selected garden distributor.
  /** @param {XY} cell */
  pickGardenCrop(cell) {
    const i = cell.x - GARDEN_PICKER.x;
    if (cell.y !== GARDEN_PICKER.y || i < 0 || i >= GARDEN_ITEMS.length) return false;
    const sel = this.selectedId != null ? this.layout.getEntity(this.selectedId) : null;
    if (!sel?.garden) { this.status('Select a garden distributor first, then pick its crop', true); return true; }
    const material = sel.material === GARDEN_ITEMS[i] ? '' : GARDEN_ITEMS[i];
    this.mutate(() => this.layout.update(sel.id, { material, autoMaterial: false }));
    this.renderInspector();
    return true;
  }

  /** @param {PointerEvent} ev */
  onPointerDown(ev) {
    if (this.drag) return;
    this.canvas.setPointerCapture(ev.pointerId);
    const cell = this.cellAt(ev);
    const before = this.snapshot();

    if (ev.button === 1 || (ev.button === 0 && this.spaceHeld) || (this.preview && ev.button === 0)) {
      this.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, ox: this.view.ox, oy: this.view.oy };
      if (this.preview && ev.button === 0 && !this.spaceHeld) this.status('Planner preview: Apply or Discard it in the Planner panel to edit again');
    } else if (this.preview) {
      return;
    } else if (ev.button === 2) {
      this.drag = { mode: 'erase', before, last: cell };
      this.eraseAt(cell);
    } else if (ev.button !== 0) {
      return;
    } else if (this.terrainTool()) {
      if (ev.shiftKey) {
        this.drag = { mode: 'rect', before, rect: { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y } };
      } else {
        this.drag = { mode: 'paint', before, last: cell };
        this.layout.setTerrain(cell.x, cell.y, this.terrainTool().terrain);
      }
    } else if (this.pickGardenCrop(cell)) {
      return;
    } else if (this.tool === 'select') {
      const e = this.layout.entityAt(cell.x, cell.y) ?? this.layout.gapAt(cell.x, cell.y);
      if (e && ENTITY_KINDS[e.kind].fixed) {
        this.select(e.id);
      } else if (e) {
        this.select(e.id);
        this.drag = { mode: 'move', before, id: e.id, gx: cell.x - e.x, gy: cell.y - e.y, ghost: null };
      } else {
        this.select(null);
        this.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, ox: this.view.ox, oy: this.view.oy };
      }
    } else if (this.tool === 'erase') {
      this.drag = { mode: 'erase', before, last: cell };
      this.eraseAt(cell);
    } else if (this.tool === 'belt') {
      this.drag = { mode: 'belt', before, last: cell };
      this.placeBelt(cell, this.rots.belt);
    } else {
      const entity = this.toolEntity(cell);
      const check = this.layout.canPlace(entity);
      if (check.ok) this.mutate(() => this.select(this.layout.add(entity).id));
      else this.status(check.reason, true);
    }
    this.updateCursor();
    this.requestDraw();
  }

  /** @param {PointerEvent} ev */
  onPointerMove(ev) {
    const cell = this.cellAt(ev);
    const moved = !this.hover || cell.x !== this.hover.x || cell.y !== this.hover.y;
    this.hover = cell;
    if (moved) this.updateStatusCell();
    const d = this.drag;
    if (!d) { if (moved) { this.updateCursor(); this.requestDraw(); } return; }

    if (d.mode === 'pan') {
      this.view.ox = Math.round(d.ox + ev.clientX - d.sx);
      this.view.oy = Math.round(d.oy + ev.clientY - d.sy);
    } else if (!moved) {
      return;
    } else if (d.mode === 'rect') {
      d.rect.x1 = cell.x; d.rect.y1 = cell.y;
    } else if (d.mode === 'paint') {
      for (const p of path4(d.last, cell)) this.layout.setTerrain(p.x, p.y, this.terrainTool().terrain);
      d.last = cell;
    } else if (d.mode === 'erase') {
      for (const p of path4(d.last, cell)) this.eraseAt(p);
      d.last = cell;
    } else if (d.mode === 'belt') {
      let prev = d.last;
      for (const p of path4(d.last, cell)) {
        const dir = dirBetween(prev, p);
        const prevBelt = this.layout.entityAt(prev.x, prev.y);
        if (prevBelt?.kind === 'belt') this.layout.update(prevBelt.id, { rot: dir });
        this.placeBelt(p, dir);
        this.rots.belt = dir;
        prev = p;
      }
      d.last = cell;
    } else if (d.mode === 'move') {
      const e = this.layout.getEntity(d.id);
      const ghost = { ...e, x: cell.x - d.gx, y: cell.y - d.gy };
      d.ghost = ghost.x === e.x && ghost.y === e.y ? null : { entity: ghost, ok: this.layout.canPlace(ghost, [e.id]).ok };
    }
    this.requestDraw();
  }

  /** @param {PointerEvent} ev */
  onPointerUp(ev) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    if (d.mode === 'rect') {
      const { x0, y0, x1, y1 } = d.rect;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.layout.setTerrain(x, y, this.terrainTool().terrain);
      }
    } else if (d.mode === 'move' && d.ghost) {
      if (d.ghost.ok) this.layout.update(d.id, { x: d.ghost.entity.x, y: d.ghost.entity.y });
      else this.status(this.layout.canPlace(d.ghost.entity, [d.id]).reason, true);
    }
    if (d.before) this.commit(d.before);
    this.updateCursor();
    this.requestDraw();
  }

  /** @param {XY} cell @param {number} rot */
  placeBelt(cell, rot) {
    const existing = this.layout.entityAt(cell.x, cell.y);
    if (existing?.kind === 'belt') { this.layout.update(existing.id, { rot }); return; }
    /** @type {EntitySpec} */
    const belt = { kind: 'belt', x: cell.x, y: cell.y, rot };
    if (this.layout.canPlace(belt).ok) this.layout.add(belt);
  }

  /** @param {XY} cell */
  eraseAt(cell) {
    const e = this.layout.entityAt(cell.x, cell.y);
    if (e && !ENTITY_KINDS[e.kind].fixed) this.layout.remove(e.id);
  }

  updateCursor() {
    let cursor = 'crosshair';
    if (this.drag?.mode === 'pan') cursor = 'grabbing';
    else if (this.spaceHeld) cursor = 'grab';
    else if (this.tool === 'select') cursor = this.hover && this.layout.entityAt(this.hover.x, this.hover.y) ? 'move' : 'default';
    this.canvas.style.cursor = cursor;
  }

  // ---- keyboard ------------------------------------------------------------

  bindKeyboard() {
    window.addEventListener('keydown', (ev) => {
      const importDialog = /** @type {HTMLDialogElement} */ (this.$('import-dialog'));
      if (importDialog?.open) return;
      if (/** @type {HTMLElement} */ (ev.target).matches?.('input, textarea, select')) {
        if (ev.key === 'Escape') /** @type {HTMLElement} */ (ev.target).blur();
        return;
      }
      const ctrl = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();
      if (this.preview) {
        if (ev.key === 'Escape') this.planner.discard();
        if (ev.key === '0') this.fit();
        if (ev.key === ' ') { ev.preventDefault(); this.spaceHeld = true; this.updateCursor(); }
        return; // no editing while a planner preview is shown
      }
      if (ctrl && key === 'z') { ev.preventDefault(); ev.shiftKey ? this.redo() : this.undo(); return; }
      if (ctrl && key === 'y') { ev.preventDefault(); this.redo(); return; }
      if (ctrl || ev.altKey) return;
      if (ev.key === ' ') { ev.preventDefault(); this.spaceHeld = true; this.updateCursor(); this.requestDraw(); return; }
      if (key === 'r') { this.rotate(ev.shiftKey ? -1 : 1); return; }
      if (ev.key === 'Delete' || ev.key === 'Backspace') { this.deleteSelected(); return; }
      if (ev.key === 'Escape') { this.tool === 'select' ? this.select(null) : this.setTool('select'); return; }
      if (key === '0') { this.fit(); return; }
      if (TOOL_BY_KEY[key]) this.setTool(TOOL_BY_KEY[key]);
    });
    window.addEventListener('keyup', (ev) => {
      if (ev.key === ' ') { this.spaceHeld = false; this.updateCursor(); this.requestDraw(); }
    });
  }

  // ---- top bar -------------------------------------------------------------

  bindTopbar() {
    /** @type {Record<string, () => void>} */
    const actions = {
      clear: () => this.clear(),
      import: () => this.openImportDialog(),
      export: () => this.exportJSON(),
      share: () => this.copyShareLink(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      fit: () => this.fit(),
    };
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.topbar [data-action]'))) {
      b.addEventListener('click', () => actions[b.dataset.action]?.());
    }
    this.$('layout-name').addEventListener('change', (ev) => {
      this.mutate(() => { this.layout.name = /** @type {HTMLInputElement} */ (ev.target).value.trim() || 'Untitled factory'; });
    });
    for (const id of ['show-grid', 'show-ports', 'show-flow', 'show-issues']) {
      this.$(id).addEventListener('change', () => this.requestDraw());
    }
    this.$('show-background').addEventListener('change', (ev) => {
      this.background.visible = /** @type {HTMLInputElement} */ (ev.target).checked;
      this.requestDraw();
    });
  }

  // Remove everything placed on the floor; the floor and its fixed distributors stay.
  clear() {
    if (this.preview) this.planner.discard();
    this.selectedId = null;
    const n = this.layout.entities.filter((e) => !ENTITY_KINDS[e.kind].fixed).length;
    this.mutate(() => {
      for (const e of this.layout.entities.filter((x) => !ENTITY_KINDS[x.kind].fixed)) this.layout.remove(e.id);
    });
    this.status(n ? `Cleared ${n} pieces (Undo to go back)` : 'Nothing to clear');
  }

  // Mark a floor section repaired or not. Taking floor away clears the current
  // setup (as Clear does), after asking when there's anything to clear; it's one
  // undo step either way.
  /** @param {number} id @param {boolean} on */
  setSectionRepaired(id, on) {
    const repaired = this.layout.repaired ?? [];
    const pieces = this.layout.entities.filter((e) => !ENTITY_KINDS[e.kind].fixed);
    const name = `section ${id} (${FLOOR_SECTIONS.find((s) => s.id === id).name.toLowerCase()})`;
    if (!on && pieces.length && !confirm(`Turning off ${name} clears the current setup (${pieces.length} pieces). Continue?`)) {
      this.renderSections();
      return;
    }
    if (this.preview) this.planner.discard();
    this.selectedId = null;
    this.mutate(() => {
      if (!on) for (const e of pieces) this.layout.remove(e.id);
      // Distributors come and go with the floor they feed.
      this.layout.setRepaired(on ? [...repaired, id] : repaired.filter((x) => x !== id));
    });
    this.status(on ? `Repaired ${name}` : `Turned off ${name}${pieces.length ? `; cleared ${pieces.length} pieces (Undo to go back)` : ''}`);
  }

  // ---- import & export -----------------------------------------------------

  openImportDialog() {
    const dialog = /** @type {HTMLDialogElement} */ (this.$('import-dialog'));
    if (!dialog) return;
    const textarea = /** @type {HTMLTextAreaElement} */ (this.$('import-json-text'));
    const fileInput = /** @type {HTMLInputElement} */ (this.$('import-dialog-file'));
    const fileName = this.$('import-dialog-filename');
    const errorEl = this.$('import-error');

    if (textarea) textarea.value = '';
    if (fileInput) fileInput.value = '';
    if (fileName) fileName.textContent = 'No file chosen';
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
    this.importFileName = '';

    dialog.showModal();
    textarea?.focus();
  }

  bindImportDialog() {
    const dialog = /** @type {HTMLDialogElement} */ (this.$('import-dialog'));
    if (!dialog) return;

    const textarea = /** @type {HTMLTextAreaElement} */ (this.$('import-json-text'));
    const fileInput = /** @type {HTMLInputElement} */ (this.$('import-dialog-file'));
    const fileName = this.$('import-dialog-filename');
    const errorEl = this.$('import-error');
    const dropCard = dialog.querySelector('.dialog-card');

    /** @param {string} msg */
    const showError = (msg) => {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    };

    /** @param {File} file */
    const loadFile = async (file) => {
      try {
        const text = await file.text();
        if (textarea) textarea.value = text;
        this.importFileName = file.name;
        if (fileName) fileName.textContent = file.name;
        if (errorEl) {
          errorEl.textContent = '';
          errorEl.hidden = true;
        }
      } catch (err) {
        showError(`Could not read file: ${/** @type {Error} */ (err).message}`);
      }
    };

    const submitImport = () => {
      const text = textarea?.value.trim() ?? '';
      if (!text) {
        showError('Please choose a file or paste layout JSON.');
        return;
      }
      try {
        const layout = Layout.fromJSON(text);
        this.replaceLayout(layout);
        const name = this.importFileName || layout.name || 'layout';
        this.status(`Imported ${name}`);
        dialog.close();
      } catch (err) {
        showError(`Import failed: ${/** @type {Error} */ (err).message}`);
      }
    };

    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await loadFile(file);
    });

    textarea?.addEventListener('input', () => {
      this.importFileName = '';
      if (fileName) fileName.textContent = 'Pasted text';
      if (errorEl && !errorEl.hidden) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    });

    textarea?.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submitImport();
      }
    });

    // Backdrop click only: the card fills the dialog, so a click on the dialog itself is outside it.
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });

    this.$('import-close-btn')?.addEventListener('click', () => dialog.close());
    this.$('import-cancel-btn')?.addEventListener('click', () => dialog.close());
    this.$('import-submit-btn')?.addEventListener('click', () => submitImport());

    // Drag and drop support
    if (dropCard) {
      dropCard.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        dropCard.classList.add('drag-over');
      });
      dropCard.addEventListener('dragleave', (ev) => {
        const related = /** @type {Node | null} */ (/** @type {DragEvent} */ (ev).relatedTarget);
        if (!related || !dropCard.contains(related)) {
          dropCard.classList.remove('drag-over');
        }
      });
      dropCard.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        dropCard.classList.remove('drag-over');
        const file = /** @type {DragEvent} */ (ev).dataTransfer?.files?.[0];
        if (file) await loadFile(file);
      });
    }
  }

  exportJSON() {
    const blob = new Blob([formatLayoutJSON(this.layout.toJSON())], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(this.layout.name)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- side panels ---------------------------------------------------------

  // One toggle per floor section that can be repaired, with the game's repair
  // materials. The planner only uses repaired floor.
  renderSections() {
    const el = this.$('sections');
    const repaired = this.layout.repaired;
    if (!repaired) {
      el.replaceChildren(h('p', { class: 'hint' }, 'This layout has its own floor, not the factory\'s sections.'));
      return;
    }
    const rows = FLOOR_SECTIONS.filter((s) => s.repair).map((s) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = repaired.includes(s.id);
      box.addEventListener('change', () => this.setSectionRepaired(s.id, box.checked));
      const cost = Object.entries(s.repair).map(([id, n]) => {
        const item = ITEM_BY_ID[id];
        return h('span', { class: 'cost', title: `${n} ${item?.name ?? id}` }, item?.icon ? h('img', { src: item.icon, alt: item.name }) : null, `${n}`);
      });
      const row = h('label', { class: 'section-row', title: `Section ${s.id}: repair materials ${Object.entries(s.repair).map(([id, n]) => `${n} ${ITEM_BY_ID[id]?.name ?? id}`).join(', ')}` },
        box, h('span', { class: 'section-name' }, `${s.id} · ${s.name}`), h('span', { class: 'costs' }, ...cost));
      row.addEventListener('pointerenter', () => { this.hoverSection = s.id; this.requestDraw(); });
      row.addEventListener('pointerleave', () => { this.hoverSection = null; this.requestDraw(); });
      return row;
    });
    el.replaceChildren(...rows,
      h('p', { class: 'hint' }, 'Repaired sections are floor for the editor and planner. Turning one off clears the current setup.'));
  }

  renderToolOptions() {
    const el = this.$('tool-options');
    el.replaceChildren();
    const t = this.tool;
    if (this.terrainTool()) {
      el.append(h('h2', {}, `${this.terrainTool().name} tool`),
        h('p', { class: 'hint' }, 'Drag to paint cells. Hold Shift and drag to fill a rectangle.'));
      return;
    }
    if (t === 'select') {
      el.append(h('h2', {}, 'Select tool'),
        h('p', { class: 'hint' }, 'Click an entity to inspect it, drag it to move. Drag empty space to pan.'));
      return;
    }
    if (t === 'erase') {
      el.append(h('h2', {}, 'Erase tool'), h('p', { class: 'hint' }, 'Click or drag to remove belts, stations and chests.'));
      return;
    }
    /** @param {Partial<ToolOpts>} patch */
    const setOpt = (patch) => { Object.assign(this.opts, patch); this.renderToolOptions(); this.requestDraw(); };
    el.append(h('h2', {}, `Place ${ENTITY_KINDS[/** @type {EntityKind} */ (t)].name.toLowerCase()}`));
    if (t === 'station') {
      el.append(
        field('Type', typeSelect(this.opts.stationType, (v) => setOpt(stationPatch(this.opts, { type: v })))),
        field('Level', levelSelect(this.opts.stationType, this.opts.level, (v) => setOpt(stationPatch(this.opts, { level: v })))),
        field('Layout', variantSelect(this.opts.stationType, this.opts.variant, (v) => setOpt({ variant: v }))),
        field('Recipe', recipeSelect(this.opts.stationType, this.opts.level, this.opts.recipe,
          (v) => setOpt({ recipe: v, extensions: withRequired(this.opts.extensions, v) }))),
      );
      if (this.opts.recipe) el.append(recipeInfo(this.opts.stationType, RECIPE_BY_ID[this.opts.recipe]));
      el.append(field('Extensions', extensionButtons(this.opts.stationType, this.opts.extensions, this.opts.recipe,
        (list) => setOpt({ extensions: list }))));
    }
    if (t === 'chest') {
      el.append(field('Stock', materialSelect(t, this.opts.chestItem, (v) => setOpt({ chestItem: v }), { none: '— empty —' })));
    }
    if (ENTITY_KINDS[/** @type {EntityKind} */ (t)].rotatable) {
      el.append(field(ROT_LABEL[t], rotButtons(this.rots[t], (r) => { this.rots[t] = r; setOpt({}); })));
    }
    el.append(h('p', { class: 'hint' }, TOOL_HINT[t]));
  }

  renderInspector() {
    const el = this.$('inspector');
    el.replaceChildren();
    const e = this.layout.getEntity(this.selectedId);
    if (!e) return;
    /** @param {Partial<Entity>} patch */
    const set = (patch) => {
      const next = { ...e, ...patch };
      const check = this.layout.canPlace(next, [e.id]);
      if (!check.ok) { this.status(check.reason, true); this.renderInspector(); return; }
      this.mutate(() => this.layout.update(e.id, patch));
    };
    el.append(h('h2', {}, `Selected: ${e.kind === 'station' ? STATIONS[e.type].name : ENTITY_KINDS[e.kind].name}`));
    const b = entityBounds(e);
    el.append(field('Position', h('span', {}, `${e.x}, ${e.y}${b.w * b.h > 1 ? ` (${b.w}×${b.h})` : ''}`)));
    if (ENTITY_KINDS[e.kind].fixed) {
      if (e.garden) el.append(field('Crop', h('span', {}, e.material ? `${ITEM_BY_ID[e.material]?.name ?? e.material}${e.autoMaterial ? ' (set by the planner)' : ''}` : 'none: click one above the factory (the planner sets it if left empty)')));
      else if (e.material) el.append(field('Material', h('span', {}, ITEM_BY_ID[e.material]?.name ?? e.material)));
      if (e.kind === 'cellar') {
        const boxes = CELLAR_ITEMS.map((id) => {
          const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
          box.checked = e.stock.includes(id);
          box.addEventListener('change', () => this.mutate(() => this.layout.update(e.id, {
            stock: CELLAR_ITEMS.filter((x) => x === id ? box.checked : e.stock.includes(x)),
          })));
          return h('label', {}, box, ` ${ITEM_BY_ID[id]?.name ?? id}`);
        });
        el.append(field('Holds', h('div', { class: 'checks' }, ...boxes)));
        el.append(h('p', { class: 'hint' }, 'Everything it holds goes onto the one belt it feeds, mixed: with more than one item, sort them with a filtered chest.'));
      }
      el.append(h('p', { class: 'hint' }, 'Part of the factory: it can\'t be moved, turned or removed. The cell it feeds can stay empty or take a belt or an underground\'s belt cell (not its gap), not pointing back into it.'));
      return;
    }
    if (e.kind === 'station') {
      el.append(
        field('Type', typeSelect(e.type, (v) => set(stationEntityPatch(e, { type: v })))),
        field('Level', levelSelect(e.type, e.level, (v) => set(stationEntityPatch(e, { level: v })))),
        field('Layout', variantSelect(e.type, e.variant, (v) => set({ variant: v }))),
        field('Recipe', recipeSelect(e.type, e.level, e.recipe ?? '',
          (v) => set({ recipe: v || null, extensions: withRequired(e.extensions, v) }))),
      );
      if (RECIPE_BY_ID[e.recipe]) el.append(recipeInfo(e.type, RECIPE_BY_ID[e.recipe]));
      el.append(field('Extensions', extensionButtons(e.type, e.extensions, e.recipe, (list) => set({ extensions: list }))));
    }
    if (e.kind === 'chest') this.renderChestFields(el, e, set);
    if (ENTITY_KINDS[e.kind].rotatable) {
      el.append(field(ROT_LABEL[e.kind], rotButtons(e.rot, (r) => set({ rot: r }))));
    }
    const locked = h('input', { type: 'checkbox', title: 'The planner keeps locked entities in place' });
    locked.checked = !!e.locked;
    locked.addEventListener('change', () => set({ locked: locked.checked }));
    el.append(field('Locked', h('label', {}, locked, ' keep in planner')));
    const del = h('button', { class: 'danger' }, 'Delete');
    del.addEventListener('click', () => this.deleteSelected());
    el.append(h('div', { class: 'row-actions' }, del));
  }

  /** @param {HTMLElement} el @param {Entity} e @param {(patch: Partial<Entity>) => void} set */
  renderChestFields(el, e, set) {
    el.append(field('Chest', selectEl(Object.entries(CHEST_LEVELS).map(([l, c]) => [l, `${c.name} (${c.slots} slots)`]),
      e.level, (v) => set({ level: +v }))));
    const chips = h('div', { class: 'chips' });
    for (const id of e.stock) {
      const x = h('button', { type: 'button', title: 'Remove' }, '×');
      x.addEventListener('click', () => set({ stock: e.stock.filter((s) => s !== id) }));
      const item = ITEM_BY_ID[id];
      const swatch = item?.icon ? h('img', { src: item.icon, alt: '' }) : h('i', { style: `background:${item?.color}` });
      chips.append(h('span', { class: 'chip' }, swatch, item?.name ?? id, x));
    }
    const adder = materialSelect('chest', '', (v) => { if (v && !e.stock.includes(v)) set({ stock: [...e.stock, v] }); }, { none: '+ add item…' });
    el.append(field('Stock', h('div', {}, chips, adder)));
    el.append(h('p', { class: 'hint' }, 'Receives from any belt pointing in; outputs to the other belts next to it. With filters set, only filtered sides output (that item); with none, every side does:'));
    for (const d of DIRS) {
      const sel = materialSelect('chest', e.filters[d.name] ?? '', (v) => {
        const filters = { ...e.filters };
        if (v) filters[d.name] = v; else delete filters[d.name];
        set({ filters });
      }, { none: 'any item' });
      el.append(field(`Out ${d.name}`, sel));
    }
  }

  renderIssues() {
    const list = this.$('issues');
    const order = { error: 0, warning: 1, info: 2 };
    const issues = [...this.issues].sort((a, b) => order[a.severity] - order[b.severity]);
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    this.$('issue-count').textContent = issues.length ? `${errors} err · ${warnings} warn` : '';
    list.replaceChildren(...(issues.length ? issues.map((issue) => {
      const li = h('li', { class: issue.severity }, issue.message);
      li.addEventListener('click', () => {
        if (issue.entityId != null) { this.setTool('select'); this.select(issue.entityId); }
        const [x, y] = issue.cells[0] ?? [0, 0];
        this.centerOn(x, y);
      });
      return li;
    }) : [h('li', { class: 'empty' }, 'No issues')]));
  }

  renderStats() {
    const l = this.layout;
    /** @param {string} t */
    const count = (t) => l.terrain.filter((c) => c === t).length;
    /** @param {string} k */
    const byKind = (k) => l.entities.filter((e) => e.kind === k).length;
    /** @type {[string, string | number][]} */
    const rows = [
      ['Size', `${l.width} × ${l.height}`],
      ['Floor cells', count(FLOOR)],
      ['Free floor', count(FLOOR) - l.entities.reduce((s, e) => s + l.footprint(e).length, 0)],
      ['Belts', byKind('belt')],
      ['Undergrounds / splitters', `${byKind('underground')} / ${byKind('splitter')}`],
      ...Object.entries(STATIONS).map(/** @returns {[string, number]} */ ([id, s]) => [s.name, l.entities.filter((e) => e.kind === 'station' && e.type === id).length]),
      ['Chests', byKind('chest')],
      ['Supply stations / porters', `${byKind('supply_station')} / ${byKind('porter')}`],
      ['Distributors', byKind('distributor') + byKind('cellar')],
    ];
    const p = l.powerSupply();
    const beltMaster = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
    beltMaster.checked = l.beltMaster;
    beltMaster.addEventListener('change', () => this.mutate(() => { this.layout.beltMaster = beltMaster.checked; }));
    this.$('stats').replaceChildren(
      h('span', { class: 'power', title: 'Factory power: 1 per station and belt, 2 per underground conveyor; chests and porters use none' }, h('img', { src: POWER_ICON, alt: '' }), 'Power'),
      h('b', { class: p.over ? 'over' : '' }, `${p.used} / ${p.available}`),
      h('span', { title: `${p.perZombie} power per zombie; the factory's ${p.carousels} carousels hold ${ZOMBIE_POWER.zombiesPerCarousel} zombies each` }, 'Zombies needed'),
      h('b', { class: p.over ? 'over' : '' }, `${p.zombies} / ${p.maxZombies}`),
      h('label', { class: 'perk', title: 'Belt Master perk: 10 power per zombie instead of 7' }, beltMaster, h('img', { src: BELT_MASTER_ICON, alt: '' }), 'Belt Master'),
      h('span', {}),
      ...rows.flatMap(([k, v]) => [h('span', {}, k), h('b', {}, String(v))]),
    );
  }

  updateStatusCell() {
    const c = this.hover;
    if (!c || !this.layout.inBounds(c.x, c.y)) { this.$('status-cell').textContent = ''; return; }
    const e = this.layout.entityAt(c.x, c.y);
    let text = `${c.x}, ${c.y} · ${terrainName(this.layout.getTerrain(c.x, c.y))}`;
    if (e) text += ` · ${describeEntity(e)}${e.kind === 'belt' ? ` → ${DIRS[e.rot].name}` : ''}`;
    const gap = this.layout.gapAt(c.x, c.y);
    if (gap) text += ` · gap of ${describeEntity(gap)}`;
    this.$('status-cell').textContent = text;
  }

  /** @param {string} msg */
  status(msg, isError = false) {
    const el = this.$('status-msg');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }
}

// ---- helpers ---------------------------------------------------------------

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs} [attrs]
 * @param {...(Node | string)} children null entries are skipped
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

/** @param {[string | number, string][]} options @param {string | number} value @param {(v: string) => void} onChange */
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

/** @param {string} kind @param {string} value @param {(v: string) => void} onChange @param {{ none?: string }} [options] */
function materialSelect(kind, value, onChange, { none = '— none —' } = {}) {
  /** @type {[string, Item[]][]} */
  const groups = [['Raw materials', RAW_MATERIALS], ['Chest-only ingredients', EXTERNAL_ITEMS], ['Products', PRODUCTS], ['Other items', OTHER_ITEMS]];
  const s = h('select');
  if (kind === 'chest' || !groups.some(([, items]) => items.some((m) => m.id === value))) s.append(h('option', { value: '' }, none));
  for (const [label, items] of groups) {
    const g = h('optgroup', { label });
    for (const m of items) g.append(h('option', { value: m.id }, m.name));
    s.append(g);
  }
  s.value = value ?? '';
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** @type {Record<string, string>} */
const ROT_LABEL = { belt: 'Direction', underground: 'Direction', splitter: 'Direction', supply_station: 'Input side' };
/** @type {Record<string, string>} */
const TOOL_HINT = {
  belt: 'Drag to lay a belt line — direction follows the drag. Belts cannot cross; use an underground conveyor.',
  underground: 'Click the entry cell; it runs 5 cells in its direction. A belt, chest or another underground may cross its middle (gap) cell; the other four cells work like belts.',
  splitter: 'Takes items from behind and sends them out to both sides.',
  station: 'Stations cannot rotate. R cycles through the four input/output layouts.',
  chest: 'Accepts from any side, outputs to neighbouring belts not pointing in. Filters pick the sides that output.',
  porter: 'Zombie Supply Porter, 1 wide and 2 high: one is needed for every 3 supply stations. The planner puts these along 23,24 to 29,24.',
  supply_station: 'Takes "Supply: …" crates from a belt on its input side. The planner puts these on or near row 27, x 23–31.',
};

/** @param {StationType} type @param {string} current @param {number} delta */
function cycleVariant(type, current, delta) {
  const ids = Object.keys(stationVariants(type));
  const n = ids.length;
  return ids[(((ids.indexOf(current) + delta) % n) + n) % n];
}

// The select only offers STATIONS keys, so its value is a StationType.
/** @param {StationType} value @param {(v: StationType) => void} onChange */
function typeSelect(value, onChange) {
  return selectEl(Object.entries(STATIONS).map(([id, s]) => [id, s.name]), value, /** @type {(v: string) => void} */ (onChange));
}

/** @param {StationType} type @param {number} value @param {(v: number) => void} onChange */
function levelSelect(type, value, onChange) {
  return selectEl(STATIONS[type].levels.map((l) => [l, ROMAN[l]]), value, (v) => onChange(+v));
}

/** @param {StationType} type @param {string} value @param {(v: string) => void} onChange */
function variantSelect(type, value, onChange) {
  return selectEl(Object.entries(stationVariants(type)).map(([id, v]) => [id, v.name]), value, onChange);
}

// Changing station type or level: keep the level and layout valid for the type
// and drop a recipe the new type/level can't run.
/** @param {StationOpts} opts @param {StationChange} change @returns {StationOpts} */
function stationPatch(opts, change) {
  const type = change.type ?? opts.stationType;
  const levels = STATIONS[type].levels;
  const level = levels.includes(change.level ?? opts.level) ? (change.level ?? opts.level) : levels.at(-1);
  const variant = stationVariants(type)[opts.variant] ? opts.variant : defaultVariant(type);
  const extensions = (opts.extensions ?? []).filter((id) => EXTENSIONS[id].station === type);
  return { stationType: type, level, variant, extensions, recipe: validRecipe(type, level, opts.recipe) };
}

/** @param {Entity} e @param {StationChange} change @returns {Partial<Entity>} */
function stationEntityPatch(e, change) {
  const p = stationPatch({ stationType: e.type, level: e.level, variant: e.variant, extensions: e.extensions, recipe: e.recipe }, change);
  return { type: p.stationType, level: p.level, variant: p.variant, extensions: p.extensions, recipe: p.recipe || null };
}

// Toggle an extension: it replaces whatever sits in its slot, or comes off again.
/** @param {string[]} list @param {string} id */
function toggleExtension(list, id) {
  if (list.includes(id)) return list.filter((x) => x !== id);
  return [...list.filter((x) => EXTENSIONS[x].slot !== EXTENSIONS[id].slot), id];
}

// Extensions after picking a recipe: the one it needs is fitted.
/** @param {string[]} list @param {string} recipeId */
function withRequired(list, recipeId) {
  const need = RECIPE_BY_ID[recipeId]?.extension;
  return need && !list.includes(need) ? toggleExtension(list, need) : list;
}

// One row of icon toggles per slot. The recipe's extension is marked, in red
// while it's missing.
/** @param {StationType} type @param {string[]} list @param {string} recipeId @param {(list: string[]) => void} onChange */
function extensionButtons(type, list, recipeId, onChange) {
  const need = RECIPE_BY_ID[recipeId]?.extension;
  const wrap = h('div', { class: 'ext-slots' });
  for (const slot of EXTENSION_SLOTS) {
    const row = h('div', { class: 'ext-row' }, h('span', { class: 'ext-slot' }, slot));
    for (const id of extensionsFor(type).filter((x) => EXTENSIONS[x].slot === slot)) {
      const x = EXTENSIONS[id];
      const cls = [list.includes(id) && 'active', id === need && (list.includes(id) ? 'needed' : 'missing')].filter(Boolean).join(' ');
      const b = h('button', { type: 'button', class: cls, title: `${x.name}${id === need ? ' (needed by the recipe)' : ''}` },
        h('img', { src: x.icon, alt: x.name }));
      b.addEventListener('click', () => onChange(toggleExtension(list, id)));
      row.append(b);
    }
    wrap.append(row);
  }
  return wrap;
}

/** @param {StationType} type @param {number} level @param {string} value @param {(v: string) => void} onChange */
function recipeSelect(type, level, value, onChange) {
  /** @param {string} id */
  const name = (id) => ITEM_BY_ID[id]?.name ?? id;
  /** @type {[string, string][]} */
  const opts = [['', '— none —'], ...recipesFor(type, level).map(/** @returns {[string, string]} */ (r) =>
    [r.id, `${Object.keys(r.outputs).map(name).join(', ')} ← ${Object.keys(r.inputs).map(name).join(' + ')}`])];
  return selectEl(opts, value, onChange);
}

/** @param {StationType} type @param {number} level @param {string} recipe */
function validRecipe(type, level, recipe) {
  return recipesFor(type, level).some((r) => r.id === recipe) ? recipe : '';
}

// Recipe line plus the worker talent it needs, with the game's talent icon.
/** @param {StationType} type @param {Recipe} r */
function recipeInfo(type, r) {
  const t = TALENTS[STATIONS[type].talent];
  return h('div', { class: 'recipe' }, recipeText(r), ' · needs ',
    h('span', { class: 'talent', title: `${t.name} talent level ${r.talent}` }, `${r.talent}`, h('img', { src: t.icon, alt: t.name })));
}

/** @param {Recipe} r */
function recipeText(r) {
  /** @param {Record<string, number>} o */
  const side = (o) => Object.entries(o).map(([id, n]) => `${n} ${ITEM_BY_ID[id]?.name ?? id}`).join(' + ');
  const needs = [r.tech && `tech: ${r.tech}`, r.extension && `extension: ${EXTENSIONS[r.extension].name}`].filter(Boolean).join(', ');
  return `${side(r.inputs)} → ${side(r.outputs)}${r.time ? ` (${r.time}s)` : ''}${needs ? ` · ${needs}` : ''}`;
}

/** @param {number} current @param {(rot: Dir) => void} onPick */
function rotButtons(current, onPick) {
  const wrap = h('div', { class: 'rot-buttons' });
  for (const d of DIRS) {
    const b = h('button', { type: 'button', class: d.id === current ? 'active' : '' }, d.name);
    b.addEventListener('click', () => onPick(d.id));
    wrap.append(b);
  }
  return wrap;
}

// 4-connected cell path from a (exclusive) to b (inclusive).
/** @param {XY} a @param {XY} b */
function path4(a, b) {
  /** @type {XY[]} */
  const out = [];
  const dx = b.x - a.x, dy = b.y - a.y;
  let x = a.x, y = a.y;
  for (let i = 0, n = Math.abs(dx) + Math.abs(dy); i < n; i++) {
    const px = dx ? Math.abs(x - a.x) / Math.abs(dx) : 1;
    const py = dy ? Math.abs(y - a.y) / Math.abs(dy) : 1;
    if (x !== b.x && px <= py) x += Math.sign(dx); else y += Math.sign(dy);
    out.push({ x, y });
  }
  return out;
}

/** @param {XY} a @param {XY} b @returns {Dir} */
function dirBetween(a, b) {
  return DIRS.find((d) => d.dx === b.x - a.x && d.dy === b.y - a.y).id;
}

// Pretty JSON with terrain rows and entities one per line (easy to diff/edit by hand).
/** @param {import('./model.js').LayoutJSON} data */
export function formatLayoutJSON(data) {
  const { entities, ...rest } = data;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  const body = entities.length ? `[\n${entities.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]` : '[]';
  return `${head},\n  "entities": ${body}\n}\n`;
}

/** @param {string} s */
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'factory';
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
/** @param {number} v */
function mod4(v) { return ((v % 4) + 4) % 4; }
