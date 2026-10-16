/**
 * LLM 兜底解析（FR-1.11 / FR-6.1）
 *
 * ⚠️ 已知限制（文档 §11 R4）：纯前端调模型意味着 **API Key 存在浏览器里等于半公开**。
 * 本期接受该风险（自用工具 + 用户自配低额度 Key），因此：
 *   - Key 只存在本地 IndexedDB，绝不上传到除用户自己配置的服务商以外的任何地方
 *   - 调用前在 UI 上明确告知「本次会把粘贴的文本发送给 <服务商>」
 *   - 没有 Key 时规则引擎独立可用，功能不阻塞（FR-1.18）
 */

import type { ParseResult, ParsedIngredient, ParsedStep, SuggestedTag } from '@/domain/parse'
import type { IngredientKind, ShoppingCategory } from '@/types/models'
import { getSetting, setSetting } from './repository'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export type LlmProvider = 'deepseek' | 'claude' | 'custom'

export interface LlmConfig {
  provider: LlmProvider
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}

export const PROVIDER_DEFAULT: Record<LlmProvider, { baseUrl: string; model: string; label: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', label: 'DeepSeek' },
  claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', label: 'Claude' },
  custom: { baseUrl: '', model: '', label: '自定义（OpenAI 兼容）' },
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: PROVIDER_DEFAULT.deepseek.baseUrl,
  model: PROVIDER_DEFAULT.deepseek.model,
  timeoutMs: 30_000,
}

const SETTING_KEY = 'llmConfig'

export async function loadLlmConfig(): Promise<LlmConfig> {
  const saved = await getSetting<Partial<LlmConfig>>(SETTING_KEY, {})
  return { ...DEFAULT_LLM_CONFIG, ...saved }
}

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  await setSetting(SETTING_KEY, config)
}

/** 换服务商时把 baseUrl/model 带过去，用户只需要填 Key */
export function applyProviderDefaults(config: LlmConfig, provider: LlmProvider): LlmConfig {
  const d = PROVIDER_DEFAULT[provider]
  return { ...config, provider, baseUrl: d.baseUrl, model: d.model }
}

export function isConfigured(config: LlmConfig): boolean {
  return config.apiKey.trim().length > 0 && config.baseUrl.trim().length > 0 && config.model.trim().length > 0
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type LlmFailReason = 'not-configured' | 'timeout' | 'http' | 'bad-response' | 'aborted'

export class LlmError extends Error {
  constructor(
    public reason: LlmFailReason,
    message: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/** 用文字描述目标结构——比 JSON Schema 更能约束中文模型的输出风格 */
const SCHEMA_HINT = `{
  "name": "菜名，字符串",
  "intro": "一句话简介或 null",
  "servings": "份数，整数或 null",
  "durationMin": "预计总耗时分钟数，整数或 null",
  "tips": "小贴士或 null",
  "ingredients": [
    {
      "name": "食材名（用规范写法，如「生抽」而不是「酱油」）",
      "kind": "main 或 seasoning",
      "amount": "数字或 null（适量/少许填 null）",
      "unit": "单位如 g/个/勺；没有填 null",
      "amountText": "无法量化时的原文，如「适量」；能量化时填 null"
    }
  ],
  "steps": [
    { "text": "步骤正文", "timerSec": "该步骤蕴含的秒数，没有填 null", "timerLabel": "计时器名称如「腌制」，没有填 null" }
  ],
  "suggestedTags": [ { "dimension": "cuisine|taste|method|scene|diet", "name": "标签名" } ]
}`

const SYSTEM_PROMPT = `你是中文菜谱结构化助手。把用户粘贴的菜谱文本转成 JSON。

规则：
1. 只输出 JSON，不要 Markdown 代码块，不要任何解释文字。
2. 严格按给定结构输出，字段一个不多一个不少。
3. 原文里没有的信息填 null，**绝对不要编造**。
4. 「适量」「少许」这类不可量化的用量：amount 填 null，amountText 填原文。
5. 步骤要按顺序拆开，不要把整段合成一条。
6. 如果文本根本不像菜谱，name 填空字符串、ingredients 和 steps 填空数组。

结构：
${SCHEMA_HINT}`

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

async function callModel(
  text: string,
  config: LlmConfig,
  signal: AbortSignal,
): Promise<string> {
  const userContent = `请解析这段菜谱：\n\n${text}`

  if (config.provider === 'claude') {
    const res = await fetch(joinUrl(config.baseUrl, '/v1/messages'), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        // 纯前端直连 Anthropic API 需要显式声明，否则会被 CORS 拦掉
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    })
    if (!res.ok) throw new LlmError('http', `HTTP ${res.status} ${await safeText(res)}`)
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const textOut = (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    if (!textOut) throw new LlmError('bad-response', '模型没有返回文本内容')
    return textOut
  }

  // DeepSeek 与自定义走 OpenAI 兼容协议
  const res = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      // 能约束就约束；不支持的兼容服务端会忽略这个字段
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  })
  if (!res.ok) throw new LlmError('http', `HTTP ${res.status} ${await safeText(res)}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const textOut = data.choices?.[0]?.message?.content
  if (!textOut) throw new LlmError('bad-response', '模型没有返回文本内容')
  return textOut
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}

/** 模型经常把 JSON 包在 ```json 里，或者前后带一句话，这里都剥掉 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(body)
  } catch {
    // 退一步：取第一个 { 到最后一个 } 之间的内容
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1))
      } catch {
        /* 落到下面抛错 */
      }
    }
    throw new LlmError('bad-response', '模型返回的不是合法 JSON')
  }
}

