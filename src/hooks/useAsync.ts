import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T
  loading: boolean
  error: Error | null
  reload: () => Promise<void>
}

/**
 * 极简异步数据加载 hook。
 * 本项目数据源是本地 IndexedDB，无缓存与竞态问题，不需要引入 react-query 这类重方案。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], initial: T): AsyncState<T> {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const mounted = useRef(true)

  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const run = useCallback(async () => {
    try {
      setLoading(true)
      const result = await loaderRef.current()
      if (mounted.current) {
        setData(result)
        setError(null)
      }
    } catch (e) {
      if (mounted.current) setError(e as Error)
    } finally {
      if (mounted.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    mounted.current = true
    void run()
    return () => {
      mounted.current = false
    }
  }, [run])

  return { data, loading, error, reload: run }
}
