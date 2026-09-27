import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface FetchInit {
  method?: string
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
}
export interface FetchResult {
  ok: boolean
  status: number
  text: string
}
export interface FileFilter {
  name: string
  extensions: string[]
}

const api = {
  fetchText: (url: string, init?: FetchInit): Promise<FetchResult> => ipcRenderer.invoke('net:fetch', url, init),
  cacheGet: (key: string): Promise<string | null> => ipcRenderer.invoke('cache:get', key),
  cachePut: (key: string, text: string): Promise<boolean> => ipcRenderer.invoke('cache:put', key, text),
  cacheClear: (): Promise<boolean> => ipcRenderer.invoke('cache:clear'),
  saveFile: (defaultName: string, content: string, filters?: FileFilter[]): Promise<string | null> =>
    ipcRenderer.invoke('file:save', defaultName, content, filters),
  openFile: (filters?: FileFilter[]): Promise<{ path: string; text: string } | null> => ipcRenderer.invoke('file:open', filters),
  writeFile: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('file:write', path, content),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke('file:read', path),
  exportDir: (files: { name: string; content: string }[], suggested?: string): Promise<string | null> =>
    ipcRenderer.invoke('file:export-dir', files, suggested),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:open-path', path),
  autotestShot: (path: string): Promise<boolean> => ipcRenderer.invoke('autotest:shot', path),
  pickDir: (title: string, defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pick-dir', title, defaultPath),
  // Altium generator sidecar
  pcbgenInfo: (): Promise<{ exe: string | null; template: string | null; running: boolean; version: string | null; candidates: string[] }> => ipcRenderer.invoke('pcbgen:info'),
  pcbgenCall: <T = unknown>(cmd: string, args: Record<string, unknown>, key?: string): Promise<T> => ipcRenderer.invoke('pcbgen:call', cmd, args, key),
  pcbgenCancel: (): Promise<void> => ipcRenderer.invoke('pcbgen:cancel'),
  firmwareInstall: (text: string, id: string, repo?: string): Promise<{ json: string; hpp: string; output: string }> => ipcRenderer.invoke('firmware:install', text, id, repo),
  onPcbgenProgress: (cb: (m: { key?: string; message: string }) => void): (() => void) => {
    const h = (_e: unknown, m: { key?: string; message: string }): void => cb(m)
    ipcRenderer.on('pcbgen:progress', h)
    return () => ipcRenderer.removeListener('pcbgen:progress', h)
  }
}
export type StudioApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
