import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '@/hooks/useAsync'
import CategorySelect from '@/components/CategorySelect'
import TagSelect from '@/components/TagSelect'
import { useAppStore } from '@/store/appStore'
import {
  createRecipe,
  ensureTag,
  findCategoryByName,
  listCategories,
  UNCATEGORIZED_ID,
} from '@/data/repository'
import { parseRecipeSource, type ParseOutcome, type ProgressPhase } from '@/data/importRecipe'
import { parseAmount } from '@/domain/units'
import { HIGHLIGHT_THRESHOLD, type ParseResult, type ParseStrategy } from '@/domain/parse'
import { isConfigured, loadLlmConfig, PROVIDER_DEFAULT, type LlmConfig } from '@/data/llm'
import type { Category, Difficulty, ID, IngredientKind, RecipeDraft, TagDimension } from '@/types/models'
import { formatDuration } from '@/utils/labels'

/** 预览页里可编辑的一行食材 */
interface DraftIngredient {
  key: string
  name: string
  amountRaw: string
  kind: IngredientKind
  confidence: number
}

interface DraftStep {
  key: string
  text: string
  timerSec: number | null
  timerLabel: string | null
  confidence: number
}

const STRATEGY_LABEL: Record<ParseStrategy, string> = {
  rules: '仅本地规则',
  fallback: '规则 + 大模型兜底',
  llm: '强制用大模型',
}

let seq = 0
const nextKey = () => `k${++seq}`

const DIMENSIONS: TagDimension[] = ['cuisine', 'taste', 'method', 'scene', 'diet', 'custom']

/** 模型给的 dimension 不可信，落到合法值上，否则标签会在筛选面板里凭空消失 */
function toDimension(raw: string): TagDimension {
  return (DIMENSIONS as string[]).includes(raw) ? (raw as TagDimension) : 'custom'
}

