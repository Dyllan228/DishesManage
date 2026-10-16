import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import { createTag, deleteTag, listTags, mergeTags, recomputeAllTagUsage, renameTag } from '@/data/repository'
import { DIMENSION_LABEL, DIMENSION_ORDER } from '@/data/seed'
import { useAppStore } from '@/store/appStore'
import type { ID, Tag, TagDimension } from '@/types/models'

export default function TagManagePage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)

  const { data: tags, reload } = useAsync<Tag[]>(() => listTags(), [], [])
  const [dimension, setDimension] = useState<TagDimension>('cuisine')
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<ID | null>(null)
  const [editingName, setEditingName] = useState('')
  const [mergeFrom, setMergeFrom] = useState<ID | null>(null)

  const byDimension = useMemo(() => {
    const map = new Map<TagDimension, Tag[]>()
    for (const t of tags) {
      const arr = map.get(t.dimension) ?? []
      arr.push(t)
      map.set(t.dimension, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return map
  }, [tags])

  const current = byDimension.get(dimension) ?? []

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    await createTag(name, dimension)
    setNewName('')
    await reload()
    showToast(`已新建标签「${name}」`)
  }

  const handleRename = async (tag: Tag) => {
    const name = editingName.trim()
    if (!name || name === tag.name) {
      setEditingId(null)
      return
    }
    // 「重命名」若撞上同维度已有标签，语义上就是合并——直接走合并，避免出现两个同名标签
    const clash = current.find((t) => t.name === name && t.id !== tag.id)
    if (clash) {
      await mergeTags(tag.id, clash.id)
      showToast(`「${tag.name}」与已有「${clash.name}」合并`)
    } else {
      await renameTag(tag.id, name)
      showToast('已重命名')
    }
    setEditingId(null)
    await reload()
  }

  const handleDelete = async (tag: Tag) => {
    const msg =
      tag.usageCount > 0
        ? `删除标签「${tag.name}」？\n\n有 ${tag.usageCount} 道菜谱用了它，这些菜谱上的该标签会被移除。`
        : `删除标签「${tag.name}」？`
    if (!window.confirm(msg)) return
    await deleteTag(tag.id)
    await reload()
    showToast('已删除')
  }

  const handleMergeInto = async (toId: ID) => {
    if (!mergeFrom || mergeFrom === toId) return
    const from = tags.find((t) => t.id === mergeFrom)
    const to = tags.find((t) => t.id === toId)
    if (!from || !to) return
    if (!window.confirm(`把「${from.name}」并入「${to.name}」？\n\n${from.usageCount} 道菜谱的标签会自动改成「${to.name}」。`)) return
    await mergeTags(from.id, to.id)
    setMergeFrom(null)
    await reload()
    showToast(`已合并到「${to.name}」`)
  }

  const handleRecompute = async () => {
    await recomputeAllTagUsage()
    await reload()
    showToast('使用频次已重算')
  }

  const unusedCount = tags.filter((t) => t.usageCount === 0).length

  return (
    <div className="px-4 pb-28 pt-4">
      <header className="mb-4 flex items-center gap-2">
        <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="text-lg font-semibold">标签管理</h1>
        <button type="button" className="btn-ghost ml-auto px-2 text-xs" onClick={() => void handleRecompute()}>
          重算频次
        </button>
      </header>

      <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
        标签是跨分类的筛选维度。同名标签只在**同一维度内**唯一，所以「川菜」（菜系）和
        「川菜」（口味）可以并存；改名时若撞上同维度已有标签，会自动合并而不是产生重复。
      </p>

      {/* 维度切换 */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {DIMENSION_ORDER.map((dim) => {
          const list = byDimension.get(dim) ?? []
          return (
            <button
              key={dim}
              type="button"
              onClick={() => {
                setDimension(dim)
                setMergeFrom(null)
              }}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                dimension === dim ? 'bg-brand-600 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
              }`}
            >
              {DIMENSION_LABEL[dim]}
              <span className="ml-1 opacity-70">{list.length}</span>
            </button>
          )
        })}
      </div>

      {mergeFrom && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>
            合并模式：点一个标签，把「{tags.find((t) => t.id === mergeFrom)?.name}」并进去
          </span>
          <button type="button" className="btn-ghost ml-auto px-1.5 text-xs" onClick={() => setMergeFrom(null)}>
            取消
          </button>
        </div>
      )}

      {/* 标签列表 */}
      <ul className="card divide-y divide-stone-100">
        {current.map((tag) => {
          const isEditing = editingId === tag.id
          return (
            <li key={tag.id} className="flex items-center gap-2 px-3 py-2">
              {isEditing ? (
                <>
                  <input
                    className="input flex-1 py-1"
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRename(tag)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void handleRename(tag)}>
                    确定
                  </button>
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <span className="text-sm">{tag.name}</span>
                  <span className={`text-xs ${tag.usageCount === 0 ? 'text-stone-300' : 'text-stone-400'}`}>
                    {tag.usageCount} 道
                  </span>

                  <div className="ml-auto flex items-center gap-0.5">
                    {mergeFrom && mergeFrom !== tag.id ? (
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        onClick={() => void handleMergeInto(tag.id)}
                      >
                        并入这里
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-ghost px-1.5 text-xs"
                          onClick={() => {
                            setEditingId(tag.id)
                            setEditingName(tag.name)
                          }}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          className="btn-ghost px-1.5 text-xs"
                          onClick={() => setMergeFrom(tag.id)}
                          title="把这个标签合并到另一个标签"
                        >
                          合并
                        </button>
                        <button
                          type="button"
                          className="btn-ghost px-1.5 text-xs text-red-600"
                          onClick={() => void handleDelete(tag)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          )
        })}
        {current.length === 0 && <li className="px-3 py-6 text-center text-xs text-stone-400">该维度还没有标签</li>}
      </ul>

      {/* 新建 */}
      <div className="mt-3 flex gap-2">
        <input
          className="input flex-1"
          placeholder={`新建「${DIMENSION_LABEL[dimension]}」标签`}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate()
          }}
        />
        <button type="button" className="btn-secondary" onClick={() => void handleCreate()}>
          添加
        </button>
      </div>

      {unusedCount > 0 && (
        <p className="mt-3 text-center text-xs text-stone-400">
          共有 {unusedCount} 个标签没有任何菜谱在用（FR-2.14）
        </p>
      )}
    </div>
  )
}
