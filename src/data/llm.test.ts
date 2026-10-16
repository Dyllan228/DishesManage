/**
 * LLM 兜底与解析编排测试（FR-1.11 / FR-1.14 / FR-1.18）
 *
 * 这里重点测**失败路径**：模型超时、返回垃圾、返回半截 JSON、Key 没配。
 * 因为兜底逻辑存在的意义就是「模型不可靠时不能让用户的数据跟着坏掉」。
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { initDatabase } from './repository'
import { parseRecipeSource } from './importRecipe'
import {
  coerceLlmResult,
  extractJson,
  isConfigured,
  LlmError,
  loadLlmConfig,
  parseWithLlm,
  saveLlmConfig,
  type LlmConfig,
} from './llm'

async function resetDb() {
  db.close()
  await db.delete()
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await db.open()
}

const CONFIG: LlmConfig = {
  provider: 'deepseek',
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  timeoutMs: 5000,
}

/** 造一个 OpenAI 兼容格式的响应 */
function mockCompletion(content: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  })
}

beforeEach(async () => {
  await resetDb()
  await initDatabase()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('配置存取', () => {
  it('没存过时返回默认值', async () => {
    const c = await loadLlmConfig()
    expect(c.provider).toBe('deepseek')
    expect(c.apiKey).toBe('')
    expect(isConfigured(c)).toBe(false)
  })

  it('存过的字段覆盖默认值，没存的保持默认', async () => {
    await saveLlmConfig({ ...CONFIG, provider: 'claude', model: 'claude-sonnet-5-5' })
    const c = await loadLlmConfig()
    expect(c.provider).toBe('claude')
    expect(c.model).toBe('claude-sonnet-5-5')
    expect(c.timeoutMs).toBe(5000)
  })

  it('缺 Key / 缺 BaseURL / 缺模型名都算没配好（FR-1.18 的判定依据）', () => {
    expect(isConfigured(CONFIG)).toBe(true)
    expect(isConfigured({ ...CONFIG, apiKey: '  ' })).toBe(false)
    expect(isConfigured({ ...CONFIG, baseUrl: '' })).toBe(false)
    expect(isConfigured({ ...CONFIG, model: '' })).toBe(false)
  })
})

describe('模型返回内容的清洗', () => {
  it('剥掉 Markdown 代码块包裹', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('前后带解释文字时也能抠出 JSON', () => {
    expect(extractJson('好的，这是解析结果：{"a":1} 希望有帮助')).toEqual({ a: 1 })
  })

  it('纯 JSON 直接解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('完全不是 JSON 时抛 bad-response，而不是返回一个空壳', () => {
    expect(() => extractJson('抱歉我无法完成这个请求')).toThrow(LlmError)
    try {
      extractJson('抱歉我无法完成这个请求')
    } catch (e) {
      expect((e as LlmError).reason).toBe('bad-response')
    }
  })
})

describe('把模型输出归一成 ParseResult', () => {
  it('正常结构能映射过来', () => {
    const r = coerceLlmResult({
      name: '番茄炒蛋',
      servings: 2,
      ingredients: [
        { name: '番茄', kind: 'main', amount: 2, unit: '个' },
        { name: '盐', kind: 'seasoning', amountText: '适量' },
      ],
      steps: [{ text: '番茄切块', timerSec: null }],
      suggestedTags: [{ dimension: 'taste', name: '酸' }],
    })
    expect(r.name).toBe('番茄炒蛋')
    expect(r.ingredients).toHaveLength(2)
    expect(r.ingredients[0].amount).toBe(2)
    expect(r.ingredients[1].amountText).toBe('适量')
    expect(r.steps).toHaveLength(1)
    expect(r.suggestedTags[0]).toEqual({ dimension: 'taste', name: '酸' })
    expect(r.source).toBe('llm')
  })

  it('有确切数字时不再同时留 amountText（否则清单里会重复展示）', () => {
    const r = coerceLlmResult({
      name: 'x',
      ingredients: [{ name: '番茄', amount: 2, unit: '个', amountText: '适量' }],
      steps: [{ text: 'a' }],
    })
    expect(r.ingredients[0].amountText).toBeNull()
  })

  it('数字写成字符串也认', () => {
    const r = coerceLlmResult({ name: 'x', servings: '3', ingredients: [{ name: '番茄', amount: '2' }], steps: [{ text: 'a' }] })
    expect(r.servings).toBe(3)
    expect(r.ingredients[0].amount).toBe(2)
  })

  it('步骤写成纯字符串数组也能接住', () => {
    const r = coerceLlmResult({ name: 'x', ingredients: [{ name: 'a' }], steps: ['第一步', '第二步'] })
    expect(r.steps.map((s) => s.text)).toEqual(['第一步', '第二步'])
  })

  it('丢弃没有名字的食材行，而不是留一堆空行', () => {
    const r = coerceLlmResult({ name: 'x', ingredients: [{ name: '' }, { name: '番茄' }, { kind: 'main' }], steps: [{ text: 'a' }] })
    expect(r.ingredients.map((i) => i.name)).toEqual(['番茄'])
  })

  it('模型的 normalizedId 一律不采信，留给本地字典重算', () => {
    const r = coerceLlmResult({
      name: 'x',
      ingredients: [{ name: '番茄', normalizedId: 'dict_999', category: 'meat' }],
      steps: [{ text: 'a' }],
    })
    expect(r.ingredients[0].normalizedId).toBeNull()
    expect(r.ingredients[0].category).toBe('other')
  })

  it('缺关键字段时置信度被压到阈值下，预览页仍会标出来', () => {
    const r = coerceLlmResult({ name: 'x', ingredients: [], steps: [] })
    expect(r.missingCritical).toBe(true)
    expect(r.overall).toBeLessThan(0.7)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('返回数组或 null 这类完全不对的东西直接报错', () => {
    expect(() => coerceLlmResult(null)).toThrow(LlmError)
    expect(() => coerceLlmResult('字符串')).toThrow(LlmError)
  })
})

describe('调用模型', () => {
  it('没配 Key 时不发请求，直接抛 not-configured（FR-1.18）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(parseWithLlm('番茄炒蛋', { ...CONFIG, apiKey: '' })).rejects.toMatchObject({
      reason: 'not-configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 错误抛 http，带上状态码', async () => {
    vi.stubGlobal('fetch', mockCompletion('rate limited', 429))
    await expect(parseWithLlm('番茄炒蛋', CONFIG)).rejects.toMatchObject({ reason: 'http' })
  })

  it('网络异常被包装成 LlmError 而不是裸抛', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))
    await expect(parseWithLlm('番茄炒蛋', CONFIG)).rejects.toBeInstanceOf(LlmError)
  })

  it('超时抛出 timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
      }),
    )
    await expect(parseWithLlm('番茄炒蛋', { ...CONFIG, timeoutMs: 30 })).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('DeepSeek 走 OpenAI 兼容协议，Base URL 末尾的斜杠不会拼出双斜杠', async () => {
    const fetchMock = mockCompletion('{"name":"番茄炒蛋","ingredients":[{"name":"番茄"}],"steps":[{"text":"炒"}]}')
    vi.stubGlobal('fetch', fetchMock)

    await parseWithLlm('原文', { ...CONFIG, baseUrl: 'https://api.deepseek.com/' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('Claude 走 /v1/messages，并带上浏览器直连所需的头', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '{"name":"番茄炒蛋","ingredients":[{"name":"番茄"}],"steps":[{"text":"炒"}]}' }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    await parseWithLlm('原文', { ...CONFIG, provider: 'claude', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  })

  it('Claude 返回空 content 时报 bad-response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [] }), text: async () => '' }))
    await expect(parseWithLlm('原文', { ...CONFIG, provider: 'claude' })).rejects.toMatchObject({ reason: 'bad-response' })
  })
})

// ---------------------------------------------------------------------------

const GOOD_TEXT = `
【番茄炒蛋】

食材：
番茄 2个
鸡蛋 3个

做法：
1. 番茄切块。
2. 热锅倒油炒蛋。
`

const VAGUE_TEXT = '就随便炒炒，放点盐'

describe('解析编排（FR-1.10 / FR-1.11 / FR-1.14）', () => {
  it('规则结果够好时根本不调模型', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await saveLlmConfig(CONFIG)

    const out = await parseRecipeSource(GOOD_TEXT, 'fallback')

    expect(out.active).toBe('rules')
    expect(out.llm).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('规则拿不准时调模型，并默认切到模型结果', async () => {
    vi.stubGlobal(
      'fetch',
      mockCompletion('{"name":"随便炒炒","ingredients":[{"name":"盐","kind":"seasoning","amountText":"少许"}],"steps":[{"text":"下锅炒"}]}'),
    )
    await saveLlmConfig(CONFIG)

    const out = await parseRecipeSource(VAGUE_TEXT, 'fallback')

    expect(out.rules.missingCritical).toBe(true)
    expect(out.llm).not.toBeNull()
    expect(out.active).toBe('llm')
    expect(out.llm?.name).toBe('随便炒炒')
  })

  it('模型失败时降级回规则结果，并把原因如实带出来（FR-1.11）', async () => {
    vi.stubGlobal('fetch', mockCompletion('我没看懂', 200))
    await saveLlmConfig(CONFIG)

    const out = await parseRecipeSource(VAGUE_TEXT, 'fallback')

    expect(out.active).toBe('rules')
    expect(out.llm).toBeNull()
    expect(out.llmError).toContain('降级')
    // 规则结果照样能用，用户不会卡在这一步
    expect(out.rules).toBeTruthy()
  })

  it('模型返回的食材名经本地字典重新归一化，别名归到标准名', async () => {
    vi.stubGlobal(
      'fetch',
      mockCompletion('{"name":"番茄炒蛋","ingredients":[{"name":"西红柿"},{"name":"酱油"}],"steps":[{"text":"炒"}]}'),
    )
    await saveLlmConfig(CONFIG)

    const out = await parseRecipeSource(VAGUE_TEXT, 'fallback')

    const names = out.llm?.ingredients.map((i) => i.name) ?? []
    expect(names).toContain('番茄')
    expect(names).toContain('生抽')
    expect(out.llm?.ingredients.every((i) => i.normalizedId !== null)).toBe(true)
  })

  it('没配 Key 时静默跳过兜底，不报错也不阻塞（FR-1.18）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const out = await parseRecipeSource(VAGUE_TEXT, 'fallback')

    expect(out.active).toBe('rules')
    expect(out.llm).toBeNull()
    // 「规则+兜底」是自动策略，用户没配 Key 不算出错，不该弹提示
    expect(out.llmError).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('「强制用大模型」但没配 Key 时，要明确告诉用户原因', async () => {
    const out = await parseRecipeSource(VAGUE_TEXT, 'llm')
    expect(out.active).toBe('rules')
    expect(out.llmError).toContain('API Key')
  })

  it('「仅本地规则」策略下不联网', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await saveLlmConfig(CONFIG)

    const out = await parseRecipeSource(VAGUE_TEXT, 'rules')

    expect(out.active).toBe('rules')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('两份结果都保留下来，供预览页一键切换（FR-1.14）', async () => {
    vi.stubGlobal(
      'fetch',
      mockCompletion('{"name":"模型版","ingredients":[{"name":"盐"}],"steps":[{"text":"炒"}]}'),
    )
    await saveLlmConfig(CONFIG)

    const out = await parseRecipeSource(VAGUE_TEXT, 'fallback')

    expect(out.rules.source).toBe('rules')
    expect(out.llm?.source).toBe('llm')
    expect(out.rules.name).not.toBe(out.llm?.name)
  })

  it('进度回调先报 rules 再报 llm', async () => {
    vi.stubGlobal('fetch', mockCompletion('{"name":"x","ingredients":[{"name":"盐"}],"steps":[{"text":"炒"}]}'))
    await saveLlmConfig(CONFIG)

    const phases: string[] = []
    await parseRecipeSource(VAGUE_TEXT, 'fallback', { onProgress: (p) => phases.push(p) })

    expect(phases).toEqual(['rules', 'llm'])
  })
})
