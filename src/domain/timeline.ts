/**
 * 多菜并行时间线（FR-3.27 ~ FR-3.29）
 *
 * Q4 的决议是「做最小形态，不做甘特图自动排程」。所以这里**不是**一个调度优化器，
 * 而是一条可解释的贪心规则，目标只有一个：把各菜的"动手时间"错开，
 * 把"等待时间"（腌制、炖、醒面）叠起来。用户看得懂，才会照着做。
 *
 * 三条规则，按顺序应用：
 *   1. **前置耗时最长者先动**——每道菜算一个「起手等待」= 从第一步开始、到第一个需要
 *      动手的步骤之前累计的被动时长。等待长的（先腌、先发面）排前面。
 *   2. **动手时间不重叠**——放置一道菜时，从小到大找第一个可行起点，使它的所有
 *      「动手步骤」都不与已放置的动手步骤重叠。被动等待随便叠。
 *      注意约束只加在"动手"上：两道菜同时炖着完全没问题，同时炒两道就不行。
 *   3. **不需要动手的时段**——把动手时段的补集算出来，长度 ≥ 3 分钟的就列出来，
 *      提示"这 8 分钟只有排骨在炖，可以顺手把米饭煮上"（FR-3.28）。
 *
 * 刻意没做的事：不重排一道菜内部的步骤顺序（那会改变菜谱本身），
 * 不做"同一口锅只能同时炒一道菜"这类资源约束（模型复杂度和收益不成比例）。
 */

import type { ID } from '@/types/models'

/** 步骤没标时长时，按 1 分钟估一个"动手时间"。这是个明说出来的近似，不是精确值 */
export const ACTIVE_STEP_SEC = 60

/** 空档至少 3 分钟才值得提示——1 分钟的缝儿提示了也没用 */
export const GAP_MIN_SEC = 180

export interface TimelineStep {
  stepId: ID
  recipeId: ID
  recipeName: string
  /** 步骤在菜谱里的序号（从 0 开始） */
  stepOrder: number
  text: string
  /** 相对整条时间线起点的秒数 */
  startSec: number
  durationSec: number
  /** true = 被动等待（挂着定时器），false = 需要动手 */
  passive: boolean
  /** 被动步骤的标签，如「腌」 */
  timerLabel: string | null
}

/** 一段时间里"同时在做什么"。同一段内的步骤是真并行 */
export interface TimelineSegment {
  startSec: number
  endSec: number
  steps: TimelineStep[]
  /** 这一段全是被动等待（可以走开） */
  allPassive: boolean
}

export interface FreeWindow {
  startSec: number
  endSec: number
  /** 这段时间里只是在等哪几道菜（可以走开 / 顺手做别的） */
  waitingFor: string[]
}

export interface DishTimeline {
  recipeId: ID
  recipeName: string
  servings: number
  startSec: number
  endSec: number
  /** 起手等待：一开始就能走开的时长 */
  leadWaitSec: number
}

export interface Timeline {
  dishes: DishTimeline[]
  segments: TimelineSegment[]
  /** 「只剩炖着」的时段，可以顺手做别的（FR-3.28） */
  freeWindows: FreeWindow[]
  /** 按时间线做，从开火到全部完成 */
  totalSec: number
  /** 一道一道串着做要多久 */
  serialSec: number
  /** 并行省下来的时间 */
  savedSec: number
}

export interface DishInput {
  recipeId: ID
  recipeName: string
  servings: number
  steps: Array<{
    id: ID
    order: number
    text: string
    timerSec: number | null
    timerLabel: string | null
  }>
}

function isPassive(timerSec: number | null): boolean {
  return timerSec !== null && timerSec > 0
}

