import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { default as usePresence, EXIT_DURATION } from './src/lib/usePresence.ts'",
      "export { createRoot, createSignal } from 'solid-js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
})
const { usePresence, EXIT_DURATION, createRoot, createSignal } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
)

function setup(t, initial, reducedMotion = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previousWindow = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: reducedMotion }) }
  let state
  createRoot((dispose) => {
    const [open, setOpen] = createSignal(initial)
    state = { ...usePresence(open), setOpen, dispose }
  })
  t.after(() => {
    state.dispose()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  return state
}

test('close retains nullable modal data until the exit finishes', (t) => {
  const dialog = { title: 'Discard changes?' }
  const state = setup(t, dialog)
  state.setOpen(null)
  assert.equal(state.exiting(), true)
  assert.equal(state.value(), dialog)
  t.mock.timers.tick(EXIT_DURATION - 1)
  assert.equal(state.value(), dialog)
  t.mock.timers.tick(1)
  assert.equal(state.value(), undefined)
})

test('reopening during exit cancels the old removal and uses the latest data', (t) => {
  const state = setup(t, { title: 'First' })
  state.setOpen(null)
  t.mock.timers.tick(EXIT_DURATION / 2)
  const replacement = { title: 'Second' }
  state.setOpen(replacement)
  t.mock.timers.tick(EXIT_DURATION)
  assert.equal(state.value(), replacement)
  assert.equal(state.exiting(), false)
  state.setOpen(null)
  t.mock.timers.tick(EXIT_DURATION)
  assert.equal(state.value(), undefined)
})

test('opening from initially closed is not removed by an old timer', (t) => {
  const state = setup(t, false)
  state.setOpen(true)
  t.mock.timers.tick(EXIT_DURATION * 2)
  assert.equal(state.value(), true)
  assert.equal(state.exiting(), false)
})

test('changes while open update the retained payload', (t) => {
  const state = setup(t, { name: 'before' })
  const updated = { name: 'after' }
  state.setOpen(updated)
  state.setOpen(null)
  assert.equal(state.value(), updated)
})

test('reduced motion removes closed overlays immediately', (t) => {
  const state = setup(t, true, true)
  state.setOpen(false)
  assert.equal(state.value(), undefined)
})

test('disposing the owner cancels pending exit work', (t) => {
  const state = setup(t, true)
  state.setOpen(false)
  state.dispose()
  t.mock.timers.tick(EXIT_DURATION * 2)
  assert.equal(state.value(), true)
})
