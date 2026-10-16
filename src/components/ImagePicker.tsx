/**
 * 图片选择器（FR-1.19 ~ FR-1.22）
 *
 * 交互上刻意做了一件事：**图片先落库、再保存菜谱**。
 * 因为新建菜谱时还没有 recipeId，没法把图挂在菜谱上。代价是用户选了图又放弃保存
 * 会留下一张孤儿图——这个由 repository 的 `gcImages()` 在进入设置页时清理，
 * 比"必须保存菜谱后才能选封面"这种反直觉的流程好得多。
 */

import { useEffect, useRef, useState } from 'react'
import DishImage from './DishImage'
import { putImage } from '@/data/repository'
import { formatBytes, processImage } from '@/domain/image'
import { useAppStore } from '@/store/appStore'

export type CropRatio = '4:3' | '1:1' | 'free'

const RATIO_VALUE: Record<CropRatio, number | undefined> = {
  '4:3': 4 / 3,
  '1:1': 1,
  free: undefined,
}

const RATIO_LABEL: Record<CropRatio, string> = { '4:3': '4:3', '1:1': '1:1', free: '原图' }

interface Props {
  /** 当前图片的 blobId，null 表示还没选 */
  value: string | null
  onChange: (blobId: string | null) => void
  /** 占位块上显示的字（菜名） */
  name: string
  /** 封面允许用户选裁剪比例；步骤图固定原图，免得切菜的手势图被裁掉一半 */
  allowRatio?: boolean
  className?: string
  /** 预览区的宽高比 class，如 'aspect-[4/3]' */
  aspectClass?: string
}

export default function ImagePicker({
  value,
  onChange,
  name,
  allowRatio = false,
  className = '',
  aspectClass = 'aspect-[4/3]',
}: Props) {
  const [ratio, setRatio] = useState<CropRatio>('4:3')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [info, setInfo] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const showToast = useAppStore((s) => s.showToast)

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 5000)
    return () => clearTimeout(t)
  }, [error])

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('只能选图片文件')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const processed = await processImage(file, RATIO_VALUE[ratio])
      const { id, deduped } = await putImage(processed)
      onChange(id)
      setInfo(processed.size)
      // 去重命中的话要说一声，否则用户会以为"怎么没变"
      showToast(deduped ? '这张图已经有过了，直接复用' : `已压缩到 ${formatBytes(processed.size)}`)
    } catch (e) {
      setError((e as Error).message || '图片处理失败')
    } finally {
      setBusy(false)
      // 清空 input，否则连续选同一张图不会触发 change
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className={className}>
      <div
        className={`relative overflow-hidden rounded-xl border-2 border-dashed transition ${
          dragging ? 'border-brand-500 bg-brand-50' : 'border-stone-200 bg-stone-50'
        } ${aspectClass}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void handleFile(e.dataTransfer.files[0])
        }}
      >
        {value ? (
          <>
            <DishImage blobId={value} name={name} variant="thumb" className="h-full w-full" />
            <button
              type="button"
              className="absolute right-2 top-2 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur"
              onClick={() => onChange(null)}
              title="移除这张图"
            >
              移除
            </button>
          </>
        ) : (
          <button
            type="button"
            className="flex h-full w-full flex-col items-center justify-center gap-1 text-stone-400"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <span className="text-2xl">＋</span>
            <span className="text-xs">{busy ? '处理中…' : '拍照 / 从相册选择'}</span>
            <span className="text-[11px] text-stone-300">也可以把图片拖进来</span>
          </button>
        )}

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs text-stone-600">
            正在压缩…
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />

      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-stone-400">
        {allowRatio && (
          <div className="flex overflow-hidden rounded-md border border-stone-200">
            {(['4:3', '1:1', 'free'] as CropRatio[]).map((r) => (
              <button
                key={r}
                type="button"
                className={`px-2 py-0.5 ${ratio === r ? 'bg-brand-600 text-white' : 'bg-white text-stone-500'}`}
                onClick={() => setRatio(r)}
              >
                {RATIO_LABEL[r]}
              </button>
            ))}
          </div>
        )}
        <span className="min-w-0 flex-1 truncate">
          {value ? (info ? `已压缩 ${formatBytes(info)}` : '点击图片右上角可移除') : '会自动压到 1600px 以内'}
        </span>
      </div>

      {error && <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
