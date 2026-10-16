/**
 * 端到端集成测试：走真实 repository + IndexedDB（fake-indexeddb）
 *
 * 覆盖 M1 + M3 的完整闭环：
 *   建菜谱 → 浏览 → 点菜 → 调份量 → 生成备菜清单（合并去重）→ 勾选 → 状态保留 → 导出
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  addManualShoppingItem,
  addToMenu,
  buildShoppingText,
  clearMenu,
  createRecipe,
  deleteRecipe,
  getRecipeDetail,
  getStats,
  initDatabase,
  listCategories,
  listMenu,
  listRecipes,
  rebuildShoppingList,
  setMenuMultiplier,
  setStockStatus,
  toggleShoppingChecked,
  UNCATEGORIZED_ID,
  todayKey,
  updateRecipe,
} from './repository'
import type { RecipeDraft } from '@/types/models'

/** 每个用例前重置数据库与 Dexie 连接 */
async function resetDb() {
  db.close()
  await db.delete()
  // 换一个新的 IDBFactory，彻底隔离上一个用例的数据
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await db.open()
}

beforeEach(async () => {
  await resetDb()
  await initDatabase()
})

function makeDraft(name: string, ingredients: RecipeDraft['ingredients'], steps?: RecipeDraft['steps']): RecipeDraft {
  return {
    name,
    intro: null,
    categoryId: UNCATEGORIZED_ID,
    tagIds: [],
    servings: 2,
    durationMin: 20,
    difficulty: 1,
    sourceType: 'manual',
    sourceText: null,
    tips: null,
    ingredients,
    steps: steps ?? [
      { order: 0, text: '下锅炒', imageBlobId: null, timerSec: null, timerLabel: null },
    ],
  }
}

function ing(name: string, amount: number | null, unit: string | null, kind: 'main' | 'seasoning' = 'main') {
  return {
    kind,
    name,
    normalizedId: null,
    amount,
    unit,
    amountText: amount === null ? unit : null,
    note: null,
    order: 0,
  }
}

describe('初始化种子数据', () => {
  it('首次启动写入分类树、标签、食材字典', async () => {
    const stats = await getStats()
    expect(stats.categoryCount).toBeGreaterThan(10)
    expect(stats.tagCount).toBeGreaterThan(30)

    const cats = await listCategories()
    expect(cats.some((c) => c.id === UNCATEGORIZED_ID && c.isSystem)).toBe(true)
    // v1.1 决议 Q3：菜系不再出现在分类树里（家常菜下不应有「川菜」）
    expect(cats.some((c) => c.name === '川菜')).toBe(false)
    // 但作为标签维度存在
    const { listTags } = await import('./repository')
    const tags = await listTags()
    expect(tags.some((t) => t.name === '川菜' && t.dimension === 'cuisine')).toBe(true)
  })

  it('重复初始化不会重复写入', async () => {
    const before = await getStats()
    await initDatabase()
    const after = await getStats()
    expect(after).toEqual(before)
  })
})

describe('M1 · 菜谱录入与浏览', () => {
  it('新建菜谱后能在列表和详情里读到', async () => {
    const id = await createRecipe(
      makeDraft('蒜香排骨', [ing('猪排骨', 500, 'g'), ing('生抽', 2, '勺', 'seasoning'), ing('食盐', null, '适量', 'seasoning')]),
    )

    const list = await listRecipes()
    expect(list.map((r) => r.name)).toContain('蒜香排骨')

    const detail = await getRecipeDetail(id)
    expect(detail).not.toBeNull()
    expect(detail!.ingredients).toHaveLength(3)
    expect(detail!.steps).toHaveLength(1)
    expect(detail!.ingredients[0].amount).toBe(500)
    expect(detail!.ingredients[2].amount).toBeNull()
    expect(detail!.ingredients[2].amountText).toBe('适量')
  })

  it('编辑菜谱会整体替换食材与步骤', async () => {
    const id = await createRecipe(makeDraft('番茄炒蛋', [ing('番茄', 2, '个')]))
    await updateRecipe(id, makeDraft('番茄炒蛋', [ing('番茄', 3, '个'), ing('鸡蛋', 3, '个')]))
    const detail = await getRecipeDetail(id)
    expect(detail!.ingredients).toHaveLength(2)
    expect(detail!.ingredients[0].amount).toBe(3)
  })

  it('删除是软删除，列表里看不到但数据还在', async () => {
    const id = await createRecipe(makeDraft('红烧肉', [ing('猪五花肉', 500, 'g')]))
    await deleteRecipe(id)
    expect(await listRecipes()).toHaveLength(0)
    const row = await db.recipes.get(id)
    expect(row).toBeTruthy()
    expect(row!.deletedAt).not.toBeNull()
  })

  it('关键词能搜到步骤里的内容（FR-4.1）', async () => {
    await createRecipe(
      makeDraft('神秘料理', [ing('番茄', 1, '个')], [
        { order: 0, text: '先把番茄用开水烫一下去皮', imageBlobId: null, timerSec: null, timerLabel: null },
      ]),
    )
    const hit = await listRecipes({ keyword: '开水烫' })
    expect(hit).toHaveLength(1)
    expect(hit[0].name).toBe('神秘料理')
  })
})

