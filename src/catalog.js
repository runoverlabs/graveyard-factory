// @ts-check
// Game data: materials, items, stations and recipes.
// Everything the editor and (later) the planner know about the game lives here,
// so adjusting to the real game is a matter of editing this file only.

/** @typedef {import('./types.js').Dir} Dir */
/** @typedef {import('./types.js').DirInfo} DirInfo */
/** @typedef {import('./types.js').Entity} Entity */
/** @typedef {import('./types.js').EntitySpec} EntitySpec */
/** @typedef {import('./types.js').EntityKind} EntityKind */
/** @typedef {import('./types.js').StationType} StationType */
/** @typedef {import('./types.js').StationVariant} StationVariant */
/** @typedef {import('./types.js').StationDef} StationDef */
/** @typedef {import('./types.js').Item} Item */
/** @typedef {import('./types.js').Materials} Materials */
/** @typedef {import('./types.js').Recipe} Recipe */
/** @typedef {import('./types.js').Extension} Extension */
/** @typedef {import('./types.js').Sprite} Sprite */
/** @typedef {import('./types.js').Cell} Cell */
/** @typedef {import('./types.js').Bounds} Bounds */
/** @typedef {import('./types.js').FloorSection} FloorSection */
/** @typedef {[number, number]} Offset */
/**
 * fixed: part of the floor plan (in the wall, off the floor), never placed, moved or removed by hand.
 * feeds: pushes items out of its `rot` side into the cell in front, like a chest open on that side only.
 * @typedef {{ name: string, rotatable?: boolean, hasMaterial?: boolean, fixed?: boolean, feeds?: boolean }} EntityKindDef
 */
/** @typedef {{ name: string, icon: string }} TalentDef */
/** @typedef {{ name: string, slots: number, art: string }} ChestLevel */

// Directions, clockwise. Grid y grows downward, so "bottom of the layout" = high y.
export const N = 0, E = 1, S = 2, W = 3;
// In-game pixels per grid unit (units are not square on screen).
export const UNIT_PX = { w: 64, h: 48 };

/** @type {DirInfo[]} */
export const DIRS = [
  { id: N, name: 'N', dx: 0, dy: -1 },
  { id: E, name: 'E', dx: 1, dy: 0 },
  { id: S, name: 'S', dx: 0, dy: 1 },
  { id: W, name: 'W', dx: -1, dy: 0 },
];

// Raw materials: supplied by distribution stations or manually provisioned chests.
/** @type {Item[]} */
export const RAW_MATERIALS = [
  { id: 'stone', name: 'Stone', color: '#8d8d8d' },
  { id: 'iron_ore', name: 'Iron ore', color: '#b0643c' },
  { id: 'coal', name: 'Coal', color: '#2e2e2e' },
  { id: 'clay', name: 'Clay', color: '#c98a5a' },
  { id: 'sand', name: 'Sand', color: '#e2cb8a' },
  { id: 'marble', name: 'Marble', color: '#ece8df' },
  { id: 'wood_log', name: 'Log', color: '#7a5530' },
];

// Ingredients no factory recipe produces: they must be stocked in chests by hand.
/** @type {Item[]} */
export const EXTERNAL_ITEMS = [
  { id: 'bronze_nails', name: 'Bronze Nails', color: '#b8793b' },
  { id: 'special_wood', name: 'Special Wood', color: '#5e3b22' },
  { id: 'zombie_power', name: 'Zombie Power', color: '#7fc241' },
  { id: 'steel_ingot', name: 'Steel Ingot', color: '#7c8a99' },
  ...Object.entries({
    flax: 'Flax', wheat: 'Wheat', carrot: 'Carrot', beet: 'Beet', beer: 'Beer',
    cabbage_1: 'Cabbage ★', cabbage_2: 'Cabbage ★★', cabbage_3: 'Cabbage ★★★',
    onion_1: 'Onion ★', onion_2: 'Onion ★★', onion_3: 'Onion ★★★',
    pumpkin_1: 'Pumpkin ★', pumpkin_2: 'Pumpkin ★★', pumpkin_3: 'Pumpkin ★★★',
    wine_1: 'Wine ★', wine_2: 'Wine ★★', wine_3: 'Wine ★★★',
  }).map(([id, name]) => ({ id, name, color: hashColor(id) })),
];

// Factory products (intermediate and final). Names are the game's English ones.
const PRODUCT_NAMES = {
  iron_ingot: 'Iron Ingot', iron_kit_1: 'Iron Kit I', iron_kit_2: 'Iron Kit II',
  brick: 'Brick', glass: 'Glass', tableware: 'Tableware', glass_containers: 'Glass Containers',
  clay_molds: 'Clay Molds', engineering_kit: 'Engineering Kit', lens: 'Lens',
  wooden_kit_1: 'Wooden Kit I', wooden_kit_2: 'Wooden Kit II', stone_kit: 'Stone Kit', marble_kit: 'Marble Kit',
  crate: 'Crate', building_kit_1: 'Building Kit I', building_kit_2: 'Building Kit II',
  furniture_kit_1: 'Furniture Kit I', furniture_kit_2: 'Furniture Kit II',
  sculpture_kit_1: 'Sculpture Kit I', sculpture_kit_2: 'Sculpture Kit II', zombie_mechanism: 'Zombie Mechanism',
  supply_iron: 'Supply: Iron', supply_building_materials_1: 'Supply: Building materials I',
  supply_building_materials_2: 'Supply: Building materials II', supply_iron_tools: 'Supply: Iron Tools',
  supply_steel_tools: 'Supply: Steel Tools', supply_cutlery_1: 'Supply: Cutlery I', supply_cutlery_2: 'Supply: Cutlery II',
  supply_kitchen_utensils: 'Supply: Kitchen Utensils', supply_furniture_1: 'Supply: Furniture I',
  supply_furniture_2: 'Supply: Furniture II', supply_appliances_1: 'Supply: Appliances I',
  supply_appliances_2: 'Supply: Appliances II', supply_engineering_mechanism: 'Supply: Engineering Mechanism',
  fabric: 'Fabric', supply_fabric: 'Supply: Fabric', supply_clothes_1: 'Supply: Clothes I', supply_clothes_2: 'Supply: Clothes II',
  supply_vegetables: 'Supply: Vegetables', supply_beer: 'Supply: Beer', supply_wine: 'Supply: Wine',
  supply_flour: 'Supply: Flour Sack', supply_preserves_1: 'Supply: Preserves I', supply_preserves_2: 'Supply: Preserves II',
};
/** @type {Item[]} */
export const PRODUCTS = Object.entries(PRODUCT_NAMES).map(([id, name]) => ({ id, name, color: hashColor(id) }));

