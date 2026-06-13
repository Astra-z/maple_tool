export const HOTKEY_ACTIONS = ['lensToggle', 'timerToggle'] as const

export const DEFAULT_HOTKEY_SETTINGS = {
  lensToggle: 'CommandOrControl+Shift+M',
  timerToggle: 'CommandOrControl+Shift+T'
} as const

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]

export type HotkeySettings = Record<HotkeyAction, string>

export type HotkeyState = {
  settings: HotkeySettings
  registered: Record<HotkeyAction, boolean>
  error: string | null
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

export type LensState = {
  config: LensConfig | null
  isOpen: boolean
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
