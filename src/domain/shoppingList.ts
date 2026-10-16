/**
 * 备菜清单合并去重（FR-3.10 ~ FR-3.13）
 *
 * 这是本产品不可替代的价值所在：点 3 道菜 → 自动汇总所有食材、同名累加、
 * 按类别分组。设计要点：
 *
 * 1. **先按各自份量缩放，再跨菜累加，最后统一取整**（Q1）。
 *    鸡蛋 1 个 ×1.5 = 1.5，加上另一道菜的 2 个 = 3.5 → 采购取整 4 个。
 *    若先取整再累加会得到 2+2=4，看似一样，但多菜时误差会累积。
 * 2. **单位不可换算时宁可不合并**（R2）：番茄「2 个」与「200g」分成两行相邻展示，
 *    并标记 unmerged 让 UI 提示用户注意，绝不误合并成「202」。
 * 3. **「适量/少许」不参与累加**，与数值型同桶时单独标记。
 */

import type { Ingredient, ShoppingCategory, ID } from '@/types/models'
import { convert, getUnit, isConvertible, needsCeil } from './units'
import { normalizeIngredient, type DictIndex } from './normalize'

export interface MergeInput {
  recipeId: ID
  recipeName: string
  /** 份量倍率 */
  multiplier: number
  ingredients: Ingredient[]
}

export interface MergedShopItem {
  /** 合并桶键：同键的行在 UI 中相邻展示 */
  groupKey: string
  name: string
  normalizedId: ID | null
  category: ShoppingCategory
  amount: number | null
  unit: string | null
  amountText: string | null
  /** 可直接渲染的用量文本 */
  display: string
  /** 是否因不可分割单位被向上取整（Q1） */
  roundedUp: boolean
  /** 取整前的精算值 */
  preciseAmount: number | null
  /** 因单位不可换算而单独成行（R2：宁可不合并也不误合并） */
  unmerged: boolean
  /** 同一食材还有「适量」类条目未计入本行 */
  hasImpreciseSibling: boolean
  /** 来源菜谱，用于追溯（FR-3.18） */
  sourceRecipeIds: ID[]
  sourceRecipeNames: string[]
  /** 是否命中内置食材字典 */
  matched: boolean
}

/** 清单分组顺序（FR-3.13） */
export const CATEGORY_ORDER: ShoppingCategory[] = ['meat', 'veg', 'staple', 'seasoning', 'other']

export const CATEGORY_LABEL: Record<ShoppingCategory, string> = {
  meat: '肉蛋水产',
  veg: '蔬菜',
  staple: '主食干货',
  seasoning: '调料',
  other: '其他',
}

interface Entry {
  recipeId: ID
  recipeName: string
  name: string
  /** 缩放后的精算用量（未取整） */
  amount: number | null
  unit: string | null
  amountText: string | null
}

const AMOUNT_EPSILON = 1e-9

/**
 * 合并多道菜的食材 → 备菜清单
 */
