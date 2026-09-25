import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js'

export const EXIT_DURATION = 140

// Keep the last truthy value so nullable modal props remain valid during exit.
// Reopening cancels the pending removal; disposing the owner releases the timer.
export default function usePresence<T>(when: Accessor<T>) {
  const [value, setValue] = createSignal<T | undefined>(when())
  createEffect(
    on(when, (next) => {
      if (next) {
        setValue(() => next)
        return
      }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setValue(undefined)
        return
      }
      const timer = setTimeout(() => setValue(undefined), EXIT_DURATION)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  return { value, exiting: () => !when() }
}
