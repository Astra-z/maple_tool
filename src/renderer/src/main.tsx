import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Aperture,
  BellRinging,
  ClockCountdown,
  Crosshair,
  Eye,
  FrameCorners,
  GearSix,
  Keyboard,
  LockKey,
  LockKeyOpen,
  MapTrifold,
  MusicNote,
  Play,
  Selection,
  SlidersHorizontal,
  Stop,
  X
} from '@phosphor-icons/react'
import { CLOSE_LENS_SHORTCUT_LABEL, CLOSE_TIMER_SHORTCUT_LABEL, TIMER_FONT_OPTIONS } from '../../shared/types'
import type { DisplayInfo, LensConfig, LensSettings, SelectionPayload, TimerSettings, TimerState } from '../../shared/types'
import './styles.css'

type MainTool = 'lens' | 'timer' | 'hotkeys'

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

function getInitialMainTool(): MainTool {
  try {
    const savedTool = window.localStorage.getItem('maple.activeTool')
    if (savedTool === 'lens' || savedTool === 'timer' || savedTool === 'hotkeys') {
      return savedTool
    }
  } catch {
    return 'lens'
  }

  return 'lens'
}

function MainPanel(): React.ReactElement {
  const [config, setConfig] = useState<LensConfig | null>(null)
  const [settings, setSettings] = useState<LensSettings>(defaultRendererSettings)
  const [timerState, setTimerState] = useState<TimerState>(defaultTimerState)
  const [activeTool, setActiveTool] = useState<MainTool>(getInitialMainTool)
  const [busy, setBusy] = useState(false)
  const timerSettingsRef = useRef(defaultTimerSettings)

  useEffect(() => {
    window.maple.getLensConfig().then((nextConfig) => {
      setConfig(nextConfig)
      if (nextConfig) setSettings(nextConfig.settings)
    })

    return window.maple.onSelectionUpdated((nextConfig) => {
      setConfig(nextConfig)
      if (nextConfig) setSettings(nextConfig.settings)
    })
  }, [])

  useEffect(() => {
    window.maple.getTimerState().then((state) => setTimerState(normalizeTimerState(state)))
    return window.maple.onTimerUpdated((state) => setTimerState(normalizeTimerState(state)))
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
    window.maple.updateLensSettings(next)
    setConfig((current) => {
      if (!current) return current
      return { ...current, settings: { ...current.settings, ...next } }
    })
  }

  const startSelection = async (): Promise<void> => {
    setBusy(true)
    await window.maple.startSelection()
    window.setTimeout(() => setBusy(false), 600)
  }

  const closeLens = (): void => {
    window.maple.closeLens()
    setConfig(null)
  }

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
          <button className="tool-nav-item" type="button" disabled>
            <MapTrifold size={18} />
            <span>地图标记</span>
          </button>
          <button className="tool-nav-item" type="button" disabled>
            <BellRinging size={18} />
            <span>事件提醒</span>
          </button>
          <button className="tool-nav-item" type="button" disabled>
            <SlidersHorizontal size={18} />
            <span>全局设置</span>
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
                {config && (
                  <button className="secondary-button" type="button" onClick={closeLens}>
                    <Eye size={17} />
                    <span>关闭放大镜</span>
                  </button>
                )}
                <button className="primary-button" type="button" onClick={startSelection} disabled={busy}>
                  <Selection size={18} weight="bold" />
                  <span>{busy ? '选择中' : '选择区域'}</span>
                </button>
              </div>
            </section>

            <section className="lens-grid">
              <section className="settings-panel" aria-label="显示设置">
                <div className="panel-heading">
                  <GearSix size={18} weight="bold" />
                  <h2>显示设置</h2>
                </div>

                <div className="quality-note">
                  <FrameCorners size={18} weight="bold" />
                  <div>
                    <strong>高清缩放</strong>
                    <span>使用高质量平滑缩放，优先保证低延迟和清晰度。</span>
                  </div>
                </div>

                <label className="slider-field">
                  <span>放大倍率</span>
                  <b>{settings.zoom.toFixed(1)}x</b>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="0.1"
                    value={settings.zoom}
                    style={rangeFill(settings.zoom, 1, 5)}
                    onChange={(event) => updateSetting({ zoom: Number(event.currentTarget.value) })}
                  />
                </label>

                <label className="slider-field">
                  <span>放大内容透明度</span>
                  <b>{Math.round(settings.opacity * 100)}%</b>
                  <input
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
        ) : (
          <HotkeysPanel />
        )}
      </section>
    </main>
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

function HotkeysPanel(): React.ReactElement {
  return (
    <>
      <section className="tool-header">
        <div>
          <p className="section-kicker">热键</p>
          <h1>集中管理所有快捷操作</h1>
          <p className="header-copy">这里展示 MapleTool 当前可用的快捷键，后续新增功能的热键也会放在这里。</p>
        </div>
      </section>

      <section className="hotkeys-panel" aria-label="热键列表">
        <div className="panel-heading">
          <Keyboard size={18} weight="bold" />
          <h2>快捷键列表</h2>
        </div>

        <div className="hotkey-list">
          <div className="hotkey-row">
            <div className="hotkey-copy">
              <strong>关闭放大镜浮层</strong>
              <span>全局生效，游戏窗口获得焦点时也可以直接关闭。</span>
            </div>
            <span className="hotkey-scope">全局</span>
            <kbd>{CLOSE_LENS_SHORTCUT_LABEL}</kbd>
          </div>

          <div className="hotkey-row">
            <div className="hotkey-copy">
              <strong>关闭倒计时浮层</strong>
              <span>全局生效，固定浮层后也可以直接关闭。</span>
            </div>
            <span className="hotkey-scope">全局</span>
            <kbd>{CLOSE_TIMER_SHORTCUT_LABEL}</kbd>
          </div>
        </div>
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const animationRef = useRef<number | null>(null)
  const [config, setConfig] = useState<LensConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.maple.getLensConfig().then((nextConfig) => {
      setConfig(nextConfig)
      if (!nextConfig) {
        setError('未选择区域。')
      }
    })
    return window.maple.onLensSettings((settings) => {
      setConfig((current) => (current ? { ...current, settings } : current))
    })
  }, [])

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
              maxFrameRate: 30
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
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
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

          context.clearRect(0, 0, canvas.width, canvas.height)
          context.imageSmoothingEnabled = true
          context.imageSmoothingQuality = 'high'
          context.globalAlpha = config.settings.opacity
          context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
          context.globalAlpha = 1
        }
      }

      animationRef.current = requestAnimationFrame(draw)
    }

    animationRef.current = requestAnimationFrame(draw)
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
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
