/**
 * M5 · 图片与备份的测试
 *
 * 这里有两类用例：
 *   1. **字节级正确性**——手写的 ZIP 写入器和 base64 编码器没有库兜底，
 *      写错一个偏移量就是一整个打不开的文件。所以校验用的都是独立实现
 *      （Node 的 Buffer 做 base64、自己按规范解 ZIP 结构），而不是自己验自己。
 *   2. **破坏性操作的边界**——导入是覆盖还是合并、冲突留哪一条、
 *      换封面会不会把还在用的图删掉。这些点错了，用户丢的是全部数据。
 *
 * 注：canvas / createImageBitmap 相关的真实压缩流程只能在浏览器里跑，
 * 这里只覆盖 image.ts 里的纯函数部分。
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  BACKUP_REMIND_DAYS,
  dataUrlToBlob,
  dumpAll,
  daysSince,
  gcImages,
  getImageBlob,
  getLastBackupAt,
  getStorageInfo,
  imageStats,
  initDatabase,
  markBackedUp,
  purgeExpiredTrash,
  purgeRecipe,
  putImage,
  requestPersistentStorage,
  restoreAll,
  setRecipeCover,
  setStepImage,
  setSetting,
  shouldRemindBackup,
  validateBackup,
  createRecipe,
  deleteRecipe,
  listDeletedRecipes,
} from './repository'
import { buildExcelSheets, backupFilename, excelFilename } from './backup'
import { buildXlsx, columnName, sanitizeSheetName } from '@/domain/xlsx'
import { crc32, createZip, type ZipEntry } from '@/domain/zip'
import { cropToRatio, fitWithin, formatBytes, placeholderColor, sha256Hex } from '@/domain/image'
import type { BackupData } from './repository'
import type { RecipeDraft } from '@/types/models'

const encoder = new TextEncoder()

async function resetDb() {
  db.close()
  await db.delete()
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await db.open()
}

beforeEach(async () => {
  await resetDb()
  await initDatabase()
})

function draft(name: string, categoryId: string, tagIds: string[] = []): RecipeDraft {
  return {
    name,
    intro: null,
    categoryId,
    tagIds,
    servings: 2,
    durationMin: 30,
    difficulty: 1,
    sourceType: 'manual',
    sourceText: null,
    tips: null,
    ingredients: [
      { kind: 'main', name: '番茄', normalizedId: 'ing_tomato', amount: 2, amountText: null, unit: '个', note: null, order: 0 },
      { kind: 'seasoning', name: '食盐', normalizedId: 'ing_salt', amount: 3, amountText: null, unit: 'g', note: null, order: 1 },
    ],
    steps: [
      { order: 0, text: '番茄切块', imageBlobId: null, timerSec: null, timerLabel: null },
      { order: 1, text: '炒 3 分钟', imageBlobId: null, timerSec: 180, timerLabel: '炒' },
    ],
  }
}

async function firstCategoryId(): Promise<string> {
  const cats = await db.categories.orderBy('order').toArray()
  const leaf = cats.find((c) => c.parentId !== null) ?? cats[0]
  return leaf.id
}

/** 造一张假的"图片"Blob——内容不重要，重要的是字节能被原样还原 */
function fakeImage(bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 255, 128]): Blob {
  return new Blob([new Uint8Array(bytes) as unknown as BlobPart], { type: 'image/webp' })
}

async function seedImage(hash: string, bytes?: number[]): Promise<string> {
  const blob = fakeImage(bytes)
  const { id } = await putImage({
    blob,
    thumbBlob: fakeImage([1, 2, 3]),
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    size: blob.size,
    hash,
  })
  return id
}

// ---------------------------------------------------------------------------
// ZIP 写入器
// ---------------------------------------------------------------------------

