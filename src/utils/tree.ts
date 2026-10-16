import type { Category, ID } from '@/types/models'

export interface FlatCategory {
  category: Category
  depth: number
}

/** 把分类树压平成带缩进层级的列表，便于渲染 <select> 与列表 */
export function flattenCategories(categories: Category[], rootId: ID | null = null, depth = 0): FlatCategory[] {
  const out: FlatCategory[] = []
  const children = categories
    .filter((c) => c.parentId === rootId)
    .sort((a, b) => a.order - b.order)
  for (const c of children) {
    out.push({ category: c, depth })
    out.push(...flattenCategories(categories, c.id, depth + 1))
  }
  return out
}

/** 该分类的所有祖先（含自身）id，用于面包屑 */
export function categoryPath(categories: Category[], id: ID): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const path: Category[] = []
  let cur = byId.get(id)
  let guard = 0
  while (cur && guard < 20) {
    path.unshift(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
    guard += 1
  }
  return path
}

export function categoryLabel(categories: Category[], id: ID): string {
  const path = categoryPath(categories, id)
  return path.map((c) => c.name).join(' › ') || '未分类'
}