export function buildShoppingItems(inputs: MergeInput[], index: DictIndex): MergedShopItem[] {
  // ---- 1. 展开所有食材行，按各自份量缩放 ----
  const buckets = new Map<string, Entry[]>()

  for (const input of inputs) {
    for (const ing of input.ingredients) {
      const norm = normalizeIngredient(ing.name, index)
      const entry: Entry = {
        recipeId: input.recipeId,
        recipeName: input.recipeName,
        name: norm.displayName,
        amount: ing.amount === null ? null : ing.amount * input.multiplier,
        unit: ing.unit,
        amountText: ing.amountText,
      }
      const list = buckets.get(norm.mergeKey)
      if (list) list.push(entry)
      else buckets.set(norm.mergeKey, [entry])
    }
  }

  // ---- 2. 逐桶合并 ----
  const result: MergedShopItem[] = []

  for (const [groupKey, entries] of buckets) {
    const sample = normalizeIngredient(entries[0].name, index)
    const normalizedId = sample.dict?.id ?? null
    const category: ShoppingCategory = sample.dict?.category ?? 'other'
    const sourceRecipeIds = [...new Set(entries.map((e) => e.recipeId))]
    const sourceRecipeNames = [...new Set(entries.map((e) => e.recipeName))]

    const quantified = entries.filter((e) => e.amount !== null)
    const imprecise = entries.filter((e) => e.amount === null)
    const hasImpreciseSibling = imprecise.length > 0

    // 2a. 全部是不可量化（「适量」「少许」）
    if (quantified.length === 0) {
      const text = imprecise[0].amountText ?? (imprecise[0].unit ? getUnit(imprecise[0].unit)?.label ?? null : null)
      result.push({
        groupKey,
        name: entries[0].name,
        normalizedId,
        category,
        amount: null,
        unit: null,
        amountText: text,
        display: text ?? '',
        roundedUp: false,
        preciseAmount: null,
        unmerged: false,
        hasImpreciseSibling: false,
        sourceRecipeIds,
        sourceRecipeNames,
        matched: sample.matched,
      })
      continue
    }

    // 2b. 按单位分组，能换算的合并
    const byUnit = new Map<string, Entry[]>()
    for (const e of quantified) {
      const key = e.unit ?? '__nounit__'
      const list = byUnit.get(key)
      if (list) list.push(e)
      else byUnit.set(key, [e])
    }

    const unitKeys = [...byUnit.keys()]
    // 主单位 = 出现次数最多的（并列时取先出现的）
    let primaryUnit = unitKeys[0]
    for (const k of unitKeys) {
      if (byUnit.get(k)!.length > byUnit.get(primaryUnit)!.length) primaryUnit = k
    }

    // 汇总到主单位
    const primaryEntries: Entry[] = []
    const leftover: Array<{ unit: string | null; total: number; entries: Entry[] }> = []

    for (const unitKey of unitKeys) {
      const group = byUnit.get(unitKey)!
      const unit = unitKey === '__nounit__' ? null : unitKey
      if (unitKey === primaryUnit) {
        primaryEntries.push(...group)
        continue
      }
      const convertible =
        primaryUnit !== '__nounit__' && isConvertible(unit, primaryUnit === '__nounit__' ? null : primaryUnit)
      if (convertible && unit && primaryUnit !== '__nounit__') {
        for (const e of group) {
          const converted = convert(e.amount!, unit, primaryUnit)
          primaryEntries.push(converted === null ? e : { ...e, amount: converted, unit: primaryUnit })
        }
      } else {
        // 不可换算：单独成行（R2 —— 宁可不合并，也不误合并）
        leftover.push({
          unit,
          total: group.reduce((s, e) => s + (e.amount ?? 0), 0),
          entries: group,
        })
      }
    }

    // 主行
    const primaryAmount = primaryEntries.reduce((s, e) => s + (e.amount ?? 0), 0)
    const primaryUnitKey = primaryUnit === '__nounit__' ? null : primaryUnit
    result.push(
      makeItem({
        groupKey,
        name: entries[0].name,
        normalizedId,
        category,
        amount: primaryAmount,
        unit: primaryUnitKey,
        amountText: null,
        unmerged: leftover.length > 0,
        hasImpreciseSibling,
        sourceRecipeIds,
        sourceRecipeNames,
        matched: sample.matched,
      }),
    )

    // 不可换算的散行
    for (const lo of leftover) {
      result.push(
        makeItem({
          groupKey,
          name: entries[0].name,
          normalizedId,
          category,
          amount: lo.total,
          unit: lo.unit,
          amountText: null,
          unmerged: true,
          hasImpreciseSibling: false,
          sourceRecipeIds: [...new Set(lo.entries.map((e) => e.recipeId))],
          sourceRecipeNames: [...new Set(lo.entries.map((e) => e.recipeName))],
          matched: sample.matched,
        }),
      )
    }

    // 同桶里的「适量」条目单独成行
    if (hasImpreciseSibling) {
      const text = imprecise[0].amountText ?? (imprecise[0].unit ? getUnit(imprecise[0].unit)?.label ?? null : null)
      if (text) {
        result.push(
          makeItem({
            groupKey,
            name: entries[0].name,
            normalizedId,
            category,
            amount: null,
            unit: null,
            amountText: text,
            unmerged: true,
            hasImpreciseSibling: false,
            sourceRecipeIds: [...new Set(imprecise.map((e) => e.recipeId))],
            sourceRecipeNames: [...new Set(imprecise.map((e) => e.recipeName))],
            matched: sample.matched,
          }),
        )
      }
    }
  }

  return sortItems(result)
}

