// Data model. All map geometry is stored in projected metres (UTM: x east, y north). The board transform
// (core/transform.ts) maps metres to board millimetres; changing the board size rescales everything.

export type Pt = [number, number]

export interface BoardSpec {
  id: string            // "kord"
  name: string          // "Chicago O'Hare International"
  icao: string
  iata: string
  elevationFt: number
  widthMm: number
  heightMm: number
  marginMm: number      // blank border between the map frame and the board edge
  cornerRadiusMm: number
  refLat: number        // airport reference point
  refLon: number
  utmZone: number
  north: boolean
}

export interface MapFrame {
  minx: number
  miny: number
  maxx: number
  maxy: number
}

/** Artwork layers: top silkscreen, exposed top copper, bottom silkscreen (Bottom Overlay). Geometry on silkBack is in
 *  the same board frame as everything else (seen from the top); labels on it are drawn mirrored so they read from the
 *  back (their rotation is the one seen from the back). */
export type ArtLayer = 'silk' | 'copper' | 'silkBack'

export type PolyClass = 'pavement' | 'runway' | 'apron' | 'stopway' | 'terminal' | 'building' | 'parking' | 'custom'
export interface HatchSpec {
  angleDeg: number      // hatch line direction, visual CCW from +x
  pitchMm: number
  cross: boolean        // second set of lines at +90 degrees
  widthMm: number       // line width
}
export const DEFAULT_HATCH: HatchSpec = { angleDeg: 45, pitchMm: 0.9, cross: false, widthMm: 0.15 }
export interface PolyFeature {
  id: string
  cls: PolyClass | string
  src?: string
  name?: string
  rings: Pt[][]         // exterior first, then holes
  layer?: ArtLayer                   // default silk (terminals: copper)
  fill?: 'none' | 'solid' | 'hatch'  // default none (terminals: hatch)
  hatch?: HatchSpec
  strokeMm?: number     // outline width override (0 = no outline)
  locked?: boolean
  visible?: boolean
}

export type LineClass = 'taxiway' | 'taxilane' | 'runway_cl' | 'road_major' | 'road' | 'road_minor' | 'rail' | 'custom' | string
export interface LineFeature {
  id: string
  cls: LineClass        // known classes above, or a source key (see SourceSpec)
  src?: string          // source spec that generated it (regenerated on "apply sources" unless locked); 'rwy-end': generated end chevron (locked)
  part?: 'line' | 'edge' | 'centre' | 'dash' | 'tick' | 'outline'
  name?: string         // taxiway ref, road name
  pts: Pt[]
  layer?: ArtLayer
  sub?: 'axis' | 'marking' | 'arrow'   // runway_cl: axis (the runway centreline) vs marking
  widthM?: number       // runway width (axis lines)
  widthMm?: number      // stroke width override
  locked?: boolean
  visible?: boolean
}

export type LedClass = 'runway' | 'taxiway' | 'ramp' | 'gate'
export type LedRole = '' | 'junction' | 'entry' | 'hold'
export type LedSize = 1.5 | 1.1 | 1.0
export interface Led {
  id: string
  cls: LedClass
  role: LedRole
  size: LedSize
  pos: Pt               // metres
  rotDeg: number        // visual CCW from +X (board frame, north up) == CCW from east in metres
  label?: string        // gate name(s), taxiway ref, runway designator
  feature?: string      // feature this LED belongs to ("10L/28R", "B", "ramp")
  alsoFeatures?: string[] // further features (a runway-crossing LED belongs to both runways)
  locked?: boolean      // exclude from automatic re-placement
  // data chain (PCB tab): chain / chainIndex as last computed by the generator; chainUser = the user put the LED on
  // this chain (kept by the chain builder); chainLocked = its position in the chain is fixed too
  chain?: number
  chainIndex?: number
  chainUser?: boolean
  chainLocked?: boolean
}

export interface Label {
  id: string
  text: string
  pos: Pt               // metres, anchor point
  heightM: number       // letter height in ground metres (scales with the board)
  rotDeg: number
  layer: ArtLayer       // silkBack: mirrored on the board so it reads from the back; rotDeg as seen from the back
  weight: 400 | 600
  anchor: 'start' | 'middle' | 'end'
  boxed?: boolean       // taxiway sign style: outlined box
  tracking?: number     // extra letter spacing as a fraction of the cap height (the ORD board's map labels: 0.18)
  kind?: 'runway' | 'taxiway' | 'terminal' | 'title' | 'road' | 'designator' | 'custom'
  locked?: boolean
  src?: string          // generator tag ('rwy-end': runway end designator, replaced when the end markings are regenerated)
}

