import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { CLOSE_LENS_SHORTCUT, CLOSE_TIMER_SHORTCUT, TIMER_FONT_OPTIONS } from '../shared/types'
import type { DisplayInfo, LensConfig, LensSettings, Rect, SelectionPayload, TimerSettings, TimerState } from '../shared/types'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null
let lensWindow: BrowserWindow | null = null
let timerWindow: BrowserWindow | null = null
let selectorWindows: BrowserWindow[] = []
let lensConfig: LensConfig | null = null
let isQuitting = false

type PersistedAppState = {
  mainWindowBounds?: Electron.Rectangle
  currentLensSettings?: Partial<LensSettings>
  lensConfig?: LensConfig | null
  lensOpen?: boolean
  lensWindowBounds?: Electron.Rectangle
  timerSettings?: Partial<TimerSettings>
  timerOpen?: boolean
  timerWindowBounds?: Electron.Rectangle
}

let persistedState: PersistedAppState = {}

const defaultLensSettings: LensSettings = {
  zoom: 1,
  opacity: 0.94,
  locked: false
}

let currentLensSettings: LensSettings = { ...defaultLensSettings }

const defaultTimerSettings: TimerSettings = {
  intervalSeconds: 60,
  audioPath: null,
  audioName: null,
  fontFamily: TIMER_FONT_OPTIONS[0].value,
  locked: false
}

let timerSettings: TimerSettings = { ...defaultTimerSettings }
let timerDeadlineMs = Date.now() + timerSettings.intervalSeconds * 1000
let timerTickId: ReturnType<typeof setInterval> | null = null
let lastTimerRemainingSeconds: number | null = null
let timerRunning = false
let timerReachedZero = false
let timerAudioCache: { path: string; mtimeMs: number; dataUrl: string } | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeLensSettings(settings?: Partial<LensSettings>): LensSettings {
  return {
    zoom: clamp(settings?.zoom ?? defaultLensSettings.zoom, 1, 5),
    opacity: clamp(settings?.opacity ?? defaultLensSettings.opacity, 0.35, 1),
    locked: settings?.locked ?? defaultLensSettings.locked
  }
}

function mergeLensSettings(settings: Partial<LensSettings>): LensSettings {
  return normalizeLensSettings({ ...currentLensSettings, ...settings })
}

function normalizeTimerSettings(settings?: Partial<TimerSettings>): TimerSettings {
  return {
    ...defaultTimerSettings,
    ...settings,
    intervalSeconds: Math.round(clamp(settings?.intervalSeconds ?? defaultTimerSettings.intervalSeconds, 1, 3600)),
    audioPath: settings?.audioPath ?? null,
    audioName: settings?.audioName ?? null,
    fontFamily: settings?.fontFamily ?? defaultTimerSettings.fontFamily,
    locked: settings?.locked ?? defaultTimerSettings.locked
  }
}

function mergeTimerSettings(settings: Partial<TimerSettings>): TimerSettings {
  return normalizeTimerSettings({ ...timerSettings, ...settings })
}

function timerAudioMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase()

  if (extension === '.mp3') return 'audio/mpeg'
  if (extension === '.wav') return 'audio/wav'
  if (extension === '.m4a') return 'audio/mp4'
  if (extension === '.aac') return 'audio/aac'
  if (extension === '.aiff' || extension === '.aif') return 'audio/aiff'
  if (extension === '.flac') return 'audio/flac'
  if (extension === '.ogg') return 'audio/ogg'

  return 'application/octet-stream'
}

function getTimerAudioDataUrl(): string | null {
  const audioPath = timerSettings.audioPath

  if (!audioPath || !existsSync(audioPath)) return null

  try {
    const fileStat = statSync(audioPath)

    if (
      timerAudioCache &&
      timerAudioCache.path === audioPath &&
      timerAudioCache.mtimeMs === fileStat.mtimeMs
    ) {
      return timerAudioCache.dataUrl
    }

    const dataUrl = `data:${timerAudioMimeType(audioPath)};base64,${readFileSync(audioPath).toString('base64')}`
    timerAudioCache = {
      path: audioPath,
      mtimeMs: fileStat.mtimeMs,
      dataUrl
    }

    return dataUrl
  } catch (error) {
    console.warn('Failed to read timer audio.', error)
    timerAudioCache = null
    return null
  }
}

