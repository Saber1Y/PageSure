/** Non-secret operator readiness report. It never prints env values, account balances, or keys. */
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { Horizon, Keypair, StrKey } from '@stellar/stellar-sdk'
import { db, closeDatabase } from '../src/lib/db/client'
import * as schema from '../src/lib/db/schema'

type Result = { name: string; ok: boolean; detail: string }
const results: Result[] = []
const report = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail })
const secret = (name: string) => (process.env[name] ?? '').trim()
const network = process.env.STELLAR_NETWORK ?? 'stellar:testnet'

async function main() {
  let databaseReady = false
  try {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries?: unknown[] }
    const applied = db().$client.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number }
    report('database migrations', applied.count === (journal.entries?.length ?? -1), `${applied.count}/${journal.entries?.length ?? 0} applied`)
    const fk = db().$client.pragma('foreign_key_check') as unknown[]
    report('database foreign keys', fk.length === 0, fk.length === 0 ? 'integrity clean' : `${fk.length} violation(s)`)
    databaseReady = true
  } catch {
    report('database migrations', false, 'database or migration metadata unavailable')
  }

  const services = databaseReady
    ? db().select().from(schema.services).all().filter((s) => s.status === 'live')
    : []
  if (!databaseReady) report('service bindings', false, 'skipped because database schema is unavailable')
  if (services.length === 0) report('live service bindings', false, 'no live services')
  for (const service of services) {
    const policy = service.policyId
      ? db().select().from(schema.policies).where(eq(schema.policies.id, service.policyId)).get()
      : null
    const policyOk = Boolean(policy?.active && policy.organizationId === service.organizationId)
    report(`service ${service.slug} policy`, policyOk, policyOk ? 'active and tenant-bound' : 'missing, inactive, or tenant mismatch')

    const org = db().select().from(schema.organizations).where(eq(schema.organizations.id, service.organizationId)).get()
    report(`service ${service.slug} treasury`, Boolean(org?.treasuryVerified && org.settlementRecipient), org?.treasuryVerified && org.settlementRecipient ? 'verified recipient configured' : 'treasury not verified')

    let upstreamReady = false
    if (service.upstreamKind === 'search') upstreamReady = ['BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY'].some((key) => !!secret(key))
    else if (service.upstreamKind === 'market') upstreamReady = true // Public CoinGecko endpoint; API key is optional.
    else if (service.upstreamKind === 'summarize') upstreamReady = !!secret('LLM_BASE_URL') && !!secret('LLM_API_KEY') && !!secret('LLM_MODEL')
    report(`service ${service.slug} upstream`, upstreamReady, upstreamReady ? 'required configuration present' : 'required credentials/configuration missing or upstream kind unknown')
  }

  const feeSecret = secret('FEE_PAYER_SECRET')
  let feeKey: Keypair | null = null
  try { if (StrKey.isValidEd25519SecretSeed(feeSecret)) feeKey = Keypair.fromSecret(feeSecret) } catch { /* report below */ }
  report('fee payer key', !!feeKey, feeKey ? 'valid key configured' : 'missing or invalid')
  const horizonUrl = process.env.STELLAR_HORIZON_URL ?? ''
  if (feeKey && horizonUrl) {
    try {
      const account = await new Horizon.Server(horizonUrl).accounts().accountId(feeKey.publicKey()).call()
      const xlm = account.balances.find((b) => b.asset_type === 'native')
      const enough = !!xlm && Number(xlm.balance) > 0.5
      report('fee payer funds', enough, enough ? 'Testnet account funded' : 'account missing or below 0.5 XLM reserve threshold')
    } catch { report('fee payer funds', false, 'account unavailable from configured Horizon endpoint') }
  } else report('fee payer funds', false, 'fee payer or Horizon endpoint unavailable')

  const payerSecret = secret('DEMO_PAYER_SECRET')
  const declaredPayer = secret('DEMO_PAYER_G')
  let payerOk = false
  try { payerOk = StrKey.isValidEd25519SecretSeed(payerSecret) && Keypair.fromSecret(payerSecret).publicKey() === declaredPayer } catch { /* report below */ }
  report('demo payer input', payerOk, payerOk ? 'secret matches declared public key' : 'missing, invalid, or public key mismatch')

  const factory = secret('CHANNEL_FACTORY_C')
  report('channel factory', StrKey.isValidContract(factory), StrKey.isValidContract(factory) ? 'contract id configured' : 'missing or invalid contract id')
  const channelServices = services.filter((s) => s.mode === 'channel')
  if (channelServices.length === 0) report('channel signer', true, 'no live channel services')
  for (const service of channelServices) {
    const org = db().select().from(schema.organizations).where(eq(schema.organizations.id, service.organizationId)).get()
    const url = org?.commitmentSignerUrl ?? ''
    const token = org?.commitmentSignerTokenEnv ? secret(org.commitmentSignerTokenEnv) : ''
    if (!url || !token) {
      report(`service ${service.slug} signer`, false, 'signer URL or token is not configured')
      continue
    }
    try {
      const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(4000) })
      report(`service ${service.slug} signer`, response.ok, response.ok ? 'healthy' : `health returned HTTP ${response.status}`)
    } catch { report(`service ${service.slug} signer`, false, 'configured but unreachable') }
  }

  report('network guard', network === 'stellar:testnet', network === 'stellar:testnet' ? 'Testnet' : 'not Testnet')
  for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}`)
  const failed = results.filter((item) => !item.ok).length
  console.log(`\nReadiness: ${results.length - failed}/${results.length} checks passed`)
  if (failed) process.exitCode = 1
}

try { await main() } finally { closeDatabase() }