// Other items that can sit in chests but aren't used by factory recipes (yet),
// such as the materials pieces are built from (BUILD_COST, EXTENSIONS).
const OTHER_NAMES = {
  wood_wedge: 'Wood Wedge', wooden_plank: 'Wooden Plank', oiled_plank: 'Oiled Plank',
  reinforced_plank: 'Reinforced Plank', wooden_beam: 'Wooden Beam', piece_of_stone: 'Piece of Stone',
  carved_stone: 'Carved Stone', polished_marble: 'Polished Marble', bronze_detail: 'Bronze Detail',
  polished_bronze: 'Polished Bronze', bronze_gear: 'Bronze Gear', iron_nails: 'Iron Nails',
  iron_detail: 'Iron Detail', advanced_detail: 'Advanced Detail',
  steel_detail: 'Steel Detail', engineering_details: 'Engineering Details', steel_screws: 'Steel Screws',
  reinforced_beam: 'Reinforced Beam', wooden_joint: 'Wooden Joint', carved_wood: 'Carved Wood',
  polished_stone: 'Polished Stone', stick: 'Stick', leather_scroll: 'Leather Scroll',
};
/** @type {Item[]} */
export const OTHER_ITEMS = Object.entries(OTHER_NAMES).map(([id, name]) => ({ id, name, color: hashColor(id) }));

/** @type {Item[]} */
export const ITEMS = [...RAW_MATERIALS, ...EXTERNAL_ITEMS, ...PRODUCTS, ...OTHER_ITEMS];

// In-game icons (76x76, extracted from the game files) in assets/items/<id>.webp.
// Every item has one; a new item needs its icon added too (see docs/INTERNALS.md "Assets").
for (const item of ITEMS) item.icon = `assets/items/${item.id}.webp`;
/** @type {Record<string, Item>} */
export const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

// Port layouts of a 3x3 station, before rotation. (x, y) is the footprint cell
// holding the port, dir is the side it faces. Inputs accept items from a belt in
// the neighbouring cell pointing into the station; the output pushes items into
// the neighbouring cell.
//
//   out_top_left   out_top_right   in_left        in_right
//    ^ . .          . . ^           . . .          . . .
//    . . .          . . .          >. . .>        <. . .<
//    . . .          . . .          >. . .          . . .<
//    ^   ^          ^   ^
/** @type {Record<string, StationVariant>} */
export const STATION_VARIANTS = {
  out_top_left: {
    name: 'Inputs bottom, output top-left',
    ports: [
      { kind: 'in', x: 0, y: 2, dir: S }, { kind: 'in', x: 2, y: 2, dir: S },
      { kind: 'out', x: 0, y: 0, dir: N },
    ],
  },
  out_top_right: {
    name: 'Inputs bottom, output top-right',
    ports: [
      { kind: 'in', x: 0, y: 2, dir: S }, { kind: 'in', x: 2, y: 2, dir: S },
      { kind: 'out', x: 2, y: 0, dir: N },
    ],
  },
  in_left: {
    name: 'Inputs left, output right',
    ports: [
      { kind: 'in', x: 0, y: 1, dir: W }, { kind: 'in', x: 0, y: 2, dir: W },
      { kind: 'out', x: 2, y: 1, dir: E },
    ],
  },
  in_right: {
    name: 'Inputs right, output left',
    ports: [
      { kind: 'in', x: 2, y: 1, dir: E }, { kind: 'in', x: 2, y: 2, dir: E },
      { kind: 'out', x: 0, y: 1, dir: W },
    ],
  },
};
export const DEFAULT_VARIANT = 'out_top_left';

// The kitchen is 2x2 in the game (its prefab's colliders and connectors), with
// the inputs on top and the output at the bottom, or on the sides.
//
//   out_bottom_left   out_bottom_right   in_left    in_right
//    v v               v v                >. .>      <. .<
//    . .               . .                >. .        . .<
//    v                   v
/** @type {Record<string, StationVariant>} */
export const KITCHEN_VARIANTS = {
  out_bottom_left: {
    name: 'Inputs top, output bottom-left',
    ports: [
      { kind: 'in', x: 0, y: 0, dir: N }, { kind: 'in', x: 1, y: 0, dir: N },
      { kind: 'out', x: 0, y: 1, dir: S },
    ],
  },
  out_bottom_right: {
    name: 'Inputs top, output bottom-right',
    ports: [
      { kind: 'in', x: 0, y: 0, dir: N }, { kind: 'in', x: 1, y: 0, dir: N },
      { kind: 'out', x: 1, y: 1, dir: S },
    ],
  },
  in_left: {
    name: 'Inputs left, output right',
    ports: [
      { kind: 'in', x: 0, y: 0, dir: W }, { kind: 'in', x: 0, y: 1, dir: W },
      { kind: 'out', x: 1, y: 0, dir: E },
    ],
  },
  in_right: {
    name: 'Inputs right, output left',
    ports: [
      { kind: 'in', x: 1, y: 0, dir: E }, { kind: 'in', x: 1, y: 1, dir: E },
      { kind: 'out', x: 0, y: 0, dir: W },
    ],
  },
};

// The Bioreactor is 2 wide and 3 high, with one input in the middle row on one
// side and the output in the middle row on the other (confirmed by the user); it
// flips left to right.
//
//   in_left    in_right
//    . .        . .
//    >. >       < .<
//    . .        . .
/** @type {Record<string, StationVariant>} */
export const BIOREACTOR_VARIANTS = {
  in_left: {
    name: 'Input left, output right',
    ports: [{ kind: 'in', x: 0, y: 1, dir: W }, { kind: 'out', x: 1, y: 1, dir: E }],
  },
  in_right: {
    name: 'Input right, output left',
    ports: [{ kind: 'in', x: 1, y: 1, dir: E }, { kind: 'out', x: 0, y: 1, dir: W }],
  },
};

