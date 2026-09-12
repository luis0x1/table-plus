import { createSignal, onCleanup, onMount } from 'solid-js'
import type { SidebarPreferences } from './types'
import type useSidebarPreferences from './useSidebarPreferences'

export function useCompactSidebar() {
  const media = window.matchMedia('(max-width: 1100px)')
  const [compact, setCompact] = createSignal(media.matches)
  onMount(() => {
    const change = () => setCompact(media.matches)
    media.addEventListener('change', change)
    onCleanup(() => media.removeEventListener('change', change))
  })
  return compact
}

export function useSidebarWidth(key: keyof SidebarPreferences, min: () => number, preferences: ReturnType<typeof useSidebarPreferences>) {
  return {
    width: () => Math.round(min() * preferences.values()[key]),
    min,
    max: () => min() * 2,
    setWidth: (width: number) => preferences.setScale(key, width / min()),
    commit: preferences.commit,
    disabled: () => !preferences.ready(),
  }
}

export type SidebarSizing = ReturnType<typeof useSidebarWidth>

export default function SidebarResizeHandle(props: { label: string; sizing: SidebarSizing }) {
  let handle!: HTMLDivElement
  let drag: { x: number; width: number; pointer: number } | null = null
  const [dragging, setDragging] = createSignal(false)
  const sizing = props.sizing

  function finish(cancel = false) {
    const current = drag
    if (!current) return
    drag = null
    if (cancel) sizing.setWidth(current.width)
    if (handle.hasPointerCapture(current.pointer)) handle.releasePointerCapture(current.pointer)
    document.documentElement.classList.remove('resizing-sidebar')
    setDragging(false)
    sizing.commit()
  }

  onCleanup(() => { if (drag) document.documentElement.classList.remove('resizing-sidebar') })

  return <div ref={handle} class={`sidebar-resize-handle ${dragging() ? 'dragging' : ''}`} role="separator" aria-label={props.label} aria-orientation="vertical" aria-valuemin={sizing.min()} aria-valuemax={sizing.max()} aria-valuenow={sizing.width()} aria-valuetext={`${sizing.width()} pixels`} aria-disabled={sizing.disabled()} tabIndex={sizing.disabled() ? -1 : 0} title="Drag to resize · Double-click to reset"
    onPointerDown={event => {
      if (sizing.disabled() || event.button !== 0 || drag) return
      event.preventDefault(); event.stopPropagation()
      event.currentTarget.focus()
      drag = { x: event.clientX, width: sizing.width(), pointer: event.pointerId }
      event.currentTarget.setPointerCapture(event.pointerId)
      document.documentElement.classList.add('resizing-sidebar')
      setDragging(true)
    }}
    onPointerMove={event => {
      if (drag?.pointer === event.pointerId) sizing.setWidth(drag.width + event.clientX - drag.x)
    }}
    onPointerUp={() => finish()}
    onPointerCancel={() => finish(true)}
    on:lostpointercapture={() => finish()}
    onDblClick={() => { if (!sizing.disabled()) { finish(); sizing.setWidth(sizing.min()); sizing.commit() } }}
    onKeyDown={event => {
      if (sizing.disabled()) return
      if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return }
      const step = event.shiftKey ? 24 : 8
      const width = sizing.width()
      const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' || event.key === 'Enter' ? sizing.min() : event.key === 'End' ? sizing.max() : null
      if (next !== null) { event.preventDefault(); sizing.setWidth(next); sizing.commit() }
    }}
  />
}
