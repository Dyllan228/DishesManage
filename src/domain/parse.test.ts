/**
 * 规则引擎测试（FR-1.9 / FR-1.10 / AC-1）
 *
 * 这里的用例大多来自「中文菜谱实际长什么样」：小标题写法千奇百怪、用量单位混着来、
 * 复制粘贴带一堆引流尾注。引擎的目标不是全对，而是**抽得出来的抽对、抽不出来的留空**。
 */

import { describe, expect, it } from 'vitest'
import {
  extractName,
  extractTimer,
  matchHeading,
  needsFallback,
  parseRecipeText,
  preprocess,
  segment,
  splitNameAndAmount,
} from './parse'
import { buildDictIndex } from './normalize'
import type { ShoppingCategory } from '@/types/models'

function fixture(items: Array<[string, ShoppingCategory, string[]?]>) {
  return buildDictIndex(
    items.map(([name, category, aliases]) => ({ name, category, aliases: aliases ?? [], defaultUnit: null })),
  )
}

const DICT = fixture([
  ['番茄', 'veg', ['西红柿']],
  ['鸡蛋', 'meat', ['蛋', '土鸡蛋']],
  ['盐', 'seasoning'],
  ['生抽', 'seasoning', ['酱油', '豉油']],
  ['料酒', 'seasoning', ['黄酒']],
  ['排骨', 'meat', ['猪排骨']],
  ['蒜', 'veg', ['大蒜', '蒜瓣', '蒜末']],
  ['小葱', 'veg', ['葱', '葱花']],
  ['白糖', 'seasoning', ['糖', '砂糖']],
  ['食用油', 'seasoning', ['油', '色拉油']],
])

/** 一段标准的、带小标题的菜谱（接近 AC-1 的场景） */
const SAMPLE = `
【番茄炒蛋】

这道菜酸甜下饭，十分钟就能上桌。

食材：
番茄 2个
鸡蛋 3个
小葱 1根

调料：
盐 适量
白糖 1勺
食用油 2勺

做法：
1. 番茄切块，鸡蛋打散加少许盐。
2. 热锅倒油，倒入蛋液炒至凝固后盛出。
3. 锅留底油下番茄，炒出汁水后加糖和盐。
4. 倒回鸡蛋翻炒均匀，撒葱花出锅。

小贴士：番茄去皮口感更好。

图文无关，侵删。关注我获取更多菜谱！
`

describe('预处理', () => {
  it('去掉表情与引流尾注，保留正文', () => {
    const lines = preprocess('🍅番茄炒蛋✨\n\n食材：番茄\n\n侵删，关注我\n点赞收藏不迷路')
    expect(lines.join('\n')).toContain('番茄炒蛋')
    expect(lines.join('\n')).toContain('食材：番茄')
    expect(lines.join('\n')).not.toContain('侵删')
    expect(lines.join('\n')).not.toContain('关注我')
    expect(lines.join('\n')).not.toContain('点赞')
  })

  it('装饰符包裹的标题保留内容，纯装饰行被丢弃', () => {
    expect(preprocess('=== 菜谱 ===\n番茄炒蛋\n----------------')).toEqual(['菜谱', '番茄炒蛋'])
    expect(preprocess('***\n番茄炒蛋')).toEqual(['番茄炒蛋'])
  })

  it('不堆积连续空行', () => {
    const lines = preprocess('a\n\n\n\n\nb')
    expect(lines).toEqual(['a', '', 'b'])
  })
})

describe('小标题识别', () => {
  it('识别各类小标题写法', () => {
    expect(matchHeading('食材：')?.kind).toBe('ingredients')
    expect(matchHeading('【用料】')?.kind).toBe('ingredients')
    expect(matchHeading('## 调料')?.kind).toBe('seasoning')
    expect(matchHeading('做法步骤')?.kind).toBe('steps')
    expect(matchHeading('小贴士：')?.kind).toBe('tips')
  })

  it('「食材：番茄 2个」这种标题与内容同行的，内容不会被丢掉', () => {
    const hit = matchHeading('食材：番茄 2个')
    expect(hit?.kind).toBe('ingredients')
    expect(hit?.rest).toBe('番茄 2个')
  })

  it('正文里出现关键词不会被误判成小标题', () => {
    // 「食材要新鲜」不是小标题
    expect(matchHeading('食材要新鲜，尽量当天买')).toBeNull()
    expect(matchHeading('把调料倒进去翻炒')).toBeNull()
  })

  it('切段后各行归入正确区块', () => {
    const sections = segment(preprocess(SAMPLE))
    expect(sections.ingredients).toContain('番茄 2个')
    expect(sections.seasoning).toContain('盐 适量')
    expect(sections.steps.some((s) => s.includes('番茄切块'))).toBe(true)
    expect(sections.tips.some((s) => s.includes('去皮'))).toBe(true)
  })
})

