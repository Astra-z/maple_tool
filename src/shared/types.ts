export const CLOSE_LENS_SHORTCUT = 'CommandOrControl+Shift+M'
export const CLOSE_LENS_SHORTCUT_LABEL = 'Ctrl / Command + Shift + M'
export const CLOSE_TIMER_SHORTCUT = 'CommandOrControl+Shift+T'
export const CLOSE_TIMER_SHORTCUT_LABEL = 'Ctrl / Command + Shift + T'

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
