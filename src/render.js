// @ts-check
// Canvas rendering of a layout plus editor overlays.

/** @typedef {import('./types.js').Entity} Entity */
/** @typedef {import('./types.js').Dir} Dir */
/** @typedef {import('./types.js').Issue} Issue */
/** @typedef {import('./types.js').View} View */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {CanvasRenderingContext2D} Ctx */

/**
 * Editor overlays for drawLayout; everything is optional.
 * @typedef {object} Overlay
 * @property {{ shown: boolean, draw(ctx: Ctx, cell: number): void }} [background]
 * @property {number | null} [highlightSection] floor section to outline
 * @property {boolean} [editingTerrain]
 * @property {boolean} [showGrid]
 * @property {boolean} [showFlow]
 * @property {boolean} [showPorts]
 * @property {boolean} [showIssues]
 * @property {Issue[]} [issues]
 * @property {number | null} [selectedId]
 * @property {RectDrag | null} [rect]
 * @property {{ entity: Entity, ok: boolean } | null} [ghost]
 * @property {{ x: number, y: number } | null} [hover]
 */
/** Rectangle being dragged out, corners inclusive. @typedef {{ x0: number, y0: number, x1: number, y1: number }} RectDrag */
/** One image of a conveyor/chest: cell (x, y) plus art offset (dx, dy) in game px. @typedef {{ src: string, x: number, y: number, dx: number, dy: number }} ArtPiece */

import {
  N, DIRS, STATIONS, stationDims, ITEMS, ITEM_BY_ID, ROMAN, RECIPE_BY_ID, TALENTS, UNIT_PX, EXTENSION_ART_FRAME, extensionArt, entityBounds, entityCells,
  ART_DIRS, CONVEYOR_ART, CHEST_LEVELS, CHEST_ART_OFFSET, FLOOR_SECTIONS, GARDEN_ITEMS, GARDEN_PICKER,
} from './catalog.js';

/** @type {Record<string, HTMLImageElement>} */
const SPRITES = {}; // sprite src -> Image
/** @type {Record<string, HTMLImageElement>} */
const ICONS = {};   // item id -> Image
/** @type {() => void} */
let redraw = () => {};

/** @type {(cache: Record<string, HTMLImageElement>, key: string, src: string | undefined) => HTMLImageElement | undefined} */
const load = (cache, key, src) => {
  if (!src || cache[key]) return cache[key];
  const img = new Image();
  img.onload = () => redraw();
  img.src = src;
  return (cache[key] = img);
};

// Load station sprites and item icons; `onLoad` is called as each finishes (to
// redraw). Extension art loads on first use.
/** @param {() => void} onLoad */
export function loadArt(onLoad) {
  redraw = onLoad;
  for (const def of Object.values(STATIONS)) {
    for (const byVariant of Object.values(def.sprites ?? {})) {
      for (const sprite of Object.values(byVariant)) load(SPRITES, sprite.src, sprite.src);
    }
  }
  for (const item of ITEMS) load(ICONS, item.id, item.icon);
  for (const t of Object.values(TALENTS)) load(SPRITES, t.icon, t.icon);
}

/** @type {(img: HTMLImageElement | undefined) => boolean} */
const ready = (img) => !!img && img.complete && img.naturalWidth > 0;

// Item icon centred at (cx, cy), `size` px square; coloured dot if there's no icon.
/** @param {Ctx} ctx @param {string} id @param {number} cx @param {number} cy @param {number} size */
function drawItem(ctx, id, cx, cy, size) {
  const img = ICONS[id];
  if (!ready(img)) { drawMaterialDot(ctx, id, cx, cy, size * 0.32); return; }
  ctx.save();
  ctx.imageSmoothingEnabled = size < img.naturalWidth;
  ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
}
import { FLOOR, REPAIRABLE_SECTIONS, sectionFloor } from './model.js';

const COLORS = {
  void: '#15171c',
  floor: '#d9d4c7',
  floorAlt: '#d2ccbe',
  grid: 'rgba(0,0,0,0.10)',
  belt: '#6f6a5f',
  beltArrow: '#f2d15c',
  floorEdge: '#35d0ff',
  splitter: '#5d6f7e',
  underground: '#4d4a44',
  cellar: '#7b2d3b',
  tunnel: '#a79f8d',
  chest: '#8b5e34',
  chestLid: '#a8743f',
  in: '#35b56a',
  out: '#f08a24',
  select: '#1e90ff',
  error: '#e5484d',
  warning: '#f5a524',
  info: '#6e8bd8',
  flow: 'rgba(120,230,255,0.9)',
  flowShadow: 'rgba(0,0,0,0.55)',
  lockedFloor: 'rgba(8,9,12,0.6)',
  lockedHatch: 'rgba(245,165,36,0.28)',
  lockedText: 'rgba(245,190,90,0.85)',
};

