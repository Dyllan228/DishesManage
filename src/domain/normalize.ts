/**
 * 食材归一化（FR-3.12）
 *
 * 备菜清单能否正确合并累加，全靠这一步。决议 Q2：内置字典开箱即用。
 *
 * 策略（宁可不合并，也不误合并 —— 文档 R2 对策）：
 *   1. 精确命中标准名  → 归一
 *   2. 精确命中别名    → 归一
 *   3. 去掉加工后缀（丝/片/段/末…）后重试 → 归一
 *   4. 都未命中 → 返回 null，清单里**不合并**，只按名称相邻排列并提示
 */

import type { IngredientDict, ShoppingCategory } from '@/types/models'

/** 加工形态后缀：切配方式不改变食材本身 */
const PREP_SUFFIXES = [
  '碎末', '末', '碎', '蓉', '泥', '丝', '片', '段', '丁', '块', '条', '粒', '球',
  '花', '卷', '馅', '沫', '粒儿', '小段', '薄片', '滚刀块',
]

/** 常见修饰前缀：修饰词不改变食材本身 */
const MODIFIER_PREFIXES = ['新鲜', '鲜', '干', '老', '嫩', '小', '大', '土', '去皮', '冰冻', '冷冻', '熟', '生']

export interface DictIndex {
  /** 别名（含标准名）→ 字典项 */
  byAlias: Map<string, IngredientDict>
  /** 字典项 id → 字典项 */
  byId: Map<string, IngredientDict>
  items: IngredientDict[]
}

/** 从 JSON 原始数据构建索引。字典项在内存中即以 name 作为 id（内置字典无独立 id） */
export function buildDictIndex(
  raw: Array<{ name: string; category: ShoppingCategory; aliases: string[]; defaultUnit: string | null }>,
): DictIndex {
  const items: IngredientDict[] = raw.map((r, i) => ({
    id: `dict_${i}`,
    name: r.name,
    category: r.category,
    aliases: r.aliases ?? [],
    defaultUnit: r.defaultUnit ?? null,
    createdAt: 0,
    updatedAt: 0,
  }))

  const byAlias = new Map<string, IngredientDict>()
  const byId = new Map<string, IngredientDict>()

  for (const item of items) {
    byId.set(item.id, item)
    // 标准名优先，别名不覆盖已有映射（避免歧义：先定义者优先）
    if (!byAlias.has(item.name)) byAlias.set(item.name, item)
    for (const alias of item.aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, item)
    }
  }

  return { byAlias, byId, items }
}

/** 清洗食材名：去空格、去括号补充说明、去量词 */
export function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/[（(].*?[)）]/g, '') // 「番茄（大的）」→「番茄」
    .replace(/\s+/g, '')
    .replace(/^[、，,。.]/, '')
    .trim()
}

/** 尝试去后缀/前缀，返回候选列表（按优先级） */
function candidates(name: string): string[] {
  const out: string[] = [name]
  let cur = name
  for (const suf of PREP_SUFFIXES) {
    if (cur.length > suf.length && cur.endsWith(suf)) {
      const stripped = cur.slice(0, -suf.length)
      out.push(stripped)
      cur = stripped
    }
  }
  for (const pre of MODIFIER_PREFIXES) {
    if (cur.length > pre.length && cur.startsWith(pre)) {
      out.push(cur.slice(pre.length))
    }
  }
  return [...new Set(out)]
}

export interface NormalizeResult {
  /** 命中的字典项；未命中为 null */
  dict: IngredientDict | null
  /** 用于展示的名字 */
  displayName: string
  /** 用于合并的键：命中字典用 dict.id，否则退化为清洗后的名字 */
  mergeKey: string
  /** 是否命中内置字典 */
  matched: boolean
}

/**
 * 归一化一个食材名
 */
export function normalizeIngredient(rawName: string, index: DictIndex): NormalizeResult {
  const name = cleanName(rawName)

  for (const cand of candidates(name)) {
    const hit = index.byAlias.get(cand)
    if (hit) {
      return {
        dict: hit,
        displayName: hit.name, // 统一显示标准名，便于清单一致
        mergeKey: hit.id,
        matched: true,
      }
    }
  }

  // 未命中：不猜。用清洗后的原名作为合并键（同名才合并）
  return {
    dict: null,
    displayName: name || rawName,
    mergeKey: `raw:${name}`,
    matched: false,
  }
}

/** 猜测食材类别，未命中字典时用于清单分组（默认归「其他」） */
export function guessCategory(rawName: string, index: DictIndex): ShoppingCategory {
  const res = normalizeIngredient(rawName, index)
  return res.dict?.category ?? 'other'
}
