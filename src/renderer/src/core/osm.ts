// OpenStreetMap via Overpass. Queries are kept small so public mirrors answer them:
//   1. aeroway features around the reference point (runways, taxiways, aprons, terminals, gates, aerodrome)
//   2. buildings inside the aerodrome area only (map_to_area of the aerodrome relation/way)
//   3. landside roads / rail / parking inside the map frame, fetched in ~2.5 km tiles with pauses
// Every response is cached in the app's user data folder.
export interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  tags?: Record<string, string>
  lat?: number
  lon?: number
  geometry?: { lat: number; lon: number }[]
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[]
}
export interface OsmData {
  aero: OsmElement[]
  landside: OsmElement[]
  fetchedAt: string
  url: string
}
export interface LLBox {
  south: number
  west: number
  north: number
  east: number
}
export type Log = (s: string) => void
import type { SourceSpec } from './model'
import { overpassBody, sourcesHash } from './sources'

// Endpoints are tried in order; the list is editable in the Sources panel (stored in localStorage). Measured from
// this network (2026-09): the NextGIS instance and mail.ru answer in seconds, kumi is often overloaded,
// private.coffee hangs, overpass-api.de refuses with 406. The last mirror that worked is tried first.
export const DEFAULT_MIRRORS = [
  'https://overpass.nextgis.com/my-h0KrOP1YL178RNkSQRVAaIE4g9neFVXF/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
]
const MIRRORS_KEY = 'flightboard.overpass'
export function getMirrors(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MIRRORS_KEY) ?? 'null')
    if (Array.isArray(v) && v.length) return v.filter((x) => typeof x === 'string' && x.startsWith('http'))
  } catch {
    /* ignore */
  }
  return DEFAULT_MIRRORS
}
export function setMirrors(list: string[]): void {
  localStorage.setItem(MIRRORS_KEY, JSON.stringify(list.filter((x) => x.trim().startsWith('http')).map((x) => x.trim())))
  preferred = null
}
let preferred: string | null = null
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function overpass(query: string, log: Log, label: string): Promise<{ elements: OsmElement[]; url: string }> {
  let lastErr = ''
  const MIRRORS = getMirrors()
  const order = preferred && MIRRORS.includes(preferred) ? [preferred, ...MIRRORS.filter((m) => m !== preferred)] : MIRRORS
  // two rounds: an overloaded mirror (504) often answers a minute later
  for (const url of [...order, ...order]) {
    const host = new URL(url).hostname.replace(/^overpass\./, '')
    const t0 = performance.now()
    const r = await window.api.fetchText(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh) FlightboardStudio/0.1'
      },
      timeoutMs: 60000
    })
    const dt = ((performance.now() - t0) / 1000).toFixed(1)
    if (r.ok) {
      try {
        const j = JSON.parse(r.text)
        if (Array.isArray(j.elements)) {
          if (j.remark && /timed out|runtime error/i.test(j.remark)) {
            lastErr = `remark: ${j.remark}`
          } else {
            log(`${label}: ${j.elements.length} elements from ${host} in ${dt}s`)
            preferred = url
            return { elements: j.elements, url }
          }
        } else lastErr = 'no elements'
      } catch (e) {
        lastErr = String(e).slice(0, 80)
      }
    } else lastErr = `HTTP ${r.status}${r.status === 0 ? ' ' + r.text.slice(0, 60) : ''}`
    if (r.status === 406 || r.status === 400) {
      log(`${label}: ${host} refused (${lastErr}), trying next mirror`)
      continue
    }
    log(`${label}: ${host} failed after ${dt}s (${lastErr}), trying next mirror`)
    await sleep(3000)
  }
  throw new Error(`${label}: every Overpass mirror failed (${lastErr})`)
}

async function cached<T>(key: string, force: boolean, log: Log, label: string, fn: () => Promise<T>): Promise<T> {
  if (!force) {
    const c = await window.api.cacheGet(key)
    if (c) {
      log(`${label}: cached`)
      return JSON.parse(c)
    }
  }
  const v = await fn()
  await window.api.cachePut(key, JSON.stringify(v))
  return v
}

export async function fetchAeroway(icao: string, lat: number, lon: number, radiusM: number, log: Log, force = false): Promise<OsmData> {
  return cached(`osm_aero_${icao}_${radiusM}_v2`, force, log, 'OSM aeroway', async () => {
    // an indexed bbox query: the (around:) form on nwr is far slower on the public mirrors
    const dLat = radiusM / 111132
    const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180))
    const b = `${(lat - dLat).toFixed(4)},${(lon - dLon).toFixed(4)},${(lat + dLat).toFixed(4)},${(lon + dLon).toFixed(4)}`
    const q = `[out:json][timeout:45];(way["aeroway"](${b});node["aeroway"](${b});rel["aeroway"="aerodrome"](${b}););out geom;`
    const { elements, url } = await overpass(q, log, 'OSM aeroway')
    return { aero: elements, landside: [], fetchedAt: new Date().toISOString(), url }
  })
}

