import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '@/store/appStore'
import {
  applyProviderDefaults,
  DEFAULT_LLM_CONFIG,
  isConfigured,
  loadLlmConfig,
  PROVIDER_DEFAULT,
  saveLlmConfig,
  type LlmConfig,
  type LlmProvider,
} from '@/data/llm'

const PROVIDERS: LlmProvider[] = ['deepseek', 'claude', 'custom']

export default function LlmSettingsPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)

  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [reveal, setReveal] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    void loadLlmConfig().then(setConfig)
  }, [])

  const patch = (p: Partial<LlmConfig>) => {
    setConfig((c) => (c ? { ...c, ...p } : c))
    setDirty(true)
  }

  if (!config) return <p className="p-6 text-center text-sm text-stone-400">加载中…</p>

  const handleSave = async () => {
    await saveLlmConfig(config)
    setDirty(false)
    showToast('已保存')
  }

  return (
    <div className="px-4 pb-28 pt-4">
      <header className="mb-4 flex items-center gap-2">
        <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="text-lg font-semibold">大模型配置</h1>
      </header>

      <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
        <strong>使用前请知悉：</strong>这是纯前端应用，没有后端服务器，所以 API Key 会保存在
        你的浏览器本地（IndexedDB）。能打开这台设备浏览器的人就能拿到它。
        <br />
        建议：单独申请一个**低额度**的 Key 专供这里使用，随时可吊销。
        不配置也完全不影响使用——粘贴解析会退回本地规则引擎。
      </p>

      <section className="card mb-4 space-y-3 p-3">
        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">服务商</span>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setConfig(applyProviderDefaults(config, p))
                  setDirty(true)
                }}
                className={`chip border ${
                  config.provider === p
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-stone-200 bg-white text-stone-600'
                }`}
              >
                {PROVIDER_DEFAULT[p].label}
              </button>
            ))}
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">API Key</span>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              type={reveal ? 'text' : 'password'}
              placeholder="sk-…"
              autoComplete="off"
              value={config.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
            <button type="button" className="btn-secondary shrink-0 px-3 text-xs" onClick={() => setReveal((v) => !v)}>
              {reveal ? '隐藏' : '显示'}
            </button>
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">Base URL</span>
          <input
            className="input font-mono text-xs"
            placeholder="https://api.deepseek.com"
            value={config.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">模型名</span>
          <input
            className="input font-mono text-xs"
            placeholder="deepseek-chat"
            value={config.model}
            onChange={(e) => patch({ model: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">超时（秒）</span>
          <input
            type="number"
            min={5}
            max={120}
            className="input w-28"
            value={Math.round(config.timeoutMs / 1000)}
            onChange={(e) => patch({ timeoutMs: Math.max(5, Number(e.target.value) || 30) * 1000 })}
          />
        </label>

        <p className={`text-xs ${isConfigured(config) ? 'text-brand-600' : 'text-stone-400'}`}>
          {isConfigured(config)
            ? `已配置：兜底解析会调用 ${PROVIDER_DEFAULT[config.provider].label} / ${config.model}`
            : '尚未配置完整，粘贴解析将只使用本地规则引擎'}
        </p>
      </section>

      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary flex-1"
          onClick={() => {
            setConfig({ ...DEFAULT_LLM_CONFIG })
            setDirty(true)
          }}
        >
          恢复默认
        </button>
        <button type="button" className="btn-primary flex-1" disabled={!dirty} onClick={() => void handleSave()}>
          {dirty ? '保存' : '已保存'}
        </button>
      </div>

      <section className="card mt-4 p-3 text-xs leading-relaxed text-stone-500">
        <p className="font-medium text-stone-700">关于这一步的取舍</p>
        <p className="mt-1">
          本地规则引擎已经能处理大部分格式规整的菜谱，大模型只负责兜住长尾（口语化描述、
          格式极乱、纯图片配文）。所以默认策略是「规则先跑，拿不准才调模型」——
          既省额度，也避免把整篇菜谱无谓地发出去。
        </p>
      </section>
    </div>
  )
}
