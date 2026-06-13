import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  DEFAULT_HOTKEY_SETTINGS,
  DEFAULT_LENS_PROFILE_HOTKEY_PREFIX,
  HOTKEY_ACTIONS,
  TIMER_FONT_OPTIONS
} from '../shared/types'
import type {
  DisplayInfo,
  HotkeyAction,
  HotkeySettings,
  HotkeyState,
  LensCapture,
  LensConfig,
  LensProfile,
  LensSettings,
  LensState,
  Rect,
  SelectionPayload,
  TimerSettings,
  TimerProfile,
  TimerState,
  UpdateCheckResult
} from '../shared/types'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
const releasePageUrl = 'https://github.com/Astra-z/maple_tool/releases'
const latestReleaseApiUrl = 'https://api.github.com/repos/Astra-z/maple_tool/releases/latest'

let mainWindow: BrowserWindow | null = null
let lensWindows = new Map<string, BrowserWindow>()
let timerWindow: BrowserWindow | null = null
let selectorWindows: BrowserWindow[] = []
let tray: Tray | null = null
let mutedLensClosedCaptureIds = new Set<string>()
let isQuitting = false

type PersistedAppState = {
  mainWindowBounds?: Electron.Rectangle
  currentLensSettings?: Partial<LensSettings>
  lensProfiles?: LensProfile[]
  activeLensProfileId?: string
  activeLensCaptureId?: string | null
  lensProfileShortcutPrefix?: string
  // Legacy single-lens fields kept for migrating existing local caches.
  lensConfig?: LensConfig | null
  lensOpen?: boolean
  lensWindowBounds?: Electron.Rectangle
  timerProfiles?: TimerProfile[]
  activeTimerProfileId?: string
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
let lensProfiles: LensProfile[] = []
let activeLensProfileId = 'default'
let activeLensCaptureId: string | null = null
let lensVisible = false

const defaultTimerSettings: TimerSettings = {
  intervalSeconds: 60,
  audioPath: null,
  audioName: null,
  fontFamily: TIMER_FONT_OPTIONS[0].value,
  locked: false
}

let timerSettings: TimerSettings = { ...defaultTimerSettings }
let timerProfiles: TimerProfile[] = []
let activeTimerProfileId = 'default'
let timerDeadlineMs = Date.now() + timerSettings.intervalSeconds * 1000
let timerTickId: ReturnType<typeof setInterval> | null = null
let lastTimerRemainingSeconds: number | null = null
let timerRunning = false
let timerReachedZero = false
let timerAudioCache: { path: string; mtimeMs: number; dataUrl: string } | null = null
let hotkeySettings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS }
let lensProfileShortcutPrefix = DEFAULT_LENS_PROFILE_HOTKEY_PREFIX
let registeredHotkeys: Record<HotkeyAction, boolean> = {
  lensToggle: false,
  timerToggle: false
}
let registeredLensProfileShortcuts = new Map<string, boolean>()

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

function normalizeVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

function compareVersions(currentVersion: string, latestVersion: string): number {
  const currentParts = normalizeVersion(currentVersion)
  const latestParts = normalizeVersion(latestVersion)
  const length = Math.max(currentParts.length, latestParts.length)

  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0
    const latestPart = latestParts[index] ?? 0

    if (latestPart > currentPart) return 1
    if (latestPart < currentPart) return -1
  }

  return 0
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

function createDefaultLensProfile(): LensProfile {
  return {
    id: 'default',
    name: '默认角色',
    captures: []
  }
}

function normalizeRect(rect?: Partial<Rect>, minWidth = 1, minHeight = 1): Rect | null {
  if (!rect) return null

  const x = Math.round(Number(rect.x))
  const y = Math.round(Number(rect.y))
  const width = Math.round(Number(rect.width))
  const height = Math.round(Number(rect.height))

  if (![x, y, width, height].every(Number.isFinite) || width < minWidth || height < minHeight) {
    return null
  }

  return { x, y, width, height }
}

function normalizeDisplayInfo(display?: Partial<DisplayInfo>): DisplayInfo | null {
  const bounds = normalizeRect(display?.bounds, 1, 1)
  if (!display || !bounds) return null

  const scaleFactor = Number(display.scaleFactor)

  return {
    id: String(display.id ?? '0'),
    bounds,
    scaleFactor: Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  }
}

function normalizeLensCapture(capture: Partial<LensCapture>, index: number): LensCapture | null {
  const display = normalizeDisplayInfo(capture.display)
  const region = normalizeRect(capture.region, 20, 20)

  if (!display || !region) return null

  return {
    id: typeof capture.id === 'string' && capture.id.trim() ? capture.id : createId('capture'),
    name: typeof capture.name === 'string' && capture.name.trim() ? capture.name.trim() : `技能 ${index + 1}`,
    display,
    region,
    settings: normalizeLensSettings(capture.settings),
    windowBounds: normalizeRect(capture.windowBounds, 80, 60) ?? undefined
  }
}