describe('菜名抽取', () => {
  it('优先用【】里的名字', () => {
    expect(extractName(['【红烧肉】', '肥而不腻']).name).toBe('红烧肉')
  })

  it('识别「菜名：」显式标注', () => {
    expect(extractName(['菜名：蒜香排骨']).name).toBe('蒜香排骨')
    expect(extractName(['菜名：蒜香排骨']).confidence).toBe(1)
  })

  it('去掉「的做法」这类尾巴', () => {
    expect(extractName(['可乐鸡翅的做法']).name).toBe('可乐鸡翅')
  })

  it('标题里带副标题时只取菜名部分', () => {
    expect(extractName(['川味土豆烧排骨 | 一锅到底的下饭神器']).name).toBe('川味土豆烧排骨')
    expect(extractName(['红烧肉｜肥而不腻的经典']).name).toBe('红烧肉')
  })

  it('过长的标题按空格截断', () => {
    expect(extractName(['蒜香排骨 外酥里嫩的经典做法分享']).name).toBe('蒜香排骨')
  })

  it('不把整句话当成菜名', () => {
    const r = extractName(['今天给大家分享一道非常好吃的家常菜。不管你会不会做饭都能学会。'])
    expect(r.name).not.toContain('。')
  })

  it('什么都没有时返回空名 + 0 置信度，而不是瞎猜', () => {
    expect(extractName([])).toEqual({ name: '', confidence: 0 })
  })
})

describe('用量拆分', () => {
  it('名字在前的常规写法', () => {
    expect(splitNameAndAmount('番茄 2个')).toEqual({ head: '番茄', amountRaw: '2个' })
    expect(splitNameAndAmount('排骨 500g')).toEqual({ head: '排骨', amountRaw: '500g' })
    expect(splitNameAndAmount('盐：适量')).toEqual({ head: '盐', amountRaw: '适量' })
    expect(splitNameAndAmount('生抽 2 勺')).toEqual({ head: '生抽', amountRaw: '2 勺' })
  })

  it('名字与用量之间没有空格的', () => {
    expect(splitNameAndAmount('番茄2个')).toEqual({ head: '番茄', amountRaw: '2个' })
  })

  it('量词倒装「2个番茄」也能认出来', () => {
    expect(splitNameAndAmount('2个番茄')).toEqual({ head: '番茄', amountRaw: '2个' })
  })

  it('没有用量时名字保持完整，不切掉尾巴', () => {
    expect(splitNameAndAmount('番茄')).toEqual({ head: '番茄', amountRaw: null })
    expect(splitNameAndAmount('5分钟快手菜')).toEqual({ head: '5分钟快手菜', amountRaw: null })
  })

  it('去掉行首的序号与项目符号', () => {
    expect(splitNameAndAmount('1. 排骨 500g')).toEqual({ head: '排骨', amountRaw: '500g' })
    expect(splitNameAndAmount('· 姜 3片')).toEqual({ head: '姜', amountRaw: '3片' })
  })

  it('整行只有用量时不算食材', () => {
    expect(splitNameAndAmount('适量').head).toBe('')
  })
})

describe('步骤计时抽取（FR-3.23）', () => {
  it('抽得出时长与动作', () => {
    expect(extractTimer('腌制 30 分钟')).toEqual({ timerSec: 1800, timerLabel: '腌制' })
    expect(extractTimer('中小火煮 5 分钟')).toEqual({ timerSec: 300, timerLabel: '煮' })
    expect(extractTimer('上锅蒸 15 分钟')).toEqual({ timerSec: 900, timerLabel: '蒸' })
    expect(extractTimer('小火焖 1 小时')).toEqual({ timerSec: 3600, timerLabel: '焖' })
  })

  it('「半」也认', () => {
    expect(extractTimer('焯水半分钟')).toEqual({ timerSec: 30, timerLabel: '焯水' })
  })

  it('认不出动作时仍然给出时长，label 留空', () => {
    const r = extractTimer('静置一会儿后 3 分钟即可')
    expect(r.timerSec).toBe(180)
  })

  it('没有时长的步骤不硬塞一个', () => {
    expect(extractTimer('翻炒均匀后出锅')).toEqual({ timerSec: null, timerLabel: null })
  })

  it('离谱的时长（当成时间点被误读）直接丢弃', () => {
    expect(extractTimer('腌制 12 小时').timerSec).toBeNull()
  })
})

