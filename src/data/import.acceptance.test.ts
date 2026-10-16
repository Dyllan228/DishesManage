/**
 * AC-1 验收：粘贴解析
 *
 * > 给一段 300 字、含「食材：」「步骤：」小标题的非结构化菜谱文本，粘贴后 3 秒内出预览：
 * > 菜名正确、食材 ≥ 80% 正确抽取、步骤完整分条。修改两个字段后保存，详情页展示正确。
 * >
 * > 反例：给一段完全无格式的口语化描述 → 系统走 LLM 兜底或明确提示「未能识别出步骤，
 * > 请手动补充」，**不得静默保存错误数据**。
 *
 * 这里刻意用**真实的 240 条食材字典**（不是铺好的 fixture），因为"能不能抽对"
 * 很大程度取决于字典覆盖度，用假字典测出来的通过率没有意义。
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { createRecipe, getDictIndex, getRecipeDetail, initDatabase, listCategories } from './repository'
import { parseRecipeSource } from './importRecipe'
import { parseAmount } from '@/domain/units'
import type { RecipeDraft } from '@/types/models'

async function resetDb() {
  db.close()
  await db.delete()
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await db.open()
}

/** 一段典型的、从公众号复制来的菜谱，约 300 字 */
const PASTED = `川味土豆烧排骨 | 一锅到底的下饭神器 🍖

今天分享一道超级下饭的家常硬菜，排骨软烂脱骨，土豆吸饱了汤汁，拌饭一绝。

【食材】
排骨 500g
土豆 2个
小葱 2根
姜 3片
八角 2个
干辣椒 5个

【调料】
生抽 2勺
老抽 1勺
料酒 2勺
冰糖 15g
盐 适量

【做法】
1. 排骨冷水下锅，加姜片和料酒焯水 3 分钟，捞出洗净沥干。
2. 热锅倒少许油，下冰糖小火炒出糖色，倒入排骨翻炒上色。
3. 加生抽、老抽、八角、干辣椒翻炒均匀，加热水没过排骨。
4. 大火烧开后转小火炖 40 分钟，中途翻动两次。
5. 放入土豆块继续炖 15 分钟，至土豆软糯。
6. 开大火收汁，加盐调味，撒葱花出锅。

【小贴士】
排骨焯水一定要冷水下锅，血水才能充分逼出来。

图文无关，侵删。关注我，每天分享家常菜做法～
`

