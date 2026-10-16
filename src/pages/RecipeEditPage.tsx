import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import CategorySelect from '@/components/CategorySelect'
import ImagePicker from '@/components/ImagePicker'
import TagSelect from '@/components/TagSelect'
import { useAsync } from '@/hooks/useAsync'
import {
  createRecipe,
  getRecipeDetail,
  listCategories,
  setRecipeCover,
  updateRecipe,
  UNCATEGORIZED_ID,
} from '@/data/repository'
import { useAppStore } from '@/store/appStore'
import { parseAmount, UNIT_OPTIONS } from '@/domain/units'
import type { Difficulty, ID, IngredientKind, RecipeDraft, SourceType } from '@/types/models'
import { DIFFICULTY_LABEL } from '@/utils/labels'

interface FormIngredient {
  key: string
  kind: IngredientKind
  name: string
  /** 自由文本用量，如「500g」「2 个」「适量」（FR-1.2 四段式合并为一次输入） */
  amountRaw: string
  note: string
}

interface FormStep {
  key: string
  text: string
  /** 分钟数，可空 */
  timerMin: string
  /** 步骤配图（FR-1.22）。编辑时必须带上原值，否则整体替换步骤会把已有的图弄丢 */
  imageBlobId: ID | null
}

interface FormState {
  name: string
  intro: string
  /** 封面图 blobId（FR-1.19）。新建时菜谱还不存在，所以先存图、保存时再挂上去 */
  coverBlobId: ID | null
  categoryId: ID
  tagIds: ID[]
  servings: number
  durationMin: string
  difficulty: Difficulty
  tips: string
  ingredients: FormIngredient[]
  steps: FormStep[]
}

const DRAFT_VERSION = 1

function newKey(): string {
  return Math.random().toString(36).slice(2, 10)
}

function emptyForm(): FormState {
  return {
    name: '',
    intro: '',
    coverBlobId: null,
    categoryId: UNCATEGORIZED_ID,
    tagIds: [],
    servings: 2,
    durationMin: '',
    difficulty: 1,
    tips: '',
    ingredients: [
      { key: newKey(), kind: 'main', name: '', amountRaw: '', note: '' },
      { key: newKey(), kind: 'main', name: '', amountRaw: '', note: '' },
      { key: newKey(), kind: 'seasoning', name: '', amountRaw: '', note: '' },
    ],
    steps: [{ key: newKey(), text: '', timerMin: '', imageBlobId: null }],
  }
}

