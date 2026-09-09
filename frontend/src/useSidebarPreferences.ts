import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { api } from './bridge'
import type { AppearancePreferences, SidebarPreferences, TransferPreferences } from './types'

export const DEFAULT_APPEARANCE: AppearancePreferences = { fontSize: 17, fontFamily: 'system' }
export const DEFAULT_TRANSFER: TransferPreferences = { backupBatchSizeMB: 500 }

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
  const [values, setValues] = createSignal(legacyPreferences())
  const [appearance, setAppearanceState] = createSignal(DEFAULT_APPEARANCE)
  const [transfer, setTransferState] = createSignal(DEFAULT_TRANSFER)
  const [ready, setReady] = createSignal(false)
  let latest = values()
  let saves = Promise.resolve()

  onMount(() => {
    let cancelled = false
    onCleanup(() => { cancelled = true })
    api().LoadAppConfig(latest).then(config => {
      if (cancelled) return
      latest = config.sidebars
      setValues(config.sidebars)
      setAppearanceState(config.appearance)
      setTransferState(config.transfer)
      setReady(true)
    }).catch(error => {
      if (!cancelled) onError(`Could not load application settings: ${String(error)}`)
    })
  })

  createEffect(() => {
    const current = appearance()
    document.documentElement.style.fontSize = `${current.fontSize}px`
    document.documentElement.style.setProperty('--app-font-family', FONT_STACKS[current.fontFamily])
  })

  const setScale = (key: keyof SidebarPreferences, scale: number) => {
    latest = { ...latest, [key]: Math.max(1, Math.min(2, scale)) }
    setValues(latest)
  }

  const commit = () => {
    if (!ready()) return
    const snapshot = { ...latest }
    // Serialize writes so rapid changes cannot save an older size last.
    saves = saves.then(() => api().SaveSidebarPreferences(snapshot)).catch(error => {
      onError(`Could not save sidebar settings: ${String(error)}`)
    })
  }

  const setAppearance = (next: AppearancePreferences) => {
    const normalized: AppearancePreferences = {
      fontSize: Math.max(14, Math.min(20, Math.round(next.fontSize))),
      fontFamily: next.fontFamily in FONT_STACKS ? next.fontFamily : 'system',
    }
    setAppearanceState(normalized)
    if (!ready()) return
    saves = saves.then(() => api().SaveAppearancePreferences(normalized)).catch(error => {
      onError(`Could not save appearance settings: ${String(error)}`)
    })
  }

  const setTransfer = (next: TransferPreferences) => {
    const normalized = { backupBatchSizeMB: Math.max(1, Math.min(10240, Math.round(next.backupBatchSizeMB))) }
    setTransferState(normalized)
    if (!ready()) return
    saves = saves.then(() => api().SaveTransferPreferences(normalized)).catch(error => {
      onError(`Could not save data operation settings: ${String(error)}`)
    })
  }

  return { values, setScale, commit, appearance, setAppearance, transfer, setTransfer, ready }
}
