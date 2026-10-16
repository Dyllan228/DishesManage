/**
 * 备份的「格式层」（FR-5.1 ~ FR-5.4）
 *
 * repository 负责把数据从 IndexedDB 里搬出来（`dumpAll` / `restoreAll`），
 * 本模块只负责把那份数据变成人/Excel 能读的东西。分这么细是因为
 * 「怎么存」和「怎么序列化」是两个会各自变化的维度：
 * 以后接云端同步，dumpAll 换实现，这里一行都不用动。
 */

import {
  dumpAll,
  downloadBlob,
  markBackedUp,
  type BackupData,
} from './repository'
import { buildXlsx, type Sheet } from '@/domain/xlsx'
import type { MenuItemStatus, ShoppingCategory, StockStatus } from '@/types/models'

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function backupFilename(d = new Date()): string {
  return `家庭私厨-备份-${stamp(d)}.json`
}

export function excelFilename(d = new Date()): string {
  return `家庭私厨-菜谱-${stamp(d)}.xlsx`
}

// ---------------------------------------------------------------------------
// 中文标签映射（导出给人看的，不是给程序读的）
// ---------------------------------------------------------------------------

const MENU_STATUS_LABEL: Record<MenuItemStatus, string> = {
  todo: '待做',
  prepping: '备菜中',
  cooking: '制作中',
  done: '已完成',
}

const SHOP_CATEGORY_LABEL: Record<ShoppingCategory, string> = {
  meat: '肉禽蛋',
  veg: '蔬菜',
  staple: '主食',
  seasoning: '调料',
  other: '其他',
}

const STOCK_LABEL: Record<StockStatus, string> = {
  have: '家里有',
  need: '需要买',
  missing: '待确认',
}

const KIND_LABEL: Record<string, string> = {
  main: '主料',
  seasoning: '调料',
}

/** Difficulty 是 1 | 2 | 3 的数字枚举（见 types/models.ts） */
const DIFFICULTY_LABEL: Record<number, string> = {
  1: '简单',
  2: '中等',
  3: '有点难',
}

// ---------------------------------------------------------------------------
// JSON 导出（FR-5.1）
// ---------------------------------------------------------------------------

export interface ExportResult {
  filename: string
  bytes: number
  counts: Record<string, number>
}

/** 导出 JSON 备份。includeImages 见 FR-5.4 */
export async function exportJson(includeImages: boolean): Promise<ExportResult> {
  const data = await dumpAll(includeImages)
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const filename = backupFilename(new Date(data.exportedAt))
  await downloadBlob(blob, filename)
  // 下载动作发起了就记一次，别再天天弹提醒（FR-5.5）
  await markBackedUp(data.exportedAt)
  return { filename, bytes: blob.size, counts: data.counts }
}

// ---------------------------------------------------------------------------
// Excel 导出（FR-5.2）
// ---------------------------------------------------------------------------

/**
 * 为什么不导出成一个「大宽表」：菜谱是一对多的（一道菜 N 条食材 M 个步骤），
 * 一张表里必然要塞合并单元格或者分号拼接，导出去就没法再加工了。
 * 拆成多 Sheet + 用 id 关联，是唯一能让人拿去做二次整理的形式。
 */
