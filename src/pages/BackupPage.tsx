/**
 * 备份与恢复（FR-5.1 ~ FR-5.7）
 *
 * 这个页面的所有文案都在做同一件事：让用户意识到「清了浏览器数据 = 数据全丢」。
 * 纯本地应用最大的风险不是被黑，是用户换个手机、重装浏览器，几十道菜就没了。
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import {
  BACKUP_REMIND_DAYS,
  daysSince,
  gcImages,
  getLastBackupAt,
  getStorageInfo,
  imageStats,
  listDeletedRecipes,
  markBackedUp,
  requestPersistentStorage,
  restoreAll,
  validateBackup,
  type RestoreStats,
  type StorageInfo,
} from '@/data/repository'
import { exportExcel, exportJson, readBackupFile } from '@/data/backup'
import { formatBytes } from '@/domain/image'
import { useAppStore } from '@/store/appStore'

/** 用到 80% 配额就该提醒了——再不做点什么，写入会开始随机失败 */
const QUOTA_WARN_RATIO = 0.8

type Busy = null | 'json' | 'excel' | 'import'

export default function BackupPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [busy, setBusy] = useState<Busy>(null)
  const [includeImages, setIncludeImages] = useState(true)
  const [pending, setPending] = useState<{ stats: RestoreStats; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: lastBackup, reload: reloadBackup } = useAsync<number | null>(() => getLastBackupAt(), [], null)
  const { data: storage, reload: reloadStorage } = useAsync<StorageInfo>(
    () => getStorageInfo(),
    [],
    { usage: 0, quota: 0, ratio: null, persisted: false, supported: false },
  )
  const { data: images, reload: reloadImages } = useAsync(() => imageStats(), [], { count: 0, bytes: 0 })
  const { data: trash, reload: reloadTrash } = useAsync(() => listDeletedRecipes(), [], [])

  // 进页面顺手清一次孤儿图：取消保存菜谱时留下的封面、被换掉的旧图都在这时候回收
  useEffect(() => {
    void (async () => {
      const { removed, freedBytes } = await gcImages()
      if (removed > 0) {
        setNotice(`顺手清理了 ${removed} 张没人引用的图片，释放 ${formatBytes(freedBytes)}`)
        await Promise.all([reloadImages(), reloadStorage()])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doExportJson = async (withImages: boolean) => {
    setBusy('json')
    setError(null)
    try {
      const result = await exportJson(withImages)
      showToast(`已导出 ${formatBytes(result.bytes)}`)
      await Promise.all([reloadBackup(), reloadStorage()])
    } catch (e) {
      setError(`导出失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const doExportExcel = async () => {
    setBusy('excel')
    setError(null)
    try {
      const result = await exportExcel()
      showToast(`已导出 Excel（${formatBytes(result.bytes)}）`)
      await reloadBackup()
    } catch (e) {
      setError(`导出失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (file: File | undefined, mode: 'overwrite' | 'merge') => {
    if (!file) return
    setBusy('import')
    setError(null)
    try {
      const backup = validateBackup(await readBackupFile(file))
      const stats = await restoreAll(backup, mode)
      await markBackedUp()
      setPending({ stats, name: file.name })
      await Promise.all([reloadBackup(), reloadStorage(), reloadImages(), reloadTrash()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const persist = async () => {
    const ok = await requestPersistentStorage()
    showToast(ok ? '已申请持久化存储，浏览器不会再自动清你的数据' : '这个浏览器不支持，或不满足持久化条件')
    await reloadStorage()
  }

  const days = daysSince(lastBackup)
  const needRemind = days === null || days >= BACKUP_REMIND_DAYS
  const quotaRatio = storage.ratio
  const quotaWarn = quotaRatio !== null && quotaRatio >= QUOTA_WARN_RATIO

  return (
    <div className="px-4 pb-28 pt-4">
      <header className="mb-4 flex items-center gap-2">
        <Link to="/settings" className="btn-ghost px-2">
          ← 返回
        </Link>
        <h1 className="text-lg font-semibold">备份与恢复</h1>
      </header>

      {/* 数据安全提示 */}
      <section
        className={`mb-4 rounded-xl px-3 py-2.5 text-xs ${
          needRemind ? 'bg-amber-50 text-amber-900' : 'bg-stone-100 text-stone-600'
        }`}
      >
        {days === null ? (
          <p>还没备份过。数据只存在这台设备的浏览器里，清了浏览器数据就没了。</p>
        ) : needRemind ? (
          <p>已经 {days} 天没备份了，建议现在导出一份（每 {BACKUP_REMIND_DAYS} 天提醒一次）。</p>
        ) : (
          <p>上次备份：{days === 0 ? '今天' : `${days} 天前`}，一切正常。</p>
        )}
      </section>

      <section className="card mb-4 space-y-3 p-3">
        <h2 className="text-sm font-semibold text-stone-700">导出</h2>

        <label className="flex items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
            className="accent-brand-600"
          />
          包含图片（{images.count} 张，约 {formatBytes(images.bytes)}）
          {includeImages && images.count > 0 && (
            <span className="text-stone-400">· 会让文件大不少，但换设备能完整还原</span>
          )}
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={busy !== null}
            onClick={() => void doExportJson(includeImages)}
          >
            {busy === 'json' ? '导出中…' : '导出 JSON 备份'}
          </button>
          <button
            type="button"
            className="btn-secondary flex-1"
            disabled={busy !== null}
            onClick={() => void doExportExcel()}
          >
            {busy === 'excel' ? '导出中…' : '导出 Excel'}
          </button>
        </div>

        <p className="text-[11px] leading-relaxed text-stone-400">
          JSON 是<strong className="text-stone-500">完整备份</strong>，能在本应用里原样恢复，请留这个。
          Excel 是把菜谱摊平成表格，方便打印或拿去别处整理，<strong className="text-stone-500">不能</strong>作为备份导回。
        </p>
      </section>

      <section className="card mb-4 space-y-3 p-3">
        <h2 className="text-sm font-semibold text-stone-700">导入</h2>
        <p className="text-[11px] leading-relaxed text-stone-500">
          选择之前导出的 JSON 备份文件。导入方式在选完文件后由你决定。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="block w-full text-xs text-stone-500 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-xs file:text-brand-700"
          disabled={busy !== null}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary flex-1 text-xs"
            disabled={busy !== null}
            onClick={() => {
              const file = fileRef.current?.files?.[0]
              if (!file) {
                setError('先选一个备份文件再点导入')
                return
              }
              void doImport(file, 'merge')
            }}
          >
            合并导入
          </button>
          <button
            type="button"
            className="btn-secondary flex-1 text-xs text-red-600"
            disabled={busy !== null}
            onClick={() => {
              const file = fileRef.current?.files?.[0]
              if (!file) {
                setError('先选一个备份文件再点导入')
                return
              }
              void doImport(file, 'overwrite')
            }}
          >
            覆盖导入
          </button>
        </div>
        <div className="rounded-lg bg-stone-50 px-2.5 py-2 text-[11px] leading-relaxed text-stone-500">
          <p>
            <strong className="text-stone-600">合并导入</strong>：保留现有数据，把备份里没有的补进来；
            同一条记录两边都有时，保留修改时间较新的那个。适合把旧手机的菜谱并进来。
          </p>
          <p className="mt-1">
            <strong className="text-red-600">覆盖导入</strong>：先清空当前所有数据，再完全按备份还原。
            适合换设备或数据被改坏了想回到备份那一刻。
          </p>
        </div>
      </section>

      {pending && (
        <section className="card mb-4 border border-green-200 bg-green-50 p-3 text-xs text-green-900">
          <h2 className="text-sm font-semibold">导入完成（{pending.name}）</h2>
          <ul className="mt-1.5 space-y-0.5">
            <li>新增 {pending.stats.added} 条</li>
            <li>更新 {pending.stats.updated} 条</li>
            {pending.stats.skipped > 0 && <li>保留本地较新版本 {pending.stats.skipped} 条（未覆盖）</li>}
            {pending.stats.mode === 'overwrite' && <li>覆盖前清空 {pending.stats.cleared} 条</li>}
            {pending.stats.images > 0 && <li>还原图片 {pending.stats.images} 张</li>}
          </ul>
          <button type="button" className="mt-2 underline" onClick={() => setPending(null)}>
            知道了
          </button>
        </section>
      )}

      <section className="card mb-4 space-y-2 p-3">
        <h2 className="text-sm font-semibold text-stone-700">存储占用</h2>
        {storage.supported ? (
          <>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-semibold tabular-nums">{formatBytes(storage.usage)}</span>
              <span className="text-xs text-stone-400">/ {formatBytes(storage.quota)} 可用</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-stone-100">
              <div
                className={`h-full ${quotaWarn ? 'bg-red-500' : 'bg-brand-500'}`}
                style={{ width: `${Math.min(100, Math.round((quotaRatio ?? 0) * 100))}%` }}
              />
            </div>
            <p className="text-[11px] text-stone-400">
              其中图片 {images.count} 张占 {formatBytes(images.bytes)}。
            </p>
            {quotaWarn && (
              <p className="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
                空间快满了。再往里塞图片可能写入失败，建议先导出备份，
                然后在「回收站」清空或删掉一些不用的菜谱。
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-stone-400">这个浏览器不提供存储用量信息。</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <span className={`text-xs ${storage.persisted ? 'text-green-700' : 'text-stone-500'}`}>
            {storage.persisted ? '✓ 已申请持久化存储' : '未申请持久化存储'}
          </span>
          {!storage.persisted && storage.supported && (
            <button type="button" className="btn-ghost ml-auto px-2 text-xs" onClick={() => void persist()}>
              申请
            </button>
          )}
        </div>
        {!storage.persisted && storage.supported && (
          <p className="text-[11px] text-stone-400">
            申请后浏览器在空间紧张时不会自动清掉你的菜谱；不申请也建议定期导出备份。
          </p>
        )}
      </section>

      <section className="card mb-4 p-3">
        <div className="flex items-center">
          <h2 className="text-sm font-semibold text-stone-700">回收站</h2>
          <span className="ml-2 text-xs text-stone-400">{trash.length} 道</span>
          <Link to="/settings/trash" className="ml-auto text-xs text-brand-600">
            查看 ›
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-stone-400">
          删除的菜谱保留 30 天，期间可以随时恢复。
        </p>
      </section>

      {notice && <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-[11px] text-stone-600">{notice}</p>}
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      <p className="text-center text-[11px] leading-relaxed text-stone-400">
        备份文件里包含你的全部菜谱、图片和大模型 API Key，
        <br />
        请像对待相册一样保管它——发给别人之前先想清楚。
      </p>
    </div>
  )
}
