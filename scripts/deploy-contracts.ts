/**
 * Upload the one-way-channel WASM once and deploy the channel factory once.
 *
 * There is no canonical deployment of these contracts upstream (no releases, no tags,
 * no published WASM hash), so we build from source and pin the resulting hash in .env.
 *
 * Requires a funded Stellar testnet account. Writes CHANNEL_WASM_HASH and
 * CHANNEL_FACTORY_C back into .env.
 *
 * Run: npm run channels:deploy
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ENV_PATH = resolve(ROOT, '.env')
const CHANNEL_WASM = resolve(ROOT, 'contracts/channel.wasm')
const FACTORY_WASM = resolve(ROOT, 'contracts/channel_factory.wasm')

function die(message: string): never {
  console.error(`\nERROR: ${message}\n`)
  process.exit(1)
}

function step(message: string): void {
  console.log(`\n==> ${message}`)
}

function sh(args: string[]): string {
  return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function setEnvValue(key: string, value: string): void {
  if (!existsSync(ENV_PATH)) die('.env not found. Copy .env.example to .env and fill it in.')
  const current = readFileSync(ENV_PATH, 'utf8')
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  const next = pattern.test(current) ? current.replace(pattern, line) : `${current.trimEnd()}\n${line}\n`
  writeFileSync(ENV_PATH, next)
  console.log(`   .env  ${key}=${value}`)
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

step('Preflight')
for (const file of [CHANNEL_WASM, FACTORY_WASM]) {
  if (!existsSync(file)) die(`${file} missing. Run: bash scripts/build-contracts.sh --build`)
  console.log(`   ok  ${file.replace(`${ROOT}/`, '')}  ${readFileSync(file).length} bytes`)
}
try {
  sh(['--version'])
} catch {
  die('stellar CLI not found. Install: cargo install stellar-cli')
}

const env = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {}
const deploySecret = env.STELLAR_DEPLOY_SECRET ?? env.FEE_PAYER_SECRET
const admin = env.CHANNEL_FACTORY_ADMIN_G ?? env.PROVIDER_RECIPIENT_G
const network = env.STELLAR_NETWORK === 'stellar:pubnet' ? 'pubnet' : 'testnet'

if (!deploySecret) die('Set STELLAR_DEPLOY_SECRET (or FEE_PAYER_SECRET) in .env to a funded testnet key.')
if (!admin) die('Set CHANNEL_FACTORY_ADMIN_G (or PROVIDER_RECIPIENT_G) in .env.')

console.log(`   network: ${network}`)
console.log(`   admin:   ${admin}`)

// Give the CLI the key without putting it on a command line that shows up in `ps`.
const keyFile = resolve(ROOT, 'data/.deploy-key.tmp')
const { mkdirSync, rmSync } = await import('node:fs')
mkdirSync(resolve(ROOT, 'data'), { recursive: true })
writeFileSync(keyFile, deploySecret, { mode: 0o600 })

function stellar(args: string[]): string {
  // --source accepts "path/to/keyfile". Key never appears in argv.
  return sh([...args, '--source', keyFile, '--network', network])
}

try {
  step('Uploading channel.wasm (one time, hash is pinned)')
  const uploadOut = stellar(['contract', 'upload', '--wasm', CHANNEL_WASM])
  const hash = uploadOut.match(/\b[0-9a-f]{64}\b/)?.[0]
  if (!hash) die(`could not parse a WASM hash from:\n${uploadOut}`)
  console.log(`   CHANNEL_WASM_HASH=${hash}`)
  setEnvValue('CHANNEL_WASM_HASH', hash)

  step('Deploying channel-factory')
  console.log('   constructor(admin, channelWasmHash)')
  const deployOut = stellar([
    'contract', 'deploy',
    '--wasm', FACTORY_WASM,
    '--arg', `admin:${admin}`,
    '--arg', `wasm_hash:${Buffer.from(hash, 'hex').toString('hex')}`,
  ])
  const factory = deployOut.match(/\bC[A-Z2-7]{55}\b/)?.[0]
  if (!factory) die(`could not parse a contract id from:\n${deployOut}`)
  console.log(`   CHANNEL_FACTORY_C=${factory}`)
  setEnvValue('CHANNEL_FACTORY_C', factory)

  step('Verifying factory state on chain')
  const adminOut = sh(['contract', 'invoke', '--id', factory, '--fn', 'admin', '--network', network])
  const wasmOut = sh([
    'contract', 'invoke', '--id', factory, '--fn', 'wasm_hash', '--network', network,
    '--output', 'json',
  ])
  const onChainAdmin = adminOut.match(/\bG[A-Z2-7]{55}\b/)?.[0]
  const onChainWasm = wasmOut.match(/\b[0-9a-f]{64}\b/)?.[0]
  console.log(`   admin()        = ${onChainAdmin ?? '(unparsed)'}`)
  console.log(`   wasm_hash()    = ${onChainWasm ?? '(unparsed)'}`)
  if (onChainAdmin && onChainAdmin !== admin) die(`factory admin mismatch: expected ${admin}, chain says ${onChainAdmin}`)
  if (onChainWasm && onChainWasm !== hash) die(`factory wasm_hash mismatch: expected ${hash}, chain says ${onChainWasm}`)

  step('Done')
  console.log(`   Channel factory: ${factory}`)
  console.log(`   Channel WASM:    ${hash}`)
  console.log('\n   Set AGENT_COMMITMENT_SEED (64-hex raw ed25519 seed) to open sessions.')
} finally {
  rmSync(keyFile, { force: true })
}