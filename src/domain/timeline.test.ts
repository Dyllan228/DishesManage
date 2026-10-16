/**
 * 多菜并行时间线的测试（FR-3.27 ~ FR-3.29）
 *
 * 时间线算错的后果很具体：用户照着做，两道菜都要下锅的时候撞在一起，
 * 或者腌了 40 分钟发现另一道菜早该炒了。所以这里重点验三件事：
 *   1. 排序真的做到「前置耗时最长者先动」
 *   2. 任何两个"动手步骤"都不重叠（这是硬约束，不重叠才做得出来）
 *   3. 时间轴是连续覆盖的、总时长算对（用户据此决定几点开火）
 */

import { describe, expect, it } from 'vitest'
import {
  ACTIVE_STEP_SEC,
  GAP_MIN_SEC,
  buildTimeline,
  findFreeWindows,
  findStart,
  formatClock,
  formatOffset,
  overlaps,
  toSegments,
  type DishInput,
  type TimelineStep,
} from './timeline'

function dish(
  recipeName: string,
  steps: Array<{ text?: string; timerSec?: number | null; timerLabel?: string | null }>,
): DishInput {
  return {
    recipeId: `rcp_${recipeName}`,
    recipeName,
    servings: 2,
    steps: steps.map((s, i) => ({
      id: `stp_${recipeName}_${i}`,
      order: i,
      text: s.text ?? `${recipeName} 第 ${i + 1} 步`,
      timerSec: s.timerSec ?? null,
      timerLabel: s.timerLabel ?? null,
    })),
  }
}

/** 收集所有"动手步骤"的区间，用于校验互不重叠 */
function activeIntervals(tl: ReturnType<typeof buildTimeline>) {
  return tl.segments
    .filter((s) => !s.allPassive)
    .flatMap((seg) => seg.steps.filter((s) => !s.passive).map((s) => ({ start: s.startSec, end: s.startSec + s.durationSec })))
}

describe('区间工具', () => {
  it('半开区间：首尾相接不算重叠', () => {
    expect(overlaps(0, 10, 10, 20)).toBe(false)
    expect(overlaps(0, 10, 9, 20)).toBe(true)
    expect(overlaps(10, 20, 0, 10)).toBe(false)
    expect(overlaps(5, 6, 0, 100)).toBe(true)
  })

  it('放置位置：没冲突就放 0，有冲突就贴着冲突段的末尾放', () => {
    expect(findStart([{ offsetSec: 0, durationSec: 60, passive: false }], [])).toBe(0)
    expect(
      findStart([{ offsetSec: 0, durationSec: 60, passive: false }], [{ start: 0, end: 300 }]),
    ).toBe(300)
  })

  it('全是被动等待的菜可以放在任意时刻（不占用动手资源）', () => {
    expect(findStart([{ offsetSec: 0, durationSec: 600, passive: true }], [{ start: 0, end: 300 }])).toBe(0)
  })
})

describe('单菜时间线', () => {
  it('一道菜从 0 开始，总时长等于各步之和', () => {
    const tl = buildTimeline([
      dish('番茄炒蛋', [{ timerSec: null }, { timerSec: 180, timerLabel: '炒' }, { timerSec: null }]),
    ])
    expect(tl.dishes).toHaveLength(1)
    expect(tl.dishes[0].startSec).toBe(0)
    expect(tl.totalSec).toBe(ACTIVE_STEP_SEC + 180 + ACTIVE_STEP_SEC)
    expect(tl.serialSec).toBe(tl.totalSec)
    expect(tl.savedSec).toBe(0)
  })

  it('没有标时长的步骤按 1 分钟估（明说出来的近似）', () => {
    const tl = buildTimeline([dish('A', [{ timerSec: null }])])
    expect(tl.totalSec).toBe(ACTIVE_STEP_SEC)
  })

  it('步骤按 order 排，即使传进来是乱序', () => {
    const input: DishInput = {
      recipeId: 'r',
      recipeName: 'A',
      servings: 2,
      steps: [
        { id: 'b', order: 1, text: '第二步', timerSec: 60, timerLabel: null },
        { id: 'a', order: 0, text: '第一步', timerSec: null, timerLabel: null },
      ],
    }
    const tl = buildTimeline([input])
    const segs = tl.segments.flatMap((s) => s.steps)
    expect(segs[0].text).toBe('第一步')
  })

  it('空步骤的菜被忽略，不会产生零长度时段', () => {
    const tl = buildTimeline([dish('空菜', [])])
    expect(tl.dishes).toHaveLength(0)
    expect(tl.segments).toHaveLength(0)
    expect(tl.totalSec).toBe(0)
  })

  it('完全没有菜时返回空时间线，不抛错', () => {
    expect(buildTimeline([])).toMatchObject({ dishes: [], segments: [], totalSec: 0, savedSec: 0 })
  })
})

