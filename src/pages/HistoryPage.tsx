/**
 * 制作历史（FR-3.31 ~ FR-3.33）
 *
 * 「上次做这道菜是什么时候、打了几分、当时说了什么」，是用户回头翻这个页面的唯一理由。
 * 所以默认视图按**日期**分组的流水账，而不是按菜谱聚合的排行榜——用户回忆的入口是
 * 「上周三那顿」，不是「番茄炒蛋的历史曲线」。
 *
 * 「再来一次」直接调 `cookAgain` / `reorderFromDate`，落到今日菜单里，
 * 不在这里另开一条"复制菜谱"的路径。
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import { cookAgain, listHistory, reorderFromDate } from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import { formatDuration } from '@/utils/labels'

type HistoryGroup = Awaited<ReturnType<typeof listHistory>>[number]

/** 「2026-10-15」→「今天」；昨天；否则「10月15日 周三」 */
function dayLabel(date: string): { primary: string; secondary: string } {
  const today = new Date()
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  if (date === key(today)) return { primary: '今天', secondary: date }
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date === key(yesterday)) return { primary: '昨天', secondary: date }

  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, (m ?? 1) - 1, d ?? 1)
  const weekday = '日一二三四五六'[parsed.getDay()]
  // 跨年的老记录保留年份，否则「1月3日」会让人误以为是今年
  const year = parsed.getFullYear() === today.getFullYear() ? '' : `${parsed.getFullYear()} 年 `
  return { primary: `${year}${m} 月 ${d} 日 周${weekday}`, secondary: date }
}

export default function HistoryPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const [limit, setLimit] = useState(30)
  const [busy, setBusy] = useState<string | null>(null)

  const { data: groups, loading, reload } = useAsync<HistoryGroup[]>(
    () => listHistory(limit),
    [limit],
    [],
  )

  const totalMeals = groups.reduce((sum, g) => sum + g.entries.length, 0)

  const again = async (key: string, action: () => Promise<void>, message: string) => {
    setBusy(key)
    try {
      await action()
      showToast(message)
      navigate('/menu')
    } finally {
      setBusy(null)
    }
  }

  const againDay = async (group: HistoryGroup) => {
    setBusy(group.date)
    try {
      await reorderFromDate(group.date)
      showToast(`已把 ${dayLabel(group.date).primary}的菜加回今日菜单`)
      navigate('/menu')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="px-4 pb-40 pt-4">
      <header className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">制作历史</h1>
        {totalMeals > 0 && <span className="text-xs text-stone-400">共 {totalMeals} 次记录</span>}
      </header>
      <p className="mb-3 text-xs text-stone-500">
        做过的菜、当时的评分和感受都在这儿。想复刻某一顿，点「照着再来一次」。
      </p>

      {loading && groups.length === 0 ? (
        <p className="py-16 text-center text-sm text-stone-400">加载中…</p>
      ) : groups.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-4xl">📖</p>
          <p className="mt-3 text-sm text-stone-500">还没有做过菜的记录</p>
          <p className="mt-1 text-xs text-stone-400">在今日菜单里点「开始做菜」，做完记一笔就会出现在这里</p>
          <Link to="/menu" className="btn-primary mt-5">
            去今日菜单
          </Link>
        </div>
      ) : (
        <>
          <ul className="space-y-4">
            {groups.map((group) => {
              const label = dayLabel(group.date)
              const ratings = group.entries
                .map((e) => e.row.rating)
                .filter((r): r is number => typeof r === 'number')
              const avg = ratings.length > 0 ? ratings.reduce((s, r) => s + r, 0) / ratings.length : null

              return (
                <li key={group.date}>
                  <div className="mb-1.5 flex items-baseline gap-2 px-1">
                    <h2 className="text-sm font-semibold text-stone-700">{label.primary}</h2>
                    <span className="text-[11px] text-stone-400">{label.secondary}</span>
                    {avg !== null && (
                      <span className="text-[11px] text-amber-600">
                        ★ {Math.round(avg * 10) / 10}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn-ghost ml-auto px-2 py-0.5 text-[11px]"
                      disabled={busy === group.date}
                      onClick={() => void againDay(group)}
                    >
                      照着再来一次
                    </button>
                  </div>

                  <ul className="space-y-2">
                    {group.entries.map(({ row, recipe }) => (
                      <li key={row.id} className="card p-3">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <Link to={`/recipes/${recipe.id}`} className="font-medium hover:underline">
                              {recipe.name}
                            </Link>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
                              <span>{row.servings} 人份</span>
                              {recipe.durationMin !== null && <span>{formatDuration(recipe.durationMin)}</span>}
                              {recipe.rating !== null && (
                                <span className="text-amber-600" title="历次平均分">
                                  均 ★ {recipe.rating}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="shrink-0 text-right">
                            <div className="text-sm leading-none">
                              {row.rating !== null ? (
                                <span className="text-amber-500">
                                  {'★'.repeat(row.rating)}
                                  <span className="text-stone-300">{'★'.repeat(5 - row.rating)}</span>
                                </span>
                              ) : (
                                <span className="text-[11px] text-stone-300">未打分</span>
                              )}
                            </div>
                            <button
                              type="button"
                              className="btn-ghost mt-1 px-2 py-0.5 text-[11px]"
                              disabled={busy === row.id}
                              onClick={() =>
                                void again(
                                  row.id,
                                  () => cookAgain(recipe.id, 1),
                                  `${recipe.name} 已加入今日菜单`,
                                )
                              }
                            >
                              再来一次
                            </button>
                          </div>
                        </div>

                        {row.note && (
                          <p className="mt-2 rounded-lg bg-amber-50/70 px-2.5 py-1.5 text-xs leading-relaxed text-amber-900">
                            {row.note}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>

          <div className="mt-4 flex justify-center gap-2">
            <button type="button" className="btn-secondary text-xs" onClick={() => setLimit((n) => n + 30)}>
              看更早的
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={() => void reload()}>
              刷新
            </button>
          </div>
        </>
      )}
    </div>
  )
}
