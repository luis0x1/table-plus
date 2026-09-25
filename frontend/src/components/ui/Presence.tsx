import { Show, type Accessor, type JSX } from 'solid-js'
import usePresence, { EXIT_DURATION } from '../../lib/usePresence'

export default function Presence<T>(props: {
  when: T | undefined | null | false
  children: JSX.Element | ((value: Accessor<NonNullable<T>>) => JSX.Element)
}) {
  const presence = usePresence(() => props.when)
  return (
    <Show when={presence.value()}>
      {(value) => {
        const content = props.children
        return (
          <div
            class="presence"
            inert={presence.exiting()}
            aria-hidden={presence.exiting() ? true : undefined}
            style={{ '--presence-duration': `${EXIT_DURATION}ms` }}
          >
            {typeof content === 'function' ? content(value as Accessor<NonNullable<T>>) : content}
          </div>
        )
      }}
    </Show>
  )
}
