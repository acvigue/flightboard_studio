// Airport search over the bundled OurAirports extract (large/medium airports + small with scheduled service).
import csvUrl from '../assets/data/airports-slim.csv?url'

export interface Airport {
  ident: string
  icao: string
  iata: string
  name: string
  lat: number
  lon: number
  elevFt: number
  type: string
  city: string
  country: string
}

let cache: Airport[] | null = null

function parseLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

export async function loadAirports(): Promise<Airport[]> {
  if (cache) return cache
  const text = await (await fetch(csvUrl)).text()
  const lines = text.split('\n')
  const rows: Airport[] = []
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    const f = parseLine(l)
    if (f.length < 10) continue
    rows.push({
      ident: f[0],
      icao: f[1],
      iata: f[2],
      name: f[3],
      lat: Number(f[4]),
      lon: Number(f[5]),
      elevFt: Number(f[6]) || 0,
      type: f[7],
      city: f[8],
      country: f[9]
    })
  }
  cache = rows
  return rows
}

export async function searchAirports(q: string, limit = 25): Promise<Airport[]> {
  const rows = await loadAirports()
  const s = q.trim().toUpperCase()
  if (!s) return []
  const scored: [number, Airport][] = []
  for (const a of rows) {
    let score = 0
    if (a.icao === s || a.iata === s || a.ident === s) score = 100
    else if (a.icao.startsWith(s) || a.iata.startsWith(s)) score = 80
    else if (a.name.toUpperCase().includes(s)) score = 50
    else if (a.city.toUpperCase().includes(s)) score = 30
    if (score) scored.push([score + (a.type === 'large' ? 5 : a.type === 'medium' ? 2 : 0), a])
  }
  scored.sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name))
  return scored.slice(0, limit).map((x) => x[1])
}
