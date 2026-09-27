#!/usr/bin/env node
// Packaging art: the app icon (build/icon.png, icon.icns, icon.ico) and the DMG window background
// (build/background.png + background@2x.png, combined into background.tiff). Drawn as SVG (text outlined with the app's Jost font, so no font has to be
// installed), rendered with rsvg-convert; the .icns via sips + iconutil, the .ico via ImageMagick. macOS only (the
// outputs are committed, CI does not run this).
//   node scripts/make-art.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import opentypeModule from 'opentype.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = path.join(root, 'build')
const artDir = path.join(build, 'art')
fs.mkdirSync(artDir, { recursive: true })
const opentype = opentypeModule.parse ? opentypeModule : opentypeModule.default
const font = (f) => {
  const b = fs.readFileSync(path.join(root, 'src/renderer/src/assets/fonts', f))
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const semibold = font('Jost-SemiBold.ttf')
const regular = font('Jost-Regular.ttf')
/** Text as an outlined path, centred on cx with its baseline at y. */
function text(f, s, cx, y, size, fill, tracking = 0) {
  const opt = tracking ? { letterSpacing: tracking } : {}
  const w = f.getAdvanceWidth(s, size, opt) - (tracking ? tracking * size : 0)
  return `<path d="${f.getPath(s, cx - w / 2, y, size, opt).toPathData(2)}" fill="${fill}"/>`
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const render = (svg, png, w, h) => {
  const file = path.join(artDir, path.basename(png, '.png') + '.svg')
  fs.writeFileSync(file, svg)
  run('rsvg-convert', ['-w', String(w), '-h', String(h), '-o', png, file])
}

// ---------------------------------------------------------------- the runway motif (shared)
/** A runway along +x from x0 to x1 at y (width w): pavement, edge lines, LEDs on the centreline, threshold bars at the
 *  start and the double end chevron past x1 (the studio's "End chevrons" runway style). */
function runway(x0, x1, y, w, o = {}) {
  const edge = o.edge ?? w * 0.06
  const led = o.led ?? w * 0.26
  const leds = o.leds ?? 4
  const stroke = o.chevron ?? w * 0.075
  const parts = []
  parts.push(`<rect x="${x0}" y="${y - w / 2}" width="${x1 - x0}" height="${w}" rx="${w * 0.04}" fill="#2a313b"/>`)
  parts.push(`<line x1="${x0}" y1="${y - w / 2 + edge}" x2="${x1}" y2="${y - w / 2 + edge}" stroke="#dfe4ea" stroke-width="${edge}"/>`)
  parts.push(`<line x1="${x0}" y1="${y + w / 2 - edge}" x2="${x1}" y2="${y + w / 2 - edge}" stroke="#dfe4ea" stroke-width="${edge}"/>`)
  for (let i = 0; i < 2; i++) {
    const bx = x0 + w * (0.18 + i * 0.22)
    parts.push(`<line x1="${bx}" y1="${y - w * 0.3}" x2="${bx}" y2="${y + w * 0.3}" stroke="#dfe4ea" stroke-width="${edge * 1.6}" stroke-linecap="round"/>`)
  }
  // LEDs: blue runway lights with a glow
  const l0 = x0 + w * 0.8
  for (let i = 0; i < leds; i++) {
    const cx = l0 + ((x1 - w * 0.3 - l0) * i) / Math.max(1, leds - 1)
    parts.push(`<rect x="${cx - led * 1.4}" y="${y - led * 1.4}" width="${led * 2.8}" height="${led * 2.8}" rx="${led * 1.4}" fill="url(#glowBlue)"/>`)
    parts.push(`<rect x="${cx - led / 2}" y="${y - led / 2}" width="${led}" height="${led}" rx="${led * 0.15}" fill="#6fb2ff"/>`)
  }
  // double chevron past the end, apex outward
  const span = w * (o.span ?? 1.25)
  const depth = span * (o.depth ?? 0.75)
  // two parallel strokes (like the studio's end chevrons): the inner V is the outer one offset by d toward the opening
  const d = stroke * 2.2
  const ex = x1 + w * 0.12
  const alpha = Math.atan2(span / 2, depth)
  for (const k of [0, 1]) {
    const ax = ex + depth - (k * d) / Math.sin(alpha)
    const hs = span / 2 - (k * d) / Math.cos(alpha)
    parts.push(`<polyline points="${ex},${y - hs} ${ax},${y} ${ex},${y + hs}" fill="none" stroke="#f4f6f8" stroke-width="${stroke}" stroke-linejoin="miter" stroke-miterlimit="8" stroke-linecap="round"/>`)
  }
  return parts.join('\n')
}
const defs = `<defs>
  <radialGradient id="glowBlue"><stop offset="0" stop-color="#6fb2ff" stop-opacity="0.75"/><stop offset="1" stop-color="#6fb2ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="glowAmber"><stop offset="0" stop-color="#f2b233" stop-opacity="0.8"/><stop offset="1" stop-color="#f2b233" stop-opacity="0"/></radialGradient>
</defs>`

// ---------------------------------------------------------------- app icon (1024, macOS grid: 824 square, r 185)
{
  const S = 1024
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
${defs}
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c2531"/><stop offset="1" stop-color="#0c1016"/></linearGradient>
  <clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  <pattern id="dots" width="41.2" height="41.2" patternUnits="userSpaceOnUse"><circle cx="20.6" cy="20.6" r="3" fill="#ffffff" fill-opacity="0.05"/></pattern>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
<g clip-path="url(#sq)">
  <rect x="100" y="100" width="824" height="824" fill="url(#dots)"/>
  <!-- a taxiway curving in from the lower right, amber lights -->
  <path d="M 960 770 C 770 770 650 715 575 585" fill="none" stroke="#2a313b" stroke-width="64" stroke-linecap="round"/>
  <path d="M 960 770 C 770 770 650 715 575 585" fill="none" stroke="#9aa3ad" stroke-width="5" opacity="0.45"/>
  ${[[850, 767], [735, 744], [638, 684]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="44" fill="url(#glowAmber)"/><rect x="${x - 16}" y="${y - 16}" width="32" height="32" rx="5" fill="#f2b233"/>`).join('')}
  <!-- the runway with its end chevron, centred on the icon: 520 of runway + 0.12 w + chevron depth -->
  <g transform="rotate(-35 512 512)">
    ${runway(190, 680, 512, 170, { edge: 10, led: 36, leds: 4, chevron: 16, span: 1.2, depth: 0.7 })}
  </g>
</g>
<rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>
</svg>`
  render(svg, path.join(build, 'icon.png'), S, S)
  // .icns
  const set = path.join(artDir, 'icon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set)
  for (const s of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(s), String(s), path.join(build, 'icon.png'), '--out', path.join(set, `icon_${s}x${s}.png`)])
    run('sips', ['-z', String(s * 2), String(s * 2), path.join(build, 'icon.png'), '--out', path.join(set, `icon_${s}x${s}@2x.png`)])
  }
  run('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')])
  fs.rmSync(set, { recursive: true, force: true })
  // .ico (Windows): 16..256
  run('magick', [path.join(build, 'icon.png'), '-define', 'icon:auto-resize=256,128,64,48,32,24,16', path.join(build, 'icon.ico')])
  // the renderer's window icon (resources/icon.png) too
  fs.copyFileSync(path.join(build, 'icon.png'), path.join(root, 'resources', 'icon.png'))
}

// ---------------------------------------------------------------- DMG background (660 x 400 window; @2x for Retina)
{
  const W = 660
  const H = 400
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${defs}
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151c26"/><stop offset="1" stop-color="#0b0f14"/></linearGradient>
  <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="0.9" fill="#ffffff" fill-opacity="0.06"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
${text(semibold, 'Flightboard Studio', W / 2, 64, 28, '#e8ecf1', 0.02)}
${text(regular, 'AIRPORT LED BOARD EDITOR', W / 2, 88, 10.5, '#7f8b99', 0.18)}
<g opacity="0.95">${runway(250, 380, 205, 26, { edge: 1.5, led: 5, leds: 4, chevron: 2.2 })}</g>
${text(regular, 'Drag Flightboard Studio into Applications to install', W / 2, 338, 12.5, '#9aa6b4')}
</svg>`
  render(svg, path.join(build, 'background.png'), W, H)
  render(svg, path.join(build, 'background@2x.png'), W * 2, H * 2)
  // one HiDPI TIFF (both resolutions) so Finder uses the sharp one on Retina screens
  run('tiffutil', ['-cathidpicheck', path.join(build, 'background.png'), path.join(build, 'background@2x.png'), '-out', path.join(build, 'background.tiff')])
}
console.log('wrote build/icon.png, icon.icns, icon.ico, background.png, background@2x.png, background.tiff (sources in build/art)')
