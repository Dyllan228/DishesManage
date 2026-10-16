/**
 * 本地规则引擎（FR-1.9 ~ FR-1.10）
 *
 * 设计原则（文档 §4.1.2）：
 *   **解析是「辅助填表」，不是「自动入库」。**
 * 所以本模块的职责不是「猜对」，而是「尽量抽出 + 诚实地报告自己有多不确定」。
 * 抽不出来的地方一律留空并降置信度，交给预览页让用户补，
 * **绝不静默填一个看起来合理的错值**。
 *
 * 纯函数，不碰数据库、不碰网络。
 */

import { parseAmount } from './units'
import { normalizeIngredient, cleanName, type DictIndex } from './normalize'
import type { ID, IngredientKind, ShoppingCategory } from '@/types/models'
import rules from '@/data/parseRules.json'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ParsedIngredient {
  name: string
  kind: IngredientKind
  /** 原文用量，如 "500g" / "适量"；没有用量时为 null */
  amountRaw: string | null
  amount: number | null
  unit: string | null
  amountText: string | null
  /** 命中内置字典时的标准食材 id */
  normalizedId: ID | null
  /** 命中的标准名，用于预览页提示「将按『生抽』合并」 */
  canonicalName: string | null
  category: ShoppingCategory
  /** 0-1，未命中字典 / 没有用量都会拉低 */
  confidence: number
}

export interface ParsedStep {
  text: string
  timerSec: number | null
  timerLabel: string | null
  confidence: number
}

export interface SuggestedTag {
  dimension: string
  name: string
}

export interface ParseResult {
  name: string
  nameConfidence: number
  intro: string | null
  ingredients: ParsedIngredient[]
  steps: ParsedStep[]
  tips: string | null
  servings: number | null
  durationMin: number | null
  /** 猜测的一级分类名（FR-1.16），交由预览页按名字解析成 id */
  suggestedCategoryName: string | null
  suggestedTags: SuggestedTag[]
  /** 整体置信度 0-1（加权），低于阈值才走 LLM 兜底 */
  overall: number
  /** 关键字段缺失：无食材 或 无步骤（FR-1.10） */
  missingCritical: boolean
  warnings: string[]
  source: 'rules' | 'llm'
}

export const PARSE_THRESHOLD = rules.thresholds.overall
export const HIGHLIGHT_THRESHOLD = rules.thresholds.highlight

// ---------------------------------------------------------------------------
// 1. 预处理：去掉表情、免责声明、装饰性分隔线
// ---------------------------------------------------------------------------

