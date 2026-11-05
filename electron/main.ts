import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigStore } from './config'
import { createTrayIcon } from './icon'
import { NotesStore } from './notes'
import type { DzmConfig } from '../src/types'

const DEFAULT_WIDTH = 400
const DEFAULT_HEIGHT = 700

let win: BrowserWindow | null = null
let tray: Tray | null = null
let config: ConfigStore
let store: NotesStore
let embedded = false
let lifted = false
let deskHost = 0
let quitting = false
let workerOrigin = { x: 0, y: 0 }
let resizeOrigin: { winX: number; winY: number; width: number; height: number } | null = null
// Electron's DIP->pixel conversion inflates the window by this much on every setBounds
// call at fractional display scales; measured once and subtracted from each request.
let sizePad = { w: 0, h: 0 }
let posPad = { x: 0, y: 0 }
let saveBoundsTimer: NodeJS.Timeout | null = null

function dataDir() {
  return path.join(app.getPath('appData'), 'dzm')
}

function logLine(message: string) {
  try {
    const file = path.join(dataDir(), 'debug.log')
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.rmSync(file)
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* ignore */
  }
}

function scriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'desktop-pin.ps1')
    : path.join(app.getAppPath(), 'scripts', 'desktop-pin.ps1')
}

function runPinScript(hwnd: number, action: 'attach' | 'detach'): Promise<{ x: number; y: number; parent: number; visible: boolean }> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), '-Hwnd', String(hwnd), '-Action', action]
  if (action === 'attach' && deskHost) args.push('-DeskHost', String(deskHost))
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      args,
      { windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message))
        const match = /OK\s+(\d+)\s+(-?\d+)\s+(-?\d+)/.exec(stdout)
        if (!match) return reject(new Error(`unexpected output: ${stdout}`))
        const state = /parent=(\d+)\s+vis=(\d)/.exec(stdout)
        resolve({
          x: Number(match[2]),
          y: Number(match[3]),
          parent: state ? Number(state[1]) : 0,
          visible: state ? state[2] === '1' : true
        })
      }
    )
  })
}

function nativeHandle() {
  if (!win) return 0
  return Number(win.getNativeWindowHandle().readBigUInt64LE(0))
}

async function attachToDesktop(): Promise<boolean> {
  const hwnd = nativeHandle()
  if (!hwnd) return false
  try {
    const res = await runPinScript(hwnd, 'attach')
    if (!res.parent || !res.visible) throw new Error(`attach incomplete parent=${res.parent} vis=${res.visible}`)
    deskHost = res.parent
    const scale = screen.getDisplayMatching(win!.getBounds()).scaleFactor
    workerOrigin = { x: res.x / scale, y: res.y / scale }
    embedded = true
    logLine(`attach ok parent=${res.parent} origin=${res.x},${res.y} scale=${scale}`)
    return true
  } catch (err) {
    logLine(`attach failed: ${String(err)}`)
    embedded = false
    return false
  }
}

async function detachFromDesktop(): Promise<void> {
  const hwnd = nativeHandle()
  if (!hwnd) return
  try {
    await runPinScript(hwnd, 'detach')
    logLine('detach ok')
  } catch (err) {
    logLine(`detach failed: ${String(err)}`)
  }
  embedded = false
}

function stopResize() {
  resizeOrigin = null
}

let transition: Promise<void> = Promise.resolve()
let wantLifted = false
let guardLift = false

function serialize(task: () => Promise<void>): Promise<void> {
  const next = transition.then(task, task)
  transition = next.catch(() => undefined)
  return next
}

function fallbackVisible() {
  if (!win) return
  win.showInactive()
  setTimeout(() => {
    if (!win || lifted || wantLifted) return
    if (config.get().embedDesktop && !embedded) void attachToDesktop()
  }, 600)
}

async function doLift() {
  if (!win) return
  logLine(`lift begin guard=${guardLift} want=${wantLifted}`)
  if (embedded) {
    await detachFromDesktop()
    embedded = false
  }
  workerOrigin = { x: 0, y: 0 }
  lifted = true
  const guard = guardLift
  guardLift = false
  if (guard) {
    const bounds = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const inside =
      cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
    if (!inside) {
      wantLifted = false
      win.showInactive()
      win.webContents.send('window:blurred')
      logLine('lift cancelled: pointer already left window')
      setTimeout(() => {
        if (!wantLifted && lifted) void requestSink()
      }, 500)
      return
    }
  }
  if (win.isMinimized()) win.restore()
  win.setResizable(true)
  win.show()
  win.moveTop()
  win.focus()
  logLine('lift done')
}

