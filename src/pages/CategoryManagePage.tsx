import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import {
  categoryCounts,
  createCategory,
  deleteCategory,
  listCategories,
  moveCategory,
  renameCategory,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import type { Category, ID } from '@/types/models'
import { flattenCategories } from '@/utils/tree'

export default function CategoryManagePage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)

  const { data: categories, reload } = useAsync<Category[]>(() => listCategories(), [], [])
  const { data: counts, reload: reloadCounts } = useAsync(() => categoryCounts(), [], new Map<ID, number>())

  const [editingId, setEditingId] = useState<ID | null>(null)
  const [editingName, setEditingName] = useState('')
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState<ID | null>(null)

  const flat = flattenCategories(categories)

  const refreshAll = async () => {
    await reload()
    await reloadCounts()
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    await createCategory(name, newParentId)
    setNewName('')
    await refreshAll()
    showToast(`已新建分类「${name}」`)
  }

  const handleRename = async (id: ID) => {
    const name = editingName.trim()
    if (!name) return
    await renameCategory(id, name)
    setEditingId(null)
    await refreshAll()
    showToast('已重命名')
  }

  const handleDelete = async (cat: Category) => {
    if (cat.isSystem) return
    const count = counts.get(cat.id) ?? 0
    const kids = categories.filter((c) => c.parentId === cat.id)
    const msg =
      kids.length > 0 || count > 0
        ? `删除「${cat.name}」？\n\n其下 ${kids.length} 个子分类和 ${count} 道菜谱会回到上级分类，不会被删除。`
        : `删除分类「${cat.name}」？`
    if (!window.confirm(msg)) return
    await deleteCategory(cat.id)
    await refreshAll()
    showToast('已删除，内容已移到上级')
  }

  const handleMove = async (id: ID, parentId: ID | null) => {
    await moveCategory(id, parentId)
    await refreshAll()
    showToast('已移动')
  }

  return (
    <div className="px-4 pb-28 pt-4">
      <header className="mb-4 flex items-center gap-2">
        <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="text-lg font-semibold">分类管理</h1>
      </header>

      <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
        分类决定菜谱**展示在哪个位置**，每道菜只能归一个分类。跨类的属性（菜系、辣度、场景）
        请用标签表达，别塞进分类树。
      </p>

      {/* 新建 */}
      <section className="card mb-4 p-3">
        <h2 className="mb-2 text-sm font-medium">新建分类</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className="input flex-1"
            placeholder="分类名，如「粤式小炒」"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
            }}
          />
          <select
            className="input w-auto shrink-0"
            value={newParentId ?? '__root__'}
            onChange={(e) => setNewParentId(e.target.value === '__root__' ? null : e.target.value)}
          >
            <option value="__root__">作为顶级分类</option>
            {flat.map(({ category, depth }) => (
              <option key={category.id} value={category.id}>
                {`${'　'.repeat(depth + 1)}放入「${category.name}」下`}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary shrink-0" onClick={() => void handleCreate()}>
            创建
          </button>
        </div>
      </section>

      {/* 分类树 */}
      <ul className="card divide-y divide-stone-100">
        {flat.map(({ category, depth }) => {
          const isEditing = editingId === category.id
          const count = counts.get(category.id) ?? 0
          return (
            <li key={category.id} className="px-3 py-2" style={{ paddingLeft: `${12 + depth * 18}px` }}>
              <div className="flex items-center gap-2">
                {depth > 0 && <span className="text-stone-300">└</span>}

                {isEditing ? (
                  <>
                    <input
                      className="input flex-1 py-1"
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(category.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void handleRename(category.id)}>
                      确定
                    </button>
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-sm">
                      {category.icon && <span className="mr-1">{category.icon}</span>}
                      {category.name}
                    </span>
                    {count > 0 && <span className="text-xs text-stone-400">{count} 道</span>}
                    {category.isSystem && (
                      <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">系统保留</span>
                    )}

                    <div className="ml-auto flex items-center gap-0.5">
                      <select
                        className="input w-auto py-1 text-[11px]"
                        value={category.parentId ?? '__root__'}
                        onChange={(e) => void handleMove(category.id, e.target.value === '__root__' ? null : e.target.value)}
                        title="移动到"
                      >
                        <option value="__root__">顶级</option>
                        {flat
                          .filter(({ category: c }) => c.id !== category.id)
                          .map(({ category: c, depth: d }) => (
                            <option key={c.id} value={c.id}>
                              {`${'　'.repeat(d + 1)}→ ${c.name}`}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        className="btn-ghost px-1.5 text-xs"
                        onClick={() => {
                          setEditingId(category.id)
                          setEditingName(category.name)
                        }}
                      >
                        改名
                      </button>
                      {!category.isSystem && (
                        <button
                          type="button"
                          className="btn-ghost px-1.5 text-xs text-red-600"
                          onClick={() => void handleDelete(category)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