const DISCLAIMER = rules.disclaimerPatterns
/** 装饰性分隔线：===、---、***、··· 之类 */
const DECORATION_LINE = /^[\s=＊*_—\-·•~～#]{3,}$/
/** 行首/行尾的装饰符（不含 `-`，避免把「1-2个」这种连字符用量削掉） */
const EDGE_DECOR_HEAD = /^[\s=＊*_·•~～#]+/
const EDGE_DECOR_TAIL = /[\s=＊*_·•~～#]+$/
const EDGE_DASH = /^[\s=-]{2,}|[\s=-]{2,}$/

export function preprocess(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    // 表情与符号：保留中文、字母、数字与常用标点
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]/gu, '')
    .split('\n')
    .map((l) => l.replace(/[​-‍﻿]/g, '').trim())

  const out: string[] = []
  for (const rawLine of lines) {
    // 「=== 菜谱 ===」这类用装饰符包起来的标题，剥掉装饰符后保留内容
    const line = rawLine
      .replace(EDGE_DASH, '')
      .replace(EDGE_DECOR_HEAD, '')
      .replace(EDGE_DECOR_TAIL, '')
      .replace(EDGE_DASH, '')
      .trim()

    if (!line || DECORATION_LINE.test(line)) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    // 免责声明/引流尾注：整行丢弃
    if (DISCLAIMER.some((p) => line.includes(p))) continue
    out.push(line)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

// ---------------------------------------------------------------------------
// 2. 切段：按小标题把文本分成区块
// ---------------------------------------------------------------------------

type SectionKind = 'ingredients' | 'seasoning' | 'steps' | 'tips'

interface Sections {
  /** 小标题之前的内容（通常是菜名与简介） */
  head: string[]
  ingredients: string[]
  seasoning: string[]
  steps: string[]
  tips: string[]
  /** 没有归入任何小标题、但也不在 head 里的行 */
  loose: string[]
}

/** 关键词 → 区块。长的关键词优先匹配，避免「调味料」被「调味」抢先 */
const HEADING_INDEX: Array<{ word: string; kind: SectionKind }> = (
  Object.entries(rules.sectionKeywords) as Array<[SectionKind, string[]]>
)
  .flatMap(([kind, words]) => words.map((word) => ({ word, kind })))
  .sort((a, b) => b.word.length - a.word.length)

/** 行首装饰（【】、#、*、markdown 标题符） */
const LEADING_DECOR = /^[\s【\[#*·•▎■□►▷\-—]+/
/** 行尾装饰（小标题常被【】或【】+冒号包起来） */
const TRAILING_DECOR = /[\s】\]、。，,：:]+$/

export interface HeadingHit {
  kind: SectionKind
  /** 小标题同一行后面的内容，如「食材：番茄 2个」→「番茄 2个」 */
  rest: string
}

/**
 * 判断一行是不是小标题。要求整行除去装饰和标点后**恰好**是关键词，
 * 否则「食材要新鲜」这种正文会被误判成小标题。
 */
export function matchHeading(line: string): HeadingHit | null {
  const exact = line.replace(LEADING_DECOR, '').replace(TRAILING_DECOR, '').trim()
  if (exact && exact.length <= 8) {
    const hit = HEADING_INDEX.find((h) => h.word === exact)
    if (hit) return { kind: hit.kind, rest: '' }
  }

  // 「食材：番茄 2个」——关键词后面还有内容，此时行长不受限制
  const m = line.match(/^[\s【\[#*·•▎■□►▷\-—]*([^:：]{1,8})[:：]\s*(.*)$/)
  if (m) {
    const word = m[1].replace(/[\s【】\[\]]+/g, '')
    const hit = HEADING_INDEX.find((h) => h.word === word)
    if (hit) return { kind: hit.kind, rest: m[2].trim() }
  }
  return null
}

export function segment(lines: string[]): Sections {
  const sections: Sections = { head: [], ingredients: [], seasoning: [], steps: [], tips: [], loose: [] }
  let current: SectionKind | null = null

  for (const line of lines) {
    const hit = matchHeading(line)
    if (hit) {
      current = hit.kind
      if (hit.rest) sections[hit.kind].push(hit.rest)
      continue
    }
    if (current) sections[current].push(line)
    else sections.head.push(line)
  }

  // head 一般只有菜名/简介；步子之前的散行留给 step 抽取兜底
  sections.loose = sections.head.slice(1)
  return sections
}

// ---------------------------------------------------------------------------
// 3. 抽取菜名
// ---------------------------------------------------------------------------

const NAME_LABEL = /^(?:菜名|名称|标题|名字)\s*[:：]\s*(.+)$/
const BRACKETED = /[【《]([^】》]{1,24})[】》]/

export function extractName(head: string[]): { name: string; confidence: number } {
  const candidates = head.filter(Boolean)

  // 1) 显式标注「菜名：XXX」
  for (const line of candidates.slice(0, 6)) {
    const m = line.match(NAME_LABEL)
    if (m) return { name: tidyName(m[1]), confidence: 1 }
  }

  // 2) 【红烧肉】/《红烧肉》这类书名号包裹
  for (const line of candidates.slice(0, 6)) {
    const m = line.match(BRACKETED)
    if (m) return { name: tidyName(m[1]), confidence: 0.95 }
  }

  // 3) 首个短行，且看着像菜名（不含句号问号、不是小标题）
  for (const line of candidates.slice(0, 4)) {
    const t = line.trim()
    if (!t || matchHeading(t)) continue
    if (/[。！？!?；;]$/.test(t)) continue // 是句子，不是标题
    if (t.length > 20) continue
    const strong = /(的做法|怎么做|教程|配方)$/.test(t) || t.length <= 12
    return { name: tidyName(t), confidence: strong ? 0.8 : 0.6 }
  }

  return { name: '', confidence: 0 }
}

function tidyName(raw: string): string {
  let t = raw
    // 「川味土豆烧排骨 | 一锅到底的下饭神器」——竖线右边是副标题，不是菜名的一部分
    .split(/[|｜丨]/)[0]
    .replace(/(的做法|怎么做|做法|教程|配方|菜谱)$/g, '')
    .replace(/^[\s:：\-—]+|[\s:：\-—]+$/g, '')
    .trim()

  // 「红烧肉 肥而不腻的经典」这类以空格分隔的标题，取前半段
  if (t.length > 14) {
    const head = t.split(/\s+/)[0]
    if (head.length >= 2 && head.length <= 14) t = head
  }
  return cleanName(t)
}

// ---------------------------------------------------------------------------
// 4. 抽取食材
// ---------------------------------------------------------------------------

/** 行尾的「用量」候选：数字+单位 / 中文数字+单位 / 适量少许等 */
const AMOUNT_TOKEN =
  /(\d+(?:\.\d+)?\s*[a-zA-Z一-龥]{0,3}|[半一两二三四五六七八九十]{1,3}\s*[a-zA-Z一-龥]{0,3}|适量|少许|少量|些许|一点|酌量|随意|若干|适当)/g

/** 整行只有用量、没有名字时的裸用量词 */
const IMPRECISE_ONLY = /^(适量|少许|少量|些许|一点|酌量|随意|若干|适当)$/

function isAmountLike(token: string): boolean {
  const p = parseAmount(token)
  // unit 命中说明「数字+已知单位」；amountText 为 null 说明是干净的数值
  return p.unit !== null || (p.amount !== null && p.amountText === null)
}

/** 把一行拆成「名字 + 用量」 */
export function splitNameAndAmount(line: string): { head: string; amountRaw: string | null } {
  const s = line
    .replace(/^[\s·•*\-–—▢□☐☑]+/, '')
    .replace(/^(?:\d+|[一二三四五六七八九十]+)\s*[.、)）]\s*/, '')
    .trim()
  if (!s) return { head: '', amountRaw: null }

  // 去掉行内的子标题前缀：「主料：」「调料：」
  const stripped = s.replace(
    /^(?:主料|辅料|配料|调料|调味料|佐料|食材|用料|材料|原料|腌料|酱汁)\s*[:：]\s*/,
    '',
  )

  // 从后往前找末尾的用量token
  AMOUNT_TOKEN.lastIndex = 0
  const matches = [...stripped.matchAll(AMOUNT_TOKEN)].filter((m) => m.index !== undefined)
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const start = m.index as number
    const end = start + m[0].length
    // 要求用量token一直延伸到行尾（只允许尾部还有标点或空白）
    if (stripped.slice(end).replace(/[\s,，。;；、:：]+$/, '') !== '') continue
    // 「盐、生抽、料酒 各适量」：`各` 是共用标记，保留下来告诉调用方用量是平摊的
    let head = stripped.slice(0, start).replace(/[\s,，。;；、:：=]+$/, '').trim()
    let shareAll = false
    if (/各$/.test(head)) {
      head = head.replace(/[\s各]+$/, '').trim()
      shareAll = true
    }
    if (!head) continue
    if (!isAmountLike(m[0].trim())) continue
    return { head, amountRaw: shareAll ? `各${m[0].trim()}` : m[0].trim() }
  }

  // 量词倒装：「2个番茄」。逐字加长前缀，取第一个「像用量、且剩下的确实是个名字」的切法
  const lead = stripped.match(/^(\d+(?:\.\d+)?|[半一两二三四五六七八九十]+)(.*)$/)
  if (lead) {
    const tail = lead[2]
    for (let k = 0; k <= Math.min(3, tail.length - 1); k++) {
      const token = lead[1] + tail.slice(0, k)
      const rest = tail.slice(k).trim()
      if (!rest || /^\d/.test(rest)) continue
      const parsedToken = parseAmount(token)
      // 倒装的用量必须带上明确的单位。否则「5分钟快手菜」会被切出一个假的「5」来
      if (parsedToken.unit === null) continue
      // 剩下的部分不该以量词开头（否则说明单位没切干净，例如切成了「个番茄」）
      if (findLeadingUnit(rest)) continue
      return { head: rest, amountRaw: token }
    }
  }

  // 整行就是用量，没有食材名
  if (IMPRECISE_ONLY.test(stripped) || isAmountLike(stripped)) return { head: '', amountRaw: null }

  return { head: stripped, amountRaw: null }
}

const UNIT_CHARS = ['个', '只', '条', '块', '根', '片', '瓣', '颗', '粒', '把', '束', '张', '枚', '朵', '份', '碗', '杯', '勺', '斤', '两', '克', 'g', 'G', 'L', 'l']

/** 行首是不是落单的量词（用于判断单位有没有切干净） */
function findLeadingUnit(text: string): string | null {
  for (const u of UNIT_CHARS) {
    if (text.startsWith(u)) return u
  }
  return null
}

/** 行内的子标题前缀：「主料：」「调料：」 */
const INLINE_SUBHEAD = /^(?:主料|辅料|配料|调料|调味料|佐料|食材|用料|材料|原料|腌料|酱汁)\s*[:：]\s*/

/** 单个食材 → ParsedIngredient */
function buildIngredient(
  rawName: string,
  amountRaw: string | null,
  kind: IngredientKind,
  index: DictIndex,
  sharedAcrossItems: boolean,
): ParsedIngredient {
  const name = cleanName(rawName)
  const norm = normalizeIngredient(name, index)
  const parsed = amountRaw ? parseAmount(amountRaw) : { amount: null, unit: null, amountText: null }

  // 置信度：命中字典 +0.5，有用量 +0.3，名字像样 +0.2
  let confidence = 0
  if (norm.matched) confidence += 0.5
  if (amountRaw) confidence += 0.3
  if (name.length >= 1 && name.length <= 8) confidence += 0.2
  // 「各适量」这种平摊写法，归属本身就不确定
  if (sharedAcrossItems) confidence -= 0.1

  return {
    name: norm.matched ? norm.displayName : name,
    kind,
    amountRaw,
    amount: parsed.amount,
    unit: parsed.unit,
    amountText: parsed.amountText,
    normalizedId: norm.dict?.id ?? null,
    canonicalName: norm.dict?.name ?? null,
    category: norm.dict?.category ?? 'other',
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
  }
}

export function parseIngredientLine(
  line: string,
  kind: IngredientKind,
  index: DictIndex,
): ParsedIngredient[] {
  const s = line.replace(INLINE_SUBHEAD, '').trim()
  if (!s) return []

  // 「盐、生抽、料酒 各适量」：整行共用同一个用量，`各` 就是信号
  const shared = s.match(/^(.+?)\s*各\s*([^\s各]{1,6})$/)
  if (shared && isAmountLike(shared[2])) {
    const amountRaw = shared[2].trim()
    const names = shared[1].split(/[、,，/／]/).map((p) => p.trim()).filter(Boolean)
    if (names.length > 1) {
      return names.map((n) => buildIngredient(n, amountRaw, kind, index, true))
    }
  }

  // 一行里塞了多样食材，各自带各自的用量：「番茄 2个、鸡蛋 3个、盐 适量」
  // 注意：递归调用时每一项已不含分隔符，不会无限递归
  const pieces = s.split(/[、,，/／]/).map((p) => p.trim()).filter(Boolean)
  if (pieces.length > 1) {
    const out: ParsedIngredient[] = []
    for (const piece of pieces) out.push(...parseIngredientLine(piece, kind, index))
    return out
  }

  const { head, amountRaw } = splitNameAndAmount(s)
  if (!head) return []
  const isShared = amountRaw?.startsWith('各') ?? false
  return [buildIngredient(head, isShared ? amountRaw!.slice(1) : amountRaw, kind, index, isShared)]
}

function parseIngredientBlock(lines: string[], kind: IngredientKind, index: DictIndex): ParsedIngredient[] {
  const out: ParsedIngredient[] = []
  for (const line of lines) {
    out.push(...parseIngredientLine(line, kind, index))
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. 抽取步骤
// ---------------------------------------------------------------------------

const STEP_NUMBER = /^(?:第\s*[一二三四五六七八九十\d]+\s*步|步骤\s*\d+|\d+\s*[.、)）])\s*[:：]?\s*/
const TIMER = /(\d+(?:\.\d+)?|半)\s*(个?小时|钟头|分钟|分|秒钟|秒)/
const SERVINGS = /(\d+)\s*(?:人份|人的量|人食|人用|个人吃|人吃)/

function stripStepMarker(line: string): { index: number | null; text: string } {
  const m = line.match(/^[\s·•*\-–—]*((?:\d+|[一二三四五六七八九十]+)\s*[.、)）]|第\s*[一二三四五六七八九十\d]+\s*步|步骤\s*\d+)\s*[:：]?\s*/)
  if (m) {
    const numText = m[1].replace(/[^\d一二三四五六七八九十]/g, '')
    const idx = /^\d+$/.test(numText) ? Number(numText) : null
    return { index: idx, text: line.slice(m[0].length).trim() }
  }
  return { index: null, text: line.replace(LEADING_DECOR, '').trim() }
}

/** 从一句话里抽出倒计时（FR-3.23：步骤里的「煮 5 分钟」可一键启动计时） */
export function extractTimer(text: string): { timerSec: number | null; timerLabel: string | null } {
  const m = text.match(TIMER)
  if (!m) return { timerSec: null, timerLabel: null }

  const raw = m[1]
  const n = raw === '半' ? 0.5 : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return { timerSec: null, timerLabel: null }

  const unit = m[2]
  let sec: number
  if (unit === '小时' || unit === '个小时' || unit === '钟头') sec = n * 3600
  else if (unit === '分钟' || unit === '分') sec = n * 60
  else sec = n

  // 超过 6 小时的「时间」多半不是烹饪时长（如「腌一晚上」被误读），丢掉更安全
  if (sec < 10 || sec > 6 * 3600) return { timerSec: null, timerLabel: null }

  // 动作词：取时长前面最靠右的那个动词当标签。
  // 动词后面如果紧跟「水火汤锅油」这类字，说明它俩是一个词（「焯」+「水」），一起带上；
  // 否则只取动词本身，避免把「静置一会儿后」整句当成标签。
  const before = text.slice(0, m.index ?? 0).replace(/[\s，,。、：:]+$/, '')
  const COMPOUND_TAIL = '水火汤锅油肉菜汁饭面'
  let label: string | null = null
  let bestAt = -1
  for (const v of rules.timerVerbs) {
    const at = before.lastIndexOf(v)
    if (at < 0) continue
    // 更靠右优先；同一位置取更长的动词（「腌制」优于「腌」）
    if (at > bestAt || (at === bestAt && label !== null && v.length > label.length)) {
      bestAt = at
      const next = before[at + v.length]
      label = next && COMPOUND_TAIL.includes(next) ? v + next : v
    }
  }
  return { timerSec: Math.round(sec), timerLabel: label }
}

/** 一句话是否像「做法」——用于没有步骤小标题时兜底 */
function looksLikeStep(line: string): boolean {
  if (line.length < 4) return false
  const verbHits = rules.cookingVerbs.filter((v) => line.includes(v)).length
  return verbHits > 0
}

export function extractSteps(sections: Sections): { steps: ParsedStep[]; confidence: number; warnings: string[] } {
  const warnings: string[] = []
  let source: 'explicit' | 'loose' | 'none' = 'none'
  let raw: string[] = []

  if (sections.steps.length > 0) {
    source = 'explicit'
    raw = sections.steps
  } else {
    // 没有「做法」小标题：从正文里挑出像做法的句子
    const pool = [...sections.loose, ...sections.tips].flatMap((l) => l.split(/[。；;]/)).filter(Boolean)
    const guess = pool.filter(looksLikeStep)
    if (guess.length > 0) {
      source = 'loose'
      raw = guess
      warnings.push('没有找到「做法/步骤」小标题，步骤是从正文里推测的，请重点核对')
    }
  }

  if (source === 'none') {
    warnings.push('未能识别出步骤，请手动补充')
    return { steps: [], confidence: 0, warnings }
  }

  const steps: ParsedStep[] = []
  for (const line of raw) {
    const { text } = stripStepMarker(line)
    if (!text) continue
    // 一句里塞了多个编号的，已经被切段处理过；这里按句子再切一次
    const sentences = text.split(/(?<=[。！!])/).map((s) => s.trim()).filter(Boolean)
    for (const s of sentences.length > 1 ? sentences : [text]) {
      const { timerSec, timerLabel } = extractTimer(s)
      steps.push({
        text: s,
        timerSec,
        timerLabel,
        // 有编号 / 有计时信息的步骤更可信
        confidence: source === 'explicit' ? (STEP_NUMBER.test(line) ? 0.95 : 0.8) : 0.5,
      })
    }
  }

  if (steps.length === 0) {
    warnings.push('未能识别出步骤，请手动补充')
    return { steps: [], confidence: 0, warnings }
  }

  const confidence = source === 'explicit' ? 0.95 : 0.5
  return { steps, confidence, warnings }
}

// ---------------------------------------------------------------------------
// 6. 猜分类与标签（FR-1.16）
// ---------------------------------------------------------------------------

function haystack(name: string, ingredients: ParsedIngredient[]): string {
  return [name, ...ingredients.map((i) => `${i.name} ${i.canonicalName ?? ''}`)].join(' ')
}

export function suggestCategory(
  name: string,
  ingredients: ParsedIngredient[],
  intro: string | null,
): string | null {
  const hay = haystack(name, ingredients) + ' ' + (intro ?? '')
  for (const hint of rules.categoryHints) {
    if (hint.keywords.some((k) => hay.includes(k))) return hint.category
  }
  // 兜底：有肉 → 荤菜，否则有蔬菜 → 素菜
  const cats = new Set(ingredients.map((i) => i.category))
  if (cats.has('meat')) return '荤菜'
  if (cats.has('veg')) return '素菜'
  return null
}

export function suggestTags(name: string, ingredients: ParsedIngredient[], durationMin: number | null): SuggestedTag[] {
  const hay = haystack(name, ingredients)
  const out: SuggestedTag[] = []
  const seen = new Set<string>()

  for (const hint of rules.tagHints) {
    const key = `${hint.dimension}:${hint.tag}`
    if (seen.has(key)) continue
    if (hint.keywords.some((k) => hay.includes(k))) {
      seen.add(key)
      out.push({ dimension: hint.dimension, name: hint.tag })
    }
  }

  // 「快手菜」：总耗时够短才有资格
  if (durationMin !== null && durationMin <= rules.quickSceneMinutes) {
    out.push({ dimension: 'scene', name: '快手菜' })
  }
  return out
}

// ---------------------------------------------------------------------------
// 7. 主入口
// ---------------------------------------------------------------------------

export function parseRecipeText(text: string, index: DictIndex): ParseResult {
  const clean = text.trim()
  if (!clean) {
    return {
      name: '', nameConfidence: 0, intro: null, ingredients: [], steps: [], tips: null,
      servings: null, durationMin: null, suggestedCategoryName: null, suggestedTags: [],
      overall: 0, missingCritical: true, warnings: ['内容是空的'], source: 'rules',
    }
  }

  const lines = preprocess(clean)
  const sections = segment(lines)
  const { name, confidence: nameConfidence } = extractName(sections.head)

  const ingredients = parseIngredientBlock(sections.ingredients, 'main', index)
  const seasonings = parseIngredientBlock(sections.seasoning, 'seasoning', index)
  const all = [...ingredients, ...seasonings]

  const { steps, confidence: stepsConfidence, warnings } = extractSteps(sections)

  const tips = sections.tips.length ? sections.tips.join('\n').trim() : null
  const intro = sections.head.slice(1).find((l) => l.length > 10 && !matchHeading(l)) ?? null

  // 时长：只用能算出来的部分，算不出来就留空让用户填，不编
  const timerSecs = steps.reduce((s, st) => s + (st.timerSec ?? 0), 0)
  const untimedSteps = steps.filter((s) => s.timerSec === null).length
  const durationMin =
    steps.length === 0 ? null : timerSecs > 0 ? Math.ceil(timerSecs / 60) + untimedSteps * 2 : null

  const servingsMatch = clean.match(SERVINGS)
  const servings = servingsMatch ? Number(servingsMatch[1]) : null

  // ---- 置信度 ----
  const ingConfidence = scoreIngredients(all)
  const overall = Number(
    (
      nameConfidence * rules.weights.name +
      ingConfidence * rules.weights.ingredients +
      stepsConfidence * rules.weights.steps
    ).toFixed(3),
  )

  const missingCritical = all.length === 0 || steps.length === 0
  if (all.length === 0) warnings.push('未能识别出食材，请手动补充')

  return {
    name,
    nameConfidence,
    intro,
    ingredients: all,
    steps,
    tips,
    servings,
    durationMin,
    suggestedCategoryName: suggestCategory(name, all, intro),
    suggestedTags: suggestTags(name, all, durationMin),
    // 关键字段缺失时整体分直接压到阈值之下，保证一定会走兜底而不是「看起来还行」
    overall: missingCritical ? Math.min(overall, 0.5) : overall,
    missingCritical,
    warnings,
    source: 'rules',
  }
}

/** 食材字段的置信度：既看抽出了多少，也看抽得干不干净 */
function scoreIngredients(items: ParsedIngredient[]): number {
  if (items.length === 0) return 0
  const avg = items.reduce((s, i) => s + i.confidence, 0) / items.length
  // 数量上至少有 2 样才认为这个区块是「抽全了」
  const coverage = Math.min(1, items.length / 2)
  return Number((avg * 0.7 + coverage * 0.3).toFixed(3))
}

/** 是否需要 LLM 兜底（FR-1.10） */
export function needsFallback(result: ParseResult, strategy: ParseStrategy): boolean {
  if (strategy === 'rules') return false
  if (strategy === 'llm') return true
  return result.overall < PARSE_THRESHOLD || result.missingCritical
}

export type ParseStrategy = 'rules' | 'fallback' | 'llm'