/** A block pose for the Altium generator (board mm, top-left origin, y down). Edge blocks (MCU with its antenna,
 *  USB-C) sit on `edge` at position `t` (x along top/bottom, y along left/right); free blocks (DCDC) at x, y, rot. */
export interface PcbBlockPose {
  name: string
  edge?: 'top' | 'bottom' | 'left' | 'right'
  t?: number
  x?: number
  y?: number
  rot?: number
}
export interface PcbSettings {
  template?: string          // Altium template project folder (default: the generator's bundled template)
  blocks: PcbBlockPose[]     // explicit poses; blocks not listed are auto-placed by the generator
  channels?: number          // LED data channels (1..7, CH0 = status LEDs)
  routeData?: boolean
  ledArtMargin?: number      // silk printed over an LED body is removed with this clearance (mm)
  zip?: boolean
  outDir?: string            // last export folder
  fwId?: string              // firmware board id for ../flightboard (boards/<id>.json); default: the board id
  backSilkClearVias?: boolean // cut the back silk around vias (default off: vias are tented)
}

/** Imported back silkscreen art (Bottom Overlay), e.g. the old Chicago street map: many polygons stored compactly and
 *  drawn as one path. Board mm, origin top-left, y down, exactly as printed on the Bottom Overlay in the board's own
 *  (top view) coordinates, so text in it reads mirrored from the front and correctly from the back. Edited only as a
 *  whole (translate, mirror, clear, replace); see core/backart.ts for the encoding. */
export interface BackArt {
  source: string             // where it came from (file name and key)
  format: 'um-varint/1'
  data: string               // base64, see core/backart.ts
  count: number              // polygons
  points: number
  areaMm2: number            // sum of the polygon areas (holes subtracted)
  bounds: [number, number, number, number] // x0, y0, x1, y1 before the offset
  offset: Pt                 // translation applied on top of the data (mm)
  locked: boolean            // no translate / mirror / clear while locked
  visible: boolean           // shown and exported (with the Layers "Back silk" toggle)
  opacity: number            // editor opacity in the front view (the back view shows it at full strength)
  importedAt?: string
}

/** How runway ends are marked. 'classic': the build's threshold bars, the stopway (EMAS / blast pad) outlines and the
 *  designators on the runway; 'chevrons': a double-line chevron past each end with the designator inside it (number
 *  over side letter), the stopway outlines and the runway text removed. */
export interface EndChevronStyle {
  direction: 'outward' | 'inward' // apex pointing away from the runway, or toward it
  strokeMm: number    // each of the two strokes
  gapMm: number       // clear space between the two strokes
  span: number        // opening width as a multiple of the runway width
  depth: number       // apex to opening as a multiple of the span (capped by the room to the board edge)
  offsetMm: number    // from the pavement end to the chevron
  textMaxMm: number   // largest designator cap height (the text is fitted inside, smaller when it must be)
}
export interface RunwayMarkingStyle {
  endStyle: 'classic' | 'chevrons'
  chevron: EndChevronStyle
  removeStopways: boolean     // drop the stopway outlines (EMAS / blast pads) at the ends
  removeRunwayNames: boolean  // drop the "RUNWAY 09C – 27C" labels beside the runways
}
export const DEFAULT_END_CHEVRON: EndChevronStyle = { direction: 'outward', strokeMm: 0.18, gapMm: 0.18, span: 1.25, depth: 1.6, offsetMm: 0.4, textMaxMm: 1.6 }
export const DEFAULT_RUNWAY_MARKINGS: RunwayMarkingStyle = { endStyle: 'classic', chevron: DEFAULT_END_CHEVRON, removeStopways: true, removeRunwayNames: true }

export interface SnapSettings {
  grid: boolean
  gridMm: number
  objects: boolean      // LED centres, label anchors, line/polygon vertices
  lines: boolean        // nearest point on a centreline / edge
  guides: boolean       // smart alignment guides against nearby objects
  angle: boolean        // rotation in steps
  angleStepDeg: number
  tolerancePx: number
}
export const DEFAULT_SNAP: SnapSettings = { grid: false, gridMm: 0.5, objects: true, lines: true, guides: true, angle: true, angleStepDeg: 15, tolerancePx: 8 }

