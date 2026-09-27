// Board transform: projected metres -> board millimetres (origin top-left, y down), and back.
import type { BoardSpec, MapFrame, Pt } from './model'

export interface BoardTransform {
  k: number      // mm per metre
  fx0: number    // mm offset of the frame's west edge
  fy0: number    // mm offset of the frame's north edge
  scale: number  // 1 : scale
  frameWmm: number
  frameHmm: number
  toMm: (p: Pt) => Pt
  toM: (p: Pt) => Pt
}

export function makeTransform(board: BoardSpec, frame: MapFrame): BoardTransform {
  const mw = Math.max(1, frame.maxx - frame.minx)
  const mh = Math.max(1, frame.maxy - frame.miny)
  const availW = Math.max(10, board.widthMm - 2 * board.marginMm)
  const availH = Math.max(10, board.heightMm - 2 * board.marginMm)
  const k = Math.min(availW / mw, availH / mh)
  const frameWmm = mw * k
  const frameHmm = mh * k
  const fx0 = (board.widthMm - frameWmm) / 2
  const fy0 = (board.heightMm - frameHmm) / 2
  return {
    k,
    fx0,
    fy0,
    scale: 1000 / k,
    frameWmm,
    frameHmm,
    toMm: ([x, y]) => [fx0 + (x - frame.minx) * k, fy0 + (frame.maxy - y) * k],
    toM: ([X, Y]) => [frame.minx + (X - fx0) / k, frame.maxy - (Y - fy0) / k]
  }
}

/** Choose a board size that fits the frame at a "nice" scale inside a maximum size. */
export function fitBoard(frame: MapFrame, maxW: number, maxH: number, margin: number): { w: number; h: number; scale: number } {
  const mw = frame.maxx - frame.minx
  const mh = frame.maxy - frame.miny
  let scale = 5000
  for (;;) {
    const k = 1000 / scale
    const w = Math.ceil(mw * k + 2 * margin)
    const h = Math.ceil(mh * k + 2 * margin)
    if (w <= maxW && h <= maxH) return { w, h, scale }
    scale += 250
    if (scale > 200000) return { w: maxW, h: maxH, scale }
  }
}