describe('M3 · 点菜与备菜清单闭环', () => {
  it('点菜后菜单可读，重复点同一道菜会叠加份量', async () => {
    const id = await createRecipe(makeDraft('番茄炒蛋', [ing('番茄', 2, '个')]))
    await addToMenu(id)
    expect(await listMenu()).toHaveLength(1)
    expect((await listMenu())[0].item.multiplier).toBe(1)

    await addToMenu(id)
    const menu = await listMenu()
    expect(menu).toHaveLength(1)
    expect(menu[0].item.multiplier).toBe(2)
  })

  it('AC-2：番茄炒蛋 + 番茄牛腩 → 番茄合并为 1 行、共 5 个、来源 2 道菜', async () => {
    const a = await createRecipe(
      makeDraft('番茄炒蛋', [ing('番茄', 2, '个'), ing('鸡蛋', 2, '个')]),
    )
    const b = await createRecipe(
      makeDraft('番茄牛腩', [ing('番茄', 3, '个'), ing('牛腩', 500, 'g')]),
    )
    await addToMenu(a)
    await addToMenu(b)

    const items = await rebuildShoppingList(todayKey())
    const tomato = items.filter((i) => i.name === '番茄')
    expect(tomato).toHaveLength(1)
    expect(tomato[0].amount).toBe(5)
    expect(tomato[0].sourceRecipeIds).toHaveLength(2)
    expect(tomato[0].category).toBe('veg')

    // 分组正确
    expect(items.find((i) => i.name === '牛腩')!.category).toBe('meat')
    expect(items.find((i) => i.name === '鸡蛋')!.category).toBe('meat')
  })

  it('AC-4：份量 ×1.5 后备菜清单按比例放大', async () => {
    const id = await createRecipe(
      makeDraft('蒜香排骨', [ing('猪排骨', 500, 'g'), ing('生抽', 2, '勺', 'seasoning')]),
    )
    await addToMenu(id)
    await setMenuMultiplier((await listMenu())[0].item.id, 1.5)

    const items = await rebuildShoppingList(todayKey())
    expect(items.find((i) => i.name === '猪排骨')!.amount).toBe(750)
    expect(items.find((i) => i.name === '生抽')!.amount).toBe(3)
  })

  it('Q1：清单里不可分割单位向上取整，重量单位不取整', async () => {
    const id = await createRecipe(makeDraft('蒸蛋', [ing('鸡蛋', 1, '个'), ing('猪排骨', 1, 'kg')]))
    await addToMenu(id)
    await setMenuMultiplier((await listMenu())[0].item.id, 1.5)

    const items = await rebuildShoppingList(todayKey())
    expect(items.find((i) => i.name === '鸡蛋')!.amount).toBe(2) // 1.5 → 2
    expect(items.find((i) => i.name === '猪排骨')!.amount).toBe(1.5) // 重量不取整
  })

  it('别名归一后自动合并：生抽 + 酱油 合成一行', async () => {
    const a = await createRecipe(makeDraft('红烧肉', [ing('生抽', 2, '勺', 'seasoning')]))
    const b = await createRecipe(makeDraft('白灼菜心', [ing('酱油', 1, '勺', 'seasoning')]))
    await addToMenu(a)
    await addToMenu(b)

    const items = await rebuildShoppingList(todayKey())
    const soy = items.filter((i) => i.name === '生抽')
    expect(soy).toHaveLength(1)
    expect(soy[0].amount).toBe(3)
  })

  it('单位不可换算时分成两行，不误合并（R2）', async () => {
    const a = await createRecipe(makeDraft('凉拌番茄', [ing('番茄', 2, '个')]))
    const b = await createRecipe(makeDraft('番茄浓汤', [ing('番茄', 200, 'g')]))
    await addToMenu(a)
    await addToMenu(b)

    const items = await rebuildShoppingList(todayKey())
    const tomato = items.filter((i) => i.name === '番茄')
    expect(tomato).toHaveLength(2)
    expect(tomato.map((t) => t.amount).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([2, 200])
  })

  it('重算清单时保留勾选状态（FR-3.14）', async () => {
    const id = await createRecipe(makeDraft('番茄炒蛋', [ing('番茄', 2, '个'), ing('鸡蛋', 2, '个')]))
    await addToMenu(id)

    let items = await rebuildShoppingList(todayKey())
    const tomato = items.find((i) => i.name === '番茄')!
    await toggleShoppingChecked(tomato.id)

    // 再次重算（模拟用户切页面回来）
    items = await rebuildShoppingList(todayKey())
    expect(items.find((i) => i.name === '番茄')!.checked).toBe(true)
    expect(items.find((i) => i.name === '鸡蛋')!.checked).toBe(false)
  })

  it('重算时库存状态也保留（FR-3.15）', async () => {
    const id = await createRecipe(makeDraft('番茄炒蛋', [ing('番茄', 2, '个')]))
    await addToMenu(id)
    let items = await rebuildShoppingList(todayKey())
    await setStockStatus(items[0].id, 'have')
    items = await rebuildShoppingList(todayKey())
    expect(items[0].stockStatus).toBe('have')
  })

  it('从菜单移除某道菜后，其食材从清单消失', async () => {
    const a = await createRecipe(makeDraft('番茄炒蛋', [ing('番茄', 2, '个')]))
    const b = await createRecipe(makeDraft('青椒肉丝', [ing('青椒', 3, '个')]))
    await addToMenu(a)
    await addToMenu(b)
    let items = await rebuildShoppingList(todayKey())
    expect(items.map((i) => i.name).sort()).toEqual(['番茄', '青椒'])

    await clearMenu()
    await addToMenu(b)
    items = await rebuildShoppingList(todayKey())
    expect(items.map((i) => i.name)).toEqual(['青椒'])
  })

  it('手动追加的清单项在重算后不被冲掉（FR-3.19）', async () => {
    const id = await createRecipe(makeDraft('番茄炒蛋', [ing('番茄', 2, '个')]))
    await addToMenu(id)
    await rebuildShoppingList(todayKey())

    await addManualShoppingItem('厨房纸', 'other', todayKey())
    const items = await rebuildShoppingList(todayKey())
    expect(items.some((i) => i.name === '厨房纸' && i.isManual)).toBe(true)
    expect(items.some((i) => i.name === '番茄')).toBe(true)
  })

  it('导出文本带分组与勾选标记（FR-3.16）', async () => {
    const id = await createRecipe(
      makeDraft('番茄炒蛋', [ing('番茄', 2, '个'), ing('鸡蛋', 2, '个'), ing('食盐', 3, 'g', 'seasoning')]),
    )
    await addToMenu(id)
    const items = await rebuildShoppingList(todayKey())
    await toggleShoppingChecked(items.find((i) => i.name === '番茄')!.id)

    const text = await buildShoppingText(todayKey())
    expect(text).toContain('— 蔬菜 —')
    expect(text).toContain('— 调料 —')
    expect(text).toContain('☑ 番茄')
    expect(text).toContain('☐ 鸡蛋')
  })

  it('空菜单时清单为空', async () => {
    await clearMenu()
    expect(await rebuildShoppingList(todayKey())).toEqual([])
  })
})