describe('ZIP 写入器', () => {
  it('CRC-32 与标准测试向量一致', () => {
    // "123456789" 的 CRC-32 是 0xCBF43926，这是这个算法的标准测试向量
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array([]))).toBe(0)
    expect(crc32(encoder.encode('a'))).toBe(0xe8b7be43)
  })

  it('产出结构合法的 ZIP：能按中央目录原样解出每个条目', () => {
    const entries: ZipEntry[] = [
      { name: 'a.txt', data: encoder.encode('hello') },
      { name: 'dir/b.txt', data: encoder.encode('世界') },
    ]
    const zip = createZip(entries)

    // 本地文件头
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50)

    // 结尾记录：条目数、中央目录大小与偏移
    const eocdOffset = zip.length - 22
    const ev = new DataView(zip.buffer)
    expect(ev.getUint32(eocdOffset, true)).toBe(0x06054b50)
    expect(ev.getUint16(eocdOffset + 8, true)).toBe(2)
    expect(ev.getUint16(eocdOffset + 10, true)).toBe(2)
    const centralSize = ev.getUint32(eocdOffset + 12, true)
    const centralOffset = ev.getUint32(eocdOffset + 16, true)
    expect(centralOffset + centralSize).toBe(eocdOffset)

    // 顺着中央目录走一遍，把内容取出来比对
    const decoder = new TextDecoder()
    let p = centralOffset
    const restored: Array<{ name: string; text: string }> = []
    for (let i = 0; i < 2; i++) {
      expect(ev.getUint32(p, true)).toBe(0x02014b50)
      const flags = ev.getUint16(p + 8, true)
      expect(flags & 0x0800).toBe(0x0800) // 文件名标了 UTF-8，中文路径才不乱码
      const size = ev.getUint32(p + 20, true)
      const nameLen = ev.getUint16(p + 28, true)
      const localOffset = ev.getUint32(p + 42, true)
      const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen))

      const lv = new DataView(zip.buffer, localOffset)
      const localNameLen = lv.getUint16(26, true)
      const localDataStart = localOffset + 30 + localNameLen
      restored.push({ name, text: decoder.decode(zip.subarray(localDataStart, localDataStart + size)) })

      p += 46 + nameLen
    }

    expect(restored).toEqual([
      { name: 'a.txt', text: 'hello' },
      { name: 'dir/b.txt', text: '世界' },
    ])
  })

  it('同样的输入产出完全相同的字节（时间戳固定，便于比对）', () => {
    const make = () => createZip([{ name: 'x', data: encoder.encode('same') }])
    expect([...make()]).toEqual([...make()])
  })
})

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

describe('XLSX 生成', () => {
  it('列名在 Z 之后正确进位', () => {
    expect(columnName(0)).toBe('A')
    expect(columnName(25)).toBe('Z')
    expect(columnName(26)).toBe('AA')
    expect(columnName(27)).toBe('AB')
    expect(columnName(51)).toBe('AZ')
    expect(columnName(52)).toBe('BA')
  })

  it('Sheet 名清洗掉非法字符并截到 31 字符', () => {
    expect(sanitizeSheetName('菜单/清单')).toBe('菜单_清单')
    expect(sanitizeSheetName('a'.repeat(40))).toHaveLength(31)
    expect(sanitizeSheetName('')).toBe('Sheet')
  })

  it('产出带 inlineStr 的合法工作簿结构', async () => {
    const blob = buildXlsx([
      { name: '菜谱', rows: [['菜名', '耗时'], ['番茄炒蛋', 10]] },
      { name: '标签', rows: [['标签'], ['快手菜']] },
    ])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const zipText = new TextDecoder().decode(bytes)

    // 每个必需的 part 都在
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]) {
      expect(zipText).toContain(part)
    }

    // 数字写成 <v>，字符串写成 inlineStr —— 否则 Excel 里会变成文本格式没法算
    expect(zipText).toContain('<c r="B2"><v>10</v></c>')
    expect(zipText).toContain('t="inlineStr"')
    expect(zipText).toContain('番茄炒蛋')
  })

  it('转义 XML 特殊字符并剔除非法控制字符', async () => {
    // 一个裸的 0x07 会让 Excel 直接判定「文件已损坏」，必须剔除
    const blob = buildXlsx([{ name: 'S', rows: [['a<b>&"c\'', 'x\u0007y']] }])
    const text = await blob.text()
    expect(text).toContain('a&lt;b&gt;&amp;&quot;c&apos;')
    expect(text).not.toContain('x\u0007y')
    expect(text).toContain('xy')
  })

  it('首尾空格用 xml:space="preserve" 保住（「 适量」不能被吃掉）', async () => {
    const blob = buildXlsx([{ name: 'S', rows: [[' 适量']] }])
    expect(await blob.text()).toContain('xml:space="preserve"')
  })
})