function normalizeLensProfiles(profiles?: LensProfile[]): LensProfile[] {
  if (!Array.isArray(profiles)) return []

  return profiles
    .map((profile, profileIndex) => {
      const captures = Array.isArray(profile?.captures)
        ? profile.captures
            .map((capture, captureIndex) => normalizeLensCapture(capture, captureIndex))
            .filter((capture): capture is LensCapture => Boolean(capture))
        : []

      return {
        id: typeof profile?.id === 'string' && profile.id.trim() ? profile.id : createId('profile'),
        name:
          typeof profile?.name === 'string' && profile.name.trim()
            ? profile.name.trim()
            : profileIndex === 0
              ? '默认角色'
              : `角色 ${profileIndex + 1}`,
        captures
      }
    })
    .filter((profile) => profile.name.length > 0)
}

function ensureLensProfiles(): void {
  if (lensProfiles.length === 0) {
    lensProfiles = [createDefaultLensProfile()]
  }

  if (!lensProfiles.some((profile) => profile.id === activeLensProfileId)) {
    activeLensProfileId = lensProfiles[0].id
  }

  const activeProfile = getActiveLensProfile()
  if (!activeProfile) return

  if (!activeLensCaptureId || !activeProfile.captures.some((capture) => capture.id === activeLensCaptureId)) {
    activeLensCaptureId = activeProfile.captures[0]?.id ?? null
  }

  const activeCapture = getActiveLensCapture()
  if (activeCapture) {
    currentLensSettings = normalizeLensSettings(activeCapture.settings)
  }
}

function getActiveLensProfile(): LensProfile | null {
  return lensProfiles.find((profile) => profile.id === activeLensProfileId) ?? lensProfiles[0] ?? null
}

function getActiveLensCapture(): LensCapture | null {
  const activeProfile = getActiveLensProfile()
  if (!activeProfile || !activeLensCaptureId) return null
  return activeProfile.captures.find((capture) => capture.id === activeLensCaptureId) ?? null
}

function findLensCapture(captureId: string): { profile: LensProfile; capture: LensCapture } | null {
  for (const profile of lensProfiles) {
    const capture = profile.captures.find((item) => item.id === captureId)
    if (capture) return { profile, capture }
  }

  return null
}

function updateLensCapture(captureId: string, updater: (capture: LensCapture) => LensCapture): LensCapture | null {
  let updatedCapture: LensCapture | null = null

  lensProfiles = lensProfiles.map((profile) => ({
    ...profile,
    captures: profile.captures.map((capture) => {
      if (capture.id !== captureId) return capture
      updatedCapture = updater(capture)
      return updatedCapture
    })
  }))

  return updatedCapture
}

function syncOpenLensWindowBounds(): void {
  for (const [captureId, lensWindow] of lensWindows) {
    if (lensWindow.isDestroyed()) continue
    const bounds = lensWindow.getBounds()
    updateLensCapture(captureId, (capture) => ({
      ...capture,
      windowBounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      }
    }))
  }
}

function getOpenLensCaptureIds(): string[] {
  return [...lensWindows.entries()]
    .filter(([, lensWindow]) => !lensWindow.isDestroyed())
    .map(([captureId]) => captureId)
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

function createDefaultTimerProfile(settings: TimerSettings = defaultTimerSettings): TimerProfile {
  return {
    id: 'default',
    name: '默认配置',
    settings: normalizeTimerSettings(settings)
  }
}

function normalizeTimerProfile(profile: Partial<TimerProfile> | null | undefined, index: number): TimerProfile | null {
  if (!profile) return null

  const settings = normalizeTimerSettings(profile.settings)

  return {
    id: typeof profile.id === 'string' && profile.id.trim() ? profile.id : createId('timer-profile'),
    name:
      typeof profile.name === 'string' && profile.name.trim()
        ? profile.name.trim()
        : index === 0
          ? '默认配置'
          : `配置 ${index + 1}`,
    settings,
    windowBounds: normalizeRect(profile.windowBounds, 80, 60) ?? undefined
  }
}

function normalizeTimerProfiles(profiles?: TimerProfile[]): TimerProfile[] {
  if (!Array.isArray(profiles)) return []

  return profiles
    .map((profile, index) => normalizeTimerProfile(profile, index))
    .filter((profile): profile is TimerProfile => Boolean(profile))
}

function getActiveTimerProfile(): TimerProfile | null {
  return timerProfiles.find((profile) => profile.id === activeTimerProfileId) ?? timerProfiles[0] ?? null
}

function ensureTimerProfiles(): void {
  if (timerProfiles.length === 0) {
    timerProfiles = [createDefaultTimerProfile(timerSettings)]
  }

  if (!timerProfiles.some((profile) => profile.id === activeTimerProfileId)) {
    activeTimerProfileId = timerProfiles[0].id
  }

  const activeProfile = getActiveTimerProfile()
  if (activeProfile) {
    timerSettings = normalizeTimerSettings(activeProfile.settings)
  }
}

function updateTimerProfile(profileId: string, updater: (profile: TimerProfile) => TimerProfile): TimerProfile | null {
  let updatedProfile: TimerProfile | null = null

  timerProfiles = timerProfiles.map((profile) => {
    if (profile.id !== profileId) return profile
    updatedProfile = updater(profile)
    return updatedProfile
  })

  return updatedProfile
}

function syncActiveTimerProfile(bounds?: Partial<Rect>): void {
  if (timerProfiles.length === 0) {
    timerProfiles = [createDefaultTimerProfile(timerSettings)]
  }

  const activeProfile = getActiveTimerProfile()
  if (!activeProfile) return

  const normalizedBounds =
    normalizeRect(bounds, 80, 60) ??
    (timerWindow && !timerWindow.isDestroyed() ? normalizeRect(timerWindow.getBounds(), 80, 60) : null)

  updateTimerProfile(activeProfile.id, (profile) => ({
    ...profile,
    settings: timerSettings,
    windowBounds: normalizedBounds ?? profile.windowBounds
  }))
}

function normalizeHotkeySettings(settings?: Partial<HotkeySettings>): HotkeySettings {
  return HOTKEY_ACTIONS.reduce((nextSettings, action) => {
    const shortcut = settings?.[action]
    nextSettings[action] =
      typeof shortcut === 'string' && shortcut.trim().length > 0 ? shortcut.trim() : DEFAULT_HOTKEY_SETTINGS[action]
    return nextSettings
  }, {} as HotkeySettings)
}

function normalizeLensProfileShortcutPrefix(prefix?: string): string {
  if (typeof prefix !== 'string') return DEFAULT_LENS_PROFILE_HOTKEY_PREFIX

  const tokens = prefix
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)

  const normalizedTokens: string[] = []

  for (const token of tokens) {
    const lowerToken = token.toLowerCase()
    const normalizedToken =
      lowerToken === 'ctrl' || lowerToken === 'control' || lowerToken === 'cmd' || lowerToken === 'command'
        ? 'CommandOrControl'
        : lowerToken === 'commandorcontrol' || lowerToken === 'commandorctrl'
          ? 'CommandOrControl'
          : lowerToken === 'alt' || lowerToken === 'option'
            ? 'Alt'
            : lowerToken === 'shift'
              ? 'Shift'
              : null

    if (normalizedToken && !normalizedTokens.includes(normalizedToken)) {
      normalizedTokens.push(normalizedToken)
    }
  }

  return normalizedTokens.length > 0 ? normalizedTokens.join('+') : DEFAULT_LENS_PROFILE_HOTKEY_PREFIX
}

