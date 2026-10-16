/**
 * 颜色透明度写法检查
 *
 * 背景：Tailwind 的颜色透明度修饰符（`bg-stone-900/90` 里的那个数字）只认
 * **5 的倍数**——默认的 opacity scale 是 0、5、10…100。写一个不是 5 的倍数的值
 * 不会报错、不会警告，Tailwind 只是**什么都不生成**：那个 class 拿到的是浏览器默认值，
 * 带 `bg-` 前缀就是没有背景色。
 *
 * 这个坑是真实踩到的：计时器条的行原本写了一个 92，编译出的 CSS 里根本没有这条规则，
 * 结果白字浮在页面内容上，几乎看不清。构建成功、类型检查通过、测试全绿——全都发现不了它。
 *
 * 所以这条检查放在这里，作为唯一能自动拦住它的手段。
 * 本文件自己也必须遵守这条规则（包括注释在内），所以下面举反例时用拼接而不是字面量。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Tailwind 默认的 opacity scale：5 的倍数 */
const SCALE_IS_MULTIPLE_OF = 5

/** 会带颜色透明度修饰符的实用类前缀 */
const PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'divide',
  'from',
  'via',
  'to',
  'fill',
  'stroke',
  'outline',
  'placeholder',
  'decoration',
  'shadow',
  'accent',
  'caret',
]

/** 反引号（模板字符串里不好直接写）、空白、引号都算边界 */
const BOUNDARY = `[\\s"'\`{]`

const PATTERN = new RegExp(
  `${BOUNDARY}(${PREFIXES.join('|')})-[a-z]+(?:-[0-9]+)?/(\\d+)(?![0-9\\]])`,
  'g',
)

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function sourceFiles(): string[] {
  return walk(join(process.cwd(), 'src'))
}

describe('Tailwind 透明度修饰符必须是 5 的倍数', () => {
  const files = sourceFiles()

  it('扫到的源文件不为空（否则这个测试在空跑）', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('自己能被这段正则扫到（不然就是正则写坏了）', () => {
    // 故意放一个不合规的样例，确认 PATTERN 抓得到它。
    // 用拼接而不是字面量，否则这个文件自己会被下面那条检查判为违规。
    const bad = '92'
    const sample = `className="bg-stone-900/${bad}"`
    const found = [...sample.matchAll(PATTERN)].map((m) => m[2])
    expect(found).toEqual([bad])
  })

  it('所有 `颜色/NN` 里的 NN 都能真的生成 CSS', () => {
    const offenders: string[] = []

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(PATTERN)) {
        const digits = match[2]
        if (Number(digits) % SCALE_IS_MULTIPLE_OF !== 0) {
          offenders.push(`${relative(process.cwd(), file).replace(/\\/g, '/')}: ${match[0].trim()}`)
        }
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : '下面这些透明度不是 5 的倍数，Tailwind 不会为它们生成任何 CSS（页面会少一层背景色）：\n' +
          offenders.map((o) => `  ${o}`).join('\n') +
          '\n改成最接近的 5 的倍数，或用任意值写法 bg-stone-900/[0.92]，' +
          '也可以把该值加进 tailwind.config 的 theme.extend.opacity。',
    ).toEqual([])
  })
})
