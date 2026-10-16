import { describe, expect, it } from 'vitest'
import type { Ingredient, IngredientKind } from '@/types/models'
import rawDict from '@/data/ingredientDict.json'
import { buildDictIndex, normalizeIngredient } from './normalize'
import { buildShoppingItems, exportAsText, groupByCategory, sortItems } from './shoppingList'

const index = buildDictIndex(
  rawDict.items as Array<{ name: string; category: never; aliases: string[]; defaultUnit: string | null }>,
)

let seq = 0
function ing(
  name: string,
  amount: number | null,
  unit: string | null,
  amountText: string | null = null,
  kind: IngredientKind = 'main',
): Ingredient {
  seq += 1
  return {
    id: `ing_${seq}`,
    recipeId: 'r',
    kind,
    name,
    normalizedId: null,
    amount,
    unit,
    amountText,
    note: null,
    order: seq,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('食材归一化（FR-3.12 / 决议 Q2）', () => {
  it('标准名直接命中', () => {
    const r = normalizeIngredient('番茄', index)
    expect(r.matched).toBe(true)
    expect(r.displayName).toBe('番茄')
  })

  it('别名归一：西红柿 → 番茄', () => {
    expect(normalizeIngredient('西红柿', index).displayName).toBe('番茄')
  })

  it('别名归一：酱油 → 生抽，马铃薯 → 土豆', () => {
    expect(normalizeIngredient('酱油', index).displayName).toBe('生抽')
    expect(normalizeIngredient('马铃薯', index).displayName).toBe('土豆')
    expect(normalizeIngredient('洋芋', index).displayName).toBe('土豆')
  })

  it('去加工后缀：排骨段 → 猪排骨', () => {
    expect(normalizeIngredient('排骨段', index).displayName).toBe('猪排骨')
    expect(normalizeIngredient('姜末', index).displayName).toBe('生姜')
  })

  it('未命中字典时返回原文，不做猜测（R2）', () => {
    const r = normalizeIngredient('自制秘制酱', index)
    expect(r.matched).toBe(false)
    expect(r.displayName).toBe('自制秘制酱')
  })

  it('字典条目数量达到「开箱即用」要求', () => {
    expect(index.items.length).toBeGreaterThanOrEqual(180)
  })
})

describe('备菜清单合并 · AC-2（需求文档 §10）', () => {
  it('番茄炒蛋（番茄 2 个）+ 番茄牛腩（番茄 3 个）→ 合并为 1 行、共 5 个、来源 2 道菜', () => {
    const items = buildShoppingItems(
      [
        {
          recipeId: 'A',
          recipeName: '番茄炒蛋',
          multiplier: 1,
          ingredients: [ing('番茄', 2, '个'), ing('鸡蛋', 2, '个')],
        },
        {
          recipeId: 'B',
          recipeName: '番茄牛腩',
          multiplier: 1,
          ingredients: [ing('番茄', 3, '个'), ing('牛腩', 500, 'g')],
        },
      ],
      index,
    )

    const tomato = items.filter((i) => i.name === '番茄' && i.unit === '个')
    expect(tomato).toHaveLength(1)
    expect(tomato[0].amount).toBe(5)
    expect(tomato[0].display).toBe('5个')
    expect(tomato[0].sourceRecipeIds.sort()).toEqual(['A', 'B'])
    expect(tomato[0].sourceRecipeNames.sort()).toEqual(['番茄炒蛋', '番茄牛腩'])
  })

  it('跨菜累加后再统一取整，避免多菜误差累积（Q1）', () => {
    // A: 鸡蛋 1 个 ×1.5 = 1.5；B: 鸡蛋 2 个 ×1 = 2；合计 3.5 → 采购取整 4
    const items = buildShoppingItems(
      [
        { recipeId: 'A', recipeName: '蒸蛋', multiplier: 1.5, ingredients: [ing('鸡蛋', 1, '个')] },
        { recipeId: 'B', recipeName: '炒蛋', multiplier: 1, ingredients: [ing('鸡蛋', 2, '个')] },
      ],
      index,
    )
    const egg = items.find((i) => i.name === '鸡蛋')!
    expect(egg.preciseAmount).toBe(3.5)
    expect(egg.amount).toBe(4)
    expect(egg.roundedUp).toBe(true)
  })

  it('别名不同的同一食材会合并：生抽 + 酱油 → 一行', () => {
    const items = buildShoppingItems(
      [
        { recipeId: 'A', recipeName: '红烧肉', multiplier: 1, ingredients: [ing('生抽', 2, '勺', null, 'seasoning')] },
        { recipeId: 'B', recipeName: '白灼菜心', multiplier: 1, ingredients: [ing('酱油', 1, '勺', null, 'seasoning')] },
      ],
      index,
    )
    const soy = items.filter((i) => i.name === '生抽')
    expect(soy).toHaveLength(1)
    expect(soy[0].amount).toBe(3)
  })

  it('单位不可换算时宁可不合并，分成两行并标记 unmerged（R2）', () => {
    const items = buildShoppingItems(
      [
        { recipeId: 'A', recipeName: '凉拌番茄', multiplier: 1, ingredients: [ing('番茄', 2, '个')] },
        { recipeId: 'B', recipeName: '番茄浓汤', multiplier: 1, ingredients: [ing('番茄', 200, 'g')] },
      ],
      index,
    )
    const tomato = items.filter((i) => i.name === '番茄')
    expect(tomato).toHaveLength(2) // 绝不合并成「202」
    expect(tomato.every((i) => i.unmerged)).toBe(true)
    const amounts = tomato.map((i) => i.display).sort()
    expect(amounts).toEqual(['200 g', '2个'])
  })

  it('可换算的同组单位会归并：500g + 1斤 → 1000 g', () => {
    const items = buildShoppingItems(
      [
        { recipeId: 'A', recipeName: 'A', multiplier: 1, ingredients: [ing('猪排骨', 500, 'g')] },
        { recipeId: 'B', recipeName: 'B', multiplier: 1, ingredients: [ing('猪排骨', 1, '斤')] },
      ],
      index,
    )
    const ribs = items.filter((i) => i.name === '猪排骨')
    expect(ribs).toHaveLength(1)
    expect(ribs[0].amount).toBe(1000)
  })

  it('「适量」不参与累加，单独成行', () => {
    const items = buildShoppingItems(
      [
        { recipeId: 'A', recipeName: 'A', multiplier: 1, ingredients: [ing('食盐', null, '适量', '适量', 'seasoning'), ing('食盐', 5, 'g', null, 'seasoning')] },
      ],
      index,
    )
    const salt = items.filter((i) => i.name === '食盐')
    expect(salt).toHaveLength(2)
    const amounts = salt.map((i) => i.display).sort()
    expect(amounts).toEqual(['5 g', '适量'])
  })

  it('份量倍率生效：×2 使用量翻倍', () => {
    const items = buildShoppingItems(
      [{ recipeId: 'A', recipeName: 'A', multiplier: 2, ingredients: [ing('猪排骨', 500, 'g')] }],
      index,
    )
    expect(items.find((i) => i.name === '猪排骨')!.amount).toBe(1000)
  })

  it('空菜单返回空清单', () => {
    expect(buildShoppingItems([], index)).toEqual([])
  })
})

describe('清单分组与导出（FR-3.13 / FR-3.16）', () => {
  const items = buildShoppingItems(
    [
      {
        recipeId: 'A',
        recipeName: '番茄炒蛋',
        multiplier: 1,
        ingredients: [
          ing('番茄', 2, '个'),
          ing('鸡蛋', 2, '个'),
          ing('食盐', 3, 'g', null, 'seasoning'),
          ing('大米', 300, 'g'),
        ],
      },
    ],
    index,
  )

  it('按 肉蛋 / 蔬菜 / 主食干货 / 调料 分组且顺序固定', () => {
    const groups = groupByCategory(items)
    const labels = groups.map((g) => g.label)
    expect(labels).toEqual(['肉蛋水产', '蔬菜', '主食干货', '调料'])
  })

  it('水果以外的未知食材归入「其他」', () => {
    const other = buildShoppingItems(
      [{ recipeId: 'A', recipeName: 'A', multiplier: 1, ingredients: [ing('自制酱料', 1, '勺')] }],
      index,
    )
    expect(other[0].category).toBe('other')
  })

  it('导出为文本时按分组带勾选框', () => {
    const text = exportAsText(items, { isChecked: (i) => i.name === '番茄' })
    expect(text).toContain('【备菜清单】')
    expect(text).toContain('— 蔬菜 —')
    expect(text).toContain('☑ 番茄  2个')
    expect(text).toContain('☐ 鸡蛋  2个')
  })
})

describe('排序稳定性', () => {
  it('sortItems 不改动原数组', () => {
    const items = buildShoppingItems(
      [{ recipeId: 'A', recipeName: 'A', multiplier: 1, ingredients: [ing('番茄', 1, '个'), ing('鸡蛋', 1, '个')] }],
      index,
    )
    const copy = [...items]
    sortItems(items)
    expect(items).toEqual(copy)
  })
})