export interface PlacementSettings {
  runwayPitchMm: number
  twyPitchMm: number
  lanePitchMm: number
  junctionRadiusTwyMm: number
  junctionRadiusLaneMm: number
  clusterMm: number
  holdOffM: number
  gateOffM: number
  gateMinPitchMm: number
  sizeRunway: LedSize
  sizeTaxiway: LedSize
  sizeRamp: LedSize
  sizeGate: LedSize
  minSepMm: number
}

export const DEFAULT_PLACEMENT: PlacementSettings = {
  runwayPitchMm: 6.5,
  twyPitchMm: 6.0,
  lanePitchMm: 4.0,
  junctionRadiusTwyMm: 3.0,
  junctionRadiusLaneMm: 2.4,
  clusterMm: 3.5,
  holdOffM: 55,
  gateOffM: 37,
  gateMinPitchMm: 2.4,
  sizeRunway: 1.5,
  sizeTaxiway: 1.5,
  sizeRamp: 1.0,
  sizeGate: 1.0,
  minSepMm: 2.6
}

export interface SourceInfo {
  osmFetchedAt?: string
  osmElements?: number
  faaFetchedAt?: string
  faaLayers?: Record<string, number>
  overpassUrl?: string
}

// ---------------------------------------------------------------- configurable data sources
export type StyleMode = 'single' | 'edges' | 'edges+centre' | 'dashed' | 'dotted' | 'ticks' | 'outline'
export interface LineStyle {
  mode: StyleMode
  widthMm: number          // stroke of the main line (single/dashed/dotted/ticks/outline) or of the centre line
  edgeWidthMm?: number     // stroke of edge lines (edges modes)
  laneM?: number           // metres per lane: road width = max(lanes * laneM, minWidthM); lanes from OSM or defaultLanes
  defaultLanes?: number
  minWidthM?: number
  laneDashes?: boolean     // dashes between lanes (edges modes)
  dashM?: [number, number] // dash / gap in ground metres (dashed, dotted, lane dashes)
  tickM?: [number, number] // pitch / half length in metres (ticks)
}
export interface SourceSpec {
  key: string              // feature class / layer key
  label: string
  enabled: boolean
  kind: 'line' | 'polygon'
  filter: string           // Overpass tag filter(s), e.g. ["highway"~"^(motorway|trunk)$"]
  color: string            // editor colour
  layer: 'silk' | 'copper'
  style: LineStyle
  landsideOnly?: boolean   // drop ways that run mostly inside the aerodrome (airside service roads)
  dropTags?: string        // "key=v1|v2;key2=v" -> elements with these tag values are skipped
  minLengthM?: number
  minAreaM2?: number
  clipAirside?: boolean    // cut under pavement, terminals and buildings
}
export const DEFAULT_SOURCES: SourceSpec[] = [
  { key: 'motorway', label: 'Motorways', enabled: true, kind: 'line', filter: '["highway"~"^(motorway|trunk)$"]', color: '#9aa1ad', layer: 'silk', clipAirside: true,
    style: { mode: 'edges', widthMm: 0.12, edgeWidthMm: 0.15, laneM: 3.7, defaultLanes: 3, minWidthM: 8, laneDashes: true, dashM: [3, 9] } },
  { key: 'motorway_link', label: 'Motorway ramps', enabled: true, kind: 'line', filter: '["highway"~"^(motorway_link|trunk_link)$"]', color: '#8a9098', layer: 'silk', clipAirside: true,
    style: { mode: 'edges', widthMm: 0.12, edgeWidthMm: 0.12, laneM: 3.7, defaultLanes: 1, minWidthM: 5, laneDashes: true, dashM: [3, 9] } },
  { key: 'road_primary', label: 'Primary / secondary roads', enabled: true, kind: 'line', filter: '["highway"~"^(primary|secondary|primary_link|secondary_link)$"]', color: '#8a9098', layer: 'silk', clipAirside: true,
    style: { mode: 'edges+centre', widthMm: 0.10, edgeWidthMm: 0.12, laneM: 3.5, defaultLanes: 2, minWidthM: 6 } },
  { key: 'road_local', label: 'Local roads', enabled: true, kind: 'line', filter: '["highway"~"^(tertiary|unclassified|residential)$"]', color: '#6f757f', layer: 'silk', clipAirside: true, minLengthM: 60,
    style: { mode: 'single', widthMm: 0.12 } },
  { key: 'road_service', label: 'Service roads (landside)', enabled: true, kind: 'line', filter: '["highway"~"^(service|busway)$"]', color: '#565c66', layer: 'silk', clipAirside: true, landsideOnly: true, minLengthM: 80,
    dropTags: 'service=parking_aisle|driveway|alley|drive-through|emergency_access;tunnel=yes', style: { mode: 'single', widthMm: 0.10 } },
  { key: 'rail', label: 'Rail', enabled: true, kind: 'line', filter: '["railway"="rail"]', color: '#7a6f5a', layer: 'silk', clipAirside: true, dropTags: 'service=yard|spur|siding|crossover;usage=industrial',
    style: { mode: 'ticks', widthMm: 0.12, tickM: [20, 6] } },
  { key: 'rail_light', label: 'People mover / light rail', enabled: true, kind: 'line', filter: '["railway"~"^(light_rail|monorail|tram)$"]', color: '#8f8a7a', layer: 'silk', clipAirside: false,
    style: { mode: 'dashed', widthMm: 0.15, dashM: [12, 5] } },
  { key: 'subway', label: 'Subway', enabled: true, kind: 'line', filter: '["railway"="subway"]', color: '#7a7a8a', layer: 'silk', clipAirside: false,
    style: { mode: 'dotted', widthMm: 0.12, dashM: [3, 6] } },
  { key: 'parking', label: 'Parking garages', enabled: true, kind: 'polygon', filter: '["amenity"="parking"]["parking"~"^(multi-storey|garage|rooftop)$"]', color: '#6d7380', layer: 'silk', clipAirside: true,
    style: { mode: 'outline', widthMm: 0.10 } },
  { key: 'parking_lots', label: 'Surface parking lots', enabled: false, kind: 'polygon', filter: '["amenity"="parking"]["parking"="surface"]', color: '#5a5f68', layer: 'silk', minAreaM2: 8000, clipAirside: true,
    style: { mode: 'outline', widthMm: 0.08 } },
  { key: 'water', label: 'Water', enabled: true, kind: 'polygon', filter: '["natural"="water"]', color: '#5a7a9a', layer: 'silk', minAreaM2: 3000,
    style: { mode: 'outline', widthMm: 0.10 } },
  { key: 'waterway', label: 'Rivers and creeks', enabled: true, kind: 'line', filter: '["waterway"~"^(river|stream|canal)$"]', color: '#5a7a9a', layer: 'silk', minLengthM: 100, clipAirside: true,
    style: { mode: 'single', widthMm: 0.10 } }
]

