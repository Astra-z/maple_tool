import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Aperture,
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  ClockCountdown,
  Crosshair,
  Eye,
  FrameCorners,
  GearSix,
  Info,
  Keyboard,
  LockKey,
  LockKeyOpen,
  MusicNote,
  PencilSimple,
  Play,
  Plus,
  Selection,
  Stop,
  Trash,
  UserCircle,
  X
} from '@phosphor-icons/react'
import { DEFAULT_HOTKEY_SETTINGS, DEFAULT_LENS_PROFILE_HOTKEY_PREFIX, TIMER_FONT_OPTIONS } from '../../shared/types'
import type {
  AppInfo,
  DisplayInfo,
  HotkeyAction,
  HotkeyState,
  LensCapture,
  LensProfile,
  LensSettings,
  LensState,
  SelectionPayload,
  TimerSettings,
  TimerState,
  UpdateCheckResult
} from '../../shared/types'
import './styles.css'

type MainTool = 'lens' | 'timer' | 'hotkeys' | 'about'

const LENS_RENDER_FPS = 12
const LENS_RENDER_INTERVAL_MS = 1000 / LENS_RENDER_FPS

const defaultRendererSettings: LensSettings = {
  zoom: 1,
  opacity: 0.94,
  locked: false
}

const defaultTimerSettings: TimerSettings = {
  intervalSeconds: 60,
  audioPath: null,
  audioName: null,
  fontFamily: TIMER_FONT_OPTIONS[0].value,
  locked: false
}

const defaultTimerState: TimerState = {
  settings: defaultTimerSettings,
  isOpen: false,
  isRunning: false,
  remainingSeconds: defaultTimerSettings.intervalSeconds
}

const defaultLensState: LensState = {
  config: null,
  profiles: [
    {
      id: 'default',
      name: '默认角色',
      captures: []
    }
  ],
  activeProfileId: 'default',
  activeCaptureId: null,
  isOpen: false,
  openCaptureIds: []
}

const defaultHotkeyState: HotkeyState = {
  settings: { ...DEFAULT_HOTKEY_SETTINGS },
  lensProfilePrefix: DEFAULT_LENS_PROFILE_HOTKEY_PREFIX,
  registered: {
    lensToggle: false,
    timerToggle: false
  },
  error: null
}

const defaultAppInfo: AppInfo = {
  name: 'MapleTool',
  version: '0.0.0',
  platform: 'unknown',
  arch: 'unknown',
  releasePageUrl: 'https://github.com/Astra-z/maple_tool/releases'
}

let timerAudioContext: AudioContext | null = null

function getView(): string {
  return new URLSearchParams(window.location.search).get('view') ?? 'main'
}

const currentView = getView()
document.body.dataset.view = currentView

function getDisplayFromQuery(): DisplayInfo {
  const params = new URLSearchParams(window.location.search)
  return {
    id: params.get('displayId') ?? '0',
    bounds: {
      x: Number(params.get('x') ?? 0),
      y: Number(params.get('y') ?? 0),
      width: Number(params.get('width') ?? window.innerWidth),
      height: Number(params.get('height') ?? window.innerHeight)
    },
    scaleFactor: Number(params.get('scaleFactor') ?? 1)
  }
}

function getCaptureIdFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get('captureId')
}

function rangeFill(value: number, min: number, max: number): React.CSSProperties {
  const percent = ((value - min) / (max - min)) * 100
  return { '--fill': `${Math.min(Math.max(percent, 0), 100)}%` } as React.CSSProperties
}

function formatSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function normalizeTimerState(state: TimerState): TimerState {
  const fallbackRemaining = state.settings?.intervalSeconds ?? defaultTimerSettings.intervalSeconds
  return {
    settings: {
      ...defaultTimerSettings,
      ...state.settings
    },
    isOpen: Boolean(state.isOpen),
    isRunning: Boolean(state.isRunning),
    remainingSeconds: Number.isFinite(state.remainingSeconds) ? state.remainingSeconds : fallbackRemaining
  }
}

function normalizeLensState(state: LensState): LensState {
  const profiles = Array.isArray(state.profiles) && state.profiles.length > 0 ? state.profiles : defaultLensState.profiles
  const activeProfileId = profiles.some((profile) => profile.id === state.activeProfileId)
    ? state.activeProfileId
    : profiles[0].id
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
  const activeCaptureId =
    state.activeCaptureId && activeProfile.captures.some((capture) => capture.id === state.activeCaptureId)
      ? state.activeCaptureId
      : activeProfile.captures[0]?.id ?? null

  return {
    config: state.config ?? activeProfile.captures.find((capture) => capture.id === activeCaptureId) ?? null,
    profiles,
    activeProfileId,
    activeCaptureId,
    isOpen: Boolean(state.isOpen),
    openCaptureIds: Array.isArray(state.openCaptureIds) ? state.openCaptureIds : []
  }
}

function normalizeHotkeyState(state: HotkeyState): HotkeyState {
  return {
    settings: {
      ...DEFAULT_HOTKEY_SETTINGS,
      ...state.settings
    },
    lensProfilePrefix: state.lensProfilePrefix ?? DEFAULT_LENS_PROFILE_HOTKEY_PREFIX,
    registered: {
      lensToggle: Boolean(state.registered?.lensToggle),
      timerToggle: Boolean(state.registered?.timerToggle)
    },
    error: state.error ?? null
  }
}

function getPrimaryModifierLabel(): string {
  const userAgentPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform
  const platform = userAgentPlatform ?? navigator.platform
  return /mac/i.test(platform) ? 'Command' : 'Ctrl'
}

function formatShortcut(shortcut: string): string {
  return shortcut
    .replaceAll('CommandOrControl', getPrimaryModifierLabel())
    .replaceAll('+', ' + ')
}

