/**
 * 从 IndexedDB 里的 Blob 渲染一张图（FR-1.21 / FR-1.23）
 *
 * 为什么单独抽一个组件：`URL.createObjectURL` 必须配对 `revokeObjectURL`，
 * 否则每渲染一次列表就漏一份内存，滚动几屏就能把手机浏览器拖垮。
 * 把生命周期关在组件里，用的人不会忘。
 */

import { useEffect, useState } from 'react'
import { getImageBlob, getThumbBlob } from '@/data/repository'
import { placeholderColor, placeholderTextColor } from '@/domain/image'

interface Props {
  blobId: string | null
  /** 没有图时用菜名首字做占位块 */
  name: string
  className?: string
  /** 列表用缩略图，详情用原图 */
  variant?: 'thumb' | 'full'
  alt?: string
}

export default function DishImage({ blobId, name, className = '', variant = 'thumb', alt }: Props) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!blobId) {
      setUrl(null)
      return
    }
    let revoked = false
    let created: string | null = null

    void (async () => {
      // 列表用缩略图（免去解码 1600px 大图的开销），详情才取原图
      const blob = variant === 'thumb' ? await getThumbBlob(blobId) : await getImageBlob(blobId)
      if (!blob || revoked) return
      created = URL.createObjectURL(blob)
      setUrl(created)
    })()

    return () => {
      revoked = true
      setUrl(null)
      if (created) URL.revokeObjectURL(created)
    }
  }, [blobId, variant])

  if (url) {
    return (
      <img
        src={url}
        alt={alt ?? name}
        loading="lazy"
        decoding="async"
        className={`object-cover ${className}`}
      />
    )
  }

  // 占位块：色相由菜名散列而来，同一道菜每次都是同一个颜色，看起来不像随机噪点
  return (
    <div
      className={`flex items-center justify-center font-semibold ${className}`}
      style={{ backgroundColor: placeholderColor(name), color: placeholderTextColor(name) }}
      aria-label={alt ?? name}
      role="img"
    >
      <span className="text-[1.6em] leading-none opacity-90">{name.trim().charAt(0) || '菜'}</span>
    </div>
  )
}
