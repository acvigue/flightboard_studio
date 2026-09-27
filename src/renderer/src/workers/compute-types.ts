// Messages between the page and the compute worker (workers/compute.worker.ts). Only data crosses: projects,
// OSM elements and results are structured-cloned; JSTS geometry never leaves the worker.
import type { Airport } from '../core/airports'
import type { BuildOptions, BuildResult } from '../core/build'
import type { FaaData } from '../core/faa'
import type { OsmData, OsmElement } from '../core/osm'
import type { GateNode } from '../core/place'
import type { CollisionResult } from '../core/labels'
import type { BackArt, Label, Led, LineFeature, PolyFeature, Project, SourceSpec } from '../core/model'
import type { PcbJob } from '../core/pcbjob'

export interface ComputeOps {
  /** Build a project from the downloaded airport data. */
  build: {
    args: { airport: Airport; osm: OsmData; faa: FaaData | null; opts: BuildOptions; specs: SourceSpec[] }
    result: { project: Project & { gates?: GateNode[] }; log: BuildResult['log'] }
  }
  /** Automatic LED placement (locked LEDs are kept by placeAll). */
  place: { args: { project: Project; gates: GateNode[] }; result: { leds: Led[]; summary: string; merged: Record<string, number> } }
  /** Regenerate labels (locked ones kept), designators and the north arrow, then resolve collisions. */
  labels: { args: { project: Project }; result: { labels: Label[]; northArrow: LineFeature; result: CollisionResult } }
  /** Move labels clear of LEDs and each other. */
  resolve: { args: { project: Project; dropUnplaceable: boolean }; result: { labels: Label[]; result: CollisionResult } }
  /** Landside art from cached OSM elements. */
  sources: {
    args: { project: Pick<Project, 'board' | 'frame' | 'polys' | 'aerodrome' | 'sources'>; elements: OsmElement[] }
    result: { lines: LineFeature[]; polys: PolyFeature[]; counts: Record<string, number> }
  }
  /** Board / lights JSON and the artwork SVGs. */
  export: { args: { project: Project }; result: { name: string; content: string }[] }
  /** The Altium generator's job (LEDs, poses, chain edits, art as polygons). */
  pcbjob: { args: { project: Project }; result: PcbJob }
  /** Parse a back-art file into the project's compact form (core/backart.ts). */
  backart: { args: { text: string; name: string; prev?: Partial<BackArt> }; result: { art: BackArt; notes: string[]; boardMm?: [number, number] } }
}
export type OpName = keyof ComputeOps

export type ToWorker = { id: number; op: OpName; args: unknown }
export type FromWorker =
  | { id: number; type: 'progress'; msg: string }
  | { id: number; type: 'done'; result: unknown; ms: number }
  | { id: number; type: 'error'; error: string; stack?: string }