describe('AC-1 · 粘贴解析', () => {
  beforeEach(async () => {
    await resetDb()
    await initDatabase()
  })

  it('规则引擎在 3 秒内出结果，且关键字段齐全', async () => {
    const started = Date.now()
    const out = await parseRecipeSource(PASTED, 'rules')
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(3000)
    expect(out.rules.missingCritical).toBe(false)
    // 关键词（排骨/土豆）都在内置字典里，置信度应该过阈值，用不着兜底
    expect(out.rules.overall).toBeGreaterThanOrEqual(0.7)
  })

  it('菜名正确，且没把引流文案当成菜名', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    expect(rules.name).toBe('川味土豆烧排骨')
    expect(rules.name).not.toContain('侵删')
    expect(rules.name).not.toContain('神器')
  })

  it('食材抽取正确率 ≥ 80%', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const index = await getDictIndex()

    // 原文里一共 11 样（6 主料 + 5 调料）。
    // 注意：引擎会把别名归一成字典里的标准名（排骨→猪排骨、姜→生姜、盐→食盐），
    // 这是**期望行为**——不归一的话备菜清单根本没法跨菜谱合并。
    const expected = ['排骨', '土豆', '小葱', '姜', '八角', '干辣椒', '生抽', '老抽', '料酒', '冰糖', '盐']
    const canonical = expected.map((raw) => index.byAlias.get(raw)?.name ?? raw)
    const got = new Set(rules.ingredients.map((i) => i.name))
    const hits = canonical.filter((n) => got.has(n))
    const accuracy = hits.length / canonical.length

    expect(accuracy).toBeGreaterThanOrEqual(0.8)
    // 这条用例里应该是全中
    expect(hits).toHaveLength(expected.length)
  })

  it('调料与主料分开归类', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const index = await getDictIndex()
    const rib = index.byAlias.get('排骨')!.name
    const soy = index.byAlias.get('生抽')!.name
    expect(rules.ingredients.find((i) => i.name === rib)?.kind).toBe('main')
    expect(rules.ingredients.find((i) => i.name === soy)?.kind).toBe('seasoning')
  })

  it('用量抽成结构化字段，数值与单位对得上', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const index = await getDictIndex()

    const pork = rules.ingredients.find((i) => i.name === index.byAlias.get('排骨')!.name)!
    expect(pork.amount).toBe(500)
    expect(pork.unit).toBe('g')

    const potato = rules.ingredients.find((i) => i.name === '土豆')!
    expect(potato.amount).toBe(2)
    expect(potato.unit).toBe('个')

    const salt = rules.ingredients.find((i) => i.name === index.byAlias.get('盐')!.name)!
    expect(salt.amount).toBeNull()
    expect(salt.amountText).toBe('适量')
  })

  it('步骤完整分条，共 6 步', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    expect(rules.steps).toHaveLength(6)
    expect(rules.steps[0].text).toContain('焯水')
    expect(rules.steps[5].text).toContain('出锅')
    // 序号被剥掉
    expect(rules.steps.every((s) => !/^\d+\s*[.、]/.test(s.text))).toBe(true)
  })

  it('步骤里的时长被识别成计时器（FR-3.23）', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const timers = rules.steps.filter((s) => s.timerSec !== null)
    expect(timers.length).toBeGreaterThanOrEqual(3)

    const stew = rules.steps.find((s) => s.text.includes('炖 40 分钟'))!
    expect(stew.timerSec).toBe(2400)
    expect(stew.timerLabel).toBe('炖')
  })

  it('小贴士被单独抽出来，不会混进步骤', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    expect(rules.tips).toContain('冷水下锅')
    expect(rules.steps.some((s) => s.text.includes('血水'))).toBe(false)
  })

  it('引流尾注被清掉，不会污染任何字段', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const all = JSON.stringify(rules)
    expect(all).not.toContain('侵删')
    expect(all).not.toContain('关注我')
  })

  it('猜出分类与标签供用户确认（FR-1.16）', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    expect(rules.suggestedCategoryName).toBeTruthy()
    // 有干辣椒 + 排骨 → 应该给出「辣」这类标签建议
    expect(rules.suggestedTags.map((t) => t.name)).toContain('辣')
  })

  it('建议的分类名能对应到种子分类树上的真实节点', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const categories = await listCategories()
    const match = categories.find((c) => c.name === rules.suggestedCategoryName)
    expect(match).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // 「修改两个字段后保存，详情页展示正确」
  // -------------------------------------------------------------------------

  it('校正后保存，详情页拿到的就是校正后的数据', async () => {
    const { rules } = await parseRecipeSource(PASTED, 'rules')
    const categories = await listCategories()
    const target = categories.find((c) => c.name === rules.suggestedCategoryName) ?? categories[0]
    const index = await getDictIndex()

    // 模拟用户在预览页改了两处：菜名去掉「川味」，排骨用量改成 750g
    const editedName = '土豆烧排骨'
    const editedPorkAmountRaw = '750g'
    const ribCanonical = index.byAlias.get('排骨')?.name ?? '排骨'

    const draft: RecipeDraft = {
      name: editedName,
      intro: rules.intro,
      categoryId: target.id,
      tagIds: [],
      servings: 2,
      durationMin: rules.durationMin,
      difficulty: 1,
      sourceType: 'paste',
      sourceText: PASTED,
      tips: rules.tips,
      ingredients: rules.ingredients.map((i, idx) => {
        const raw = i.name === ribCanonical ? editedPorkAmountRaw : (i.amountRaw ?? '')
        const p = raw ? parseAmount(raw) : { amount: null, unit: null, amountText: null }
        return {
          kind: i.kind,
          name: i.name,
          normalizedId: i.normalizedId,
          amount: p.amount,
          unit: p.unit,
          amountText: p.amountText,
          note: null,
          order: idx,
        }
      }),
      steps: rules.steps.map((s, idx) => ({
        order: idx,
        text: s.text,
        imageBlobId: null,
        timerSec: s.timerSec,
        timerLabel: s.timerLabel,
      })),
    }

    const id = await createRecipe(draft)
    const detail = await getRecipeDetail(id)

    expect(detail).not.toBeNull()
    expect(detail!.recipe.name).toBe('土豆烧排骨')
    expect(detail!.recipe.categoryId).toBe(target.id)
    expect(detail!.recipe.sourceText).toBe(PASTED) // FR-1.15 原文留档
    expect(detail!.ingredients).toHaveLength(rules.ingredients.length)
    expect(detail!.steps).toHaveLength(6)

    const savedPork = detail!.ingredients.find((i) => i.name === ribCanonical)!
    expect(savedPork.amount).toBe(750)
    expect(savedPork.unit).toBe('g')

    // 归一化 id 落库，备菜清单才能跨菜谱合并
    expect(savedPork.normalizedId).toBe(index.byAlias.get('排骨')?.id ?? null)
  })

  // -------------------------------------------------------------------------
  // 反例
  // -------------------------------------------------------------------------

  it('反例：口语化描述不静默保存错误数据，而是明确提示缺步骤', async () => {
    const out = await parseRecipeSource('就随便炒炒，放点盐', 'fallback')

    expect(out.active).toBe('rules') // 没配 Key，降级回规则
    expect(out.llmError).toBeNull() // 但不算错误
    expect(out.rules.missingCritical).toBe(true)
    expect(out.rules.warnings.some((w) => w.includes('步骤'))).toBe(true)
    // 菜名也不该凭空编一个出来
    expect(out.rules.name === '' || out.rules.name === '就随便炒炒，放点盐').toBe(true)
  })
})