// Worker talents a station uses. A recipe's `talent` is the level of it the
// station's worker needs (the game's craft talentLock).
/** @type {Record<StationDef['talent'], TalentDef>} */
export const TALENTS = {
  gear: { name: 'Gear', icon: 'assets/ui/talent_red.webp' },
  hammer: { name: 'Hammer', icon: 'assets/ui/talent_orange.webp' },
  wheat: { name: 'Wheat', icon: 'assets/ui/talent_green.webp' },
};

// sprites[level][variant]: in-game art at 64x48 px per unit, rendered from the
// game's station prefabs (see docs/INTERNALS.md "Assets"). dx/dy is the sprite's top-left
// relative to the footprint's top-left in image pixels, from the prefab geometry;
// the overhang beyond the footprint (hoppers, chimney) is purely cosmetic.
// Offsets are listed in the order of the station's variants.
/**
 * @param {StationType} type
 * @param {Record<string, StationVariant>} variants
 * @param {Record<number, Offset[]>} offsets
 * @returns {Record<number, Record<string, Sprite>>}
 */
const stationSprites = (type, variants, offsets) => Object.fromEntries(Object.entries(offsets).map(([level, byVariant]) => [
  level,
  Object.fromEntries(Object.keys(variants).map((v, i) => [v, { src: `assets/stations/${type}_${level}_${v}.webp`, dx: byVariant[i][0], dy: byVariant[i][1] }])),
]));
/** @type {Record<StationType, StationDef>} */
export const STATIONS = {
  assembly_bench: {
    name: 'Assembly bench', short: 'ASM', color: '#4f7fd1', size: 3, levels: [1, 2, 3], talent: 'hammer',
    variants: STATION_VARIANTS,
    sprites: stationSprites('assembly_bench', STATION_VARIANTS, {
      1: [[-9, -9], [-2, -9], [-22, 26], [-22, 26]],
      2: [[-2, 20], [-2, 20], [-22, 26], [-22, 26]],
      3: [[-2, 20], [-2, 20], [-22, 26], [-22, 26]],
    }),
  },
  smithy: {
    name: 'Smithy', short: 'SMI', color: '#c9573b', size: 3, levels: [1, 2], talent: 'gear',
    variants: STATION_VARIANTS,
    sprites: stationSprites('smithy', STATION_VARIANTS, {
      1: [[-9, -14], [-4, -14], [-22, -14], [-22, -14]],
      2: [[-9, -40], [-4, -40], [-22, -40], [-22, -40]],
    }),
  },
  kitchen: {
    name: 'Kitchen', short: 'KIT', color: '#3d9d6a', size: 2, levels: [1, 2], talent: 'wheat',
    variants: KITCHEN_VARIANTS, defaultVariant: 'out_bottom_left',
    sprites: stationSprites('kitchen', KITCHEN_VARIANTS, {
      1: [[-7, -57], [-9, -57], [-22, -24], [-22, -24]],
      2: [[-7, -57], [-9, -57], [-22, -22], [-22, -22]],
    }),
  },
  // One level, no extensions, and no worker talent needed (the wheat icon is just its display talent).
  bioreactor: {
    name: 'Bioreactor', short: 'BIO', color: '#7fc241', size: 2, height: 3, levels: [1], talent: 'wheat',
    variants: BIOREACTOR_VARIANTS, defaultVariant: 'in_left',
    sprites: stationSprites('bioreactor', BIOREACTOR_VARIANTS, { 1: [[-22, -50], [-20, -50]] }),
  },
};
/** Footprint width and height of a station type, in cells. @type {(type: StationType) => { w: number, h: number }} */
export const stationDims = (type) => ({ w: STATIONS[type].size, h: STATIONS[type].height ?? STATIONS[type].size });
/** @type {(type: StationType) => Record<string, StationVariant>} */
export const stationVariants = (type) => STATIONS[type]?.variants ?? STATION_VARIANTS;
/** @type {(type: StationType) => string} */
export const defaultVariant = (type) => STATIONS[type]?.defaultVariant ?? DEFAULT_VARIANT;

// Station extensions (the game's workbench extensions). Each station has one
// small and one big slot, so it takes at most one extension of each size. The
// icon is the game's build icon; `build` is what it's built from (the game's
// building `needItems`; the Stove lists nothing).
/** @type {Extension['slot'][]} */
export const EXTENSION_SLOTS = ['small', 'big'];
/** @type {Record<string, Extension>} */
export const EXTENSIONS = {
  bellows: { name: 'Bellows', station: 'smithy', slot: 'small', build: { leather_scroll: 4, iron_detail: 2, wooden_plank: 4 } },
  hammer: { name: 'Hammer', station: 'smithy', slot: 'big', build: { wooden_beam: 2, iron_detail: 2, iron_ingot: 1 } },
  press: { name: 'Press', station: 'smithy', slot: 'big', build: { engineering_details: 2, steel_detail: 4, wooden_beam: 2 } },
  grindstone: { name: 'Grindstone', station: 'smithy', slot: 'big', build: { engineering_details: 2, steel_detail: 4, piece_of_stone: 1 } },
  auto_hammer: { name: 'Auto-hammer', station: 'assembly_bench', slot: 'small', build: { bronze_gear: 2, iron_detail: 6, iron_ingot: 2 } },
  spinning_wheel: { name: 'Spinning wheel', station: 'assembly_bench', slot: 'small', build: { bronze_gear: 2, wooden_plank: 4, iron_nails: 4 } },
  drill_press: { name: 'Drill press', station: 'assembly_bench', slot: 'big', build: { bronze_gear: 2, iron_detail: 4, wooden_beam: 2 } },
  sewing_machine: { name: 'Sewing machine', station: 'assembly_bench', slot: 'big', build: { wooden_joint: 4, steel_screws: 8, engineering_details: 4 } },
  lathe: { name: 'Lathe', station: 'assembly_bench', slot: 'big', build: { engineering_details: 4, steel_screws: 8, carved_wood: 2 } },
  millstone: { name: 'Millstone', station: 'kitchen', slot: 'small', build: { polished_stone: 2, stick: 4, iron_detail: 2 } },
  sealing_machine: { name: 'Sealing machine', station: 'kitchen', slot: 'small', build: { advanced_detail: 4, iron_ingot: 1, wooden_plank: 2 } },
  stove: { name: 'Stove', station: 'kitchen', slot: 'big', build: {} },
};
for (const [id, x] of Object.entries(EXTENSIONS)) x.icon = `assets/extensions/icons/${id}.webp`;
/** @type {(type: StationType) => string[]} */
export const extensionsFor = (type) => Object.keys(EXTENSIONS).filter((id) => EXTENSIONS[id].station === type);