function normalizeWindowBounds(bounds?: Partial<Electron.Rectangle>): Electron.Rectangle | undefined {
  if (!bounds) return undefined

  const width = Math.round(Number(bounds.width))
  const height = Math.round(Number(bounds.height))
  const x = Math.round(Number(bounds.x))
  const y = Math.round(Number(bounds.y))

  if (![x, y, width, height].every(Number.isFinite) || width < 80 || height < 60) {
    return undefined
  }

  return { x, y, width, height }
}

function persistedStatePath(): string {
  return join(app.getPath('userData'), 'maple-tool-state.json')
}

function readPersistedState(): PersistedAppState {
  try {
    const filePath = persistedStatePath()
    if (!existsSync(filePath)) return {}

    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedAppState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.warn('Failed to read persisted state.', error)
    return {}
  }
}

function savePersistedState(): void {
  if (!app.isReady()) return

  const nextState: PersistedAppState = {
    mainWindowBounds:
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : normalizeWindowBounds(persistedState.mainWindowBounds),
    currentLensSettings,
    lensConfig,
    lensOpen: Boolean(lensWindow && !lensWindow.isDestroyed()),
    lensWindowBounds:
      lensWindow && !lensWindow.isDestroyed()
        ? lensWindow.getBounds()
        : normalizeWindowBounds(persistedState.lensWindowBounds),
    timerSettings,
    timerOpen: Boolean(timerWindow && !timerWindow.isDestroyed()),
    timerWindowBounds:
      timerWindow && !timerWindow.isDestroyed()
        ? timerWindow.getBounds()
        : normalizeWindowBounds(persistedState.timerWindowBounds)
  }

  try {
    const filePath = persistedStatePath()
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(filePath, JSON.stringify(nextState, null, 2), 'utf8')
    persistedState = nextState
  } catch (error) {
    console.warn('Failed to save persisted state.', error)
  }
}

function restorePersistedState(): void {
  persistedState = readPersistedState()
  currentLensSettings = normalizeLensSettings(persistedState.currentLensSettings)
  timerSettings = normalizeTimerSettings(persistedState.timerSettings)
  resetTimerDeadline()

  if (persistedState.lensConfig) {
    lensConfig = {
      ...persistedState.lensConfig,
      settings: currentLensSettings
    }
  }
}

function getTimerRemainingSeconds(): number {
  if (!timerRunning) return timerSettings.intervalSeconds
  return Math.max(0, Math.ceil((timerDeadlineMs - Date.now()) / 1000))
}

function resetTimerDeadline(): void {
  timerDeadlineMs = Date.now() + timerSettings.intervalSeconds * 1000
  lastTimerRemainingSeconds = null
  timerReachedZero = false
}

function getTimerState(): TimerState {
  return {
    settings: timerSettings,
    isOpen: Boolean(timerWindow && !timerWindow.isDestroyed()),
    isRunning: timerRunning,
    remainingSeconds: getTimerRemainingSeconds()
  }
}

function broadcastTimerState(): void {
  const timerState = getTimerState()
  mainWindow?.webContents.send('timer:updated', timerState)
  timerWindow?.webContents.send('timer:updated', timerState)
}

function broadcastTimerAlert(): void {
  mainWindow?.webContents.send('timer:alert')
  timerWindow?.webContents.send('timer:visual-alert')
}

function emitTimerTick(): void {
  if (!timerRunning) return

  const now = Date.now()
  let remainingSeconds = getTimerRemainingSeconds()

  if (remainingSeconds === 0) {
    if (!timerReachedZero) {
      timerReachedZero = true
      broadcastTimerAlert()
    } else if (now >= timerDeadlineMs + 1000) {
      timerDeadlineMs = now + timerSettings.intervalSeconds * 1000
      timerReachedZero = false
      lastTimerRemainingSeconds = null
      remainingSeconds = getTimerRemainingSeconds()
    }
  }

  if (remainingSeconds !== lastTimerRemainingSeconds) {
    lastTimerRemainingSeconds = remainingSeconds
    broadcastTimerState()
  }
}

