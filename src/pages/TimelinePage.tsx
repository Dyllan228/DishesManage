/**
 * 多菜时间线（FR-3.27 ~ FR-3.29）
 *
 * 页面只负责把 `@/domain/timeline` 算出来的东西画出来，自己不做任何排程判断——
 * 算法是纯函数、单独有测试，这里掺进逻辑就会变成两处规则各自演化。
 *
 * 展示上刻意做成**从上往下读的时刻表**，而不是甘特图：手机上一条横向时间轴
 * 很难看清，而且用户真正需要的信息只有三句——「什么时候开始动手」、
 * 「现在同时在做什么」、「哪段时间可以走开」。
 */

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import { buildMenuTimelineInput, listMenu, type MenuEntry } from '@/data/repository'
import { buildTimeline, formatClock, formatOffset, GAP_MIN_SEC } from '@/domain/timeline'

export default function TimelinePage() {
  const { data: input, loading, reload } = useAsync(
    async () => buildMenuTimelineInput(),
    [],
    [] as Awaited<ReturnType<typeof buildMenuTimelineInput>>,
  )
  const { data: menu } = useAsync<MenuEntry[]>(() => listMenu(), [], [])

  const timeline = useMemo(() => buildTimeline(input), [input])

  // 时间线只认 recipeId（domain 层不该知道"菜单项"这个概念），
  // 要做菜就得回到菜单项 id，所以在这里补一次映射
  const menuItemByRecipe = useMemo(
    () => new Map(menu.map((m) => [m.recipe.id, m.item.id])),
    [menu],
  )

  if (loading && timeline.dishes.length === 0) {
    return <p className="py-24 text-center text-sm text-stone-400">正在算时间线…</p>
  }

  if (timeline.dishes.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-4xl">🕒</p>
        <p className="mt-3 text-sm text-stone-500">菜单里还没有没做完的菜</p>
        <p className="mt-1 text-xs text-stone-400">先去点菜，这里会告诉你几道菜怎么并着做</p>
        <Link to="/menu" className="btn-primary mt-5">
          去点菜
        </Link>
      </div>
    )
  }

  return (
    <div className="px-4 pb-40 pt-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">做菜时间线</h1>
        <button type="button" className="btn-ghost text-xs" onClick={() => void reload()}>
          重新算
        </button>
      </header>

      {/* 收益一句话：这是整个页面唯一"数字"层面的说服，先说结论 */}
      <div className="card mb-4 bg-brand-50/60 p-3">
        <p className="text-sm text-stone-700">
          一起做约 <span className="font-semibold text-brand-800">{formatClock(timeline.totalSec)}</span>
          {timeline.savedSec > 0 && (
            <>
              ，比一道一道做着省{' '}
              <span className="font-semibold text-brand-800">{formatClock(timeline.savedSec)}</span>
            </>
          )}
        </p>
        <p className="mt-1 text-[11px] text-stone-500">
          串着做要 {formatClock(timeline.serialSec)}。规则：先腌 / 先炖的先动手，剩下按顺序错开。
        </p>
      </div>

      {/* 1. 什么时候开始动手（FR-3.27） */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-stone-700">什么时候动手</h2>
        <ul className="space-y-2">
          {timeline.dishes.map((d) => {
            const menuItemId = menuItemByRecipe.get(d.recipeId)
            return (
              <li key={d.recipeId} className="card p-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-stone-900 px-1.5 py-0.5 font-mono text-[11px] text-white">
                    {formatOffset(d.startSec)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{d.recipeName}</span>
                  <span className="shrink-0 text-[11px] text-stone-400">
                    {formatClock(d.endSec - d.startSec)}
                  </span>
                </div>

                {d.leadWaitSec > 0 ? (
                  <p className="mt-1.5 text-xs text-brand-700">
                    一上来先安排上，接下来 {formatClock(d.leadWaitSec)} 可以走开
                    <span className="text-stone-400">（{formatOffset(d.leadWaitSec)} 后再回来）</span>
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-stone-500">从 {formatOffset(d.startSec)} 开始一直要动手</p>
                )}

                {menuItemId && (
                  <Link to={`/menu/cook/${menuItemId}`} className="btn-secondary mt-2 py-1.5 text-xs">
                    单独做这道
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {/* 2. 同时在做什么（FR-3.29） */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-stone-700">照着这个顺序做</h2>
        <ol className="space-y-2">
          {timeline.segments.map((seg) => (
            <li
              key={`${seg.startSec}-${seg.endSec}`}
              className={`card p-3 ${seg.allPassive ? 'border-dashed bg-stone-50/70' : ''}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-stone-400">{formatOffset(seg.startSec)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    seg.allPassive ? 'bg-stone-200 text-stone-600' : 'bg-brand-100 text-brand-800'
                  }`}
                >
                  {seg.allPassive ? '等着就行' : '要动手'}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                  {formatClock(seg.endSec - seg.startSec)}
                </span>
              </div>

              <ul className="mt-2 space-y-1.5">
                {seg.steps.map((s) => (
                  <li key={s.stepId} className="flex gap-2 text-sm">
                    <span
                      className={`mt-[3px] h-2 w-2 shrink-0 rounded-full ${
                        s.passive ? 'bg-stone-300' : 'bg-brand-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-stone-500">{s.recipeName}</span>
                      <span className="mx-1 text-stone-300">·</span>
                      <span className="text-stone-800">{s.text}</span>
                    </span>
                    {s.passive && s.timerLabel && (
                      <span className="shrink-0 self-start rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">
                        {s.timerLabel}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      {/* 3. 哪段时间可以走开（FR-3.28） */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-stone-700">可以走开的时间</h2>
        {timeline.freeWindows.length === 0 ? (
          <p className="card p-3 text-xs text-stone-500">
            这道菜单没有超过 {Math.round(GAP_MIN_SEC / 60)} 分钟的空档，最好一直在旁边看着。
          </p>
        ) : (
          <ul className="space-y-2">
            {timeline.freeWindows.map((w) => (
              <li key={`${w.startSec}-${w.endSec}`} className="card border-brand-200 bg-brand-50/40 p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-brand-700">{formatOffset(w.startSec)}</span>
                  <span className="text-sm font-medium text-brand-900">{formatClock(w.endSec - w.startSec)} 空着</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-stone-400">
                    到 {formatOffset(w.endSec)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-stone-600">
                  {w.waitingFor.length > 0
                    ? `这段时间只是在等${w.waitingFor.join('、')}，可以收拾台面、去备下一道，或者歇会儿。`
                    : '这段时间锅里什么都没有，前面一道已经收工、下一道还没轮到。'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-4 text-[11px] leading-relaxed text-stone-400">
        说明：没标时长的步骤按 1 分钟估。规则只保证「动手时间不打架」，
        同时炖两道菜是允许的；同一口锅的占用情况得你自己看。
      </p>
    </div>
  )
}