describe('排序：前置耗时最长者先动', () => {
  it('要先腌 / 先发面的菜排在前面', () => {
    const tl = buildTimeline([
      dish('快炒青菜', [{ timerSec: null }, { timerSec: null }]), // 起手等待 0
      dish('腌黄瓜', [{ timerSec: 1800, timerLabel: '腌' }, { timerSec: null }]), // 起手等待 30 分钟
    ])
    expect(tl.dishes[0].recipeName).toBe('腌黄瓜')
    expect(tl.dishes[0].leadWaitSec).toBe(1800)
    expect(tl.dishes[1].leadWaitSec).toBe(0)
  })

  it('起手等待只算开头连续的那一段：一旦动手，后面再等也不算', () => {
    // 先切（动手）→ 再炖 20 分钟：这个 20 分钟不是"能走开的起手等待"
    const tl = buildTimeline([
      dish('红烧肉', [{ timerSec: null }, { timerSec: 1200, timerLabel: '炖' }]),
      dish('发面饼', [{ timerSec: 2400, timerLabel: '发面' }, { timerSec: null }]),
    ])
    expect(tl.dishes[0].recipeName).toBe('发面饼')
    expect(tl.dishes[1].leadWaitSec).toBe(0)
  })

  it('起手等待相同时，更长的菜先做（先启动重活）', () => {
    const tl = buildTimeline([
      dish('短菜', [{ timerSec: null }]),
      dish('长菜', [{ timerSec: null }, { timerSec: null }, { timerSec: null }]),
    ])
    expect(tl.dishes[0].recipeName).toBe('长菜')
  })
})

describe('硬约束：动手步骤永不重叠', () => {
  it('两道都要炒的菜被错开，而不是同时占用灶台', () => {
    const tl = buildTimeline([
      dish('炒A', [{ timerSec: null }, { timerSec: null }]),
      dish('炒B', [{ timerSec: null }, { timerSec: null }]),
    ])
    const intervals = activeIntervals(tl)
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        expect(overlaps(intervals[i].start, intervals[i].end, intervals[j].start, intervals[j].end)).toBe(false)
      }
    }
  })

  it('三道菜混着动手与等待，动手区间依然两两不重叠', () => {
    const tl = buildTimeline([
      dish('炖排骨', [{ timerSec: null }, { timerSec: 2400, timerLabel: '炖' }, { timerSec: null }]),
      dish('凉拌黄瓜', [{ timerSec: 600, timerLabel: '腌' }, { timerSec: null }]),
      dish('米饭', [{ timerSec: 1800, timerLabel: '煮' }, { timerSec: null }]),
    ])
    const intervals = activeIntervals(tl)
    // 炖排骨 2 个动手步骤 + 凉拌黄瓜 1 个 + 米饭 1 个
    expect(intervals).toHaveLength(4)
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        expect(overlaps(intervals[i].start, intervals[i].end, intervals[j].start, intervals[j].end)).toBe(false)
      }
    }
  })

  it('后一道菜的等待可以塞进前一道菜的等待里（这是省时间的来源）', () => {
    const tl = buildTimeline([
      dish('炖菜', [{ timerSec: 3600, timerLabel: '炖' }, { timerSec: null }]),
      dish('快炒', [{ timerSec: null }]),
    ])
    // 快炒的动手步骤落在炖菜的第一个小时里，而不是等炖完才开始
    const stir = tl.dishes.find((d) => d.recipeName === '快炒')!
    expect(stir.startSec).toBe(0)
    expect(tl.savedSec).toBeGreaterThan(0)
  })
})

describe('总时长与省下的时间', () => {
  it('串行时长 = 各菜之和；并行时长 < 串行时长', () => {
    const tl = buildTimeline([
      dish('炖菜', [{ timerSec: 1800, timerLabel: '炖' }, { timerSec: null }]),
      dish('米饭', [{ timerSec: 1800, timerLabel: '煮' }, { timerSec: null }]),
    ])
    expect(tl.serialSec).toBe(1800 + 60 + 1800 + 60)
    expect(tl.totalSec).toBeLessThan(tl.serialSec)
    expect(tl.savedSec).toBe(tl.serialSec - tl.totalSec)
  })

  it('两道都要动手且无法并行的菜，省不下时间', () => {
    const tl = buildTimeline([dish('A', [{ timerSec: null }]), dish('B', [{ timerSec: null }])])
    expect(tl.totalSec).toBe(tl.serialSec)
    expect(tl.savedSec).toBe(0)
  })

  it('总时长等于最后结束的那一步', () => {
    const tl = buildTimeline([
      dish('炖菜', [{ timerSec: 3600, timerLabel: '炖' }, { timerSec: null }]),
      dish('快炒', [{ timerSec: null }]),
    ])
    const lastEnd = Math.max(...tl.segments.map((s) => s.endSec))
    expect(tl.totalSec).toBe(lastEnd)
  })
})