function keyToAcceleratorKey(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.replace('Key', '')
  if (/^Digit[0-9]$/.test(event.code)) return event.code.replace('Digit', '')
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code

  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Enter: 'Enter',
    Escape: 'Escape',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Space: 'Space',
    Tab: 'Tab'
  }

  return keyMap[event.code] ?? null
}

function eventToShortcut(event: KeyboardEvent): string | null {
  const key = keyToAcceleratorKey(event)

  if (!key || ['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) {
    return null
  }

  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  if (parts.length === 0) return null

  parts.push(key)
  return parts.join('+')
}

function eventToShortcutPreview(event: KeyboardEvent): string | null {
  const key = keyToAcceleratorKey(event)
  const parts: string[] = []

  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (key && !['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) parts.push(key)

  return parts.length > 0 ? parts.join('+') : null
}

function shortcutToProfilePrefix(shortcut: string): string | null {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length < 2) return null

  const key = parts[parts.length - 1]
  const prefixParts = parts.slice(0, -1)

  if (!/^[1-9]$/.test(key)) return null

  return prefixParts.length > 0 ? prefixParts.join('+') : null
}

function getInitialMainTool(): MainTool {
  try {
    const savedTool = window.localStorage.getItem('maple.activeTool')
    if (savedTool === 'lens' || savedTool === 'timer' || savedTool === 'hotkeys' || savedTool === 'about') {
      return savedTool
    }
  } catch {
    return 'lens'
  }

  return 'lens'
}

function MainPanel(): React.ReactElement {
  const [lensState, setLensState] = useState<LensState>(defaultLensState)
  const [settings, setSettings] = useState<LensSettings>(defaultRendererSettings)
  const [timerState, setTimerState] = useState<TimerState>(defaultTimerState)
  const [hotkeyState, setHotkeyState] = useState<HotkeyState>(defaultHotkeyState)
  const [appInfo, setAppInfo] = useState<AppInfo>(defaultAppInfo)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [activeTool, setActiveTool] = useState<MainTool>(getInitialMainTool)
  const [busy, setBusy] = useState(false)
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [profileNameDraft, setProfileNameDraft] = useState('')
  const [editingCaptureId, setEditingCaptureId] = useState<string | null>(null)
  const [captureNameDraft, setCaptureNameDraft] = useState('')
  const timerSettingsRef = useRef(defaultTimerSettings)

  const applyLensState = (nextState: LensState): void => {
    const normalizedState = normalizeLensState(nextState)
    setLensState(normalizedState)
    setSettings(normalizedState.config?.settings ?? defaultRendererSettings)
  }

  useEffect(() => {
    window.maple.getLensState().then((nextState) => {
      applyLensState(nextState)
    })

    return window.maple.onLensUpdated((nextState) => {
      applyLensState(nextState)
    })
  }, [])

  useEffect(() => {
    window.maple.getTimerState().then((state) => setTimerState(normalizeTimerState(state)))
    return window.maple.onTimerUpdated((state) => setTimerState(normalizeTimerState(state)))
  }, [])

  useEffect(() => {
    window.maple.getHotkeyState().then((state) => setHotkeyState(normalizeHotkeyState(state)))
    return window.maple.onHotkeysUpdated((state) => setHotkeyState(normalizeHotkeyState(state)))
  }, [])

  useEffect(() => {
    window.maple.getAppInfo().then(setAppInfo)
  }, [])

  useEffect(() => {
    return window.maple.onMainToolSelected((tool) => {
      if (tool === 'lens' || tool === 'timer' || tool === 'hotkeys' || tool === 'about') {
        setActiveTool(tool)
      }
    })
  }, [])

  useEffect(() => {
    timerSettingsRef.current = timerState.settings
  }, [timerState.settings])

  useEffect(() => {
    return window.maple.onTimerAlert(() => {
      void playTimerAlertSound(timerSettingsRef.current.audioPath)
    })
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem('maple.activeTool', activeTool)
    } catch {
      // Ignore storage failures; the app still works without restoring the selected menu.
    }
  }, [activeTool])

  const updateSetting = (next: Partial<LensSettings>): void => {
    setSettings((current) => ({ ...current, ...next }))
    window.maple.updateLensSettings(next, lensState.activeCaptureId ?? undefined)
    setLensState((current) => {
      if (!current.config || !current.activeCaptureId) return current

      const updateCapture = (capture: LensCapture): LensCapture =>
        capture.id === current.activeCaptureId
          ? { ...capture, settings: { ...capture.settings, ...next } }
          : capture

      return {
        ...current,
        config: updateCapture(current.config),
        profiles: current.profiles.map((profile) => ({
          ...profile,
          captures: profile.captures.map(updateCapture)
        }))
      }
    })
  }

  const startSelection = async (): Promise<void> => {
    setBusy(true)
    await window.maple.startSelection()
    window.setTimeout(() => setBusy(false), 600)
  }

  const toggleLens = async (): Promise<void> => {
    applyLensState(await window.maple.toggleLens())
  }

  const createLensProfile = async (): Promise<void> => {
    applyLensState(await window.maple.createLensProfile(`角色 ${lensState.profiles.length + 1}`))
  }

  const beginProfileEdit = (): void => {
    const activeProfile = lensState.profiles.find((profile) => profile.id === lensState.activeProfileId)
    if (!activeProfile) return

    setEditingProfileId(activeProfile.id)
    setProfileNameDraft(activeProfile.name)
  }

  const saveProfileEdit = async (): Promise<void> => {
    if (!editingProfileId) return
    const name = profileNameDraft.trim()
    if (!name) return

    applyLensState(await window.maple.renameLensProfile(editingProfileId, name))
    setEditingProfileId(null)
    setProfileNameDraft('')
  }

  const cancelProfileEdit = (): void => {
    setEditingProfileId(null)
    setProfileNameDraft('')
  }

  const deleteLensProfile = async (): Promise<void> => {
    if (lensState.profiles.length <= 1) return
    const activeProfile = lensState.profiles.find((profile) => profile.id === lensState.activeProfileId)
    if (!activeProfile || !window.confirm(`删除角色「${activeProfile.name}」及其全部截图？`)) return

    applyLensState(await window.maple.deleteLensProfile(activeProfile.id))
  }

  const selectLensProfile = async (profileId: string): Promise<void> => {
    applyLensState(await window.maple.selectLensProfile(profileId))
  }

  const selectLensCapture = async (captureId: string): Promise<void> => {
    applyLensState(await window.maple.selectLensCapture(captureId))
  }

  const beginCaptureEdit = (capture: LensCapture): void => {
    setEditingCaptureId(capture.id)
    setCaptureNameDraft(capture.name)
  }

  const saveCaptureEdit = async (): Promise<void> => {
    if (!editingCaptureId) return
    const name = captureNameDraft.trim()
    if (!name) return

    applyLensState(await window.maple.renameLensCapture(editingCaptureId, name))
    setEditingCaptureId(null)
    setCaptureNameDraft('')
  }

  const cancelCaptureEdit = (): void => {
    setEditingCaptureId(null)
    setCaptureNameDraft('')
  }

  const deleteLensCapture = async (capture: LensCapture): Promise<void> => {
    if (!window.confirm(`删除截图「${capture.name}」？`)) return

    applyLensState(await window.maple.deleteLensCapture(capture.id))
  }

  const config = lensState.config
  const activeProfile = lensState.profiles.find((profile) => profile.id === lensState.activeProfileId) ?? lensState.profiles[0]
  const activeCaptures = activeProfile?.captures ?? []
  const openCaptureIds = new Set(lensState.openCaptureIds)

  const updateTimerSetting = (next: Partial<TimerSettings>): void => {
    setTimerState((current) => ({
      ...current,
      isRunning: next.intervalSeconds !== undefined ? false : current.isRunning,
      remainingSeconds: next.intervalSeconds ?? current.remainingSeconds,
      settings: { ...current.settings, ...next }
    }))
    window.maple.updateTimerSettings(next)
  }

  const chooseAudio = async (): Promise<void> => {
    const nextState = await window.maple.chooseTimerAudio()
    setTimerState(normalizeTimerState(nextState))
  }

  const resetAudio = async (): Promise<void> => {
    const nextState = await window.maple.resetTimerAudio()
    setTimerState(normalizeTimerState(nextState))
  }

  const startTimer = async (): Promise<void> => {
    unlockTimerSound()
    const nextState = await window.maple.startTimer()
    setTimerState(normalizeTimerState(nextState))
  }

  const stopTimer = async (): Promise<void> => {
    const nextState = await window.maple.stopTimer()
    setTimerState(normalizeTimerState(nextState))
  }

  const updateHotkey = async (action: HotkeyAction, shortcut: string): Promise<void> => {
    const nextState = await window.maple.updateHotkey(action, shortcut)
    setHotkeyState(normalizeHotkeyState(nextState))
  }

  const resetHotkey = async (action: HotkeyAction): Promise<void> => {
    const nextState = await window.maple.resetHotkey(action)
    setHotkeyState(normalizeHotkeyState(nextState))
  }

  const updateLensProfileHotkeyPrefix = async (prefix: string): Promise<void> => {
    const nextState = await window.maple.updateLensProfileHotkeyPrefix(prefix)
    setHotkeyState(normalizeHotkeyState(nextState))
    applyLensState(await window.maple.getLensState())
  }

  const checkForUpdates = async (): Promise<void> => {
    setCheckingUpdate(true)
    try {
      setUpdateResult(await window.maple.checkForUpdates())
    } finally {
      setCheckingUpdate(false)
    }
  }

  return (
    <main className="app-shell">
      <aside className="tool-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Aperture size={22} weight="bold" />
          </div>
          <div>
            <div className="brand-name">MapleTool</div>
            <div className="brand-subtitle">GMS 国际服辅助工具</div>
          </div>
        </div>

        <nav className="tool-nav" aria-label="工具栏">
          <button
            className={`tool-nav-item ${activeTool === 'lens' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTool('lens')}
          >
            <Crosshair size={18} weight="bold" />
            <span>冷却放大镜</span>
          </button>
          <button
            className={`tool-nav-item ${activeTool === 'timer' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTool('timer')}
          >
            <ClockCountdown size={18} weight="bold" />
            <span>刷图倒计时</span>
          </button>
          <button
            className={`tool-nav-item ${activeTool === 'hotkeys' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTool('hotkeys')}
          >
            <Keyboard size={18} weight="bold" />
            <span>热键</span>
          </button>
          <button
            className={`tool-nav-item ${activeTool === 'about' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTool('about')}
          >
            <Info size={18} weight="bold" />
            <span>关于</span>
          </button>
        </nav>

      </aside>

      <section className="workspace">
        {activeTool === 'lens' ? (
          <>
            <section className="tool-header">
              <div>
                <p className="section-kicker">冷却放大镜</p>
                <h1>把技能冷却固定在顺眼的位置</h1>
                <p className="header-copy">选择游戏画面里的一块区域，MapleTool 会生成一个无边框、始终置顶的高清放大浮窗。</p>
              </div>

              <div className="header-actions">
                {activeCaptures.length > 0 && (
                  <button className="secondary-button" type="button" onClick={toggleLens}>
                    <Eye size={17} />
                    <span>{lensState.isOpen ? '隐藏全部' : '展示全部'}</span>
                  </button>
                )}
                <button className="primary-button" type="button" onClick={startSelection} disabled={busy}>
                  <Selection size={18} weight="bold" />
                  <span>{busy ? '选择中' : '添加截图区域'}</span>
                </button>
              </div>
            </section>

            <section className="lens-grid">
              <section className="settings-panel lens-config-panel" aria-label="角色和截图配置">
                <div className="panel-heading">
                  <UserCircle size={18} weight="bold" />
                  <h2>角色配置</h2>
                </div>

                <div className="profile-toolbar">
                  {editingProfileId === lensState.activeProfileId ? (
                    <input
                      className="inline-edit-input"
                      value={profileNameDraft}
                      autoFocus
                      onChange={(event) => setProfileNameDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveProfileEdit()
                        if (event.key === 'Escape') cancelProfileEdit()
                      }}
                    />
                  ) : (
                    <select value={lensState.activeProfileId} onChange={(event) => void selectLensProfile(event.currentTarget.value)}>
                      {lensState.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}（{profile.captures.length}）
                          {profile.shortcut ? ` · ${formatShortcut(profile.shortcut)}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="icon-button" type="button" onClick={createLensProfile} aria-label="新增角色">
                    <Plus size={17} weight="bold" />
                  </button>
                  {editingProfileId === lensState.activeProfileId ? (
                    <>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => void saveProfileEdit()}
                        disabled={!profileNameDraft.trim()}
                        aria-label="保存角色名称"
                      >
                        <Check size={17} weight="bold" />
                      </button>
                      <button className="icon-button" type="button" onClick={cancelProfileEdit} aria-label="取消编辑角色">
                        <X size={17} weight="bold" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="icon-button" type="button" onClick={beginProfileEdit} aria-label="重命名角色">
                        <PencilSimple size={17} weight="bold" />
                      </button>
                      <button
                        className="icon-button danger"
                        type="button"
                        onClick={deleteLensProfile}
                        disabled={lensState.profiles.length <= 1}
                        aria-label="删除角色"
                      >
                        <Trash size={17} weight="bold" />
                      </button>
                    </>
                  )}
                </div>

                <div className={`profile-hotkey-hint ${activeProfile?.shortcutRegistered ? '' : 'is-muted'}`}>
                  快捷切换：
                  <strong>{activeProfile?.shortcut ? formatShortcut(activeProfile.shortcut) : '前 9 个角色自动分配'}</strong>
                  {activeProfile?.shortcut && !activeProfile.shortcutRegistered ? <span>未注册，可能已被占用</span> : null}
                </div>

                <div className="capture-list">
                  {activeCaptures.length === 0 ? (
                    <div className="empty-capture">
                      <Selection size={20} weight="bold" />
                      <span>当前角色还没有截图区域</span>
                    </div>
                  ) : (
                    activeCaptures.map((capture) => {
                      const selected = capture.id === lensState.activeCaptureId
                      const open = openCaptureIds.has(capture.id)

                      return (
                        <div className={`capture-row ${selected ? 'is-selected' : ''}`} key={capture.id}>
                          {editingCaptureId === capture.id ? (
                            <>
                              <input
                                className="capture-edit-input"
                                value={captureNameDraft}
                                autoFocus
                                onChange={(event) => setCaptureNameDraft(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') void saveCaptureEdit()
                                  if (event.key === 'Escape') cancelCaptureEdit()
                                }}
                              />
                              <button
                                className="icon-button"
                                type="button"
                                onClick={() => void saveCaptureEdit()}
                                disabled={!captureNameDraft.trim()}
                                aria-label="保存截图名称"
                              >
                                <Check size={16} weight="bold" />
                              </button>
                              <button className="icon-button" type="button" onClick={cancelCaptureEdit} aria-label="取消编辑截图">
                                <X size={16} weight="bold" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="capture-main" type="button" onClick={() => void selectLensCapture(capture.id)}>
                                <FrameCorners size={18} weight="bold" />
                                <span>
                                  <strong>{capture.name}</strong>
                                  <small>
                                    {Math.round(capture.region.width)} x {Math.round(capture.region.height)}
                                    {open ? ' · 已展示' : ' · 已保存'}
                                  </small>
                                </span>
                              </button>
                              <button className="icon-button" type="button" onClick={() => beginCaptureEdit(capture)} aria-label="重命名截图">
                                <PencilSimple size={16} weight="bold" />
                              </button>
                              <button className="icon-button danger" type="button" onClick={() => void deleteLensCapture(capture)} aria-label="删除截图">
                                <Trash size={16} weight="bold" />
                              </button>
                            </>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </section>

              <section className="settings-panel" aria-label="显示设置">
                <div className="panel-heading">
                  <GearSix size={18} weight="bold" />
                  <h2>显示设置</h2>
                </div>

                <div className="quality-note">
                  <FrameCorners size={18} weight="bold" />
                  <div>
                    <strong>窗口尺寸</strong>
                    <span>直接拖拽放大镜边缘调整大小。</span>
                  </div>
                </div>

                <label className="slider-field">
                  <span>放大内容透明度</span>
                  <b>{Math.round(settings.opacity * 100)}%</b>
                  <input
                    disabled={!config}
                    type="range"
                    min="0.35"
                    max="1"
                    step="0.01"
                    value={settings.opacity}
                    style={rangeFill(settings.opacity, 0.35, 1)}
                    onChange={(event) => updateSetting({ opacity: Number(event.currentTarget.value) })}
                  />
                </label>

                <button
                  className={`lock-toggle ${settings.locked ? 'is-on' : ''}`}
                  type="button"
                  disabled={!config}
                  onClick={() => updateSetting({ locked: !settings.locked })}
                >
                  {settings.locked ? <LockKey size={19} weight="bold" /> : <LockKeyOpen size={19} weight="bold" />}
                  <span>
                    <strong>固定放大镜</strong>
                    <small>{settings.locked ? '位置和大小已锁定，鼠标会穿透浮窗' : '允许拖动和调整浮窗大小'}</small>
                  </span>
                </button>
              </section>
            </section>
          </>
        ) : activeTool === 'timer' ? (
          <TimerPanel
            timerState={timerState}
            updateTimerSetting={updateTimerSetting}
            chooseAudio={chooseAudio}
            resetAudio={resetAudio}
            startTimer={startTimer}
            stopTimer={stopTimer}
          />
        ) : activeTool === 'hotkeys' ? (
          <HotkeysPanel
            hotkeyState={hotkeyState}
            lensProfiles={lensState.profiles}
            updateHotkey={updateHotkey}
            resetHotkey={resetHotkey}
            updateLensProfileHotkeyPrefix={updateLensProfileHotkeyPrefix}
          />
        ) : (
          <AboutPanel
            appInfo={appInfo}
            updateResult={updateResult}
            checkingUpdate={checkingUpdate}
            checkForUpdates={checkForUpdates}
          />
        )}
      </section>
    </main>
  )
}

function AboutPanel({
  appInfo,
  updateResult,
  checkingUpdate,
  checkForUpdates
}: {
  appInfo: AppInfo
  updateResult: UpdateCheckResult | null
  checkingUpdate: boolean
  checkForUpdates: () => Promise<void>
}): React.ReactElement {
  const updateUrl = updateResult?.downloadUrl ?? updateResult?.releaseUrl ?? appInfo.releasePageUrl
  const latestVersionText = updateResult?.latestVersion ?? '未检查'
  const updateStatus = !updateResult
    ? '点击检查更新获取最新 Release'
    : updateResult.error
      ? updateResult.error
      : updateResult.hasUpdate
        ? `发现新版本 ${updateResult.latestVersion}`
        : '当前已是最新版本'

  return (
    <>
      <section className="tool-header">
        <div>
          <p className="section-kicker">关于</p>
          <h1>MapleTool</h1>
          <p className="header-copy">面向 GMS 国际服冒险岛玩家的小工具。版本信息和更新入口都在这里。</p>
        </div>

        <div className="header-actions">
          <button className="secondary-button" type="button" onClick={() => void checkForUpdates()} disabled={checkingUpdate}>
            <ArrowClockwise size={17} weight="bold" />
            <span>{checkingUpdate ? '检查中' : '检查更新'}</span>
          </button>
          <button className="primary-button" type="button" onClick={() => void window.maple.openReleasePage(updateUrl)}>
            <ArrowSquareOut size={17} weight="bold" />
            <span>打开下载页</span>
          </button>
        </div>
      </section>

      <section className="about-grid">
        <section className="about-panel" aria-label="版本信息">
          <div className="panel-heading">
            <Info size={18} weight="bold" />
            <h2>版本信息</h2>
          </div>

          <div className="version-card">
            <span>当前版本</span>
            <strong>v{appInfo.version}</strong>
            <small>
              {appInfo.platform} / {appInfo.arch}
            </small>
          </div>

          <div className="meta-grid">
            <div>
              <span>应用名称</span>
              <strong>{appInfo.name}</strong>
            </div>
            <div>
              <span>更新来源</span>
              <strong>GitHub Release</strong>
            </div>
          </div>
        </section>

        <section className="about-panel" aria-label="更新状态">
          <div className="panel-heading">
            <ArrowClockwise size={18} weight="bold" />
            <h2>更新状态</h2>
          </div>

          <div className={`update-status ${updateResult?.error ? 'is-error' : updateResult?.hasUpdate ? 'has-update' : ''}`}>
            <span>最新版本</span>
            <strong>{latestVersionText}</strong>
            <small>{updateStatus}</small>
          </div>

          {updateResult?.checkedAt && (
            <p className="about-note">上次检查：{new Date(updateResult.checkedAt).toLocaleString()}</p>
          )}

          <p className="about-note">如果自动检查失败，通常是 GitHub 仓库为私有或网络不可用，可以直接打开下载页查看 Release。</p>
        </section>
      </section>
    </>
  )
}

function TimerPanel({
  timerState,
  updateTimerSetting,
  chooseAudio,
  resetAudio,
  startTimer,
  stopTimer
}: {
  timerState: TimerState
  updateTimerSetting: (settings: Partial<TimerSettings>) => void
  chooseAudio: () => Promise<void>
  resetAudio: () => Promise<void>
  startTimer: () => Promise<void>
  stopTimer: () => Promise<void>
}): React.ReactElement {
  const settings = timerState.settings
  const [intervalDraft, setIntervalDraft] = useState(String(settings.intervalSeconds))

  useEffect(() => {
    setIntervalDraft(String(settings.intervalSeconds))
  }, [settings.intervalSeconds])

  const commitIntervalDraft = (): void => {
    const parsedValue = Number(intervalDraft)
    const nextInterval = Number.isFinite(parsedValue)
      ? Math.round(Math.min(Math.max(parsedValue, 1), 3600))
      : settings.intervalSeconds

    setIntervalDraft(String(nextInterval))
    if (nextInterval !== settings.intervalSeconds) {
      updateTimerSetting({ intervalSeconds: nextInterval })
    }
  }

  return (
    <>
      <section className="tool-header">
        <div>
          <p className="section-kicker">刷图倒计时</p>
          <h1>每隔固定秒数提醒一次操作</h1>
          <p className="header-copy">适合刷图节奏提醒，到点播放提示音，提醒移动、放置或刷新技能。</p>
        </div>

        <div className="header-actions">
          {timerState.isRunning ? (
            <button className="secondary-button" type="button" onClick={stopTimer}>
              <Stop size={17} weight="bold" />
              <span>停止计时</span>
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={startTimer}>
              <Play size={17} weight="fill" />
              <span>开始计时</span>
            </button>
          )}
          {timerState.isOpen ? (
            <button className="secondary-button" type="button" onClick={() => window.maple.closeTimer()}>
              <Eye size={17} />
              <span>隐藏浮层</span>
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={() => window.maple.openTimer()}>
              <ClockCountdown size={18} weight="bold" />
              <span>展示浮层</span>
            </button>
          )}
        </div>
      </section>

      <section className="timer-grid">
        <section className="timer-settings-panel" aria-label="倒计时设置">
          <div className="panel-heading">
            <GearSix size={18} weight="bold" />
            <h2>倒计时设置</h2>
          </div>

          <label className="number-field">
            <span>倒计时间隔</span>
            <div>
              <input
                type="text"
                inputMode="numeric"
                value={intervalDraft}
                onBlur={commitIntervalDraft}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value
                  if (/^\d*$/.test(nextValue)) {
                    setIntervalDraft(nextValue)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                }}
              />
              <b>秒</b>
            </div>
          </label>

          <div className="audio-field">
            <div>
              <span>提示音频</span>
              <strong>{settings.audioName ?? '默认提示音'}</strong>
            </div>
            <div className="audio-actions">
              {settings.audioName && (
                <button className="secondary-button compact-button" type="button" onClick={resetAudio}>
                  <X size={15} weight="bold" />
                  <span>使用默认</span>
                </button>
              )}
              <button className="secondary-button compact-button" type="button" onClick={chooseAudio}>
                <MusicNote size={17} />
                <span>选择音频</span>
              </button>
            </div>
          </div>

          <label className="select-field">
            <span>倒计时字体</span>
            <select
              value={settings.fontFamily}
              onChange={(event) => updateTimerSetting({ fontFamily: event.currentTarget.value })}
            >
              {TIMER_FONT_OPTIONS.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>

          <button
            className={`lock-toggle ${settings.locked ? 'is-on' : ''}`}
            type="button"
            onClick={() => updateTimerSetting({ locked: !settings.locked })}
          >
            {settings.locked ? <LockKey size={19} weight="bold" /> : <LockKeyOpen size={19} weight="bold" />}
            <span>
              <strong>固定倒计时浮层</strong>
              <small>{settings.locked ? '位置和大小已锁定，鼠标会穿透浮层' : '允许拖动和调整浮层大小'}</small>
            </span>
          </button>
        </section>

        <section className="timer-preview-panel" aria-label="倒计时预览">
          <div className="panel-heading">
            <ClockCountdown size={18} weight="bold" />
            <h2>浮层预览</h2>
          </div>

          <div className="timer-preview-card">
            <span>下一次提醒</span>
            <strong style={{ fontFamily: settings.fontFamily }}>{formatSeconds(timerState.remainingSeconds)}</strong>
            <small>
              {!timerState.isRunning
                ? timerState.isOpen
                  ? '浮层已展示，点击开始后计时'
                  : '点击开始后计时，可单独展示浮层'
                : timerState.isOpen
                ? settings.locked
                  ? '浮层已展示并固定'
                  : '浮层正在屏幕上运行'
                : '计时运行中，可按需展示浮层'}
            </small>
          </div>
        </section>
      </section>
    </>
  )
}

function HotkeysPanel({
  hotkeyState,
  lensProfiles,
  updateHotkey,
  resetHotkey,
  updateLensProfileHotkeyPrefix
}: {
  hotkeyState: HotkeyState
  lensProfiles: LensProfile[]
  updateHotkey: (action: HotkeyAction, shortcut: string) => Promise<void>
  resetHotkey: (action: HotkeyAction) => Promise<void>
  updateLensProfileHotkeyPrefix: (prefix: string) => Promise<void>
}): React.ReactElement {
  const [capturingAction, setCapturingAction] = useState<HotkeyAction | null>(null)
  const [capturingProfilePrefix, setCapturingProfilePrefix] = useState(false)
  const [shortcutPreview, setShortcutPreview] = useState('')
  const [captureError, setCaptureError] = useState<string | null>(null)

  useEffect(() => {
    if (!capturingAction && !capturingProfilePrefix) return

    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setCapturingAction(null)
        setCapturingProfilePrefix(false)
        setShortcutPreview('')
        setCaptureError(null)
        return
      }

      setShortcutPreview(eventToShortcutPreview(event) ?? '')
      const shortcut = eventToShortcut(event)

      if (!shortcut) {
        setCaptureError(`请按下包含 ${getPrimaryModifierLabel()}、Alt 或 Shift 的组合键。`)
        return
      }

      if (capturingProfilePrefix) {
        const prefix = shortcutToProfilePrefix(shortcut)

        if (!prefix) {
          setCaptureError('录制角色前缀时请按下“前缀 + 1”，例如 Ctrl + Shift + 1。')
          return
        }

        setCaptureError(null)
        setCapturingProfilePrefix(false)
        setShortcutPreview('')
        void updateLensProfileHotkeyPrefix(prefix)
        return
      }

      if (!capturingAction) return

      setCaptureError(null)
      setCapturingAction(null)
      setShortcutPreview('')
      void updateHotkey(capturingAction, shortcut)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturingAction, capturingProfilePrefix, updateHotkey, updateLensProfileHotkeyPrefix])

  const rows: Array<{
    action: HotkeyAction
    title: string
    description: string
  }> = [
    {
      action: 'lensToggle',
      title: '打开 / 关闭放大镜浮层',
      description: '全局生效，关闭后再次按下会恢复当前角色的全部截图浮层。'
    },
    {
      action: 'timerToggle',
      title: '打开 / 关闭倒计时浮层',
      description: '全局生效，重新打开时会使用上次放置的位置。'
    }
  ]

  return (
    <>
      <section className="tool-header">
        <div>
          <p className="section-kicker">热键</p>
          <h1>集中管理所有快捷操作</h1>
          <p className="header-copy">点击录制后按下新的组合键，MapleTool 会立刻尝试注册并保存。</p>
        </div>
      </section>

      <section className="hotkeys-panel" aria-label="热键列表">
        <div className="panel-heading">
          <Keyboard size={18} weight="bold" />
          <h2>快捷键列表</h2>
        </div>

        <div className="hotkey-list">
          {rows.map((row) => {
            const isCapturing = capturingAction === row.action
            const registered = hotkeyState.registered[row.action]

            return (
              <div className="hotkey-row" key={row.action}>
                <div className="hotkey-copy">
                  <strong>{row.title}</strong>
                  <span>{row.description}</span>
                </div>
                <span className={`hotkey-scope ${registered ? '' : 'is-error'}`}>{registered ? '已生效' : '未注册'}</span>
                <button
                  className={`hotkey-recorder ${isCapturing ? 'is-recording' : ''}`}
                  type="button"
                  onClick={() => {
                    setCapturingProfilePrefix(false)
                    setCapturingAction(row.action)
                    setShortcutPreview('')
                    setCaptureError(null)
                  }}
                >
                  {isCapturing
                    ? shortcutPreview
                      ? formatShortcut(shortcutPreview)
                      : '按下组合键'
                    : formatShortcut(hotkeyState.settings[row.action])}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => resetHotkey(row.action)}>
                  <span>恢复默认</span>
                </button>
              </div>
            )
          })}
        </div>

        <div className="readonly-hotkey-list">
          <div className="readonly-hotkey-heading">
            <div>
              <h3>角色切换</h3>
              <span>前 9 个角色会自动使用此前缀加数字。</span>
            </div>
            <button
              className={`hotkey-recorder ${capturingProfilePrefix ? 'is-recording' : ''}`}
              type="button"
              onClick={() => {
                setCapturingAction(null)
                setCapturingProfilePrefix(true)
                setShortcutPreview('')
                setCaptureError(null)
              }}
            >
              {capturingProfilePrefix
                ? shortcutPreview
                  ? formatShortcut(shortcutPreview)
                  : '按前缀 + 1'
                : formatShortcut(hotkeyState.lensProfilePrefix)}
            </button>
          </div>
          {lensProfiles.map((profile) => (
            <div className="readonly-hotkey-row" key={profile.id}>
              <div className="hotkey-copy">
                <strong>{profile.name}</strong>
                <span>{profile.captures.length} 个截图区域</span>
              </div>
              <span className={`hotkey-scope ${profile.shortcutRegistered ? '' : 'is-error'}`}>
                {profile.shortcutRegistered ? '已生效' : '未注册'}
              </span>
              <code>{profile.shortcut ? formatShortcut(profile.shortcut) : '无'}</code>
            </div>
          ))}
        </div>

        {(captureError || hotkeyState.error) && <p className="hotkey-error">{captureError ?? hotkeyState.error}</p>}
      </section>
    </>
  )
}

function getTimerAudioContext(): AudioContext | null {
  const AudioContextClass =
    window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextClass) return null

  if (!timerAudioContext || timerAudioContext.state === 'closed') {
    timerAudioContext = new AudioContextClass()
  }

  return timerAudioContext
}

function unlockTimerSound(): void {
  void getTimerAudioContext()?.resume().catch(() => undefined)
}

function playDefaultTimerTone(): void {
  const audioContext = getTimerAudioContext()

  if (!audioContext) return

  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  const now = audioContext.currentTime

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(880, now)
  oscillator.frequency.setValueAtTime(1046.5, now + 0.16)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36)

  oscillator.connect(gain)
  gain.connect(audioContext.destination)
  oscillator.start(now)
  oscillator.stop(now + 0.38)
  void audioContext.resume().catch(() => undefined)
}

async function playTimerAlertSound(audioPath: string | null): Promise<void> {
  if (!audioPath) {
    playDefaultTimerTone()
    return
  }

  const audioDataUrl = await window.maple.getTimerAudioDataUrl()

  if (!audioDataUrl) {
    playDefaultTimerTone()
    return
  }

  const audio = new Audio(audioDataUrl)
  audio.currentTime = 0
  void audio.play().catch(() => playDefaultTimerTone())
}

function SelectorOverlay(): React.ReactElement {
  const display = useMemo(getDisplayFromQuery, [])
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        window.maple.cancelSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rect = useMemo(() => {
    if (!start || !current) return null
    const x = Math.min(start.x, current.x)
    const y = Math.min(start.y, current.y)
    const width = Math.abs(start.x - current.x)
    const height = Math.abs(start.y - current.y)
    return { x, y, width, height }
  }, [current, start])

  const completeSelection = (): void => {
    if (!rect || rect.width < 20 || rect.height < 20) {
      setStart(null)
      setCurrent(null)
      return
    }

    const payload: SelectionPayload = {
      display,
      region: rect
    }

    window.maple.completeSelection(payload)
  }

  return (
    <main
      className="selector-overlay"
      onMouseDown={(event) => {
        setStart({ x: event.clientX, y: event.clientY })
        setCurrent({ x: event.clientX, y: event.clientY })
      }}
      onMouseMove={(event) => {
        if (start) setCurrent({ x: event.clientX, y: event.clientY })
      }}
      onMouseUp={completeSelection}
    >
      <div className="selector-hint">
        <Selection size={18} weight="bold" />
        <span>拖拽选择技能冷却区域</span>
      </div>
      {rect && (
        <div
          className="selection-box"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height
          }}
        >
          <span>
            {Math.round(rect.width)} x {Math.round(rect.height)}
          </span>
        </div>
      )}
    </main>
  )
}

function LensWindow(): React.ReactElement {
  const captureId = useMemo(getCaptureIdFromQuery, [])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const drawTimerRef = useRef<number | null>(null)
  const [config, setConfig] = useState<LensCapture | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.maple.getLensConfig(captureId ?? undefined).then((nextConfig) => {
      setConfig(nextConfig)
      if (!nextConfig) {
        setError('未选择区域。')
      }
    })

    return window.maple.onLensUpdated((state) => {
      const nextConfig =
        (captureId
          ? state.profiles.flatMap((profile) => profile.captures).find((capture) => capture.id === captureId)
          : state.config) ?? null
      setConfig(nextConfig)
      if (!nextConfig) {
        setError('截图区域已删除。')
      }
    })
  }, [captureId])

  useEffect(() => {
    if (!config) return

    let stream: MediaStream | null = null
    let cancelled = false

    const startCapture = async (): Promise<void> => {
      try {
        const source = await window.maple.getScreenSource(config.display.id)
        const constraints = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: source.id,
              maxFrameRate: LENS_RENDER_FPS
            }
          }
        } as unknown as MediaStreamConstraints

        stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) return

        const video = document.createElement('video')
        video.muted = true
        video.srcObject = stream
        await video.play()
        videoRef.current = video
      } catch (captureError) {
        const message = captureError instanceof Error ? captureError.message : '未知错误'
        setError(`屏幕捕获失败：${message}`)
      }
    }

    startCapture()

    return () => {
      cancelled = true
      if (drawTimerRef.current) window.clearTimeout(drawTimerRef.current)
      stream?.getTracks().forEach((track) => track.stop())
      videoRef.current = null
    }
  }, [config?.display.id])

  useEffect(() => {
    if (!config) return

    const draw = (): void => {
      const canvas = canvasRef.current
      const video = videoRef.current

      if (canvas && video && video.videoWidth > 0 && video.videoHeight > 0) {
        const ratio = window.devicePixelRatio || 1
        const width = Math.max(1, Math.floor(canvas.clientWidth * ratio))
        const height = Math.max(1, Math.floor(canvas.clientHeight * ratio))

        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }

        const context = canvas.getContext('2d')

        if (context) {
          const scaleX = video.videoWidth / config.display.bounds.width
          const scaleY = video.videoHeight / config.display.bounds.height
          const sourceX = Math.round(config.region.x * scaleX)
          const sourceY = Math.round(config.region.y * scaleY)
          const sourceWidth = Math.round(config.region.width * scaleX)
          const sourceHeight = Math.round(config.region.height * scaleY)
          const isScaled = canvas.width !== sourceWidth || canvas.height !== sourceHeight

          context.clearRect(0, 0, canvas.width, canvas.height)
          context.imageSmoothingEnabled = isScaled
          if (isScaled) {
            context.imageSmoothingQuality = 'high'
          }
          context.globalAlpha = config.settings.opacity
          context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
          context.globalAlpha = 1
        }
      }

      drawTimerRef.current = window.setTimeout(draw, LENS_RENDER_INTERVAL_MS)
    }

    draw()
    return () => {
      if (drawTimerRef.current) window.clearTimeout(drawTimerRef.current)
    }
  }, [config])

  if (!config) {
    return (
      <main className="lens-shell">
        <div className="lens-empty">未选择区域。</div>
      </main>
    )
  }

  return (
    <main className="lens-shell">
      <div className={`lens-window ${config.settings.locked ? 'is-locked' : ''}`}>
        <canvas ref={canvasRef} className="lens-canvas" />
        {error && <div className="lens-error">{error}</div>}
      </div>
    </main>
  )
}

function TimerWindow(): React.ReactElement {
  const [settings, setSettings] = useState<TimerSettings>(defaultTimerSettings)
  const [remaining, setRemaining] = useState(defaultTimerSettings.intervalSeconds)
  const [isRunning, setIsRunning] = useState(false)
  const [alerting, setAlerting] = useState(false)
  const alertTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    window.maple.getTimerState().then((state) => {
      const nextState = normalizeTimerState(state)
      setSettings(nextState.settings)
      setRemaining(nextState.remainingSeconds)
      setIsRunning(nextState.isRunning)
    })

    return window.maple.onTimerUpdated((state) => {
      const nextState = normalizeTimerState(state)
      setSettings(nextState.settings)
      setRemaining(nextState.remainingSeconds)
      setIsRunning(nextState.isRunning)
    })
  }, [])

  useEffect(() => {
    const showAlert = (): void => {
      setAlerting(true)
      if (alertTimeoutRef.current) window.clearTimeout(alertTimeoutRef.current)
      alertTimeoutRef.current = window.setTimeout(() => setAlerting(false), 1200)
    }

    const unsubscribe = window.maple.onTimerVisualAlert(showAlert)

    return () => {
      unsubscribe()
      if (alertTimeoutRef.current) window.clearTimeout(alertTimeoutRef.current)
    }
  }, [])

  return (
    <main
      className={`timer-overlay-shell ${alerting ? 'is-alerting' : ''} ${settings.locked ? 'is-locked' : ''}`}
      style={{ fontFamily: settings.fontFamily }}
    >
      {!settings.locked && (
        <button className="timer-close-button" type="button" onClick={() => window.maple.closeTimer()} aria-label="关闭倒计时">
          <X size={14} weight="bold" />
        </button>
      )}
      <div className="timer-overlay-card">
        <span>{isRunning ? '下一次提醒' : '等待开始'}</span>
        <strong>{formatSeconds(remaining)}</strong>
        <small>{alerting ? '该移动 / 放置了' : isRunning ? `${settings.intervalSeconds} 秒循环` : '在工具页点击开始'}</small>
      </div>
    </main>
  )
}

function App(): React.ReactElement {
  const view = currentView
  if (view === 'selector') return <SelectorOverlay />
  if (view === 'lens') return <LensWindow />
  if (view === 'timer') return <TimerWindow />
  return <MainPanel />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
