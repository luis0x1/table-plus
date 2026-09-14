import { createEffect, createSignal, createUniqueId, Index, onCleanup, onMount, Show } from 'solid-js'
import { X } from '../ui/icons'

const QUICK_PAGE_ITEM_WIDTH = 70

export default function QuickPagePicker(props: {
  currentPage: number
  totalPages: number
  onSelect: (page: number) => void
}) {
  const [open, setOpen] = createSignal(false)
  let root!: HTMLDivElement

  createEffect(() => {
    if (!open()) return
    const close = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) setOpen(false)
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keyboard)
    onCleanup(() => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keyboard)
    })
  })

  return (
    <div ref={root} class="quick-page-picker">
      <button
        class="quick-page-trigger"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        Page {props.currentPage} of {props.totalPages}
      </button>
      <Show when={open()}>
        <QuickPagePopover
          currentPage={props.currentPage}
          totalPages={props.totalPages}
          onClose={() => setOpen(false)}
          onSelect={(page) => {
            setOpen(false)
            if (page !== props.currentPage) props.onSelect(page)
          }}
        />
      </Show>
    </div>
  )
}

function QuickPagePopover(props: {
  currentPage: number
  totalPages: number
  onClose: () => void
  onSelect: (page: number) => void
}) {
  // The virtual geometry is fixed for the lifetime of an open popover.
  const totalPages = props.totalPages
  const visibleCount = Math.min(5, totalPages)
  const [value, setValue] = createSignal(String(props.currentPage))
  const [message, setMessage] = createSignal('')
  const maxStart = Math.max(0, totalPages - visibleCount)
  const initialStart = Math.min(maxStart, Math.max(0, props.currentPage - 1 - Math.floor(visibleCount / 2)))
  const [windowStart, setWindowStart] = createSignal(initialStart)
  let input!: HTMLInputElement
  let scroller!: HTMLDivElement
  const inputID = createUniqueId()
  const viewportWidth = visibleCount * QUICK_PAGE_ITEM_WIDTH
  const virtualWidth = totalPages * QUICK_PAGE_ITEM_WIDTH
  const maxScroll = Math.max(0, virtualWidth - viewportWidth)
  const scrollForStart = (start: number) => (maxStart ? (start / maxStart) * maxScroll : 0)

  onMount(() => {
    input?.focus()
    input?.select()
    if (scroller) scroller.scrollLeft = scrollForStart(initialStart)
  })

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const page = Number(value())
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      setMessage(`Enter a whole number from 1 to ${totalPages.toLocaleString()}.`)
      input?.select()
      return
    }
    props.onSelect(page)
  }

  function moveWindow(next: number) {
    const start = Math.min(maxStart, Math.max(0, next))
    setWindowStart(start)
    if (scroller) scroller.scrollLeft = scrollForStart(start)
  }

  const renderedStart = () => Math.max(0, windowStart() - 1)
  const renderedEnd = () => Math.min(totalPages, windowStart() + visibleCount + 1)
  const renderedCount = () => renderedEnd() - renderedStart()
  const itemsOffset = () =>
    Math.min(
      virtualWidth - renderedCount() * QUICK_PAGE_ITEM_WIDTH,
      Math.max(0, scrollForStart(windowStart()) - (windowStart() - renderedStart()) * QUICK_PAGE_ITEM_WIDTH),
    )
  const pages = () => Array.from({ length: renderedCount() }, (_, index) => renderedStart() + index + 1)
  return (
    <section class="quick-page-popover" role="dialog" aria-label="Go to page">
      <header>
        <div>
          <b>Go to page</b>
          <span>{totalPages.toLocaleString()} pages available</span>
        </div>
        <button class="icon-button" onClick={props.onClose} aria-label="Close page picker">
          <X size={14} />
        </button>
      </header>
      <form onSubmit={submit}>
        <label for={inputID}>Page number</label>
        <div class="quick-page-input">
          <input
            ref={input}
            id={inputID}
            inputmode="numeric"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            value={value()}
            aria-invalid={Boolean(message())}
            onInput={(event) => {
              setValue(event.currentTarget.value)
              setMessage('')
            }}
          />
          <button class="primary" type="submit">
            Go
          </button>
        </div>
        <Show when={message()}>
          <p class="quick-page-error" role="alert">
            {message()}
          </p>
        </Show>
      </form>
      <div class="quick-page-heading">
        <span>Pages</span>
        <small>Page 1 — {totalPages.toLocaleString()}</small>
      </div>
      <div
        ref={scroller}
        class="quick-page-window"
        style={{ width: `${viewportWidth}px` }}
        tabIndex={maxStart ? 0 : -1}
        aria-label="Nearby pages"
        onScroll={(event) => {
          if (!maxScroll) return
          setWindowStart(
            Math.min(maxStart, Math.max(0, Math.round((event.currentTarget.scrollLeft / maxScroll) * maxStart))),
          )
        }}
        onWheel={(event) => {
          if (!maxStart) return
          event.preventDefault()
          const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
          moveWindow(windowStart() + Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 40)))
        }}
        onKeyDown={(event) => {
          const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
          if (!maxStart || !direction) return
          event.preventDefault()
          moveWindow(windowStart() + direction)
        }}
      >
        <div class="quick-page-track" style={{ width: `${virtualWidth}px` }}>
          <div class="quick-page-items" style={{ transform: `translateX(${itemsOffset()}px)` }}>
            <Index each={pages()}>
              {(page) => (
                <span class="quick-page-cell">
                  <button
                    type="button"
                    title={`Page ${page().toLocaleString()}`}
                    class={page() === props.currentPage ? 'active' : ''}
                    aria-current={page() === props.currentPage ? 'page' : undefined}
                    onClick={() => props.onSelect(page())}
                  >
                    {page().toLocaleString()}
                  </button>
                </span>
              )}
            </Index>
          </div>
        </div>
      </div>
    </section>
  )
}
