import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing with node:crypto scrypt. No extra dependency.
 *
 * Parameters: N=16384 (CPU/memory cost), r=8, p=1, 32-byte salt, 64-byte key.
 * Stored as `scrypt$N$r$p$saltHex$keyHex` so the parameters travel with the hash
 * and can be raised later without invalidating existing rows.
 */

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64
const SALT_BYTES = 32

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const key = scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('hex'), key.toString('hex')].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4]!, 'hex')
    expected = Buffer.from(parts[5]!, 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, { N: n, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}