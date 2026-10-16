/**
 * 计时器条（FR-3.24）
 *
 * 固定在屏幕底部，任何页面都看得见——在制作模式里它在，跳去看备菜清单它也在。
 * 到点的计时器变红并停止跳动，等用户手动确认后消失（不能自动消失：
 * 人可能正背对着手机切菜，铃声过了没看见就永远不知道时间到了）。
 */

import { useTimerStore, formatTimer, remainingSec, timerProgress } from '@/store/timerStore'
import { TIMER_GAP_PX } from '@/domain/timerLayout'

interface Props {
  /** 紧凑模式：只显示倒计时，不显示进度条，用于空间紧张的页面 */
  compact?: boolean
}

export default function TimerBar({ compact = false }: Props) {
  const timers = useTimerStore((s) => s.timers)
  const now = useTimerStore((s) => s.now)
  const cancel = useTimerStore((s) => s.cancel)
  const clearFired = useTimerStore((s) => s.clearFired)

  if (timers.length === 0) return null

  const fired = timers.filter((t) => t.fired)
  const active = timers.filter((t) => !t.fired)

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-3">
      {/* gap 与 `@/domain/timerLayout` 里的 TIMER_GAP_PX 必须一致，否则 App 预留的
          底部空白就对不上了 */}
      <div className="pointer-events-auto w-full max-w-md" style={{ display: 'flex', flexDirection: 'column', gap: TIMER_GAP_PX }}>
        {fired.length > 0 && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-left text-white shadow-lg"
            onClick={() => clearFired()}
          >
            <span className="text-lg">🔔</span>
            <span className="min-w-0 flex-1 text-sm font-medium">
              {fired.map((t) => t.label).join('、')} 到点了
            </span>
            <span className="shrink-0 text-xs opacity-80">点掉</span>
          </button>
        )}

        {active.map((t) => {
          const left = remainingSec(t, now)
          const progress = timerProgress(t, now)
          return (
            <div
              key={t.id}
              className="flex items-center gap-2.5 rounded-xl bg-stone-900/90 px-3 py-2 text-white shadow-lg backdrop-blur"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs text-stone-300">
                    {t.label}
                    {t.recipeName && t.label !== t.recipeName && (
                      <span className="ml-1 text-stone-500">{t.recipeName}</span>
                    )}
                  </span>
                  <span className={`ml-auto shrink-0 font-mono tabular-nums ${left <= 60 ? 'text-amber-300' : ''}`}>
                    {formatTimer(left)}
                  </span>
                </div>
                {!compact && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/20">
                    <div className="h-full bg-brand-400" style={{ width: `${progress * 100}%` }} />
                  </div>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md px-2 py-1 text-xs text-stone-300 active:bg-white/10"
                onClick={() => cancel(t.id)}
                title="取消这个计时器"
              >
                ✕
              </button>
            </div>
          )
        })}

        {fired.length === 0 && active.length > 1 && (
          <button
            type="button"
            className="mx-auto block rounded-full bg-stone-900/70 px-3 py-1 text-[11px] text-stone-200"
            onClick={() => {
              for (const t of timers) cancel(t.id)
            }}
          >
            全部取消
          </button>
        )}
      </div>
    </div>
  )
}