// ---------------------------------------------------------------------------
// 归一成 ParseResult
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 把模型返回的 JSON 映射成 ParseResult。
 * 模型不可信：字段缺失、类型不对、多给少给都要能兜住，兜不住就丢字段而不是丢整条结果。
 */
export function coerceLlmResult(data: unknown): ParseResult {
  if (!data || typeof data !== 'object') throw new LlmError('bad-response', '模型返回的不是对象')
  const obj = data as Record<string, unknown>

  const rawIngredients = Array.isArray(obj.ingredients) ? obj.ingredients : []
  const ingredients: ParsedIngredient[] = []
  for (const raw of rawIngredients) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = asString(r.name)
    if (!name) continue
    const kind: IngredientKind = r.kind === 'seasoning' ? 'seasoning' : 'main'
    const amountText = asString(r.amountText)
    const amount = asNumber(r.amount)
    ingredients.push({
      name,
      kind,
      amountRaw: amountText ?? (amount !== null ? `${amount}${asString(r.unit) ?? ''}` : null),
      amount,
      unit: asString(r.unit),
      // 有确切数字就不能同时留 amountText，否则清单里会重复展示
      amountText: amount !== null ? null : amountText,
      // 归一化由调用方用内置字典重做一遍，模型的 normalizedId 不可信
      normalizedId: null,
      canonicalName: null,
      category: 'other' as ShoppingCategory,
      confidence: 0.75,
    })
  }

  const rawSteps = Array.isArray(obj.steps) ? obj.steps : []
  const steps: ParsedStep[] = []
  for (const raw of rawSteps) {
    if (typeof raw === 'string') {
      const t = raw.trim()
      if (t) steps.push({ text: t, timerSec: null, timerLabel: null, confidence: 0.75 })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const text = asString(r.text)
    if (!text) continue
    steps.push({
      text,
      timerSec: asNumber(r.timerSec),
      timerLabel: asString(r.timerLabel),
      confidence: 0.75,
    })
  }

  const rawTags = Array.isArray(obj.suggestedTags) ? obj.suggestedTags : []
  const suggestedTags: SuggestedTag[] = []
  for (const raw of rawTags) {
    if (typeof raw === 'string') {
      const n = raw.trim()
      if (n) suggestedTags.push({ dimension: 'custom', name: n })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = asString(r.name)
    if (!name) continue
    suggestedTags.push({ dimension: asString(r.dimension) ?? 'custom', name })
  }

  const name = asString(obj.name) ?? ''
  const missingCritical = ingredients.length === 0 || steps.length === 0

  // LLM 结果的置信度是"信任"而非"测量"：字段齐就给高分，缺关键字段照样压到阈值下，
  // 这样预览页仍然会把缺失的地方标出来让用户补。
  const overall = missingCritical ? 0.5 : 0.9

  const warnings: string[] = []
  if (!name) warnings.push('模型没有识别出菜名，请手动填写')
  if (ingredients.length === 0) warnings.push('模型没有识别出食材，请手动补充')
  if (steps.length === 0) warnings.push('模型没有识别出步骤，请手动补充')

  return {
    name,
    nameConfidence: name ? 0.9 : 0,
    intro: asString(obj.intro),
    ingredients,
    steps,
    tips: asString(obj.tips),
    servings: asNumber(obj.servings),
    durationMin: asNumber(obj.durationMin),
    suggestedCategoryName: null,
    suggestedTags,
    overall,
    missingCritical,
    warnings,
    source: 'llm',
  }
}

/**
 * 调 LLM 解析。任何失败（无 Key / 超时 / HTTP 错 / 返回不合法）都抛 LlmError，
 * 由调用方降级回规则引擎的结果（FR-1.11）。
 */
export async function parseWithLlm(
  text: string,
  config: LlmConfig,
  externalSignal?: AbortSignal,
): Promise<ParseResult> {
  if (!isConfigured(config)) {
    throw new LlmError('not-configured', '还没有配置 API Key')
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const raw = await callModel(text, config, controller.signal)
    return coerceLlmResult(extractJson(raw))
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (controller.signal.aborted) {
      throw new LlmError(
        externalSignal?.aborted ? 'aborted' : 'timeout',
        externalSignal?.aborted ? '已取消' : `超过 ${Math.round(config.timeoutMs / 1000)} 秒没有响应`,
      )
    }
    throw new LlmError('http', err instanceof Error ? err.message : '网络请求失败')
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onAbort)
  }
}
