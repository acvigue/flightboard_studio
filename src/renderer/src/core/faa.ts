// FAA AIS "Airport Mapping" polygons (public domain): surveyed taxiway / apron / runway / stopway pavement and
// buildings, for US airports. Fetched by ICAO from the FAA ArcGIS feature services and cached.
export interface GeoJSONFeature {
  type: 'Feature'
  geometry: { type: string; coordinates: unknown } | null
  properties: Record<string, unknown>
}
export type FaaData = Record<string, GeoJSONFeature[]>

const BASE = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/{}/FeatureServer/0/query'
export const FAA_LAYERS = ['AM_Taxiway', 'AM_Apron', 'AM_Runway', 'AM_Building', 'AM_Stopway']

export async function fetchFaa(icao: string, log: (s: string) => void, force = false): Promise<FaaData | null> {
  const key = `faa_${icao}`
  if (!force) {
    const c = await window.api.cacheGet(key)
    if (c) {
      log('FAA airport mapping: cached')
      return JSON.parse(c)
    }
  }
  const out: FaaData = {}
  let total = 0
  for (const layer of FAA_LAYERS) {
    const params = new URLSearchParams({
      where: `ICAO_ID='${icao}'`,
      outFields: '*',
      returnGeometry: 'true',
      f: 'geojson',
      outSR: '4326',
      resultRecordCount: '5000'
    })
    const r = await window.api.fetchText(BASE.replace('{}', layer) + '?' + params.toString(), { timeoutMs: 90000 })
    if (!r.ok) {
      log(`FAA ${layer}: HTTP ${r.status}`)
      out[layer] = []
      continue
    }
    try {
      const j = JSON.parse(r.text)
      out[layer] = Array.isArray(j.features) ? j.features : []
      total += out[layer].length
    } catch {
      out[layer] = []
    }
    log(`FAA ${layer}: ${out[layer].length}`)
  }
  if (!total) {
    log('FAA airport mapping: no coverage for this airport (OSM pavement will be used)')
    return null
  }
  await window.api.cachePut(key, JSON.stringify(out))
  return out
}
