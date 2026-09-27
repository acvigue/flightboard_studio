// Projection: WGS84 <-> UTM (zone from the airport longitude). Metres with x east, y north.
import proj4 from 'proj4'

export interface Projection {
  zone: number
  north: boolean
  epsg: number
  forward: (lon: number, lat: number) => [number, number]
  inverse: (x: number, y: number) => [number, number] // [lon, lat]
}

export function utmFor(lat: number, lon: number): Projection {
  const zone = Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1))
  const north = lat >= 0
  const epsg = (north ? 32600 : 32700) + zone
  const def = `+proj=utm +zone=${zone} ${north ? '' : '+south'} +datum=WGS84 +units=m +no_defs`
  const conv = proj4('EPSG:4326', def)
  return {
    zone,
    north,
    epsg,
    forward: (lo, la) => {
      const [x, y] = conv.forward([lo, la])
      return [x, y]
    },
    inverse: (x, y) => {
      const [lo, la] = conv.inverse([x, y])
      return [lo, la]
    }
  }
}

export function bearingDeg(dx: number, dy: number): number {
  // compass bearing (0 = north, clockwise) of a vector in metres
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
}