export default function ImportPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)

  const [step, setStep] = useState<'input' | 'preview'>('input')
  const [text, setText] = useState('')
  const [strategy, setStrategy] = useState<ParseStrategy>('fallback')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<ProgressPhase | null>(null)
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null)
  const [engine, setEngine] = useState<'rules' | 'llm'>('rules')
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [saving, setSaving] = useState(false)

  // 预览态的可编辑字段
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState<ID>(UNCATEGORIZED_ID)
  const [tagIds, setTagIds] = useState<ID[]>([])
  const [servings, setServings] = useState(2)
  const [durationMin, setDurationMin] = useState<number | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>(1)
  const [tips, setTips] = useState('')
  const [ingredients, setIngredients] = useState<DraftIngredient[]>([])
  const [steps, setSteps] = useState<DraftStep[]>([])
  const [suggestedTagNames, setSuggestedTagNames] = useState<string[]>([])

  const { data: categories } = useAsync<Category[]>(() => listCategories(), [], [])

  const active: ParseResult | null = outcome ? (engine === 'llm' ? outcome.llm : outcome.rules) : null

  // 首次进入时读一次 LLM 配置，用于提示用户「本次会发到哪家」
  useEffect(() => {
    void loadLlmConfig().then(setLlmConfig)
  }, [])

  const willCallLlm = strategy !== 'rules' && llmConfig !== null && isConfigured(llmConfig)

  // -------------------------------------------------------------------------
  // 解析
  // -------------------------------------------------------------------------

  const handleParse = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setOutcome(null)
    try {
      const result = await parseRecipeSource(text, strategy, { onProgress: setPhase })
      setOutcome(result)
      setEngine(result.active)
      await applyResult(result.active === 'llm' && result.llm ? result.llm : result.rules)
      if (result.llmError) showToast(result.llmError)
      setStep('preview')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '解析失败')
    } finally {
      setBusy(false)
      setPhase(null)
    }
  }

  /** 把一份解析结果灌进可编辑的草稿态 */
  const applyResult = async (result: ParseResult) => {
    setName(result.name)
    setServings(result.servings ?? 2)
    setDurationMin(result.durationMin)
    setTips(result.tips ?? '')
    setIngredients(
      result.ingredients.map((i) => ({
        key: nextKey(),
        name: i.name,
        amountRaw: i.amountRaw ?? '',
        kind: i.kind,
        confidence: i.confidence,
      })),
    )
    setSteps(
      result.steps.map((s) => ({
        key: nextKey(),
        text: s.text,
        timerSec: s.timerSec,
        timerLabel: s.timerLabel,
        confidence: s.confidence,
      })),
    )

    // 分类：优先用建议名匹配现有分类节点，匹配不上就落到「未分类」
    const suggested = await findCategoryByName(result.suggestedCategoryName ?? '')
    setCategoryId(suggested?.id ?? UNCATEGORIZED_ID)

    // 标签：建议的名字逐个 ensure（没有就建），并把它们挂上（FR-1.16）
    const ids: ID[] = []
    for (const tag of result.suggestedTags) {
      ids.push(await ensureTag(tag.name, toDimension(tag.dimension)))
    }
    setTagIds([...new Set(ids)])
    setSuggestedTagNames(result.suggestedTags.map((t) => t.name))
  }

  /** 换个引擎重看（FR-1.14）——会覆盖用户已做的编辑，所以先问一句 */
  const switchEngine = async (next: 'rules' | 'llm') => {
    if (next === engine) return
    const target = next === 'llm' ? outcome?.llm : outcome?.rules
    if (!target) return
    const edited =
      name !== active?.name ||
      ingredients.length !== active?.ingredients.length ||
      steps.length !== active?.steps.length
    if (edited && !window.confirm('切换解析结果会覆盖你刚才的修改，继续吗？')) return
    setEngine(next)
    await applyResult(target)
  }

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (saving) return
    if (!name.trim()) {
      showToast('菜名不能为空')
      return
    }
    if (ingredients.length === 0 && steps.length === 0) {
      showToast('食材和步骤都是空的，先补充一下再保存')
      return
    }
    setSaving(true)
    try {
      const draft: RecipeDraft = {
        name: name.trim(),
        intro: active?.intro ?? null,
        categoryId,
        tagIds,
        servings,
        durationMin,
        difficulty,
        sourceType: 'paste',
        // FR-1.15：原文一起存下来，随时可回看比对
        sourceText: text.trim() || null,
        tips: tips.trim() || null,
        ingredients: ingredients
          .filter((i) => i.name.trim())
          .map((i, idx) => {
            const parsed = i.amountRaw.trim() ? parseAmount(i.amountRaw) : { amount: null, unit: null, amountText: null }
            return {
              kind: i.kind,
              name: i.name.trim(),
              normalizedId: null,
              amount: parsed.amount,
              unit: parsed.unit,
              amountText: parsed.amountText,
              note: null,
              order: idx,
            }
          }),
        steps: steps
          .filter((s) => s.text.trim())
          .map((s, idx) => ({
            order: idx,
            text: s.text.trim(),
            imageBlobId: null,
            timerSec: s.timerSec,
            timerLabel: s.timerLabel,
          })),
      }
      const id = await createRecipe(draft)
      showToast('已保存')
      navigate(`/recipes/${id}`, { replace: true })
    } finally {
      setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // 渲染：输入
  // -------------------------------------------------------------------------

  if (step === 'input') {
    return (
      <div className="px-4 pb-28 pt-4">
        <header className="mb-4 flex items-center gap-2">
          <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)}>
            ← 返回
          </button>
          <h1 className="text-lg font-semibold">粘贴菜谱</h1>
        </header>

        <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
          从公众号 / 小红书 / 聊天记录里复制的菜谱，整段粘进来就行，格式乱也没关系。
          解析结果**一定会先给你看一遍**再保存，不会直接入库。
        </p>

        <textarea
          className="input mb-3 h-72 resize-y font-mono text-[13px] leading-relaxed"
          placeholder={'例：\n\n【番茄炒蛋】\n\n食材：\n番茄 2个\n鸡蛋 3个\n\n做法：\n1. 番茄切块…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />

        <section className="card mb-3 p-3">
          <h2 className="mb-2 text-sm font-medium">解析策略</h2>
          <div className="space-y-1.5">
            {(['rules', 'fallback', 'llm'] as ParseStrategy[]).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="strategy"
                  checked={strategy === s}
                  onChange={() => setStrategy(s)}
                  disabled={busy}
                />
                {STRATEGY_LABEL[s]}
                {s === 'rules' && <span className="text-xs text-stone-400">完全离线，不联网</span>}
              </label>
            ))}
          </div>
        </section>

        {/* 隐私提示（FR-6.1 的明确告知义务） */}
        {strategy !== 'rules' && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {llmConfig === null ? (
              '正在读取大模型配置…'
            ) : willCallLlm ? (
              <>
                当本地规则拿不准时，会把**你粘贴的这段文本**发送给{' '}
                {PROVIDER_DEFAULT[llmConfig.provider].label}（{llmConfig.model}）做兜底解析。
                其余数据不会离开本机。
              </>
            ) : (
              <>
                还没有配置 API Key，本次只会用本地规则解析。
                <button
                  type="button"
                  className="ml-1 underline"
                  onClick={() => navigate('/settings/llm')}
                >
                  去配置
                </button>
              </>
            )}
          </p>
        )}

        <button type="button" className="btn-primary w-full" disabled={busy || !text.trim()} onClick={() => void handleParse()}>
          {busy ? (phase === 'llm' ? '大模型解析中…' : '解析中…') : '解析'}
        </button>
        {busy && <p className="mt-2 text-center text-xs text-stone-400">解析期间请勿重复提交</p>}
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // 渲染：预览校正（FR-1.12 / FR-1.13 / FR-1.14）
  // -------------------------------------------------------------------------

  if (!active) return null

  return (
    <div className="px-4 pb-32 pt-4">
      <header className="mb-3 flex items-center gap-2">
        <button type="button" className="btn-ghost px-2" onClick={() => setStep('input')}>
          ← 改原文
        </button>
        <h1 className="text-lg font-semibold">确认解析结果</h1>
      </header>

      {/* 引擎切换（FR-1.14） */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex overflow-hidden rounded-full border border-stone-200 text-xs">
          <button
            type="button"
            onClick={() => void switchEngine('rules')}
            className={`px-3 py-1.5 ${engine === 'rules' ? 'bg-brand-600 text-white' : 'bg-white text-stone-600'}`}
          >
            本地规则
          </button>
          <button
            type="button"
            onClick={() => void switchEngine('llm')}
            disabled={!outcome?.llm}
            className={`px-3 py-1.5 disabled:text-stone-300 ${
              engine === 'llm' ? 'bg-brand-600 text-white' : 'bg-white text-stone-600'
            }`}
          >
            大模型{outcome?.llm ? '' : '（未启用）'}
          </button>
        </div>
        <span className="ml-auto text-xs text-stone-400">
          整体置信度 {Math.round(active.overall * 100)}%
        </span>
      </div>

      {/* 置信度条 */}
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-stone-100">
        <div
          className={`h-full rounded-full ${active.overall >= 0.7 ? 'bg-brand-500' : 'bg-amber-400'}`}
          style={{ width: `${Math.round(active.overall * 100)}%` }}
        />
      </div>

      {active.warnings.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {active.warnings.map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      )}

      {/* 原文回看（FR-1.15） */}
      <div className="mb-3">
        <button type="button" className="text-xs text-brand-600" onClick={() => setShowSource((v) => !v)}>
          {showSource ? '收起原文' : '对照原文 ›'}
        </button>
        {showSource && (
          <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-[12px] leading-relaxed text-stone-600">
            {text}
          </pre>
        )}
      </div>

      {/* 基本信息 */}
      <section className="card mb-3 space-y-3 p-3">
        <Field label="菜名" low={active.nameConfidence < HIGHLIGHT_THRESHOLD}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="分类" hint={active.suggestedCategoryName ? `建议：${active.suggestedCategoryName}` : undefined}>
          <CategorySelect value={categoryId} onChange={setCategoryId} categories={categories} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="份数">
            <input
              type="number"
              min={1}
              className="input"
              value={servings}
              onChange={(e) => setServings(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label="耗时（分钟）" hint={active.durationMin === null ? '原文没写，可留空' : undefined}>
            <input
              type="number"
              min={0}
              className="input"
              value={durationMin ?? ''}
              placeholder="未识别"
              onChange={(e) => setDurationMin(e.target.value === '' ? null : Number(e.target.value))}
            />
          </Field>
        </div>

        <Field label="难度">
          <div className="flex gap-1.5">
            {([1, 2, 3] as Difficulty[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDifficulty(d)}
                className={`chip border ${difficulty === d ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white text-stone-600'}`}
              >
                {d === 1 ? '简单' : d === 2 ? '中等' : '较难'}
              </button>
            ))}
          </div>
        </Field>
      </section>

      {/* 食材 */}
      <section className="card mb-3 p-3">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium">食材（{ingredients.length}）</h2>
          <button
            type="button"
            className="btn-ghost ml-auto px-2 text-xs"
            onClick={() => setIngredients((rows) => [...rows, { key: nextKey(), name: '', amountRaw: '', kind: 'main', confidence: 1 }])}
          >
            ＋ 加一行
          </button>
        </div>
        <ul className="space-y-2">
          {ingredients.map((row, idx) => (
            <li key={row.key} className="flex items-center gap-1.5">
              <ConfidenceDot value={row.confidence} />
              <input
                className={`input flex-1 ${row.confidence < HIGHLIGHT_THRESHOLD ? 'border-amber-300 bg-amber-50/40' : ''}`}
                placeholder="食材名"
                value={row.name}
                onChange={(e) => update(setIngredients, idx, { name: e.target.value })}
              />
              <input
                className={`input w-24 shrink-0 ${row.confidence < HIGHLIGHT_THRESHOLD ? 'border-amber-300 bg-amber-50/40' : ''}`}
                placeholder="用量"
                value={row.amountRaw}
                onChange={(e) => update(setIngredients, idx, { amountRaw: e.target.value })}
              />
              <select
                className="input w-auto shrink-0 px-1 text-xs"
                value={row.kind}
                onChange={(e) => update(setIngredients, idx, { kind: e.target.value as IngredientKind })}
              >
                <option value="main">主料</option>
                <option value="seasoning">调料</option>
              </select>
              <button
                type="button"
                className="btn-ghost shrink-0 px-1 text-xs text-stone-400"
                onClick={() => setIngredients((rows) => rows.filter((r) => r.key !== row.key))}
              >
                ✕
              </button>
            </li>
          ))}
          {ingredients.length === 0 && <li className="py-3 text-center text-xs text-stone-400">没有识别到食材，手动加几行吧</li>}
        </ul>
      </section>

      {/* 步骤 */}
      <section className="card mb-3 p-3">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium">步骤（{steps.length}）</h2>
          <button
            type="button"
            className="btn-ghost ml-auto px-2 text-xs"
            onClick={() => setSteps((rows) => [...rows, { key: nextKey(), text: '', timerSec: null, timerLabel: null, confidence: 1 }])}
          >
            ＋ 加一步
          </button>
        </div>
        <ul className="space-y-2">
          {steps.map((row, idx) => (
            <li key={row.key} className="flex items-start gap-1.5">
              <span className="mt-2 w-5 shrink-0 text-center text-xs text-stone-400">{idx + 1}</span>
              <div className="min-w-0 flex-1">
                <textarea
                  className={`input min-h-[3.5rem] resize-y ${row.confidence < HIGHLIGHT_THRESHOLD ? 'border-amber-300 bg-amber-50/40' : ''}`}
                  placeholder="这一步做什么"
                  value={row.text}
                  onChange={(e) => update(setSteps, idx, { text: e.target.value })}
                />
                {row.timerSec !== null && (
                  <p className="mt-1 text-[11px] text-brand-600">
                    ⏱ 识别到计时：{row.timerLabel ?? '本步骤'} {formatDuration(Math.round(row.timerSec / 60)) || `${row.timerSec} 秒`}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0 px-1 text-xs text-stone-400"
                onClick={() => setSteps((rows) => rows.filter((r) => r.key !== row.key))}
              >
                ✕
              </button>
            </li>
          ))}
          {steps.length === 0 && <li className="py-3 text-center text-xs text-stone-400">没有识别到步骤，手动补几条吧</li>}
        </ul>
      </section>

      {/* 标签与小贴士 */}
      <section className="card mb-3 space-y-3 p-3">
        <Field label="标签" hint={suggestedTagNames.length ? `已按建议预选：${suggestedTagNames.join('、')}` : undefined}>
          <TagSelect selected={tagIds} onChange={setTagIds} />
        </Field>
        <Field label="小贴士">
          <textarea className="input min-h-[4rem] resize-y" value={tips} onChange={(e) => setTips(e.target.value)} />
        </Field>
      </section>

      {/* 固定保存条 */}
      <div className="fixed inset-x-0 bottom-14 z-30 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={() => setStep('input')}>
            返回修改
          </button>
          <button type="button" className="btn-primary flex-[2]" disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '确认并保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function update<T>(setter: React.Dispatch<React.SetStateAction<T[]>>, index: number, patch: Partial<T>) {
  setter((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
}

/** 低置信度字段标黄提示用户重点核对（FR-1.13） */
function ConfidenceDot({ value }: { value: number }) {
  const color = value >= 0.8 ? 'bg-brand-400' : value >= HIGHLIGHT_THRESHOLD ? 'bg-amber-300' : 'bg-amber-500'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} title={`置信度 ${Math.round(value * 100)}%`} />
}

function Field({
  label,
  hint,
  low,
  children,
}: {
  label: string
  hint?: string
  low?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2">
        <span className="text-xs text-stone-500">{label}</span>
        {low && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">建议核对</span>}
        {hint && <span className="text-[11px] text-stone-400">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