export function buildExcelSheets(data: BackupData): Sheet[] {
  const { recipes, ingredients, steps, categories, tags, menuItems, shoppingItems, cookHistory, notes } = data.data

  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  const tagName = new Map(tags.map((t) => [t.id, t.name]))
  const recipeName = new Map(recipes.map((r) => [r.id, r.name]))

  const recipeRows: Sheet['rows'] = [
    ['ID', '菜名', '分类', '标签', '份量(人)', '耗时(分钟)', '难度', '收藏', '做过次数', '评分', '最近制作', '创建时间', '简介', '小贴士', '来源'],
  ]
  for (const r of recipes) {
    recipeRows.push([
      r.id,
      r.name,
      categoryName.get(r.categoryId) ?? '',
      r.tagIds.map((id) => tagName.get(id) ?? id).join('、'),
      r.servings,
      r.durationMin ?? '',
      DIFFICULTY_LABEL[r.difficulty] ?? r.difficulty,
      r.favorite ? '是' : '',
      r.cookCount,
      r.rating ?? '',
      r.lastCookedAt ? new Date(r.lastCookedAt).toLocaleString('zh-CN') : '',
      new Date(r.createdAt).toLocaleString('zh-CN'),
      r.intro ?? '',
      r.tips ?? '',
      r.sourceType,
    ])
  }

  const ingredientRows: Sheet['rows'] = [
    ['菜谱', '序号', '类型', '食材', '用量', '单位', '原文用量', '备注'],
  ]
  for (const ing of [...ingredients].sort((a, b) => a.recipeId.localeCompare(b.recipeId) || a.order - b.order)) {
    ingredientRows.push([
      recipeName.get(ing.recipeId) ?? ing.recipeId,
      ing.order + 1,
      KIND_LABEL[ing.kind] ?? ing.kind,
      ing.name,
      ing.amount ?? '',
      ing.unit ?? '',
      ing.amountText ?? '',
      ing.note ?? '',
    ])
  }

  const stepRows: Sheet['rows'] = [['菜谱', '步骤', '内容', '内置计时']]
  for (const st of [...steps].sort((a, b) => a.recipeId.localeCompare(b.recipeId) || a.order - b.order)) {
    stepRows.push([
      recipeName.get(st.recipeId) ?? st.recipeId,
      st.order + 1,
      st.text,
      st.timerSec ? `${st.timerLabel ?? '计时'} ${Math.round(st.timerSec / 60)} 分钟` : '',
    ])
  }

  // MenuItem 没有日期字段——菜单是「当前这一次要做的菜」，
  // 不是按天归档的历史（历史在「制作历史」Sheet 里），所以这里不导日期列。
  const menuRows: Sheet['rows'] = [['菜名', '倍率', '预计开始', '状态']]
  for (const m of menuItems) {
    menuRows.push([
      recipeName.get(m.recipeId) ?? m.recipeId,
      m.multiplier,
      m.plannedStartAt ?? '',
      MENU_STATUS_LABEL[m.status] ?? m.status,
    ])
  }

  const shoppingRows: Sheet['rows'] = [['日期', '分类', '食材', '用量', '单位', '原文用量', '状态', '家里有没', '手动添加']]
  for (const s of [...shoppingItems].sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category))) {
    shoppingRows.push([
      s.date,
      SHOP_CATEGORY_LABEL[s.category] ?? s.category,
      s.name,
      s.amount ?? '',
      s.unit ?? '',
      s.amountText ?? '',
      s.checked ? '已备好' : '未备好',
      STOCK_LABEL[s.stockStatus] ?? s.stockStatus,
      s.isManual ? '是' : '',
    ])
  }

  const historyRows: Sheet['rows'] = [['日期', '菜名', '份量(人)', '评分', '备注']]
  for (const h of [...cookHistory].sort((a, b) => b.date.localeCompare(a.date))) {
    historyRows.push([h.date, recipeName.get(h.recipeId) ?? h.recipeId, h.servings, h.rating ?? '', h.note ?? ''])
  }

  const noteRows: Sheet['rows'] = [['日期', '菜名', '笔记']]
  for (const n of [...notes].sort((a, b) => (b.cookedOn ?? '').localeCompare(a.cookedOn ?? ''))) {
    noteRows.push([n.cookedOn ?? '', recipeName.get(n.recipeId) ?? n.recipeId, n.text])
  }

  const tagRows: Sheet['rows'] = [['标签', '维度', '使用次数']]
  for (const t of [...tags].sort((a, b) => a.dimension.localeCompare(b.dimension) || b.usageCount - a.usageCount)) {
    tagRows.push([t.name, t.dimension, t.usageCount])
  }

  // 空 Sheet 也留着——用户拿到文件能一眼看出"这类数据我还没记过"，
  // 比 Sheet 突然消失更容易理解。
  return [
    { name: '菜谱', rows: recipeRows },
    { name: '食材明细', rows: ingredientRows },
    { name: '步骤', rows: stepRows },
    { name: '分类', rows: [['分类', '上级分类', '菜谱数'], ...buildCategoryRows(data)] },
    { name: '标签', rows: tagRows },
    { name: '点菜记录', rows: menuRows },
    { name: '备菜清单', rows: shoppingRows },
    { name: '制作历史', rows: historyRows },
    { name: '笔记', rows: noteRows },
  ]
}

function buildCategoryRows(data: BackupData): Sheet['rows'] {
  const { categories, recipes } = data.data
  const byId = new Map(categories.map((c) => [c.id, c]))
  // 直接挂在本分类下的菜谱数（不含子分类），和 UI 上的口径保持一致
  const direct = new Map<string, number>()
  for (const r of recipes) {
    if (r.deletedAt !== null) continue
    direct.set(r.categoryId, (direct.get(r.categoryId) ?? 0) + 1)
  }
  return categories.map((c) => [c.name, c.parentId ? byId.get(c.parentId)?.name ?? '' : '', direct.get(c.id) ?? 0])
}

/** 导出 Excel（FR-5.2） */
export async function exportExcel(): Promise<ExportResult> {
  const data = await dumpAll(false)
  const blob = buildXlsx(buildExcelSheets(data))
  const filename = excelFilename(new Date(data.exportedAt))
  await downloadBlob(blob, filename)
  await markBackedUp(data.exportedAt)
  return { filename, bytes: blob.size, counts: data.counts }
}

// ---------------------------------------------------------------------------
// 只导菜谱（快捷方式：给家人分享用，不带任何设置/历史）
// ---------------------------------------------------------------------------

export async function exportRecipesOnly(): Promise<ExportResult> {
  const data = await dumpAll(false)
  const recipeIds = new Set(data.data.recipes.map((r) => r.id))
  const trimmed: BackupData = {
    ...data,
    data: {
      ...data.data,
      ingredients: data.data.ingredients.filter((i) => recipeIds.has(i.recipeId)),
      steps: data.data.steps.filter((s) => recipeIds.has(s.recipeId)),
      notes: data.data.notes.filter((n) => recipeIds.has(n.recipeId)),
      menuItems: [],
      shoppingItems: [],
      cookHistory: [],
      settings: [],
    },
    images: [],
  }
  const blob = new Blob([JSON.stringify(trimmed, null, 2)], { type: 'application/json;charset=utf-8' })
  const filename = `家庭私厨-菜谱-${stamp()}.json`
  await downloadBlob(blob, filename)
  // counts 得按裁剪后的数据重算，否则提示里会报出"导出 50 道菜"而实际只有 12 道
  return {
    filename,
    bytes: blob.size,
    counts: {
      ...data.counts,
      ingredients: trimmed.data.ingredients.length,
      steps: trimmed.data.steps.length,
      menuItems: 0,
      cookHistory: 0,
      images: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// 读取本地文件（给导入页用）
// ---------------------------------------------------------------------------

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024

export async function readBackupFile(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error('文件超过 200MB，请确认选对了文件')
  }
  const text = await file.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON，可能不是备份文件或已损坏')
  }
}