export default function RecipeEditPage() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)

  const draftKey = `draft:recipe:${id ?? 'new'}`

  const { data: existing, loading } = useAsync(
    () => (id ? getRecipeDetail(id) : Promise.resolve(null)),
    [id],
    null,
  )
  const { data: categories } = useAsync(() => listCategories(), [], [])

  const [form, setForm] = useState<FormState>(emptyForm)
  const [hydrated, setHydrated] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedAtRef = useRef<number | null>(null)

  // ---- 初始填充：优先用草稿，其次用已有菜谱（FR-1.5） ----
  useEffect(() => {
    if (hydrated) return
    if (isEdit && loading) return

    const raw = localStorage.getItem(draftKey)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { version: number; savedAt: number; form: FormState }
        if (parsed.version === DRAFT_VERSION && parsed.form) {
          setForm({ ...emptyForm(), ...parsed.form })
          setDraftRestored(true)
          setHydrated(true)
          return
        }
      } catch {
        // 草稿损坏则忽略
      }
    }

    if (isEdit && existing) {
      setForm({
        name: existing.recipe.name,
        intro: existing.recipe.intro ?? '',
        coverBlobId: existing.recipe.coverBlobId,
        categoryId: existing.recipe.categoryId,
        tagIds: existing.recipe.tagIds,
        servings: existing.recipe.servings,
        durationMin: existing.recipe.durationMin === null ? '' : String(existing.recipe.durationMin),
        difficulty: existing.recipe.difficulty,
        tips: existing.recipe.tips ?? '',
        ingredients: existing.ingredients.map((i) => ({
          key: newKey(),
          kind: i.kind,
          name: i.name,
          amountRaw: i.amount === null ? i.amountText ?? '' : formatRaw(i.amount, i.unit),
          note: i.note ?? '',
        })),
        steps: existing.steps.map((s) => ({
          key: newKey(),
          text: s.text,
          timerMin: s.timerSec ? String(Math.round(s.timerSec / 60)) : '',
          imageBlobId: s.imageBlobId,
        })),
      })
    }
    setHydrated(true)
  }, [hydrated, isEdit, loading, existing, draftKey])

  // ---- 草稿自动保存：输入停顿 2s 落盘（FR-1.5） ----
  useEffect(() => {
    if (!hydrated) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ version: DRAFT_VERSION, savedAt: Date.now(), form }),
        )
        savedAtRef.current = Date.now()
      } catch {
        // 存储满等情况忽略，不影响主流程
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [form, draftKey, hydrated])

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }, [])

  const parsedPreview = useMemo(
    () => form.ingredients.map((i) => (i.amountRaw.trim() ? parseAmount(i.amountRaw) : null)),
    [form.ingredients],
  )

  const handleSave = async () => {
    const name = form.name.trim()
    if (!name) {
      setError('菜名必填')
      return
    }

    const ingredients = form.ingredients
      .filter((i) => i.name.trim())
      .map((i, idx) => {
        const parsed = i.amountRaw.trim()
          ? parseAmount(i.amountRaw)
          : { amount: null, unit: null, amountText: null }
        return {
          kind: i.kind,
          name: i.name.trim(),
          normalizedId: null,
          amount: parsed.amount,
          unit: parsed.unit,
          amountText: parsed.amountText,
          note: i.note.trim() || null,
          order: idx,
        }
      })

    const steps = form.steps
      .filter((s) => s.text.trim())
      .map((s, idx) => ({
        order: idx,
        text: s.text.trim(),
        imageBlobId: s.imageBlobId,
        timerSec: s.timerMin.trim() ? Math.round(Number(s.timerMin) * 60) : null,
        timerLabel: null,
      }))

    if (ingredients.length === 0) {
      setError('至少填 1 个食材')
      return
    }
    if (steps.length === 0) {
      setError('至少填 1 个步骤')
      return
    }

    const draft: RecipeDraft = {
      name,
      intro: form.intro.trim() || null,
      categoryId: form.categoryId,
      tagIds: form.tagIds,
      servings: form.servings,
      durationMin: form.durationMin.trim() ? Number(form.durationMin) : null,
      difficulty: form.difficulty,
      sourceType: (isEdit ? existing?.recipe.sourceType ?? 'manual' : 'manual') as SourceType,
      sourceText: isEdit ? existing?.recipe.sourceText ?? null : null,
      tips: form.tips.trim() || null,
      ingredients,
      steps,
    }

    setSaving(true)
    setError(null)
    try {
      const targetId = isEdit && id ? id : await createRecipe(draft)
      if (isEdit && id) await updateRecipe(id, draft)
      // 封面走独立入口：setRecipeCover 会顺手回收被换掉的旧图（没人再引用才删）
      await setRecipeCover(targetId, form.coverBlobId)
      localStorage.removeItem(draftKey)
      showToast(isEdit ? '已保存' : '菜谱已创建')
      navigate(`/recipes/${targetId}`, { replace: true })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const discardDraft = () => {
    localStorage.removeItem(draftKey)
    setDraftRestored(false)
    setForm(emptyForm())
    if (isEdit) {
      // 重新用原数据填充
      setHydrated(false)
    }
  }

  if (isEdit && loading) return <p className="py-24 text-center text-sm text-stone-400">加载中…</p>

  return (
    <div className="px-4 pb-32 pt-4">
      <header className="mb-4 flex items-center gap-2">
        <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="text-lg font-semibold">{isEdit ? '编辑菜谱' : '新建菜谱'}</h1>
      </header>

      {draftRestored && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>已恢复上次未保存的草稿</span>
          <button type="button" className="ml-auto underline" onClick={discardDraft}>
            丢弃草稿
          </button>
        </div>
      )}

      {/* 封面 */}
      <section className="mb-4">
        <label className="label">封面图</label>
        <ImagePicker
          value={form.coverBlobId}
          onChange={(blobId) => update('coverBlobId', blobId)}
          name={form.name || '菜'}
          allowRatio
        />
      </section>

      {/* 基本信息 */}
      <section className="space-y-3">
        <div>
          <label className="label">菜名 *</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="如：蒜香排骨"
          />
        </div>

        <div>
          <label className="label">简介</label>
          <input
            className="input"
            value={form.intro}
            onChange={(e) => update('intro', e.target.value)}
            placeholder="一句话描述，可留空"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">分类</label>
            <CategorySelect value={form.categoryId} onChange={(v) => update('categoryId', v)} categories={categories} />
          </div>
          <div>
            <label className="label">难度</label>
            <select
              className="input"
              value={form.difficulty}
              onChange={(e) => update('difficulty', Number(e.target.value) as Difficulty)}
            >
              {([1, 2, 3] as Difficulty[]).map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABEL[d]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">基准份量（人份）</label>
            <input
              className="input"
              type="number"
              min={1}
              value={form.servings}
              onChange={(e) => update('servings', Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div>
            <label className="label">预计耗时（分钟）</label>
            <input
              className="input"
              type="number"
              min={0}
              value={form.durationMin}
              onChange={(e) => update('durationMin', e.target.value)}
              placeholder="如 30"
            />
          </div>
        </div>

        <div>
          <label className="label">标签</label>
          <TagSelect selected={form.tagIds} onChange={(ids) => update('tagIds', ids)} />
        </div>
      </section>

      {/* 食材 */}
      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">食材与调料</h2>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() =>
              update('ingredients', [...form.ingredients, { key: newKey(), kind: 'main', name: '', amountRaw: '', note: '' }])
            }
          >
            ＋ 加一行
          </button>
        </div>

        <datalist id="unit-options">
          {UNIT_OPTIONS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>

        <ul className="space-y-2">
          {form.ingredients.map((ing, idx) => (
            <li key={ing.key} className="card p-2">
              <div className="flex items-center gap-1.5">
                <select
                  className="input w-20 shrink-0 py-1.5 text-xs"
                  value={ing.kind}
                  onChange={(e) => {
                    const next = [...form.ingredients]
                    next[idx] = { ...ing, kind: e.target.value as IngredientKind }
                    update('ingredients', next)
                  }}
                >
                  <option value="main">食材</option>
                  <option value="seasoning">调料</option>
                </select>
                <input
                  className="input py-1.5"
                  placeholder="名称，如 排骨"
                  value={ing.name}
                  onChange={(e) => {
                    const next = [...form.ingredients]
                    next[idx] = { ...ing, name: e.target.value }
                    update('ingredients', next)
                  }}
                />
                <button
                  type="button"
                  className="btn-ghost shrink-0 px-2 text-stone-400"
                  onClick={() => update('ingredients', form.ingredients.filter((x) => x.key !== ing.key))}
                  title="删除这一行"
                >
                  ✕
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  className="input py-1.5"
                  list="unit-options"
                  placeholder="用量，如 500g / 2 个 / 适量"
                  value={ing.amountRaw}
                  onChange={(e) => {
                    const next = [...form.ingredients]
                    next[idx] = { ...ing, amountRaw: e.target.value }
                    update('ingredients', next)
                  }}
                />
                <input
                  className="input w-28 shrink-0 py-1.5"
                  placeholder="备注"
                  value={ing.note}
                  onChange={(e) => {
                    const next = [...form.ingredients]
                    next[idx] = { ...ing, note: e.target.value }
                    update('ingredients', next)
                  }}
                />
              </div>
              {parsedPreview[idx] && (
                <p className="mt-1 px-1 text-[11px] text-stone-400">
                  识别为：
                  {parsedPreview[idx]!.amount !== null
                    ? `${parsedPreview[idx]!.amount} ${parsedPreview[idx]!.unit ?? ''}`
                    : parsedPreview[idx]!.amountText}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* 步骤 */}
      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">步骤</h2>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => update('steps', [...form.steps, { key: newKey(), text: '', timerMin: '', imageBlobId: null }])}
          >
            ＋ 加一步
          </button>
        </div>
        <ul className="space-y-2">
          {form.steps.map((s, idx) => (
            <li key={s.key} className="card flex gap-2 p-2">
              <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                {idx + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <textarea
                  className="input resize-y py-1.5"
                  rows={2}
                  placeholder="这一步做什么"
                  value={s.text}
                  onChange={(e) => {
                    const next = [...form.steps]
                    next[idx] = { ...s, text: e.target.value }
                    update('steps', next)
                  }}
                />
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-stone-500">计时（分钟）</label>
                  <input
                    className="input w-20 py-1 text-xs"
                    type="number"
                    min={0}
                    placeholder="如 20"
                    value={s.timerMin}
                    onChange={(e) => {
                      const next = [...form.steps]
                      next[idx] = { ...s, timerMin: e.target.value }
                      update('steps', next)
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost ml-auto px-2 text-stone-400"
                    onClick={() => update('steps', form.steps.filter((x) => x.key !== s.key))}
                  >
                    ✕
                  </button>
                </div>
                {/* 步骤配图是可选的，折叠起来别喧宾夺主（FR-1.22） */}
                <details className="text-[11px]" open={s.imageBlobId !== null}>
                  <summary className="cursor-pointer select-none py-0.5 text-stone-400">
                    {s.imageBlobId ? '已配图' : '加一张配图（可选）'}
                  </summary>
                  <ImagePicker
                    className="mt-1.5"
                    value={s.imageBlobId}
                    onChange={(blobId) => {
                      const next = [...form.steps]
                      next[idx] = { ...s, imageBlobId: blobId }
                      update('steps', next)
                    }}
                    name={`第${idx + 1}步`}
                    aspectClass="aspect-[4/3]"
                  />
                </details>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 小贴士 */}
      <section className="mt-6">
        <label className="label">小贴士</label>
        <textarea
          className="input resize-y"
          rows={3}
          value={form.tips}
          onChange={(e) => update('tips', e.target.value)}
          placeholder="容易踩坑的地方、可以提前准备的部分…"
        />
      </section>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <p className="mt-4 text-center text-[11px] text-stone-400">
        {savedAtRef.current ? '草稿已自动保存' : '输入后会自动保存草稿，误关页面不会丢'}
      </p>

      {/* 底部操作 */}
      <div className="fixed inset-x-0 bottom-16 z-20 px-4">
        <div className="mx-auto flex max-w-3xl gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={() => navigate(-1)}>
            取消
          </button>
          <button type="button" className="btn-primary flex-[2]" disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存菜谱'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 把已存的 amount + unit 还原成输入框里的文本 */
function formatRaw(amount: number, unit: string | null): string {
  return unit ? `${amount}${unit}` : String(amount)
}