// Extension art drawn over a station: one image per station level, layout and
// extension, rendered in the game's slot (and orientation) for that layout with
// the parts hidden behind the station removed. All share one frame whose
// top-left is (dx, dy) game pixels from the footprint's top-left.
export const EXTENSION_ART_FRAME = { dx: -32, dy: -80 };
/** @type {(e: Entity, id: string) => string} */
export const extensionArt = (e, id) => `assets/extensions/${e.type}_${e.level}_${e.variant}_${id}.webp`;
/** @type {Record<number, string>} */
export const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

// Factory recipes, from the game's craft definitions (conveyor crafts). levels:
// station levels that can run it. inputs/outputs: item id -> quantity per batch
// (outputs that scale with a worker perk use the base amount). time: seconds per
// batch. talent: worker talent level needed. tech: the tech that unlocks it.
// extension: the station extension it needs.
/**
 * @param {string} id
 * @param {StationType} station
 * @param {number[]} levels
 * @param {Record<string, number>} inputs
 * @param {Record<string, number>} outputs
 * @param {number | null} time
 * @param {number} talent
 * @param {string | null} tech
 * @param {string | null} [extension]
 * @returns {Recipe}
 */
const R = (id, station, levels, inputs, outputs, time, talent, tech, extension = null) =>
  ({ id, station, levels, inputs, outputs, time, talent, tech, extension });
