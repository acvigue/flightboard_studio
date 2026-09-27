// The Altium generator (pcbgen, .NET) as a long-running sidecar: `PcbGen serve`, line-delimited JSON on stdin/stdout
// (protocol in pcbgen gen/Sidecar.cs). One request at a time on the generator side; requests are written in order and
// answered in order. Progress events are forwarded to the page. Cancel = kill the process (the next call restarts it;
// cached jobs are gone then, the page reloads its job on "unknown jobId").
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface PcbgenInfo {
  exe: string | null
  template: string | null
  running: boolean
  version: string | null
  candidates: string[]
}

const DEV_ROOT = join(homedir(), 'Projects', 'Koios', 'Matrx', 'pcbgen')
const PLATFORM = `${process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`
const EXE_NAME = process.platform === 'win32' ? 'PcbGen.exe' : 'PcbGen'

function resources(): string | null {
  return typeof process.resourcesPath === 'string' ? process.resourcesPath : null
}

/** A packaged app uses only what it ships (plus FB_PCBGEN / FB_PCBGEN_TEMPLATE overrides), never a repo checkout. */
const devFallbacks = (): boolean => !app.isPackaged

/** Generator executable: FB_PCBGEN, the app bundle, then (dev only) the dev build and the dev publish folder. */
export function exeCandidates(): string[] {
  const list: string[] = []
  if (process.env['FB_PCBGEN']) list.push(process.env['FB_PCBGEN'])
  const res = resources()
  if (res) list.push(join(res, 'pcbgen', EXE_NAME))
  if (devFallbacks()) {
    list.push(join(DEV_ROOT, 'gen', 'bin', 'Release', 'net10.0', EXE_NAME))   // dev build first: a publish may be older
    list.push(join(DEV_ROOT, 'out', 'publish', PLATFORM, EXE_NAME))
  }
  return list
}
export function findExe(): string | null {
  return exeCandidates().find((p) => existsSync(p)) ?? null
}
export function defaultTemplate(): string | null {
  const list: string[] = []
  if (process.env['FB_PCBGEN_TEMPLATE']) list.push(process.env['FB_PCBGEN_TEMPLATE'])
  const res = resources()
  if (res) list.push(join(res, 'pcbgen-template', 'Plane_Template'))
  // dev: the live Altium template, else the committed snapshot (a fresh pcbgen clone has only the snapshot)
  if (devFallbacks()) list.push(join(DEV_ROOT, 'template', 'Plane_Template'), join(DEV_ROOT, 'template-snapshot', 'Plane_Template'))
  return list.find((p) => existsSync(p)) ?? null
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (msg: string) => void
}

export class Pcbgen {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private seq = 0
  private pending = new Map<number, Pending>()
  private ready: Promise<void> | null = null
  private version: string | null = null
  private stderrTail: string[] = []

  info(): PcbgenInfo {
    return { exe: findExe(), template: defaultTemplate(), running: !!this.proc, version: this.version, candidates: exeCandidates() }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const exe = findExe()
    if (!exe) return Promise.reject(new Error(`Altium generator not found (looked in: ${exeCandidates().join(', ')})`))
    const env = { ...process.env }
    if (!app.isPackaged && !env['DOTNET_ROOT'] && existsSync('/usr/local/share/dotnet')) env['DOTNET_ROOT'] = '/usr/local/share/dotnet'   // framework-dependent dev builds
    const proc = spawn(exe, ['serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.buf = ''
    this.stderrTail = []
    this.ready = new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null): void => {
        const why = new Error(`Altium generator exited (${code ?? 'signal'})${this.stderrTail.length ? ': ' + this.stderrTail.slice(-6).join(' | ') : ''}`)
        reject(why)
        for (const p of this.pending.values()) p.reject(why)
        this.pending.clear()
        if (this.proc === proc) {
          this.proc = null
          this.ready = null
        }
      }
      proc.on('exit', onExit)
      proc.on('error', (e) => {
        this.stderrTail.push(String(e))
        onExit(null)
      })
      proc.stderr.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split('\n')) if (line.trim()) this.stderrTail.push(line.trim())
        if (this.stderrTail.length > 50) this.stderrTail.splice(0, this.stderrTail.length - 50)
      })
      proc.stdout.on('data', (d: Buffer) => {
        this.buf += d.toString('utf8')
        let nl: number
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim()
          this.buf = this.buf.slice(nl + 1)
          if (!line) continue
          let m: { id?: number; event?: string; message?: string; ok?: boolean; result?: unknown; error?: string; version?: string }
          try {
            m = JSON.parse(line)
          } catch {
            continue
          }
          if (m.event === 'ready') {
            this.version = m.version ?? null
            resolve()
            continue
          }
          const p = m.id !== undefined ? this.pending.get(m.id) : undefined
          if (!p) continue
          if (m.event === 'progress') p.onProgress?.(m.message ?? '')
          else {
            this.pending.delete(m.id!)
            if (m.ok) p.resolve(m.result)
            else p.reject(new Error(m.error ?? 'generator error'))
          }
        }
      })
    })
    return this.ready
  }

  async call(cmd: string, args: Record<string, unknown>, onProgress?: (msg: string) => void): Promise<unknown> {
    await this.start()
    const proc = this.proc!
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  /** Stop whatever runs (the process is killed; the next call starts a fresh one). */
  cancel(): void {
    const proc = this.proc
    if (!proc) return
    for (const p of this.pending.values()) p.reject(new Error('cancelled'))
    this.pending.clear()
    this.proc = null
    this.ready = null
    proc.kill()
  }

  dispose(): void {
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin.write(JSON.stringify({ id: 0, cmd: 'shutdown' }) + '\n')
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 500)
    this.proc = null
    this.ready = null
  }
}
