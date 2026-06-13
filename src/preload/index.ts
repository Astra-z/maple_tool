import { contextBridge, ipcRenderer } from 'electron'
import type {
  HotkeyAction,
  HotkeyState,
  LensConfig,
  LensSettings,
  LensState,
  ScreenSource,
  SelectionPayload,
  TimerSettings,
  TimerState
} from '../shared/types'

const api = {
  startSelection: (): Promise<void> => ipcRenderer.invoke('selection:start'),
  completeSelection: (payload: SelectionPayload): void => {
    ipcRenderer.send('selection:complete', payload)
  },
  cancelSelection: (): void => {
    ipcRenderer.send('selection:cancel')
  },
  getScreenSource: (displayId: string): Promise<ScreenSource> => {
    return ipcRenderer.invoke('screen:get-source', displayId)
  },
  getLensConfig: (): Promise<LensConfig | null> => {
    return ipcRenderer.invoke('lens:get-config')
  },
  getLensState: (): Promise<LensState> => {
    return ipcRenderer.invoke('lens:get-state')
  },
  updateLensSettings: (settings: Partial<LensSettings>): void => {
    ipcRenderer.send('lens:update-settings', settings)
  },
  closeLens: (): void => {
    ipcRenderer.send('lens:close')
  },
  toggleLens: (): Promise<LensState> => {
    return ipcRenderer.invoke('lens:toggle')
  },
  getTimerState: (): Promise<TimerState> => {
    return ipcRenderer.invoke('timer:get-settings')
  },
  chooseTimerAudio: (): Promise<TimerState> => {
    return ipcRenderer.invoke('timer:choose-audio')
  },
  resetTimerAudio: (): Promise<TimerState> => {
    return ipcRenderer.invoke('timer:reset-audio')
  },
  startTimer: (): Promise<TimerState> => {
    return ipcRenderer.invoke('timer:start')
  },
  stopTimer: (): Promise<TimerState> => {
    return ipcRenderer.invoke('timer:stop')
  },
  getTimerAudioDataUrl: (): Promise<string | null> => {
    return ipcRenderer.invoke('timer:get-audio-data-url')
  },
  updateTimerSettings: (settings: Partial<TimerSettings>): void => {
    ipcRenderer.send('timer:update-settings', settings)
  },
  openTimer: (): void => {
    ipcRenderer.send('timer:open')
  },
  closeTimer: (): void => {
    ipcRenderer.send('timer:close')
  },
  toggleTimer: (): Promise<TimerState> => {
    return ipcRenderer.invoke('timer:toggle')
  },
  getHotkeyState: (): Promise<HotkeyState> => {
    return ipcRenderer.invoke('hotkeys:get-state')
  },
  updateHotkey: (action: HotkeyAction, shortcut: string): Promise<HotkeyState> => {
    return ipcRenderer.invoke('hotkeys:update', action, shortcut)
  },
  resetHotkey: (action: HotkeyAction): Promise<HotkeyState> => {
    return ipcRenderer.invoke('hotkeys:reset', action)
  },
  onSelectionUpdated: (callback: (config: LensConfig | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: LensConfig | null): void => callback(config)
    ipcRenderer.on('selection:updated', handler)
    return () => ipcRenderer.removeListener('selection:updated', handler)
  },
  onLensUpdated: (callback: (state: LensState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: LensState): void => callback(state)
    ipcRenderer.on('lens:updated', handler)
    return () => ipcRenderer.removeListener('lens:updated', handler)
  },
  onLensSettings: (callback: (settings: LensSettings) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: LensSettings): void => callback(settings)
    ipcRenderer.on('lens:settings', handler)
    return () => ipcRenderer.removeListener('lens:settings', handler)
  },
  onTimerSettings: (callback: (settings: TimerSettings) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: TimerSettings): void => callback(settings)
    ipcRenderer.on('timer:settings', handler)
    return () => ipcRenderer.removeListener('timer:settings', handler)
  },
  onTimerUpdated: (callback: (state: TimerState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TimerState): void => callback(state)
    ipcRenderer.on('timer:updated', handler)
    return () => ipcRenderer.removeListener('timer:updated', handler)
  },
  onTimerAlert: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('timer:alert', handler)
    return () => ipcRenderer.removeListener('timer:alert', handler)
  },
  onTimerVisualAlert: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('timer:visual-alert', handler)
    return () => ipcRenderer.removeListener('timer:visual-alert', handler)
  },
  onHotkeysUpdated: (callback: (state: HotkeyState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: HotkeyState): void => callback(state)
    ipcRenderer.on('hotkeys:updated', handler)
    return () => ipcRenderer.removeListener('hotkeys:updated', handler)
  },
  onMainToolSelected: (callback: (tool: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tool: string): void => callback(tool)
    ipcRenderer.on('main:tool-selected', handler)
    return () => ipcRenderer.removeListener('main:tool-selected', handler)
  }
}

contextBridge.exposeInMainWorld('maple', api)

export type MapleAPI = typeof api
