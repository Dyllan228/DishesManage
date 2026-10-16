/**
 * 回收站（FR-5.8）
 *
 * 删除不弹确认框，而是"删了还能捞回来"——这是更符合厨房场景的选择：
 * 手里正忙，弹一个"确定吗"只会让人烦。30 天足够发现误删。
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import DishImage from '@/components/DishImage'
import { useAsync } from '@/hooks/useAsync'
import {
  TRASH_RETENTION_DAYS,
  listDeletedRecipes,
  purgeExpiredTrash,
  purgeRecipe,
  restoreRecipe,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'

export default function TrashPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  const { data: deleted, loading, reload } = useAsync(() => listDeletedRecipes(), [], [])

  const restore = async (id: string, name: string) => {
    setBusyId(id)
    try {
      await restoreRecipe(id)
      showToast(`已恢复「${name}」`)
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  const destroy = async (id: string, name: string) => {
    setBusyId(id)
    try {
      await purgeRecipe(id)
      showToast(`「${name}」已彻底删除`)
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  const emptyAll = async () => {
    setConfirmEmpty(false)
    setBusyId('all')
    try {
      const n = deleted.length
      for (const r of deleted) await purgeRecipe(r.id)
      showToast(`已彻底删除 ${n} 道菜谱`)
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  const cleanupExpired = async () => {
    setBusyId('expired')
    try {
      const n = await purgeExpiredTrash()
      showToast(n > 0 ? `清理了 ${n} 道过期菜谱` : '没有超过保留期的菜谱')
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="px-4 pb-6 pt-4">
      <header className="mb-3 flex items-center gap-2">
        <Link to="/settings" className="btn-ghost px-2">
          ← 返回
        </Link>
        <h1 className="text-lg font-semibold">回收站</h1>
        <span className="ml-auto text-xs text-stone-400">{deleted.length} 道</span>
      </header>

      <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
        删除的菜谱会在回收站留 {TRASH_RETENTION_DAYS} 天，期间随时可以恢复。
        超过 {TRASH_RETENTION_DAYS} 天或手动「彻底删除」后就真的找不回来了。
      </p>

      {loading && deleted.length === 0 ? (
        <p className="py-16 text-center text-sm text-stone-400">加载中…</p>
      ) : deleted.length === 0 ? (
        <div className="py-16 text-center text-sm text-stone-400">
          <p className="text-3xl">🗑</p>
          <p className="mt-2">回收站是空的</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {deleted.map((r) => (
              <li key={r.id} className="card flex items-center gap-3 p-3">
                <DishImage blobId={r.coverBlobId} name={r.name} className="h-11 w-11 shrink-0 rounded-lg text-lg" />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-stone-700">{r.name}</h3>
                  <p className="text-xs text-stone-400">{deletedAgo(r.deletedAt)}删除</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary shrink-0 px-2.5 py-1.5 text-xs"
                  disabled={busyId !== null}
                  onClick={() => void restore(r.id, r.name)}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="btn-ghost shrink-0 px-2 py-1.5 text-xs text-red-600"
                  disabled={busyId !== null}
                  onClick={() => void destroy(r.id, r.name)}
                >
                  彻底删除
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn-ghost flex-1 text-xs"
              disabled={busyId !== null}
              onClick={() => void cleanupExpired()}
            >
              清理超过 {TRASH_RETENTION_DAYS} 天的
            </button>
            <button
              type="button"
              className="btn-ghost flex-1 text-xs text-red-600"
              disabled={busyId !== null}
              onClick={() => setConfirmEmpty(true)}
            >
              清空回收站
            </button>
          </div>
        </>
      )}

      {confirmEmpty && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/40 px-4 pb-6 sm:items-center sm:justify-center">
          <div className="w-full max-w-sm rounded-2xl bg-white p-4">
            <h2 className="text-base font-semibold">清空回收站？</h2>
            <p className="mt-1 text-sm text-stone-600">
              这 {deleted.length} 道菜谱会被永久删除，连图片一起清掉，无法恢复。
              如果想留个后路，建议先去「设置 → 备份与恢复」导出一份。
            </p>
            <div className="mt-4 flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setConfirmEmpty(false)}>
                取消
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white"
                onClick={() => void emptyAll()}
              >
                确定清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function deletedAgo(deletedAt: number | null): string {
  if (deletedAt === null) return ''
  const days = Math.floor((Date.now() - deletedAt) / (24 * 60 * 60 * 1000))
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}