function ensureTimerTicker(): void {
  if (timerTickId) return
  timerTickId = setInterval(emitTimerTick, 250)
  emitTimerTick()
}

function startTimer(): TimerState {
  timerRunning = true
  resetTimerDeadline()
  broadcastTimerState()
  return getTimerState()
}

function stopTimer(): TimerState {
  timerRunning = false
  resetTimerDeadline()
  broadcastTimerState()
  return getTimerState()
}

function applyTimerWindowBehavior(window: BrowserWindow, settings: TimerSettings): void {
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.setResizable(!settings.locked)
  window.setMovable(!settings.locked)
  window.setIgnoreMouseEvents(settings.locked, { forward: true })
}

function applyLensWindowBehavior(window: BrowserWindow, settings: LensSettings): void {
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setOpacity(1)
  window.setResizable(!settings.locked)
  window.setMovable(!settings.locked)
  window.setIgnoreMouseEvents(settings.locked, { forward: true })
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.mjs')
}

function loadRenderer(window: BrowserWindow, view: string, query: Record<string, string> = {}): void {
  const params = new URLSearchParams({ view, ...query })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${params.toString()}`)
    return
  }

  window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: Object.fromEntries(params)
  })
}

function displayToInfo(display: Electron.Display): DisplayInfo {
  return {
    id: String(display.id),
    bounds: display.bounds,
    scaleFactor: display.scaleFactor
  }
}

function clampLensSize(region: Rect, zoom: number): { width: number; height: number } {
  const width = Math.round(Math.min(Math.max(region.width * zoom, 120), 860))
  const height = Math.round(Math.min(Math.max(region.height * zoom, 72), 520))
  return { width, height }
}

function createMainWindow(): void {
  const restoredBounds = normalizeWindowBounds(persistedState.mainWindowBounds)

  mainWindow = new BrowserWindow({
    x: restoredBounds?.x,
    y: restoredBounds?.y,
    width: restoredBounds?.width ?? 980,
    height: restoredBounds?.height ?? 680,
    minWidth: 860,
    minHeight: 580,
    title: 'MapleTool',
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  loadRenderer(mainWindow, 'main')

  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      persistedState.mainWindowBounds = mainWindow.getBounds()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (!isQuitting) savePersistedState()
  })
}

function closeLens(): void {
  lensConfig = null

  if (lensWindow && !lensWindow.isDestroyed()) {
    lensWindow.close()
  } else {
    savePersistedState()
  }

  mainWindow?.webContents.send('selection:updated', null)
}

function closeTimer(): void {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.close()
    return
  }

  broadcastTimerState()
  savePersistedState()
}

function registerGlobalShortcuts(): void {
  const shortcuts = [
    { shortcut: CLOSE_LENS_SHORTCUT, action: closeLens },
    { shortcut: CLOSE_TIMER_SHORTCUT, action: closeTimer }
  ]

  for (const item of shortcuts) {
    const registered = globalShortcut.register(item.shortcut, item.action)

    if (!registered) {
      console.warn(`Failed to register global shortcut: ${item.shortcut}`)
    }
  }
}

function closeSelectorWindows(): void {
  for (const selectorWindow of selectorWindows) {
    if (!selectorWindow.isDestroyed()) {
      selectorWindow.close()
    }
  }
  selectorWindows = []
}

function createSelectorWindows(): void {
  closeSelectorWindows()

  for (const display of screen.getAllDisplays()) {
    const bounds = display.bounds
    const selectorWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    selectorWindow.setAlwaysOnTop(true, 'screen-saver')
    selectorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    loadRenderer(selectorWindow, 'selector', {
      displayId: String(display.id),
      x: String(bounds.x),
      y: String(bounds.y),
      width: String(bounds.width),
      height: String(bounds.height),
      scaleFactor: String(display.scaleFactor)
    })

    selectorWindows.push(selectorWindow)
  }
}

function createLensWindow(config: LensConfig, restoredBounds?: Electron.Rectangle): void {
  if (lensWindow && !lensWindow.isDestroyed()) {
    lensWindow.close()
  }

  const displayBounds = config.display.bounds
  const size = clampLensSize(config.region, config.settings.zoom)
  const windowBounds =
    normalizeWindowBounds(restoredBounds) ?? {
      x: Math.round(displayBounds.x + displayBounds.width - size.width - 40),
      y: Math.round(displayBounds.y + 48),
      width: size.width,
      height: size.height
    }

  lensWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    minWidth: 100,
    minHeight: 64,
    frame: false,
    transparent: true,
    resizable: !config.settings.locked,
    hasShadow: false,
    movable: !config.settings.locked,
    title: 'MapleTool Lens',
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  applyLensWindowBehavior(lensWindow, config.settings)
  loadRenderer(lensWindow, 'lens')

  lensWindow.on('close', () => {
    if (lensWindow && !lensWindow.isDestroyed()) {
      persistedState.lensWindowBounds = lensWindow.getBounds()
    }
  })

  lensWindow.on('closed', () => {
    lensWindow = null
    if (!isQuitting) savePersistedState()
  })

  savePersistedState()
}

function createTimerWindow(restoredBounds?: Electron.Rectangle): void {
  if (timerWindow && !timerWindow.isDestroyed()) {
    applyTimerWindowBehavior(timerWindow, timerSettings)
    timerWindow.showInactive()
    timerWindow.moveTop()
    broadcastTimerState()
    savePersistedState()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const bounds = primaryDisplay.bounds
  const width = 260
  const height = 136
  const windowBounds =
    normalizeWindowBounds(restoredBounds) ?? {
      x: Math.round(bounds.x + bounds.width - width - 48),
      y: Math.round(bounds.y + 96),
      width,
      height
    }

  timerWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    minWidth: 220,
    minHeight: 112,
    frame: false,
    transparent: true,
    resizable: !timerSettings.locked,
    hasShadow: false,
    movable: !timerSettings.locked,
    title: 'MapleTool Timer',
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  timerWindow.once('ready-to-show', () => {
    if (!timerWindow || timerWindow.isDestroyed()) return
    applyTimerWindowBehavior(timerWindow, timerSettings)
    timerWindow.showInactive()
    timerWindow.moveTop()
    broadcastTimerState()
  })

  loadRenderer(timerWindow, 'timer')
  applyTimerWindowBehavior(timerWindow, timerSettings)
  timerWindow.showInactive()
  timerWindow.moveTop()

  timerWindow.on('close', () => {
    if (timerWindow && !timerWindow.isDestroyed()) {
      persistedState.timerWindowBounds = timerWindow.getBounds()
    }
  })

  timerWindow.on('closed', () => {
    timerWindow = null
    if (!isQuitting) {
      broadcastTimerState()
      savePersistedState()
    }
  })

  broadcastTimerState()
  savePersistedState()
}

async function getScreenSource(displayId: string) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }
  })

  const exact = sources.find((source) => source.display_id === displayId)
  const fallback = sources[0]

  if (!exact && !fallback) {
    throw new Error('No screen source is available.')
  }

  const source = exact ?? fallback
  return {
    id: source.id,
    name: source.name,
    displayId: source.display_id
  }
}

ipcMain.handle('selection:start', () => {
  createSelectorWindows()
})

ipcMain.on('selection:complete', (_event, payload: SelectionPayload) => {
  const region = {
    x: Math.round(payload.region.x),
    y: Math.round(payload.region.y),
    width: Math.round(payload.region.width),
    height: Math.round(payload.region.height)
  }

  if (region.width < 20 || region.height < 20) {
    closeSelectorWindows()
    return
  }

  lensConfig = {
    display: payload.display,
    region,
    settings: currentLensSettings
  }

  closeSelectorWindows()
  createLensWindow(lensConfig)
  mainWindow?.webContents.send('selection:updated', lensConfig)
  savePersistedState()
})

ipcMain.on('selection:cancel', () => {
  closeSelectorWindows()
})

ipcMain.handle('screen:get-source', (_event, displayId: string) => {
  return getScreenSource(displayId)
})

ipcMain.handle('lens:get-config', () => {
  return lensConfig
})

ipcMain.on('lens:update-settings', (_event, settings: Partial<LensSettings>) => {
  currentLensSettings = mergeLensSettings(settings)

  if (!lensConfig) {
    savePersistedState()
    return
  }

  lensConfig = {
    ...lensConfig,
    settings: currentLensSettings
  }

  if (lensWindow && !lensWindow.isDestroyed() && settings.zoom !== undefined) {
    const bounds = lensWindow.getBounds()
    const nextSize = clampLensSize(lensConfig.region, lensConfig.settings.zoom)
    lensWindow.setBounds({
      ...bounds,
      width: nextSize.width,
      height: nextSize.height
    })
  }

  if (
    lensWindow &&
    !lensWindow.isDestroyed() &&
    (settings.opacity !== undefined || settings.locked !== undefined)
  ) {
    applyLensWindowBehavior(lensWindow, lensConfig.settings)
  }

  lensWindow?.webContents.send('lens:settings', lensConfig.settings)
  mainWindow?.webContents.send('selection:updated', lensConfig)
  savePersistedState()
})

ipcMain.on('lens:close', () => {
  closeLens()
})

ipcMain.handle('timer:get-settings', () => {
  return getTimerState()
})

ipcMain.handle('timer:choose-audio', async () => {
  const dialogOptions = {
    title: '选择倒计时提示音',
    properties: ['openFile'],
    filters: [
      {
        name: '音频文件',
        extensions: ['mp3', 'wav', 'm4a', 'aac', 'aiff', 'flac', 'ogg']
      },
      {
        name: '所有文件',
        extensions: ['*']
      }
    ]
  } satisfies Electron.OpenDialogOptions

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return getTimerState()
  }

  const audioPath = result.filePaths[0]
  timerSettings = mergeTimerSettings({
    audioPath,
    audioName: basename(audioPath)
  })
  timerAudioCache = null

  timerWindow?.webContents.send('timer:settings', timerSettings)
  broadcastTimerState()
  savePersistedState()
  return getTimerState()
})

ipcMain.handle('timer:reset-audio', () => {
  timerSettings = mergeTimerSettings({
    audioPath: null,
    audioName: null
  })
  timerAudioCache = null

  timerWindow?.webContents.send('timer:settings', timerSettings)
  broadcastTimerState()
  savePersistedState()
  return getTimerState()
})

ipcMain.on('timer:update-settings', (_event, settings: Partial<TimerSettings>) => {
  const previousInterval = timerSettings.intervalSeconds
  timerSettings = mergeTimerSettings(settings)

  if (settings.intervalSeconds !== undefined && timerSettings.intervalSeconds !== previousInterval) {
    timerRunning = false
    resetTimerDeadline()
  }

  if (timerWindow && !timerWindow.isDestroyed()) {
    applyTimerWindowBehavior(timerWindow, timerSettings)
  }
  timerWindow?.webContents.send('timer:settings', timerSettings)
  broadcastTimerState()
  savePersistedState()
})

ipcMain.handle('timer:start', () => {
  return startTimer()
})

ipcMain.handle('timer:stop', () => {
  return stopTimer()
})

ipcMain.handle('timer:get-audio-data-url', () => {
  return getTimerAudioDataUrl()
})

ipcMain.on('timer:open', () => {
  createTimerWindow(persistedState.timerWindowBounds)
})

ipcMain.on('timer:close', () => {
  closeTimer()
})

app.whenReady().then(() => {
  restorePersistedState()
  ensureTimerTicker()
  createMainWindow()
  registerGlobalShortcuts()

  if (persistedState.lensOpen && lensConfig) {
    createLensWindow(lensConfig, persistedState.lensWindowBounds)
  }

  if (persistedState.timerOpen) {
    createTimerWindow(persistedState.timerWindowBounds)
  }

  app.on('activate', () => {
    if (!mainWindow) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  savePersistedState()
})

app.on('will-quit', () => {
  if (timerTickId) {
    clearInterval(timerTickId)
    timerTickId = null
  }
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
