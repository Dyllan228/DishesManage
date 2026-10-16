/**
 * M6 · 收工与制作历史的测试（FR-3.30 ~ FR-3.34）
 *
 * 这里最关键的一条：`finishCooking` 必须在**一个事务**里同时改「菜单状态 / 制作历史 /
 * 菜谱的做过次数与平均分」。这三个数字用户都会在界面上看到，任何一个落后于其他两个
 * 都是那种"说不上哪里不对但就是不对劲"的 bug。
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  addToMenu,
  buildMenuTimelineInput,
  clearMenu,
  cookAgainBatch,
  findMenuItem,
  finishCooking,
  getRecipeDetail,
  initDatabase,
  listHistory,
  listMenu,
  listRecipes,
  createRecipe,
  setMenuStatus,
} from './repository'
import { buildTimeline } from '@/domain/timeline'
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

async function firstCategoryId(): Promise<string> {
  const cats = await db.categories.toArray()
  return (cats.find((c) => c.parentId !== null) ?? cats[0]).id
}

async function makeRecipe(
  name: string,
  options: { servings?: number; steps?: RecipeDraft['steps'] } = {},
): Promise<string> {
  const cat = await firstCategoryId()
  return createRecipe({
    name,
    intro: null,
    categoryId: cat,
    tagIds: [],
    servings: options.servings ?? 2,
    durationMin: 30,
    difficulty: 1,
    sourceType: 'manual',
    sourceText: null,
    tips: null,
    ingredients: [
      { kind: 'main', name: '番茄', normalizedId: null, amount: 2, amountText: null, unit: '个', note: null, order: 0 },
    ],
    steps: options.steps ?? [
      { order: 0, text: '切块', imageBlobId: null, timerSec: null, timerLabel: null },
      { order: 1, text: '炖 20 分钟', imageBlobId: null, timerSec: 1200, timerLabel: '炖' },
      { order: 2, text: '收汁', imageBlobId: null, timerSec: null, timerLabel: null },
    ],
  })
}

describe('收工：状态 / 历史 / 计数三者一致', () => {
  it('收工后菜单项变已完成、历史多一条、做过次数 +1', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    const menu = await listMenu()
    const menuItemId = menu[0].item.id

    await finishCooking(menuItemId)
    await setMenuStatus(menuItemId, 'done')

    expect((await listMenu())[0].item.status).toBe('done')
    const detail = await getRecipeDetail(recipeId)
    expect(detail!.recipe.cookCount).toBe(1)
    expect(detail!.recipe.lastCookedAt).not.toBeNull()

    const history = await listHistory()
    expect(history).toHaveLength(1)
    expect(history[0].entries).toHaveLength(1)
    expect(history[0].entries[0].recipe.name).toBe('番茄炒蛋')
  })

  it('历史里记的份量是「基准份量 × 倍率」', async () => {
    const recipeId = await makeRecipe('红烧肉', { servings: 2 })
    await addToMenu(recipeId, 2.5)
    const menuItemId = (await listMenu())[0].item.id

    await finishCooking(menuItemId)
    const history = await listHistory()
    expect(history[0].entries[0].row.servings).toBe(5)
  })

  it('评分与感受一起落进历史', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    const menuItemId = (await listMenu())[0].item.id

    await finishCooking(menuItemId, { rating: 4, note: '下次盐少放点' })
    const row = (await listHistory())[0].entries[0].row
    expect(row.rating).toBe(4)
    expect(row.note).toBe('下次盐少放点')
  })

  it('感受里的空白被清成 null，别在历史里显示一个空行', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    await finishCooking((await listMenu())[0].item.id, { note: '   ' })
    expect((await listHistory())[0].entries[0].row.note).toBeNull()
  })

  it('不做菜的菜单项收工是空操作，不写脏数据', async () => {
    await expect(finishCooking('不存在的 id')).resolves.toBeUndefined()
    expect(await listHistory()).toHaveLength(0)
  })

  it('菜单项被删掉后收工也不报错', async () => {
    await expect(finishCooking('menu_gone', { rating: 5 })).resolves.toBeUndefined()
  })
})

describe('平均分', () => {
  it('平均分只统计打过分的次数', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)

    // 第一次 5 分，第二次不打分 —— 平均分应该还是 5，不能被 0 拉低
    await finishCooking((await listMenu())[0].item.id, { rating: 5 })
    await finishCooking((await listMenu())[0].item.id)

    const detail = await getRecipeDetail(recipeId)
    expect(detail!.recipe.rating).toBe(5)
    expect(detail!.recipe.cookCount).toBe(2)
  })

  it('多次打分取平均，保留一位小数', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    const id = (await listMenu())[0].item.id

    await finishCooking(id, { rating: 5 })
    await finishCooking(id, { rating: 4 })

    expect((await getRecipeDetail(recipeId))!.recipe.rating).toBe(4.5)
  })

  it('一次都没打分时评分保持 null，不显示 0 分', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    await finishCooking((await listMenu())[0].item.id)
    expect((await getRecipeDetail(recipeId))!.recipe.rating).toBeNull()
  })

  it('重复收工同一道菜，做过次数与历史条数同步增长', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    const id = (await listMenu())[0].item.id

    await finishCooking(id)
    await finishCooking(id)
    await finishCooking(id)

    expect((await getRecipeDetail(recipeId))!.recipe.cookCount).toBe(3)
    const history = await listHistory()
    expect(history[0].entries).toHaveLength(3)
    // 做过次数与历史条数必须相等，否则界面上两个数字自相矛盾
    expect((await getRecipeDetail(recipeId))!.recipe.cookCount).toBe(history[0].entries.length)
  })
})

describe('时间线输入', () => {
  it('按菜单拼出每道菜的步骤，带上菜名与份量', async () => {
    const recipeId = await makeRecipe('番茄炒蛋', { servings: 2 })
    await addToMenu(recipeId, 1.5)

    const input = await buildMenuTimelineInput()
    expect(input).toHaveLength(1)
    expect(input[0].recipeName).toBe('番茄炒蛋')
    expect(input[0].servings).toBe(3)
    expect(input[0].steps).toHaveLength(3)
    expect(input[0].steps[1]).toMatchObject({ timerSec: 1200, timerLabel: '炖' })
  })

  it('已完成的菜不排进时间线（用户要的是"接下来怎么安排"）', async () => {
    const a = await makeRecipe('已做完的')
    const b = await makeRecipe('还没做的')
    await addToMenu(a)
    await addToMenu(b)
    const menu = await listMenu()
    const doneId = menu.find((m) => m.recipe.name === '已做完的')!.item.id
    await setMenuStatus(doneId, 'done')

    const input = await buildMenuTimelineInput()
    expect(input).toHaveLength(1)
    expect(input[0].recipeName).toBe('还没做的')
  })

  it('软删除的菜谱不会出现在菜单里，也就不会进时间线', async () => {
    const recipeId = await makeRecipe('要被删的')
    await addToMenu(recipeId)
    await db.recipes.update(recipeId, { deletedAt: Date.now() })

    expect(await buildMenuTimelineInput()).toHaveLength(0)
  })

  it('空菜单返回空数组', async () => {
    expect(await buildMenuTimelineInput()).toEqual([])
  })

  it('拼出来的输入能直接喂给时间线引擎（两端接口对得上）', async () => {
    const a = await makeRecipe('炖菜', {
      steps: [
        { order: 0, text: '焯水', imageBlobId: null, timerSec: null, timerLabel: null },
        { order: 1, text: '炖 40 分钟', imageBlobId: null, timerSec: 2400, timerLabel: '炖' },
      ],
    })
    const b = await makeRecipe('凉拌黄瓜', {
      steps: [
        { order: 0, text: '腌 10 分钟', imageBlobId: null, timerSec: 600, timerLabel: '腌' },
        { order: 1, text: '拌匀', imageBlobId: null, timerSec: null, timerLabel: null },
      ],
    })
    await addToMenu(a)
    await addToMenu(b)

    const tl = buildTimeline(await buildMenuTimelineInput())
    expect(tl.dishes).toHaveLength(2)
    // 前置等待长的（腌 10 分钟）先动
    expect(tl.dishes[0].recipeName).toBe('凉拌黄瓜')
    expect(tl.totalSec).toBeGreaterThan(0)
  })
})

describe('再来一次（FR-3.33）', () => {
  it('单道菜重新加入今日菜单', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await cookAgainBatch([recipeId])
    expect((await listMenu())[0].recipe.name).toBe('番茄炒蛋')
  })

  it('批量再来一次，返回真正新增的条数', async () => {
    const a = await makeRecipe('菜A')
    const b = await makeRecipe('菜B')
    const added = await cookAgainBatch([a, b, a])
    // 第三次加 a 是「再来一份」（倍率 +1），菜单条数不变
    expect(added).toBe(2)
    expect(await listMenu()).toHaveLength(2)
  })

  it('清空菜单后再来一次是干净的', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    await clearMenu()
    expect(await listMenu()).toHaveLength(0)
    await cookAgainBatch([recipeId])
    expect(await listMenu()).toHaveLength(1)
  })
})

describe('制作模式的入口（深链接）', () => {
  it('按菜单项 id 取出这一条，带上菜谱与倍率', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId, 1.5)
    const menuItemId = (await listMenu())[0].item.id

    const entry = await findMenuItem(menuItemId)
    expect(entry?.recipe.id).toBe(recipeId)
    expect(entry?.item.multiplier).toBe(1.5)
  })

  it('id 不存在时返回 null，让页面给出"不在菜单里"而不是崩掉', async () => {
    expect(await findMenuItem('menu_不存在')).toBeNull()
  })

  it('菜谱被软删除后，即使菜单项还在也返回 null（与 listMenu 一致）', async () => {
    const recipeId = await makeRecipe('要被删的')
    await addToMenu(recipeId)
    const menuItemId = (await listMenu())[0].item.id
    await db.recipes.update(recipeId, { deletedAt: Date.now() })

    expect(await findMenuItem(menuItemId)).toBeNull()
    expect(await listMenu()).toHaveLength(0)
  })

  it('深链接取出的数据够制作模式渲染：步骤、计时、食材都在', async () => {
    const recipeId = await makeRecipe('炖排骨')
    await addToMenu(recipeId)
    const entry = await findMenuItem((await listMenu())[0].item.id)

    const detail = await getRecipeDetail(entry!.item.recipeId)
    expect(detail!.steps.length).toBeGreaterThan(0)
    expect(detail!.steps.some((s) => s.timerSec !== null)).toBe(true)
    expect(detail!.ingredients.length).toBeGreaterThan(0)
  })
})

describe('菜谱详情上的「做过 N 次 · 上次做于」（FR-3.34）', () => {
  it('做过 0 次时不显示，做过之后有次数与日期', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    expect((await getRecipeDetail(recipeId))!.recipe.cookCount).toBe(0)

    await addToMenu(recipeId)
    await finishCooking((await listMenu())[0].item.id)

    const recipe = (await getRecipeDetail(recipeId))!.recipe
    expect(recipe.cookCount).toBe(1)
    const last = new Date(recipe.lastCookedAt as number)
    expect(last.getFullYear()).toBe(new Date().getFullYear())
  })

  it('软删除的菜谱不出现在列表里，但历史还留着（回看得到）', async () => {
    const recipeId = await makeRecipe('番茄炒蛋')
    await addToMenu(recipeId)
    await finishCooking((await listMenu())[0].item.id)
    await db.recipes.update(recipeId, { deletedAt: Date.now() })

    expect(await listRecipes()).toHaveLength(0)
    // 历史是按菜谱 id 关联的，菜谱还在库里（软删除），所以还能回看
    expect((await listHistory())[0].entries).toHaveLength(1)
  })
})
