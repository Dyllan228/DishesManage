import { useAppStore } from '@/store/appStore'

export default function Toast() {
  const toast = useAppStore((s) => s.toast)
  if (!toast) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <div className="rounded-full bg-stone-900/90 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>
    </div>
  )
}
