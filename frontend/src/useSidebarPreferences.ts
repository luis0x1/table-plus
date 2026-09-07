import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './bridge'
import type { SidebarPreferences } from './types'

function legacyPreferences(): SidebarPreferences {
  const read = (key: string) => {
    try {
      const value = Number(localStorage.getItem(`querynest:sidebar:${key}`) ?? 1)
      return Number.isFinite(value) ? Math.max(1, Math.min(2, value)) : 1
    } catch { return 1 }
  }
  return { databases: read('databases'), tables: read('tables') }
}

export default function useSidebarPreferences(onError: (message: string) => void) {
  const [values, setValues] = useState(legacyPreferences)
  const latest = useRef(values)
  const [ready, setReady] = useState(false)
  const saves = useRef(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    api().LoadAppConfig(latest.current).then(config => {
      if (cancelled) return
      latest.current = config.sidebars
      setValues(config.sidebars)
      setReady(true)
    }).catch(error => {
      if (!cancelled) onError(`Could not load sidebar settings: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [onError])

  const setScale = useCallback((key: keyof SidebarPreferences, scale: number) => {
    latest.current = { ...latest.current, [key]: Math.max(1, Math.min(2, scale)) }
    setValues(latest.current)
  }, [])

  const commit = useCallback(() => {
    if (!ready) return
    const snapshot = { ...latest.current }
    // Serialize writes so rapid changes cannot save an older size last.
    saves.current = saves.current.then(() => api().SaveSidebarPreferences(snapshot)).catch(error => {
      onError(`Could not save sidebar settings: ${String(error)}`)
    })
  }, [ready, onError])

  return { values, setScale, commit, ready }
}
