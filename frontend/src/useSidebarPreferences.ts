import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './bridge'
import type { AppearancePreferences, SidebarPreferences } from './types'

export const DEFAULT_APPEARANCE: AppearancePreferences = { fontSize: 17, fontFamily: 'system' }

export const FONT_STACKS: Record<AppearancePreferences['fontFamily'], string> = {
  system: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  humanist: '"Trebuchet MS", "Avenir Next", Avenir, ui-sans-serif, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
}

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
  const [appearance, setAppearanceState] = useState(DEFAULT_APPEARANCE)
  const latest = useRef(values)
  const [ready, setReady] = useState(false)
  const saves = useRef(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    api().LoadAppConfig(latest.current).then(config => {
      if (cancelled) return
      latest.current = config.sidebars
      setValues(config.sidebars)
      setAppearanceState(config.appearance)
      setReady(true)
    }).catch(error => {
      if (!cancelled) onError(`Could not load application settings: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [onError])

  useEffect(() => {
    document.documentElement.style.fontSize = `${appearance.fontSize}px`
    document.documentElement.style.setProperty('--app-font-family', FONT_STACKS[appearance.fontFamily])
  }, [appearance])

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

  const setAppearance = useCallback((next: AppearancePreferences) => {
    const normalized: AppearancePreferences = {
      fontSize: Math.max(14, Math.min(20, Math.round(next.fontSize))),
      fontFamily: next.fontFamily in FONT_STACKS ? next.fontFamily : 'system',
    }
    setAppearanceState(normalized)
    if (!ready) return
    saves.current = saves.current.then(() => api().SaveAppearancePreferences(normalized)).catch(error => {
      onError(`Could not save appearance settings: ${String(error)}`)
    })
  }, [ready, onError])

  return { values, setScale, commit, appearance, setAppearance, ready }
}
