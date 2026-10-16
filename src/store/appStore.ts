import { create } from 'zustand'

/**
 * 全局 UI 状态。
 *
 * 只放跨页面共享的瞬时状态；业务数据一律从 repository 读取（不放进全局 store，
 * 避免出现两处真相）。
 */
interface AppState {
  /** 已点菜数，用于底部 Tab 角标（FR-3.5） */
  menuCount: number
  setMenuCount: (n: number) => void

  /** 轻提示 */
  toast: string | null
  showToast: (message: string) => void
  clearToast: () => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useAppStore = create<AppState>((set) => ({
  menuCount: 0,
  setMenuCount: (n) => set({ menuCount: n }),

  toast: null,
  showToast: (message) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: message })
    toastTimer = setTimeout(() => set({ toast: null }), 2200)
  },
  clearToast: () => set({ toast: null }),
}))
