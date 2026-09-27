// Page side of the compute worker: one long-lived worker, request ids, streamed progress, cancellation.
// Cancelling terminates the worker (JSTS work cannot be interrupted); the next request starts a fresh one.
import ComputeWorker from '../workers/compute.worker?worker'
import type { ComputeOps, FromWorker, OpName, ToWorker } from '../workers/compute-types'

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  onLog?: (s: string) => void
}
let worker: Worker | null = null
let seq = 0
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new ComputeWorker()
  w.onmessage = (ev: MessageEvent<FromWorker>): void => {
    const m = ev.data
    const p = pending.get(m.id)
    if (!p) return
    if (m.type === 'progress') p.onLog?.(m.msg)
    else {
      pending.delete(m.id)
      if (m.type === 'done') p.resolve(m.result)
      else {
        const err = new Error(m.error)
        if (m.stack) err.stack = m.stack
        p.reject(err)
      }
    }
  }
  w.onerror = (ev): void => {
    // a crash inside the worker (e.g. out of memory): fail everything in flight and start fresh next time
    for (const p of pending.values()) p.reject(new Error(`compute worker crashed: ${ev.message || 'unknown error'}`))
    pending.clear()
    w.terminate()
    if (worker === w) worker = null
  }
  worker = w
  return w
}

/** Structured clone refuses Vue proxies; fall back to a plain JSON copy for arguments that carry one. */
function send(w: Worker, msg: ToWorker): void {
  try {
    w.postMessage(msg)
  } catch (e) {
    if ((e as Error)?.name !== 'DataCloneError') throw e
    w.postMessage(JSON.parse(JSON.stringify(msg)))
  }
}

export interface ComputeCall<T> {
  promise: Promise<T>
  cancel: () => void
}
export function compute<K extends OpName>(op: K, args: ComputeOps[K]['args'], onLog?: (s: string) => void): ComputeCall<ComputeOps[K]['result']> {
  const id = ++seq
  const w = ensureWorker()
  const promise = new Promise<ComputeOps[K]['result']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onLog })
    try {
      send(w, { id, op, args })
    } catch (e) {
      pending.delete(id)
      reject(e)
    }
  })
  const cancel = (): void => {
    if (!pending.has(id)) return
    for (const p of pending.values()) p.reject(new CancelledError())
    pending.clear()
    w.terminate()
    if (worker === w) worker = null
  }
  return { promise, cancel }
}