// ---------------------------------------------------------------------------
// 图片：纯函数
// ---------------------------------------------------------------------------

describe('图片处理（纯函数）', () => {
  it('等比缩放：够小就原样返回，超了就按最长边缩', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 })
    // 竖图按高度缩，不能只看宽度
    expect(fitWithin(1200, 3200, 1600)).toEqual({ width: 600, height: 1600 })
  })

  it('缩放后不会出现 0 边长（极端长图也要能画出 1px）', () => {
    const r = fitWithin(10000, 1, 1600)
    expect(r.width).toBe(1600)
    expect(r.height).toBe(1)
  })

  it('按 4:3 裁剪时只裁不拉伸，且居中', () => {
    // 16:9 的横向图裁成 4:3 → 左右各裁掉一点
    const wide = cropToRatio(1600, 900, 4 / 3)
    expect(wide.sh).toBe(900)
    expect(wide.sw).toBe(1200)
    expect(wide.sx).toBe(200)
    expect(wide.sy).toBe(0)

    // 竖图裁成 4:3 → 上下各裁
    const tall = cropToRatio(900, 1600, 4 / 3)
    expect(tall.sw).toBe(900)
    expect(tall.sh).toBe(675)
    expect(tall.sy).toBe(Math.round((1600 - 675) / 2))
  })

  it('比例已经接近目标时不裁（避免反复上传攒出一像素的漂移）', () => {
    expect(cropToRatio(1600, 1200, 4 / 3)).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 1200 })
  })

  it('占位色对同一个菜名稳定，不同菜名基本不同', () => {
    expect(placeholderColor('番茄炒蛋')).toBe(placeholderColor('番茄炒蛋'))
    expect(placeholderColor('番茄炒蛋')).toMatch(/^hsl\(\d+ 42% 88%\)$/)
    const set = new Set(['番茄炒蛋', '红烧肉', '紫菜蛋花汤', '宫保鸡丁'].map(placeholderColor))
    expect(set.size).toBe(4)
  })

  it('字节数按人类可读单位格式化', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })

  it('同样内容算出同样的指纹（去重靠它）', async () => {
    const a = await sha256Hex(fakeImage([1, 2, 3]))
    const b = await sha256Hex(fakeImage([1, 2, 3]))
    const c = await sha256Hex(fakeImage([1, 2, 4]))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    // SHA-256 的十六进制形式，64 位
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// 图片：仓储层
// ---------------------------------------------------------------------------

describe('图片存储', () => {
  it('同样的 hash 只存一份，后一次直接复用', async () => {
    const first = await seedImage('hash-same')
    const second = await seedImage('hash-same')
    expect(second).toBe(first)
    expect((await imageStats()).count).toBe(1)
  })

  it('取回的字节与存入时一致', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 255, 0, 127]
    const id = await seedImage('hash-bytes', bytes)
    const blob = await getImageBlob(id)
    expect(blob).not.toBeNull()
    expect([...(new Uint8Array(await blob!.arrayBuffer()))]).toEqual(bytes)
  })

  it('换封面会把没人再用的旧图回收掉', async () => {
    const cat = await firstCategoryId()
    const recipeId = await createRecipe(draft('番茄炒蛋', cat))
    const oldImg = await seedImage('old')
    const newImg = await seedImage('new')

    await setRecipeCover(recipeId, oldImg)
    expect((await imageStats()).count).toBe(2)

    await setRecipeCover(recipeId, newImg)
    expect(await getImageBlob(oldImg)).toBeNull() // 回收了
    expect(await getImageBlob(newImg)).not.toBeNull()
  })

  it('旧图还有别的菜谱在用就不回收', async () => {
    const cat = await firstCategoryId()
    const a = await createRecipe(draft('菜A', cat))
    const b = await createRecipe(draft('菜B', cat))
    const shared = await seedImage('shared')

    await setRecipeCover(a, shared)
    await setRecipeCover(b, shared)
    await setRecipeCover(a, null) // A 换掉了，但 B 还在用

    expect(await getImageBlob(shared)).not.toBeNull()
  })

  it('gc 只清孤儿图，并报出释放了多少字节', async () => {
    const cat = await firstCategoryId()
    const recipeId = await createRecipe(draft('番茄炒蛋', cat))
    const used = await seedImage('used')
    await setRecipeCover(recipeId, used)
    await seedImage('orphan-1')
    await seedImage('orphan-2')

    const before = await imageStats()
    const result = await gcImages()
    expect(result.removed).toBe(2)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect((await imageStats()).count).toBe(before.count - 2)
    expect(await getImageBlob(used)).not.toBeNull()
  })

  it('没有孤儿时 gc 是空操作', async () => {
    expect(await gcImages()).toEqual({ removed: 0, freedBytes: 0 })
  })
})

