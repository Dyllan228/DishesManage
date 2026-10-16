/**
 * 计时器条占位高度的测试
 *
 * 这块逻辑的价值全在"两边用同一个数字"上，所以测试也集中在数学上：
 * 空、一行、多行、有横幅、只有横幅。
 */

import { describe, expect, it } from 'vitest'
import {
  TIMER_BANNER_PX,
  TIMER_CANCEL_ALL_PX,
  TIMER_GAP_PX,
  TIMER_ROW_PX,
  TIMER_STACK_GAP_PX,
  timerBarHeight,
} from './timerLayout'
import type { CookTimer } from '@/store/timerStore'

function timer(id: string, fired = false): CookTimer {
  return { id, label: id, endsAt: 0, totalSec: 600, recipeName: null, fired }
}

describe('计时器条占位高度', () => {
  it('没有计时器时不占位', () => {
    expect(timerBarHeight([])).toBe(0)
  })

  it('一条计时器 = 一行 + 间距（不出现「全部取消」）', () => {
    expect(timerBarHeight([timer('a')])).toBe(TIMER_ROW_PX + TIMER_STACK_GAP_PX)
  })

  it('两条在跑的计时器会多出「全部取消」那一个小按钮', () => {
    expect(timerBarHeight([timer('a'), timer('b')])).toBe(
      2 * TIMER_ROW_PX + TIMER_CANCEL_ALL_PX + 2 * TIMER_GAP_PX + TIMER_STACK_GAP_PX,
    )
  })

  it('响铃的计时器不单独占行，只多一条横幅', () => {
    const h = timerBarHeight([timer('a'), timer('b', true)])
    expect(h).toBe(TIMER_ROW_PX + TIMER_BANNER_PX + TIMER_GAP_PX + TIMER_STACK_GAP_PX)
  })

  it('有横幅时不再显示「全部取消」', () => {
    // 两条在跑 + 一条响铃：横幅已经给了"清掉响铃"的动作，全部取消让位
    const h = timerBarHeight([timer('a'), timer('b'), timer('c', true)])
    expect(h).toBe(2 * TIMER_ROW_PX + TIMER_BANNER_PX + 2 * TIMER_GAP_PX + TIMER_STACK_GAP_PX)
  })

  it('全部响铃时只剩一条横幅', () => {
    expect(timerBarHeight([timer('a', true), timer('b', true)])).toBe(
      TIMER_BANNER_PX + TIMER_STACK_GAP_PX,
    )
  })

  it('占位高度只为"看得见的东西"买单，不会凭空多出来', () => {
    // 空 → 一条在跑：只多一行
    expect(timerBarHeight([timer('a')]) - timerBarHeight([])).toBe(TIMER_ROW_PX + TIMER_STACK_GAP_PX)
    // 一条在跑 → 两条在跑：多一行 + 一个「全部取消」+ 两个间距
    // （从 1 个块变成 3 个块，间距从 0 个变成 2 个，所以是两个间距而不是一个）
    expect(timerBarHeight([timer('a'), timer('b')]) - timerBarHeight([timer('a')])).toBe(
      TIMER_ROW_PX + TIMER_CANCEL_ALL_PX + 2 * TIMER_GAP_PX,
    )
    // 两条在跑 → 三条在跑：只多一行 + 一个间距
    expect(
      timerBarHeight([timer('a'), timer('b'), timer('c')]) - timerBarHeight([timer('a'), timer('b')]),
    ).toBe(TIMER_ROW_PX + TIMER_GAP_PX)
  })
})