/** @type {Recipe[]} */
export const RECIPES = [
  R('zombie_power', 'bioreactor', [1], { wheat: 5 }, { zombie_power: 1 }, 10, 0, 'Bioreactor'),
  R('supply_iron', 'assembly_bench', [1, 2, 3], { iron_ingot: 8 }, { supply_iron: 1 }, 10, 2, 'Check station access'),
  R('wooden_kit_1_nails', 'assembly_bench', [1, 2, 3], { wood_log: 1, bronze_nails: 4 }, { wooden_kit_1: 4 }, 12, 2, 'Assembly bench'),
  R('wooden_kit_1', 'assembly_bench', [1, 2, 3], { wood_log: 1 }, { wooden_kit_1: 4 }, 14, 3, 'Assembly bench: Auto-hammer', 'auto_hammer'),
  R('stone_kit', 'assembly_bench', [1, 2, 3], { stone: 2 }, { stone_kit: 1 }, 8, 2, 'Assembly bench'),
  R('crate', 'assembly_bench', [1, 2, 3], { wooden_kit_1: 1, iron_kit_1: 1 }, { crate: 2 }, 8, 3, 'Crate'),
  R('building_kit_1', 'assembly_bench', [1, 2, 3], { stone_kit: 1, brick: 1 }, { building_kit_1: 1 }, 8, 5, 'Building Kit I', 'auto_hammer'),
  R('supply_building_materials_1', 'assembly_bench', [1, 2, 3], { stone_kit: 1, brick: 1 }, { supply_building_materials_1: 1 }, 8, 5, 'Building Kit I', 'auto_hammer'),
  R('fabric', 'assembly_bench', [1, 2, 3], { flax: 16 }, { fabric: 1 }, 8, 4, 'Assembly bench: Spinning wheel', 'spinning_wheel'),
  R('supply_fabric', 'assembly_bench', [1, 2, 3], { flax: 16 }, { supply_fabric: 1 }, 8, 4, 'Assembly bench: Spinning wheel', 'spinning_wheel'),
  R('supply_iron_tools', 'assembly_bench', [2, 3], { crate: 1, iron_kit_1: 4 }, { supply_iron_tools: 1 }, 8, 5, 'Assembly bench II'),
  R('supply_cutlery_1', 'assembly_bench', [2, 3], { iron_kit_1: 4 }, { supply_cutlery_1: 1 }, 8, 5, 'Kitchen Supplies'),
  R('supply_kitchen_utensils', 'assembly_bench', [2, 3], { tableware: 4, glass_containers: 4 }, { supply_kitchen_utensils: 1 }, 8, 5, 'Kitchen Supplies'),
  R('furniture_kit_1', 'assembly_bench', [2, 3], { wooden_kit_1: 1, iron_kit_1: 1 }, { furniture_kit_1: 1 }, 6, 6, 'Furniture Kit I', 'drill_press'),
  R('supply_furniture_1', 'assembly_bench', [2, 3], { wooden_kit_1: 4, iron_kit_1: 4 }, { supply_furniture_1: 1 }, 12, 6, 'Furniture Kit I', 'drill_press'),
  R('supply_appliances_1', 'assembly_bench', [2, 3], { furniture_kit_1: 4, zombie_power: 1 }, { supply_appliances_1: 1 }, 12, 6, 'Appliances I'),
  R('marble_kit', 'assembly_bench', [2, 3], { marble: 2 }, { marble_kit: 1 }, 6, 6, 'Ways of Stone'),
  R('sculpture_kit_1', 'assembly_bench', [2, 3], { stone: 2 }, { sculpture_kit_1: 1 }, 6, 6, 'Ways of Stone'),
  R('supply_clothes_1', 'assembly_bench', [2, 3], { fabric: 12 }, { supply_clothes_1: 1 }, 12, 6, 'Clothes I', 'sewing_machine'),
  R('supply_clothes_2', 'assembly_bench', [3], { fabric: 16, iron_kit_2: 2 }, { supply_clothes_2: 1 }, 12, 8, 'Clothes II', 'sewing_machine'),
  R('wooden_kit_2', 'assembly_bench', [2, 3], { special_wood: 1 }, { wooden_kit_2: 3 }, 12, 7, 'Wooden Kit II', 'drill_press'),
  R('zombie_mechanism', 'assembly_bench', [2, 3], { engineering_kit: 1, zombie_power: 1 }, { zombie_mechanism: 1 }, 6, 7, 'Zombie Mechanisms', 'lathe'),
  R('supply_engineering_mechanism', 'assembly_bench', [2, 3], { engineering_kit: 2, zombie_power: 2 }, { supply_engineering_mechanism: 1 }, 12, 7, 'Zombie Mechanisms', 'lathe'),
  R('furniture_kit_2', 'assembly_bench', [3], { wooden_kit_2: 1, iron_kit_2: 1 }, { furniture_kit_2: 1 }, 8, 8, 'Furniture Kit II'),
  R('supply_furniture_2', 'assembly_bench', [3], { wooden_kit_2: 3, iron_kit_2: 3 }, { supply_furniture_2: 1 }, 12, 8, 'Furniture Kit II'),
  R('building_kit_2', 'assembly_bench', [3], { wooden_kit_2: 1, marble_kit: 1 }, { building_kit_2: 1 }, 6, 9, 'Building Kit II'),
  R('supply_building_materials_2', 'assembly_bench', [3], { wooden_kit_2: 4, marble_kit: 4 }, { supply_building_materials_2: 1 }, 12, 9, 'Building Kit II'),
  R('supply_appliances_2', 'assembly_bench', [3], { furniture_kit_2: 4, zombie_mechanism: 2 }, { supply_appliances_2: 1 }, 12, 9, 'Appliances II'),
  R('sculpture_kit_2', 'assembly_bench', [3], { marble: 4 }, { sculpture_kit_2: 1 }, 6, 9, 'Assembly bench III'),
  R('supply_cutlery_2', 'assembly_bench', [3], { iron_kit_2: 4 }, { supply_cutlery_2: 1 }, 12, 9, 'Assembly bench III'),
  R('iron_ingot', 'smithy', [1, 2], { iron_ore: 1, coal: 1 }, { iron_ingot: 1 }, 8, 2, 'Smithy: Hammer'),
  R('iron_kit_1', 'smithy', [1, 2], { iron_ingot: 1 }, { iron_kit_1: 4 }, 8, 3, 'Smithy: Hammer', 'hammer'),
  R('brick', 'smithy', [1, 2], { clay: 2, coal: 1 }, { brick: 2 }, 8, 2, 'Smithy I'),
  R('glass', 'smithy', [1, 2], { sand: 3, coal: 1 }, { glass: 1 }, 8, 2, 'Smithy I'),
  R('tableware', 'smithy', [1, 2], { clay: 2, coal: 1 }, { tableware: 1 }, 6, 4, 'Smithy: Bellows', 'bellows'),
  R('glass_containers', 'smithy', [1, 2], { sand: 2, coal: 1 }, { glass_containers: 1 }, 6, 4, 'Smithy: Bellows', 'bellows'),
  R('clay_molds', 'smithy', [2], { clay: 2, coal: 1 }, { clay_molds: 1 }, 6, 5, 'Smithy II'),
  R('iron_kit_2', 'smithy', [2], { iron_ingot: 1, clay_molds: 2 }, { iron_kit_2: 4 }, 12, 5, 'Smithy II', 'bellows'),
  R('engineering_kit', 'smithy', [2], { steel_ingot: 1, clay_molds: 2 }, { engineering_kit: 1 }, 6, 6, 'Steel Works', 'bellows'),
  R('supply_steel_tools', 'smithy', [2], { steel_ingot: 4, crate: 1 }, { supply_steel_tools: 1 }, 12, 6, 'Steel Works', 'bellows'),
  R('lens', 'smithy', [2], { sand: 3, coal: 2 }, { lens: 1 }, 6, 7, 'Lenses', 'press'),
  R('supply_vegetables_carrot', 'kitchen', [1, 2], { crate: 1, carrot: 16 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_beet', 'kitchen', [1, 2], { crate: 1, beet: 12 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_cabbage_1', 'kitchen', [1, 2], { crate: 1, cabbage_1: 10 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_cabbage_2', 'kitchen', [1, 2], { crate: 1, cabbage_2: 8 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_cabbage_3', 'kitchen', [1, 2], { crate: 1, cabbage_3: 6 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_onion_1', 'kitchen', [1, 2], { crate: 1, onion_1: 8 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_onion_2', 'kitchen', [1, 2], { crate: 1, onion_2: 6 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_onion_3', 'kitchen', [1, 2], { crate: 1, onion_3: 4 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_pumpkin_1', 'kitchen', [1, 2], { crate: 1, pumpkin_1: 3 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_pumpkin_2', 'kitchen', [1, 2], { crate: 1, pumpkin_2: 2 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_vegetables_pumpkin_3', 'kitchen', [1, 2], { crate: 1, pumpkin_3: 1 }, { supply_vegetables: 1 }, 8, 3, 'Vegetable Supplies'),
  R('supply_beer', 'kitchen', [1, 2], { beer: 12 }, { supply_beer: 1 }, 6, 3, 'Brewing'),
  R('supply_wine_1', 'kitchen', [1, 2], { wine_1: 8 }, { supply_wine: 1 }, 6, 5, 'Winemaking'),
  R('supply_wine_2', 'kitchen', [1, 2], { wine_2: 6 }, { supply_wine: 1 }, 6, 5, 'Winemaking'),
  R('supply_wine_3', 'kitchen', [1, 2], { wine_3: 4 }, { supply_wine: 1 }, 6, 5, 'Winemaking'),
  R('supply_flour', 'kitchen', [1, 2], { wheat: 16, fabric: 2 }, { supply_flour: 1 }, 10, 4, 'Flour Supplies', 'millstone'),
  R('supply_preserves_1_carrot', 'kitchen', [1, 2], { glass_containers: 1, carrot: 16 }, { supply_preserves_1: 1 }, 8, 6, 'Preservation Supplies', 'sealing_machine'),
  R('supply_preserves_1_beet', 'kitchen', [1, 2], { glass_containers: 1, beet: 12 }, { supply_preserves_1: 1 }, 8, 6, 'Preservation Supplies', 'sealing_machine'),
  R('supply_preserves_1_cabbage_1', 'kitchen', [1, 2], { glass_containers: 1, cabbage_1: 10 }, { supply_preserves_1: 1 }, 8, 6, 'Preservation Supplies', 'sealing_machine'),
  R('supply_preserves_1_cabbage_2', 'kitchen', [1, 2], { glass_containers: 1, cabbage_2: 8 }, { supply_preserves_1: 1 }, 8, 6, 'Preservation Supplies', 'sealing_machine'),
  R('supply_preserves_1_cabbage_3', 'kitchen', [1, 2], { glass_containers: 1, cabbage_3: 6 }, { supply_preserves_1: 1 }, 8, 6, 'Preservation Supplies', 'sealing_machine'),
  R('supply_preserves_2_onion_1', 'kitchen', [2], { glass_containers: 1, onion_1: 10 }, { supply_preserves_2: 1 }, 8, 8, 'Preservation Supplies II', 'sealing_machine'),
  R('supply_preserves_2_onion_2', 'kitchen', [2], { glass_containers: 1, onion_2: 8 }, { supply_preserves_2: 1 }, 8, 8, 'Preservation Supplies II', 'sealing_machine'),
  R('supply_preserves_2_onion_3', 'kitchen', [2], { glass_containers: 1, onion_3: 6 }, { supply_preserves_2: 1 }, 8, 8, 'Preservation Supplies II', 'sealing_machine'),
  R('supply_preserves_2_pumpkin_1', 'kitchen', [2], { glass_containers: 1, pumpkin_1: 4 }, { supply_preserves_2: 1 }, 8, 8, 'Preservation Supplies II', 'sealing_machine'),
  R('supply_preserves_2_pumpkin_2', 'kitchen', [2], { glass_containers: 1, pumpkin_2: 3 }, { supply_preserves_2: 1 }, 8, 8, 'Preservation Supplies II', 'sealing_machine'),
  R('supply_preserves_2_pumpkin_3', 'kitchen', [2], { glass_containers: 1, pumpkin_3: 2 }, { supply_preserves_2: 1 }, 8, 8, 'Preservation Supplies II', 'sealing_machine'),
];
/** @type {Record<string, Recipe>} */
export const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

/**
 * @param {StationType} stationType
 * @param {number} level
 * @returns {Recipe[]}
 */
export function recipesFor(stationType, level) {
  return RECIPES.filter((r) => r.station === stationType && r.levels.includes(level));
}

// Stable, distinct-enough colour per item id.
/** @param {string} id */
function hashColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 45%, ${45 + (h >> 9) % 20}%)`;
}

// Entity kinds that can be placed on the floor.
//   belt         1x1, moves items towards `rot`. Belts never cross.
//   underground  1x5 from its entry cell (x, y) towards `rot`: 2 cells, a gap, 2 cells.
//                Items leave in front of the exit cell. The four cells around the
//                gap work like belts: they take items from behind and from the
//                sides (belts, chests, distributors). A belt, a chest or another
//                underground's belt cell may sit on the gap.
//   splitter     1x1, takes items from behind (travelling towards `rot`) and sends
//                them out to both sides.
//   chest        1x1, accepts items from any side (a distributor or a station's
//                top/bottom output can push straight into it; a side output needs a belt) and outputs, round-robin, onto every
//                neighbouring belt that doesn't point into it (alongside ones too) on
//                its filtered sides, or on every side when it has no filters,
//                and it never feeds a station input directly. `filters` picks the item sent out of each side
//                keyed N/E/S/W (unset = any); `stock` lists items the player provisions by hand.
//   distributor  1x1 raw-material source, outputs towards `rot`.
//   cellar       1x1 source of beer and wine (`stock`, chosen by the player),
//                all mixed onto the one belt it feeds towards `rot`.
//   supply_station 1x1 sink for "Supply: ..." crates (the game's Supply Station),
//                taking items from the neighbouring cell on its `rot` side.
//   porter       1 wide, 2 high Zombie Supply Porter: one for every 3 supply stations, no ports
//   station      3x3, fixed orientation; `variant` picks the port layout.
/** @type {Record<EntityKind, EntityKindDef>} */
export const ENTITY_KINDS = {
  belt: { name: 'Conveyor belt', rotatable: true },
  underground: { name: 'Underground conveyor', rotatable: true },
  splitter: { name: 'Conveyor splitter', rotatable: true },
  chest: { name: 'Chest' },
  distributor: { name: 'Distribution station', rotatable: true, hasMaterial: true, fixed: true, feeds: true },
  cellar: { name: 'Cellar', fixed: true, feeds: true },
  supply_station: { name: 'Supply station', rotatable: true },
  porter: { name: 'Zombie Supply Porter' },
  station: { name: 'Station' },
};

// Conveyor art from the game's conveyor prefabs, at 64x48 px per unit:
// assets/conveyors/<kind>_<dir>_<shape>.webp, drawn with its top-left at [dx, dy]
// game pixels from the cell's top-left. Straight belts come as start, centre,
// end or single pieces (a line's caps overhang the cell); a turn is the start of
// the new line. An underground's art covers its first four cells (drawn from the
// entry cell); its exit cell is a plain belt, as in the game. Splitters show an
// end cap on each output with nothing attached; `vertical` has arms up and down
// (items travelling east or west).
/** @type {string[]} */
export const ART_DIRS = ['up', 'right', 'down', 'left']; // by rot: N E S W
/**
 * @type {{
 *   belt: Record<string, Record<string, Offset>>,
 *   underground: Record<string, Record<string, Offset>>,
 *   supply_station: Record<string, Offset>,
 *   splitter: Record<string, Record<string, Offset>>,
 * }}
 */
export const CONVEYOR_ART = {
  belt: {
    up: { start: [0, 0], centre: [0, 0], end: [0, -18], single: [0, -18] },
    right: { start: [-18, 0], centre: [0, 0], end: [0, 0], single: [-18, 0] },
    down: { start: [0, -14], centre: [0, 0], end: [0, 0], single: [0, -14] },
    left: { start: [0, 0], centre: [0, 0], end: [-22, 0], single: [-22, 0] },
  },
  underground: {
    up: { start: [0, -144], center: [0, -144] },
    right: { start: [-18, -24], center: [0, -24] },
    down: { start: [0, -14], center: [0, 0] },
    left: { start: [-192, -24], center: [-192, -24] },
  },
  supply_station: { up: [-2, -16], right: [-2, -26], down: [-2, -16], left: [0, -26] }, // input side
  splitter: {
    down: { centre: [0, 0], centreupend: [-2, -18], centredownend: [-2, 0], end: [-2, -18] },
    left: { centre: [0, -2], centreleftend: [-22, -2], centrerightend: [0, -2], end: [-22, -2] },
  },
};

// Conveyor chests: art, and stack slots from the game's inventory size.
/** @type {Record<number, ChestLevel>} */
export const CHEST_LEVELS = {
  1: { name: 'Conveyor Chest I', slots: 5, art: 'assets/chests/chest_1.webp' },
  2: { name: 'Conveyor Chest II', slots: 10, art: 'assets/chests/chest_2.webp' },
};
/** @type {Offset} */
export const CHEST_ART_OFFSET = [-4, -32];

// "Supply: ..." items are delivered to a supply station rather than a chest.
// The planner pulls supply stations (and the makers of supply items) towards this row segment.
// The Zombie Supply Porter (1 wide, 2 high; from the user): one per 3 supply stations, built
// from `PORTER.build` (the game's `zombie_conveyor_transporter_station_p`). The planner puts them at x0..x1 on row `y` (the top cell; it also takes
// the row below). It uses no power (from the user).
export const PORTER = { stationsEach: 3, row: { x0: 23, x1: 29, y: 24 }, build: { wooden_plank: 4, iron_nails: 8, iron_detail: 2 } };
/** @type {(supplyStations: number) => number} */
export const portersFor = (supplyStations) => Math.ceil(supplyStations / PORTER.stationsEach);
export const SUPPLY_ZONE = { x0: 23, x1: 31, y: 27 };
/** @type {(x: number, y: number) => number} cells from the zone (0 on it) */
export const supplyZoneDistance = (x, y) => Math.abs(y - SUPPLY_ZONE.y) + Math.max(0, SUPPLY_ZONE.x0 - x, x - SUPPLY_ZONE.x1);
/** @type {(id: string) => boolean} */
export const isSupplyItem = (id) => id.startsWith('supply_');

// Factory power (the gear in the game's UI) each placed piece uses: 2 for an
// underground conveyor (confirmed by the user). Kinds not listed cost nothing.
// The icon is the game's power gear, tinted yellow.
/** @type {Partial<Record<import('./types.js').EntityKind, number>>} */
// Chests and the Zombie Supply Porter use none (from the user).
export const POWER_COST = { station: 1, belt: 1, underground: 2 };
export const POWER_ICON = 'assets/ui/power.webp';

// What each piece is built from (item id -> count), from the game's building
// definitions (`needItems` of `conveyor_cell_cp`, `conveyor_<station>_t<level>_place_p`
// and so on). Each station and chest level has its own build, not an upgrade of
// the level below. Extensions are in EXTENSIONS; the fixed pieces (distributors,
// the cellar) aren't built.
/**
 * @type {{
 *   belt: Materials, underground: Materials, splitter: Materials, supply_station: Materials, porter: Materials,
 *   chest: Record<number, Materials>, station: Record<StationType, Record<number, Materials>>,
 * }}
 */
export const BUILD_COST = {
  belt: { bronze_gear: 1, fabric: 1 },
  underground: { bronze_gear: 4, fabric: 2 },
  splitter: { bronze_gear: 3, fabric: 1 },
  supply_station: { bronze_gear: 4, iron_detail: 6, wooden_beam: 2 },
  porter: PORTER.build,
  chest: {
    1: { bronze_gear: 2, bronze_detail: 4, wooden_plank: 2 },
    2: { bronze_gear: 4, advanced_detail: 4, wooden_joint: 2 },
  },
  station: {
    assembly_bench: {
      1: { reinforced_plank: 6, bronze_gear: 4, bronze_detail: 4 },
      2: { reinforced_beam: 6, bronze_gear: 8, advanced_detail: 6 },
      3: { wooden_joint: 6, steel_screws: 12, engineering_details: 4 },
    },
    smithy: {
      1: { reinforced_plank: 6, bronze_detail: 4, bronze_gear: 4 },
      2: { reinforced_beam: 6, steel_screws: 12, engineering_details: 4 },
    },
    kitchen: {
      1: { reinforced_plank: 6, bronze_gear: 4, bronze_detail: 4 },
      2: { reinforced_beam: 4, bronze_gear: 8, advanced_detail: 8 },
    },
    bioreactor: { 1: { glass: 10, bronze_gear: 8, advanced_detail: 6 } },
  },
};

// Power comes from zombies on the factory's zombie carousels. They're fixed
// (outside the floor plan, none can be built), 5 of them with 4 zombies each, so
// at most 20 zombies: 200 power, or 400 with the Belt Master perk (confirmed by
// the user; game version 1.010 raised it from 7 and 10 per zombie).
export const ZOMBIE_POWER = { perZombie: 10, perZombieBeltMaster: 20, zombiesPerCarousel: 4, carousels: 5 };
export const BELT_MASTER_ICON = 'assets/ui/perk_beltmaster.webp';

// The factory floor is the game's `conveyor` world zone, made of ten build areas
// (`gd_conveyor_zone_build_area_<id>`), each a few BoxCollider rectangles. They
// are given here in grid cells: column = (x + 120) / 0.64, row = (−392.7 − z) / 0.6
// from world x, z. Some edges fall on half cells, and a cell is floor only when
// the rectangles of the sections in use cover all of it (that reproduces the
// floor the user confirmed). Sections 6, 7, 9 and 10 are there from the start.
// The others start disabled: the craft `conv_pins_repair_<id>` on the section's
// Broken Conveyor Mechanism (`conveyor_place_pins_<id>_broken`) enables them.
// `repair` lists that craft's materials (item id -> count).
/** @type {FloorSection[]} */
export const FLOOR_SECTIONS = [
  { id: 1, name: 'Far north-west', repair: { bronze_gear: 4, polished_bronze: 2 },
    rects: [[1, 0, 10.5, 10.5], [1, 10.5, 10.5, 12.5]] },
  { id: 2, name: 'Far north', repair: { bronze_gear: 4, advanced_detail: 4, polished_bronze: 2 },
    rects: [[10.5, 0, 20, 10.5], [10.5, 10.5, 20, 12.5]] },
  { id: 3, name: 'North-west', repair: { engineering_details: 4, steel_detail: 4, steel_screws: 8 },
    rects: [[1, 14, 10.5, 26.5], [1, 12.5, 10.5, 14], [0, 14, 1, 15]] },
  { id: 4, name: 'North', repair: { engineering_details: 4, steel_detail: 4, steel_screws: 8 },
    rects: [[10.5, 14, 20, 26.5], [10.5, 12.5, 20, 14]] },
  { id: 5, name: 'West', repair: { bronze_gear: 4, advanced_detail: 4, polished_bronze: 2 },
    rects: [[4, 26.5, 10.5, 38.5], [4, 38.5, 10.5, 40.5], [1, 26.5, 4, 36]] },
  { id: 6, name: 'Centre', rects: [[10.5, 28, 21.5, 40.5], [10.5, 26.5, 20, 28]] },
  { id: 7, name: 'East',
    rects: [[23, 24, 32, 39.5], [21.5, 28, 23, 40.5], [23, 39.5, 32, 40.5], [32, 27.5, 35, 36], [32, 36, 33, 38]] },
  { id: 8, name: 'South-west', repair: { bronze_gear: 4, polished_bronze: 2 },
    rects: [[1, 42, 10.5, 53], [4, 40.5, 10.5, 42]] },
  { id: 9, name: 'South', rects: [[10.5, 40.5, 21.5, 53]] },
  { id: 10, name: 'South-east', rects: [[21.5, 40.5, 32, 53]] },
];
// Cells inside a section that aren't factory floor: a column stands there.
export const FLOOR_HOLES = [{ x: 29, y: 41 }, { x: 30, y: 41 }];
// The fixed floor plan's grid; every section fits in it.
export const FLOOR_GRID = { width: 42, height: 55 };

// The factory's distribution stations: in the bottom wall, one row below the
// floor (the `conveyor_place_module_cells_1` slots), each feeding north into
// the floor's bottom row (confirmed by the user). They can't be built or moved.
/** @type {{ x: number, y: number, material: string }[]} */
export const FACTORY_DISTRIBUTORS = [
  { x: 3, y: 53, material: 'marble' },
  { x: 7, y: 53, material: 'iron_ore' },
  { x: 11, y: 53, material: 'coal' },
  { x: 15, y: 53, material: 'clay' },
  { x: 19, y: 53, material: 'sand' },
  { x: 23, y: 53, material: 'stone' },
  { x: 27, y: 53, material: 'wood_log' },
];
// Three garden distributors in the top wall, one row above the floor, each feeding
// south into the floor's top row. Each is set by the player to one of the garden's
// crops (`GARDEN_ITEMS`); the planner sets the ones left empty. They can't be built or
// moved either. `GARDEN_PICKER` is where the strip of crop icons to pick from floats.
/** @type {{ x: number, y: number, rot: import('./types.js').Dir }[]} */
export const FACTORY_GARDEN_DISTRIBUTORS = [
  { x: 1, y: -1, rot: S },
  { x: 3, y: -1, rot: S },
  { x: 5, y: -1, rot: S },
];
export const GARDEN_ITEMS = ['wheat', 'carrot', 'beet', 'onion_1', 'onion_2', 'onion_3', 'pumpkin_1', 'pumpkin_2', 'pumpkin_3', 'cabbage_1', 'cabbage_2', 'cabbage_3'];
export const GARDEN_PICKER = { x: 1, y: -2 };
// The cellar (the game's `conveyor_wine_beer_pallet`): in the west wall, just
// off the grid, feeding east into the one-cell nook at 0,14 of the North-west
// section (confirmed by the user). It holds beer and wine of each quality, and
// puts whatever it holds onto that belt, so more than one item needs a chest
// with filters to sort them out.
/** @type {{ x: number, y: number, rot: import('./types.js').Dir }} */
export const FACTORY_CELLAR = { x: -1, y: 14, rot: E };
export const CELLAR_ITEMS = ['beer', 'wine_1', 'wine_2', 'wine_3'];
// The cell a distributor (or the cellar) feeds may stay empty, or hold a belt or one of an
// underground conveyor's belt cells (not its gap), neither pointing back into
// the distributor; nothing else (confirmed by the user). A distributor feeds it
// like a chest with one side.
/** @type {import('./types.js').EntityKind[]} */
export const DISTRIBUTOR_FRONT_KINDS = ['belt', 'underground'];

// Belts can be fed from their sides (merging), confirmed in-game.
export const BELT_ACCEPTS_FROM_SIDES = true;
// Must the underground conveyor's gap cell be factory floor?
export const UNDERGROUND_GAP_MUST_BE_FLOOR = true;
// What may sit on an underground conveyor's gap cell (it runs below): a belt
// crossing it, a chest, or one of another underground's belt cells (never its
// gap); confirmed by the user.
/** @type {import('./types.js').EntityKind[]} */
export const UNDERGROUND_GAP_KINDS = ['belt', 'chest', 'underground'];
export const UNDERGROUND_LENGTH = 5;
export const UNDERGROUND_GAP = 2; // index of the gap cell along the conveyor

// All cells of an entity's shape: [{x, y, gap}]. Gap cells are not occupied.
/**
 * @param {EntitySpec} e
 * @returns {Cell[]}
 */
export function entityCells(e) {
  if (e.kind === 'station') {
    const { w, h } = stationDims(e.type);
    const cells = [];
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push({ x: e.x + dx, y: e.y + dy, gap: false });
    return cells;
  }
  if (e.kind === 'underground') {
    const d = DIRS[e.rot];
    return Array.from({ length: UNDERGROUND_LENGTH }, (_, i) => ({ x: e.x + d.dx * i, y: e.y + d.dy * i, gap: i === UNDERGROUND_GAP }));
  }
  if (e.kind === 'porter') return [{ x: e.x, y: e.y, gap: false }, { x: e.x, y: e.y + 1, gap: false }];
  return [{ x: e.x, y: e.y, gap: false }];
}

// Bounding box of an entity's shape.
/**
 * @param {EntitySpec} e
 * @returns {Bounds}
 */
export function entityBounds(e) {
  const cells = entityCells(e);
  const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
}
