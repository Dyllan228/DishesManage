/**
 * 单位元数据
 *
 * 决议 Q1（见 docs/决策记录.md D-001）：份量换算采用「双场景分离」策略——
 * 菜谱内展示保留精算值，备菜/采购清单对不可分割单位向上取整。
 * 因此每个单位都要声明 `divisible` 与 `roundMode`。
 */

export type UnitGroup = 'weight' | 'volume' | 'count' | 'imprecise'

export interface UnitMeta {
  /** 规范键，持久化时存这个值 */
  key: string
  /** 展示名 */
  label: string
  /** 解析时用于匹配的别名（含符号写法） */
  aliases: string[]
  group: UnitGroup
  /** 换算到本组基准单位的倍率；'imprecise' 组为 null */
  toBase: number | null
  /** 能否出现小数（「半个」「1.5 勺」合理，「1.5 个鸡蛋」不合理） */
  divisible: boolean
  /** 清单场景的舍入策略 */
  roundMode: 'exact' | 'ceil'
}

/** 基准单位：weight → g，volume → ml */
export const UNITS: UnitMeta[] = [
  // --- 重量 ---
  { key: 'g', label: 'g', aliases: ['g', 'G', '克', '公克'], group: 'weight', toBase: 1, divisible: true, roundMode: 'exact' },
  { key: 'kg', label: 'kg', aliases: ['kg', 'KG', '千克', '公斤'], group: 'weight', toBase: 1000, divisible: true, roundMode: 'exact' },
  { key: '斤', label: '斤', aliases: ['斤'], group: 'weight', toBase: 500, divisible: true, roundMode: 'exact' },
  { key: '两', label: '两', aliases: ['两'], group: 'weight', toBase: 50, divisible: true, roundMode: 'exact' },

  // --- 体积 ---
  { key: 'ml', label: 'ml', aliases: ['ml', 'ML', '毫升'], group: 'volume', toBase: 1, divisible: true, roundMode: 'exact' },
  { key: 'l', label: 'L', aliases: ['l', 'L', '升'], group: 'volume', toBase: 1000, divisible: true, roundMode: 'exact' },
  { key: '勺', label: '勺', aliases: ['勺', '汤匙', '大勺', 'tbsp'], group: 'volume', toBase: 15, divisible: true, roundMode: 'exact' },
  { key: '茶匙', label: '茶匙', aliases: ['茶匙', '小勺', 'tsp'], group: 'volume', toBase: 5, divisible: true, roundMode: 'exact' },
  { key: '碗', label: '碗', aliases: ['碗'], group: 'volume', toBase: 250, divisible: true, roundMode: 'exact' },
  { key: '杯', label: '杯', aliases: ['杯', 'cup'], group: 'volume', toBase: 240, divisible: true, roundMode: 'exact' },

  // --- 计数（不可分割，清单里向上取整）---
  { key: '个', label: '个', aliases: ['个'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '只', label: '只', aliases: ['只'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '条', label: '条', aliases: ['条'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '块', label: '块', aliases: ['块'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '根', label: '根', aliases: ['根'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '片', label: '片', aliases: ['片'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '瓣', label: '瓣', aliases: ['瓣'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '颗', label: '颗', aliases: ['颗', '粒'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '把', label: '把', aliases: ['把'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '束', label: '束', aliases: ['束'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '张', label: '张', aliases: ['张'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '枚', label: '枚', aliases: ['枚'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '朵', label: '朵', aliases: ['朵'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },
  { key: '份', label: '份', aliases: ['份'], group: 'count', toBase: 1, divisible: false, roundMode: 'ceil' },

  // --- 不可量化 ---
  { key: '适量', label: '适量', aliases: ['适量', '些许'], group: 'imprecise', toBase: null, divisible: false, roundMode: 'exact' },
  { key: '少许', label: '少许', aliases: ['少许', '一点', '少量', '一丢丢'], group: 'imprecise', toBase: null, divisible: false, roundMode: 'exact' },
]

const BY_KEY = new Map(UNITS.map((u) => [u.key, u]))
const BY_ALIAS = new Map<string, UnitMeta>()
for (const u of UNITS) {
  BY_ALIAS.set(u.key, u)
  for (const a of u.aliases) if (!BY_ALIAS.has(a)) BY_ALIAS.set(a, u)
}

/** 按规范键或别名查单位 */
export function findUnit(token: string): UnitMeta | null {
  return BY_ALIAS.get(token.trim()) ?? null
}

export function getUnit(key: string): UnitMeta | null {
  return BY_KEY.get(key) ?? null
}

/** 该单位在清单场景是否需要向上取整 */
export function needsCeil(unitKey: string | null): boolean {
  if (!unitKey) return false
  return getUnit(unitKey)?.roundMode === 'ceil'
}

/**
 * 两个单位是否可换算（同组且有换算倍率）。
 * 「个/只/条」同属 count 组但语义不同——它们之间不换算，只按 key 相同合并。
 */
export function isConvertible(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const ua = getUnit(a)
  const ub = getUnit(b)
  if (!ua || !ub) return false
  if (ua.group !== ub.group) return false
  if (ua.group === 'count' || ua.group === 'imprecise') return false
  return ua.toBase !== null && ub.toBase !== null
}

/** 把 amount 从 fromUnit 换算到 toUnit（同组才有效） */
export function convert(amount: number, fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return amount
  const from = getUnit(fromUnit)
  const to = getUnit(toUnit)
  if (!from || !to || from.toBase === null || to.toBase === null) return null
  if (from.group !== to.group) return null
  // 计数单位语义不同（「个」和「只」不是同一回事），不可量化单位也不换算
  if (from.group === 'count' || from.group === 'imprecise') return null
  return (amount * from.toBase) / to.toBase
}

/** 用于 UI 的单位候选项（FR-1.3） */
export const UNIT_OPTIONS = UNITS.map((u) => u.label)

// ---------------------------------------------------------------------------
// 用量文本解析
// ---------------------------------------------------------------------------

export interface ParsedAmount {
  amount: number | null
  unit: string | null
  /** 无法量化时保留原文 */
  amountText: string | null
}

/** 中文数字 → 阿拉伯数字（只覆盖做菜常用的小数字） */
const CN_NUM: Record<string, number> = {
  半: 0.5,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/**
 * 解析用量文本，如 "500g" / "2 个" / "适量" / "一把"。
 * 识别不了时整体作为 amountText 保留，绝不丢信息。
 */
export function parseAmount(raw: string): ParsedAmount {
  const text = raw.trim()
  if (!text) return { amount: null, unit: null, amountText: null }

  // 1) 数字 + 单位，如 "500g" "2 个" "1.5勺"
  const numUnit = text.match(/^(\d+(?:\.\d+)?)\s*([^\d\s]+)$/)
  if (numUnit) {
    const unit = findUnit(numUnit[2])
    if (unit) {
      return { amount: Number(numUnit[1]), unit: unit.key, amountText: null }
    }
    return { amount: Number(numUnit[1]), unit: null, amountText: text }
  }

  // 2) 中文数字 + 单位，如 "两个" "半勺"
  const cnUnit = text.match(/^([半一两二三四五六七八九十]+)\s*([^\d\s]+)$/)
  if (cnUnit) {
    const unit = findUnit(cnUnit[2])
    const n = cnNumToNumber(cnUnit[1])
    if (unit && n !== null) {
      return { amount: n, unit: unit.key, amountText: null }
    }
  }

  // 3) 纯数字
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return { amount: Number(text), unit: null, amountText: null }
  }

  // 4) 不可量化词，如 "适量" "少许"
  const imprecise = findUnit(text)
  if (imprecise && imprecise.group === 'imprecise') {
    return { amount: null, unit: imprecise.key, amountText: text }
  }

  // 5) 兜底：保留原文
  return { amount: null, unit: null, amountText: text }
}

/** "两三" 这类转不了，返回 null；"一" 返回 1 */
function cnNumToNumber(s: string): number | null {
  if (s.length === 1) return CN_NUM[s] ?? null
  // 十X / X十 / X十Y
  if (s === '十') return 10
  const m = s.match(/^([半一两二三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) {
    const tens = m[1] ? (CN_NUM[m[1]] ?? 1) : 1
    const ones = m[2] ? (CN_NUM[m[2]] ?? 0) : 0
    return tens * 10 + ones
  }
  return null
}
