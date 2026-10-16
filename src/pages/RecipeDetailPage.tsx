import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import DishImage from '@/components/DishImage'
import { useAsync } from '@/hooks/useAsync'
import {
  addToMenu,
  deleteRecipe,
  getRecipeDetail,
  listCategories,
  listMenu,
  listTags,
  toggleFavorite,
  type MenuEntry,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import type { Category, RecipeDetail, Tag } from '@/types/models'
import { displayWithHint, scaleAmount } from '@/domain/scale'
import { DIFFICULTY_LABEL, formatDuration } from '@/utils/labels'
import { categoryLabel } from '@/utils/tree'

export default function RecipeDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const setMenuCount = useAppStore((s) => s.setMenuCount)

  const { data: detail, loading, reload } = useAsync<RecipeDetail | null>(
    () => getRecipeDetail(id),
    [id],
    null,
  )
  const { data: categories } = useAsync<Category[]>(() => listCategories(), [], [])
  const { data: tags } = useAsync<Tag[]>(() => listTags(), [], [])
  const { data: menu, reload: reloadMenu } = useAsync<MenuEntry[]>(() => listMenu(), [], [])

  const [multiplier, setMultiplier] = useState(1)

  const tagName = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags])
  /** 这道菜已经在今日菜单里的话，给出它的菜单项 id（用于跳制作模式） */
  const menuItemId = useMemo(
    () => menu.find((m) => m.recipe.id === id)?.item.id ?? null,
    [menu, id],
  )

  if (loading && !detail) return <p className="py-24 text-center text-sm text-stone-400">加载中…</p>
  if (!detail) {
    return (
      <div className="py-24 text-center">
        <p className="text-sm text-stone-500">菜谱不存在或已被删除</p>
        <Link to="/recipes" className="btn-secondary mt-4">
          返回列表
        </Link>
      </div>
    )
  }

  const { recipe, ingredients, steps, notes } = detail
  const mains = ingredients.filter((i) => i.kind === 'main')
  const seasonings = ingredients.filter((i) => i.kind === 'seasoning')

  const handleAddToMenu = async () => {
    await addToMenu(recipe.id, multiplier)
    setMenuCount((await listMenu()).length)
    await reloadMenu()
    showToast(`已加入今日菜单（${multiplier}×）`)
  }

  const handleDelete = async () => {
    await deleteRecipe(recipe.id)
    showToast('已移入回收站')
    navigate('/recipes')
  }

  return (
    <article className="pb-4">
      {/* 顶部操作条 */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-stone-200 bg-stone-50/95 px-4 py-2 backdrop-blur">
        <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost px-2 text-lg"
            title={recipe.favorite ? '取消收藏' : '收藏'}
            onClick={async () => {
              await toggleFavorite(recipe.id)
              await reload()
            }}
          >
            {recipe.favorite ? '★' : '☆'}
          </button>
          <Link to={`/recipes/${recipe.id}/edit`} className="btn-ghost px-2 text-sm">
            编辑
          </Link>
        </div>
      </div>

      <div className="px-4 pt-4">
        {recipe.coverBlobId && (
          <DishImage
            blobId={recipe.coverBlobId}
            name={recipe.name}
            variant="full"
            className="mb-3 aspect-[4/3] w-full rounded-xl text-4xl"
          />
        )}
        <h1 className="text-2xl font-semibold">{recipe.name}</h1>
        {recipe.intro && <p className="mt-1 text-sm text-stone-500">{recipe.intro}</p>}

        {/* 元信息 */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
          <span>{categoryLabel(categories, recipe.categoryId)}</span>
          <span>·</span>
          <span>{formatDuration(recipe.durationMin)}</span>
          <span>·</span>
          <span>{DIFFICULTY_LABEL[recipe.difficulty]}</span>
          <span>·</span>
          <span>基准 {recipe.servings} 人份</span>
          {recipe.cookCount > 0 && (
            <>
              <span>·</span>
              {/* 点进去可以看每次的分与感受（FR-3.31） */}
              <Link to="/history" className="text-brand-700 hover:underline">
                做过 {recipe.cookCount} 次
                {recipe.lastCookedAt && ` · 上次 ${new Date(recipe.lastCookedAt).toLocaleDateString('zh-CN')}`}
              </Link>
            </>
          )}
        </div>

        {recipe.tagIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {recipe.tagIds.map((tid) => (
              <span key={tid} className="chip bg-stone-100 text-stone-600">
                {tagName.get(tid) ?? ''}
              </span>
            ))}
          </div>
        )}

        {/* 份量调节（FR-3.3） */}
        <section className="card mt-4 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">份量</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary h-8 w-8 p-0"
                onClick={() => setMultiplier((m) => Math.max(0.5, Math.round((m - 0.5) * 2) / 2))}
              >
                −
              </button>
              <span className="w-12 text-center text-sm font-medium tabular-nums">{multiplier}×</span>
              <button
                type="button"
                className="btn-secondary h-8 w-8 p-0"
                onClick={() => setMultiplier((m) => Math.min(5, Math.round((m + 0.5) * 2) / 2))}
              >
                ＋
              </button>
            </div>
          </div>
          <p className="mt-1 text-xs text-stone-400">
            约 {(recipe.servings * multiplier).toFixed(1).replace(/\.0$/, '')} 人份 · 下方用量已按此换算
          </p>
        </section>

        {/* 食材 */}
        <IngredientSection title="食材" items={mains} multiplier={multiplier} />
        {seasonings.length > 0 && <IngredientSection title="调料" items={seasonings} multiplier={multiplier} />}

        {/* 步骤 */}
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold">步骤</h2>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={s.id} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="pt-0.5 text-sm leading-relaxed">{s.text}</p>
                  {s.imageBlobId && (
                    <DishImage
                      blobId={s.imageBlobId}
                      name={`第${i + 1}步`}
                      variant="full"
                      className="mt-2 aspect-[4/3] w-full rounded-lg text-2xl"
                    />
                  )}
                  {s.timerSec !== null && s.timerSec > 0 && (
                    <p className="mt-1 text-xs text-brand-700">
                      ⏱ {s.timerLabel ?? '计时'} {Math.round(s.timerSec / 60)} 分钟
                    </p>
                  )}
                </div>
              </li>
            ))}
            {steps.length === 0 && <li className="text-sm text-stone-400">还没有步骤</li>}
          </ol>
        </section>

        {/* 小贴士与笔记 */}
        {recipe.tips && (
          <section className="mt-6 rounded-xl bg-amber-50 p-3">
            <h2 className="mb-1 text-sm font-semibold text-amber-900">小贴士</h2>
            <p className="whitespace-pre-wrap text-sm text-amber-900/90">{recipe.tips}</p>
          </section>
        )}

        {notes.length > 0 && (
          <section className="mt-4">
            <h2 className="mb-2 text-base font-semibold">我的笔记</h2>
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="card p-3 text-sm">
                  <p className="whitespace-pre-wrap">{n.text}</p>
                  {n.cookedOn && <p className="mt-1 text-xs text-stone-400">{n.cookedOn}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {recipe.sourceText && (
          <details className="mt-4 rounded-xl border border-stone-200 bg-white p-3">
            <summary className="cursor-pointer text-sm text-stone-600">查看来源原文</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-stone-500">
              {recipe.sourceText}
            </pre>
          </details>
        )}

        <button type="button" className="btn-ghost mt-6 text-xs text-red-600" onClick={() => void handleDelete()}>
          删除这道菜谱
        </button>
      </div>

      {/* 底部固定操作 */}
      <div className="fixed inset-x-0 bottom-16 z-20 px-4">
        <div className="mx-auto flex max-w-3xl gap-2">
          {/* 已经在今日菜单里的话，直接给一条做菜的路——用户从菜谱进来往往就是现在要做 */}
          {menuItemId && (
            <Link to={`/menu/cook/${menuItemId}`} className="btn-secondary shrink-0 shadow-lg">
              开始做菜
            </Link>
          )}
          <button
            type="button"
            className="btn-primary flex-1 shadow-lg"
            onClick={() => void handleAddToMenu()}
          >
            加入今日菜单（{multiplier}×）
          </button>
        </div>
      </div>
    </article>
  )
}

function IngredientSection({
  title,
  items,
  multiplier,
}: {
  title: string
  items: RecipeDetail['ingredients']
  multiplier: number
}) {
  if (items.length === 0) return null
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <ul className="card divide-y divide-stone-100">
        {items.map((ing) => {
          const scaled = scaleAmount(
            { amount: ing.amount, unit: ing.unit, amountText: ing.amountText },
            multiplier,
            'display',
          )
          return (
            <li key={ing.id} className="flex items-center justify-between px-3 py-2.5 text-sm">
              <span>
                {ing.name}
                {ing.note && <span className="ml-1 text-xs text-stone-400">（{ing.note}）</span>}
              </span>
              <span className="tabular-nums text-stone-600">{displayWithHint(scaled)}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