describe('时间轴分段', () => {
  it('相邻且成员相同的段被合并，不会把「炖 40 分钟」切成 41 段', () => {
    const tl = buildTimeline([dish('炖菜', [{ timerSec: 2400, timerLabel: '炖' }])])
    expect(tl.segments).toHaveLength(1)
    expect(tl.segments[0].endSec - tl.segments[0].startSec).toBe(2400)
  })

  it('线段标明「同时在做什么」', () => {
    const tl = buildTimeline([
      dish('炖菜', [{ timerSec: 3600, timerLabel: '炖' }, { timerSec: null }]),
      dish('快炒', [{ timerSec: null }]),
    ])
    const parallel = tl.segments.find((s) => s.steps.length > 1)
    expect(parallel).toBeDefined()
    expect(parallel!.steps.map((s) => s.recipeName).sort()).toEqual(['快炒', '炖菜'])
    expect(parallel!.allPassive).toBe(false)
  })

  it('全被动的段被标记出来（可以走开）', () => {
    const tl = buildTimeline([
      dish('炖菜', [{ timerSec: 3600, timerLabel: '炖' }]),
      dish('米饭', [{ timerSec: 3600, timerLabel: '煮' }]),
    ])
    expect(tl.segments.some((s) => s.allPassive)).toBe(true)
  })

  it('toSegments 对空输入返回空数组', () => {
    expect(toSegments([])).toEqual([])
  })

  it('每个步骤在任何时刻最多出现在一个段里（分段不重复计）', () => {
    const tl = buildTimeline([
      dish('炖排骨', [{ timerSec: null }, { timerSec: 2400, timerLabel: '炖' }, { timerSec: null }]),
      dish('米饭', [{ timerSec: 1800, timerLabel: '煮' }, { timerSec: null }]),
    ])
    // 按步骤聚合它出现过的段，总时长应等于步骤自身时长
    const byStep = new Map<string, number>()
    for (const seg of tl.segments) {
      for (const s of seg.steps) {
        byStep.set(s.stepId, (byStep.get(s.stepId) ?? 0) + (seg.endSec - seg.startSec))
      }
    }
    for (const seg of tl.segments) {
      for (const s of seg.steps) {
        expect(byStep.get(s.stepId)).toBe(s.durationSec)
      }
    }
  })
})

