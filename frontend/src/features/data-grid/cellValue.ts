import type { WireInt64, WireFloat64, WireNumber } from '../../types'

export function isWireNumber(value: unknown): value is WireNumber {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<WireNumber>).value === 'string' &&
    ((value as Partial<WireNumber>).type === 'int64' ||
      ((value as Partial<WireNumber>).type === 'float64' &&
        ['+Inf', '-Inf', 'NaN'].includes((value as WireNumber).value)))
  )
}

export function cellText(value: unknown): string {
  return isWireNumber(value) ? value.value : String(value ?? '')
}

export function jsonText(value: unknown): string | null {
  if (isWireNumber(value)) return null
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

export function editedValue(text: string, original: unknown): unknown {
  if (text.trim().toLowerCase() === 'null') return null
  if (isWireNumber(original) && original.type === 'int64' && /^-?\d+$/.test(text.trim())) {
    return { type: 'int64', value: text.trim() } satisfies WireInt64
  }
  if (typeof original === 'number' || (isWireNumber(original) && original.type === 'float64')) {
    const trimmed = text.trim()
    if (trimmed === 'NaN') return { type: 'float64', value: 'NaN' } satisfies WireFloat64
    const number = trimmed === '+Inf' || trimmed === 'Inf' ? Infinity : trimmed === '-Inf' ? -Infinity : Number(text)
    if (number === Infinity) return { type: 'float64', value: '+Inf' } satisfies WireFloat64
    if (number === -Infinity) return { type: 'float64', value: '-Inf' } satisfies WireFloat64
    return Number.isNaN(number) ? text : number
  }
  if (typeof original === 'boolean') return text.toLowerCase() === 'true'
  return text
}
