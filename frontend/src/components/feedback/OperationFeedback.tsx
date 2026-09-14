import { createEffect, createSignal, on, onCleanup } from 'solid-js'
import { Alert, Check, Save, Trash, X } from '../ui/icons'

export function DangerConfirmModal(props: {
  title: string
  message: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div class="modal-backdrop transfer-backdrop">
      <section class="danger-confirm-modal" role="alertdialog" aria-modal="true">
        <div class="danger-confirm-icon">
          <Trash size={21} />
        </div>
        <h3>{props.title}</h3>
        <p>{props.message}</p>
        <footer>
          <button class="secondary" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </button>
          <button class="danger-button" disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? 'Working…' : 'Truncate'}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function OperationToast(props: { message: string; onClose: () => void }) {
  createEffect(
    on(
      () => props.message,
      () => {
        const timer = window.setTimeout(props.onClose, 7000)
        onCleanup(() => window.clearTimeout(timer))
      },
    ),
  )
  return (
    <div class="operation-toast" role="status">
      <Check size={16} />
      <span>{props.message}</span>
      <button onClick={props.onClose} aria-label="Dismiss notification">
        <X size={13} />
      </button>
    </div>
  )
}

export function UnsavedModal(props: {
  title: string
  message: string
  count: number
  onCancel: () => void
  onDiscard: () => Promise<void>
  onSave: () => Promise<void>
}) {
  const [busy, setBusy] = createSignal(false)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="modal-backdrop unsaved-backdrop">
      <section class="unsaved-modal" role="alertdialog" aria-modal="true">
        <div class="unsaved-icon">
          <Alert size={21} />
        </div>
        <h3>{props.title}</h3>
        <p>{props.message}</p>
        <div class="pending-summary">
          <span>{props.count}</span> pending change{props.count === 1 ? '' : 's'}
        </div>
        <footer class="unsaved-actions">
          <button class="secondary" disabled={busy()} onClick={props.onCancel}>
            Cancel
          </button>
          <button class="discard-button" disabled={busy()} onClick={() => void run(props.onDiscard)}>
            Discard
          </button>
          <button class="primary" disabled={busy()} onClick={() => void run(props.onSave)}>
            <Save size={14} /> Save
          </button>
        </footer>
      </section>
    </div>
  )
}