async function doSink() {
  if (!win) return
  lifted = false
  win.setResizable(false)
  logLine('sink begin')
  if (win.isMinimized()) win.restore()
  if (config.get().embedDesktop) {
    const ok = await attachToDesktop()
    if (!win) return
    win.showInactive()
    if (!ok) {
      logLine('sink fallback: staying visible above desktop')
      fallbackVisible()
    }
  } else {
    win.showInactive()
  }
  logLine('sink done')
}

async function reconcile() {
  if (!win) {
    guardLift = false
    return
  }
  if (wantLifted === lifted) {
    guardLift = false
    return
  }
  if (wantLifted) await doLift()
  else await doSink()
}

function requestLift(guard = false): Promise<void> {
  wantLifted = true
  if (guard) guardLift = true
  return serialize(reconcile)
}

function requestSink(): Promise<void> {
  wantLifted = false
  return serialize(reconcile)
}

function applyWindowBounds() {
  if (!win) return
  const saved = config.get().bounds
  if (!saved) return
  const area = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y }).workArea
  const width = Math.min(saved.width, area.width)
  const height = Math.min(saved.height, area.height)
  const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height)
  win.setBounds({ x: x - posPad.x, y: y - posPad.y, width: width - sizePad.w, height: height - sizePad.h })
}

function saveWindowBounds() {
  if (!win) return
  const bounds = win.getBounds()
  config.patch({ bounds })
}

function measureSizePad() {
  if (!win) return
  const b = win.getBounds()
  win.setBounds(b)
  const after = win.getBounds()
  sizePad = { w: after.width - b.width, h: after.height - b.height }
  posPad = { x: after.x - b.x, y: after.y - b.y }
  if (sizePad.w || sizePad.h || posPad.x || posPad.y) {
    win.setBounds({ x: b.x - posPad.x, y: b.y - posPad.y, width: b.width - sizePad.w, height: b.height - sizePad.h })
  }
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea
  const initial = config.get().bounds ?? {
    x: area.x + area.width - DEFAULT_WIDTH - 24,
    y: area.y + 24,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT
  }

  win = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.once('ready-to-show', () => {
    win?.showInactive()
    void attachToDesktop()
  })

  win.on('focus', () => {
    logLine('window focus')
  })

  const scheduleBoundsSave = () => {
    if (!lifted) return
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null
      saveWindowBounds()
    }, 400)
  }
  win.on('move', scheduleBoundsSave)
  win.on('resize', scheduleBoundsSave)

  win.on('blur', () => {
    logLine('window blur')
    win?.webContents.send('window:blurred')
  })

  win.on('closed', () => {
    win = null
    if (quitting) return
    setTimeout(() => {
      if (win) return
      createWindow()
      applyWindowBounds()
    }, 800)
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
}

function rebuildTray() {
  if (!tray) return
  const cfg = config.get()
  const send = (channel: string) => win?.webContents.send(channel)

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => toggleVisible() },
      { label: '新建便签', accelerator: 'Ctrl+Alt+N', click: () => newNote() },
      { label: '搜索便签', accelerator: 'Ctrl+Alt+F', click: () => searchNotes() },
      { type: 'separator' },
      {
        label: '主题',
        submenu: [
          { label: '纸白', type: 'radio', checked: cfg.theme === 'paper', click: () => setTheme('paper') },
          { label: '墨黑', type: 'radio', checked: cfg.theme === 'ink', click: () => setTheme('ink') },
          { label: '雾灰', type: 'radio', checked: cfg.theme === 'mist', click: () => setTheme('mist') }
        ]
      },
      {
        label: '不透明度',
        submenu: [
          { label: '100%', type: 'radio', checked: cfg.opacity >= 0.995, click: () => setOpacity(1) },
          { label: '95%', type: 'radio', checked: Math.abs(cfg.opacity - 0.95) < 0.02, click: () => setOpacity(0.95) },
          { label: '85%', type: 'radio', checked: Math.abs(cfg.opacity - 0.85) < 0.02, click: () => setOpacity(0.85) },
          { label: '75%', type: 'radio', checked: Math.abs(cfg.opacity - 0.75) < 0.02, click: () => setOpacity(0.75) }
        ]
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: cfg.autostart,
        click: (item) => {
          config.patch({ autostart: item.checked })
          applyAutostart(item.checked)
          rebuildTray()
        }
      },
      {
        label: '钉在桌面',
        type: 'checkbox',
        checked: cfg.embedDesktop,
        click: (item) => {
          config.patch({ embedDesktop: item.checked })
          if (!item.checked) {
            void detachFromDesktop()
          } else if (!lifted) {
            void attachToDesktop()
          }
          rebuildTray()
        }
      },
      { type: 'separator' },
      { label: '打开数据目录', click: () => void shell.openPath(dataDir()) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  void send
}

function setTheme(theme: DzmConfig['theme']) {
  config.patch({ theme })
  win?.webContents.send('config:changed', config.get())
  rebuildTray()
}

function setOpacity(opacity: number) {
  config.patch({ opacity })
  win?.webContents.send('config:changed', config.get())
  rebuildTray()
}

function applyAutostart(enabled: boolean) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  })
}

