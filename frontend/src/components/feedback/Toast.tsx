import { createEffect, on, onCleanup } from 'solid-js'
import { Alert, X } from '../ui/icons'

export default function Toast(props: { message: string; onClose: () => void }) {
  const clean = () => props.message.replace(/^Error:\s*/i, '')
  createEffect(
    on(clean, () => {
      const timer = window.setTimeout(props.onClose, 12000)
      onCleanup(() => window.clearTimeout(timer))
    }),
  )
  return (
    <div class="toast" role="alert">
      <Alert size={17} />
      <span title={clean()}>{clean()}</span>
      <button onClick={props.onClose} aria-label="Dismiss error">
        <X size={14} />
      </button>
    </div>
  )
}