describe('整篇解析', () => {
  const result = parseRecipeText(SAMPLE, DICT)

  it('抽出菜名', () => {
    expect(result.name).toBe('番茄炒蛋')
    expect(result.nameConfidence).toBeGreaterThan(0.9)
  })

  it('食材与调料分开抽取，kind 正确', () => {
    const names = result.ingredients.map((i) => i.name)
    expect(names).toContain('番茄')
    expect(names).toContain('鸡蛋')
    expect(result.ingredients.find((i) => i.name === '番茄')?.kind).toBe('main')
    expect(result.ingredients.find((i) => i.name === '盐')?.kind).toBe('seasoning')
  })

  it('用量解析成结构化字段', () => {
    const tomato = result.ingredients.find((i) => i.name === '番茄')!
    expect(tomato.amount).toBe(2)
    expect(tomato.unit).toBe('个')

    const salt = result.ingredients.find((i) => i.name === '盐')!
    expect(salt.amount).toBeNull()
    expect(salt.amountText).toBe('适量')
  })

  it('食材归一化命中内置字典，别名归到标准名（AC-1 的「食材正确抽取」）', () => {
    const egg = result.ingredients.find((i) => i.name === '鸡蛋')
    expect(egg?.canonicalName).toBe('鸡蛋')
    expect(egg?.normalizedId).not.toBeNull()
    expect(egg?.category).toBe('meat')
  })

  it('步骤分条，序号被剥掉', () => {
    expect(result.steps).toHaveLength(4)
    expect(result.steps[0].text.startsWith('番茄切块')).toBe(true)
    expect(result.steps.every((s) => !/^\d+[.、]/.test(s.text))).toBe(true)
  })

  it('整体置信度达标，不需要兜底', () => {
    expect(result.overall).toBeGreaterThanOrEqual(0.7)
    expect(result.missingCritical).toBe(false)
    expect(needsFallback(result, 'fallback')).toBe(false)
  })

  it('猜出分类与标签（FR-1.16）', () => {
    expect(result.suggestedCategoryName).toBeTruthy()
    const tagNames = result.suggestedTags.map((t) => t.name)
    expect(tagNames).toContain('炒')
  })

  it('把原文存下来（FR-1.15 的前提）', () => {
    expect(SAMPLE).toContain(result.name)
  })
})

describe('兜底判定（FR-1.10 / FR-1.18）', () => {
  it('没有步骤的文本被标记为关键字段缺失', () => {
    const r = parseRecipeText('食材：番茄 2个\n鸡蛋 3个', DICT)
    expect(r.missingCritical).toBe(true)
    expect(r.overall).toBeLessThan(0.7)
    expect(needsFallback(r, 'fallback')).toBe(true)
  })

  it('完全口语化的描述不硬编步骤，而是明确提示', () => {
    const r = parseRecipeText('就随便炒炒，放点盐', DICT)
    expect(r.missingCritical).toBe(true)
    expect(r.warnings.some((w) => w.includes('步骤'))).toBe(true)
  })

  it('没有 API Key 时规则引擎独立可用，不阻塞（FR-1.18）', () => {
    const r = parseRecipeText(SAMPLE, DICT)
    expect(r.source).toBe('rules')
    // 策略为「仅本地规则」时，无论分数多低都不该要求兜底
    expect(needsFallback(parseRecipeText('随便写点什么', DICT), 'rules')).toBe(false)
  })

  it('强制 LLM 策略下总是兜底', () => {
    expect(needsFallback(parseRecipeText(SAMPLE, DICT), 'llm')).toBe(true)
  })
})

describe('格式不统一的真实情况', () => {
  it('用小标题后面的内容不丢：食材与调料写成一行', () => {
    const r = parseRecipeText('食材：番茄 2个、鸡蛋 3个、盐 适量', DICT)
    const names = r.ingredients.map((i) => i.name)
    expect(names).toContain('番茄')
    expect(names).toContain('鸡蛋')
    expect(names).toContain('盐')
  })

  it('「盐、生抽、料酒 各适量」平摊用量到每一样', () => {
    const r = parseRecipeText('调料：\n盐、生抽、料酒 各适量', DICT)
    const names = r.ingredients.map((i) => i.name)
    expect(names).toContain('盐')
    expect(names).toContain('生抽')
    expect(names).toContain('料酒')
    for (const n of ['盐', '生抽', '料酒']) {
      expect(r.ingredients.find((i) => i.name === n)?.amountText).toBe('适量')
    }
  })

  it('没有小标题但有编号步骤时，靠做法动词兜底抽步骤', () => {
    const r = parseRecipeText(
      '蒜香排骨\n排骨 500g 用生抽腌制。热锅倒油下排骨煎至两面金黄。加水焖 20 分钟收汁。',
      DICT,
    )
    expect(r.steps.length).toBeGreaterThanOrEqual(2)
    expect(r.warnings.some((w) => w.includes('推测'))).toBe(true)
  })

  it('步骤按句号切分，不把三句话粘成一条', () => {
    const r = parseRecipeText('做法：\n1. 排骨洗净。加生抽腌制 20 分钟。热锅倒油下锅煎。', DICT)
    expect(r.steps.length).toBeGreaterThanOrEqual(2)
    expect(r.steps.some((s) => s.timerSec === 1200)).toBe(true)
  })

  it('识别份量', () => {
    expect(parseRecipeText('2人份的番茄炒蛋\n做法：\n1. 炒。', DICT).servings).toBe(2)
  })

  it('估不准时长时留空，而不是编一个数', () => {
    const r = parseRecipeText('做法：\n1. 切菜。\n2. 下锅炒。\n3. 出锅。', DICT)
    expect(r.durationMin).toBeNull()
  })

  it('有条目时长的步骤能估出总时长', () => {
    const r = parseRecipeText('做法：\n1. 腌制 20 分钟。\n2. 下锅炒。', DICT)
    expect(r.durationMin).toBeGreaterThanOrEqual(20)
  })
})