// The crops a garden distributor can be set to, floating above the top wall. The one
// the selected garden distributor holds is outlined.
/** @param {Ctx} ctx @param {Layout} layout @param {number} cell @param {number | null | undefined} selectedId */
function drawGardenPicker(ctx, layout, cell, selectedId) {
  const sel = selectedId != null ? layout.getEntity(selectedId) : null;
  const active = sel?.garden ? sel : null;
  GARDEN_ITEMS.forEach((id, i) => {
    const px = (GARDEN_PICKER.x + i) * cell, py = GARDEN_PICKER.y * cell;
    ctx.fillStyle = active ? 'rgba(30,33,41,0.92)' : 'rgba(30,33,41,0.6)';
    roundRect(ctx, px + cell * 0.06, py + cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.15);
    ctx.fill();
    if (active?.material === id) {
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    drawItem(ctx, id, px + cell / 2, py + cell / 2, cell * 0.66);
  });
}

/** @param {Ctx} ctx @param {Layout} layout @param {View} view @param {Overlay} [overlay] */
export function drawLayout(ctx, layout, view, overlay = {}) {
  const { cell } = view;
  const canvas = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, view.ox * view.dpr, view.oy * view.dpr);

  // Visible cell range.
  const x0 = Math.max(0, Math.floor(-view.ox / cell));
  const y0 = Math.max(0, Math.floor(-view.oy / cell));
  const x1 = Math.min(layout.width, Math.ceil((canvas.width / view.dpr - view.ox) / cell));
  const y1 = Math.min(layout.height, Math.ceil((canvas.height / view.dpr - view.oy) / cell));

  // With the background image the factory itself is the picture; the editor's
  // terrain is only overlaid while a terrain tool is in use.
  const bgShown = !!overlay.background?.shown;
  if (bgShown) {
    overlay.background.draw(ctx, cell);
    if (overlay.editingTerrain) {
      ctx.globalAlpha = 0.45;
      drawTerrain(ctx, layout, cell, x0, y0, x1, y1);
      ctx.globalAlpha = 1;
      drawFloorEdges(ctx, layout, cell, x0, y0, x1, y1);
    }
  } else {
    drawTerrain(ctx, layout, cell, x0, y0, x1, y1);
  }
  if (overlay.showGrid !== false) drawGrid(ctx, layout, cell, x0, y0, x1, y1, bgShown);
  drawSections(ctx, layout, cell, overlay.highlightSection);

  // Layout boundary (only when background is hidden or editing terrain, so it doesn't
  // draw an artificial rectangular box across the irregular factory walls).
  if (!bgShown || overlay.editingTerrain) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, layout.width * cell, layout.height * cell);
  }

  // Conveyors first, then stations, chests and distributors over them; each
  // top to bottom, so lower pieces overlap the overhangs of the ones above.
  for (const e of drawOrder(layout.entities)) drawEntity(ctx, layout, e, cell, { dim: !e.locked });
  if (overlay.showFlow !== false) drawFlow(ctx, layout, cell);
  const stations = layout.entities.filter((e) => e.kind === 'station');
  // Recipe icons go on top of everything, so belts feeding the hoppers don't hide them.
  for (const e of stations) drawStationIO(ctx, layout, e, cell);

  if (overlay.showPorts !== false) {
    for (const e of layout.entities) drawPorts(ctx, layout, e, cell);
  }

  // Belts carrying "Supply: ..." items into a chest, which can't take them.
  for (const b of layout.supplyIntoChests().belts) drawChevron(ctx, (b.x + 0.5) * cell, (b.y + 0.5) * cell, b.rot, cell * 0.28, COLORS.error, cell * 0.12);

  if (overlay.showIssues && overlay.issues) {
    // Info-level notes (e.g. "no recipe") are listed in the panel only.
    for (const issue of overlay.issues) {
      if (issue.severity === 'info') continue;
      ctx.strokeStyle = COLORS[issue.severity];
      ctx.lineWidth = 2;
      for (const [x, y] of issue.cells) ctx.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }

  if (layout.entities.some((e) => e.garden)) drawGardenPicker(ctx, layout, cell, overlay.selectedId);

  if (overlay.selectedId != null) {
    const e = layout.getEntity(overlay.selectedId);
    if (e) {
      const b = entityBounds(e);
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(b.x * cell - 1, b.y * cell - 1, b.w * cell + 2, b.h * cell + 2);
    }
  }

  if (overlay.rect) drawRectPreview(ctx, overlay.rect, cell);

  if (overlay.ghost) {
    ctx.globalAlpha = 0.6;
    drawEntity(ctx, layout, overlay.ghost.entity, cell, {});
    if (overlay.ghost.entity.kind === 'station') drawStationIO(ctx, layout, overlay.ghost.entity, cell);
    drawPorts(ctx, layout, overlay.ghost.entity, cell);
    ctx.globalAlpha = 1;
    const b = entityBounds(overlay.ghost.entity);
    ctx.strokeStyle = overlay.ghost.ok ? COLORS.select : COLORS.error;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x * cell, b.y * cell, b.w * cell, b.h * cell);
  } else if (overlay.hover && layout.inBounds(overlay.hover.x, overlay.hover.y)) {
    ctx.strokeStyle = 'rgba(30,144,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(overlay.hover.x * cell + 0.5, overlay.hover.y * cell + 0.5, cell - 1, cell - 1);
  }
}