describe('可自由支配的时段（FR-3.28）', () => {
  it('只剩炖着的那段时间被列出来，并说明在等谁', () => {
    const tl = buildTimeline([
      dish('炖排骨', [{ timerSec: 3600, timerLabel: '炖' }]),
      dish('米饭', [{ timerSec: 3600, timerLabel: '煮' }]),
    ])
    expect(tl.freeWindows).toHaveLength(1)
    expect(tl.freeWindows[0].waitingFor.sort()).toEqual(['炖排骨', '米饭'])
    expect(tl.freeWindows[0].endSec - tl.freeWindows[0].startSec).toBe(3600)
  })

  it('太短的缝儿不算（1 分钟的等待提示了也没用）', () => {
    const tl = buildTimeline([dish('A', [{ timerSec: 30, timerLabel: '烫' }])])
    expect(tl.freeWindows).toHaveLength(0)
  })

  it('阈值就是 GAP_MIN_SEC，边界上要算进来', () => {
    const exactly = buildTimeline([dish('A', [{ timerSec: GAP_MIN_SEC, timerLabel: '等' }])])
    expect(exactly.freeWindows).toHaveLength(1)

    const under = buildTimeline([dish('A', [{ timerSec: GAP_MIN_SEC - 1, timerLabel: '等' }])])
    expect(under.freeWindows).toHaveLength(0)
  })

  it('全程都要动手时不产生自由时段', () => {
    const tl = buildTimeline([dish('A', [{ timerSec: null }, { timerSec: null }])])
    expect(tl.freeWindows).toHaveLength(0)
  })

  it('相邻的全被动段会并成一个窗口，并汇总在等哪些菜', () => {
    const steps: TimelineStep[] = [
      { stepId: 'a', recipeId: 'r1', recipeName: '甲', stepOrder: 0, text: '', startSec: 0, durationSec: 1200, passive: true, timerLabel: null },
      { stepId: 'b', recipeId: 'r2', recipeName: '乙', stepOrder: 0, text: '', startSec: 600, durationSec: 900, passive: true, timerLabel: null },
    ]
    const windows = findFreeWindows(steps, 1500)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ startSec: 0, endSec: 1500 })
    expect(windows[0].waitingFor.sort()).toEqual(['乙', '甲'])
  })

  it('被动手步骤隔开的两个被动段不会并成一个', () => {
    const steps: TimelineStep[] = [
      { stepId: 'a', recipeId: 'r1', recipeName: '甲', stepOrder: 0, text: '', startSec: 0, durationSec: 600, passive: true, timerLabel: null },
      { stepId: 'x', recipeId: 'r1', recipeName: '甲', stepOrder: 1, text: '', startSec: 600, durationSec: 60, passive: false, timerLabel: null },
      { stepId: 'b', recipeId: 'r1', recipeName: '甲', stepOrder: 2, text: '', startSec: 660, durationSec: 600, passive: true, timerLabel: null },
    ]
    const windows = findFreeWindows(steps, 1260)
    expect(windows).toHaveLength(2)
    expect(windows.map((w) => [w.startSec, w.endSec])).toEqual([
      [0, 600],
      [660, 1260],
    ])
  })

  it('整段时间轴上什么都没有时也算自由时段（前一道收工、下一道还没到点）', () => {
    const steps: TimelineStep[] = [
      { stepId: 'x', recipeId: 'r1', recipeName: '甲', stepOrder: 0, text: '', startSec: 0, durationSec: 60, passive: false, timerLabel: null },
      { stepId: 'y', recipeId: 'r2', recipeName: '乙', stepOrder: 0, text: '', startSec: 1200, durationSec: 60, passive: false, timerLabel: null },
    ]
    const windows = findFreeWindows(steps, 1260)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ startSec: 60, endSec: 1200 })
    expect(windows[0].waitingFor).toEqual([])
  })
})

describe('展示辅助', () => {
  it('时长格式化', () => {
    expect(formatClock(0)).toBe('0 分钟')
    expect(formatClock(1200)).toBe('20 分钟')
    expect(formatClock(3600)).toBe('1 小时')
    expect(formatClock(5400)).toBe('1 小时 30 分')
  })

  it('偏移量格式化带前导零', () => {
    expect(formatOffset(0)).toBe('+0:00')
    expect(formatOffset(65)).toBe('+1:05')
    expect(formatOffset(600)).toBe('+10:00')
  })

  it('负数偏移被夹到 0，不显示 +-1:00 这种东西', () => {
    expect(formatOffset(-30)).toBe('+0:00')
    expect(formatClock(-100)).toBe('0 分钟')
  })
})

describe('端到端：一顿真饭', () => {
  it('炖排骨 + 米饭 + 凉拌黄瓜：排序合理、动手不撞、能省下时间', () => {
    const tl = buildTimeline([
      // 米饭：先淘米动手，再煮 30 分钟
      dish('米饭', [{ text: '淘米下锅', timerSec: null }, { text: '煮饭', timerSec: 1800, timerLabel: '煮' }]),
      // 凉拌黄瓜：先腌 10 分钟（起手等待），再拌
      dish('凉拌黄瓜', [{ text: '拍黄瓜撒盐', timerSec: 600, timerLabel: '腌' }, { text: '调味拌匀', timerSec: null }]),
      // 排骨：焯水动手，炖 40 分钟，收汁动手
      dish('排骨', [
        { text: '焯水', timerSec: null },
        { text: '炖 40 分钟', timerSec: 2400, timerLabel: '炖' },
        { text: '大火收汁', timerSec: null },
      ]),
    ])

    // 起手等待：凉拌黄瓜 600s 最长 → 先动
    expect(tl.dishes[0].recipeName).toBe('凉拌黄瓜')
    expect(tl.dishes[0].leadWaitSec).toBe(600)

    // 动手步骤两两不重叠
    const intervals = activeIntervals(tl)
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        expect(overlaps(intervals[i].start, intervals[i].end, intervals[j].start, intervals[j].end)).toBe(false)
      }
    }

    // 并行确实省了时间
    expect(tl.savedSec).toBeGreaterThan(0)
    expect(tl.totalSec).toBeLessThan(tl.serialSec)

    // 时间轴连续覆盖，没有空洞（用户可以放心从 0 开始按表做）
    let cursor = 0
    for (const seg of tl.segments) {
      expect(seg.startSec).toBe(cursor)
      cursor = seg.endSec
    }
    expect(cursor).toBe(tl.totalSec)
  })
})
