/**
 * Generate the Stellar testnet keypairs PageSure needs.
 *
 * Prints secrets to stdout and appends them to .env. NEVER commits .env.
 * Account creation and funding are deliberately NOT automated here: testnet XLM
 * comes from friendbot and testnet USDC requires the Circle faucet, which has no
 * public API. Fund the printed public keys manually, then create the USDC SAC
 * trustline.
 *
 * Run: npm run keys:generate
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ENV_PATH = resolve(ROOT, '.env')

if (!existsSync(ENV_PATH)) {
  writeFileSync(ENV_PATH, readFileSync(resolve(ROOT, '.env.example'), 'utf8'))
  console.log('Created .env from .env.example\n')
}

let current = readFileSync(ENV_PATH, 'utf8')

function put(key: string, value: string): void {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  current = pattern.test(current) ? current.replace(pattern, line) : `${current.trimEnd()}\n${line}\n`
}

const rows: Array<{ label: string; publicKey: string; secret: string }> = []

// Keypair.random() for accounts; a raw 32-byte seed for the commitment key.
const provider = Keypair.random()
const feePayer = Keypair.random()
const demoPayer = Keypair.random()

// The commitment key is a RAW 32-byte ed25519 seed, NOT an S... Stellar secret.
const commitmentSeed = randomBytes(32).toString('hex')

put('PROVIDER_RECIPIENT_G', provider.publicKey())
put('PROVIDER_RECIPIENT_SECRET', provider.secret())
put('FEE_PAYER_G', feePayer.publicKey())
put('FEE_PAYER_SECRET', feePayer.secret())
put('DEMO_PAYER_G', demoPayer.publicKey())
put('DEMO_PAYER_SECRET', demoPayer.secret())
put('AGENT_COMMITMENT_SEED', commitmentSeed)
put('SESSION_SECRET', randomBytes(32).toString('base64url'))
put('MPP_SECRET_KEY', randomBytes(32).toString('base64url'))
put('STELLAR_DEPLOY_SECRET', feePayer.secret())

writeFileSync(ENV_PATH, current, { mode: 0o600 })

rows.push(
  { label: 'provider / recipient', publicKey: provider.publicKey(), secret: provider.secret() },
  { label: 'fee payer', publicKey: feePayer.publicKey(), secret: feePayer.secret() },
  { label: 'demo agent payer', publicKey: demoPayer.publicKey(), secret: demoPayer.secret() },
)

console.log('Generated keypairs (written to .env, mode 0600)\n')
for (const r of rows) {
  console.log(`  ${r.label}`)
  console.log(`    public  ${r.publicKey}   (valid: ${StrKey.isValidEd25519PublicKey(r.publicKey)})`)
  console.log(`    secret  ${r.secret.slice(0, 6)}…${r.secret.slice(-4)}`)
}
console.log(`\n  agent commitment seed  ${commitmentSeed.slice(0, 8)}… (raw 64-hex ed25519)`)

console.log(`
------------------------------------------------------------------------
FUND THESE ON STELLAR TESTNET (manual, no public faucet API):

  1. XLM for fees, all three accounts, via Friendbot:
       https://lab.stellar.org/account/fund?account=<PUBLIC_KEY>&key=Test%20Network%3B%20September%202015
     or POST https://friendbot.stellar.org/?addr=<PUBLIC_KEY>

  2. USDC trustline on the demo payer and the provider account:
       https://lab.stellar.org/account/fund  (Create a trustline button)

  3. USDC balance on the demo payer, from the Circle faucet:
       https://faucet.circle.com  -> select "Stellar Testnet"

  4. Then:  npm run channels:deploy
------------------------------------------------------------------------
`)