export interface Project {
  version: 1
  board: BoardSpec
  frame: MapFrame
  polys: PolyFeature[]
  lines: LineFeature[]
  leds: Led[]
  labels: Label[]
  placement: PlacementSettings
  layerVisibility: Record<string, boolean>
  source: SourceInfo
  sources?: SourceSpec[]   // configurable landside data sources (defaults when missing)
  pcb?: PcbSettings        // Altium generator settings: template, block poses, options (PCB tab)
  aerodrome?: Pt[][]       // airport property boundary rings (metres), for the landside-only filter
  backArt?: BackArt        // imported Bottom Overlay art (the hand-drawn back art is ordinary features on layer silkBack)
  runwayMarkings?: RunwayMarkingStyle // runway end style (default: classic)
}

// Stroke widths (mm) per class, from the ORD generator
export const LINE_WIDTH: Record<string, number> = {
  taxiway: 0.13,
  taxilane: 0.13,
  runway_cl: 0.15,
  road_major: 0.35,
  road: 0.18,
  road_minor: 0.12,
  rail: 0.15,
  custom: 0.15,
  pavement: 0.18,
  runway: 0.25,
  apron: 0.18,
  stopway: 0.12,
  terminal: 0.25,
  building: 0.15,
  parking: 0.12
}

export const LAYER_NAMES: { key: string; label: string }[] = [
  { key: 'pavement', label: 'Pavement' },
  { key: 'runway', label: 'Runways' },
  { key: 'stopway', label: 'Stopways / blast pads' },
  { key: 'terminal', label: 'Terminals (copper hatch)' },
  { key: 'building', label: 'Buildings' },
  { key: 'taxiway', label: 'Taxiway centrelines' },
  { key: 'taxilane', label: 'Apron lanes' },
  { key: 'runway_cl', label: 'Runway markings' },
  { key: 'custom', label: 'Custom lines and polygons' },
  { key: 'labels', label: 'Labels' },
  { key: 'leds', label: 'LEDs' },
  { key: 'backsilk', label: 'Back silk (bottom overlay)' }
]

let counter = 0
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e9
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`
}
