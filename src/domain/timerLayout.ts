/**
 * 计时器条的占位高度（FR-3.24）
 *
 * 计时器条是浮在屏幕底部的，会盖住页面最下面那一块——在制作模式里那块正好是
 * 「下一步」按钮，被盖住就等于做不下去了。所以页面底部必须留出与它等高的空白。
 *
 * 留白高度不能各算各的：如果 TimerBar 里改了行高、App 里的留白没跟着改，
 * 就会出现"在某些手机上按钮被挡住"这种只在特定设备复现的 bug。
 * 因此两边都只读这里的常量与函数，数字只在一个地方定义。
 *
 * 放在 domain 而不是组件文件里，是为了能在 node 环境下直接测（组件文件是 .tsx，
 * 测试配置只收 .ts）。
 */

import type { CookTimer } from '@/store/timerStore'

/** 单个计时器行：标签行 + 进度条 + 上下内边距，实测约 52px */
export const TIMER_ROW_PX = 52

/** 「XX 到点了」那条红色横幅 */
export const TIMER_BANNER_PX = 44

/** 两个以上计时器时才会出现的「全部取消」小按钮 */
export const TIMER_CANCEL_ALL_PX = 34

/** 行与行之间的间距（Tailwind space-y-1.5） */
export const TIMER_GAP_PX = 6

/** 计时器条与底部导航之间的距离感，别贴太紧 */
export const TIMER_STACK_GAP_PX = 8

/**
 * 计时器条当前占用的高度（px）。
 *
 * 注意：**已响铃的计时器不单独占行**，它们被折叠进那一条红色横幅里，
 * 所以行数只数未响铃的。
 */
export function timerBarHeight(timers: CookTimer[]): number {
  if (timers.length === 0) return 0

  const activeRows = timers.filter((t) => !t.fired).length
  const hasBanner = timers.some((t) => t.fired)
  // 「全部取消」只在"没有横幅 且 两个以上在跑"时出现，条件必须与 TimerBar 里一致
  const hasCancelAll = !hasBanner && activeRows > 1

  const blocks = activeRows + (hasBanner ? 1 : 0) + (hasCancelAll ? 1 : 0)
  if (blocks === 0) return 0

  const heights =
    activeRows * TIMER_ROW_PX + (hasBanner ? TIMER_BANNER_PX : 0) + (hasCancelAll ? TIMER_CANCEL_ALL_PX : 0)
  return heights + (blocks - 1) * TIMER_GAP_PX + TIMER_STACK_GAP_PX
}
