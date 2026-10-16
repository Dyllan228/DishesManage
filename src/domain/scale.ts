/**
 * 份量换算（FR-3.3 / FR-3.4）
 *
 * 决议 Q1：双场景分离
 * - `display` 场景（菜谱详情）：保留精算值，不可分割单位给「约 N 个」提示
 * - `shopping` 场景（备菜/采购清单）：不可分割单位向上取整（没人能买 1.5 个鸡蛋）
 *
 * 「适量 / 少许」不参与缩放，只标注份量（FR-3.4）。
 */

import { getUnit, needsCeil, type ParsedAmount } from './units'

export type ScaleMode = 'display' | 'shopping'

export interface ScaledAmount {
  /** 缩放后的数值；null 表示不可量化 */
  amount: number | null
  unit: string | null
  /** 不可量化时保留的原文 */
  amountText: string | null
  /** 取整前的精算值，用于「约 N 个」提示 */
  preciseAmount: number | null
  /** 是否因不可分割单位被向上取整 */
  roundedUp: boolean
  /** 直接可用于渲染的文本 */
  display: string
}

/** 去掉浮点噪声（0.30000000000000004 → 0.3） */
export function roundAmount(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/** 数值 → 人类可读文本：整数不带小数点，小数最多两位 */
export function formatNumber(n: number): string {
  const r = roundAmount(n)
  return Number.isInteger(r) ? String(r) : String(r)
}

/**
 * 格式化用量文本
 * @param amount 数值用量，null 表示不可量化
 * @param unit   单位键
 * @param amountText 不可量化时的原文
 */
export function formatAmount(
  amount: number | null,
  unit: string | null,
  amountText: string | null,
): string {
  if (amount === null) {
    // 「适量」「少许」或原文（「两把」）
    return amountText ?? (unit ? (getUnit(unit)?.label ?? unit) : '')
  }
  const unitLabel = unit ? (getUnit(unit)?.label ?? unit) : ''
  // 中文单位不空格，西文单位空格更易读（500 g / 2 个）
  const sep = unitLabel && /^[a-zA-Z]/.test(unitLabel) ? ' ' : ''
  return `${formatNumber(amount)}${sep}${unitLabel}`
}

/**
 * 按份量倍率缩放用量
 *
 * @param input  原始用量
 * @param multiplier 份量倍率（1 = 基准份量）
 * @param mode   display = 菜谱内展示；shopping = 备菜/采购清单
 */
export function scaleAmount(
  input: Pick<ParsedAmount, 'amount' | 'unit' | 'amountText'>,
  multiplier: number,
  mode: ScaleMode = 'display',
): ScaledAmount {
  const { amount, unit, amountText } = input

  // 不可量化（适量/少许/两把）：不缩放，原样保留
  if (amount === null) {
    return {
      amount: null,
      unit,
      amountText,
      preciseAmount: null,
      roundedUp: false,
      display: formatAmount(null, unit, amountText),
    }
  }

  const precise = roundAmount(amount * multiplier)
  let final = precise
  let roundedUp = false

  if (mode === 'shopping' && needsCeil(unit)) {
    const ceiled = Math.ceil(precise)
    if (ceiled !== precise) {
      final = ceiled
      roundedUp = true
    }
  }

  return {
    amount: final,
    unit,
    amountText: null,
    preciseAmount: precise,
    roundedUp,
    display: formatAmount(final, unit, null),
  }
}

/**
 * 生成带提示的展示文本：不可分割单位出现小数时补「约 N 个」
 * 例：「1.5 个」→「1.5 个（约 2 个）」
 */
export function displayWithHint(scaled: ScaledAmount): string {
  if (scaled.amount === null) return scaled.display
  if (!scaled.unit || !needsCeil(scaled.unit)) return scaled.display
  if (Number.isInteger(scaled.amount)) return scaled.display
  const approx = Math.ceil(scaled.amount)
  return `${scaled.display}（约 ${approx}${getUnit(scaled.unit)?.label ?? scaled.unit}）`
}

/** 估算总耗时（FR-3.5 底部悬浮条「已点 N 道菜 · 预计总耗时」） */
export function estimateTotalMinutes(durations: Array<number | null>): number {
  // 简化模型：单菜耗时取最大值作为基准，其余菜按 40% 折算并行重叠部分
  const known = durations.filter((d): d is number => d !== null && d > 0)
  if (known.length === 0) return 0
  const sorted = [...known].sort((a, b) => b - a)
  const longest = sorted[0]
  const rest = sorted.slice(1).reduce((sum, d) => sum + d * 0.4, 0)
  return Math.round(longest + rest)
}
