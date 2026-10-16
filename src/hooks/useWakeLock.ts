/**
 * 屏幕常亮（FR-3.22）
 *
 * 做菜时手是湿的、油的，不会去碰屏幕。默认 30 秒息屏意味着每半分钟要擦手解锁一次——
 * 这个功能不做，制作模式基本没法用。
 *
 * 两个坑：
 *   1. Wake Lock 只在**可见**的页面上有效，切到后台会被浏览器自动释放。
 *      所以必须在 `visibilitychange` 时重新申请，否则用户切出去看一眼消息回来就失效了。
 *   2. 不是所有浏览器都支持（Safari 到 16.4 才有）。不支持时要让用户知道
 *      「你手动把自动锁屏调长一点」，而不是默默什么都不做。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

interface NavigatorWithWakeLock {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
}

export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

export interface WakeLockState {
  /** 当前是否真的held住（不是"申请过"） */
  active: boolean
  supported: boolean
  /** 需要用户手动延长锁屏时给出的提示文案 */
  hint: string | null
  request: () => Promise<void>
  release: () => Promise<void>
}

export function useWakeLock(enabled = true): WakeLockState {
  const supported = isWakeLockSupported()
  const [active, setActive] = useState(false)
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null)

  const request = useCallback(async () => {
    if (!supported) return
    // 已经有活的就别重复申请，否则每切一次页面就攒一个 sentinel
    if (sentinelRef.current && !sentinelRef.current.released) return
    try {
      const sentinel = await (navigator as NavigatorWithWakeLock).wakeLock!.request('screen')
      sentinelRef.current = sentinel
      setActive(true)
      // 浏览器主动释放（切后台、电量低）时把状态同步回来
      sentinel.addEventListener('release', () => {
        sentinelRef.current = null
        setActive(false)
      })
    } catch {
      // 用户没交互过、或页面不可见时会 reject。不算错误，保持静默
      setActive(false)
    }
  }, [supported])

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    setActive(false)
    if (!sentinel || sentinel.released) return
    try {
      await sentinel.release()
    } catch {
      /* 已经释放了，忽略 */
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      void release()
      return
    }
    void request()

    const onVisibility = () => {
      // 回到前台时重新申请——切后台期间浏览器必然把锁释放了
      if (document.visibilityState === 'visible') void request()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      // 退出页面一定释放，不然屏幕会一直亮着耗电
      void release()
    }
  }, [enabled, request, release])

  return {
    active,
    supported,
    hint: supported ? null : '这个浏览器不支持屏幕常亮，建议手动把自动锁屏时间调长一些',
    request,
    release,
  }
}