function makeItem(args: {
  groupKey: string
  name: string
  normalizedId: ID | null
  category: ShoppingCategory
  amount: number | null
  unit: string | null
  amountText: string | null
  unmerged: boolean
  hasImpreciseSibling: boolean
  sourceRecipeIds: ID[]
  sourceRecipeNames: string[]
  matched: boolean
}): MergedShopItem {
  const { amount, unit } = args
  let finalAmount = amount
  let roundedUp = false
  let preciseAmount: number | null = null

  if (amount !== null) {
    preciseAmount = round2(amount)
    // Q1：清单场景对不可分割单位向上取整（在跨菜累加之后统一执行）
    if (needsCeil(unit)) {
      const ceiled = Math.ceil(preciseAmount - AMOUNT_EPSILON)
      if (ceiled !== preciseAmount) {
        finalAmount = ceiled
        roundedUp = true
      }
    }
  }

  return {
    ...args,
    amount: finalAmount,
    preciseAmount,
    roundedUp,
    display: formatDisplay(finalAmount, unit, args.amountText),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 清单行的用量文本 */
function formatDisplay(amount: number | null, unit: string | null, amountText: string | null): string {
  if (amount === null) return amountText ?? ''
  const label = unit ? getUnit(unit)?.label ?? unit : ''
  const rounded = round2(amount)
  const num = Number.isInteger(rounded) ? String(rounded) : String(rounded)
  const sep = label && /^[a-zA-Z]/.test(label) ? ' ' : ''
  return `${num}${sep}${label}`
}

/** 排序：先按类别，再按名称（FR-3.13） */
export function sortItems(items: MergedShopItem[]): MergedShopItem[] {
  return [...items].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category)
    const cb = CATEGORY_ORDER.indexOf(b.category)
    if (ca !== cb) return ca - cb
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/** 按类别分组，供 UI 渲染（FR-3.13） */
export function groupByCategory(items: MergedShopItem[]): Array<{ category: ShoppingCategory; label: string; items: MergedShopItem[] }> {
  const groups: Array<{ category: ShoppingCategory; label: string; items: MergedShopItem[] }> = []
  for (const cat of CATEGORY_ORDER) {
    const list = items.filter((i) => i.category === cat)
    if (list.length > 0) groups.push({ category: cat, label: CATEGORY_LABEL[cat], items: list })
  }
  return groups
}

/**
 * 导出为纯文本，便于复制发给家人（FR-3.16）
 *
 * @param items     合并结果
 * @param isChecked 可选的勾选状态查询（持久化的勾选在 repository 层，不在合并逻辑里）
 */
export function exportAsText(
  items: MergedShopItem[],
  options: { title?: string; isChecked?: (item: MergedShopItem) => boolean } = {},
): string {
  const { title = '备菜清单', isChecked } = options
  const groups = groupByCategory(items)
  const lines: string[] = [`【${title}】`, '']
  for (const g of groups) {
    lines.push(`— ${g.label} —`)
    for (const item of g.items) {
      const flag = isChecked?.(item) ? '☑ ' : '☐ '
      lines.push(`  ${flag}${item.name}  ${item.display}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
