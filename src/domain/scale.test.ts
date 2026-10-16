import { describe, expect, it } from 'vitest'
import { displayWithHint, estimateTotalMinutes, formatAmount, scaleAmount } from './scale'

describe('份额换算 · AC-4（需求文档 §10）', () => {
  it('蒜香排骨 ×1.5：排骨 500g → 750g，生抽 2 勺 → 3 勺，盐「适量」不变', () => {
    const paigu = scaleAmount({ amount: 500, unit: 'g', amountText: null }, 1.5)
    expect(paigu.amount).toBe(750)
    expect(paigu.display).toBe('750 g')

    const soy = scaleAmount({ amount: 2, unit: '勺', amountText: null }, 1.5)
    expect(soy.amount).toBe(3)
    expect(soy.display).toBe('3勺')

    // 「适量」不参与缩放（FR-3.4）
    const salt = scaleAmount({ amount: null, unit: '适量', amountText: '适量' }, 1.5)
    expect(salt.amount).toBeNull()
    expect(salt.display).toBe('适量')
  })

  it('基准份量 ×1 不做任何改变', () => {
    const r = scaleAmount({ amount: 300, unit: 'g', amountText: null }, 1)
    expect(r.amount).toBe(300)
    expect(r.roundedUp).toBe(false)
  })
})

describe('份额换算 · Q1 双场景分离（决议 D-001）', () => {
  it('菜谱展示：不可分割单位保留精算值', () => {
    const egg = scaleAmount({ amount: 1, unit: '个', amountText: null }, 1.5, 'display')
    expect(egg.amount).toBe(1.5)
    expect(egg.roundedUp).toBe(false)
    expect(egg.display).toBe('1.5个')
  })

  it('菜谱展示：给出人性化提示「约 2 个」', () => {
    const egg = scaleAmount({ amount: 1, unit: '个', amountText: null }, 1.5, 'display')
    expect(displayWithHint(egg)).toBe('1.5个（约 2个）')
  })

  it('采购清单：不可分割单位向上取整', () => {
    const egg = scaleAmount({ amount: 1, unit: '个', amountText: null }, 1.5, 'shopping')
    expect(egg.amount).toBe(2)
    expect(egg.preciseAmount).toBe(1.5)
    expect(egg.roundedUp).toBe(true)
  })

  it('采购清单：重量/体积单位不取整（1.5 kg 合理）', () => {
    const rice = scaleAmount({ amount: 1, unit: 'kg', amountText: null }, 1.5, 'shopping')
    expect(rice.amount).toBe(1.5)
    expect(rice.roundedUp).toBe(false)
  })

  it('已经整数时标记为未取整', () => {
    const r = scaleAmount({ amount: 2, unit: '个', amountText: null }, 1.5, 'shopping')
    expect(r.amount).toBe(3)
    expect(r.roundedUp).toBe(false)
  })
})

describe('用量格式化', () => {
  it('西文单位带空格，中文单位不带', () => {
    expect(formatAmount(500, 'g', null)).toBe('500 g')
    expect(formatAmount(2, '个', null)).toBe('2个')
  })

  it('不可量化时回落到原文', () => {
    expect(formatAmount(null, '适量', '适量')).toBe('适量')
    expect(formatAmount(null, null, '两把')).toBe('两把')
  })

  it('消除浮点噪声', () => {
    expect(formatAmount(0.1 * 3, '勺', null)).toBe('0.3勺')
  })
})

describe('总耗时估算（FR-3.5）', () => {
  it('单菜取自身耗时', () => {
    expect(estimateTotalMinutes([30])).toBe(30)
  })

  it('多菜按最长菜 + 其余 40% 并行折算', () => {
    // 40 + 20*0.4 = 48
    expect(estimateTotalMinutes([40, 20])).toBe(48)
  })

  it('无耗时数据返回 0', () => {
    expect(estimateTotalMinutes([null, null])).toBe(0)
  })
})