function lensProfileShortcut(index: number): string | undefined {
  if (index < 0 || index > 8) return undefined
  return `${lensProfileShortcutPrefix}+${index + 1}`
}

function getHotkeyState(error: string | null = null): HotkeyState {
  return {
    settings: hotkeySettings,
    lensProfilePrefix: lensProfileShortcutPrefix,
    registered: registeredHotkeys,
    error
  }
}

type GitHubReleaseAsset = {
  name?: string
  browser_download_url?: string
}

type GitHubRelease = {
  tag_name?: string
  name?: string
  html_url?: string
  assets?: GitHubReleaseAsset[]
}

function pickReleaseDownloadUrl(release: GitHubRelease): string | null {
  const assets = Array.isArray(release.assets) ? release.assets : []

  if (process.platform === 'win32') {
    return assets.find((asset) => asset.browser_download_url && asset.name?.toLowerCase().endsWith('.exe'))
      ?.browser_download_url ?? null
  }

  if (process.platform === 'darwin') {
    return assets.find((asset) => asset.browser_download_url && /\.(dmg|zip)$/i.test(asset.name ?? ''))
      ?.browser_download_url ?? null
  }

  return assets.find((asset) => asset.browser_download_url)?.browser_download_url ?? null
}

function getAppInfo() {
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    releasePageUrl
  }
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const checkedAt = new Date().toISOString()

  try {
    const response = await fetch(latestReleaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MapleTool/${currentVersion}`
      }
    })

    if (!response.ok) {
      return {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseName: null,
        releaseUrl: releasePageUrl,
        downloadUrl: null,
        error:
          response.status === 404
            ? '无法读取最新版本。当前 GitHub 仓库可能是私有仓库，请打开 Release 页面手动查看。'
            : `检查更新失败：GitHub 返回 ${response.status}。`,
        checkedAt
      }
    }

    const release = (await response.json()) as GitHubRelease
    const latestVersion = release.tag_name?.trim() ?? null
    const releaseUrl = release.html_url ?? releasePageUrl
    const hasUpdate = latestVersion ? compareVersions(currentVersion, latestVersion) > 0 : false

    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseName: release.name ?? latestVersion,
      releaseUrl,
      downloadUrl: pickReleaseDownloadUrl(release),
      error: latestVersion ? null : '最新版本信息不完整，请打开 Release 页面手动查看。',
      checkedAt
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseName: null,
      releaseUrl: releasePageUrl,
      downloadUrl: null,
      error: `检查更新失败：${message}`,
      checkedAt
    }
  }
}

function safeReleaseUrl(url?: string): string {
  if (!url) return releasePageUrl

  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.hostname === 'github.com' && parsedUrl.pathname.startsWith('/Astra-z/maple_tool/')) {
      return parsedUrl.toString()
    }
  } catch {
    return releasePageUrl
  }

  return releasePageUrl
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

function normalizeWindowBounds(
  bounds?: Partial<Electron.Rectangle>,
  minimum: { width: number; height: number } = { width: 80, height: 60 }
): Electron.Rectangle | undefined {
  if (!bounds) return undefined

  const width = Math.round(Number(bounds.width))
  const height = Math.round(Number(bounds.height))
  const x = Math.round(Number(bounds.x))
  const y = Math.round(Number(bounds.y))

  if (![x, y, width, height].every(Number.isFinite) || width < minimum.width || height < minimum.height) {
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

  syncOpenLensWindowBounds()
  ensureLensProfiles()
  syncActiveTimerProfile()
  const activeTimerProfile = getActiveTimerProfile()

  const nextState: PersistedAppState = {
    mainWindowBounds:
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : normalizeWindowBounds(persistedState.mainWindowBounds),
    currentLensSettings,
    lensProfiles,
    activeLensProfileId,
    activeLensCaptureId,
    lensProfileShortcutPrefix,
    lensOpen: lensVisible,
    timerProfiles,
    activeTimerProfileId,
    timerSettings,
    hotkeySettings,
    timerOpen: Boolean(timerWindow && !timerWindow.isDestroyed()),
    timerWindowBounds:
      timerWindow && !timerWindow.isDestroyed()
        ? timerWindow.getBounds()
        : normalizeWindowBounds(activeTimerProfile?.windowBounds ?? persistedState.timerWindowBounds)
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
  lensProfiles = normalizeLensProfiles(persistedState.lensProfiles)

  if (lensProfiles.length === 0 && persistedState.lensConfig) {
    const migratedCapture = normalizeLensCapture(
      {
        ...persistedState.lensConfig,
        id: 'legacy-capture',
        name: '技能 1',
        windowBounds: normalizeWindowBounds(persistedState.lensWindowBounds)
      },
      0
    )

    lensProfiles = [
      {
        ...createDefaultLensProfile(),
        captures: migratedCapture ? [migratedCapture] : []
      }
    ]
  }

  if (lensProfiles.length === 0) {
    lensProfiles = [createDefaultLensProfile()]
  }

  activeLensProfileId = persistedState.activeLensProfileId ?? lensProfiles[0].id
  activeLensCaptureId = persistedState.activeLensCaptureId ?? lensProfiles[0].captures[0]?.id ?? null
  lensVisible = Boolean(persistedState.lensOpen)
  lensProfileShortcutPrefix = normalizeLensProfileShortcutPrefix(persistedState.lensProfileShortcutPrefix)
  ensureLensProfiles()
  const legacyTimerSettings = normalizeTimerSettings(persistedState.timerSettings)
  timerProfiles = normalizeTimerProfiles(persistedState.timerProfiles)

  if (timerProfiles.length === 0) {
    timerProfiles = [
      {
        ...createDefaultTimerProfile(legacyTimerSettings),
        windowBounds: normalizeRect(persistedState.timerWindowBounds, 80, 60) ?? undefined
      }
    ]
  }

  activeTimerProfileId = persistedState.activeTimerProfileId ?? timerProfiles[0].id
  ensureTimerProfiles()
  hotkeySettings = normalizeHotkeySettings(persistedState.hotkeySettings)
  resetTimerDeadline()
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
  ensureLensProfiles()
  const activeProfile = getActiveLensProfile()
  const activeOpenCaptureIds = new Set(getOpenLensCaptureIds())

  return {
    config: getActiveLensCapture(),
    profiles: lensProfiles.map((profile, index) => ({
      ...profile,
      shortcut: lensProfileShortcut(index),
      shortcutRegistered: registeredLensProfileShortcuts.get(profile.id) ?? false
    })),
    activeProfileId: activeLensProfileId,
    activeCaptureId: activeLensCaptureId,
    isOpen: lensVisible && Boolean(activeProfile?.captures.length),
    openCaptureIds: [...activeOpenCaptureIds]
  }
}

function broadcastLensState(): void {
  const lensState = getLensState()
  mainWindow?.webContents.send('lens:updated', lensState)
  mainWindow?.webContents.send('selection:updated', lensState.config)
  for (const lensWindow of lensWindows.values()) {
    if (!lensWindow.isDestroyed()) {
      lensWindow.webContents.send('lens:updated', lensState)
    }
  }
}

function getTimerState(): TimerState {
  ensureTimerProfiles()

  return {
    settings: timerSettings,
    profiles: timerProfiles,
    activeProfileId: activeTimerProfileId,
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

function trayIconPath(): string {
  if (app.isPackaged) {
    const packagedIconPath = join(process.resourcesPath, 'icon.ico')
    if (existsSync(packagedIconPath)) return packagedIconPath
  }

  const devIconPath = join(process.cwd(), 'build/icon.ico')
  if (existsSync(devIconPath)) return devIconPath

  return join(process.cwd(), 'build/icon.png')
}

function restoreMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
  }

  if (mainWindow?.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow?.show()
  mainWindow?.focus()
}

function minimizeMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  persistedState.mainWindowBounds = mainWindow.getBounds()

  if (process.platform === 'win32') {
    mainWindow.hide()
    return
  }

  mainWindow.minimize()
}

function quitFromTray(): void {
  isQuitting = true
  app.quit()
}

function createTray(): void {
  if (process.platform !== 'win32' || tray) return

  const trayImage = nativeImage.createFromPath(trayIconPath())
  if (trayImage.isEmpty()) {
    console.warn('Unable to create MapleTool tray icon.')
    return
  }

  tray = new Tray(trayImage)
  tray.setToolTip('MapleTool')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: restoreMainWindow
      },
      { type: 'separator' },
      {
        label: '打开 / 关闭放大镜',
        click: toggleLens
      },
      {
        label: '打开 / 关闭倒计时浮层',
        click: toggleTimer
      },
      { type: 'separator' },
      {
        label: '退出 MapleTool',
        click: quitFromTray
      }
    ])
  )
  tray.on('click', restoreMainWindow)
  tray.on('double-click', restoreMainWindow)
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
  const width = Math.round(Math.min(Math.max(region.width * zoom, 20), 860))
  const height = Math.round(Math.min(Math.max(region.height * zoom, 20), 520))
  return { width, height }
}

function clampLegacyLensSize(region: Rect, zoom: number): { width: number; height: number } {
  const width = Math.round(Math.min(Math.max(region.width * zoom, 120), 860))
  const height = Math.round(Math.min(Math.max(region.height * zoom, 72), 520))
  return { width, height }
}

function isLegacyGeneratedLensSize(capture: LensCapture, bounds: Electron.Rectangle): boolean {
  const legacySize = clampLegacyLensSize(capture.region, capture.settings.zoom)
  const matchesLegacySize = Math.abs(bounds.width - legacySize.width) <= 2 && Math.abs(bounds.height - legacySize.height) <= 2
  const usedLegacyMinimum = capture.region.width < 120 || capture.region.height < 72
  return matchesLegacySize && (capture.settings.zoom !== defaultLensSettings.zoom || usedLegacyMinimum)
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

  mainWindow.on('minimize', () => {
    if (process.platform !== 'win32' || isQuitting) return

    minimizeMainWindow()
  })

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

function hideLens(options: { broadcast?: boolean; preserveVisible?: boolean } = {}): LensState {
  const shouldBroadcast = options.broadcast ?? true
  const shouldPreserveVisible = options.preserveVisible ?? false
  syncOpenLensWindowBounds()
  if (!shouldPreserveVisible) {
    lensVisible = false
  }

  for (const [captureId, lensWindow] of lensWindows) {
    if (!lensWindow.isDestroyed()) {
      if (!shouldBroadcast) {
        mutedLensClosedCaptureIds.add(captureId)
      }
      lensWindows.delete(captureId)
      lensWindow.destroy()
    }
  }

  savePersistedState()
  if (shouldBroadcast) {
    broadcastLensState()
  }
  return getLensState()
}

function showLens(): LensState {
  lensVisible = true
  const activeProfile = getActiveLensProfile()
  if (activeProfile) {
    for (const capture of activeProfile.captures) {
      createLensWindow(capture)
    }
  }

  broadcastLensState()
  return getLensState()
}

function toggleLens(): LensState {
  if (lensVisible) {
    return hideLens()
  }

  return showLens()
}

function closeLens(): void {
  hideLens()
}

function selectLensProfile(profileId: string): LensState {
  if (!lensProfiles.some((profile) => profile.id === profileId)) {
    return getLensState()
  }

  const shouldRestoreLens = lensVisible || getOpenLensCaptureIds().length > 0
  hideLens({ broadcast: false, preserveVisible: true })
  activeLensProfileId = profileId
  activeLensCaptureId = getActiveLensProfile()?.captures[0]?.id ?? null
  const activeCapture = getActiveLensCapture()
  currentLensSettings = activeCapture ? normalizeLensSettings(activeCapture.settings) : { ...defaultLensSettings }

  if (shouldRestoreLens) {
    lensVisible = true
    const activeProfile = getActiveLensProfile()
    for (const capture of activeProfile?.captures ?? []) {
      createLensWindow(capture)
    }
  } else {
    lensVisible = false
  }

  savePersistedState()
  broadcastLensState()
  return getLensState()
}

function hideTimer(): TimerState {
  if (timerWindow && !timerWindow.isDestroyed()) {
    syncActiveTimerProfile(timerWindow.getBounds())
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

  createTimerWindow(getActiveTimerProfile()?.windowBounds)
  return getTimerState()
}

function closeTimer(): void {
  hideTimer()
}

function createTimerProfile(name: string): TimerState {
  syncActiveTimerProfile()

  const profileName = typeof name === 'string' && name.trim() ? name.trim() : `配置 ${timerProfiles.length + 1}`
  const profile: TimerProfile = {
    id: createId('timer-profile'),
    name: profileName,
    settings: normalizeTimerSettings(timerSettings)
  }

  const wasTimerOpen = Boolean(timerWindow && !timerWindow.isDestroyed())
  if (wasTimerOpen) {
    hideTimer()
  }

  timerProfiles = [...timerProfiles, profile]
  activeTimerProfileId = profile.id
  timerSettings = normalizeTimerSettings(profile.settings)
  timerRunning = false
  resetTimerDeadline()
  stopTimerTicker()

  if (wasTimerOpen) {
    createTimerWindow(profile.windowBounds)
  }

  broadcastTimerState()
  savePersistedState()
  return getTimerState()
}

function renameTimerProfile(profileId: string, name: string): TimerState {
  const nextName = typeof name === 'string' && name.trim() ? name.trim() : ''
  if (!nextName) return getTimerState()

  updateTimerProfile(profileId, (profile) => ({
    ...profile,
    name: nextName
  }))

  broadcastTimerState()
  savePersistedState()
  return getTimerState()
}

function selectTimerProfile(profileId: string): TimerState {
  if (!timerProfiles.some((profile) => profile.id === profileId)) {
    return getTimerState()
  }

  const wasTimerOpen = Boolean(timerWindow && !timerWindow.isDestroyed())
  if (wasTimerOpen) {
    hideTimer()
  } else {
    syncActiveTimerProfile()
  }

  activeTimerProfileId = profileId
  timerSettings = normalizeTimerSettings(getActiveTimerProfile()?.settings)
  timerRunning = false
  resetTimerDeadline()
  stopTimerTicker()
  timerAudioCache = null

  if (wasTimerOpen) {
    createTimerWindow(getActiveTimerProfile()?.windowBounds)
  }

  timerWindow?.webContents.send('timer:settings', timerSettings)
  broadcastTimerState()
  savePersistedState()
  return getTimerState()
}

function deleteTimerProfile(profileId: string): TimerState {
  if (timerProfiles.length <= 1) return getTimerState()

  const deleteIndex = timerProfiles.findIndex((profile) => profile.id === profileId)
  if (deleteIndex < 0) return getTimerState()

  const wasActive = activeTimerProfileId === profileId
  const wasTimerOpen = Boolean(timerWindow && !timerWindow.isDestroyed())

  if (wasActive && wasTimerOpen) {
    hideTimer()
  } else {
    syncActiveTimerProfile()
  }

  timerProfiles = timerProfiles.filter((profile) => profile.id !== profileId)

  if (wasActive) {
    activeTimerProfileId = timerProfiles[Math.max(0, deleteIndex - 1)]?.id ?? timerProfiles[0].id
    timerSettings = normalizeTimerSettings(getActiveTimerProfile()?.settings)
    timerRunning = false
    resetTimerDeadline()
    stopTimerTicker()
    timerAudioCache = null

    if (wasTimerOpen) {
      createTimerWindow(getActiveTimerProfile()?.windowBounds)
    }
  }

  broadcastTimerState()
  savePersistedState()
  return getTimerState()
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
        {
          label: process.platform === 'win32' ? '最小化到托盘' : '最小化主窗口',
          accelerator: process.platform === 'darwin' ? 'Command+M' : 'Ctrl+M',
          click: minimizeMainWindow
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
          click: () => showMainTool('about')
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
  registeredLensProfileShortcuts = new Map()

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

  lensProfiles.slice(0, 9).forEach((profile, index) => {
    const shortcut = lensProfileShortcut(index)
    if (!shortcut) return

    if (registeredShortcuts.has(shortcut)) {
      registeredLensProfileShortcuts.set(profile.id, false)
      console.warn(`Duplicate lens profile shortcut: ${shortcut}`)
      return
    }

    const registered = globalShortcut.register(shortcut, () => {
      selectLensProfile(profile.id)
    })
    registeredLensProfileShortcuts.set(profile.id, registered)

    if (registered) {
      registeredShortcuts.add(shortcut)
    } else {
      console.warn(`Failed to register lens profile shortcut: ${shortcut}`)
    }
  })

  refreshApplicationMenu()
  if (shouldBroadcast) broadcastHotkeyState()
  if (shouldBroadcast) broadcastLensState()
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

function updateLensProfileShortcutPrefix(prefix: string): HotkeyState {
  const nextPrefix = normalizeLensProfileShortcutPrefix(prefix)

  lensProfileShortcutPrefix = nextPrefix
  registerGlobalShortcuts(false)

  const failedProfileIndex = lensProfiles
    .slice(0, 9)
    .findIndex((profile) => registeredLensProfileShortcuts.get(profile.id) !== true)

  savePersistedState()
  const error =
    failedProfileIndex >= 0
      ? `已保存，但角色快捷键 ${lensProfileShortcut(failedProfileIndex) ?? nextPrefix} 无法注册，可能已被系统或其他软件占用。`
      : null

  broadcastHotkeyState(error)
  broadcastLensState()
  return getHotkeyState(error)
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
    const shouldUseFullscreenSelector = process.platform === 'win32'
    const selectorWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      fullscreen: shouldUseFullscreenSelector,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: shouldUseFullscreenSelector,
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
    if (shouldUseFullscreenSelector) {
      selectorWindow.setBounds(bounds)
      selectorWindow.setFullScreen(true)
    }

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

function createLensWindow(config: LensCapture): void {
  lensVisible = true
  const existingWindow = lensWindows.get(config.id)
  if (existingWindow && !existingWindow.isDestroyed()) {
    applyLensWindowBehavior(existingWindow, config.settings)
    existingWindow.showInactive()
    existingWindow.moveTop()
    existingWindow.webContents.send('lens:settings', config.settings)
    broadcastLensState()
    savePersistedState()
    return
  }

  const displayBounds = config.display.bounds
  const size = clampLensSize(config.region, defaultLensSettings.zoom)
  const activeProfile = getActiveLensProfile()
  const captureIndex = Math.max(0, activeProfile?.captures.findIndex((capture) => capture.id === config.id) ?? 0)
  const restoredBounds = normalizeWindowBounds(config.windowBounds, { width: 20, height: 20 })
  const shouldResetLegacySize = restoredBounds ? isLegacyGeneratedLensSize(config, restoredBounds) : false
  const windowBounds =
    restoredBounds
      ? {
          x: restoredBounds.x,
          y: restoredBounds.y,
          width: shouldResetLegacySize ? size.width : restoredBounds.width,
          height: shouldResetLegacySize ? size.height : restoredBounds.height
        }
      : {
          x: Math.round(displayBounds.x + displayBounds.width - size.width - 40),
          y: Math.round(displayBounds.y + 48 + captureIndex * 28),
          width: size.width,
          height: size.height
        }

  const lensWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    minWidth: 20,
    minHeight: 20,
    frame: false,
    transparent: true,
    resizable: !config.settings.locked,
    hasShadow: false,
    movable: !config.settings.locked,
    title: `MapleTool Lens - ${config.name}`,
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
  loadRenderer(lensWindow, 'lens', { captureId: config.id })
  lensWindows.set(config.id, lensWindow)

  const createdWindow = lensWindow

  createdWindow.on('close', () => {
    if (!createdWindow.isDestroyed()) {
      const bounds = createdWindow.getBounds()
      updateLensCapture(config.id, (capture) => ({
        ...capture,
        windowBounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        }
      }))
    }
  })

  createdWindow.on('closed', () => {
    const shouldMute = mutedLensClosedCaptureIds.delete(config.id)
    lensWindows.delete(config.id)
    if (!isQuitting && !shouldMute) {
      if (getOpenLensCaptureIds().length === 0) {
        lensVisible = false
      }
      broadcastLensState()
      savePersistedState()
    }
  })

  savePersistedState()
}

function createTimerWindow(restoredBounds?: Partial<Rect>): void {
  ensureTimerProfiles()

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
  const activeProfile = getActiveTimerProfile()
  const windowBounds =
    normalizeWindowBounds(restoredBounds ?? activeProfile?.windowBounds) ?? {
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
      syncActiveTimerProfile(createdWindow.getBounds())
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
  ensureLensProfiles()

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

  const activeProfile = getActiveLensProfile()
  if (!activeProfile) {
    closeSelectorWindows()
    return
  }

  const capture: LensCapture = {
    id: createId('capture'),
    name: `技能 ${activeProfile.captures.length + 1}`,
    display: payload.display,
    region,
    settings: {
      ...currentLensSettings,
      zoom: defaultLensSettings.zoom
    }
  }

  lensProfiles = lensProfiles.map((profile) =>
    profile.id === activeProfile.id ? { ...profile, captures: [...profile.captures, capture] } : profile
  )
  activeLensProfileId = activeProfile.id
  activeLensCaptureId = capture.id
  currentLensSettings = normalizeLensSettings(capture.settings)

  closeSelectorWindows()
  createLensWindow(capture)
  broadcastLensState()
  savePersistedState()
})

ipcMain.on('selection:cancel', () => {
  closeSelectorWindows()
})

ipcMain.handle('screen:get-source', (_event, displayId: string) => {
  return getScreenSource(displayId)
})

ipcMain.handle('lens:get-config', (_event, captureId?: string) => {
  if (typeof captureId === 'string' && captureId.trim()) {
    return findLensCapture(captureId)?.capture ?? null
  }

  return getActiveLensCapture()
})

ipcMain.handle('lens:get-state', () => {
  return getLensState()
})

ipcMain.on('lens:update-settings', (_event, settings: Partial<LensSettings>, captureId?: string) => {
  currentLensSettings = mergeLensSettings(settings)
  const targetCaptureId = typeof captureId === 'string' && captureId.trim() ? captureId : activeLensCaptureId

  if (!targetCaptureId) {
    savePersistedState()
    broadcastLensState()
    return
  }

  updateLensCapture(targetCaptureId, (capture) => ({
    ...capture,
    settings: currentLensSettings
  }))

  const lensWindow = lensWindows.get(targetCaptureId)

  if (
    lensWindow &&
    !lensWindow.isDestroyed() &&
    (settings.opacity !== undefined || settings.locked !== undefined)
  ) {
    applyLensWindowBehavior(lensWindow, currentLensSettings)
  }

  lensWindow?.webContents.send('lens:settings', currentLensSettings)
  broadcastLensState()
  savePersistedState()
})

ipcMain.on('lens:close', () => {
  closeLens()
})

ipcMain.handle('lens:toggle', () => {
  return toggleLens()
})

ipcMain.handle('lens:create-profile', (_event, name: string) => {
  const profileName = typeof name === 'string' && name.trim() ? name.trim() : `角色 ${lensProfiles.length + 1}`
  const profile: LensProfile = {
    id: createId('profile'),
    name: profileName,
    captures: []
  }

  hideLens({ broadcast: false })
  lensProfiles = [...lensProfiles, profile]
  activeLensProfileId = profile.id
  activeLensCaptureId = null
  currentLensSettings = { ...defaultLensSettings }
  registerGlobalShortcuts(false)
  savePersistedState()
  broadcastLensState()
  return getLensState()
})

ipcMain.handle('lens:rename-profile', (_event, profileId: string, name: string) => {
  const nextName = typeof name === 'string' ? name.trim() : ''
  if (!nextName) return getLensState()

  lensProfiles = lensProfiles.map((profile) => (profile.id === profileId ? { ...profile, name: nextName } : profile))
  savePersistedState()
  broadcastLensState()
  return getLensState()
})

ipcMain.handle('lens:select-profile', (_event, profileId: string) => {
  return selectLensProfile(profileId)
})

ipcMain.handle('lens:delete-profile', (_event, profileId: string) => {
  if (lensProfiles.length <= 1) return getLensState()

  for (const capture of lensProfiles.find((profile) => profile.id === profileId)?.captures ?? []) {
    const lensWindow = lensWindows.get(capture.id)
    if (lensWindow && !lensWindow.isDestroyed()) {
      lensWindows.delete(capture.id)
      lensWindow.destroy()
    }
  }

  lensProfiles = lensProfiles.filter((profile) => profile.id !== profileId)
  if (activeLensProfileId === profileId) {
    activeLensProfileId = lensProfiles[0]?.id ?? createDefaultLensProfile().id
    activeLensCaptureId = getActiveLensProfile()?.captures[0]?.id ?? null
  }

  ensureLensProfiles()
  registerGlobalShortcuts(false)
  savePersistedState()
  broadcastLensState()
  return getLensState()
})

ipcMain.handle('lens:select-capture', (_event, captureId: string) => {
  const result = findLensCapture(captureId)
  if (!result) return getLensState()

  activeLensProfileId = result.profile.id
  activeLensCaptureId = result.capture.id
  currentLensSettings = normalizeLensSettings(result.capture.settings)
  savePersistedState()
  broadcastLensState()
  return getLensState()
})

ipcMain.handle('lens:rename-capture', (_event, captureId: string, name: string) => {
  const nextName = typeof name === 'string' ? name.trim() : ''
  if (!nextName) return getLensState()

  updateLensCapture(captureId, (capture) => ({ ...capture, name: nextName }))
  const lensWindow = lensWindows.get(captureId)
  if (lensWindow && !lensWindow.isDestroyed()) {
    lensWindow.setTitle(`MapleTool Lens - ${nextName}`)
  }
  savePersistedState()
  broadcastLensState()
  return getLensState()
})

ipcMain.handle('lens:delete-capture', (_event, captureId: string) => {
  const lensWindow = lensWindows.get(captureId)
  if (lensWindow && !lensWindow.isDestroyed()) {
    lensWindows.delete(captureId)
    lensWindow.destroy()
  }

  lensProfiles = lensProfiles.map((profile) => ({
    ...profile,
    captures: profile.captures.filter((capture) => capture.id !== captureId)
  }))

  if (activeLensCaptureId === captureId) {
    activeLensCaptureId = getActiveLensProfile()?.captures[0]?.id ?? null
    const activeCapture = getActiveLensCapture()
    currentLensSettings = activeCapture ? normalizeLensSettings(activeCapture.settings) : { ...defaultLensSettings }
  }

  savePersistedState()
  broadcastLensState()
  return getLensState()
})

ipcMain.handle('timer:get-settings', () => {
  return getTimerState()
})

ipcMain.handle('timer:create-profile', (_event, name: string) => {
  return createTimerProfile(name)
})

ipcMain.handle('timer:rename-profile', (_event, profileId: string, name: string) => {
  return renameTimerProfile(profileId, name)
})

ipcMain.handle('timer:select-profile', (_event, profileId: string) => {
  return selectTimerProfile(profileId)
})

ipcMain.handle('timer:delete-profile', (_event, profileId: string) => {
  return deleteTimerProfile(profileId)
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
  syncActiveTimerProfile()

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
  syncActiveTimerProfile()

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
  syncActiveTimerProfile()
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
  createTimerWindow(getActiveTimerProfile()?.windowBounds)
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

ipcMain.handle('hotkeys:update-profile-prefix', (_event, prefix: string) => {
  return updateLensProfileShortcutPrefix(prefix)
})

ipcMain.handle('app:get-info', () => {
  return getAppInfo()
})

ipcMain.handle('app:check-update', () => {
  return checkForUpdates()
})

ipcMain.handle('app:open-release-page', (_event, url?: string) => {
  return shell.openExternal(safeReleaseUrl(url))
})

app.whenReady().then(() => {
  restorePersistedState()
  refreshApplicationMenu()
  createTray()
  createMainWindow()
  registerGlobalShortcuts()

  if (persistedState.lensOpen) {
    showLens()
  }

  if (persistedState.timerOpen) {
    createTimerWindow(getActiveTimerProfile()?.windowBounds)
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