// ---------------------------------------------------------------------------
// 备份：导出
// ---------------------------------------------------------------------------

describe('导出', () => {
  it('dumpAll 带上所有表的记录数统计', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    await createRecipe(draft('红烧肉', cat))

    const data = await dumpAll(false)
    expect(data.format).toBe('dishes-manage-backup')
    expect(data.counts.recipes).toBe(2)
    expect(data.counts.ingredients).toBe(4)
    expect(data.counts.steps).toBe(4)
    expect(data.counts.images).toBe(0)
    expect(data.data.recipes).toHaveLength(2)
  })

  it('includeImages=false 时一张图都不带', async () => {
    const cat = await firstCategoryId()
    const recipeId = await createRecipe(draft('番茄炒蛋', cat))
    await setRecipeCover(recipeId, await seedImage('cover'))

    const without = await dumpAll(false)
    expect(without.images).toHaveLength(0)

    const withImages = await dumpAll(true)
    expect(withImages.images).toHaveLength(1)
    expect(withImages.images[0].dataUrl).toMatch(/^data:image\/webp;base64,/)
    expect(withImages.images[0].thumbDataUrl).toMatch(/^data:image\/webp;base64,/)
  })

  it('base64 编码与 Node 的 Buffer 逐字节一致', async () => {
    // 用独立实现比对，否则编码器错了测试也发现不了
    const bytes = [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 255, 200, 64, 7]
    const cat = await firstCategoryId()
    const recipeId = await createRecipe(draft('番茄炒蛋', cat))
    await setRecipeCover(recipeId, await seedImage('b64', bytes))

    const data = await dumpAll(true)
    const b64 = data.images[0].dataUrl.split(',')[1]
    expect(b64).toBe(Buffer.from(new Uint8Array(bytes)).toString('base64'))
  })

  it('文件名带时间戳且可读', () => {
    const d = new Date(2026, 9, 15, 9, 5)
    expect(backupFilename(d)).toBe('家庭私厨-备份-20261015-0905.json')
    expect(excelFilename(d)).toBe('家庭私厨-菜谱-20261015-0905.xlsx')
  })

  it('Excel 导出把人话标签和关联名字填进去', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))

    const data = await dumpAll(false)
    const sheets = buildExcelSheets(data)
    const names = sheets.map((s) => s.name)
    expect(names).toContain('菜谱')
    expect(names).toContain('食材明细')
    expect(names).toContain('步骤')
    expect(names).toContain('分类')
    expect(names).toContain('制作历史')

    const recipeSheet = sheets.find((s) => s.name === '菜谱')!
    expect(recipeSheet.rows[1][1]).toBe('番茄炒蛋')
    expect(recipeSheet.rows[1][6]).toBe('简单') // difficulty 翻成中文

    const stepSheet = sheets.find((s) => s.name === '步骤')!
    // 步骤行用菜名而不是 id 关联，导出文件要能直接看懂
    expect(stepSheet.rows[1][0]).toBe('番茄炒蛋')
    expect(stepSheet.rows[2][3]).toBe('炒 3 分钟') // 计时器也带出来
  })

  it('空数据库也能导出，Sheet 结构不塌', async () => {
    await db.recipes.clear()
    const data = await dumpAll(false)
    const sheets = buildExcelSheets(data)
    expect(sheets).toHaveLength(9)
    for (const s of sheets) expect(s.rows.length).toBeGreaterThanOrEqual(1) // 至少还有表头
    expect(() => buildXlsx(sheets)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 备份：导入
// ---------------------------------------------------------------------------

describe('导入 · 覆盖模式', () => {
  it('清空后按备份还原', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    const backup = await dumpAll(false)

    await createRecipe(draft('本地新增的菜', cat))
    expect((await db.recipes.count())).toBe(2)

    const stats = await restoreAll(backup, 'overwrite')
    expect(stats.cleared).toBeGreaterThan(0)
    expect((await db.recipes.count())).toBe(1)
    expect((await db.recipes.toArray())[0].name).toBe('番茄炒蛋')
  })

  it('覆盖后不会留下孤儿食材/步骤', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    const backup = await dumpAll(false)
    await createRecipe(draft('红烧肉', cat))

    await restoreAll(backup, 'overwrite')
    const recipeIds = new Set((await db.recipes.toArray()).map((r) => r.id))
    for (const ing of await db.ingredients.toArray()) expect(recipeIds.has(ing.recipeId)).toBe(true)
    for (const st of await db.steps.toArray()) expect(recipeIds.has(st.recipeId)).toBe(true)
  })
})

describe('导入 · 合并模式', () => {
  it('按 id 去重：本地没有的新增，两边都有的按 updatedAt 留新的', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    const backup = await dumpAll(false)

    // 本地把这道菜改新一点（updatedAt 更大），备份里是旧的
    const localRecipe = (await db.recipes.toArray())[0]
    await db.recipes.update(localRecipe.id, { name: '番茄炒蛋（改过名）', updatedAt: Date.now() + 10_000 })

    const stats = await restoreAll(backup, 'merge')

    // 备份里的旧版本不该把本地新的盖回去
    expect(await db.recipes.get(localRecipe.id)).toMatchObject({ name: '番茄炒蛋（改过名）' })
    expect(stats.updated).toBe(0)
    expect(stats.skipped).toBeGreaterThan(0)
  })

  it('备份更新时采纳备份的版本', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    const backup = await dumpAll(false)

    // 把备份里的版本改得更新，再导入
    backup.data.recipes[0].name = '番茄炒蛋（备份版）'
    backup.data.recipes[0].updatedAt = Date.now() + 10_000

    const stats = await restoreAll(backup, 'merge')
    expect(await db.recipes.get(backup.data.recipes[0].id)).toMatchObject({ name: '番茄炒蛋（备份版）' })
    expect(stats.updated).toBe(1)
  })

  it('合并是补集而不是替换：两边独有的数据都留着', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    const backup = await dumpAll(false)

    await createRecipe(draft('红烧肉', cat))
    await restoreAll(backup, 'merge')

    const names = (await db.recipes.toArray()).map((r) => r.name).sort()
    // 默认 sort 按 UTF-16 码位：番(U+756A) < 红(U+7EA2)
    expect(names).toEqual(['番茄炒蛋', '红烧肉'])
  })

  it('设置以备份为准（没有 updatedAt 就没法比新旧）', async () => {
    await setSetting('theme', 'dark')
    const backup = await dumpAll(false)
    await setSetting('theme', 'light')

    await restoreAll(backup, 'merge')
    expect(await db.settings.get('theme')).toMatchObject({ value: 'dark' })
  })

  it('图片也一起还原，菜谱封面不再悬空', async () => {
    const cat = await firstCategoryId()
    const recipeId = await createRecipe(draft('番茄炒蛋', cat))
    const imgId = await seedImage('cover-merge')
    await setRecipeCover(recipeId, imgId)
    const backup = await dumpAll(true)

    // 模拟"换了一台设备"：清库后导入
    await db.recipes.clear()
    await db.blobs.clear()

    await restoreAll(backup, 'overwrite')
    const restored = await db.recipes.get(recipeId)
    expect(restored?.coverBlobId).toBe(imgId)
    expect(await getImageBlob(imgId)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 备份文件校验
// ---------------------------------------------------------------------------

describe('备份文件校验', () => {
  const valid = { format: 'dishes-manage-backup', version: 1, data: {} }

  it('拒绝非备份文件并给出人话原因', () => {
    expect(() => validateBackup(null)).toThrow(/不是有效的 JSON 对象/)
    expect(() => validateBackup('{}')).toThrow(/不是有效的 JSON 对象/)
    expect(() => validateBackup({})).toThrow(/不是「家庭私厨」导出的备份文件/)
    expect(() => validateBackup({ format: 'dishes-manage-backup' })).toThrow(/缺少 data 字段/)
  })

  it('拒绝来自更新版本的备份，而不是读一半崩掉', () => {
    expect(() => validateBackup({ ...valid, version: 99 })).toThrow(/比当前应用更新/)
  })

  it('接受合法备份并原样返回', () => {
    expect(validateBackup(valid)).toBe(valid)
  })
})

// ---------------------------------------------------------------------------
// 存储配额与提醒
// ---------------------------------------------------------------------------

describe('存储配额', () => {
  it('node 环境下没有 storage.estimate，要优雅降级而不是崩', async () => {
    const info = await getStorageInfo()
    expect(info.supported).toBe(false)
    expect(info.ratio).toBeNull()
  })

  it('申请持久化时没有 API 就返回 false，不抛错', async () => {
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})

describe('备份提醒', () => {
  it('没数据时不提醒（空库提醒备份很烦）', async () => {
    expect(await shouldRemindBackup()).toMatchObject({ remind: false, recipeCount: 0 })
  })

  it('有数据但从没备份过 → 提醒', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    expect(await shouldRemindBackup()).toMatchObject({ remind: true, days: null })
  })

  it('刚备份过就不提醒', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    await markBackedUp()
    expect((await shouldRemindBackup()).remind).toBe(false)
    expect(await getLastBackupAt()).not.toBeNull()
  })

  it('超过 30 天又提醒', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat))
    const old = Date.now() - (BACKUP_REMIND_DAYS + 2) * 24 * 60 * 60 * 1000
    await markBackedUp(old)

    const result = await shouldRemindBackup()
    expect(result.remind).toBe(true)
    expect(result.days).toBeGreaterThanOrEqual(BACKUP_REMIND_DAYS)
  })

  it('daysSince 在没有记录时返回 null', () => {
    expect(daysSince(null)).toBeNull()
    expect(daysSince(Date.now())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

describe('回收站', () => {
  it('软删除的菜谱不出现在列表里，但还在库里', async () => {
    const cat = await firstCategoryId()
    const id = await createRecipe(draft('番茄炒蛋', cat))
    await deleteRecipe(id)

    expect((await db.recipes.count())).toBe(1) // 还在
    expect(await listDeletedRecipes()).toHaveLength(1)
  })

  it('超过保留期的软删除菜谱会被真删掉，连图片一起清', async () => {
    const cat = await firstCategoryId()
    const fresh = await createRecipe(draft('刚删的', cat))
    const stale = await createRecipe(draft('删很久了', cat))
    const imgId = await seedImage('stale-cover')
    await setRecipeCover(stale, imgId)

    await deleteRecipe(fresh)
    await deleteRecipe(stale)

    // 把「删很久了」的删除时间改到 40 天前
    await db.recipes.update(stale, { deletedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 })

    const purged = await purgeExpiredTrash()
    expect(purged).toBe(1)
    expect(await db.recipes.get(stale)).toBeUndefined()
    expect(await db.recipes.get(fresh)).toBeDefined()
    expect(await getImageBlob(imgId)).toBeNull()
  })

  it('保留期内的软删除菜谱不受清理影响', async () => {
    const cat = await firstCategoryId()
    const id = await createRecipe(draft('昨天删的', cat))
    await deleteRecipe(id)
    expect(await purgeExpiredTrash()).toBe(0)
    expect(await db.recipes.get(id)).toBeDefined()
  })

  it('彻底删除时把封面和步骤图一起回收（否则清空回收站会留下看不见的图）', async () => {
    const cat = await firstCategoryId()
    const id = await createRecipe(draft('要彻底删的', cat))
    const cover = await seedImage('purge-cover')
    await setRecipeCover(id, cover)

    // 给第一步也挂一张图
    const steps = await db.steps.where('recipeId').equals(id).toArray()
    const stepImg = await seedImage('purge-step')
    await setStepImage(steps[0].id, stepImg)

    expect((await imageStats()).count).toBe(2)
    await purgeRecipe(id)
    expect((await imageStats()).count).toBe(0)
  })

  it('彻底删除只回收这道菜独占的图，别的菜还在用的留着', async () => {
    const cat = await firstCategoryId()
    const doomed = await createRecipe(draft('要删的', cat))
    const keeper = await createRecipe(draft('保留的', cat))
    const shared = await seedImage('purge-shared')
    await setRecipeCover(doomed, shared)
    await setRecipeCover(keeper, shared)

    await purgeRecipe(doomed)
    expect(await getImageBlob(shared)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// dataUrlToBlob
// ---------------------------------------------------------------------------

describe('dataURL 解码', () => {
  it('还原出正确的字节与 MIME', async () => {
    const bytes = [0, 1, 2, 253, 254, 255]
    const b64 = Buffer.from(new Uint8Array(bytes)).toString('base64')
    const blob = await dataUrlToBlob(`data:image/webp;base64,${b64}`)

    expect(blob.type).toBe('image/webp')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(bytes)
  })

  it('各种长度都能正确还原（覆盖 base64 的三种补位情况）', async () => {
    for (const len of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const bytes = Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256)
      const b64 = Buffer.from(new Uint8Array(bytes)).toString('base64')
      const blob = await dataUrlToBlob(`data:application/octet-stream;base64,${b64}`)
      expect([...(new Uint8Array(await blob.arrayBuffer()))]).toEqual(bytes)
    }
  })

  it('格式不对时报错而不是静默返回空图', async () => {
    await expect(dataUrlToBlob('not-a-data-url')).rejects.toThrow(/格式不对/)
  })
})

// ---------------------------------------------------------------------------
// 端到端：导出 → 抹库 → 导入，数据要一模一样
// ---------------------------------------------------------------------------

describe('备份往返（端到端）', () => {
  it('导出再导入后，菜谱/食材/步骤/图片逐字节一致', async () => {
    const cat = await firstCategoryId()
    const recipeId = await createRecipe(draft('番茄炒蛋', cat))
    const imgId = await seedImage('roundtrip')
    await setRecipeCover(recipeId, imgId)

    const before = await dumpAll(true)
    const beforeDetail = {
      recipe: await db.recipes.get(recipeId),
      ingredients: await db.ingredients.where('recipeId').equals(recipeId).toArray(),
      steps: await db.steps.where('recipeId').equals(recipeId).toArray(),
      imageBytes: [...new Uint8Array(await (await getImageBlob(imgId))!.arrayBuffer())],
    }

    // 模拟用户换手机：整个库清掉
    await db.delete()
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    await db.open()
    await initDatabase()
    await restoreAll(before, 'overwrite')

    expect(await db.recipes.get(recipeId)).toEqual(beforeDetail.recipe)
    expect(await db.ingredients.where('recipeId').equals(recipeId).toArray()).toEqual(beforeDetail.ingredients)
    expect(await db.steps.where('recipeId').equals(recipeId).toArray()).toEqual(beforeDetail.steps)
    expect([...new Uint8Array(await (await getImageBlob(imgId))!.arrayBuffer())]).toEqual(beforeDetail.imageBytes)
  })

  it('导入的数据能立刻被正常业务逻辑读到（分类树/标签统计没坏）', async () => {
    const cat = await firstCategoryId()
    await createRecipe(draft('番茄炒蛋', cat, []))
    const backup = await dumpAll(true)

    await db.recipes.clear()
    await db.ingredients.clear()
    await db.steps.clear()
    await restoreAll(backup, 'overwrite')

    expect((await db.recipes.count())).toBe(1)
    const recipe = (await db.recipes.toArray())[0]
    expect(recipe.categoryId).toBe(cat)
    expect(await db.ingredients.where('recipeId').equals(recipe.id).count()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 备份格式的自描述性
// ---------------------------------------------------------------------------

describe('备份文件格式', () => {
  it('是合法 JSON 且带 format / version / exportedAt', async () => {
    const data: BackupData = await dumpAll(false)
    const parsed = JSON.parse(JSON.stringify(data)) as BackupData
    expect(parsed.format).toBe('dishes-manage-backup')
    expect(typeof parsed.version).toBe('number')
    expect(typeof parsed.exportedAt).toBe('number')
    // 循环一遍确认没有不可序列化的东西漏进来（比如 Blob 直接塞进 JSON）
    expect(parsed.data.recipes).toBeInstanceOf(Array)
  })
})
