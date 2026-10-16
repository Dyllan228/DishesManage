import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import {
  addManualShoppingItem,
  buildShoppingText,
  deleteShoppingItem,
  rebuildShoppingList,
  setAllChecked,
  setStockStatus,
  todayKey,
  toggleShoppingChecked,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import type { ShoppingCategory, ShoppingItem, StockStatus } from '@/types/models'
import { CATEGORY_LABEL } from '@/domain/shoppingList'
import { formatAmount } from '@/domain/scale'
import { STOCK_LABEL } from '@/utils/labels'

const CATEGORY_ORDER: ShoppingCategory[] = ['meat', 'veg', 'staple', 'seasoning', 'other']

export default function ShoppingPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [params] = useSearchParams()
  const date = todayKey()

  const [onlyTodo, setOnlyTodo] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualCategory, setManualCategory] = useState<ShoppingCategory>('other')

  // 每次进入都重算：清单由今日菜单派生，但勾选状态会被保留
  const { data: items, loading, reload } = useAsync<ShoppingItem[]>(() => rebuildShoppingList(date), [date], [])

  const visible = useMemo(
    () => (onlyTodo ? items.filter((i) => i.stockStatus !== 'have') : items),
    [items, onlyTodo],
  )

  const groups = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      label: CATEGORY_LABEL[cat],
      items: visible.filter((i) => i.category === cat),
    })).filter((g) => g.items.length > 0)
  }, [visible])

  const stats = useMemo(() => {
    const total = items.length
    const done = items.filter((i) => i.checked).length
    const toBuy = items.filter((i) => i.stockStatus === 'need').length
    return { total, done, toBuy }
  }, [items])

  const handleCopy = async () => {
    const mode = onlyTodo ? '采购清单' : '备菜清单'
    const text = await buildShoppingText(date)
    try {
      await navigator.clipboard.writeText(onlyTodo ? text.replace('备菜清单', mode) : text)
      showToast('已复制到剪贴板')
    } catch {
      showToast('复制失败，请手动选择文本')
    }
  }

  const handleShowText = async () => {
    const text = await buildShoppingText(date)
    window.prompt('清单文本（可手动复制）', text)
  }

  const handleAddManual = async () => {
    const name = manualName.trim()
    if (!name) return
    await addManualShoppingItem(name, manualCategory, date)
    setManualName('')
    await reload()
    showToast(`已添加「${name}」`)
  }

  return (
    <div className="px-4 pb-28 pt-4">
      <header className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-semibold">备菜清单</h1>
        <button type="button" className="btn-ghost text-xs" onClick={() => void reload()}>
          ↻ 重算
        </button>
      </header>
      <p className="mb-3 text-xs text-stone-400">
        {date} · 共 {stats.total} 项，已备 {stats.done} 项，待买 {stats.toBuy} 项
      </p>

      {params.get('rebuild') === '1' && (
        <p className="mb-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
          已按今日菜单重新生成，同名食材已合并累加
        </p>
      )}

      {/* 工具条 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOnlyTodo((v) => !v)}
          className={`chip border ${
            onlyTodo ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'
          }`}
        >
          🛍 只看待买
        </button>
        <button
          type="button"
          className="chip border border-stone-200 bg-white text-stone-600"
          onClick={async () => {
            await setAllChecked(date, stats.done < stats.total)
            await reload()
          }}
        >
          {stats.done < stats.total ? '全部勾选' : '全部取消'}
        </button>
        <button type="button" className="chip border border-stone-200 bg-white text-stone-600" onClick={() => void handleCopy()}>
          📋 复制清单
        </button>
        <button type="button" className="chip border border-stone-200 bg-white text-stone-600" onClick={() => void handleShowText()}>
          👁 查看文本
        </button>
      </div>

      {loading && items.length === 0 ? (
        <p className="py-16 text-center text-sm text-stone-400">加载中…</p>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-4xl">🧺</p>
          <p className="mt-3 text-sm text-stone-500">备菜清单是空的</p>
          <p className="mt-1 text-xs text-stone-400">先去「点菜」里加几道菜，这里会自动汇总食材</p>
          <Link to="/menu" className="btn-primary mt-5">
            去点菜
          </Link>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.category} className="mb-4">
              <h2 className="mb-1.5 px-1 text-xs font-semibold text-stone-500">
                {g.label} <span className="font-normal text-stone-400">（{g.items.length}）</span>
              </h2>
              <ul className="card divide-y divide-stone-100">
                {g.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-brand-600"
                      checked={item.checked}
                      onChange={async () => {
                        await toggleShoppingChecked(item.id)
                        await reload()
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${item.checked ? 'text-stone-400 line-through' : ''}`}>
                        {item.name}
                        {item.isManual && <span className="ml-1 text-[10px] text-stone-400">手动</span>}
                      </div>
                      {item.sourceRecipeIds.length > 1 && (
                        <div className="text-[11px] text-stone-400">来自 {item.sourceRecipeIds.length} 道菜</div>
                      )}
                    </div>
                    <span className="shrink-0 text-sm tabular-nums text-stone-600">
                      {formatAmount(item.amount, item.unit, item.amountText)}
                    </span>
                    <select
                      className="input w-auto shrink-0 py-1 text-[11px]"
                      value={item.stockStatus}
                      onChange={async (e) => {
                        await setStockStatus(item.id, e.target.value as StockStatus)
                        await reload()
                      }}
                    >
                      {(['have', 'need', 'missing'] as StockStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {STOCK_LABEL[s]}
                        </option>
                      ))}
                    </select>
                    {item.isManual && (
                      <button
                        type="button"
                        className="btn-ghost shrink-0 px-1 text-stone-400"
                        onClick={async () => {
                          await deleteShoppingItem(item.id)
                          await reload()
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* 手动追加（FR-3.19） */}
          <section className="mt-4">
            <h2 className="mb-1.5 px-1 text-xs font-semibold text-stone-500">临时加一项</h2>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="如：厨房纸"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddManual()
                }}
              />
              <select
                className="input w-auto shrink-0"
                value={manualCategory}
                onChange={(e) => setManualCategory(e.target.value as ShoppingCategory)}
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary shrink-0" onClick={() => void handleAddManual()}>
                添加
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