/** @param {Ctx} ctx @param {Layout} layout @param {number} cell @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function drawTerrain(ctx, layout, cell, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (layout.getTerrain(x, y) !== FLOOR) continue;
      ctx.fillStyle = (x + y) % 2 ? COLORS.floorAlt : COLORS.floor;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

// Grid lines only around cells where pieces can be placed (floor). Each floor
// cell draws its top and left edges, plus bottom/right where the floor ends,
// so shared edges are stroked once.
/** @param {Ctx} ctx @param {Layout} layout @param {number} cell @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {boolean} strong */
function drawGrid(ctx, layout, cell, x0, y0, x1, y1, strong) {
  if (cell < 8) return;
  ctx.strokeStyle = strong ? 'rgba(255,255,255,0.18)' : COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  /** @param {number} x @param {number} y */
  const h = (x, y) => { ctx.moveTo(x * cell, y * cell + 0.5); ctx.lineTo((x + 1) * cell, y * cell + 0.5); };
  /** @param {number} x @param {number} y */
  const v = (x, y) => { ctx.moveTo(x * cell + 0.5, y * cell); ctx.lineTo(x * cell + 0.5, (y + 1) * cell); };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!layout.isFloor(x, y)) continue;
      h(x, y);
      v(x, y);
      if (!layout.isFloor(x, y + 1)) h(x, y + 1);
      if (!layout.isFloor(x + 1, y)) v(x + 1, y);
    }
  }
  ctx.stroke();
}

/** @type {boolean[] | null} floor with every section repaired (FLOOR_GRID cells) */
let fullFloor = null;

