/**
 * P0 GATE: verify the INSTALLED @stellar/mpp surface, not the git `main` branch.
 *
 * The published npm tarball of @stellar/mpp and the unreleased `main` branch declare
 * the SAME version (0.7.1) with DIFFERENT peer dependency ranges and, in some cases,
 * different APIs. Everything in this repo must be written against what is actually
 * installed. This script fails loudly if an assumption encoded in the app breaks.
 *
 * Run: npm run mpp:audit
 */
import * as sdk from '@stellar/stellar-sdk'
import * as mpp from '@stellar/mpp'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Every named export @stellar/mpp pulls from @stellar/stellar-sdk in its dist.
const SDK_EXPORTS_REQUIRED_BY_MPP = [
  'Networks',
  'Account',
  'Address',
  'BASE_FEE',
  'FeeBumpTransaction',
  'Keypair',
  'Transaction',
  'TransactionBuilder',
  'rpc',
  'xdr',
  'Contract',
  'authorizeEntry',
  'nativeToScVal',
  'StrKey',
  'hash',
  'scValToNative',
] as const

const MPP_EXPORTS_REQUIRED = ['USDC_SAC_TESTNET', 'toBaseUnits', 'fromBaseUnits'] as const

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

function section(name: string): void {
  console.log(`\n== ${name}`)
}

section('installed versions')
const pkg = (id: string): string =>
  // Some packages do not expose ./package.json via "exports"; read it from disk.
  JSON.parse(
    fs.readFileSync(new URL(`../node_modules/${id}/package.json`, import.meta.url), 'utf8'),
  ).version
console.log(`  @stellar/mpp         ${pkg('@stellar/mpp')}`)
console.log(`  @stellar/stellar-sdk ${pkg('@stellar/stellar-sdk')}`)
console.log(`  mppx                 ${pkg('mppx')}`)
console.log(`  zod                  ${pkg('zod')}`)

section('@stellar/stellar-sdk exports required by @stellar/mpp')
for (const name of SDK_EXPORTS_REQUIRED_BY_MPP) {
  check(name, name in sdk)
}
check('rpc.Server', typeof sdk.rpc?.Server === 'function')
check('rpc.assembleTransaction', typeof sdk.rpc?.assembleTransaction === 'function')
check('Keypair.fromRawEd25519Seed', typeof sdk.Keypair?.fromRawEd25519Seed === 'function')
check(
  'StrKey.encodeEd25519PublicKey',
  typeof sdk.StrKey?.encodeEd25519PublicKey === 'function',
)

section('@stellar/mpp exports')
for (const name of MPP_EXPORTS_REQUIRED) {
  check(name, name in mpp)
}

section('MPP network constants')
const net = (mpp as Record<string, unknown>).STELLAR_TESTNET
check("STELLAR_TESTNET === 'stellar:testnet'", net === 'stellar:testnet', String(net))

section('base-unit conversion round-trip')
// NOTE: in the published 0.7.1 these are STRING in / STRING out (they differ from
// the unreleased `main` branch, which returns bigint). Verified, not assumed.
const toBase = (mpp as Record<string, (v: string, d: number) => string>).toBaseUnits
const fromBase = (mpp as Record<string, (v: string, d: number) => string>).fromBaseUnits
if (typeof toBase === 'function' && typeof fromBase === 'function') {
  check("toBaseUnits('0.01', 7) === '100000'", toBase('0.01', 7) === '100000', toBase('0.01', 7))
  check("toBaseUnits('1', 7) === '10000000'", toBase('1', 7) === '10000000', toBase('1', 7))
  check("fromBaseUnits('100000', 7) === '0.0100000'", fromBase('100000', 7) === '0.0100000')
  check('returns strings, not bigint', typeof toBase('0.01', 7) === 'string')
} else {
  check('toBaseUnits/fromBaseUnits callable', false)
}

section('EVM-only code paths are NOT reachable from the stellar method')
// The mppx gas-draining advisories (GHSA-vc9j-9wph-qghj, GHSA-727h-3vm5-qwq6) live
// in mppx/dist/tempo/** (the EVM method). @stellar/mpp must never reference them.
const stellarDist = path.join(process.cwd(), 'node_modules/@stellar/mpp/dist')
let evmLeaks = 0
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) {
      const src = fs.readFileSync(full, 'utf8')
      if (/access_list|accessList|decodeFunctionData|\bviem\b/.test(src)) {
        console.log(`  LEAK  ${path.relative(process.cwd(), full)}`)
        evmLeaks++
      }
    }
  }
}
walk(stellarDist)
check('no EVM helpers referenced in @stellar/mpp/dist', evmLeaks === 0, `${evmLeaks} file(s)`)

section('result')
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED — do not build against this tree.`)
  process.exit(1)
}
console.log('\nAll installed-surface checks passed.')