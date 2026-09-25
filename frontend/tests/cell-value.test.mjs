import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/data-grid/cellValue.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { cellText, jsonText, editedValue } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
)

test('non-finite database numbers display as scalars, not JSON objects', () => {
  for (const value of ['+Inf', '-Inf', 'NaN']) {
    const wire = { type: 'float64', value }
    assert.equal(cellText(wire), value)
    assert.equal(jsonText(wire), null)
    assert.deepEqual(editedValue(cellText(wire), wire), wire)
  }
})

test('editing numeric cells never sends native non-finite numbers through JSON', () => {
  for (const [text, expected] of [
    ['+Inf', '+Inf'],
    ['Infinity', '+Inf'],
    ['-Inf', '-Inf'],
    ['-Infinity', '-Inf'],
    ['NaN', 'NaN'],
    ['1e999', '+Inf'],
  ]) {
    for (const original of [1.5, { type: 'float64', value: '+Inf' }]) {
      const result = editedValue(text, original)
      assert.deepEqual(JSON.parse(JSON.stringify(result)), { type: 'float64', value: expected })
    }
  }
  assert.equal(editedValue('2.5', { type: 'float64', value: 'NaN' }), 2.5)
  assert.equal(editedValue('NULL', { type: 'float64', value: '+Inf' }), null)
})

test('ordinary text, JSON and lossless integer behavior remains intact', () => {
  assert.equal(editedValue('+Inf', 'text'), '+Inf')
  assert.equal(jsonText('+Inf'), null)
  assert.equal(jsonText({ answer: 42 }), '{\n  "answer": 42\n}')
  const integer = { type: 'int64', value: '9223372036854775807' }
  assert.equal(cellText(integer), integer.value)
  assert.equal(jsonText(integer), null)
  assert.deepEqual(editedValue('9223372036854775806', integer), { type: 'int64', value: '9223372036854775806' })
})