// Floor sections that aren't repaired: darkened and hatched, with their number.
// `highlight` (a section hovered in the list) is outlined, repaired or not.
/** @param {Ctx} ctx @param {Layout} layout @param {number} cell @param {number | null | undefined} highlight */
function drawSections(ctx, layout, cell, highlight) {
  if (!layout.repaired) return;
  fullFloor ??= sectionFloor(REPAIRABLE_SECTIONS);
  const locked = new Path2D();
  let any = false;
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      if (!fullFloor[y * layout.width + x] || layout.isFloor(x, y)) continue;
      locked.rect(x * cell, y * cell, cell, cell);
      any = true;
    }
  }
  if (any) {
    ctx.save();
    ctx.clip(locked);
    ctx.fillStyle = COLORS.lockedFloor;
    ctx.fillRect(0, 0, layout.width * cell, layout.height * cell);
    ctx.strokeStyle = COLORS.lockedHatch;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const w = layout.width * cell, hgt = layout.height * cell, step = Math.max(6, cell / 2);
    for (let d = -hgt; d < w; d += step) { ctx.moveTo(d, hgt); ctx.lineTo(d + hgt, 0); }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = COLORS.lockedText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.max(10, Math.round(cell * 0.7))}px system-ui, sans-serif`;
    for (const s of FLOOR_SECTIONS) {
      if (!s.repair || layout.repaired.includes(s.id)) continue;
      const [x0, y0, x1, y1] = s.rects[0];
      ctx.fillText(`${s.id} · not repaired`, (x0 + x1) / 2 * cell, (y0 + y1) / 2 * cell);
    }
  }
  const hl = FLOOR_SECTIONS.find((s) => s.id === highlight);
  if (hl) {
    ctx.save();
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    for (const [x0, y0, x1, y1] of hl.rects) ctx.strokeRect(x0 * cell, y0 * cell, (x1 - x0) * cell, (y1 - y0) * cell);
    ctx.restore();
  }
}

// Outline where floor meets anything else, so the plan reads clearly over the background.
/** @param {Ctx} ctx @param {Layout} layout @param {number} cell @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function drawFloorEdges(ctx, layout, cell, x0, y0, x1, y1) {
  ctx.strokeStyle = COLORS.floorEdge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!layout.isFloor(x, y)) continue;
      if (!layout.isFloor(x, y - 1)) { ctx.moveTo(x * cell, y * cell); ctx.lineTo((x + 1) * cell, y * cell); }
      if (!layout.isFloor(x, y + 1)) { ctx.moveTo(x * cell, (y + 1) * cell); ctx.lineTo((x + 1) * cell, (y + 1) * cell); }
      if (!layout.isFloor(x - 1, y)) { ctx.moveTo(x * cell, y * cell); ctx.lineTo(x * cell, (y + 1) * cell); }
      if (!layout.isFloor(x + 1, y)) { ctx.moveTo((x + 1) * cell, y * cell); ctx.lineTo((x + 1) * cell, (y + 1) * cell); }
    }
  }
  ctx.stroke();
}

/** @param {Ctx} ctx @param {Layout} layout @param {Entity} e @param {number} cell @param {{ dim?: boolean }} opts */
export function drawEntity(ctx, layout, e, cell, { dim }) {
  const px = e.x * cell, py = e.y * cell;
  const prevAlpha = ctx.globalAlpha;
  if (dim) ctx.globalAlpha = prevAlpha * 0.75;

  if (drawConveyorArt(ctx, layout, e, cell)) {
    if (e.kind === 'chest') drawChestContents(ctx, e, px, py, cell);
  } else if (e.kind === 'belt') {
    const m = cell * 0.08;
    ctx.fillStyle = COLORS.belt;
    roundRect(ctx, px + m, py + m, cell - 2 * m, cell - 2 * m, cell * 0.15);
    ctx.fill();
    drawChevron(ctx, px + cell / 2, py + cell / 2, e.rot, cell * 0.28, COLORS.beltArrow, cell * 0.1);
  } else if (e.kind === 'underground') {
    drawUnderground(ctx, e, cell);
  } else if (e.kind === 'splitter') {
    const m = cell * 0.08;
    ctx.fillStyle = COLORS.splitter;
    roundRect(ctx, px + m, py + m, cell - 2 * m, cell - 2 * m, cell * 0.15);
    ctx.fill();
    // Incoming stem from behind, then a bar out to both sides.
    ctx.save();
    ctx.translate(px + cell / 2, py + cell / 2);
    ctx.rotate((e.rot * Math.PI) / 2);
    ctx.strokeStyle = COLORS.beltArrow;
    ctx.lineWidth = cell * 0.1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, cell * 0.3); ctx.lineTo(0, 0);
    ctx.moveTo(-cell * 0.3, 0); ctx.lineTo(cell * 0.3, 0);
    ctx.stroke();
    ctx.restore();
  } else if (e.kind === 'chest') {
    const m = cell * 0.1;
    ctx.fillStyle = COLORS.chest;
    ctx.fillRect(px + m, py + m, cell - 2 * m, cell - 2 * m);
    ctx.fillStyle = COLORS.chestLid;
    ctx.fillRect(px + m, py + m, cell - 2 * m, (cell - 2 * m) * 0.35);
    drawChestContents(ctx, e, px, py, cell);
  } else if (e.kind === 'porter') {
    ctx.fillStyle = '#4b3a5e';
    ctx.fillRect(px + cell * 0.1, py + cell * 0.1, cell * 0.8, cell * 1.8);
    ctx.strokeStyle = COLORS.beltArrow;
    ctx.lineWidth = Math.max(1.5, cell * 0.08);
    ctx.strokeRect(px + cell * 0.18, py + cell * 0.18, cell * 0.64, cell * 1.64);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(cell * 0.4)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ZP', px + cell / 2, py + cell);
  } else if (e.kind === 'supply_station') {
    ctx.fillStyle = '#6b4a2b';
    ctx.fillRect(px + cell * 0.1, py + cell * 0.1, cell * 0.8, cell * 0.8);
    drawChevron(ctx, px + cell / 2, py + cell / 2, (e.rot + 2) % 4, cell * 0.28, COLORS.beltArrow, cell * 0.1);
  } else if (e.kind === 'distributor') {
    ctx.fillStyle = '#2f3542';
    ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
    ctx.strokeStyle = ITEM_BY_ID[e.material]?.color ?? '#999';
    ctx.lineWidth = Math.max(2, cell * 0.12);
    ctx.strokeRect(px + cell * 0.12, py + cell * 0.12, cell * 0.76, cell * 0.76);
    if (e.material) drawItem(ctx, e.material, px + cell / 2, py + cell / 2, cell * 0.66);
  } else if (e.kind === 'cellar') {
    ctx.fillStyle = '#2f3542';
    ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
    ctx.strokeStyle = COLORS.cellar;
    ctx.lineWidth = Math.max(2, cell * 0.12);
    ctx.strokeRect(px + cell * 0.12, py + cell * 0.12, cell * 0.76, cell * 0.76);
    // What it holds, up to four icons in a 2x2 grid.
    const stock = e.stock ?? [];
    stock.forEach((id, i) => {
      const one = stock.length === 1, s = one ? cell * 0.66 : cell * 0.36;
      const cx = one ? 0.5 : i % 2 ? 0.7 : 0.3, cy = one ? 0.5 : i < 2 ? 0.3 : 0.7;
      drawItem(ctx, id, px + cell * cx, py + cell * cy, s);
    });
  } else if (e.kind === 'station' && usesSprite(e)) {
    const def = STATIONS[e.type], sprite = spriteFor(e), img = SPRITES[sprite.src], { w, h } = stationDims(e.type);
    const sx = cell / UNIT_PX.w, sy = cell / UNIT_PX.h;
    // Highlight: the station colour as a rounded square behind the art. The art
    // itself is always drawn opaque (even for unlocked stations) so the square
    // never shows through it.
    const m = cell * 0.08;
    ctx.fillStyle = def.color;
    roundRect(ctx, px + m, py + m, w * cell - 2 * m, h * cell - 2 * m, cell * 0.25);
    ctx.fill();
    ctx.save();
    ctx.globalAlpha = prevAlpha;
    ctx.imageSmoothingEnabled = sx < 1;
    ctx.drawImage(img, px + sprite.dx * sx, py + sprite.dy * sy, img.naturalWidth * sx, img.naturalHeight * sy);
    // Extensions on top: their art already leaves out what the station hides.
    for (const id of e.extensions ?? []) {
      const art = load(SPRITES, extensionArt(e, id), extensionArt(e, id));
      if (ready(art)) ctx.drawImage(art, px + EXTENSION_ART_FRAME.dx * sx, py + EXTENSION_ART_FRAME.dy * sy, art.naturalWidth * sx, art.naturalHeight * sy);
    }
    ctx.restore();
    drawStationLabel(ctx, e, px, py, w * cell, cell);
  } else if (e.kind === 'station') {
    const def = STATIONS[e.type];
    const { w, h } = stationDims(e.type);
    const m = cell * 0.08;
    ctx.fillStyle = def.color;
    roundRect(ctx, px + m, py + m, w * cell - 2 * m, h * cell - 2 * m, cell * 0.25);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.max(8, cell * 0.5)}px system-ui, sans-serif`;
    ctx.font = `600 ${Math.max(8, cell * 0.34)}px system-ui, sans-serif`;
    ctx.fillText(def.name, px + w * cell / 2, py + cell * 0.55);
    drawStationLabel(ctx, e, px, py, w * cell, cell);
  }
  ctx.globalAlpha = prevAlpha;
}

