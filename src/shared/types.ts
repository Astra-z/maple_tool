export const HOTKEY_ACTIONS = ['lensToggle', 'timerToggle'] as const

export const DEFAULT_HOTKEY_SETTINGS = {
  lensToggle: 'CommandOrControl+Shift+M',
  timerToggle: 'CommandOrControl+Shift+T'
} as const

export const DEFAULT_LENS_PROFILE_HOTKEY_PREFIX = 'CommandOrControl+Shift'

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]

export type HotkeySettings = Record<HotkeyAction, string>

export type HotkeyState = {
  settings: HotkeySettings
  lensProfilePrefix: string
  registered: Record<HotkeyAction, boolean>
  error: string | null
}

export type AppInfo = {
  name: string
  version: string
  platform: string
  arch: string
  releasePageUrl: string
}

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  releaseName: string | null
  releaseUrl: string | null
  downloadUrl: string | null
  error: string | null
  checkedAt: string
}

export const TIMER_FONT_OPTIONS = [
  {
    label: '系统默认',
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  {
    label: '等宽数字',
    value: '"SF Mono", "Cascadia Mono", Consolas, monospace'
  },
  {
    label: 'Arial',
    value: 'Arial, sans-serif'
  },
  {
    label: 'Georgia',
    value: 'Georgia, serif'
  }
] as const

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type DisplayInfo = {
  id: string
  bounds: Rect
  scaleFactor: number
}

export type LensSettings = {
  zoom: number
  opacity: number
  locked: boolean
}

export type LensConfig = {
  display: DisplayInfo
  region: Rect
  settings: LensSettings
}

export type LensCapture = LensConfig & {
  id: string
  name: string
  windowBounds?: Rect
}

export type LensProfile = {
  id: string
  name: string
  captures: LensCapture[]
  shortcut?: string
  shortcutRegistered?: boolean
}

export type LensState = {
  config: LensCapture | null
  profiles: LensProfile[]
  activeProfileId: string
  activeCaptureId: string | null
  isOpen: boolean
  openCaptureIds: string[]
}

export type ScreenSource = {
  id: string
  name: string
  displayId: string
}

export type SelectionPayload = {
  display: DisplayInfo
  region: Rect
}

export type TimerSettings = {
  intervalSeconds: number
  audioPath: string | null
  audioName: string | null
  fontFamily: string
  locked: boolean
}

export type TimerState = {
  settings: TimerSettings
  isOpen: boolean
  isRunning: boolean
  remainingSeconds: number
}
