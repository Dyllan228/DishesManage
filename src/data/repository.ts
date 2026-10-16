/**
 * 数据访问抽象层
 *
 * ⚠️ **UI 层唯一的数据入口**（docs/决策记录.md D-002）。
 * UI 组件不得直接 import Dexie / db，全部经由本模块导出的 `repo` 对象。
 * V2 接入云端同步时，只需替换本文件的实现，UI 无需改动。
 *
 * 约定：
 * - 所有写操作自动维护 `updatedAt`
 * - 删除菜谱为软删除（FR-5.8），需显式 purge 才真删
 */

import type { Table } from 'dexie'
import { db } from './db'
import rawDict from './ingredientDict.json'
import {
  buildSeedCategories,
  buildSeedTags,
  UNCATEGORIZED_ID,
} from './seed'
import { buildDictIndex, normalizeIngredient, type DictIndex } from '@/domain/normalize'
import type { ParsedIngredient } from '@/domain/parse'
import {
  buildShoppingItems,
  exportAsText,
  type MergeInput,
  type MergedShopItem,
} from '@/domain/shoppingList'
import type {
  AppSetting,
  BlobRecord,
  Category,
  CookHistoryItem,
  Difficulty,
  ID,
  Ingredient,
  IngredientDict,
  MenuItem,
  MenuItemStatus,
  Note,
  Recipe,
  RecipeDetail,
  RecipeDraft,
  ShoppingCategory,
  ShoppingItem,
  Step,
  StockStatus,
  Tag,
  TagDimension,
} from '@/types/models'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function uid(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}_${rnd}` : rnd
}

export function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---------------------------------------------------------------------------
// 初始化：首次启动写入种子数据
// ---------------------------------------------------------------------------

let dictIndexCache: DictIndex | null = null

export async function initDatabase(): Promise<void> {
  const catCount = await db.categories.count()
  if (catCount === 0) {
    await db.categories.bulkAdd(buildSeedCategories())
  }
  const tagCount = await db.tags.count()
  if (tagCount === 0) {
    await db.tags.bulkAdd(buildSeedTags())
  }
  const dictCount = await db.ingredientDict.count()
  if (dictCount === 0) {
    const now = Date.now()
    await db.ingredientDict.bulkAdd(
      (rawDict.items as Array<{ name: string; category: ShoppingCategory; aliases: string[]; defaultUnit: string | null }>).map(
        (r, i) => ({
          id: `dict_${i}`,
          name: r.name,
          category: r.category,
          aliases: r.aliases ?? [],
          defaultUnit: r.defaultUnit ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    )
  }
  dictIndexCache = null
}

/** 食材字典索引（解析与归一化用），带内存缓存 */
export async function getDictIndex(): Promise<DictIndex> {
  if (dictIndexCache) return dictIndexCache
  const items = await db.ingredientDict.toArray()
  dictIndexCache = buildDictIndex(items)
  return dictIndexCache
}

/** 字典变更后调用，使缓存失效 */
export function invalidateDictCache(): void {
  dictIndexCache = null
}

// ---------------------------------------------------------------------------
// 菜谱
// ---------------------------------------------------------------------------

export interface RecipeFilter {
  /** 'all' 或具体分类 id；默认 all */
  categoryId?: ID | 'all'
  /** 分类筛选时是否包含子孙分类（FR-2.5），默认 true */
  includeSubcategories?: boolean
  tagIds?: ID[]
  /** 多标签筛选模式（FR-2.13），默认交集 */
  tagMode?: 'and' | 'or'
  /** 关键词搜索：菜名 + 标签 + 步骤（FR-4.1） */
  keyword?: string
  favorite?: boolean
  /** 按食材反向搜索（FR-4.2） */
  ingredientKeyword?: string
  sort?: 'recent' | 'name' | 'cookCount' | 'lastCooked'
}

async function descendantCategoryIds(rootId: ID): Promise<ID[]> {
  const all = await db.categories.toArray()
  const out: ID[] = [rootId]
  let frontier = [rootId]
  while (frontier.length) {
    const next = all.filter((c) => c.parentId && frontier.includes(c.parentId)).map((c) => c.id)
    if (!next.length) break
    out.push(...next)
    frontier = next
  }
  return [...new Set(out)]
}

/** 列出菜谱（默认排除软删除） */
export async function listRecipes(filter: RecipeFilter = {}): Promise<Recipe[]> {
  const {
    categoryId = 'all',
    includeSubcategories = true,
    tagIds = [],
    tagMode = 'and',
    keyword = '',
    favorite,
    ingredientKeyword = '',
    sort = 'recent',
  } = filter

  let list = await db.recipes.filter((r) => r.deletedAt === null).toArray()

  if (categoryId !== 'all') {
    const ids = includeSubcategories ? await descendantCategoryIds(categoryId) : [categoryId]
    list = list.filter((r) => ids.includes(r.categoryId))
  }

  if (tagIds.length > 0) {
    list =
      tagMode === 'and'
        ? list.filter((r) => tagIds.every((t) => r.tagIds.includes(t)))
        : list.filter((r) => tagIds.some((t) => r.tagIds.includes(t)))
  }

  if (favorite) list = list.filter((r) => r.favorite)

  const kw = keyword.trim().toLowerCase()
  if (kw) {
    // 匹配菜名 / 小贴士 / 步骤文本（FR-4.1）
    const stepRows = await db.steps.toArray()
    const stepsByRecipe = new Map<ID, string>()
    for (const s of stepRows) {
      stepsByRecipe.set(s.recipeId, (stepsByRecipe.get(s.recipeId) ?? '') + ' ' + s.text)
    }
    list = list.filter((r) => {
      const hay = `${r.name} ${r.intro ?? ''} ${r.tips ?? ''} ${stepsByRecipe.get(r.id) ?? ''}`.toLowerCase()
      return hay.includes(kw)
    })
  }

  const ikw = ingredientKeyword.trim().toLowerCase()
  if (ikw) {
    // 反向搜食材：命中越多排越前（FR-4.2）
    const terms = ikw.split(/\s+/).filter(Boolean)
    const ingredients = await db.ingredients.toArray()
    const byRecipe = new Map<ID, string[]>()
    for (const ing of ingredients) {
      const arr = byRecipe.get(ing.recipeId) ?? []
      arr.push(ing.name.toLowerCase())
      byRecipe.set(ing.recipeId, arr)
    }
    const scored = list
      .map((r) => {
        const names = byRecipe.get(r.id) ?? []
        const hits = terms.filter((t) => names.some((n) => n.includes(t))).length
        return { r, hits }
      })
      .filter((x) => x.hits > 0)
    scored.sort((a, b) => b.hits - a.hits)
    return scored.map((x) => x.r)
  }

  return sortRecipes(list, sort)
}

function sortRecipes(list: Recipe[], sort: RecipeFilter['sort']): Recipe[] {
  const arr = [...list]
  switch (sort) {
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    case 'cookCount':
      return arr.sort((a, b) => b.cookCount - a.cookCount)
    case 'lastCooked':
      return arr.sort((a, b) => (b.lastCookedAt ?? 0) - (a.lastCookedAt ?? 0))
    case 'recent':
    default:
      return arr.sort((a, b) => b.createdAt - a.createdAt)
  }
}

export async function getRecipeDetail(id: ID): Promise<RecipeDetail | null> {
  const recipe = await db.recipes.get(id)
  if (!recipe) return null
  const [ingredients, steps, notes] = await Promise.all([
    db.ingredients.where('recipeId').equals(id).sortBy('order'),
    db.steps.where('recipeId').equals(id).sortBy('order'),
    db.notes.where('recipeId').equals(id).toArray(),
  ])
  return { recipe, ingredients, steps, notes }
}

export async function createRecipe(draft: RecipeDraft): Promise<ID> {
  const now = Date.now()
  const id = uid('rcp')
  const recipe: Recipe = {
    id,
    name: draft.name.trim(),
    coverBlobId: null,
    intro: draft.intro,
    categoryId: draft.categoryId || UNCATEGORIZED_ID,
    tagIds: draft.tagIds,
    servings: draft.servings,
    durationMin: draft.durationMin,
    difficulty: draft.difficulty,
    sourceType: draft.sourceType,
    sourceText: draft.sourceText,
    tips: draft.tips,
    favorite: false,
    cookCount: 0,
    lastCookedAt: null,
    rating: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }

  await db.transaction('rw', db.recipes, db.ingredients, db.steps, db.tags, async () => {
    await db.recipes.add(recipe)
    await db.ingredients.bulkAdd(
      draft.ingredients.map((ing, i) => ({ ...ing, id: uid('ing'), recipeId: id, order: i, createdAt: now, updatedAt: now })),
    )
    await db.steps.bulkAdd(
      draft.steps.map((s, i) => ({ ...s, id: uid('stp'), recipeId: id, order: i, createdAt: now, updatedAt: now })),
    )
    await recomputeTagUsageTx(draft.tagIds)
  })

  return id
}

export async function updateRecipe(id: ID, draft: RecipeDraft): Promise<void> {
  const now = Date.now()
  const existing = await db.recipes.get(id)
  if (!existing) return

  await db.transaction('rw', db.recipes, db.ingredients, db.steps, db.tags, async () => {
    await db.recipes.update(id, {
      name: draft.name.trim(),
      intro: draft.intro,
      categoryId: draft.categoryId,
      tagIds: draft.tagIds,
      servings: draft.servings,
      durationMin: draft.durationMin,
      difficulty: draft.difficulty,
      sourceType: draft.sourceType,
      sourceText: draft.sourceText,
      tips: draft.tips,
      updatedAt: now,
    })

    // 简单策略：整体替换食材与步骤（数量级很小，无需增量 diff）
    await db.ingredients.where('recipeId').equals(id).delete()
    await db.steps.where('recipeId').equals(id).delete()
    await db.ingredients.bulkAdd(
      draft.ingredients.map((ing, i) => ({ ...ing, id: uid('ing'), recipeId: id, order: i, createdAt: now, updatedAt: now })),
    )
    await db.steps.bulkAdd(
      draft.steps.map((s, i) => ({ ...s, id: uid('stp'), recipeId: id, order: i, createdAt: now, updatedAt: now })),
    )
    await recomputeTagUsageTx([...existing.tagIds, ...draft.tagIds])
  })
}

/** 软删除（FR-5.8） */
export async function deleteRecipe(id: ID): Promise<void> {
  await db.recipes.update(id, { deletedAt: Date.now(), updatedAt: Date.now() })
}

export async function restoreRecipe(id: ID): Promise<void> {
  await db.recipes.update(id, { deletedAt: null, updatedAt: Date.now() })
}

/** 真删除（回收站清空） */
export async function purgeRecipe(id: ID): Promise<void> {
  // 先把这道菜可能用到的图片 id 记下来，删完引用后再判断它们是否真的没人用了
  const candidateImages: ID[] = []
  const recipe = await db.recipes.get(id)
  if (recipe?.coverBlobId) candidateImages.push(recipe.coverBlobId)
  for (const step of await db.steps.where('recipeId').equals(id).toArray()) {
    if (step.imageBlobId) candidateImages.push(step.imageBlobId)
  }

  await db.transaction('rw', db.recipes, db.ingredients, db.steps, db.notes, db.menuItems, async () => {
    await db.ingredients.where('recipeId').equals(id).delete()
    await db.steps.where('recipeId').equals(id).delete()
    await db.notes.where('recipeId').equals(id).delete()
    await db.menuItems.where('recipeId').equals(id).delete()
    await db.recipes.delete(id)
  })

  // 不在这里回收的话，清空回收站会留下一堆谁也看不见的图，白占配额（FR-5.7）
  for (const blobId of candidateImages) {
    if (!(await isImageReferenced(blobId))) await db.blobs.delete(blobId)
  }
}

export async function listDeletedRecipes(): Promise<Recipe[]> {
  return db.recipes.filter((r) => r.deletedAt !== null).toArray()
}

export async function toggleFavorite(id: ID): Promise<void> {
  const r = await db.recipes.get(id)
  if (!r) return
  await db.recipes.update(id, { favorite: !r.favorite, updatedAt: Date.now() })
}

export async function addNote(recipeId: ID, text: string, cookedOn: string | null = todayKey()): Promise<void> {
  const now = Date.now()
  await db.notes.add({ id: uid('note'), recipeId, text, cookedOn, createdAt: now, updatedAt: now })
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

export async function listCategories(): Promise<Category[]> {
  const all = await db.categories.toArray()
  return all.sort((a, b) => a.order - b.order)
}

export async function createCategory(name: string, parentId: ID | null): Promise<ID> {
  const now = Date.now()
  const siblings = (await db.categories.toArray()).filter((c) => c.parentId === parentId)
  const id = uid('cat')
  await db.categories.add({
    id,
    name: name.trim(),
    parentId,
    order: siblings.length,
    icon: null,
    isSystem: false,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

export async function renameCategory(id: ID, name: string): Promise<void> {
  await db.categories.update(id, { name: name.trim(), updatedAt: Date.now() })
}

export async function moveCategory(id: ID, newParentId: ID | null): Promise<void> {
  // 防止把节点移动到自己或自己的子孙下，形成环
  const forbidden = await descendantCategoryIds(id)
  if (newParentId && forbidden.includes(newParentId)) return
  await db.categories.update(id, { parentId: newParentId, updatedAt: Date.now() })
}

/** 删除分类：子分类与菜谱**回到上级**，不连带删除（FR-2.4） */
export async function deleteCategory(id: ID): Promise<void> {
  const cat = await db.categories.get(id)
  if (!cat || cat.isSystem) return
  const now = Date.now()
  await db.transaction('rw', db.categories, db.recipes, async () => {
    const children = (await db.categories.toArray()).filter((c) => c.parentId === id)
    for (const child of children) {
      await db.categories.update(child.id, { parentId: cat.parentId, updatedAt: now })
    }
    const fallback = cat.parentId ?? UNCATEGORIZED_ID
    const recipes = (await db.recipes.toArray()).filter((r) => r.categoryId === id)
    for (const r of recipes) {
      await db.recipes.update(r.id, { categoryId: fallback, updatedAt: now })
    }
    await db.categories.delete(id)
  })
}

/** 分类下的菜谱数量（FR-2.6，含子孙） */
export async function categoryCounts(): Promise<Map<ID, number>> {
  const [cats, recipes] = await Promise.all([db.categories.toArray(), db.recipes.toArray()])
  const live = recipes.filter((r) => r.deletedAt === null)
  const counts = new Map<ID, number>()
  const direct = new Map<ID, number>()
  for (const r of live) direct.set(r.categoryId, (direct.get(r.categoryId) ?? 0) + 1)

  // 自底向上累加子孙数量
  const childrenOf = new Map<ID | null, Category[]>()
  for (const c of cats) {
    const arr = childrenOf.get(c.parentId) ?? []
    arr.push(c)
    childrenOf.set(c.parentId, arr)
  }
  const compute = (cat: Category): number => {
    const kids = childrenOf.get(cat.id) ?? []
    const total = (direct.get(cat.id) ?? 0) + kids.reduce((s, k) => s + compute(k), 0)
    counts.set(cat.id, total)
    return total
  }
  for (const c of cats.filter((c) => c.parentId === null)) compute(c)
  return counts
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

export async function listTags(): Promise<Tag[]> {
  return db.tags.toArray()
}

export async function createTag(name: string, dimension: TagDimension): Promise<ID> {
  const trimmed = name.trim()
  const existing = await db.tags.filter((t) => t.name === trimmed && t.dimension === dimension).first()
  if (existing) return existing.id
  const now = Date.now()
  const id = uid('tag')
  await db.tags.add({ id, name: trimmed, dimension, color: null, usageCount: 0, createdAt: now, updatedAt: now })
  return id
}

/** 就地改名：只动 name 字段。同维度重名的情况由调用方先走 mergeTags，这里不查重。 */
export async function renameTag(id: ID, name: string): Promise<void> {
  await db.tags.update(id, { name: name.trim(), updatedAt: Date.now() })
}

export async function deleteTag(id: ID): Promise<void> {
  await db.transaction('rw', db.tags, db.recipes, async () => {
    const recipes = await db.recipes.filter((r) => r.tagIds.includes(id)).toArray()
    for (const r of recipes) {
      await db.recipes.update(r.id, { tagIds: r.tagIds.filter((t) => t !== id), updatedAt: Date.now() })
    }
    await db.tags.delete(id)
  })
}

/** 合并标签：原标签的关联自动迁移（FR-2.11） */
export async function mergeTags(fromId: ID, toId: ID): Promise<void> {
  if (fromId === toId) return
  const now = Date.now()
  await db.transaction('rw', db.tags, db.recipes, async () => {
    const recipes = await db.recipes.filter((r) => r.tagIds.includes(fromId)).toArray()
    for (const r of recipes) {
      const next = [...new Set(r.tagIds.map((t) => (t === fromId ? toId : t)))]
      await db.recipes.update(r.id, { tagIds: next, updatedAt: now })
    }
    await db.tags.delete(fromId)
    await recomputeTagUsageTx([toId])
  })
}

/** 重算标签使用频次（FR-2.12） */
async function recomputeTagUsageTx(tagIds: ID[]): Promise<void> {
  const recipes = await db.recipes.filter((r) => r.deletedAt === null).toArray()
  for (const tagId of new Set(tagIds)) {
    const count = recipes.filter((r) => r.tagIds.includes(tagId)).length
    await db.tags.update(tagId, { usageCount: count })
  }
}

export async function recomputeAllTagUsage(): Promise<void> {
  const tags = await db.tags.toArray()
  await recomputeTagUsageTx(tags.map((t) => t.id))
}

// ---------------------------------------------------------------------------
// 食材字典
// ---------------------------------------------------------------------------

export async function listDictItems(): Promise<IngredientDict[]> {
  const items = await db.ingredientDict.toArray()
  return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function upsertDictItem(
  item: { id?: ID; name: string; category: ShoppingCategory; aliases: string[]; defaultUnit: string | null },
): Promise<ID> {
  const now = Date.now()
  const id = item.id ?? uid('dict')
  const existing = await db.ingredientDict.get(id)
  await db.ingredientDict.put({
    id,
    name: item.name.trim(),
    category: item.category,
    aliases: item.aliases.map((a) => a.trim()).filter(Boolean),
    defaultUnit: item.defaultUnit,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  invalidateDictCache()
  return id
}

export async function deleteDictItem(id: ID): Promise<void> {
  await db.ingredientDict.delete(id)
  invalidateDictCache()
}

// ---------------------------------------------------------------------------
// 今日菜单（FR-3.1 ~ FR-3.9）
// ---------------------------------------------------------------------------

export interface MenuEntry {
  item: MenuItem
  recipe: Recipe
}

export async function listMenu(): Promise<MenuEntry[]> {
  const items = (await db.menuItems.toArray()).sort((a, b) => a.order - b.order)
  const out: MenuEntry[] = []
  for (const item of items) {
    const recipe = await db.recipes.get(item.recipeId)
    // 菜谱被软删除时，菜单里的残留项自动隐藏
    if (recipe && recipe.deletedAt === null) out.push({ item, recipe })
  }
  return out
}

/**
 * 按菜单项 id 取一条（制作模式进来时用）。
 *
 * 不复用 `listMenu().find(...)`：制作模式是从一个 id 直接进来的深链接，
 * 没必要把整个菜单连菜谱都读出来。返回 null 表示这条已经不在菜单里了
 * （用户可能在另一个标签页清空了菜单），页面要能优雅处理。
 */
export async function findMenuItem(id: ID): Promise<MenuEntry | null> {
  const item = await db.menuItems.get(id)
  if (!item) return null
  const recipe = await db.recipes.get(item.recipeId)
  if (!recipe || recipe.deletedAt !== null) return null
  return { item, recipe }
}

export async function addToMenu(recipeId: ID, multiplier = 1): Promise<void> {
  const existing = await db.menuItems.filter((m) => m.recipeId === recipeId).first()
  if (existing) {
    // 已点过则份量 +1 倍（FR-3.2 的「再来一份」语义），上限 5
    const next = Math.min(5, existing.multiplier + 1)
    await db.menuItems.update(existing.id, { multiplier: next, updatedAt: Date.now() })
    return
  }
  const now = Date.now()
  const count = await db.menuItems.count()
  await db.menuItems.add({
    id: uid('menu'),
    recipeId,
    multiplier,
    order: count,
    plannedStartAt: null,
    status: 'todo',
    createdAt: now,
    updatedAt: now,
  })
}

export async function setMenuMultiplier(id: ID, multiplier: number): Promise<void> {
  const clamped = Math.min(5, Math.max(0.5, Math.round(multiplier * 2) / 2))
  await db.menuItems.update(id, { multiplier: clamped, updatedAt: Date.now() })
}

export async function setMenuStatus(id: ID, status: MenuItemStatus): Promise<void> {
  await db.menuItems.update(id, { status, updatedAt: Date.now() })
}

export async function setMenuPlannedStart(id: ID, hhmm: string | null): Promise<void> {
  await db.menuItems.update(id, { plannedStartAt: hhmm, updatedAt: Date.now() })
}

export async function removeFromMenu(id: ID): Promise<void> {
  await db.menuItems.delete(id)
}

export async function clearMenu(): Promise<void> {
  await db.menuItems.clear()
}

/** 一键「再来一次」：把历史某天的菜重新加入今日菜单（FR-3.33） */
export async function reorderFromDate(date: string): Promise<number> {
  const rows = await db.cookHistory.where('date').equals(date).toArray()
  for (const r of rows) await addToMenu(r.recipeId, 1)
  return rows.length
}

// ---------------------------------------------------------------------------
// 备菜清单（FR-3.10 ~ FR-3.20）
// ---------------------------------------------------------------------------

/** 合并桶键 → 持久化行 id */
function shoppingRowId(date: string, itemKey: string): string {
  return `${date}|${itemKey}`
}

/**
 * 重新计算备菜清单并落库。
 *
 * 关键：清单是**派生数据**，但勾选状态要保留。做法是按 `itemKey` 匹配已有行，
 * 只刷新内容字段，不动 checked / stockStatus / isManual。
 */
export async function rebuildShoppingList(date = todayKey()): Promise<ShoppingItem[]> {
  const menu = await listMenu()
  const index = await getDictIndex()

  const inputs: MergeInput[] = []
  for (const entry of menu) {
    const ingredients = await db.ingredients.where('recipeId').equals(entry.recipe.id).sortBy('order')
    inputs.push({
      recipeId: entry.recipe.id,
      recipeName: entry.recipe.name,
      multiplier: entry.item.multiplier,
      ingredients,
    })
  }

  const merged = buildShoppingItems(inputs, index)

  const existing = await db.shoppingItems.where('date').equals(date).toArray()
  const existingByKey = new Map<string, ShoppingItem>()
  for (const row of existing) {
    if (!row.isManual) existingByKey.set(row.itemKey, row)
  }

  const now = Date.now()
  const seenKeys = new Set<string>()
  const rows: ShoppingItem[] = []

  merged.forEach((item, idx) => {
    // itemKey：归一化 id（或原始名）+ 单位。同一桶出现多行时补序号，保证确定性
    let key = `${item.normalizedId ?? item.name}|${item.unit ?? ''}`
    if (seenKeys.has(key)) key = `${key}#${idx}`
    seenKeys.add(key)

    const prev = existingByKey.get(key)
    rows.push({
      id: shoppingRowId(date, key),
      date,
      itemKey: key,
      name: item.name,
      normalizedId: item.normalizedId,
      amount: item.amount,
      unit: item.unit,
      amountText: item.amountText,
      category: item.category,
      checked: prev?.checked ?? false,
      stockStatus: prev?.stockStatus ?? 'need',
      sourceRecipeIds: item.sourceRecipeIds,
      isManual: false,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    })
  })

  // 手动追加项原样保留（FR-3.19）
  const manual = existing.filter((row) => row.isManual)
  for (const m of manual) rows.push(m)

  await db.transaction('rw', db.shoppingItems, async () => {
    const keepIds = new Set(rows.map((r) => r.id))
    const stale = existing.filter((r) => !keepIds.has(r.id)).map((r) => r.id)
    if (stale.length) await db.shoppingItems.bulkDelete(stale)
    await db.shoppingItems.bulkPut(rows)
  })

  return sortShoppingRows(rows)
}

