import { app, shell, BrowserWindow, ipcMain, dialog, net } from 'electron'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Pcbgen } from './pcbgen'

const UA = 'flightboard-studio/0.1 (+https://koiosdigital.net)'
// settings, localStorage and the download cache stay in .../flightboard-studio whatever the product name is (the
// packaged app is "Flightboard Studio"; Electron would otherwise follow the product name)
app.setPath('userData', join(app.getPath('appData'), 'flightboard-studio'))

function cacheDir(): string {
  return join(app.getPath('userData'), 'cache')
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'Flightboard Studio',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // autotest windows usually sit behind other windows: keep timers and painting running
      backgroundThrottling: !process.env.FB_AUTOTEST && !process.env.FB_BATCH
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    const a = args[1] as { level?: number; message?: string } | number
    const msg = typeof a === 'object' && a ? a.message : (args[2] as string)
    if (process.env['FB_AUTOTEST'] || process.env['FB_BATCH'] || is.dev) console.log('[renderer]', msg)
    if (typeof msg === 'string' && msg.includes('AUTOTEST DONE') && process.env['FB_AUTOTEST']) setTimeout(() => app.quit(), 500)
    if (typeof msg === 'string' && msg.includes('BATCH DONE') && process.env['FB_BATCH']) setTimeout(() => app.quit(), 500)
  })
  // FB_BATCH=<job.json>: scripted open / resolve / save / screenshot / export runs (see App.vue runBatch)
  const auto = process.env['FB_AUTOTEST']
    ? `?autotest=${encodeURIComponent(process.env['FB_AUTOTEST'])}${process.env['FB_AUTOTEST_PCB'] ? '&pcb=1' : ''}${process.env['FB_AUTOTEST_FWREPO'] ? '&fwrepo=' + encodeURIComponent(process.env['FB_AUTOTEST_FWREPO']) : ''}`
    : process.env['FB_BATCH']
      ? `?batch=${encodeURIComponent(process.env['FB_BATCH'])}`
      : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + auto)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), auto ? { search: auto } : undefined)
  }
}

// ---------------------------------------------------------------- IPC: network (from the main process: no CORS, our own UA)
ipcMain.handle(
  'net:fetch',
  async (_e, url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number }) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), init?.timeoutMs ?? 120000)
    try {
      const res = await net.fetch(url, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: { 'User-Agent': UA, ...(init?.headers ?? {}) },  // renderer may override the UA per service
        signal: ctl.signal
      })
      const text = await res.text()
      return { ok: res.ok, status: res.status, text }
    } catch (e) {
      return { ok: false, status: 0, text: String(e) }
    } finally {
      clearTimeout(t)
    }
  }
)

// ---------------------------------------------------------------- IPC: cache (userData/cache/<key>.json)
ipcMain.handle('cache:get', async (_e, key: string) => {
  try {
    return await fs.readFile(join(cacheDir(), `${key}.json`), 'utf8')
  } catch {
    return null
  }
})
ipcMain.handle('cache:put', async (_e, key: string, text: string) => {
  await fs.mkdir(cacheDir(), { recursive: true })
  await fs.writeFile(join(cacheDir(), `${key}.json`), text, 'utf8')
  return true
})
ipcMain.handle('cache:clear', async () => {
  await fs.rm(cacheDir(), { recursive: true, force: true })
  return true
})

