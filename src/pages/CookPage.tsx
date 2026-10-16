/**
 * 制作模式（FR-3.21 ~ FR-3.26 / FR-3.29 / FR-3.31）
 *
 * 这个页面的每一处设计都来自同一个前提：**用户的手是湿的、油的，眼睛离屏幕半米远**。
 * 于是：
 *   - 字大。步骤正文用 text-2xl，做菜时扫一眼就能看清，不用凑近
 *   - 一次一屏一到两步。滑一下就到下一步，不需要在长页面里找位置
 *   - 屏幕常亮。手不干净的时候不可能每 30 秒去解锁一次
 *   - 计时器点击即启动，且跳出页面还在跑（在全局 store 里）
 *   - 食材、笔记是抽屉而不是跳页——跳页会丢掉"我做到第几步了"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import DishImage from '@/components/DishImage'
import { useAsync } from '@/hooks/useAsync'
import { useWakeLock } from '@/hooks/useWakeLock'
import {
  addNote,
  findMenuItem,
  finishCooking,
  getRecipeDetail,
  listCategories,
  type MenuEntry,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import { useTimerStore, unlockAudio } from '@/store/timerStore'
import { scaleAmount } from '@/domain/scale'
import { formatClock } from '@/domain/timeline'
import { categoryLabel } from '@/utils/tree'
import type { Category, RecipeDetail } from '@/types/models'

export default function CookPage() {
  const { menuItemId = '' } = useParams()
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const startTimer = useTimerStore((s) => s.start)

  const [stepIndex, setStepIndex] = useState(0)
  const [drawer, setDrawer] = useState<null | 'ingredients' | 'note' | 'finish'>(null)
  const [noteText, setNoteText] = useState('')
  const [rating, setRating] = useState<number | null>(null)
  const [feeling, setFeeling] = useState('')
  const [saving, setSaving] = useState(false)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  const wake = useWakeLock(true)

  const { data: menuEntry, loading: menuLoading } = useAsync<MenuEntry | null>(
    () => findMenuItem(menuItemId),
    [menuItemId],
    null,
  )
  const recipeId = menuEntry?.item.recipeId ?? ''
  const { data: detail, loading: detailLoading } = useAsync<RecipeDetail | null>(
    () => (recipeId ? getRecipeDetail(recipeId) : Promise.resolve(null)),
    [recipeId],
    null,
  )
  const { data: categories } = useAsync<Category[]>(() => listCategories(), [], [])

  const multiplier = menuEntry?.item.multiplier ?? 1
  const steps = detail?.steps ?? []
  const step = steps[stepIndex]

  // 制作是"用户手势"打头的，正好用来解锁音频上下文——iOS 上晚于此的第一次发声会被静音
  useEffect(() => {
    unlockAudio()
  }, [])

  const go = useCallback(
    (delta: number) => {
      setStepIndex((i) => Math.min(Math.max(0, i + delta), Math.max(0, steps.length - 1)))
    },
    [steps.length],
  )

  // 桌面端用方向键，手机上用左右滑动（下面）——两套都要，不然总有一端难用
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (drawer !== null) return
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        go(1)
      }
      if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, drawer])

  const ingredients = useMemo(
    () => (detail?.ingredients ?? []).map((i) => ({ ...i, scaled: scaleAmount(i, multiplier) })),
    [detail, multiplier],
  )

  const startStepTimer = (label: string, seconds: number) => {
    startTimer({ label, seconds, recipeName: detail?.recipe.name ?? null })
    showToast(`${label} 计时已启动`)
  }

  const saveNote = async () => {
    if (!recipeId || !noteText.trim()) return
    await addNote(recipeId, noteText.trim())
    setNoteText('')
    showToast('笔记已保存到这道菜')
    setDrawer(null)
  }

  const finish = async () => {
    setSaving(true)
    try {
      await finishCooking(menuItemId, { rating, note: feeling.trim() || null })
      showToast('已完成，记一笔')
      setDrawer(null)
      navigate('/menu', { replace: true })
    } finally {
      setSaving(false)
    }
  }

  // 加载中不能显示"不在菜单里"：data 初值是 null，直接判断会先闪一句错话
  if (menuLoading || (menuEntry !== null && detailLoading)) {
    return <p className="py-24 text-center text-sm text-stone-400">加载中…</p>
  }

  if (!menuEntry || !detail) {
    return (
      <div className="py-24 text-center text-sm text-stone-400">
        <p>{!menuEntry ? '这道菜不在今日菜单里' : '菜谱读取失败，可能已经被删掉了'}</p>
        <Link to="/menu" className="btn-secondary mt-4 inline-block">
          回到今日菜单
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-h-[70vh] flex-1 flex-col">
      {/* 顶栏：退出 + 屏幕常亮状态 */}
      <header className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="btn-ghost px-2 text-sm" onClick={() => navigate(-1)}>
          ← 退出制作
        </button>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[11px] ${
            wake.active ? 'bg-green-100 text-green-800' : 'bg-stone-100 text-stone-500'
          }`}
          title={wake.hint ?? (wake.active ? '屏幕会一直亮着' : '屏幕可能自动熄灭')}
        >
          {wake.active ? '☀ 屏幕常亮' : wake.supported ? '○ 常亮未生效' : '○ 不支持常亮'}
        </span>
      </header>

      {wake.hint && (
        <p className="mx-3 mb-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">{wake.hint}</p>
      )}

      {/* 步骤进度 */}
      <div className="px-4">
        <div className="flex items-baseline gap-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-stone-600">{detail.recipe.name}</h1>
          <span className="shrink-0 text-xs tabular-nums text-stone-400">
            {stepIndex + 1} / {steps.length}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-stone-100">
          <div
            className="h-full bg-brand-500 transition-all"
            style={{ width: `${steps.length ? ((stepIndex + 1) / steps.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* 步骤主体：一次一屏一到两步 */}
      <div
        className="flex flex-1 flex-col px-4 py-4"
        onTouchStart={(e) => {
          touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        }}
        onTouchEnd={(e) => {
          const start = touchStart.current
          touchStart.current = null
          if (!start || drawer !== null) return
          const dx = e.changedTouches[0].clientX - start.x
          const dy = e.changedTouches[0].clientY - start.y
          // 只认横向滑动：竖向是用来滚长步骤的，不能被误判成翻页
          if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
          go(dx < 0 ? 1 : -1)
        }}
      >
        {step ? (
          <div className="flex-1">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                {stepIndex + 1}
              </span>
              {step.timerSec !== null && step.timerSec > 0 && (
                <span className="text-xs text-brand-700">约 {formatClock(step.timerSec)}</span>
              )}
            </div>

            <p className="whitespace-pre-wrap text-2xl leading-relaxed text-stone-800">{step.text}</p>

            {step.imageBlobId && (
              <DishImage
                blobId={step.imageBlobId}
                name={`第${stepIndex + 1}步`}
                variant="full"
                className="mt-4 aspect-[4/3] w-full rounded-xl text-4xl"
              />
            )}

            {/* FR-3.23：步骤里蕴含时长时，一键启动倒计时 */}
            {step.timerSec !== null && step.timerSec > 0 && (
              <button
                type="button"
                className="btn-primary mt-4 w-full py-3 text-base"
                onClick={() => startStepTimer(step.timerLabel ?? `第${stepIndex + 1}步`, step.timerSec!)}
              >
                ⏱ 启动「{step.timerLabel ?? '计时'}」{formatClock(step.timerSec)}
              </button>
            )}

            {/* 下一步预览："一次一屏一到两步"里的那"第二步" */}
            {steps[stepIndex + 1] && (
              <div className="mt-6 rounded-xl border border-dashed border-stone-200 p-3">
                <p className="mb-1 text-[11px] text-stone-400">下一步</p>
                <p className="line-clamp-2 text-sm text-stone-500">{steps[stepIndex + 1].text}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="py-16 text-center text-sm text-stone-400">这道菜还没有步骤</p>
        )}
      </div>

      {/* 工具条 */}
      <div className="flex items-center justify-around border-t border-stone-200 px-2 py-2 text-xs">
        <button type="button" className="btn-ghost flex-col px-3 py-1.5" onClick={() => setDrawer('ingredients')}>
          <span className="text-lg">🧺</span>
          食材
        </button>
        <button type="button" className="btn-ghost flex-col px-3 py-1.5" onClick={() => setDrawer('note')}>
          <span className="text-lg">📝</span>
          记一笔
        </button>
        <Link to="/menu/timeline" className="btn-ghost flex-col px-3 py-1.5">
          <span className="text-lg">🕒</span>
          时间线
        </Link>
        <button type="button" className="btn-ghost flex-col px-3 py-1.5" onClick={() => setDrawer('finish')}>
          <span className="text-lg">✅</span>
          做完了
        </button>
      </div>

      {/* 翻页：大按钮比手势可靠——手上有油的时候滑动经常失手。
          底部留白由 App 统一按计时器条高度算，这里不用自己补 */}
      <div className="flex gap-2 px-4 pb-2 pt-2">
        <button
          type="button"
          className="btn-secondary flex-1 py-3"
          disabled={stepIndex === 0}
          onClick={() => go(-1)}
        >
          上一步
        </button>
        {stepIndex < steps.length - 1 ? (
          <button type="button" className="btn-primary flex-[2] py-3" onClick={() => go(1)}>
            下一步
          </button>
        ) : (
          <button type="button" className="btn-primary flex-[2] py-3" onClick={() => setDrawer('finish')}>
            最后一步，完成
          </button>
        )}
      </div>

      {/* 抽屉 */}
      {drawer !== null && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/40"
          onClick={() => setDrawer(null)}
          role="presentation"
        >
          <div
            className="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            {drawer === 'ingredients' && (
              <>
                <div className="mb-2 flex items-center">
                  <h2 className="text-base font-semibold">食材与用量</h2>
                  {multiplier !== 1 && (
                    <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">
                      ×{multiplier}
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-stone-100">
                  {ingredients.map((i) => (
                    <li key={i.id} className="flex items-baseline gap-2 py-2 text-sm">
                      <span className="min-w-0 flex-1">{i.name}</span>
                      <span className="shrink-0 font-medium tabular-nums text-stone-700">
                        {i.scaled.display}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-stone-400">
                  {categoryLabel(categories, detail.recipe.categoryId)} · 基准 {detail.recipe.servings} 人份
                </p>
              </>
            )}

            {drawer === 'note' && (
              <>
                <h2 className="mb-2 text-base font-semibold">记一笔（FR-3.26）</h2>
                <p className="mb-2 text-xs text-stone-500">
                  做菜过程中的发现会存到这道菜的笔记里，下次做的时候翻得到。
                </p>
                <textarea
                  className="input resize-y"
                  rows={4}
                  autoFocus
                  placeholder="如：下次盐少放一半；煎的时候火再小一点"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary mt-3 w-full py-3"
                  disabled={!noteText.trim()}
                  onClick={() => void saveNote()}
                >
                  保存笔记
                </button>
              </>
            )}

            {drawer === 'finish' && (
              <>
                <h2 className="mb-2 text-base font-semibold">这道菜做完了</h2>
                <p className="mb-3 text-xs text-stone-500">打个分、记一句感受，以后就知道该不该再做（FR-3.31）</p>

                <div className="mb-3 flex justify-center gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`text-3xl transition ${rating !== null && n <= rating ? 'text-amber-500' : 'text-stone-300'}`}
                      onClick={() => setRating(n)}
                      aria-label={`${n} 星`}
                    >
                      ★
                    </button>
                  ))}
                </div>
                {rating !== null && (
                  <button type="button" className="mx-auto mb-2 block text-[11px] text-stone-400" onClick={() => setRating(null)}>
                    取消打分
                  </button>
                )}

                <textarea
                  className="input resize-y"
                  rows={2}
                  placeholder="如：家里人都说好，就是有点咸"
                  value={feeling}
                  onChange={(e) => setFeeling(e.target.value)}
                />

                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-secondary flex-1" onClick={() => setDrawer(null)}>
                    还没好
                  </button>
                  <button
                    type="button"
                    className="btn-primary flex-[2] py-3"
                    disabled={saving}
                    onClick={() => void finish()}
                  >
                    {saving ? '保存中…' : '完成并记录'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
