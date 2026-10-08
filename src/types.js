// @ts-check
// Shared JSDoc types. Nothing here runs: other modules import these with
// `@typedef {import('./types.js').Entity} Entity` (or `import('../types.js')`).

/** Direction id: 0 = N, 1 = E, 2 = S, 3 = W (grid y grows downward). @typedef {0 | 1 | 2 | 3} Dir */
/** Side name used for chest filters. @typedef {'N' | 'E' | 'S' | 'W'} SideName */
/** @typedef {{ id: Dir, name: SideName, dx: number, dy: number }} DirInfo */

/** Terrain cell: '.' floor, ' ' outside. @typedef {string} Terrain */

/** @typedef {'belt' | 'underground' | 'splitter' | 'chest' | 'distributor' | 'cellar' | 'station' | 'supply_station' | 'porter'} EntityKind */
/** @typedef {'assembly_bench' | 'smithy' | 'kitchen' | 'bioreactor'} StationType */

/**
 * A placed piece. One shape for every kind; the kind decides which optional
 * fields apply (see ENTITY_KINDS in catalog.js).
 * @typedef {object} Entity
 * @property {number} id
 * @property {EntityKind} kind
 * @property {number} x top-left cell (entry cell for undergrounds)
 * @property {number} y
 * @property {boolean} [locked] the planner must keep it
 * @property {boolean} [planned] placed by the planner
 * @property {number} [rot] belts, undergrounds, splitters: travel direction; distributors and the cellar: output side; supply stations: input side
 * @property {string} [material] distributor: raw material id (a garden distributor: the crop it's set to, '' for none)
 * @property {boolean} [garden] distributor: one of the garden's, set to a crop by the player or the planner
 * @property {boolean} [autoMaterial] garden distributor: the planner set its crop
 * @property {StationType} [type] station
 * @property {number} [level] station level, or chest level (1 | 2)
 * @property {string} [variant] station port layout (see stationVariants)
 * @property {string | null} [recipe] station recipe id
 * @property {string[]} [extensions] station: fitted extension ids (one per slot)
 * @property {(string | null)[]} [inputs] planned station: item taken by each input port
 * @property {string[]} [stock] chest: items provisioned by hand; cellar: the beer and wine it holds
 * @property {Partial<Record<SideName, string>>} [filters] chest: item sent out of each side
 * @property {'supply' | 'output' | 'hub' | 'pass'} [role] planned chest
 */

/** Entity fields as passed to `Layout.add` (no id yet). @typedef {Omit<Entity, 'id'> & { id?: number }} EntitySpec */

/** @typedef {{ x: number, y: number, gap: boolean }} Cell */
/** @typedef {{ x: number, y: number, w: number, h: number }} Bounds */

/** Port in footprint coordinates (catalog). @typedef {{ kind: 'in' | 'out', x: number, y: number, dir: Dir }} PortDef */
/** Port in world coordinates; (nx, ny) is the neighbouring cell it connects to. @typedef {PortDef & { nx: number, ny: number }} Port */
/** @typedef {{ name: string, ports: PortDef[] }} StationVariant */

/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} name
 * @property {string} color fallback swatch colour
 * @property {string} [icon] image path
 */

/**
 * @typedef {object} Recipe
 * @property {string} id
 * @property {StationType} station
 * @property {number[]} levels station levels that can run it
 * @property {Record<string, number>} inputs item id -> quantity per batch
 * @property {Record<string, number>} outputs item id -> quantity per batch
 * @property {number | null} time seconds per batch
 * @property {number} talent worker talent level needed
 * @property {string | null} tech tech that unlocks it
 * @property {string | null} extension extension id it needs
 */

/** @typedef {{ src: string, dx: number, dy: number }} Sprite */

/**
 * @typedef {object} StationDef
 * @property {string} name
 * @property {string} short
 * @property {string} color
 * @property {number} size footprint side in cells
 * @property {number} [height] footprint rows, when it isn't `size` (a Bioreactor is `size` 2 wide and 3 high)
 * @property {number[]} levels
 * @property {'gear' | 'hammer' | 'wheat'} talent
 * @property {Record<string, StationVariant>} variants
 * @property {string} [defaultVariant]
 * @property {Record<number, Record<string, Sprite>>} [sprites] level -> variant -> art
 */

/** @typedef {{ name: string, station: StationType, slot: 'small' | 'big', icon?: string }} Extension */

/**
 * A section of the factory floor (one of the game's conveyor build areas).
 * @typedef {object} FloorSection
 * @property {number} id the game's build area number
 * @property {string} name where it is
 * @property {[number, number, number, number][]} rects x0, y0, x1, y1 in grid cells (edges may be half cells)
 * @property {Record<string, number>} [repair] repair materials, item id -> count; absent for sections there from the start
 */

/**
 * @typedef {object} Issue
 * @property {'error' | 'warning' | 'info'} severity
 * @property {number | null} entityId
 * @property {string} message
 * @property {[number, number][]} cells
 */

/** Canvas view: cell size in CSS px, pan offset, device pixel ratio. @typedef {{ cell: number, ox: number, oy: number, dpr: number }} View */

/** Planner targets: item and rate per minute, and the recipe to make it with if chosen. @typedef {{ item: string, rate: number, recipe?: string }} Target */

/**
 * Options for planProduction.
 * @typedef {object} ProductionOptions
 * @property {Partial<Record<StationType, number>>} [maxLevel] best level the player has per station type
 * @property {Record<string, string>} [recipeChoice] item id -> recipe id
 * @property {Record<string, number>} [craftsPerMinute] recipe id -> crafts per minute per station
 * @property {Set<string>} [distributors] items with a distribution station or the cellar (default: every raw material)
 */

/**
 * @typedef {object} PlannedRecipe
 * @property {string} recipe
 * @property {string} item the output it's used for
 * @property {StationType} station
 * @property {number | null} level
 * @property {number} crafts per minute
 * @property {number} craftsPerStation per minute
 * @property {number} stations
 * @property {number} output items per minute
 * @property {Record<string, number>} inputs item id -> items per minute
 */

/**
 * Result of planProduction.
 * @typedef {object} ProductionPlan
 * @property {Record<string, number>} final item id -> rate
 * @property {PlannedRecipe[]} recipes producers first
 * @property {Record<string, { rate: number, source: 'distributor' | 'chest' }>} supply
 * @property {number} stations
 * @property {string[]} errors
 */

/** @typedef {{ items: Record<string, string>, stations: Record<string, string>, extensions: Record<string, string>, talents: Record<string, string> }} NameTable */

export {};