// ---------------------------------------------------------------- IPC: files
ipcMain.handle('file:save', async (_e, defaultName: string, content: string, filters?: { name: string; extensions: string[] }[]) => {
  const win = BrowserWindow.getFocusedWindow()
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters })
  if (r.canceled || !r.filePath) return null
  await fs.writeFile(r.filePath, content, 'utf8')
  return r.filePath
})
ipcMain.handle('file:open', async (_e, filters?: { name: string; extensions: string[] }[]) => {
  const win = BrowserWindow.getFocusedWindow()
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters })
  if (r.canceled || !r.filePaths.length) return null
  return { path: r.filePaths[0], text: await fs.readFile(r.filePaths[0], 'utf8') }
})
ipcMain.handle('file:write', async (_e, path: string, content: string) => {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
  return true
})
ipcMain.handle('file:export-dir', async (_e, files: { name: string; content: string }[], suggested?: string) => {
  if (process.env['FB_AUTOTEST_DIR']) {
    const dir = process.env['FB_AUTOTEST_DIR']
    await fs.mkdir(dir, { recursive: true })
    for (const f of files) await fs.writeFile(join(dir, f.name), f.content, 'utf8')
    return dir
  }
  const win = BrowserWindow.getFocusedWindow()
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose the export folder',
    defaultPath: suggested
  })
  if (r.canceled || !r.filePaths.length) return null
  const dir = r.filePaths[0]
  for (const f of files) await fs.writeFile(join(dir, f.name), f.content, 'utf8')
  return dir
})
// plain file read, only for scripted batch runs
ipcMain.handle('file:read', async (_e, path: string) => {
  if (!process.env['FB_BATCH']) throw new Error('file:read is only available in batch mode')
  return fs.readFile(path, 'utf8')
})
// ---------------------------------------------------------------- IPC: Altium generator sidecar (see pcbgen.ts)
const pcbgen = new Pcbgen()
ipcMain.handle('pcbgen:info', () => pcbgen.info())
ipcMain.handle('pcbgen:call', async (e, cmd: string, args: Record<string, unknown>, key?: string) => {
  const sender = e.sender
  return pcbgen.call(cmd, args ?? {}, (message) => {
    if (!sender.isDestroyed()) sender.send('pcbgen:progress', { key, message })
  })
})
ipcMain.handle('pcbgen:cancel', () => pcbgen.cancel())
app.on('will-quit', () => pcbgen.dispose())
// Firmware board definition -> <flightboard repo>/boards/<id>.json, then the repo's tools/gen_board_hpp.py makes the header
ipcMain.handle('firmware:install', async (_e, text: string, id: string, repo?: string) => {
  const { existsSync } = await import('fs')
  const { execFile } = await import('child_process')
  const { homedir } = await import('os')
  const dir = repo ?? join(homedir(), 'Projects', 'Koios', 'Matrx', 'flightboard')
  if (!existsSync(join(dir, 'tools', 'gen_board_hpp.py'))) throw new Error(`not a flightboard repo (no tools/gen_board_hpp.py): ${dir}`)
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_')
  const json = join(dir, 'boards', `${safe}.json`)
  await fs.mkdir(join(dir, 'boards'), { recursive: true })
  await fs.writeFile(json, text, 'utf8')
  const out = await new Promise<string>((resolve, reject) =>
    execFile('python3', [join('tools', 'gen_board_hpp.py'), join('boards', `${safe}.json`)], { cwd: dir }, (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout + stderr)))
  )
  return { json, hpp: json.replace(/\.json$/, '.hpp'), output: out }
})
ipcMain.handle('dialog:pick-dir', async (_e, title: string, defaultPath?: string) => {
  if (process.env['FB_AUTOTEST_DIR']) {
    const dir = join(process.env['FB_AUTOTEST_DIR'], 'altium')
    await fs.mkdir(dir, { recursive: true })
    return dir
  }
  const win = BrowserWindow.getFocusedWindow()
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title, defaultPath })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})
ipcMain.handle('shell:open-path', async (_e, path: string) => shell.openPath(path))
ipcMain.handle('autotest:shot', async (_e, path: string) => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return false
  // an occluded window may not have painted the latest state: force a fresh frame first
  win.webContents.invalidate()
  await new Promise((r) => setTimeout(r, 250))
  const img = await win.webContents.capturePage()
  await fs.writeFile(path, img.toPNG())
  return true
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('net.koiosdigital.flightboard-studio')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
