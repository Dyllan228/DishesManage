import { NavLink } from 'react-router-dom'
import { useAppStore } from '@/store/appStore'

const TABS = [
  { to: '/recipes', label: '菜谱', icon: '📖' },
  { to: '/menu', label: '点菜', icon: '🛒' },
  { to: '/shopping', label: '备菜', icon: '🧺' },
  { to: '/history', label: '历史', icon: '🕘' },
  { to: '/settings', label: '我的', icon: '⚙️' },
]

export default function BottomNav() {
  const menuCount = useAppStore((s) => s.menuCount)

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-stone-200 bg-white/95 backdrop-blur">
      <div className="pb-safe mx-auto flex w-full max-w-3xl items-stretch px-2 pt-1">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-xs transition-colors ${
                isActive ? 'text-brand-600 font-medium' : 'text-stone-500'
              }`
            }
          >
            <span className="text-lg leading-none">
              {tab.icon}
              {tab.to === '/menu' && menuCount > 0 && (
                <span className="absolute -right-1 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">
                  {menuCount}
                </span>
              )}
            </span>
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