const CATEGORY_ORDER_LOCAL: ShoppingCategory[] = ['meat', 'veg', 'staple', 'seasoning', 'other']

export function sortShoppingRows(rows: ShoppingItem[]): ShoppingItem[] {
  return [...rows].sort((a, b) => {
    const ca = CATEGORY_ORDER_LOCAL.indexOf(a.category)
    const cb = CATEGORY_ORDER_LOCAL.indexOf(b.category)
    if (ca !== cb) return ca - cb
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/** 读取已持久化的清单（不重算） */
export async function getShoppingList(date = todayKey()): Promise<ShoppingItem[]> {
  const rows = await db.shoppingItems.where('date').equals(date).toArray()
  return sortShoppingRows(rows)
}

export async function toggleShoppingChecked(id: ID): Promise<void> {
  const row = await db.shoppingItems.get(id)
  if (!row) return
  await db.shoppingItems.update(id, { checked: !row.checked, updatedAt: Date.now() })
}

export async function setStockStatus(id: ID, stockStatus: StockStatus): Promise<void> {
  await db.shoppingItems.update(id, { stockStatus, updatedAt: Date.now() })
}

export async function setAllChecked(date: string, checked: boolean): Promise<void> {
  const rows = await db.shoppingItems.where('date').equals(date).toArray()
  await db.shoppingItems.bulkPut(rows.map((r) => ({ ...r, checked, updatedAt: Date.now() })))
}

/** 手动追加清单项（FR-3.19） */
export async function addManualShoppingItem(
  name: string,
  category: ShoppingCategory = 'other',
  date = todayKey(),
): Promise<ID> {
  const now = Date.now()
  const id = uid('shop')
  const key = `manual:${name.trim()}|${id}`
  await db.shoppingItems.add({
    id: shoppingRowId(date, key),
    date,
    itemKey: key,
    name: name.trim(),
    normalizedId: null,
    amount: null,
    unit: null,
    amountText: null,
    category,
    checked: false,
    stockStatus: 'need',
    sourceRecipeIds: [],
    isManual: true,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

export async function deleteShoppingItem(id: ID): Promise<void> {
  await db.shoppingItems.delete(id)
}

/** 生成清单文本，供复制/分享（FR-3.16） */
export async function buildShoppingText(date = todayKey()): Promise<string> {
  const rows = await getShoppingList(date)
  const grouped = new Map<ShoppingCategory, ShoppingItem[]>()
  for (const r of rows) {
    const arr = grouped.get(r.category) ?? []
    arr.push(r)
    grouped.set(r.category, arr)
  }
  const label: Record<ShoppingCategory, string> = {
    meat: '肉蛋水产',
    veg: '蔬菜',
    staple: '主食干货',
    seasoning: '调料',
    other: '其他',
  }
  const lines: string[] = [`【备菜清单 · ${date}】`, '']
  for (const cat of CATEGORY_ORDER_LOCAL) {
    const items = grouped.get(cat)
    if (!items?.length) continue
    lines.push(`— ${label[cat]} —`)
    for (const it of items) {
      const amount = it.amountText ?? (it.amount !== null ? `${it.amount}${it.unit ?? ''}` : '')
      lines.push(`  ${it.checked ? '☑' : '☐'} ${it.name}  ${amount}`.trimEnd())
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 临时合并（不落库），用于详情页展示「备菜清单会合并成什么」之类的预览。
 * 复用 domain 层的纯函数，避免重复实现。
 */
export async function previewMergedFromRecipes(
  entries: Array<{ recipeId: ID; multiplier: number }>,
): Promise<MergedShopItem[]> {
  const index = await getDictIndex()
  const inputs: MergeInput[] = []
  for (const e of entries) {
    const recipe = await db.recipes.get(e.recipeId)
    if (!recipe) continue
    const ingredients = await db.ingredients.where('recipeId').equals(e.recipeId).sortBy('order')
    inputs.push({ recipeId: recipe.id, recipeName: recipe.name, multiplier: e.multiplier, ingredients })
  }
  return buildShoppingItems(inputs, index)
}

// 供 UI 复用的导出函数（避免 UI 直接依赖 domain 内部）
export { exportAsText }

/** 按名字（忽略大小写与空白）找分类，用于把解析建议的分类名翻成 id */
export async function findCategoryByName(name: string): Promise<Category | null> {
  const target = name.trim()
  if (!target) return null
  const all = await db.categories.toArray()
  return all.find((c) => c.name === target) ?? null
}

/** 按名字+维度找标签，没有就建一个。解析建议落库时用（FR-1.16） */
export async function ensureTag(name: string, dimension: TagDimension): Promise<ID> {
  const trimmed = name.trim()
  const existing = await db.tags.filter((t) => t.name === trimmed && t.dimension === dimension).first()
  if (existing) return existing.id
  return createTag(trimmed, dimension)
}

/**
 * 用内置字典给解析出来的食材补上归一化信息。
 * LLM 返回的 normalizedId 一律不可信，必须本地重算，否则清单合并会错。
 */
export async function normalizeParsedIngredients(
  items: ParsedIngredient[],
): Promise<ParsedIngredient[]> {
  const index = await getDictIndex()
  return items.map((item) => {
    const norm = normalizeIngredient(item.name, index)
    return {
      ...item,
      name: norm.matched ? norm.displayName : item.name,
      normalizedId: norm.dict?.id ?? null,
      canonicalName: norm.dict?.name ?? null,
      category: norm.dict?.category ?? 'other',
    }
  })
}

// ---------------------------------------------------------------------------
// 图片（FR-1.19 ~ FR-1.23）
// ---------------------------------------------------------------------------

/**
 * 存一张处理好的图。相同 hash 直接复用已有记录，不重复占空间。
 * 返回 blobId 与是否命中已有记录（调用方据此决定要不要删掉刚生成的新 Blob）。
 */
export async function putImage(img: {
  blob: Blob
  thumbBlob: Blob | null
  mimeType: string
  width: number
  height: number
  size: number
  hash: string
}): Promise<{ id: ID; deduped: boolean }> {
  const existing = await db.blobs.where('hash').equals(img.hash).first()
  if (existing) return { id: existing.id, deduped: true }

  const id = uid('img')
  await db.blobs.add({
    id,
    blob: img.blob,
    thumbBlob: img.thumbBlob,
    mimeType: img.mimeType,
    width: img.width,
    height: img.height,
    size: img.size,
    hash: img.hash,
    createdAt: Date.now(),
  })
  return { id, deduped: false }
}

export async function getImage(id: ID): Promise<BlobRecord | null> {
  return (await db.blobs.get(id)) ?? null
}

export async function getImageBlob(id: ID): Promise<Blob | null> {
  const row = await db.blobs.get(id)
  return row?.blob ?? null
}

export async function getThumbBlob(id: ID): Promise<Blob | null> {
  const row = await db.blobs.get(id)
  return row?.thumbBlob ?? row?.blob ?? null
}

/** 从菜谱的封面字段反推是否还有人在用这张图 */
async function isImageReferenced(blobId: ID, exceptRecipeId?: ID): Promise<boolean> {
  const recipes = await db.recipes.toArray()
  if (recipes.some((r) => r.coverBlobId === blobId && r.id !== exceptRecipeId)) return true
  const steps = await db.steps.toArray()
  return steps.some((s) => s.imageBlobId === blobId)
}

/** 换封面（传 null 表示移除） */
export async function setRecipeCover(recipeId: ID, blobId: ID | null): Promise<void> {
  const recipe = await db.recipes.get(recipeId)
  if (!recipe) return
  const previous = recipe.coverBlobId
  await db.recipes.update(recipeId, { coverBlobId: blobId, updatedAt: Date.now() })
  // 旧图没人用了就顺手回收，避免 IndexedDB 越用越胖（FR-5.7）
  if (previous && previous !== blobId && !(await isImageReferenced(previous, recipeId))) {
    await db.blobs.delete(previous)
  }
}

export async function setStepImage(stepId: ID, blobId: ID | null): Promise<void> {
  await db.steps.update(stepId, { imageBlobId: blobId, updatedAt: Date.now() })
}

/** 删掉没有任何引用的图片；返回清掉的张数与释放的字节数 */
export async function gcImages(): Promise<{ removed: number; freedBytes: number }> {
  const [blobs, recipes, steps] = await Promise.all([
    db.blobs.toArray(),
    db.recipes.toArray(),
    db.steps.toArray(),
  ])
  const used = new Set<ID>()
  for (const r of recipes) if (r.coverBlobId) used.add(r.coverBlobId)
  for (const s of steps) if (s.imageBlobId) used.add(s.imageBlobId)

  const orphans = blobs.filter((b) => !used.has(b.id))
  if (orphans.length === 0) return { removed: 0, freedBytes: 0 }

  const freedBytes = orphans.reduce((s, b) => s + b.size + (b.thumbBlob?.size ?? 0), 0)
  await db.blobs.bulkDelete(orphans.map((b) => b.id))
  return { removed: orphans.length, freedBytes }
}

export async function imageStats(): Promise<{ count: number; bytes: number }> {
  const blobs = await db.blobs.toArray()
  return {
    count: blobs.length,
    bytes: blobs.reduce((s, b) => s + b.size + (b.thumbBlob?.size ?? 0), 0),
  }
}

// ---------------------------------------------------------------------------
// 存储配额（FR-5.6 / FR-5.7）
// ---------------------------------------------------------------------------

export interface StorageInfo {
  usage: number
  quota: number
  /** 已用比例 0-1；浏览器不给数据时为 null */
  ratio: number | null
  persisted: boolean
  supported: boolean
}

export async function getStorageInfo(): Promise<StorageInfo> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usage: 0, quota: 0, ratio: null, persisted: false, supported: false }
  }
  const est = await navigator.storage.estimate()
  const usage = est.usage ?? 0
  const quota = est.quota ?? 0
  let persisted = false
  try {
    persisted = (await navigator.storage.persisted?.()) ?? false
  } catch {
    persisted = false
  }
  return { usage, quota, ratio: quota > 0 ? usage / quota : null, persisted, supported: true }
}

/** 申请持久化存储，防止浏览器在空间紧张时把用户的数据清掉（FR-5.6） */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 回收站（FR-5.8）
// ---------------------------------------------------------------------------

export const TRASH_RETENTION_DAYS = 30

/** 清掉超过保留期的软删除菜谱；返回真删了几道 */
export async function purgeExpiredTrash(days = TRASH_RETENTION_DAYS): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const expired = (await db.recipes.toArray()).filter((r) => r.deletedAt !== null && r.deletedAt < cutoff)
  for (const r of expired) await purgeRecipe(r.id)
  if (expired.length > 0) await gcImages()
  return expired.length
}

// ---------------------------------------------------------------------------
// 全量导出 / 导入（FR-5.1 / FR-5.3）
// ---------------------------------------------------------------------------

export interface BackupBlob {
  id: ID
  mimeType: string
  width: number
  height: number
  size: number
  hash: string
  createdAt: number
  /** base64 data URL，便于 JSON 自包含 */
  dataUrl: string
  thumbDataUrl: string | null
}

export interface BackupData {
  format: 'dishes-manage-backup'
  version: number
  schemaVersion: number
  exportedAt: number
  appVersion: string
  counts: Record<string, number>
  data: {
    recipes: Recipe[]
    ingredients: Ingredient[]
    steps: Step[]
    notes: Note[]
    categories: Category[]
    tags: Tag[]
    menuItems: MenuItem[]
    shoppingItems: ShoppingItem[]
    ingredientDict: IngredientDict[]
    cookHistory: CookHistoryItem[]
    settings: AppSetting[]
  }
  /** 导出时选择「不含图片」则为空数组（FR-5.4） */
  images: BackupBlob[]
}

export const BACKUP_VERSION = 1
export const SCHEMA_VERSION = 1

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 0x3f]
  }
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const pad = /(=*)$/.exec(b64)?.[1].length ?? 0
  // 长度按 4 的整倍数算（不足补 'A'），这样才能用 (n*3/4 - pad) 得出字节数
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, 'A')
  const out = new Uint8Array((padded.length * 3) / 4 - pad)
  const idx = (ch: string) => B64_CHARS.indexOf(ch)
  let p = 0
  for (let i = 0; i < padded.length; i += 4) {
    const n =
      (idx(padded[i]) << 18) | (idx(padded[i + 1]) << 12) | ((idx(padded[i + 2]) & 63) << 6) | (idx(padded[i + 3]) & 63)
    if (p < out.length) out[p++] = (n >> 16) & 0xff
    if (p < out.length) out[p++] = (n >> 8) & 0xff
    if (p < out.length) out[p++] = n & 0xff
  }
  return out
}

/**
 * 手写 base64 而不是用 FileReader：FileReader 只在浏览器里有，
 * 而备份的序列化逻辑我想在 node 测试里也能端到端跑一遍（见 backup.test.ts）。
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('图片数据格式不对（缺少 data URL 的逗号分隔）')
  const meta = dataUrl.slice(0, comma)
  const mime = /^data:([^;,]*)/.exec(meta)?.[1] || 'application/octet-stream'
  return new Blob([base64ToBytes(dataUrl.slice(comma + 1)) as unknown as BlobPart], { type: mime })
}

/** 全量导出（FR-5.1）。includeImages 为 false 时跳过图片（FR-5.4） */
export async function dumpAll(includeImages = true): Promise<BackupData> {
  const [
    recipes, ingredients, steps, notes, categories, tags,
    menuItems, shoppingItems, ingredientDict, cookHistory, settings,
  ] = await Promise.all([
    db.recipes.toArray(),
    db.ingredients.toArray(),
    db.steps.toArray(),
    db.notes.toArray(),
    db.categories.toArray(),
    db.tags.toArray(),
    db.menuItems.toArray(),
    db.shoppingItems.toArray(),
    db.ingredientDict.toArray(),
    db.cookHistory.toArray(),
    db.settings.toArray(),
  ])

  const images: BackupBlob[] = []
  if (includeImages) {
    for (const row of await db.blobs.toArray()) {
      images.push({
        id: row.id,
        mimeType: row.mimeType,
        width: row.width,
        height: row.height,
        size: row.size,
        hash: row.hash,
        createdAt: row.createdAt,
        dataUrl: await blobToDataUrl(row.blob),
        thumbDataUrl: row.thumbBlob ? await blobToDataUrl(row.thumbBlob) : null,
      })
    }
  }

  return {
    format: 'dishes-manage-backup',
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion: '0.1.0',
    counts: {
      recipes: recipes.length,
      ingredients: ingredients.length,
      steps: steps.length,
      categories: categories.length,
      tags: tags.length,
      menuItems: menuItems.length,
      cookHistory: cookHistory.length,
      images: images.length,
    },
    data: {
      recipes, ingredients, steps, notes, categories, tags,
      menuItems, shoppingItems, ingredientDict, cookHistory, settings,
    },
    images,
  }
}

export interface RestoreStats {
  mode: 'overwrite' | 'merge'
  added: number
  updated: number
  skipped: number
  images: number
  /** 覆盖模式下清掉的旧记录数 */
  cleared: number
}

/** 校验导入文件是不是我们的备份格式，尽早给出人话错误 */
export function validateBackup(raw: unknown): BackupData {
  if (!raw || typeof raw !== 'object') throw new Error('文件内容不是有效的 JSON 对象')
  const obj = raw as Partial<BackupData>
  if (obj.format !== 'dishes-manage-backup') {
    throw new Error('这不是「家庭私厨」导出的备份文件（缺少 format 标记）')
  }
  if (!obj.data || typeof obj.data !== 'object') throw new Error('备份文件缺少 data 字段')
  if (typeof obj.version === 'number' && obj.version > BACKUP_VERSION) {
    throw new Error(`备份文件版本（v${obj.version}）比当前应用更新，请先升级应用再导入`)
  }
  return obj as BackupData
}

/**
 * 导入（FR-5.3）。
 * - overwrite：清空后导入，拿它当"恢复出厂设置 + 还原"
 * - merge：按 id 去重，冲突时保留 updatedAt 较新的那条
 *
 * 图片在两种模式下都只补不删——除非是 overwrite 的全量清空。
 */
export async function restoreAll(backup: BackupData, mode: 'overwrite' | 'merge'): Promise<RestoreStats> {
  const stats: RestoreStats = { mode, added: 0, updated: 0, skipped: 0, images: 0, cleared: 0 }

  // 先把图片写进去，再写引用它的菜谱/步骤，避免中途留下悬空 blobId
  for (const img of backup.images ?? []) {
    const existing = await db.blobs.get(img.id)
    if (existing && mode === 'merge') continue
    await db.blobs.put({
      id: img.id,
      blob: await dataUrlToBlob(img.dataUrl),
      thumbBlob: img.thumbDataUrl ? await dataUrlToBlob(img.thumbDataUrl) : null,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      size: img.size,
      hash: img.hash,
      createdAt: img.createdAt,
    })
    stats.images += 1
  }

  // settings 是个例外：它没有 updatedAt，也不存在"冲突"的概念——
  // 用户既然点了导入，就是想让备份里的设置生效，所以合并模式下直接以导入的为准。
  const tables: Array<{
    table: Table<unknown, string>
    rows: unknown[]
    incomingWins?: boolean
  }> = [
    { table: db.categories, rows: backup.data.categories ?? [] },
    { table: db.tags, rows: backup.data.tags ?? [] },
    { table: db.recipes, rows: backup.data.recipes ?? [] },
    { table: db.ingredients, rows: backup.data.ingredients ?? [] },
    { table: db.steps, rows: backup.data.steps ?? [] },
    { table: db.notes, rows: backup.data.notes ?? [] },
    { table: db.menuItems, rows: backup.data.menuItems ?? [] },
    { table: db.shoppingItems, rows: backup.data.shoppingItems ?? [] },
    { table: db.ingredientDict, rows: backup.data.ingredientDict ?? [] },
    { table: db.cookHistory, rows: backup.data.cookHistory ?? [] },
    { table: db.settings, rows: backup.data.settings ?? [], incomingWins: true },
  ]

  await db.transaction(
    'rw',
    [db.categories, db.tags, db.recipes, db.ingredients, db.steps, db.notes, db.menuItems, db.shoppingItems, db.ingredientDict, db.cookHistory, db.settings],
    async () => {
      for (const { table, rows, incomingWins } of tables) {
        if (mode === 'overwrite') {
          stats.cleared += await table.count()
          await table.clear()
          if (rows.length) await table.bulkPut(rows as never[])
          stats.added += rows.length
          continue
        }

        for (const row of rows as Array<{ id?: string; key?: string; updatedAt?: number }>) {
          const pk = row.id ?? row.key
          if (pk === undefined) {
            stats.skipped += 1
            continue
          }
          const existing = (await table.get(pk)) as { updatedAt?: number } | undefined
          if (!existing) {
            await table.put(row as never)
            stats.added += 1
            continue
          }
          if (incomingWins) {
            await table.put(row as never)
            stats.updated += 1
            continue
          }
          // 冲突：保留较新的那条。没有 updatedAt 的一律视为更旧，不覆盖本地
          const incoming = row.updatedAt ?? 0
          const local = existing.updatedAt ?? 0
          if (incoming > local) {
            await table.put(row as never)
            stats.updated += 1
          } else {
            stats.skipped += 1
          }
        }
      }
    },
  )

  invalidateDictCache()
  return stats
}

/** 用系统保存对话框下载一个 Blob；不支持时退回 <a download> */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // 给浏览器留出读取的时间再回收
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

// ---------------------------------------------------------------------------
// 备份提醒（FR-5.5）
// ---------------------------------------------------------------------------

export const BACKUP_REMIND_DAYS = 30
const LAST_BACKUP_KEY = 'lastBackupAt'

export async function getLastBackupAt(): Promise<number | null> {
  return getSetting<number | null>(LAST_BACKUP_KEY, null)
}

export async function markBackedUp(at = Date.now()): Promise<void> {
  await setSetting(LAST_BACKUP_KEY, at)
}

export function daysSince(timestamp: number | null, now = Date.now()): number | null {
  if (timestamp === null) return null
  return Math.floor((now - timestamp) / (24 * 60 * 60 * 1000))
}

/** 是否该提醒备份了：从没备份过也算（但要确实有数据可备份） */
export async function shouldRemindBackup(): Promise<{ remind: boolean; days: number | null; recipeCount: number }> {
  const [last, recipeCount] = await Promise.all([
    getLastBackupAt(),
    db.recipes.filter((r) => r.deletedAt === null).count(),
  ])
  if (recipeCount === 0) return { remind: false, days: null, recipeCount }
  const days = daysSince(last)
  if (days === null) return { remind: true, days: null, recipeCount }
  return { remind: days >= BACKUP_REMIND_DAYS, days, recipeCount }
}

// ---------------------------------------------------------------------------
// 制作历史
// ---------------------------------------------------------------------------

export async function recordCooked(
  recipeId: ID,
  options: { date?: string; servings?: number; rating?: number | null; note?: string | null } = {},
): Promise<void> {
  const date = options.date ?? todayKey()
  const now = Date.now()
  const recipe = await db.recipes.get(recipeId)
  if (!recipe) return
  await db.transaction('rw', db.cookHistory, db.recipes, async () => {
    await db.cookHistory.add({
      id: uid('hist'),
      date,
      recipeId,
      servings: options.servings ?? recipe.servings,
      rating: options.rating ?? null,
      note: options.note ?? null,
      createdAt: now,
      updatedAt: now,
    })
    await db.recipes.update(recipeId, {
      cookCount: recipe.cookCount + 1,
      lastCookedAt: now,
      rating: options.rating ?? recipe.rating,
      updatedAt: now,
    })
  })
}

export async function listHistory(limit = 30): Promise<Array<{ date: string; entries: Array<{ row: import('@/types/models').CookHistoryItem; recipe: Recipe }> }>> {
  const rows = (await db.cookHistory.toArray()).sort((a, b) => (a.date < b.date ? 1 : -1))
  const byDate = new Map<string, typeof rows>()
  for (const r of rows) {
    const arr = byDate.get(r.date) ?? []
    arr.push(r)
    byDate.set(r.date, arr)
  }
  const out: Array<{ date: string; entries: Array<{ row: (typeof rows)[number]; recipe: Recipe }> }> = []
  for (const [date, list] of byDate) {
    const entries = []
    for (const row of list) {
      const recipe = await db.recipes.get(row.recipeId)
      if (recipe) entries.push({ row, recipe })
    }
    out.push({ date, entries })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 收工（FR-3.30 / FR-3.31）。
 *
 * 一次事务里做三件事：菜单项置为已完成、写一条制作历史、更新菜谱的
 * 做过次数与平均评分。分成三次调用的话，中间任何一步失败都会留下不一致的状态
 * （比如"做过 3 次"但历史里只有 2 条），而这两个数字用户都会看到。
 */
export async function finishCooking(
  menuItemId: ID,
  options: { rating?: number | null; note?: string | null } = {},
): Promise<void> {
  const item = await db.menuItems.get(menuItemId)
  if (!item) return

  const date = todayKey()
  const now = Date.now()
  const recipe = await db.recipes.get(item.recipeId)
  if (!recipe) return

  const servings = Math.round(recipe.servings * item.multiplier * 10) / 10

  await db.transaction('rw', db.menuItems, db.cookHistory, db.recipes, async () => {
    await db.menuItems.update(menuItemId, { status: 'done', updatedAt: now })

    const previous = await db.cookHistory.where('recipeId').equals(item.recipeId).toArray()
    const rated = previous.map((h) => h.rating).filter((r): r is number => typeof r === 'number')
    const rating = options.rating ?? null
    // 平均分只统计打过分的次数——把没打分的当 0 分会把分数越拉越低
    const allRated = rating === null ? rated : [...rated, rating]
    const avg = allRated.length > 0 ? allRated.reduce((s, r) => s + r, 0) / allRated.length : null

    await db.cookHistory.add({
      id: uid('hist'),
      date,
      recipeId: item.recipeId,
      servings,
      rating,
      note: options.note?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    await db.recipes.update(item.recipeId, {
      cookCount: recipe.cookCount + 1,
      lastCookedAt: now,
      rating: avg === null ? recipe.rating : Math.round(avg * 10) / 10,
      updatedAt: now,
    })
    // 「这一顿的感受」存在 history.note 里，不额外写一条 Note——
    // 制作中的随手笔记（FR-3.26）走 addNote()，两者在详情页是分开的两块，
    // 合成一条会让用户在同一页看到两遍同一句话。
  })
}

/**
 * 把今日菜单拼成时间线引擎需要的输入（FR-3.27）。
 *
 * 放在 repository 而不是 domain，是因为它要读三张表；时间线的算法本身
 * （`@/domain/timeline`）保持纯函数，两边职责不混。
 */
export async function buildMenuTimelineInput(): Promise<DishTimelineInput[]> {
  const menu = await listMenu()
  const out: DishTimelineInput[] = []

  for (const entry of menu) {
    // 已经做完的不再排进时间线——用户要的是"接下来怎么安排"
    if (entry.item.status === 'done') continue
    const detail = await getRecipeDetail(entry.item.recipeId)
    if (!detail) continue
    out.push({
      recipeId: detail.recipe.id,
      recipeName: detail.recipe.name,
      servings: detail.recipe.servings * entry.item.multiplier,
      steps: detail.steps.map((s) => ({
        id: s.id,
        order: s.order,
        text: s.text,
        timerSec: s.timerSec,
        timerLabel: s.timerLabel,
      })),
    })
  }

  return out
}

/** 避免 domain 层反向依赖 repository：这里只借用它的输入类型形状 */
export type DishTimelineInput = import('@/domain/timeline').DishInput

/** 「再来一次」（FR-3.33）：把某天的菜或单道菜重新加入今日菜单 */
export async function cookAgain(recipeId: ID, multiplier = 1): Promise<void> {
  await addToMenu(recipeId, multiplier)
}

export async function cookAgainBatch(recipeIds: ID[]): Promise<number> {
  let added = 0
  for (const id of recipeIds) {
    const before = (await db.menuItems.count())
    await addToMenu(id)
    if ((await db.menuItems.count()) > before) added += 1
  }
  return added
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  return row ? (row.value as T) : fallback
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value })
}

// ---------------------------------------------------------------------------
// 统计（首页/我的页）
// ---------------------------------------------------------------------------

export async function getStats(): Promise<{ recipeCount: number; categoryCount: number; tagCount: number }> {
  const [recipes, categories, tags] = await Promise.all([
    db.recipes.filter((r) => r.deletedAt === null).count(),
    db.categories.count(),
    db.tags.count(),
  ])
  return { recipeCount: recipes, categoryCount: categories, tagCount: tags }
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export const DEFAULT_DIFFICULTY: Difficulty = 1
export { UNCATEGORIZED_ID }
export type { Note, Tag }
