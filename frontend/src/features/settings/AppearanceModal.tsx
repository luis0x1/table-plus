import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { AppearancePreferences, EditingPreferences, TransferPreferences } from '../../types'
import {
  CARET_WIDTH_RANGE,
  EDITOR_FONT_SIZE_RANGE,
  FONT_STACKS,
  UNDO_HISTORY_RANGE,
} from '../../lib/preferences/useSidebarPreferences'
import { Check, ChevronDown, Plus, Refresh, Search, Settings, X } from '../../components/ui/icons'

const CARET_WIDTH_OPTIONS = [
  { value: 1, label: 'Thin' },
  { value: 2, label: 'Default' },
  { value: 3, label: 'Thick' },
  { value: 4, label: 'Extra' },
]

const BUILTIN_FONTS = [
  { value: 'system', label: 'System default' },
  { value: 'humanist', label: 'System humanist' },
  { value: 'serif', label: 'System serif' },
  { value: 'mono', label: 'System monospace' },
]

function FontPicker(props: {
  value: string
  fonts: string[]
  loading: boolean
  label: string
  onChange: (value: string) => void
  onRefresh: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal('')
  let root!: HTMLDivElement
  let searchInput!: HTMLInputElement
  const options = createMemo(() => {
    const seen = new Set<string>()
    const values = [...BUILTIN_FONTS, ...props.fonts.map((font) => ({ value: font, label: font }))]
    const query = search().trim().toLocaleLowerCase()
    return values.filter((option) => {
      const key = option.value.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return !query || option.label.toLocaleLowerCase().includes(query)
    })
  })
  const selectedLabel = () => BUILTIN_FONTS.find((option) => option.value === props.value)?.label ?? props.value
  const exactMatch = () => {
    const query = search().trim().toLocaleLowerCase()
    return (
      !query ||
      [...BUILTIN_FONTS.map((option) => option.value), ...props.fonts].some(
        (font) => font.toLocaleLowerCase() === query,
      )
    )
  }
  const choose = (value: string) => {
    props.onChange(value)
    setSearch('')
    setOpen(false)
  }

  onMount(() => {
    const close = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('pointerdown', close)
    onCleanup(() => document.removeEventListener('pointerdown', close))
  })
  createEffect(() => {
    if (open()) queueMicrotask(() => searchInput?.focus())
  })

  return (
    <div ref={root} class="font-family-control">
      <button
        type="button"
        class={`font-picker-trigger ${open() ? 'open' : ''}`}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="font-picker-mark" style={{ 'font-family': FONT_STACKS[props.value] ?? props.value }}>
          Aa
        </span>
        <span>
          <b>{selectedLabel()}</b>
          <small>
            {props.loading ? 'Scanning installed fonts…' : `${props.fonts.length.toLocaleString()} installed fonts`}
          </small>
        </span>
        <ChevronDown size={15} />
      </button>
      <Show when={open()}>
        <div class="font-picker-popover">
          <label class="font-picker-search">
            <Search size={14} />
            <input
              ref={searchInput}
              value={search()}
              placeholder="Search installed fonts…"
              aria-label="Search installed fonts"
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <Show when={search()}>
              <button
                type="button"
                onClick={() => {
                  setSearch('')
                  searchInput.focus()
                }}
                aria-label="Clear font search"
              >
                <X size={13} />
              </button>
            </Show>
          </label>
          <div class="font-picker-list" role="listbox" aria-label={props.label}>
            <For each={options()}>
              {(option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={props.value === option.value}
                  class={props.value === option.value ? 'selected' : ''}
                  onClick={() => choose(option.value)}
                >
                  <span class="font-option-sample" style={{ 'font-family': FONT_STACKS[option.value] ?? option.value }}>
                    Aa
                  </span>
                  <span>{option.label}</span>
                  <Show when={props.value === option.value}>
                    <Check size={14} />
                  </Show>
                </button>
              )}
            </For>
            <Show when={search().trim() && !exactMatch()}>
              <button type="button" class="font-custom-option" onClick={() => choose(search().trim())}>
                <Plus size={14} />
                <span>Use “{search().trim()}”</span>
              </button>
            </Show>
            <Show when={!options().length && !search().trim()}>
              <div class="font-picker-empty">No installed fonts found.</div>
            </Show>
          </div>
          <footer>
            <span>{props.loading ? 'Scanning fonts…' : `${props.fonts.length.toLocaleString()} fonts available`}</span>
            <button type="button" disabled={props.loading} onClick={props.onRefresh}>
              <Refresh size={13} class={props.loading ? 'spin' : ''} /> Refresh
            </button>
          </footer>
        </div>
      </Show>
    </div>
  )
}

export default function AppearanceModal(props: {
  appearance: AppearancePreferences
  transfer: TransferPreferences
  editing: EditingPreferences
  fonts: string[]
  fontsLoading: boolean
  ready: boolean
  onChange: (next: AppearancePreferences) => void
  onTransferChange: (next: TransferPreferences) => void
  onEditingChange: (next: EditingPreferences) => void
  onRefreshFonts: () => void
  onReset: () => void
  onClose: () => void
}) {
  onMount(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })

  const changeSize = (fontSize: number) => props.onChange({ ...props.appearance, fontSize })
  return (
    <div
      class="modal-backdrop appearance-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section class="appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <header>
          <div class="modal-mark">
            <Settings size={18} />
          </div>
          <div>
            <h3 id="appearance-title">Settings</h3>
            <p>Interface, editor, history, and data preferences.</p>
          </div>
          <button class="icon-button" onClick={props.onClose} aria-label="Close appearance settings">
            <X size={16} />
          </button>
        </header>
        <div class="appearance-content">
          <div class="settings-group-heading">
            <span>Interface</span>
            <small>Typography used throughout QueryNest</small>
          </div>
          <section class="appearance-section typography-settings">
            <div class="setting-heading">
              <div>
                <b>Font size</b>
                <small>Scales text throughout the application.</small>
              </div>
              <output>{props.appearance.fontSize} px</output>
            </div>
            <div class="font-size-control">
              <button
                onClick={() => changeSize(props.appearance.fontSize - 1)}
                disabled={!props.ready || props.appearance.fontSize <= 14}
                aria-label="Decrease font size"
              >
                A−
              </button>
              <input
                type="range"
                min="14"
                max="20"
                step="1"
                value={props.appearance.fontSize}
                disabled={!props.ready}
                aria-label="Global font size"
                onInput={(event) => changeSize(Number(event.currentTarget.value))}
              />
              <button
                onClick={() => changeSize(props.appearance.fontSize + 1)}
                disabled={!props.ready || props.appearance.fontSize >= 20}
                aria-label="Increase font size"
              >
                A+
              </button>
            </div>
            <div class="range-labels" aria-hidden="true">
              <span>Compact</span>
              <span>Large</span>
            </div>
            <div class="setting-divider" />
            <div class="setting-heading compact">
              <div>
                <b>Font family</b>
                <small>Choose from fonts installed on this computer.</small>
              </div>
            </div>
            <FontPicker
              value={props.appearance.fontFamily}
              fonts={props.fonts}
              loading={props.fontsLoading}
              label="Interface font family"
              onRefresh={props.onRefreshFonts}
              onChange={(fontFamily) => props.onChange({ ...props.appearance, fontFamily })}
            />
          </section>

          <div class="settings-group-heading">
            <span>Editor</span>
            <small>SQL editor typography and cursor</small>
          </div>
          <section class="appearance-section typography-settings">
            <div class="setting-heading">
              <div>
                <b>Font size</b>
                <small>Changes SQL text without scaling the rest of the interface.</small>
              </div>
              <output>{props.editing.editorFontSize} px</output>
            </div>
            <div class="font-size-control editor-font-size-control">
              <button
                onClick={() =>
                  props.onEditingChange({ ...props.editing, editorFontSize: props.editing.editorFontSize - 1 })
                }
                disabled={!props.ready || props.editing.editorFontSize <= EDITOR_FONT_SIZE_RANGE.min}
                aria-label="Decrease editor font size"
              >
                A−
              </button>
              <input
                type="range"
                min={EDITOR_FONT_SIZE_RANGE.min}
                max={EDITOR_FONT_SIZE_RANGE.max}
                step="1"
                value={props.editing.editorFontSize}
                disabled={!props.ready}
                aria-label="Editor font size"
                onInput={(event) =>
                  props.onEditingChange({ ...props.editing, editorFontSize: Number(event.currentTarget.value) })
                }
              />
              <button
                onClick={() =>
                  props.onEditingChange({ ...props.editing, editorFontSize: props.editing.editorFontSize + 1 })
                }
                disabled={!props.ready || props.editing.editorFontSize >= EDITOR_FONT_SIZE_RANGE.max}
                aria-label="Increase editor font size"
              >
                A+
              </button>
            </div>
            <div class="range-labels" aria-hidden="true">
              <span>Compact</span>
              <span>Large</span>
            </div>
            <div class="setting-divider" />
            <div class="setting-heading compact">
              <div>
                <b>Font family</b>
                <small>Use any installed font for SQL code.</small>
              </div>
            </div>
            <FontPicker
              value={props.editing.editorFontFamily}
              fonts={props.fonts}
              loading={props.fontsLoading}
              label="Editor font family"
              onRefresh={props.onRefreshFonts}
              onChange={(editorFontFamily) => props.onEditingChange({ ...props.editing, editorFontFamily })}
            />
            <div class="setting-divider" />
            <div class="setting-heading">
              <div>
                <b>Editor caret width</b>
                <small>Adjust the thickness of the text cursor in SQL editors.</small>
              </div>
              <output>{props.editing.caretWidth} px</output>
            </div>
            <div class="caret-width-options" role="radiogroup" aria-label="Editor caret width">
              <For each={CARET_WIDTH_OPTIONS}>
                {(option) => (
                  <button
                    role="radio"
                    aria-checked={props.editing.caretWidth === option.value}
                    class={props.editing.caretWidth === option.value ? 'active' : ''}
                    disabled={
                      !props.ready || option.value < CARET_WIDTH_RANGE.min || option.value > CARET_WIDTH_RANGE.max
                    }
                    onClick={() => props.onEditingChange({ ...props.editing, caretWidth: option.value })}
                  >
                    <i class={`caret-preview width-${option.value}`} />
                    <span>{option.label}</span>
                  </button>
                )}
              </For>
            </div>
          </section>

          <div class="settings-group-heading">
            <span>History</span>
            <small>Memory used for local editing</small>
          </div>
          <section class="appearance-section">
            <div class="setting-heading">
              <div>
                <b>Undo history limit</b>
                <small>How many draft changes each table tab can step back through.</small>
              </div>
              <output>{props.editing.undoHistoryLimit.toLocaleString()} changes</output>
            </div>
            <label class="batch-size-control">
              <input
                type="number"
                min={UNDO_HISTORY_RANGE.min}
                max={UNDO_HISTORY_RANGE.max}
                step="1"
                value={props.editing.undoHistoryLimit}
                disabled={!props.ready}
                aria-label="Undo history limit"
                onInput={(event) =>
                  props.onEditingChange({
                    ...props.editing,
                    undoHistoryLimit: Number(event.currentTarget.value) || UNDO_HISTORY_RANGE.min,
                  })
                }
              />
              <span>changes</span>
            </label>
            <div class="batch-size-hint">
              The default is 100. Each step keeps a snapshot of that tab's pending changes, so a lower limit releases
              memory sooner.
            </div>
          </section>

          <div class="settings-group-heading">
            <span>Data operations</span>
            <small>Backup and transfer behaviour</small>
          </div>
          <section class="appearance-section">
            <div class="setting-heading">
              <div>
                <b>Backup batch size</b>
                <small>Flushes streamed backup data and writes a recovery checkpoint at this interval.</small>
              </div>
              <output>{props.transfer.backupBatchSizeMB.toLocaleString()} MB</output>
            </div>
            <label class="batch-size-control">
              <input
                type="number"
                min="1"
                max="10240"
                step="1"
                value={props.transfer.backupBatchSizeMB}
                disabled={!props.ready}
                onInput={(event) =>
                  props.onTransferChange({ backupBatchSizeMB: Number(event.currentTarget.value) || 1 })
                }
              />
              <span>MB</span>
            </label>
            <div class="batch-size-hint">
              The default is 500 MB. Data is streamed continuously and is not buffered to this size in memory.
            </div>
          </section>
          <div class="appearance-preview">
            <span>Preview</span>
            <p>Query your data with clarity.</p>
            <small>SELECT * FROM customers;</small>
          </div>
        </div>
        <footer>
          <button class="secondary reset-settings" disabled={!props.ready} onClick={props.onReset}>
            <Refresh size={14} /> Reset all settings
          </button>
          <button class="primary" onClick={props.onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  )
}
