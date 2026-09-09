import { createSignal, onCleanup, onMount, createEffect, type JSX } from 'solid-js'
import { ChevronLeft, ChevronRight } from './icons'

export default function TabStrip(props: { activeTab: string; children: JSX.Element }) {
  let viewport!: HTMLDivElement
  let content!: HTMLDivElement
  const [edges, setEdges] = createSignal({ left: false, right: false })

  function revealActiveTab() {
    const active = content?.querySelector<HTMLElement>('[data-active="true"]')
    if (!viewport || !active) return
    const bounds = viewport.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    if (tab.left < bounds.left) viewport.scrollLeft += tab.left - bounds.left
    else if (tab.right > bounds.right) viewport.scrollLeft += tab.right - bounds.right
  }

  onMount(() => {
    const updateEdges = () => {
      const left = viewport.scrollLeft > 1
      const right = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1
      setEdges(current => current.left === left && current.right === right ? current : { left, right })
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || viewport.scrollWidth <= viewport.clientWidth) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? viewport.clientWidth : 1
      viewport.scrollLeft += delta * scale
    }
    const resize = new ResizeObserver(() => { revealActiveTab(); updateEdges() })
    resize.observe(viewport)
    resize.observe(content)
    viewport.addEventListener('scroll', updateEdges)
    viewport.addEventListener('wheel', wheel, { passive: false })
    updateEdges()
    onCleanup(() => {
      resize.disconnect()
      viewport.removeEventListener('scroll', updateEdges)
      viewport.removeEventListener('wheel', wheel)
    })
  })

  createEffect(() => {
    props.activeTab
    revealActiveTab()
  })

  function scroll(direction: -1 | 1) {
    if (!viewport) return
    viewport.scrollBy({ left: direction * Math.max(160, viewport.clientWidth * 0.75), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  const overflowing = () => edges().left || edges().right
  return <div class="tab-strip">
    {overflowing() && <button class="icon-button tab-scroll-button" aria-label="Scroll tabs left" title="Scroll tabs left" disabled={!edges().left} onClick={() => scroll(-1)}><ChevronLeft size={15}/></button>}
    <div class="tabs-scroll" ref={viewport}>
      <div class="tabs-content" ref={content}>{props.children}</div>
    </div>
    {overflowing() && <button class="icon-button tab-scroll-button" aria-label="Scroll tabs right" title="Scroll tabs right" disabled={!edges().right} onClick={() => scroll(1)}><ChevronRight size={15}/></button>}
  </div>
}