// Stations show their ports with recipe icons instead (see drawStationIO).
const KINDS_WITH_PORT_MARKERS = new Set(['distributor', 'cellar', 'splitter', 'underground']);

/** @param {Ctx} ctx @param {Entity} e @param {number} cell */
function drawUnderground(ctx, e, cell) {
  const cells = entityCells(e);
  const gap = cells.find((c) => c.gap);
  // Dashed tunnel under the gap cell.
  ctx.save();
  ctx.strokeStyle = COLORS.tunnel;
  ctx.lineWidth = Math.max(1.5, cell * 0.08);
  ctx.setLineDash([cell * 0.15, cell * 0.12]);
  const d = DIRS[e.rot];
  ctx.beginPath();
  for (const s of [-0.28, 0.28]) {
    const ox = d.dy ? s * cell : 0, oy = d.dx ? s * cell : 0;
    ctx.moveTo((gap.x + 0.5 - d.dx * 0.5) * cell + ox, (gap.y + 0.5 - d.dy * 0.5) * cell + oy);
    ctx.lineTo((gap.x + 0.5 + d.dx * 0.5) * cell + ox, (gap.y + 0.5 + d.dy * 0.5) * cell + oy);
  }
  ctx.stroke();
  ctx.restore();
  cells.forEach((c, i) => {
    if (c.gap) return;
    const m = cell * 0.06;
    ctx.fillStyle = COLORS.underground;
    ctx.fillRect(c.x * cell + m, c.y * cell + m, cell - 2 * m, cell - 2 * m);
    // Ramps: lighter at the ends where items enter/leave, darker next to the gap.
    const edge = i === 0 || i === cells.length - 1;
    drawChevron(ctx, (c.x + 0.5) * cell, (c.y + 0.5) * cell, e.rot, cell * 0.24, edge ? COLORS.beltArrow : COLORS.tunnel, cell * 0.09);
  });
}

/** @param {Ctx} ctx @param {Layout} layout @param {Entity} e @param {number} cell */
function drawPorts(ctx, layout, e, cell) {
  if (!KINDS_WITH_PORT_MARKERS.has(e.kind)) return;
  for (const p of layout.ports(e)) {
    const d = DIRS[p.dir];
    // Marker sits on the shared edge between the port cell and its neighbour.
    const cx = (p.x + 0.5 + d.dx * 0.5) * cell;
    const cy = (p.y + 0.5 + d.dy * 0.5) * cell;
    const pointDir = p.kind === 'in' ? (p.dir + 2) % 4 : p.dir;
    drawTriangle(ctx, cx, cy, pointDir, cell * 0.22, p.kind === 'in' ? COLORS.in : COLORS.out);
  }
}

/** @param {Ctx} ctx @param {RectDrag} r @param {number} cell */
function drawRectPreview(ctx, r, cell) {
  const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
  const w = Math.abs(r.x1 - r.x0) + 1, h = Math.abs(r.y1 - r.y0) + 1;
  ctx.fillStyle = 'rgba(30,144,255,0.18)';
  ctx.fillRect(x * cell, y * cell, w * cell, h * cell);
  ctx.strokeStyle = COLORS.select;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x * cell, y * cell, w * cell, h * cell);
}

/** @param {Ctx} ctx @param {string} material @param {number} cx @param {number} cy @param {number} r */
function drawMaterialDot(ctx, material, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = ITEM_BY_ID[material]?.color ?? 'transparent';
  ctx.fill();
  ctx.strokeStyle = ITEM_BY_ID[material] ? 'rgba(0,0,0,0.5)' : '#e5484d';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** @param {Ctx} ctx @param {number} cx @param {number} cy @param {number} dir @param {number} r @param {string} color @param {number} width */
function drawChevron(ctx, cx, cy, dir, r, color, width) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-r, r * 0.3);
  ctx.lineTo(0, -r * 0.7);
  ctx.lineTo(r, r * 0.3);
  ctx.stroke();
  ctx.restore();
}

/** @param {Ctx} ctx @param {number} cx @param {number} cy @param {number} dir @param {number} r @param {string} color */
function drawTriangle(ctx, cx, cy, dir, r, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r, r * 0.6);
  ctx.lineTo(-r, r * 0.6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Recipe ingredient icons on the input ports, product icon on the output port.
// Ingredients are shown in recipe order (a single ingredient on every input),
// unless the station records its port assignment in `inputs`.
/** @param {Ctx} ctx @param {Layout} layout @param {Entity} e @param {number} cell */
function drawStationIO(ctx, layout, e, cell) {
  const recipe = RECIPE_BY_ID[e.recipe];
  if (!recipe || cell < 10) return;
  const inputs = Object.entries(recipe.inputs);
  const [outId, outQty] = Object.entries(recipe.outputs)[0];
  const sprite = usesSprite(e);
  // Planned stations record which ingredient each input port takes (null = unused).
  const perPort = Array.isArray(e.inputs) ? e.inputs : null;
  let i = 0;
  for (const p of layout.ports(e)) {
    const d = DIRS[p.dir];
    // On the art, inputs (and a side output) sit on the hoppers just outside the
    // edge and a top output on its slot inside the port cell; on the plain box
    // both sit on the edge.
    const k = !sprite ? 0.5 : p.kind === 'in' || p.dir !== N ? 0.85 : 0;
    const cx = (p.x + 0.5 + d.dx * k) * cell, cy = (p.y + 0.5 + d.dy * k) * cell;
    let id, qty;
    if (p.kind === 'out') [id, qty] = [outId, outQty];
    else if (perPort) { const port = i++; id = perPort[port]; qty = recipe.inputs[id]; if (!id) continue; }
    else [id, qty] = inputs[i++ % inputs.length];
    drawPortItem(ctx, id, qty, cx, cy, cell, p.kind);
  }
}

/** @param {Ctx} ctx @param {string} id @param {number} qty @param {number} cx @param {number} cy @param {number} cell @param {'in' | 'out'} kind */
function drawPortItem(ctx, id, qty, cx, cy, cell, kind) {
  const r = cell * 0.36;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15,17,22,0.72)';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, cell * 0.05);
  ctx.strokeStyle = kind === 'in' ? COLORS.in : COLORS.out;
  ctx.stroke();
  drawItem(ctx, id, cx, cy, r * 1.7);
  if (qty > 1 && cell >= 16) {
    ctx.font = `700 ${Math.max(8, cell * 0.24)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(`${qty}`, cx + r * 1.05, cy + r * 1.05);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${qty}`, cx + r * 1.05, cy + r * 1.05);
  }
}

