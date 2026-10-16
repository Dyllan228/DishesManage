import { Link } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import { getStats, listCategories, listDictItems, listTags } from '@/data/repository'
import { DIMENSION_LABEL, DIMENSION_ORDER } from '@/data/seed'
import type { IngredientDict, Tag } from '@/types/models'
import { flattenCategories } from '@/utils/tree'

export default function SettingsPage() {
  const { data: stats } = useAsync(() => getStats(), [], { recipeCount: 0, categoryCount: 0, tagCount: 0 })
  const { data: categories } = useAsync(() => listCategories(), [], [])
  const { data: tags } = useAsync<Tag[]>(() => listTags(), [], [])
  const { data: dict } = useAsync<IngredientDict[]>(() => listDictItems(), [], [])

  const flat = flattenCategories(categories)

  return (
    <div className="px-4 pb-28 pt-4">
      <h1 className="mb-4 text-xl font-semibold">我的</h1>

      {/* 统计 */}
      <section className="card mb-4 grid grid-cols-3 divide-x divide-stone-100 p-3 text-center">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{stats.recipeCount}</p>
          <p className="text-xs text-stone-500">菜谱</p>
        </div>
        <div>
          <p className="text-2xl font-semibold tabular-nums">{stats.categoryCount}</p>
          <p className="text-xs text-stone-500">分类</p>
        </div>
        <div>
          <p className="text-2xl font-semibold tabular-nums">{stats.tagCount}</p>
          <p className="text-xs text-stone-500">标签</p>
        </div>
      </section>

      {/* 分类树 */}
      <section className="mb-4">
        <div className="mb-1.5 flex items-center px-1">
          <h2 className="text-xs font-semibold text-stone-500">分类树</h2>
          <Link to="/settings/categories" className="ml-auto text-xs text-brand-600">
            管理 ›
          </Link>
        </div>
        <ul className="card divide-y divide-stone-100 text-sm">
          {flat.map(({ category, depth }) => (
            <li key={category.id} className="flex items-center px-3 py-2">
              <span style={{ paddingLeft: `${depth * 14}px` }} className="text-stone-700">
                {depth > 0 && <span className="mr-1 text-stone-300">└</span>}
                {category.icon && <span className="mr-1">{category.icon}</span>}
                {category.name}
              </span>
              {category.isSystem && <span className="ml-2 text-[10px] text-stone-400">系统保留</span>}
            </li>
          ))}
        </ul>
      </section>

      {/* 标签（按维度） */}
      <section className="mb-4">
        <div className="mb-1.5 flex items-center px-1">
          <h2 className="text-xs font-semibold text-stone-500">标签维度</h2>
          <Link to="/settings/tags" className="ml-auto text-xs text-brand-600">
            管理 ›
          </Link>
        </div>
        <div className="card space-y-2 p-3">
          {DIMENSION_ORDER.map((dim) => {
            const list = tags.filter((t) => t.dimension === dim)
            if (list.length === 0) return null
            return (
              <div key={dim}>
                <p className="mb-1 text-[11px] text-stone-400">{DIMENSION_LABEL[dim]}</p>
                <div className="flex flex-wrap gap-1">
                  {list.map((t) => (
                    <span key={t.id} className="chip bg-stone-100 text-stone-600">
                      {t.name}
                      {t.usageCount > 0 && <span className="text-stone-400">{t.usageCount}</span>}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* 大模型 */}
      <section className="mb-4">
        <h2 className="mb-1.5 px-1 text-xs font-semibold text-stone-500">粘贴解析</h2>
        <Link to="/settings/llm" className="card flex items-center px-3 py-2.5 text-sm">
          <span>大模型兜底配置</span>
          <span className="ml-2 text-xs text-stone-400">可选，不配也能用</span>
          <span className="ml-auto text-stone-300">›</span>
        </Link>
      </section>

      {/* 食材字典 */}
      <section className="mb-4">
        <h2 className="mb-1.5 px-1 text-xs font-semibold text-stone-500">食材标准库</h2>
        <div className="card p-3">
          <p className="text-sm text-stone-700">已内置 {dict.length} 种常见食材及别名</p>
          <p className="mt-1 text-xs text-stone-400">
            备菜清单靠它把「生抽 / 酱油 / 豉油」识别成同一样东西，从而正确合并累加。
          </p>
        </div>
      </section>

      {/* 备份与回收站 */}
      <section className="mb-4">
        <h2 className="mb-1.5 px-1 text-xs font-semibold text-stone-500">数据</h2>
        <div className="card divide-y divide-stone-100">
          <Link to="/history" className="flex items-center px-3 py-2.5 text-sm">
            <span>制作历史</span>
            <span className="ml-2 text-xs text-stone-400">做过的菜、评分与感受</span>
            <span className="ml-auto text-stone-300">›</span>
          </Link>
          <Link to="/settings/backup" className="flex items-center px-3 py-2.5 text-sm">
            <span>备份与恢复</span>
            <span className="ml-2 text-xs text-stone-400">导出 / 导入 / 存储占用</span>
            <span className="ml-auto text-stone-300">›</span>
          </Link>
          <Link to="/settings/trash" className="flex items-center px-3 py-2.5 text-sm">
            <span>回收站</span>
            <span className="ml-2 text-xs text-stone-400">删除的菜谱保留 30 天</span>
            <span className="ml-auto text-stone-300">›</span>
          </Link>
        </div>
      </section>

      {/* 关于 */}
      <section className="card p-3 text-xs text-stone-500">
        <p className="font-medium text-stone-700">家庭私厨 · v0.1.0</p>
        <p className="mt-1">纯本地运行，数据存在你的浏览器里，不上传任何服务器。</p>
        <p className="mt-1">
          当前进度：M1 地基 + M3 点菜闭环 + M2 分类与标签管理 + M4 粘贴智能解析 + M5 图片与备份 +
          M6 制作模式与计时器。<span className="text-stone-700">六个里程碑全部完成。</span>
        </p>
      </section>
    </div>
  )
}