/** The aerodrome polygon element: the one whose bounding box contains the reference point (largest if several), else the largest. */
export function findAerodrome(elements: OsmElement[], lat?: number, lon?: number): OsmElement | null {
  let best: OsmElement | null = null
  let bestSpan = 0
  let bestHome: OsmElement | null = null
  let bestHomeSpan = 0
  for (const e of elements) {
    if (e.tags?.aeroway !== 'aerodrome' || (e.type !== 'relation' && e.type !== 'way')) continue
    const pts = e.type === 'way' ? (e.geometry ?? []) : (e.members ?? []).flatMap((m) => m.geometry ?? [])
    if (!pts.length) continue
    const lats = pts.map((p) => p.lat)
    const lons = pts.map((p) => p.lon)
    const span = (Math.max(...lats) - Math.min(...lats)) * (Math.max(...lons) - Math.min(...lons))
    const contains = lat !== undefined && lon !== undefined && lat >= Math.min(...lats) && lat <= Math.max(...lats) && lon >= Math.min(...lons) && lon <= Math.max(...lons)
    if (contains && span > bestHomeSpan) {
      bestHomeSpan = span
      bestHome = e
    }
    if (span > bestSpan) {
      bestSpan = span
      best = e
    }
  }
  return bestHome ?? best
}

export async function fetchBuildings(icao: string, aerodrome: OsmElement | null, bb: LLBox, log: Log, force = false): Promise<OsmElement[]> {
  const areaId = aerodrome ? (aerodrome.type === 'relation' ? 3600000000 + aerodrome.id : 2400000000 + aerodrome.id) : 0
  return cached(`osm_bld_${icao}_${areaId || 'bbox'}`, force, log, 'OSM buildings', async () => {
    const q = areaId
      ? `[out:json][timeout:45];way["building"](area:${areaId});out geom;`
      : `[out:json][timeout:45];way["building"~"^(hangar|terminal|industrial|warehouse|transportation)$"](${bb.south},${bb.west},${bb.north},${bb.east});out geom;`
    return (await overpass(q, log, 'OSM buildings')).elements
  })
}

export async function fetchLandside(icao: string, bb: LLBox, specs: SourceSpec[], log: Log, force = false): Promise<OsmElement[]> {
  const hash = sourcesHash(specs)
  // tiles of at most ~2 km so each request stays small for the public mirrors
  const latStep = 2000 / 111132
  const lonStep = 2000 / (111320 * Math.cos((((bb.south + bb.north) / 2) * Math.PI) / 180))
  const rows = Math.max(1, Math.ceil((bb.north - bb.south) / latStep))
  const cols = Math.max(1, Math.ceil((bb.east - bb.west) / lonStep))
  const seen = new Set<string>()
  const out: OsmElement[] = []
  let n = 0
  let failed = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++
      const s = bb.south + ((bb.north - bb.south) * r) / rows
      const nn = bb.south + ((bb.north - bb.south) * (r + 1)) / rows
      const w = bb.west + ((bb.east - bb.west) * c) / cols
      const e = bb.west + ((bb.east - bb.west) * (c + 1)) / cols
      const key = `osm_land_${icao}_${hash}_${s.toFixed(4)}_${w.toFixed(4)}_${nn.toFixed(4)}_${e.toFixed(4)}`
      const label = `OSM landside tile ${n}/${rows * cols}`
      let els: OsmElement[] = []
      try {
        els = await cached(key, force, log, label, async () => {
          const b = `${s},${w},${nn},${e}`
          const body = overpassBody(specs, b)
          if (!body) return []
          const q = `[out:json][timeout:45];(${body});out geom;`
          const res = await overpass(q, log, label)
          await sleep(600)
          return res.elements
        })
      } catch (err) {
        failed++
        log(`${label}: giving up on this tile (${String(err).slice(0, 80)}); it will be retried on the next fetch`)
        continue
      }
      for (const el of els) {
        const k = `${el.type}${el.id}`
        if (!seen.has(k)) {
          seen.add(k)
          out.push(el)
        }
      }
    }
  }
  log(`OSM landside: ${out.length} elements from ${rows * cols - failed} of ${rows * cols} tiles${failed ? ' (partial: use Fetch & apply again later)' : ''}`)
  return out
}
