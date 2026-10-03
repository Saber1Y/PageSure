/**
 * Base-unit string arithmetic.
 *
 * MPP sends and expects amounts as decimal STRINGS of base units. SQLite has no
 * arbitrary-precision integer type that survives 64-bit cleanly at USDC scale
 * multiplied by request counts, so all money maths in PageSure is done on bigint.
 * Floating point is never used for money.
 */

/** Parse a base-unit string to bigint, rejecting anything non-integral. */
export function toBig(base: string | number | bigint): bigint {
  if (typeof base === 'bigint') return base
  const s = String(base).trim()
  if (!/^-?\d+$/.test(s)) throw new Error(`not an integer base-unit value: ${JSON.stringify(base)}`)
  return BigInt(s)
}

/** Format a bigint back to a base-unit string. */
export function fromBig(value: bigint): string {
  return value.toString(10)
}

/** Human display amount, e.g. 100000n with 7 decimals -> '0.01'. */
export function formatAmount(base: string | bigint, decimals: number): string {
  const value = toBig(base)
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals) || '0'
  const frac = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : ''
  return `${negative ? '-' : ''}${whole}${frac}`
}

/** Parse a human amount like '0.01' into base units. */
export function parseAmount(human: string, decimals: number): string {
  const s = human.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${JSON.stringify(human)}`)
  const [whole = '0', frac = ''] = s.split('.')
  if (frac.length > decimals) {
    throw new Error(`amount ${human} has more than ${decimals} decimal places`)
  }
  return fromBig(toBig(whole + frac.padEnd(decimals, '0')))
}

/** Sum of base-unit strings. */
export function sumBase(values: Array<string | bigint>): string {
  return fromBig(values.reduce<bigint>((acc, v) => acc + toBig(v), 0n))
}

/** True when `value` exceeds `limit`. Either may be null meaning 'no limit'. */
export function exceeds(value: string | bigint, limit: string | null | undefined): boolean {
  if (limit === null || limit === undefined || limit === '') return false
  return toBig(value) > toBig(limit)
}