import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import BottomNav from '@/components/BottomNav'
import Toast from '@/components/Toast'
import TimerBar from '@/components/TimerBar'
import RecipesPage from '@/pages/RecipesPage'
import RecipeDetailPage from '@/pages/RecipeDetailPage'
import RecipeEditPage from '@/pages/RecipeEditPage'
import MenuPage from '@/pages/MenuPage'
import TimelinePage from '@/pages/TimelinePage'
import CookPage from '@/pages/CookPage'
import HistoryPage from '@/pages/HistoryPage'
import ShoppingPage from '@/pages/ShoppingPage'
import SettingsPage from '@/pages/SettingsPage'
import CategoryManagePage from '@/pages/CategoryManagePage'
import TagManagePage from '@/pages/TagManagePage'
import ImportPage from '@/pages/ImportPage'
import LlmSettingsPage from '@/pages/LlmSettingsPage'
import BackupPage from '@/pages/BackupPage'
import TrashPage from '@/pages/TrashPage'
import { listMenu } from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import { startTimerHeartbeat, useTimerStore } from '@/store/timerStore'
import { timerBarHeight } from '@/domain/timerLayout'

/** 底部导航占用的高度（Tailwind 的 pb-24） */
const NAV_SPACE_PX = 96

export default function App() {
  const location = useLocation()
  const setMenuCount = useAppStore((s) => s.setMenuCount)
  const timers = useTimerStore((s) => s.timers)

  // 计时器心跳挂在 App 顶层：计时必须在页面之间活着。
  // 放在制作模式里，用户一切页看备菜清单，计时就归零了——那还不如手机自带的秒表。
  useEffect(() => startTimerHeartbeat(), [])

  // 菜单数量是全局面板角标，路由切换时同步一次
  useEffect(() => {
    void listMenu().then((m) => setMenuCount(m.length))
  }, [location.pathname, setMenuCount])

  // 路由切换时回到顶部
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  // 计时器条浮在底部，会盖住页面最后一块内容（在制作模式里正好是「下一步」）。
  // 留白高度与 TimerBar 共用 `timerBarHeight`，两边不会各改各的。
  const bottomSpace = NAV_SPACE_PX + timerBarHeight(timers)

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
      <main className="flex flex-1 flex-col" style={{ paddingBottom: bottomSpace }}>
        <Routes>
          <Route path="/" element={<Navigate to="/recipes" replace />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/recipes/new" element={<RecipeEditPage />} />
          <Route path="/recipes/import" element={<ImportPage />} />
          <Route path="/recipes/:id" element={<RecipeDetailPage />} />
          <Route path="/recipes/:id/edit" element={<RecipeEditPage />} />
          <Route path="/menu" element={<MenuPage />} />
          <Route path="/menu/timeline" element={<TimelinePage />} />
          <Route path="/menu/cook/:menuItemId" element={<CookPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/shopping" element={<ShoppingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/categories" element={<CategoryManagePage />} />
          <Route path="/settings/tags" element={<TagManagePage />} />
          <Route path="/settings/llm" element={<LlmSettingsPage />} />
          <Route path="/settings/backup" element={<BackupPage />} />
          <Route path="/settings/trash" element={<TrashPage />} />
          <Route path="*" element={<Navigate to="/recipes" replace />} />
        </Routes>
      </main>
      <TimerBar />
      <BottomNav />
      <Toast />
    </div>
  )
}
