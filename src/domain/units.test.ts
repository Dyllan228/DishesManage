import { describe, expect, it } from 'vitest'
import { convert, findUnit, isConvertible, needsCeil, parseAmount } from './units'

describe('单位字典', () => {
  it('按别名查到单位', () => {
    expect(findUnit('克')?.key).toBe('g')
    expect(findUnit('kg')?.key).toBe('kg')
    expect(findUnit('汤匙')?.key).toBe('勺')
    expect(findUnit('不存在的单位')).toBeNull()
  })

  it('不可分割单位需要向上取整（Q1）', () => {
    for (const u of ['个', '只', '条', '块', '根', '片', '瓣']) {
      expect(needsCeil(u)).toBe(true)
    }
    for (const u of ['g', 'kg', 'ml', '勺', '茶匙', '碗']) {
      expect(needsCeil(u)).toBe(false)
    }
  })

  it('同组可换算', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000)
    expect(convert(500, 'g', '斤')).toBe(1)
    expect(convert(3, '勺', '茶匙')).toBe(9)
  })

  it('计数单位之间不换算（个 ≠ 只）', () => {
    expect(isConvertible('个', '只')).toBe(false)
    expect(isConvertible('个', '个')).toBe(true)
    expect(convert(2, '个', '只')).toBeNull()
  })

  it('不可量化单位不参与换算', () => {
    expect(isConvertible('适量', 'g')).toBe(false)
    expect(isConvertible('适量', '少许')).toBe(false)
  })
})

describe('用量文本解析', () => {
  it('数字 + 单位', () => {
    expect(parseAmount('500g')).toEqual({ amount: 500, unit: 'g', amountText: null })
    expect(parseAmount('2 个')).toEqual({ amount: 2, unit: '个', amountText: null })
    expect(parseAmount('1.5勺')).toEqual({ amount: 1.5, unit: '勺', amountText: null })
  })

  it('中文数字 + 单位', () => {
    expect(parseAmount('两个')).toEqual({ amount: 2, unit: '个', amountText: null })
    expect(parseAmount('半勺')).toEqual({ amount: 0.5, unit: '勺', amountText: null })
    expect(parseAmount('两把')).toEqual({ amount: 2, unit: '把', amountText: null })
    expect(parseAmount('十克')).toEqual({ amount: 10, unit: 'g', amountText: null })
    expect(parseAmount('十五克')).toEqual({ amount: 15, unit: 'g', amountText: null })
  })

  it('不可量化词保留原文', () => {
    const r = parseAmount('适量')
    expect(r.amount).toBeNull()
    expect(r.amountText).toBe('适量')
  })

  it('识别不了的用量不丢信息，整体留在 amountText', () => {
    expect(parseAmount('一小碗').amountText).toBe('一小碗')
    expect(parseAmount('若干').amountText).toBe('若干')
  })

  it('纯数字无单位', () => {
    expect(parseAmount('3')).toEqual({ amount: 3, unit: null, amountText: null })
  })
})