// Station art for the entity's level and layout, or undefined (e.g. the kitchen).
/** @param {Entity} e */
function spriteFor(e) {
  return STATIONS[e.type]?.sprites?.[e.level]?.[e.variant];
}

/** @param {Entity} e */
function usesSprite(e) {
  const sprite = spriteFor(e);
  return !!sprite && ready(SPRITES[sprite.src]);
}

// Painter's order: conveyors (belts, undergrounds, splitters) first as the
// floor layer, those crossing an underground's gap over it, then everything
// else on top. Within each layer by the footprint's bottom row, then top row
// (taller pieces first), then left to right.
const CONVEYOR_KINDS = new Set(['belt', 'underground', 'splitter']);
/** @param {Entity[]} entities @returns {Entity[]} */
export function drawOrder(entities) {
  const gaps = new Set(entities.flatMap((e) => entityCells(e).filter((c) => c.gap).map((c) => `${c.x},${c.y}`)));
  /** @param {Entity} e */
  const onGap = (e) => entityCells(e).some((c) => !c.gap && gaps.has(`${c.x},${c.y}`));
  const key = new Map(entities.map((e) => {
    const b = entityBounds(e);
    return [e, [CONVEYOR_KINDS.has(e.kind) ? (onGap(e) ? 0.5 : 0) : 1, b.y + b.h, b.y, b.x]];
  }));
  return [...entities].sort((a, b) => {
    const ka = key.get(a), kb = key.get(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || ka[3] - kb[3];
  });
}

// Flow lines over the conveyors: from each side that actually feeds a piece
// (or its back, if nothing does) through its centre to where it sends items,
// with an arrowhead there. Undergrounds are dashed where they run below.
/** @param {Ctx} ctx @param {Layout} layout @param {number} cell */
function drawFlow(ctx, layout, cell) {
  if (cell < 8) return;
  /** @type {(x: number, y: number) => [number, number]} */
  const mid = (x, y) => [(x + 0.5) * cell, (y + 0.5) * cell];
  /** @type {(x: number, y: number, d: number) => [number, number]} */
  const edge = (x, y, d) => [(x + 0.5 + DIRS[d].dx * 0.5) * cell, (y + 0.5 + DIRS[d].dy * 0.5) * cell];
  /** @type {[[number, number], [number, number]][]} */
  const segs = [], dashed = /** @type {[[number, number], [number, number]][]} */ ([]), heads = /** @type {[[number, number], number][]} */ ([]);
  // Sides feeding (x, y), as travel directions; the back (travel `rot`) when none.
  /** @type {(x: number, y: number, rot: number, sides: number[]) => number[]} */
  const inputs = (x, y, rot, sides) => {
    const fed = sides.filter((d) => fedFromBehind(layout, x, y, d));
    return fed.length ? fed : [rot];
  };
  for (const e of layout.entities) {
    if (e.kind === 'belt') {
      for (const d of inputs(e.x, e.y, e.rot, [e.rot, (e.rot + 1) % 4, (e.rot + 3) % 4])) segs.push([edge(e.x, e.y, (d + 2) % 4), mid(e.x, e.y)]);
      segs.push([mid(e.x, e.y), edge(e.x, e.y, e.rot)]);
      // Arrowheads only where a straight run ends, turns or hands over.
      const next = layout.entityAt(e.x + DIRS[e.rot].dx, e.y + DIRS[e.rot].dy);
      if (!(next?.kind === 'belt' && next.rot === e.rot)) heads.push([edge(e.x, e.y, e.rot), e.rot]);
    } else if (e.kind === 'splitter') {
      segs.push([edge(e.x, e.y, (e.rot + 2) % 4), mid(e.x, e.y)]);
      for (const d of [(e.rot + 1) % 4, (e.rot + 3) % 4]) {
        segs.push([mid(e.x, e.y), edge(e.x, e.y, d)]);
        heads.push([edge(e.x, e.y, d), d]);
      }
    } else if (e.kind === 'underground') {
      const cells = entityCells(e), exit = cells[cells.length - 1];
      const sides = [e.rot, (e.rot + 1) % 4, (e.rot + 3) % 4];
      for (const d of inputs(e.x, e.y, e.rot, sides)) segs.push([edge(e.x, e.y, (d + 2) % 4), mid(e.x, e.y)]);
      // The other belt cells only show what feeds them.
      for (const c of cells.slice(1)) {
        if (c.gap) continue;
        for (const d of sides) if (fedFromBehind(layout, c.x, c.y, d)) segs.push([edge(c.x, c.y, (d + 2) % 4), mid(c.x, c.y)]);
      }
      dashed.push([mid(e.x, e.y), mid(exit.x, exit.y)]);
      segs.push([mid(exit.x, exit.y), edge(exit.x, exit.y, e.rot)]);
      heads.push([edge(exit.x, exit.y, e.rot), e.rot]);
    }
  }
  const w = Math.max(1.5, cell * 0.06), a = cell * 0.13;
  /** @param {string} color @param {number} width */
  const stroke = (color, width) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [p, q] of segs) { ctx.moveTo(...p); ctx.lineTo(...q); }
    ctx.stroke();
    ctx.setLineDash([cell * 0.15, cell * 0.12]);
    ctx.beginPath();
    for (const [p, q] of dashed) { ctx.moveTo(...p); ctx.lineTo(...q); }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [[x, y], d] of heads) {
      const { dx, dy } = DIRS[d];
      ctx.beginPath();
      ctx.moveTo(x + dx * a * 0.4, y + dy * a * 0.4);
      ctx.lineTo(x - dx * a - dy * a * 0.7, y - dy * a + dx * a * 0.7);
      ctx.lineTo(x - dx * a + dy * a * 0.7, y - dy * a - dx * a * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  stroke(COLORS.flowShadow, w + 2);
  stroke(COLORS.flow, w);
  ctx.restore();
}

// Stocked items and filtered sides drawn over a chest.
/** @param {Ctx} ctx @param {Entity} e @param {number} px @param {number} py @param {number} cell */
function drawChestContents(ctx, e, px, py, cell) {
  const stock = e.stock ?? [];

    stock.slice(0, 3).forEach((id, i, arr) => {
      const cx = px + cell / 2 + (i - (arr.length - 1) / 2) * cell * 0.26;
      drawItem(ctx, id, cx, py + cell * 0.6, cell * (arr.length > 1 ? 0.4 : 0.66));
    });
    // Filtered sides: a strip in the filtered item's colour.
    for (const [side, id] of Object.entries(e.filters ?? {})) {
      const d = DIRS.find((dd) => dd.name === side);
      if (!d) continue;
      ctx.fillStyle = ITEM_BY_ID[id]?.color ?? '#e5484d';
      const t = cell * 0.12;
      const fx = d.dx > 0 ? px + cell - t : px, fy = d.dy > 0 ? py + cell - t : py;
      ctx.fillRect(d.dx ? fx : px + cell * 0.2, d.dy ? fy : py + cell * 0.2, d.dx ? t : cell * 0.6, d.dy ? t : cell * 0.6);
    }
}

// Game art for belts, undergrounds, splitters and chests; false until it has
// loaded (the caller then draws the plain shapes).
/** @param {Ctx} ctx @param {Layout} layout @param {Entity} e @param {number} cell */
function drawConveyorArt(ctx, layout, e, cell) {
  const pieces = conveyorPieces(layout, e);
  if (!pieces) return false;
  const imgs = pieces.map((p) => load(SPRITES, p.src, p.src));
  if (!imgs.every(ready)) return false;
  const sx = cell / UNIT_PX.w, sy = cell / UNIT_PX.h;
  ctx.save();
  ctx.imageSmoothingEnabled = sx < 1;
  pieces.forEach((p, i) => {
    const img = imgs[i];
    ctx.drawImage(img, p.x * cell + p.dx * sx, p.y * cell + p.dy * sy, img.naturalWidth * sx, img.naturalHeight * sy);
  });
  ctx.restore();
  return true;
}

// [{src, x, y, dx, dy}]: the images an entity is drawn with, from its connections.
/** @param {Layout} layout @param {Entity} e @returns {ArtPiece[] | null} */
function conveyorPieces(layout, e) {
  const dir = ART_DIRS[e.rot];
  /** @type {(x: number, y: number, shape: string) => ArtPiece} */
  const belt = (x, y, shape) => ({ src: `assets/conveyors/belt_${dir}_${shape}.webp`, x, y, dx: CONVEYOR_ART.belt[dir][shape][0], dy: CONVEYOR_ART.belt[dir][shape][1] });
  if (e.kind === 'belt') return [belt(e.x, e.y, lineShape(fedFromBehind(layout, e.x, e.y, e.rot), feedsAhead(layout, e, e.x, e.y, e.rot)))];
  if (e.kind === 'underground') {
    const cells = entityCells(e), exit = cells[cells.length - 1];
    const shape = fedFromBehind(layout, e.x, e.y, e.rot) ? 'center' : 'start';
    const [dx, dy] = CONVEYOR_ART.underground[dir][shape];
    return [
      { src: `assets/conveyors/underground_${dir}_${shape}.webp`, x: e.x, y: e.y, dx, dy },
      belt(exit.x, exit.y, feedsAhead(layout, e, exit.x, exit.y, e.rot) ? 'centre' : 'end'),
    ];
  }
  if (e.kind === 'splitter') {
    // Arms run across the travel direction: up/down for E/W, left/right for N/S.
    const vertical = e.rot % 2 === 1;
    const root = vertical ? 'down' : 'left';
    const [a, b] = vertical ? [0, 2] : [3, 1]; // up, down | left, right
    /** @param {number} d */
    const on = (d) => feedsAhead(layout, e, e.x, e.y, d);
    const shape = on(a) && on(b) ? 'centre' : on(b) ? `centre${ART_DIRS[a]}end` : on(a) ? `centre${ART_DIRS[b]}end` : 'end';
    const [dx, dy] = CONVEYOR_ART.splitter[root][shape];
    return [{ src: `assets/conveyors/splitter_${root}_${shape}.webp`, x: e.x, y: e.y, dx, dy }];
  }
  if (e.kind === 'supply_station') {
    const [dx, dy] = CONVEYOR_ART.supply_station[dir];
    return [{ src: `assets/conveyors/supply_station_${dir}.webp`, x: e.x, y: e.y, dx, dy }];
  }
  if (e.kind === 'chest') {
    const art = CHEST_LEVELS[e.level ?? 1]?.art;
    return art ? [{ src: art, x: e.x, y: e.y, dx: CHEST_ART_OFFSET[0], dy: CHEST_ART_OFFSET[1] }] : null;
  }
  return null;
}

/** @param {boolean} fed @param {boolean} feeds */
function lineShape(fed, feeds) {
  return fed ? (feeds ? 'centre' : 'end') : (feeds ? 'start' : 'single');
}

// Does something push into (x, y) from the cell behind it (travel direction d)?
// A chest feeds every neighbouring belt (or underground belt cell) that doesn't
// point into it, from its filtered sides (every side if it has no filters).
/** @param {Layout} layout @param {number} x @param {number} y @param {number} d @returns {boolean} */
function fedFromBehind(layout, x, y, d) {
  const bx = x - DIRS[d].dx, by = y - DIRS[d].dy;
  const src = layout.entityAt(bx, by);
  if (src?.kind === 'chest') {
    const filters = Object.keys(src.filters ?? {});
    return ['belt', 'underground'].includes(layout.entityAt(x, y)?.kind) && (!filters.length || filters.includes(DIRS[d].name));
  }
  return !!src && layout.ports(src).some((p) => p.kind === 'out' && p.x === bx && p.y === by && p.nx === x && p.ny === y);
}

// Does the cell ahead of (x, y) in direction d take items from here?
/** @param {Layout} layout @param {Entity} e @param {number} x @param {number} y @param {number} d @returns {boolean} */
function feedsAhead(layout, e, x, y, d) {
  const t = layout.entityAt(x + DIRS[d].dx, y + DIRS[d].dy);
  return !!t && t !== e && layout.acceptsFrom(t, x, y);
}

// "I · Iron Ingot" pill (level · product) in the middle of a station.
/** @param {Ctx} ctx @param {Entity} e @param {number} px @param {number} py @param {number} size @param {number} cell */
function drawStationLabel(ctx, e, px, py, size, cell) {
  if (cell < 10) return;
  const def = STATIONS[e.type];
  const recipe = RECIPE_BY_ID[e.recipe];
  const productId = recipe && Object.keys(recipe.outputs)[0];
  const product = recipe ? ITEM_BY_ID[productId]?.name ?? recipe.id : 'no recipe';
  const hgt = cell * 0.5;
  ctx.font = `600 ${Math.max(8, cell * 0.3)}px system-ui, sans-serif`;
  const text = ellipsize(ctx, `${ROMAN[e.level] ?? e.level} · ${product}`, size - cell * 0.3);
  const w = ctx.measureText(text).width + cell * 0.3;
  const x = px + (size - w) / 2, y = py + (stationDims(e.type).h * cell - hgt) / 2;
  ctx.fillStyle = 'rgba(15,17,22,0.8)';
  roundRect(ctx, x, y, w, hgt, hgt / 2);
  ctx.fill();
  ctx.fillStyle = recipe ? '#fff' : '#f5a524';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px + size / 2, y + hgt / 2 + 0.5);
  if (recipe && recipe.talent > 0 && cell >= 16) drawTalentChip(ctx, def.talent, recipe.talent, px + size / 2, y + hgt + cell * 0.08, cell);
}

// "5 [gear]" under the label: the worker talent level the recipe needs.
/** @param {Ctx} ctx @param {import('./types.js').StationDef['talent']} talent @param {number} level @param {number} cx @param {number} top @param {number} cell */
function drawTalentChip(ctx, talent, level, cx, top, cell) {
  const img = SPRITES[TALENTS[talent]?.icon];
  const hgt = cell * 0.42, icon = hgt * 0.86;
  ctx.font = `700 ${Math.max(8, cell * 0.28)}px system-ui, sans-serif`;
  const label = `${level}`;
  const w = ctx.measureText(label).width + icon + cell * 0.26;
  const x = cx - w / 2;
  ctx.fillStyle = 'rgba(15,17,22,0.8)';
  roundRect(ctx, x, top, w, hgt, hgt / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + cell * 0.1, top + hgt / 2 + 0.5);
  if (ready(img)) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x + w - icon - cell * 0.06, top + (hgt - icon) / 2, icon, icon);
    ctx.restore();
  }
}

/** @param {Ctx} ctx @param {string} text @param {number} maxWidth */
function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

/** @param {Ctx} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