/** 把一道菜的步骤摊成"相对偏移 + 时长"的串，并算出起手等待 */
function prepareDishSteps(input: DishInput): {
  steps: Array<Omit<TimelineStep, 'startSec'> & { offsetSec: number }>
  leadWaitSec: number
  totalSec: number
} {
  const steps: Array<Omit<TimelineStep, 'startSec'> & { offsetSec: number }> = []
  let offset = 0
  let leadWait = 0
  let seenActive = false

  for (const step of [...input.steps].sort((a, b) => a.order - b.order)) {
    const passive = isPassive(step.timerSec)
    const durationSec = passive ? (step.timerSec as number) : ACTIVE_STEP_SEC
    steps.push({
      stepId: step.id,
      recipeId: input.recipeId,
      recipeName: input.recipeName,
      stepOrder: step.order,
      text: step.text,
      offsetSec: offset,
      durationSec,
      passive,
      timerLabel: step.timerLabel,
    })
    // 起手等待只累计"开头连续的一段"被动时间：一旦要动手了，后面再等也不算能走开的窗口
    if (!seenActive) {
      if (passive) leadWait += durationSec
      else seenActive = true
    }
    offset += durationSec
  }

  return { steps, leadWaitSec: leadWait, totalSec: offset }
}

/** 半开区间 [aStart, aEnd) 与 [bStart, bEnd) 是否相交 */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/**
 * 放置一道菜：找最小的起点，使其所有"动手步骤"都不与已占用的动手时段重叠。
 *
 * 候选起点的取法：对每个"动手步骤 i（相对偏移 o、时长 d）"与每段已占用时段 b，
 * 可行条件是 `T+o ≥ b.end` **或** `T+o+d ≤ b.start`。所有约束的边界点只可能落在
 * `0`、`b.end - o`、`b.start - o - d` 这三类位置上，所以最小可行点一定在其中。
 *
 * （第一版只试 `0` 和 `b.end`，会漏掉"往左挪一点正好塞进空档"的位置，
 * 例如「淘米 → 煮饭 → 盛饭」这道菜其实只要往后挪 1 分钟就能整条塞进炖菜的空隙里。）
 */
export function findStart(
  steps: Array<{ offsetSec: number; durationSec: number; passive: boolean }>,
  busy: Array<{ start: number; end: number }>,
): number {
  const actives = steps.filter((s) => !s.passive)
  if (actives.length === 0) return 0

  const candidates = new Set<number>([0])
  for (const b of busy) {
    for (const s of actives) {
      candidates.add(b.end - s.offsetSec)
      candidates.add(b.start - s.offsetSec - s.durationSec)
    }
  }

  for (const start of [...candidates].filter((c) => c >= 0).sort((a, b) => a - b)) {
    const clash = actives.some((s) =>
      busy.some((b) => overlaps(start + s.offsetSec, start + s.offsetSec + s.durationSec, b.start, b.end)),
    )
    if (!clash) return start
  }
  // 理论上到不了这里（候选集里必然有可行解），兜底放在所有动手步骤之后
  return Math.max(0, ...busy.map((b) => b.end))
}

export function buildTimeline(inputs: DishInput[]): Timeline {
  const prepared = inputs
    .map((input) => ({ input, ...prepareDishSteps(input) }))
    .filter((p) => p.steps.length > 0)

  // 规则 1：前置耗时最长者先动
  prepared.sort(
    (a, b) =>
      b.leadWaitSec - a.leadWaitSec ||
      b.totalSec - a.totalSec ||
      a.input.recipeName.localeCompare(b.input.recipeName),
  )

  const busy: Array<{ start: number; end: number }> = []
  const dishes: DishTimeline[] = []
  const allSteps: TimelineStep[] = []

  for (const p of prepared) {
    const start = findStart(p.steps, busy)
    const end = start + p.totalSec

    for (const s of p.steps) {
      const placed: TimelineStep = {
        stepId: s.stepId,
        recipeId: s.recipeId,
        recipeName: s.recipeName,
        stepOrder: s.stepOrder,
        text: s.text,
        startSec: start + s.offsetSec,
        durationSec: s.durationSec,
        passive: s.passive,
        timerLabel: s.timerLabel,
      }
      allSteps.push(placed)
      if (!placed.passive) {
        busy.push({ start: placed.startSec, end: placed.startSec + placed.durationSec })
      }
    }

    dishes.push({
      recipeId: p.input.recipeId,
      recipeName: p.input.recipeName,
      servings: p.input.servings,
      startSec: start,
      endSec: end,
      leadWaitSec: p.leadWaitSec,
    })
  }

  allSteps.sort((a, b) => a.startSec - b.startSec || a.recipeName.localeCompare(b.recipeName))

  const totalSec = allSteps.reduce((max, s) => Math.max(max, s.startSec + s.durationSec), 0)
  const serialSec = prepared.reduce((sum, p) => sum + p.totalSec, 0)

  return {
    dishes,
    segments: toSegments(allSteps),
    freeWindows: findFreeWindows(allSteps, totalSec),
    totalSec,
    serialSec,
    savedSec: Math.max(0, serialSec - totalSec),
  }
}

