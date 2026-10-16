/**
 * 粘贴解析的编排层（FR-1.10 / FR-1.11 / FR-1.14）
 *
 * 把「规则引擎 → 打分 → 是否兜底 → 调 LLM → 归一化」串起来，
 * 但**不做决定**：两份结果都返回给 UI，由用户在预览页一键切换。
 */

import { needsFallback, parseRecipeText, type ParseResult, type ParseStrategy } from '@/domain/parse'
import { getDictIndex, normalizeParsedIngredients } from './repository'
import { LlmError, loadLlmConfig, parseWithLlm, isConfigured } from './llm'

export interface ParseOutcome {
  /** 规则引擎的结果，永远有 */
  rules: ParseResult
  /** LLM 的结果；没调或调用失败时为 null */
  llm: ParseResult | null
  /** 当前该展示哪一份（FR-1.14 的切换开关初值） */
  active: 'rules' | 'llm'
  /** LLM 失败原因，用于在 UI 上如实告知而不是静默吞掉 */
  llmError: string | null
}

export type ProgressPhase = 'rules' | 'llm'

export async function parseRecipeSource(
  text: string,
  strategy: ParseStrategy,
  options: {
    onProgress?: (phase: ProgressPhase) => void
    signal?: AbortSignal
  } = {},
): Promise<ParseOutcome> {
  options.onProgress?.('rules')
  const index = await getDictIndex()
  const rules = parseRecipeText(text, index)

  // FR-1.18：没配 Key 时规则引擎独立可用，静默跳过兜底而不是报错
  if (!needsFallback(rules, strategy)) {
    return { rules, llm: null, active: 'rules', llmError: null }
  }

  const config = await loadLlmConfig()
  if (!isConfigured(config)) {
    return {
      rules,
      llm: null,
      active: 'rules',
      llmError: strategy === 'llm' ? '还没有配置 API Key，本次只用本地规则解析' : null,
    }
  }

  options.onProgress?.('llm')
  try {
    const raw = await parseWithLlm(text, config, options.signal)
    // LLM 给的食材名不可信，统一用内置字典重算归一化
    const llm: ParseResult = { ...raw, ingredients: await normalizeParsedIngredients(raw.ingredients) }
    return { rules, llm, active: 'llm', llmError: null }
  } catch (err) {
    // FR-1.11：失败/超时降级回规则结果，但要让用户知道发生了什么
    const message =
      err instanceof LlmError
        ? err.reason === 'aborted'
          ? '已取消，展示本地规则解析结果'
          : `大模型解析失败（${err.message}），已降级为本地规则结果`
        : '大模型解析失败，已降级为本地规则解析结果'
    return { rules, llm: null, active: 'rules', llmError: message }
  }
}
