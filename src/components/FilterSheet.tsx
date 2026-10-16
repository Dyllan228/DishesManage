import { useMemo, useState } from 'react'
import { DIMENSION_LABEL, DIMENSION_ORDER } from '@/data/seed'
import type { ID, Tag, TagDimension } from '@/types/models'

export interface AdvancedFilters {
  tagIds: ID[]
  tagMode: 'and' | 'or'
  ingredientKeyword: string
  includeSubcategories: boolean
}

export const EMPTY_FILTERS: AdvancedFilters = {
  tagIds: [],
  tagMode: 'and',
  ingredientKeyword: '',
  includeSubcategories: true,
}

export function activeFilterCount(f: AdvancedFilters): number {
  return (f.tagIds.length > 0 ? 1 : 0) + (f.ingredientKeyword.trim() ? 1 : 0)
}

interface Props {
  open: boolean
  onClose: () => void
  tags: Tag[]
  /** 当前是否选中了某个具体分类——只有在具体分类下，「含子分类」开关才有意义 */
  hasCategory: boolean
  value: AdvancedFilters
  onChange: (next: AdvancedFilters) => void
}

/** 高级筛选面板（FR-2.13 / FR-4.2）：多标签交集/并集 + 食材反查 */
export default function FilterSheet({ open, onClose, tags, hasCategory, value, onChange }: Props) {
  // 草稿态：面板内的改动先攒着，点「应用」才回写，避免每次点标签都重查一次数据库
  const [draft, setDraft] = useState<AdvancedFilters>(value)
  const [dimension, setDimension] = useState<TagDimension | 'all'>('all')
  const [openedFor, setOpenedFor] = useState(open)

  // 每次打开时用外部值重置草稿
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) setDraft(value)
  }

  const visibleTags = useMemo(
    () => (dimension === 'all' ? tags : tags.filter((t) => t.dimension === dimension)),
    [tags, dimension],
  )

  const dimensionsWithTags = useMemo(
    () => DIMENSION_ORDER.filter((d) => tags.some((t) => t.dimension === d)),
    [tags],
  )

  if (!open) return null

  const toggleTag = (id: ID) => {
    setDraft((d) => ({
      ...d,
      tagIds: d.tagIds.includes(id) ? d.tagIds.filter((t) => t !== id) : [...d.tagIds, id],
    }))
  }

  const selectedTags = tags.filter((t) => draft.tagIds.includes(t.id))

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">筛选</h2>
          <button type="button" className="btn-ghost px-2 text-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 标签筛选 */}
        <section className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-medium">标签</h3>
            {draft.tagIds.length > 1 && (
              <div className="ml-auto flex overflow-hidden rounded-full border border-stone-200 text-xs">
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, tagMode: 'and' }))}
                  className={`px-2.5 py-1 ${draft.tagMode === 'and' ? 'bg-brand-600 text-white' : 'bg-white text-stone-600'}`}
                >
                  同时满足
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, tagMode: 'or' }))}
                  className={`px-2.5 py-1 ${draft.tagMode === 'or' ? 'bg-brand-600 text-white' : 'bg-white text-stone-600'}`}
                >
                  任一即可
                </button>
              </div>
            )}
          </div>

          {tags.length === 0 ? (
            <p className="text-xs text-stone-400">还没有标签，去「我的 → 标签管理」建几个</p>
          ) : (
            <>
              <div className="-mx-4 mb-2 overflow-x-auto px-4">
                <div className="flex gap-1.5 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => setDimension('all')}
                    className={`chip border ${dimension === 'all' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'}`}
                  >
                    全部
                  </button>
                  {dimensionsWithTags.map((dim) => (
                    <button
                      key={dim}
                      type="button"
                      onClick={() => setDimension(dim)}
                      className={`chip border ${dimension === dim ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'}`}
                    >
                      {DIMENSION_LABEL[dim]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {visibleTags.map((tag) => {
                  const on = draft.tagIds.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`chip border ${on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'}`}
                    >
                      {on && <span aria-hidden>✓</span>}
                      {tag.name}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </section>

        {/* 食材反查 */}
        <section className="mb-4">
          <h3 className="mb-2 text-sm font-medium">按食材找菜（冰箱里有什么就做什么）</h3>
          <input
            className="input"
            placeholder="如「番茄 鸡蛋」，多个食材用空格隔开"
            value={draft.ingredientKeyword}
            onChange={(e) => setDraft((d) => ({ ...d, ingredientKeyword: e.target.value }))}
          />
          <p className="mt-1 text-xs text-stone-400">命中食材越多的菜排越前</p>
        </section>

        {/* 子分类开关 */}
        {hasCategory && (
          <label className="mb-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.includeSubcategories}
              onChange={(e) => setDraft((d) => ({ ...d, includeSubcategories: e.target.checked }))}
            />
            包含子分类的菜谱
          </label>
        )}

        {selectedTags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1.5 rounded-lg bg-stone-50 p-2">
            {selectedTags.map((t) => (
              <span key={t.id} className="chip bg-stone-200 text-stone-700">
                {t.name}
                <button type="button" onClick={() => toggleTag(t.id)} className="text-stone-500 hover:text-stone-800">
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => {
              setDraft({ ...EMPTY_FILTERS, includeSubcategories: value.includeSubcategories })
            }}
          >
            清空
          </button>
          <button
            type="button"
            className="btn-primary flex-1"
            onClick={() => {
              onChange(draft)
              onClose()
            }}
          >
            应用
          </button>
        </div>
      </div>
    </div>
  )
}
