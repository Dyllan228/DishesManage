import { Link, useNavigate } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import {
  clearMenu,
  listMenu,
  removeFromMenu,
  setMenuMultiplier,
  setMenuStatus,
  type MenuEntry,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import { estimateTotalMinutes } from '@/domain/scale'
import { STATUS_LABEL, STATUS_ORDER, formatDuration } from '@/utils/labels'

export default function MenuPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const setMenuCount = useAppStore((s) => s.setMenuCount)

  const { data: menu, loading, reload } = useAsync<MenuEntry[]>(() => listMenu(), [], [])

  const totalMinutes = estimateTotalMinutes(menu.map((m) => m.recipe.durationMin))
  const totalServings = menu.reduce((s, m) => s + m.recipe.servings * m.item.multiplier, 0)

  const sync = async () => {
    await reload()
    setMenuCount((await listMenu()).length)
  }

  const goShopping = async () => {
    if (menu.length === 0) return
    navigate('/shopping?rebuild=1')
  }

  return (
    <div className="px-4 pb-40 pt-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold">今日菜单</h1>
        <div className="flex items-center gap-1">
          {menu.length > 0 && (
            <Link to="/menu/timeline" className="btn-ghost text-xs">
              🕒 时间线
            </Link>
          )}
          {menu.length > 0 && (
            <button
              type="button"
              className="btn-ghost text-xs text-red-600"
              onClick={async () => {
                await clearMenu()
                await sync()
                showToast('已清空菜单')
              }}
            >
              清空
            </button>
          )}
        </div>
      </header>

      {loading && menu.length === 0 ? (
        <p className="py-16 text-center text-sm text-stone-400">加载中…</p>
      ) : menu.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-4xl">🛒</p>
          <p className="mt-3 text-sm text-stone-500">还没点菜</p>
          <p className="mt-1 text-xs text-stone-400">去菜谱里挑几道，像点外卖一样加进来</p>
          <Link to="/recipes" className="btn-primary mt-5">
            去挑菜
          </Link>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {menu.map(({ item, recipe }) => (
              <li key={item.id} className="card p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Link to={`/recipes/${recipe.id}`} className="font-medium hover:underline">
                      {recipe.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-stone-500">
                      {formatDuration(recipe.durationMin)} · 基准 {recipe.servings} 人份
                      {item.multiplier !== 1 && ` · ${item.multiplier}×`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost shrink-0 px-2 text-stone-400"
                    onClick={async () => {
                      await removeFromMenu(item.id)
                      await sync()
                    }}
                    title="移除"
                  >
                    ✕
                  </button>
                </div>

                {/* 份量增减（对应外卖的加减号，FR-3.2 / FR-3.3） */}
                <div className="mt-2 flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-secondary h-7 w-7 p-0 text-sm"
                      disabled={item.multiplier <= 0.5}
                      onClick={async () => {
                        await setMenuMultiplier(item.id, item.multiplier - 0.5)
                        await sync()
                      }}
                    >
                      −
                    </button>
                    <span className="w-10 text-center text-sm tabular-nums">{item.multiplier}×</span>
                    <button
                      type="button"
                      className="btn-secondary h-7 w-7 p-0 text-sm"
                      disabled={item.multiplier >= 5}
                      onClick={async () => {
                        await setMenuMultiplier(item.id, item.multiplier + 0.5)
                        await sync()
                      }}
                    >
                      ＋
                    </button>
                  </div>

                  <Link to={`/menu/cook/${item.id}`} className="btn-secondary ml-auto py-1 text-xs">
                    开始做菜
                  </Link>

                  <select
                    className="input w-auto py-1 text-xs"
                    value={item.status}
                    onChange={async (e) => {
                      await setMenuStatus(item.id, e.target.value as (typeof STATUS_ORDER)[number])
                      await sync()
                    }}
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-center text-xs text-stone-400">
            已点 {menu.length} 道菜 · 约 {totalServings.toFixed(1).replace(/\.0$/, '')} 人份 · 预计耗时{' '}
            {formatDuration(totalMinutes)}
          </p>
        </>
      )}

      {/* 底部结算条（FR-3.5，对应外卖的购物车结算） */}
      {menu.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 px-4">
          <div className="mx-auto max-w-3xl">
            <button type="button" className="btn-primary w-full shadow-lg" onClick={() => void goShopping()}>
              生成备菜清单（{menu.length} 道菜）
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
