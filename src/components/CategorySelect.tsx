import { useAsync } from '@/hooks/useAsync'
import { listCategories } from '@/data/repository'
import type { Category, ID } from '@/types/models'
import { flattenCategories } from '@/utils/tree'

interface Props {
  value: ID
  onChange: (id: ID) => void
  categories?: Category[]
  className?: string
}

/** 分类下拉选择（用缩进表达层级） */
export default function CategorySelect({ value, onChange, categories: provided, className }: Props) {
  const { data: loaded } = useAsync<Category[]>(() => listCategories(), [], [])
  const categories = provided ?? loaded
  const flat = flattenCategories(categories)

  return (
    <select className={className ?? 'input'} value={value} onChange={(e) => onChange(e.target.value)}>
      {flat.map(({ category, depth }) => (
        <option key={category.id} value={category.id}>
          {`${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${category.icon ? category.icon + ' ' : ''}${category.name}`}
        </option>
      ))}
    </select>
  )
}
