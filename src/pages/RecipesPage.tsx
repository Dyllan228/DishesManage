import { useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import {
  addToMenu,
  categoryCounts,
  listCategories,
  listMenu,
  listRecipes,
  listTags,
  type RecipeFilter,
} from '@/data/repository'
import DishImage from '@/components/DishImage'
import FilterSheet, { EMPTY_FILTERS, activeFilterCount, type AdvancedFilters } from '@/components/FilterSheet'
import { useAppStore } from '@/store/appStore'
import type { Category, Recipe, Tag } from '@/types/models'
import { DIFFICULTY_LABEL, formatDuration } from '@/utils/labels'
import { flattenCategories } from '@/utils/tree'

export default function RecipesPage() {
  const navigate = useNavigate()
  const setMenuCount = useAppStore((s) => s.setMenuCount)
  const showToast = useAppStore((s) => s.showToast)

  const [keyword, setKeyword] = useState('')
  const [categoryId, setCategoryId] = useState<string>('all')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [sort, setSort] = useState<NonNullable<RecipeFilter['sort']>>('recent')
  const [filters, setFilters] = useState<AdvancedFilters>(EMPTY_FILTERS)
  const [filterOpen, setFilterOpen] = useState(false)
  const [gridView, setGridView] = useState(false)

  const { data: categories } = useAsync<Category[]>(() => listCategories(), [], [])
  const { data: tags } = useAsync<Tag[]>(() => listTags(), [], [])
  const { data: counts } = useAsync<Map<string, number>>(() => categoryCounts(), [categories.length], new Map())

  const { data: recipes, loading, reload } = useAsync<Recipe[]>(
    () =>
      listRecipes({
        keyword,
        categoryId,
        sort,
        favorite: favoriteOnly || undefined,
        tagIds: filters.tagIds,
        tagMode: filters.tagMode,
        ingredientKeyword: filters.ingredientKeyword,
        includeSubcategories: filters.includeSubcategories,
      }),
    [keyword, categoryId, sort, favoriteOnly, filters],
    [],
  )

  const tagName = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags])
  const topCategories = useMemo(
    () => flattenCategories(categories).filter((f) => f.depth === 0),
    [categories],
  )

  const handleQuickAdd = async (recipe: Recipe, e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await addToMenu(recipe.id)
    const menu = await listMenu()
    setMenuCount(menu.length)
    showToast(`已把「${recipe.name}」加入今日菜单`)
  }

  return (
    <div className="px-4 pt-4">
      {/* 顶栏 */}
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold">菜谱</h1>
        <div className="flex gap-2">
          <Link to="/recipes/import" className="btn-secondary">
            粘贴导入
          </Link>
          <Link to="/recipes/new" className="btn-primary">
            ＋ 新建
          </Link>
        </div>
      </header>

      {/* 搜索 */}
      <input
        className="input mb-3"
        placeholder="搜菜名、步骤、小贴士…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />

      {/* 分类横滑 */}
      <div className="-mx-4 mb-3 overflow-x-auto px-4">
        <div className="flex gap-1.5 whitespace-nowrap">
          <CategoryChip label="全部" active={categoryId === 'all'} onClick={() => setCategoryId('all')} />
          {topCategories.map(({ category }) => (
            <CategoryChip
              key={category.id}
              label={`${category.icon ?? ''} ${category.name}`.trim()}
              count={counts.get(category.id) ?? 0}
              active={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
            />
          ))}
        </div>
      </div>

      {/* 工具条 */}
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFavoriteOnly((v) => !v)}
          className={`chip border ${favoriteOnly ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'}`}
        >
          ★ 收藏
        </button>
        <button
          type="button"
          onClick={() => setFilterOpen(true)}
          className={`chip border ${activeFilterCount(filters) > 0 ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'}`}
        >
          筛选
          {activeFilterCount(filters) > 0 && <span className="ml-0.5">· {activeFilterCount(filters)}</span>}
        </button>
        <select
          className="input ml-auto w-auto py-1.5 text-xs"
          value={sort}
          onChange={(e) => setSort(e.target.value as NonNullable<RecipeFilter['sort']>)}
        >
          <option value="recent">最近添加</option>
          <option value="name">按名称</option>
          <option value="cookCount">做过次数</option>
          <option value="lastCooked">最近做过</option>
        </select>
        <button
          type="button"
          onClick={() => setGridView((v) => !v)}
          className="btn-ghost shrink-0 px-2 text-base"
          title={gridView ? '切换为列表' : '切换为网格'}
        >
          {gridView ? '☰' : '▦'}
        </button>
      </div>

      {/* 已激活的筛选条件，可点掉（FR-2.15） */}
      {(filters.tagIds.length > 0 || filters.ingredientKeyword.trim()) && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {tags
            .filter((t) => filters.tagIds.includes(t.id))
            .map((t) => (
              <span key={t.id} className="chip bg-brand-50 text-brand-700">
                {t.name}
                <button
                  type="button"
                  onClick={() => setFilters((f) => ({ ...f, tagIds: f.tagIds.filter((id) => id !== t.id) }))}
                  className="text-brand-500"
                >
                  ✕
                </button>
              </span>
            ))}
          {filters.tagIds.length > 1 && (
            <span className="text-xs text-stone-400">{filters.tagMode === 'and' ? '同时满足' : '任一即可'}</span>
          )}
          {filters.ingredientKeyword.trim() && (
            <span className="chip bg-brand-50 text-brand-700">
              食材：{filters.ingredientKeyword}
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, ingredientKeyword: '' }))}
                className="text-brand-500"
              >
                ✕
              </button>
            </span>
          )}
          <button type="button" className="btn-ghost px-1.5 text-xs" onClick={() => setFilters(EMPTY_FILTERS)}>
            清除
          </button>
        </div>
      )}

      {/* 列表 */}
      {loading && recipes.length === 0 ? (
        <p className="py-16 text-center text-sm text-stone-400">加载中…</p>
      ) : recipes.length === 0 ? (
        <EmptyRecipes
          hasFilter={Boolean(keyword) || categoryId !== 'all' || favoriteOnly || activeFilterCount(filters) > 0}
          onCreate={() => navigate('/recipes/new')}
          onClearFilter={() => {
            setKeyword('')
            setCategoryId('all')
            setFavoriteOnly(false)
            setFilters(EMPTY_FILTERS)
          }}
        />
      ) : gridView ? (
        <ul className="grid grid-cols-2 gap-2 pb-4 sm:grid-cols-3">
          {recipes.map((r) => (
            <li key={r.id}>
              <Link to={`/recipes/${r.id}`} className="card block p-3 active:bg-stone-50">
                <DishImage
                  blobId={r.coverBlobId}
                  name={r.name}
                  className="mb-2 h-20 w-full rounded-lg text-3xl"
                />
                <h3 className="truncate text-sm font-medium">{r.name}</h3>
                <p className="mt-0.5 truncate text-xs text-stone-500">
                  {formatDuration(r.durationMin)} · {DIFFICULTY_LABEL[r.difficulty]}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2 pb-4">{recipes.map((r) => renderRow(r))}</ul>
      )}

      {/* 刷新入口：从别的页面改完数据回来时手动拉一次 */}
      {!loading && (
        <button type="button" onClick={() => void reload()} className="btn-ghost mx-auto mb-4 block text-xs">
          刷新列表
        </button>
      )}

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        tags={tags}
        hasCategory={categoryId !== 'all'}
        value={filters}
        onChange={setFilters}
      />
    </div>
  )

  function renderRow(r: Recipe) {
    return (
      <li key={r.id}>
        <Link to={`/recipes/${r.id}`} className="card flex items-center gap-3 p-3 active:bg-stone-50">
          <DishImage
            blobId={r.coverBlobId}
            name={r.name}
            className="h-12 w-12 shrink-0 rounded-lg text-xl"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <h3 className="truncate font-medium">{r.name}</h3>
              {r.favorite && <span className="text-xs text-amber-500">★</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-stone-500">
              <span>{formatDuration(r.durationMin)}</span>
              <span>·</span>
              <span>{DIFFICULTY_LABEL[r.difficulty]}</span>
              {r.cookCount > 0 && (
                <>
                  <span>·</span>
                  <span>做过 {r.cookCount} 次</span>
                </>
              )}
            </div>
            {r.tagIds.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {r.tagIds.slice(0, 4).map((id) => (
                  <span key={id} className="chip bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-600">
                    {tagName.get(id) ?? ''}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => void handleQuickAdd(r, e)}
            className="btn-secondary shrink-0 px-2.5 py-1.5 text-xs"
            title="加入今日菜单"
          >
            ＋菜单
          </button>
        </Link>
      </li>
    )
  }
}

function CategoryChip({
  label,
  active,
  onClick,
  count,
}: {
  label: string
  active: boolean
  onClick: () => void
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`chip border transition-colors ${
        active ? 'border-brand-500 bg-brand-600 text-white' : 'border-stone-200 bg-white text-stone-600'
      }`}
    >
      {label}
      {count !== undefined && count > 0 && <span className="opacity-70">{count}</span>}
    </button>
  )
}

function EmptyRecipes({
  hasFilter,
  onCreate,
  onClearFilter,
}: {
  hasFilter: boolean
  onCreate: () => void
  onClearFilter: () => void
}) {
  return (
    <div className="py-16 text-center">
      <p className="text-4xl">🍳</p>
      <p className="mt-3 text-sm text-stone-500">
        {hasFilter ? '没有符合条件的菜谱' : '还没有菜谱，先记一道试试'}
      </p>
      {!hasFilter ? (
        <button type="button" className="btn-primary mt-4" onClick={onCreate}>
          录入第一道菜
        </button>
      ) : (
        <button type="button" className="btn-secondary mt-4" onClick={onClearFilter}>
          清除筛选条件
        </button>
      )}
    </div>
  )
}
