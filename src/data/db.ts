/**
 * IndexedDB 表结构（Dexie）
 *
 * ⚠️ UI 层禁止直接 import 本文件，一律走 `@/data/repository`
 * （docs/决策记录.md D-002：为 V2 云端同步预留替换点）
 */

import Dexie, { type Table } from 'dexie'
import type {
  AppSetting,
  BlobRecord,
  Category,
  CookHistoryItem,
  Ingredient,
  IngredientDict,
  MenuItem,
  Note,
  Recipe,
  ShoppingItem,
  Step,
  Tag,
} from '@/types/models'

export class DishesDatabase extends Dexie {
  recipes!: Table<Recipe, string>
  ingredients!: Table<Ingredient, string>
  steps!: Table<Step, string>
  notes!: Table<Note, string>
  categories!: Table<Category, string>
  tags!: Table<Tag, string>
  menuItems!: Table<MenuItem, string>
  shoppingItems!: Table<ShoppingItem, string>
  ingredientDict!: Table<IngredientDict, string>
  cookHistory!: Table<CookHistoryItem, string>
  blobs!: Table<BlobRecord, string>
  settings!: Table<AppSetting, string>

  constructor(name = 'dishes-manage') {
    super(name)
    this.version(1).stores({
      // 索引说明：* 前缀 = multiEntry（数组字段），[] = 复合索引
      recipes:
        'id, name, categoryId, *tagIds, favorite, cookCount, lastCookedAt, createdAt, updatedAt, deletedAt, durationMin',
      ingredients: 'id, recipeId, [recipeId+order], name, normalizedId',
      steps: 'id, recipeId, [recipeId+order]',
      notes: 'id, recipeId, cookedOn',
      categories: 'id, parentId, order',
      tags: 'id, name, dimension, usageCount',
      menuItems: 'id, recipeId, order, status',
      shoppingItems: 'id, date, itemKey, category, checked, normalizedId',
      ingredientDict: 'id, category, name, *aliases',
      cookHistory: 'id, date, recipeId',
      blobs: 'id, hash, createdAt',
      settings: 'key',
    })
  }
}

export const db = new DishesDatabase()