function toggleVisible() {
  if (!win) return
  if (win.isVisible() && !lifted) {
    win.hide()
  } else {
    win.showInactive()
  }
}

function newNote() {
  if (!win) return
  win.show()
  win.focus()
  win.webContents.send('shortcut:new-note')
}

function searchNotes() {
  if (!win) return
  win.show()
  win.webContents.send('shortcut:search')
}

function setupTray() {
  tray = new Tray(nativeImage.createFromBuffer(createTrayIcon()))
  tray.setToolTip('dzm 桌面便签')
  tray.on('click', () => toggleVisible())
  rebuildTray()
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+D', () => toggleVisible())
  globalShortcut.register('CommandOrControl+Alt+N', () => newNote())
  globalShortcut.register('CommandOrControl+Alt+F', () => searchNotes())
}

function setupIpc() {
  ipcMain.handle('notes:list', () => store.list())
  ipcMain.handle('notes:create', (_e, body: string) => store.create(body ?? ''))
  ipcMain.handle('notes:update', (_e, payload: { id: string; body: string }) => store.update(payload.id, payload.body))
  ipcMain.handle('notes:delete', (_e, id: string) => store.remove(id))
  ipcMain.handle('notes:undo-delete', (_e, token: string) => store.restore(token))
  ipcMain.handle('notes:export', async (_e, id: string) => {
    const note = store.get(id)
    if (!note) return null
    const firstLine = note.body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? 'note'
    const suggested = firstLine.replace(/[\\/:*?"<>|#]/g, '').trim().slice(0, 40) || 'note'
    const result = await dialog.showSaveDialog(win!, {
      title: '导出便签',
      defaultPath: `${suggested}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, note.body, 'utf8')
    return result.filePath
  })
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text ?? '')
  })
  ipcMain.handle('app:open-data-dir', () => shell.openPath(dataDir()))
  ipcMain.handle('app:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return null
  })
  ipcMain.handle('config:get', () => config.get())
  ipcMain.handle('config:patch', (_e, partial: Partial<DzmConfig>) => {
    const next = config.patch(partial)
    win?.webContents.send('config:changed', next)
    return next
  })
  ipcMain.handle('window:lift', async (_e, options?: { cancelIfPointerOutside?: boolean }) => {
    logLine(`lift request guard=${options?.cancelIfPointerOutside === true}`)
    await requestLift(options?.cancelIfPointerOutside === true)
    return 1
  })
  ipcMain.handle('window:sink', async () => {
    await requestSink()
  })

  ipcMain.on('window:resize-start', () => {
    if (!win) return
    measureSizePad()
    const b = win.getBounds()
    resizeOrigin = { winX: b.x, winY: b.y, width: b.width, height: b.height }
    logLine(`resize start pad=${sizePad.w}x${sizePad.h} size=${b.width}x${b.height}`)
  })

  ipcMain.on('window:resize-move', (_e, dx: number, dy: number) => {
    if (!win || !resizeOrigin) return
    win.setBounds({
      x: Math.round(resizeOrigin.winX - posPad.x - workerOrigin.x),
      y: Math.round(resizeOrigin.winY - posPad.y - workerOrigin.y),
      width: Math.max(320, Math.round(resizeOrigin.width + dx)) - sizePad.w,
      height: Math.max(360, Math.round(resizeOrigin.height + dy)) - sizePad.h
    })
  })

  ipcMain.on('window:resize-end', () => {
    const wasResizing = resizeOrigin !== null
    stopResize()
    if (wasResizing) saveWindowBounds()
    logLine(`resize end moved=${wasResizing} pos=${win?.getPosition().join(',')} size=${win?.getSize().join('x')}`)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    newNote()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.novick.dzm')
    config = new ConfigStore(dataDir())
    store = new NotesStore(dataDir())
    setupIpc()
    createWindow()
    measureSizePad()
    applyWindowBounds()
    setupTray()
    registerShortcuts()
    applyAutostart(config.get().autostart)
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })

  app.on('before-quit', async (event) => {
    quitting = true
    if (embedded) {
      event.preventDefault()
      await detachFromDesktop()
      app.exit(0)
    }
  })

  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
