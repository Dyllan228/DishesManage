/**
 * 图片处理（FR-1.19 ~ FR-1.23）
 *
 * 全部在浏览器里做，不依赖任何库：
 *   - 压缩：最长边 ≤ 1600px，转 WebP，质量 0.82（FR-1.20）
 *   - 缩略图：最长边 ≤ 300px，列表页用它，别让列表去解码 1600px 的大图
 *   - 去重：算 SHA-256，同一张图重复上传只存一份（FR-1.21 的副作用）
 *
 * 为什么一定要压缩：IndexedDB 的配额通常只有几百 MB，手机直出照片一张 4-8MB，
 * 几十道菜就能把配额吃满（FR-5.7 要提示的那个场景）。
 */

export const MAX_EDGE = 1600
export const THUMB_EDGE = 300
export const WEBP_QUALITY = 0.82

export interface ProcessedImage {
  blob: Blob
  thumbBlob: Blob
  width: number
  height: number
  size: number
  mimeType: string
  hash: string
}

/** 读出图片的原始尺寸与可绘制对象 */
async function loadImage(file: Blob): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { bitmap, width: bitmap.width, height: bitmap.height }
    } catch {
      /* 落到 <img> 方案（部分浏览器对某些格式不支持 createImageBitmap） */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解码失败，可能是格式不支持'))
      el.src = url
    })
    return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 等比缩放到最长边不超过 maxEdge；本来就够小就原样返回 */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const ratio = maxEdge / longest
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/**
 * 按目标宽高比居中裁剪（FR-1.19 的 4:3 / 1:1）。
 * 只裁不拉伸——拉伸会让菜看着变形，那是比留白更糟的观感。
 */
export function cropToRatio(
  width: number,
  height: number,
  ratio: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const current = width / height
  if (Math.abs(current - ratio) < 0.01) return { sx: 0, sy: 0, sw: width, sh: height }
  if (current > ratio) {
    // 太宽：左右各裁一点
    const sw = Math.round(height * ratio)
    return { sx: Math.round((width - sw) / 2), sy: 0, sw, sh: height }
  }
  const sh = Math.round(width / ratio)
  return { sx: 0, sy: Math.round((height - sh) / 2), sw: width, sh }
}

async function drawToBlob(
  source: ImageBitmap | HTMLImageElement,
  sourceRect: { sx: number; sy: number; sw: number; sh: number },
  target: { width: number; height: number },
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D，无法压缩图片')

  // 缩小时开双线性以上质量，否则缩略图会出现锯齿
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // 透明背景填白，避免 WebP 透明区域在深色主题下变成黑块
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, target.width, target.height)
  ctx.drawImage(source, sourceRect.sx, sourceRect.sy, sourceRect.sw, sourceRect.sh, 0, 0, target.width, target.height)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/webp', quality)
  })
  if (blob) return blob
  // WebP 不被支持时退到 JPEG（老 Safari）
  const fallback = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality))
  if (!fallback) throw new Error('图片编码失败')
  return fallback
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // 没有 SubtleCrypto（非安全上下文）时退到简单指纹，只用于去重，不用于安全
  let h = 2166136261
  const view = new Uint8Array(buf)
  for (let i = 0; i < view.length; i++) {
    h ^= view[i]
    h = Math.imul(h, 16777619)
  }
  return `fnv1a_${(h >>> 0).toString(16)}`
}

/**
 * 完整处理一张图：压缩 + 生成缩略图 + 算指纹。
 * `ratio` 给定时先按该比例居中裁剪（封面用 4:3 或 1:1）。
 */
export async function processImage(file: Blob, ratio?: number): Promise<ProcessedImage> {
  const { bitmap, width, height } = await loadImage(file)

  try {
    const rect = ratio ? cropToRatio(width, height, ratio) : { sx: 0, sy: 0, sw: width, sh: height }
    const main = fitWithin(rect.sw, rect.sh, MAX_EDGE)
    const thumb = fitWithin(rect.sw, rect.sh, THUMB_EDGE)

    const [blob, thumbBlob] = await Promise.all([
      drawToBlob(bitmap, rect, main, WEBP_QUALITY),
      drawToBlob(bitmap, rect, thumb, WEBP_QUALITY),
    ])

    return {
      blob,
      thumbBlob,
      width: main.width,
      height: main.height,
      size: blob.size,
      mimeType: blob.type || 'image/webp',
      hash: await sha256Hex(blob),
    }
  } finally {
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()
  }
}

// ---------------------------------------------------------------------------
// 显示辅助
// ---------------------------------------------------------------------------

/** 占位色块：无封面时按菜名散列出一个稳定的颜色（FR-1.23） */
export function placeholderColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  // 固定亮度与饱和度，只变色调，保证和品牌色系观感一致
  return `hsl(${h % 360} 42% 88%)`
}

export function placeholderTextColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 45% 38%)`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
