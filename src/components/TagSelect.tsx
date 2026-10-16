import { useMemo, useState } from 'react'
import { useAsync } from '@/hooks/useAsync'
import { createTag, listTags } from '@/data/repository'
import type { ID, Tag, TagDimension } from '@/types/models'
import { DIMENSION_LABEL, DIMENSION_ORDER } from '@/data/seed'

interface Props {
  selected: ID[]
  onChange: (ids: ID[]) => void
}

/** 标签多选器：按维度分组展示，支持即时新建（FR-2.10） */
export default function TagSelect({ selected, onChange }: Props) {
  const { data: tags, reload } = useAsync<Tag[]>(() => listTags(), [], [])
  const [activeDimension, setActiveDimension] = useState<TagDimension>('cuisine')
  const [newName, setNewName] = useState('')

  const byDimension = useMemo(() => {
    const map = new Map<TagDimension, Tag[]>()
    for (const t of tags) {
      const arr = map.get(t.dimension) ?? []
      arr.push(t)
      map.set(t.dimension, arr)
    }
    return map
  }, [tags])

  const toggle = (id: ID) => {
    onChange(selected.includes(id) ? selected.filter((t) => t !== id) : [...selected, id])
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const id = await createTag(name, activeDimension)
    setNewName('')
    await reload()
    if (!selected.includes(id)) onChange([...selected, id])
  }

  return (
    <div className="space-y-2">
      {/* 维度切换 */}
      <div className="flex flex-wrap gap-1.5">
        {DIMENSION_ORDER.map((dim) => (
          <button
            key={dim}
            type="button"
            onClick={() => setActiveDimension(dim)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              activeDimension === dim
                ? 'bg-brand-600 text-white'
                : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
            }`}
          >
            {DIMENSION_LABEL[dim]}
            {(byDimension.get(dim) ?? []).filter((t) => selected.includes(t.id)).length > 0 && (
              <span className="ml-1 opacity-80">
                {(byDimension.get(dim) ?? []).filter((t) => selected.includes(t.id)).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 候选标签 */}
      <div className="flex flex-wrap gap-1.5">
        {(byDimension.get(activeDimension) ?? []).map((tag) => {
          const on = selected.includes(tag.id)
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => toggle(tag.id)}
              className={`chip border transition-colors ${
                on
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300'
              }`}
            >
              {on && <span aria-hidden>✓</span>}
              {tag.name}
            </button>
          )
        })}
        {(byDimension.get(activeDimension) ?? []).length === 0 && (
          <p className="text-xs text-stone-400">该维度还没有标签，在下面新建一个</p>
        )}
      </div>

      {/* 新建 */}
      <div className="flex gap-2">
        <input
          className="input flex-1"
          placeholder={`新建「${DIMENSION_LABEL[activeDimension]}」标签`}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleCreate()
            }
          }}
        />
        <button type="button" className="btn-secondary" onClick={() => void handleCreate()}>
          添加
        </button>
      </div>

      {/* 已选汇总 */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 rounded-lg bg-stone-50 p-2">
          {tags
            .filter((t) => selected.includes(t.id))
            .map((t) => (
              <span key={t.id} className="chip bg-stone-200 text-stone-700">
                {t.name}
                <button type="button" onClick={() => toggle(t.id)} className="text-stone-500 hover:text-stone-800">
                  ✕
                </button>
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
