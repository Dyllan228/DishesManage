/**
 * M2 · 分类与标签管理的端到端测试
 *
 * 这些用例覆盖的是**破坏性操作的边界**：删分类会不会连菜谱一起删掉、
 * 移动分类会不会形成环、合并标签会不会丢关联。这类 bug 在 UI 上点不出来，
 * 只能靠测试卡住。
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  categoryCounts,
  createCategory,
  createRecipe,
  createTag,
  deleteCategory,
  deleteTag,
  initDatabase,
  listCategories,
  listRecipes,
  listTags,
  mergeTags,
  moveCategory,
  recomputeAllTagUsage,
  renameCategory,
  renameTag,
  UNCATEGORIZED_ID,
} from './repository'
import type { RecipeDraft } from '@/types/models'

async function resetDb() {
  db.close()
  await db.delete()
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await db.open()
}

beforeEach(async () => {
  await resetDb()
  await initDatabase()
})

function draft(name: string, categoryId: string, tagIds: string[] = []): RecipeDraft {
  return {
    name,
    intro: null,
    categoryId,
    tagIds,
    servings: 2,
    durationMin: 20,
    difficulty: 1,
    sourceType: 'manual',
    sourceText: null,
    tips: null,
    ingredients: [
      { kind: 'seasoning', name: '盐', normalizedId: null, amount: null, amountText: '适量', unit: null, note: null, order: 0 },
    ],
    steps: [{ order: 0, text: '随便炒炒', imageBlobId: null, timerSec: null, timerLabel: null }],
  }
}

describe('分类管理', () => {
  it('新建分类时挂到指定父节点，order 按同级追加', async () => {
    const parent = await createCategory('我的私房菜', null)
    const a = await createCategory('小炒', parent)
    const b = await createCategory('炖菜', parent)

    const cats = await listCategories()
    const siblings = cats.filter((c) => c.parentId === parent)
    expect(siblings.map((c) => c.id)).toEqual([a, b])
    expect(siblings.map((c) => c.order)).toEqual([0, 1])
  })

  it('删除分类时子分类抬到上级、直属菜谱落到上级，都不连带删除（FR-2.4）', async () => {
    const root = await createCategory('根', null)
    const mid = await createCategory('中层', root)
    const leaf = await createCategory('叶子', mid)
    const onMid = await createRecipe(draft('中层的菜', mid))
    const onLeaf = await createRecipe(draft('叶子上的菜', leaf))

    await deleteCategory(mid)

    const cats = await listCategories()
    // 中层没了
    expect(cats.find((c) => c.id === mid)).toBeUndefined()
    // 子分类被抬到 root 下，而不是被删掉
    expect(cats.find((c) => c.id === leaf)?.parentId).toBe(root)

    const recipes = await listRecipes()
    // 直属于被删分类的菜谱，落到它的上级
    expect(recipes.find((r) => r.id === onMid)?.categoryId).toBe(root)
    // 挂在仍然存在的子分类下的菜谱**不动**——它跟着子分类一起被抬上去，本来就还能找到
    expect(recipes.find((r) => r.id === onLeaf)?.categoryId).toBe(leaf)
  })

  it('删除顶级分类时，内容落回「未分类」而不是凭空消失', async () => {
    const root = await createCategory('临时分类', null)
    const rid = await createRecipe(draft('一道菜', root))

    await deleteCategory(root)

    const recipes = await listRecipes()
    expect(recipes.find((r) => r.id === rid)?.categoryId).toBe(UNCATEGORIZED_ID)
  })

  it('系统保留分类不可删除（FR-2.1）', async () => {
    await deleteCategory(UNCATEGORIZED_ID)
    const cats = await listCategories()
    expect(cats.find((c) => c.id === UNCATEGORIZED_ID)).toBeDefined()
  })

  it('重命名分类只改名字，不动归属', async () => {
    const parent = await createCategory('父', null)
    const child = await createCategory('旧名', parent)
    await renameCategory(child, '新名')

    const cat = (await listCategories()).find((c) => c.id === child)
    expect(cat?.name).toBe('新名')
    expect(cat?.parentId).toBe(parent)
  })
})

describe('分类移动', () => {
  it('可以移动到另一个分类下', async () => {
    const a = await createCategory('A', null)
    const b = await createCategory('B', null)
    const move = await createCategory('待搬', a)

    await moveCategory(move, b)
    expect((await listCategories()).find((c) => c.id === move)?.parentId).toBe(b)
  })

  it('拒绝把分类移到自己或自己的子孙下（否则分类树会成环，递归渲染直接爆栈）', async () => {
    const root = await createCategory('根', null)
    const mid = await createCategory('中', root)
    const leaf = await createCategory('叶', mid)

    await moveCategory(root, root) // 移到自己
    await moveCategory(root, leaf) // 移到自己的子孙

    const cats = await listCategories()
    expect(cats.find((c) => c.id === root)?.parentId).toBeNull()
  })
})

describe('分类计数', () => {
  it('父分类的计数包含所有子孙的菜谱（FR-2.6）', async () => {
    const root = await createCategory('根', null)
    const a = await createCategory('A', root)
    const b = await createCategory('B', root)
    await createRecipe(draft('甲', a))
    await createRecipe(draft('乙', b))
    await createRecipe(draft('丙', b))

    const counts = await categoryCounts()
    expect(counts.get(b)).toBe(2)
    expect(counts.get(root)).toBe(3)
  })

  it('软删除的菜谱不计入分类数量', async () => {
    const root = await createCategory('根', null)
    const id = await createRecipe(draft('甲', root))
    expect((await categoryCounts()).get(root)).toBe(1)

    await db.recipes.update(id, { deletedAt: Date.now() })
    expect((await categoryCounts()).get(root)).toBe(0)
  })
})

describe('标签管理', () => {
  it('同维度同名标签复用已有记录，不产生重复（FR-2.10）', async () => {
    const a = await createTag('川菜', 'cuisine')
    const b = await createTag('川菜', 'cuisine')
    expect(a).toBe(b)

    const cuisineTags = (await listTags()).filter((t) => t.name === '川菜')
    expect(cuisineTags).toHaveLength(1)
  })

  it('同名标签允许存在于不同维度（这是「川菜」既是菜系也是口味的必要前提）', async () => {
    const a = await createTag('川菜', 'cuisine')
    const b = await createTag('川菜', 'taste')
    expect(a).not.toBe(b)
    expect((await listTags()).filter((t) => t.name === '川菜')).toHaveLength(2)
  })

  it('合并标签时菜谱上的关联自动迁移，原标签被删除（FR-2.11）', async () => {
    const from = await createTag('辣', 'taste')
    const to = await createTag('辛辣', 'taste')
    const r1 = await createRecipe(draft('水煮肉片', UNCATEGORIZED_ID, [from]))
    const r2 = await createRecipe(draft('麻婆豆腐', UNCATEGORIZED_ID, [from, to]))

    await mergeTags(from, to)

    const tags = await listTags()
    expect(tags.find((t) => t.id === from)).toBeUndefined()

    const recipes = await listRecipes()
    expect(recipes.find((r) => r.id === r1)?.tagIds).toEqual([to])
    // 本来两个标签都有的，合并后只留一个，不能出现重复 id
    expect(recipes.find((r) => r.id === r2)?.tagIds).toEqual([to])
  })

  it('合并后目标标签的使用频次按合并结果重算', async () => {
    const from = await createTag('A', 'custom')
    const to = await createTag('B', 'custom')
    await createRecipe(draft('菜一', UNCATEGORIZED_ID, [from]))
    await createRecipe(draft('菜二', UNCATEGORIZED_ID, [from]))
    await recomputeAllTagUsage()

    await mergeTags(from, to)

    const toTag = (await listTags()).find((t) => t.id === to)
    expect(toTag?.usageCount).toBe(2)
  })

  it('给不存在的菜谱用标签也没关系——合并/删除只扫真正引用它的菜谱', async () => {
    const from = await createTag('孤立', 'custom')
    const to = await createTag('目标', 'custom')
    await expect(mergeTags(from, to)).resolves.toBeUndefined()
    expect((await listTags()).find((t) => t.id === from)).toBeUndefined()
  })

  it('删除标签会把菜谱上的关联一并摘掉，不留悬空 id（否则详情页会渲染出空标签）', async () => {
    const tag = await createTag('待删', 'custom')
    const keep = await createTag('保留', 'custom')
    const rid = await createRecipe(draft('一道菜', UNCATEGORIZED_ID, [tag, keep]))

    await deleteTag(tag)

    const recipe = (await listRecipes()).find((r) => r.id === rid)
    expect(recipe?.tagIds).toEqual([keep])
  })

  it('重命名不产生重复记录，只改 name', async () => {
    const id = await createTag('旧标签', 'custom')
    await renameTag(id, '新标签')

    const tags = await listTags()
    expect(tags.find((t) => t.id === id)?.name).toBe('新标签')
    expect(tags.filter((t) => t.name === '旧标签')).toHaveLength(0)
  })
})

describe('按标签 / 分类筛选菜谱（FR-2.13 / FR-2.5）', () => {
  it('多标签「同时满足」是交集', async () => {
    const spicy = await createTag('辣', 'taste')
    const sichuan = await createTag('川菜', 'cuisine')
    const onlySpicy = await createRecipe(draft('辣但不川', UNCATEGORIZED_ID, [spicy]))
    const both = await createRecipe(draft('又辣又川', UNCATEGORIZED_ID, [spicy, sichuan]))

    const hit = await listRecipes({ tagIds: [spicy, sichuan], tagMode: 'and' })
    expect(hit.map((r) => r.id)).toEqual([both])
    expect(hit.map((r) => r.id)).not.toContain(onlySpicy)
  })

  it('多标签「任一即可」是并集', async () => {
    const spicy = await createTag('辣', 'taste')
    const sichuan = await createTag('川菜', 'cuisine')
    const a = await createRecipe(draft('辣但不川', UNCATEGORIZED_ID, [spicy]))
    const b = await createRecipe(draft('又辣又川', UNCATEGORIZED_ID, [spicy, sichuan]))
    const c = await createRecipe(draft('川但不辣', UNCATEGORIZED_ID, [sichuan]))
    await createRecipe(draft('无关', UNCATEGORIZED_ID, []))

    const hit = await listRecipes({ tagIds: [spicy, sichuan], tagMode: 'or' })
    expect(new Set(hit.map((r) => r.id))).toEqual(new Set([a, b, c]))
  })

  it('选中父分类默认包含子孙分类的菜谱；关掉开关后只出直属于该分类的（FR-2.5）', async () => {
    const root = await createCategory('根', null)
    const child = await createCategory('子', root)
    const inRoot = await createRecipe(draft('根上的菜', root))
    const inChild = await createRecipe(draft('子上的菜', child))

    const withSubs = await listRecipes({ categoryId: root })
    expect(new Set(withSubs.map((r) => r.id))).toEqual(new Set([inRoot, inChild]))

    const withoutSubs = await listRecipes({ categoryId: root, includeSubcategories: false })
    expect(withoutSubs.map((r) => r.id)).toEqual([inRoot])
  })
})

describe('按食材反查菜谱（FR-4.2）', () => {
  async function withIngredients(name: string, names: string[]): Promise<string> {
    const d = draft(name, UNCATEGORIZED_ID)
    d.ingredients = names.map((n, i) => ({
      kind: 'main' as const,
      name: n,
      normalizedId: null,
      amount: null,
      amountText: '适量',
      unit: null,
      note: null,
      order: i,
    }))
    return createRecipe(d)
  }

  it('命中任一食材即可出现，命中越多排越前', async () => {
    const both = await withIngredients('番茄炒蛋', ['番茄', '鸡蛋'])
    const oneTomato = await withIngredients('番茄汤', ['番茄', '水'])
    await withIngredients('清炒时蔬', ['青菜'])

    const hit = await listRecipes({ ingredientKeyword: '番茄 鸡蛋' })
    expect(hit.map((r) => r.id)).toEqual([both, oneTomato])
  })

  it('多个关键词之间是「都算命中数」，不是必须全中', async () => {
    const onlyEgg = await withIngredients('蒸蛋', ['鸡蛋'])
    const hit = await listRecipes({ ingredientKeyword: '番茄 鸡蛋' })
    expect(hit.map((r) => r.id)).toEqual([onlyEgg])
  })

  it('一个都没命中就不返回', async () => {
    await withIngredients('清炒时蔬', ['青菜'])
    const hit = await listRecipes({ ingredientKeyword: '和牛' })
    expect(hit).toEqual([])
  })
})
