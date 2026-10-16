/**
 * 全局计时器（FR-3.23 / FR-3.24）
 *
 * 为什么放全局 store 而不是页面 state：做菜时会来回切页面——从制作模式跳去看
 * 备菜清单，或者切到另一道菜。计时器必须活着。放在页面里，一跳转就归零，
 * 那这个功能还不如手机自带的秒表。
 *
 * 时间的推进不用 `setInterval` 累加（后台标签页会被节流，越跑越不准），
 * 而是每 1s 让 UI 重渲染一次、用 `Date.now()` 与目标时刻比对。这样即使标签页
 * 被冻结几分钟，回来时剩余时间依然是准的。
 */

import { create } from 'zustand'

export interface CookTimer {
  id: string
  /** 计时器名字，如「排骨」「米饭」 */
  label: string
  /** 目标时刻（毫秒时间戳）。用终点而不是剩余秒数，避免后台节流导致漂移 */
  endsAt: number
  /** 总时长（秒），用于画进度条 */
  totalSec: number
  /** 来源菜谱，便于在界面上区分「这是哪道菜的计时」 */
  recipeName: string | null
  /** 已响过铃的标记，防止同一个计时器反复报警 */
  fired: boolean
}

interface TimerState {
  timers: CookTimer[]
  /** 每 tick 变化一次，让订阅者重渲染 */
  now: number
  start: (input: { label: string; seconds: number; recipeName?: string | null }) => string
  cancel: (id: string) => void
  clearFired: () => void
  tick: () => void
  /** 刚响铃的计时器（供 Toast / 提示层消费） */
  ringing: CookTimer | null
  dismissRinging: () => void
}

let seq = 0

export const useTimerStore = create<TimerState>((set, get) => ({
  timers: [],
  now: Date.now(),
  ringing: null,

  start: ({ label, seconds, recipeName = null }) => {
    // 启动计时一定发生在用户的点击里，这是解锁音频上下文最可靠的时机。
    // 放到这里而不是各个调用点，是因为将来多一个"启动计时"的入口时不会再想起来加。
    unlockAudio()
    seq += 1
    const id = `tmr_${Date.now()}_${seq}`
    const timer: CookTimer = {
      id,
      label: label.trim() || '计时',
      endsAt: Date.now() + seconds * 1000,
      totalSec: seconds,
      recipeName,
      fired: false,
    }
    set((s) => ({ timers: [...s.timers, timer].sort((a, b) => a.endsAt - b.endsAt) }))
    notify(timer)
    return id
  },

  cancel: (id) => set((s) => ({ timers: s.timers.filter((t) => t.id !== id) })),

  clearFired: () => set((s) => ({ timers: s.timers.filter((t) => !t.fired) })),

  tick: () => {
    const now = Date.now()
    const due = get().timers.filter((t) => !t.fired && t.endsAt <= now)
    if (due.length > 0) {
      // 一次 tick 可能同时到点多个（排骨和米饭一起响），逐个提醒
      set((s) => ({ timers: s.timers.map((t) => (due.some((d) => d.id === t.id) ? { ...t, fired: true } : t)) }))
      for (const t of due) ring(t)
      set({ ringing: due[0] })
    }
    set({ now })
  },

  dismissRinging: () => set({ ringing: null }),
}))

/** 剩余秒数；已到点返回 0 */
export function remainingSec(timer: CookTimer, now: number): number {
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

/** 把一个计时器的剩余时间格式化成 mm:ss（超过 1 小时变成 h:mm:ss） */
export function formatTimer(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function timerProgress(timer: CookTimer, now: number): number {
  if (timer.totalSec <= 0) return 0
  const elapsed = (now - (timer.endsAt - timer.totalSec * 1000)) / 1000
  return Math.min(1, Math.max(0, elapsed / timer.totalSec))
}

// ---------------------------------------------------------------------------
// 提醒：声音 + 震动
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null
let tickHandle: ReturnType<typeof setInterval> | null = null

type AudioContextCtor = typeof AudioContext

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  if (!Ctor) return null
  audioCtx ??= new Ctor()
  return audioCtx
}

/**
 * 用 Web Audio 合成三声「叮」，不引入音频文件。
 * 理由是纯静态 PWA 想尽量少一个资源；而且合成音在静音模式下也未必可靠，
 * 真正兜底的是震动和视觉提示。
 */
export function playChime(times = 3): void {
  const ctx = getAudioContext()
  if (!ctx) return
  void ctx.resume()

  for (let i = 0; i < times; i++) {
    const at = ctx.currentTime + i * 0.55
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    // 两声不同音高（880 / 1320 Hz），比单调的滴滴声更容易被注意到
    osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 1320, at)
    // 快起慢落，避免爆音
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.5)
  }
}

export function vibrate(pattern: number | number[] = [220, 120, 220, 120, 400]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // 桌面浏览器 / 无权限时静默忽略
  }
}

function notify(timer: CookTimer): void {
  // 浏览器通知是可选的第二层提醒（用户在别的标签页时才有用），失败不影响主流程
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('家庭私厨 · 计时到点', { body: `${timer.label} ${Math.round(timer.totalSec / 60)} 分钟到了` })
    }
  } catch {
    /* 忽略 */
  }
}

function ring(timer: CookTimer): void {
  playChime()
  vibrate()
  notify(timer)
}

/**
 * 启动全局 1s 心跳。返回停止函数。
 * 在 App 顶层调用一次即可；重复调用会被忽略。
 */
export function startTimerHeartbeat(): () => void {
  if (tickHandle !== null) return () => undefined
  tickHandle = setInterval(() => {
    const { timers, tick } = useTimerStore.getState()
    // 没有计时器时也走一次 tick，保持 now 前进（界面上还有别的相对时间显示）
    if (timers.length === 0) {
      useTimerStore.setState({ now: Date.now() })
      return
    }
    tick()
  }, 1000)

  return () => {
    if (tickHandle !== null) clearInterval(tickHandle)
    tickHandle = null
  }
}

/** 提前解锁音频（iOS/Safari 要求首次发声必须在用户手势里） */
export function unlockAudio(): void {
  const ctx = getAudioContext()
  if (!ctx) return
  void ctx.resume()
}
