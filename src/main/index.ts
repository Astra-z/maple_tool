import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { DEFAULT_HOTKEY_SETTINGS, HOTKEY_ACTIONS, TIMER_FONT_OPTIONS } from '../shared/types'
import type {
  DisplayInfo,
  HotkeyAction,
  HotkeySettings,
  HotkeyState,
  LensConfig,
  LensSettings,
  LensState,
  Rect,
  SelectionPayload,
  TimerSettings,
  TimerState
} from '../shared/types'

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
  hotkeySettings?: Partial<HotkeySettings>
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
let hotkeySettings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS }
let registeredHotkeys: Record<HotkeyAction, boolean> = {
  lensToggle: false,
  timerToggle: false
}

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

function normalizeHotkeySettings(settings?: Partial<HotkeySettings>): HotkeySettings {
  return HOTKEY_ACTIONS.reduce((nextSettings, action) => {
    const shortcut = settings?.[action]
    nextSettings[action] =
      typeof shortcut === 'string' && shortcut.trim().length > 0 ? shortcut.trim() : DEFAULT_HOTKEY_SETTINGS[action]
    return nextSettings
  }, {} as HotkeySettings)
}

function getHotkeyState(error: string | null = null): HotkeyState {
  return {
    settings: hotkeySettings,
    registered: registeredHotkeys,
    error
  }
}

function broadcastHotkeyState(error: string | null = null): void {
  mainWindow?.webContents.send('hotkeys:updated', getHotkeyState(error))
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
    hotkeySettings,
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
  hotkeySettings = normalizeHotkeySettings(persistedState.hotkeySettings)
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

function getLensState(): LensState {
  return {
    config: lensConfig,
    isOpen: Boolean(lensWindow && !lensWindow.isDestroyed())
  }
}

function broadcastLensState(): void {
  const lensState = getLensState()
  mainWindow?.webContents.send('lens:updated', lensState)
  mainWindow?.webContents.send('selection:updated', lensState.config)
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

function stopTimerTicker(): void {
  if (!timerTickId) return
  clearInterval(timerTickId)
  timerTickId = null
}

function startTimer(): TimerState {
  timerRunning = true
  resetTimerDeadline()
  ensureTimerTicker()
  broadcastTimerState()
  return getTimerState()
}

function stopTimer(): TimerState {
  timerRunning = false
  resetTimerDeadline()
  stopTimerTicker()
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
    if (!isQuitting) {
      savePersistedState()
      app.quit()
    }
  })
}

function hideLens(): LensState {
  if (lensWindow && !lensWindow.isDestroyed()) {
    persistedState.lensWindowBounds = lensWindow.getBounds()
    const windowToClose = lensWindow
    lensWindow = null
    windowToClose.destroy()
  }

  savePersistedState()
  broadcastLensState()
  return getLensState()
}

function showLens(): LensState {
  if (lensConfig) {
    createLensWindow(lensConfig, persistedState.lensWindowBounds)
  }

  broadcastLensState()
  return getLensState()
}

function toggleLens(): LensState {
  if (lensWindow && !lensWindow.isDestroyed()) {
    return hideLens()
  }

  return showLens()
}

function closeLens(): void {
  hideLens()
}

function hideTimer(): TimerState {
  if (timerWindow && !timerWindow.isDestroyed()) {
    persistedState.timerWindowBounds = timerWindow.getBounds()
    const windowToClose = timerWindow
    timerWindow = null
    windowToClose.destroy()
  }

  broadcastTimerState()
  savePersistedState()
  return getTimerState()
}

function toggleTimer(): TimerState {
  if (timerWindow && !timerWindow.isDestroyed()) {
    return hideTimer()
  }

  createTimerWindow(persistedState.timerWindowBounds)
  return getTimerState()
}

function closeTimer(): void {
  hideTimer()
}

function showMainTool(tool: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
  }

  mainWindow?.show()
  mainWindow?.focus()
  mainWindow?.webContents.send('main:tool-selected', tool)
}

function showAboutDialog(): void {
  const options = {
    type: 'info',
    title: '关于 MapleTool',
    message: `MapleTool ${app.getVersion()}`,
    detail: '面向 GMS 国际服冒险岛玩家的小工具。当前包含冷却放大镜、刷图倒计时和可配置热键。'
  } satisfies Electron.MessageBoxOptions

  if (mainWindow && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, options)
    return
  }

  void dialog.showMessageBox(options)
}

function refreshApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: '选择放大镜区域',
          click: createSelectorWindows
        },
        {
          label: '打开 / 关闭放大镜',
          accelerator: hotkeySettings.lensToggle,
          click: toggleLens
        },
        {
          label: '打开 / 关闭倒计时浮层',
          accelerator: hotkeySettings.timerToggle,
          click: toggleTimer
        },
        { type: 'separator' },
        {
          label: '退出 MapleTool',
          role: 'quit'
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: '热键设置',
          click: () => showMainTool('hotkeys')
        },
        {
          label: '关于 MapleTool',
          click: showAboutDialog
        }
      ]
    }
  ])

  Menu.setApplicationMenu(menu)
}

function registerGlobalShortcuts(shouldBroadcast = true): void {
  globalShortcut.unregisterAll()
  registeredHotkeys = {
    lensToggle: false,
    timerToggle: false
  }

  const shortcutHandlers: Record<HotkeyAction, () => void> = {
    lensToggle: toggleLens,
    timerToggle: toggleTimer
  }
  const registeredShortcuts = new Set<string>()

  for (const action of HOTKEY_ACTIONS) {
    const shortcut = hotkeySettings[action]

    if (registeredShortcuts.has(shortcut)) {
      console.warn(`Duplicate global shortcut: ${shortcut}`)
      continue
    }

    registeredHotkeys[action] = globalShortcut.register(shortcut, shortcutHandlers[action])

    if (registeredHotkeys[action]) {
      registeredShortcuts.add(shortcut)
    } else {
      console.warn(`Failed to register global shortcut: ${shortcut}`)
    }
  }

  refreshApplicationMenu()
  if (shouldBroadcast) broadcastHotkeyState()
}

function hasDuplicateHotkey(settings: HotkeySettings): boolean {
  return new Set(HOTKEY_ACTIONS.map((action) => settings[action])).size !== HOTKEY_ACTIONS.length
}

function updateHotkey(action: HotkeyAction, shortcut: string): HotkeyState {
  if (!HOTKEY_ACTIONS.includes(action)) {
    return getHotkeyState('未知的热键配置。')
  }

  const nextSettings = normalizeHotkeySettings({
    ...hotkeySettings,
    [action]: shortcut
  })

  if (hasDuplicateHotkey(nextSettings)) {
    return getHotkeyState('这个快捷键已经被其他功能使用。')
  }

  const previousSettings = hotkeySettings
  hotkeySettings = nextSettings
  registerGlobalShortcuts(false)

  if (!registeredHotkeys[action]) {
    const failedShortcut = hotkeySettings[action]
    hotkeySettings = previousSettings
    registerGlobalShortcuts(false)
    const state = getHotkeyState(`快捷键 ${failedShortcut} 无法注册，可能已被系统或其他软件占用。`)
    broadcastHotkeyState(state.error)
    return state
  }

  savePersistedState()
  broadcastHotkeyState()
  return getHotkeyState()
}

function resetHotkey(action: HotkeyAction): HotkeyState {
  return updateHotkey(action, DEFAULT_HOTKEY_SETTINGS[action])
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

  const createdWindow = lensWindow

  createdWindow.on('close', () => {
    if (!createdWindow.isDestroyed()) {
      persistedState.lensWindowBounds = createdWindow.getBounds()
    }
  })

  createdWindow.on('closed', () => {
    if (lensWindow === createdWindow) {
      lensWindow = null
    }
    if (!isQuitting) {
      broadcastLensState()
      savePersistedState()
    }
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

  const createdWindow = timerWindow

  createdWindow.on('close', () => {
    if (!createdWindow.isDestroyed()) {
      persistedState.timerWindowBounds = createdWindow.getBounds()
    }
  })

  createdWindow.on('closed', () => {
    if (timerWindow === createdWindow) {
      timerWindow = null
    }
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
  broadcastLensState()
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

ipcMain.handle('lens:get-state', () => {
  return getLensState()
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
  broadcastLensState()
  savePersistedState()
})

ipcMain.on('lens:close', () => {
  closeLens()
})

ipcMain.handle('lens:toggle', () => {
  return toggleLens()
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
    stopTimerTicker()
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

ipcMain.handle('timer:toggle', () => {
  return toggleTimer()
})

ipcMain.handle('hotkeys:get-state', () => {
  return getHotkeyState()
})

ipcMain.handle('hotkeys:update', (_event, action: HotkeyAction, shortcut: string) => {
  return updateHotkey(action, shortcut)
})

ipcMain.handle('hotkeys:reset', (_event, action: HotkeyAction) => {
  return resetHotkey(action)
})

app.whenReady().then(() => {
  restorePersistedState()
  refreshApplicationMenu()
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
  stopTimerTicker()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
