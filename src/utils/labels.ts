import type { Difficulty, MenuItemStatus, StockStatus } from '@/types/models'

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  1: '简单',
  2: '中等',
  3: '较难',
}

export const STATUS_LABEL: Record<MenuItemStatus, string> = {
  todo: '待做',
  prepping: '备菜中',
  cooking: '制作中',
  done: '已完成',
}

export const STATUS_ORDER: MenuItemStatus[] = ['todo', 'prepping', 'cooking', 'done']

export const STOCK_LABEL: Record<StockStatus, string> = {
  have: '已有',
  need: '待买',
  missing: '缺',
}

/** 耗时人性化：90 → 1 小时 30 分 */
export function formatDuration(min: number | null): string {
  if (min === null || min <= 0) return '—'
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}
