import { useEffect, useRef, useState } from 'react'
import type { SidebarPreferences } from './types'
import type useSidebarPreferences from './useSidebarPreferences'

export function useCompactSidebar() {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1100px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)')
    const change = () => setCompact(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return compact
}

export function useSidebarWidth(key: keyof SidebarPreferences, min: number, preferences: ReturnType<typeof useSidebarPreferences>) {
  return {
    width: Math.round(min * preferences.values[key]), min, max: min * 2,
    setWidth: (width: number) => preferences.setScale(key, width / min),
    commit: preferences.commit, disabled: !preferences.ready,
  }
}

export type SidebarSizing = ReturnType<typeof useSidebarWidth>

export default function SidebarResizeHandle({ label, sizing }: { label: string; sizing: SidebarSizing }) {
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const { width, min, max, setWidth, commit, disabled } = sizing

  function finish(cancel = false) {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (cancel) setWidth(current.width)
    if (handleRef.current?.hasPointerCapture(current.pointer)) handleRef.current.releasePointerCapture(current.pointer)
    document.documentElement.classList.remove('resizing-sidebar')
    setDragging(false)
    commit()
  }

  useEffect(() => () => { if (drag.current) document.documentElement.classList.remove('resizing-sidebar') }, [])

  return <div ref={handleRef} className={`sidebar-resize-handle ${dragging ? 'dragging' : ''}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} title="Drag to resize · Double-click to reset"
    onPointerDown={event => {
      if (disabled || event.button !== 0 || drag.current) return
      event.preventDefault(); event.stopPropagation()
      event.currentTarget.focus()
      drag.current = { x: event.clientX, width, pointer: event.pointerId }
      event.currentTarget.setPointerCapture(event.pointerId)
      document.documentElement.classList.add('resizing-sidebar')
      setDragging(true)
    }}
    onPointerMove={event => {
      if (drag.current?.pointer === event.pointerId) setWidth(drag.current.width + event.clientX - drag.current.x)
    }}
    onPointerUp={() => finish()}
    onPointerCancel={() => finish(true)}
    onLostPointerCapture={() => finish()}
    onDoubleClick={() => { if (!disabled) { finish(); setWidth(min); commit() } }}
    onKeyDown={event => {
      if (disabled) return
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(true); return }
      const step = event.shiftKey ? 24 : 8
      const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' || event.key === 'Enter' ? min : event.key === 'End' ? max : null
      if (next !== null) { event.preventDefault(); setWidth(next); commit() }
    }}
  />
}