/**
 * 扫描线：所有步骤的起止点把时间轴切成若干段，每一段内"正在做的事"是固定的。
 */
export function toSegments(steps: TimelineStep[]): TimelineSegment[] {
  if (steps.length === 0) return []

  const bounds = [...new Set(steps.flatMap((s) => [s.startSec, s.startSec + s.durationSec]))].sort((a, b) => a - b)
  const segments: TimelineSegment[] = []

  for (let i = 0; i < bounds.length - 1; i++) {
    const startSec = bounds[i]
    const endSec = bounds[i + 1]
    // 半开区间的归属：起点 ≤ 段起点 且 终点 ≥ 段终点 的步骤，在这一整段里都活着
    const live = steps.filter((s) => s.startSec <= startSec && s.startSec + s.durationSec >= endSec)
    if (live.length === 0) continue

    // 相邻且成员完全相同的段要合并，否则「炖 40 分钟」会被切成 41 个 1 分钟的段
    const prev = segments[segments.length - 1]
    if (prev && prev.endSec === startSec && sameMembers(prev.steps, live)) {
      prev.endSec = endSec
      continue
    }

    segments.push({ startSec, endSec, steps: live, allPassive: live.every((s) => s.passive) })
  }

  return segments
}

function sameMembers(a: TimelineStep[], b: TimelineStep[]): boolean {
  if (a.length !== b.length) return false
  const ids = new Set(a.map((s) => s.stepId))
  return b.every((s) => ids.has(s.stepId))
}

/**
 * 找出"不需要你动手"的时段（FR-3.28）。
 *
 * 直接以"动手时段"的补集来算，而不是看分段——因为补集同时覆盖两种情况：
 *   - 只有被动等待在跑（排骨在炖）
 *   - 整段时间轴上什么都没有（前一道刚收工，下一道还没到点）
 * 这两种对用户是同一件事：这段时间可以走开，或者顺手做点别的。
 *
 * 太短的（< GAP_MIN_SEC）不算——1 分钟的缝儿提示了也没用。
 */
export function findFreeWindows(steps: TimelineStep[], totalSec: number): FreeWindow[] {
  const busy = steps
    .filter((s) => !s.passive)
    .map((s) => ({ start: s.startSec, end: s.startSec + s.durationSec }))
    .sort((a, b) => a.start - b.start)

  // 动手时段可能有上下步首尾相接或重叠，先合并成不相交的若干段
  const merged: Array<{ start: number; end: number }> = []
  for (const b of busy) {
    const prev = merged[merged.length - 1]
    if (prev && b.start <= prev.end) prev.end = Math.max(prev.end, b.end)
    else merged.push({ ...b })
  }

  const windows: FreeWindow[] = []
  const push = (startSec: number, endSec: number) => {
    if (endSec - startSec < GAP_MIN_SEC) return
    windows.push({
      startSec,
      endSec,
      // 这段时间里在等哪几道菜（纯空档时为空数组）
      waitingFor: [
        ...new Set(
          steps
            .filter((s) => s.passive && s.startSec < endSec && s.startSec + s.durationSec > startSec)
            .map((s) => s.recipeName),
        ),
      ],
    })
  }

  let cursor = 0
  for (const b of merged) {
    push(cursor, b.start)
    cursor = Math.max(cursor, b.end)
  }
  push(cursor, totalSec)

  return windows
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 秒 → 「1 小时 20 分」/「35 分钟」 */
export function formatClock(sec: number): string {
  const total = Math.max(0, Math.round(sec / 60))
  if (total < 60) return `${total} 分钟`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 相对起点的时间，如「+0:45」 */
export function formatOffset(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60)
  const s = Math.max(0, sec) % 60
  return `+${m}:${String(s).padStart(2, '0')}`
}
