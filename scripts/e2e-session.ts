/**
 * Live end-to-end proof of PageSure's session (channel) mode on Testnet.
 *
 * Two subcommands:
 *
 *   npm run e2e:session -- prepare
 *     Wire org_demo (settlement recipient, signer URL + token env), create a
 *     channel-mode `market` service, generate + fund the demo treasury, and persist the new
 *     secrets to .env. RESTART the dev server afterwards so it sees the new env.
 *
 *   npm run e2e:session -- run
 *     (default) Spawn the signer service, reserve a session, open + fund + confirm a real
 *     one-way channel as the demo payer, deliver N live requests through the channel, then
 *     settle with the payer's latest signed voucher and the provider treasury account.
 *     Verifies the DB and the treasury balance.
 *
 * The whole point of the file is the "N requests -> 1 transaction" claim: every request is an
 * off-chain commitment signed by the funder's client; only the open (1) and the close (1)
 * transactions touch the chain. The payer commitment seed is never passed to the provider
 * signer process.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import * as schema from '@/lib/db/schema'
import { providerSignerEnvironment } from '../src/lib/mpp/signer-env'
import {
  Keypair,
  StrKey,
  Contract,
  TransactionBuilder,
  Operation,
  Asset,
  nativeToScVal,
  scValToNative,
  rpc,
  Horizon,
} from '@stellar/stellar-sdk'
import { Mppx, channel as clientChannel } from '@stellar/mpp/channel/client'

const ENV_PATH = '.env'
const ENV_KEY = /^([A-Z0-9_]+)=/

const ORIGIN = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORG_ID = process.env.E2E_ORG_ID ?? 'org_demo'
const SLUG = process.env.E2E_SLUG ?? 'channel-demo'
const PRICE_BASE = process.env.E2E_PRICE_BASE ?? '100000'
const FUNDED_BASE = process.env.E2E_FUNDED_BASE ?? '500000'
const REQUESTS = Number(process.env.E2E_REQUESTS ?? 4)
const REFUND_WAIT_SECONDS = Number(process.env.E2E_REFUND_WAIT_SECONDS ?? 120)

const network = process.env.STELLAR_NETWORK ?? 'stellar:testnet'
const rpcUrl = process.env.STELLAR_RPC_URL ?? ''
const horizonUrl = process.env.STELLAR_HORIZON_URL ?? ''
const passphrase = 'Test SDF Network ; September 2015'

const signerPort = Number(process.env.SIGNER_PORT ?? 4457)
const signerHttpUrl = process.env.SIGNER_HTTP_URL ?? `http://127.0.0.1:${signerPort}`
const signerTokenEnvName = process.env.SIGNER_TOKEN_ENV ?? 'PAGESURE_SIGNER_PROOF'
const token = process.env[signerTokenEnvName] ?? process.env.SIGNER_TOKEN ?? ''

const seedHex = process.env.AGENT_COMMITMENT_SEED ?? ''
const payerSecret = process.env.DEMO_PAYER_SECRET ?? ''

function fail(message: string): never {
  throw new Error(`e2e-session: ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

// ---------------------------------------------------------------- env helpers

/** Replace or append KEY=VALUE in .env, preserving ordering and comments. */
function upsertEnv(key: string, value: string): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : []
  const idx = lines.findIndex((l) => ENV_KEY.test(l) && l.startsWith(key + '='))
  const line = `${key}=${value}`
  if (idx >= 0) lines[idx] = line
  else lines.push(line)
  writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8')
  process.env[key] = value
}

// ------------------------------------------------------- account / chain utils

const horizon = horizonUrl ? new Horizon.Server(horizonUrl) : null
const rpcServer = rpcUrl ? new rpc.Server(rpcUrl) : null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fundTestnet(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${address}`)
  if (!res.ok) fail(`friendbot for ${address} returned HTTP ${res.status}`)
}

async function waitAccount(address: string, timeoutMs = 60_000): Promise<void> {
  const at = Date.now()
  while (Date.now() - at < timeoutMs) {
    try {
      const account = await horizon!.accounts().accountId(address).call()
      if (account) return
    } catch {
      await sleep(1500)
    }
  }
  fail(`account ${address} never became reachable`)
}

/**
 * The demo USDC issuer is whatever the payer already holds. Horizon serves several assets
 * coded USDC on testnet, and only one of them is the asset behind the service's SAC - the
 * payer's USDC demonstrably is, because the channel open transfers it through that SAC.
 * Guessing from /assets records picked a different issuer and left the treasury unable to
 * receive settlement.
 */
async function resolveUsdcIssuer(): Promise<string> {
  const payerAccount = await horizon!.loadAccount(Keypair.fromSecret(payerSecret).publicKey())
  const line = payerAccount.balances.find(
    (b): b is Horizon.HorizonApi.BalanceLineAsset => 'asset_code' in b && b.asset_code === 'USDC',
  )
  assert(line, 'the demo payer holds no USDC; cannot resolve the settlement issuer')
  return line.asset_issuer
}

async function establishUsdcTrustline(address: string, signer: Keypair, issuer: string): Promise<void> {
  const account = await horizon!.loadAccount(address)
  const lines = account.balances.filter(
    (b): b is Horizon.HorizonApi.BalanceLineAsset => 'asset_code' in b && b.asset_code === 'USDC',
  )
  if (lines.some((b) => b.asset_issuer === issuer)) return
  // Replace any USDC trustline issued by someone else: only the SAC's underlying issuer
  // can settle, and a stale trustline would also trip the "already established" check.
  const operations = lines
    .filter((b) => b.asset_issuer !== issuer)
    .map((b) => Operation.changeTrust({ asset: new Asset('USDC', b.asset_issuer), limit: '0' }))
  operations.push(Operation.changeTrust({ asset: new Asset('USDC', issuer) }))
  const builder = new TransactionBuilder(account, { fee: '100', networkPassphrase: passphrase })
  for (const operation of operations) builder.addOperation(operation)
  const tx = builder.setTimeout(60).build()
  tx.sign(signer)
  const res = await horizon!.submitTransaction(tx)
  if (!res.successful) fail(`USDC trustline failed on ${address}`)
}

async function usdcBalance(address: string): Promise<string> {
  const account = await horizon!.accounts().accountId(address).call()
  const usdc = (account.balances as Horizon.HorizonApi.BalanceLine[]).find(
    (b) => 'asset_code' in b && b.asset_code === 'USDC',
  )
  return usdc?.balance ?? '0'
}

async function waitForCompletion(hash: string, timeoutMs = 90_000): Promise<void> {
  const at = Date.now()
  while (Date.now() - at < timeoutMs) {
    const result = await rpcServer!.getTransaction(hash)
    if (result.status === 'SUCCESS') return
    if (result.status === 'FAILED') {
      fail(`transaction ${hash} failed (status FAILED)`)
    }
    await sleep(2000)
  }
  fail(`transaction ${hash} never completed`)
}

// ------------------------------------------------------------ signer lifecycle

let signerProcess: ChildProcess | null = null

async function signerReady(): Promise<boolean> {
  try {
    const res = await fetch(`${signerHttpUrl}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function ensureSigner(): Promise<void> {
  if (await signerReady()) return
  assert(token, `${signerTokenEnvName} is not set; run the prepare step first`)
  const env = {
    ...providerSignerEnvironment(process.env),
    SIGNER_PORT: String(signerPort),
    SIGNER_TOKEN: token,
    SIGNER_TREASURY_SECRET: process.env.SESSION_TREASURY_SECRET ?? '',
    SIGNER_RPC_URL: rpcUrl,
    SIGNER_NETWORK: network,
    PAGESURE_ORIGIN: ORIGIN,
  }
  signerProcess = spawn('npx', ['tsx', 'scripts/signer-service.ts'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  signerProcess.stdout?.on('data', (chunk) => process.stdout.write(`[signer] ${chunk}`))
  signerProcess.stderr?.on('data', (chunk) => process.stderr.write(`[signer] ${chunk}`))
  const at = Date.now()
  while (Date.now() - at < 20_000) {
    if (await signerReady()) return
    await sleep(500)
  }
  fail('signer service did not become ready')
}

// ------------------------------------------------------------------ DB wiring

function requireOrg(id: string) {
  const org = db().select().from(schema.organizations).where(eq(schema.organizations.id, id)).get()
  assert(org, `organization ${id} does not exist; seed the database first`)
  return org
}

function ensureChannelService(orgId: string): void {
  const now = Date.now()
  // Evaluation fails closed when a service has no policy, so the demo service gets its own
  // permissive policy: unknown wallets allowed, caps comfortably above priceBase.
  const policyId = `pol_${SLUG}`
  if (!db().select().from(schema.policies).where(eq(schema.policies.id, policyId)).get()) {
    db()
      .insert(schema.policies)
      .values({
        id: policyId,
        organizationId: orgId,
        name: 'Channel Demo Access',
        description: 'Demo policy for the channel-mode end-to-end run.',
        unknownAction: 'allow',
        maxAmountPerRequestBase: '10000000',
        dailyCapPerWalletBase: '1000000000',
        ungrantedSpendCapBase: '100000000',
        rateLimitPerMin: 120,
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  // The engine blocks at check 3 (network) and check 4 (asset) without these rows.
  const assetContract = process.env.USDC_CONTRACT_C ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
  const net = process.env.STELLAR_NETWORK ?? 'stellar:testnet'
  const networks = db().select().from(schema.policyNetworks).all().filter((r) => r.policyId === policyId)
  if (!networks.some((r) => r.network === net)) {
    db()
      .insert(schema.policyNetworks)
      .values({ id: `pn_${randomBytes(9).toString('hex')}`, organizationId: orgId, policyId, network: net })
      .run()
  }
  const assets = db().select().from(schema.policyAssets).all().filter((r) => r.policyId === policyId)
  if (!assets.some((r) => r.assetContract === assetContract)) {
    db()
      .insert(schema.policyAssets)
      .values({ id: `pa_${randomBytes(9).toString('hex')}`, organizationId: orgId, policyId, assetContract })
      .run()
  }
  const existing = db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.slug, SLUG))
    .get()
  if (existing) {
    if (existing.policyId !== policyId) {
      db().update(schema.services).set({ policyId }).where(eq(schema.services.id, existing.id)).run()
    }
    return
  }
  db()
    .insert(schema.services)
    .values({
      id: `svc_${SLUG}`,
      organizationId: orgId,
      slug: SLUG,
      name: 'Channel Demo (CoinGecko market)',
      description: 'Live channel-mode demo: one-way channel, N requests, one close.',
      assetCode: 'USDC',
      assetContract: process.env.USDC_CONTRACT_C ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      decimals: 7,
      priceBase: PRICE_BASE,
      mode: 'channel',
      upstreamKind: 'market',
      upstreamConfig: { coinGeckoIds: 'stellar' },
      policyId,
      status: 'live',
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function wireOrg(orgId: string, treasury: string, signerUrl: string): void {
  db()
    .update(schema.organizations)
    .set({
      settlementRecipient: treasury,
      commitmentSignerUrl: signerUrl,
      commitmentSignerTokenEnv: signerTokenEnvName,
    })
    .where(eq(schema.organizations.id, orgId))
    .run()
}

// -------------------------------------------------------------------- prepare

async function prepare(): Promise<void> {
  const org = requireOrg(ORG_ID)

  const treasurySecret = process.env.SESSION_TREASURY_SECRET ?? Keypair.random().secret()
  upsertEnv('SESSION_TREASURY_SECRET', treasurySecret)
  if (!process.env[signerTokenEnvName]) upsertEnv(signerTokenEnvName, randomBytes(18).toString('hex'))
  if (!process.env.MPP_SIGNER_HOSTS) upsertEnv('MPP_SIGNER_HOSTS', 'signer.pagesure.demo,127.0.0.1,localhost')
  if (!process.env.MPP_SIGNER_TOKEN_PREFIX) upsertEnv('MPP_SIGNER_TOKEN_PREFIX', 'PAGESURE_SIGNER_')

  const treasury = Keypair.fromSecret(process.env.SESSION_TREASURY_SECRET!)
  ensureChannelService(org.id)
  wireOrg(org.id, treasury.publicKey(), 'https://signer.pagesure.demo')

  if (horizon) {
    const hasAccount = await usdcBalance(treasury.publicKey()).then(() => true).catch(() => false)
    if (!hasAccount) {
      await fundTestnet(treasury.publicKey())
      await waitAccount(treasury.publicKey())
    }
    await establishUsdcTrustline(treasury.publicKey(), treasury, await resolveUsdcIssuer())
  }

  assert(process.env[signerTokenEnvName], 'signer token is missing after prep')
  console.log(
    `[prepare] org ${org.id}: recipient=${treasury.publicKey()} ` +
      `tokenEnv=${signerTokenEnvName} service=/${SLUG} priceBase=${PRICE_BASE} fundedBase=${FUNDED_BASE}`,
  )
  console.log(
    '[prepare] wrote .env and the DB. Restart the dev server so it picks up the new env, then run: npm run e2e:session',
  )
}

// ----------------------------------------------------------------------- run

async function openSessionAndChannel(): Promise<{ sessionId: string; channelContract: string; txHash: string }> {
  const sessionRes = await fetch(`${ORIGIN}/v1/${SLUG}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      funder: Keypair.fromSecret(payerSecret).publicKey(),
      commitmentPublicKey: Keypair.fromRawEd25519Seed(Buffer.from(seedHex, 'hex')).publicKey(),
      fundedBase: FUNDED_BASE,
      refundWaitingPeriodSeconds: REFUND_WAIT_SECONDS,
    }),
  })
  const sessionText = await sessionRes.text()
  assert(sessionRes.ok, `session open returned HTTP ${sessionRes.status}: ${sessionText}`)
  const session = JSON.parse(sessionText) as {
    sessionId: string
    open: {
      factory: string
      salt: string
      token: string
      from: string
      commitmentKey: string
      to: string
      amount: string
      refundWaitingPeriod: number
    }
  }
  const open = session.open

  const payer = Keypair.fromSecret(payerSecret)
  const source = await rpcServer!.getAccount(payer.publicKey())
  const invoker = new Contract(open.factory)
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: passphrase })
    .addOperation(
      invoker.call(
        'open',
        nativeToScVal(Buffer.from(open.salt, 'hex')),
        nativeToScVal(open.token, { type: 'address' }),
        nativeToScVal(open.from, { type: 'address' }),
        nativeToScVal(Buffer.from(open.commitmentKey, 'hex')),
        nativeToScVal(open.to, { type: 'address' }),
        nativeToScVal(BigInt(open.amount), { type: 'i128' }),
        nativeToScVal(Number(open.refundWaitingPeriod), { type: 'u32' }),
      ),
    )
    .setTimeout(60)
    .build()

  const simulated = await rpcServer!.simulateTransaction(tx)
  assert(
    rpc.Api.isSimulationSuccess(simulated),
    `open simulation failed: ${rpc.Api.isSimulationError(simulated) ? simulated.error : 'no result'}`,
  )
  assert(simulated.result?.retval, 'open simulation returned no channel address')
  const channelContract = scValToNative(simulated.result.retval)
  assert(typeof channelContract === 'string' && channelContract.startsWith('C'), `unexpected channel address ${channelContract}`)

  const prepared = await rpcServer!.prepareTransaction(tx)
  prepared.sign(payer)
  const sent = await rpcServer!.sendTransaction(prepared)
  if (sent.status === 'ERROR') fail(`open submit failed: ${JSON.stringify(sent)}`)
  const txHash = sent.hash
  await waitForCompletion(txHash)

  return { sessionId: session.sessionId, channelContract, txHash }
}

function httpJson(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init)
}

async function confirmSession(sessionId: string, channelContract: string, txHash: string): Promise<void> {
  const res = await httpJson(`${ORIGIN}/v1/${SLUG}/session/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, channelContract, txHash }),
  })
  const confirmText = await res.text()
  assert(res.ok, `session confirm returned HTTP ${res.status}: ${confirmText}`)
}

async function deliverRequests(sessionId: string, channelContract: string, count: number): Promise<string[]> {
  const commitment = Keypair.fromRawEd25519Seed(Buffer.from(seedHex, 'hex'))
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      clientChannel({
        commitmentKey: commitment,
        rpcUrl,
        network: network as 'stellar:testnet',
        allowedChannels: [channelContract],
      }),
    ],
  })

  const receipts: string[] = []
  for (let i = 0; i < count; i++) {
    const res = await mppx.fetch(`${ORIGIN}/v1/${SLUG}`, {
      method: 'POST',
      // The gateway needs the channel to locate the session on the first request, before any
      // signed credential exists. Present attempts carry the credential itself.
      headers: { 'content-type': 'application/json', 'x-pagesure-channel': channelContract },
      body: JSON.stringify({ message: `demo request ${i + 1}`, externalId: `${sessionId}-${i + 1}` }),
    })
    const requestText = await res.text()
    assert(res.ok, `request ${i + 1} returned HTTP ${res.status}: ${requestText}`)
    const cumulative = res.headers.get('X-Pagesure-Cumulative-Base') ?? '?'
    const body = JSON.parse(requestText) as { ok?: boolean; provider?: string; data?: unknown }
    receipts.push(`request ${i + 1}: status ${res.status} cumulativeBase=${cumulative} provider=${body.provider ?? '?'}`)
  }
  return receipts
}

async function settle(sessionId: string): Promise<{ txHash: string; cumulativeBase: string; requestCount: number }> {
  const res = await httpJson(`${signerHttpUrl}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug: SLUG, sessionId }),
  })
  const settleText = await res.text()
  assert(res.ok, `settle returned HTTP ${res.status}: ${settleText}`)
  const result = JSON.parse(settleText) as { txHash?: string; cumulativeBase?: string; requestCount?: number; error?: string }
  if (result.error) fail(`settle error: ${result.error}`)
  assert(result.txHash && result.cumulativeBase, 'settle did not report a tx hash')
  return { txHash: result.txHash!, cumulativeBase: result.cumulativeBase!, requestCount: result.requestCount ?? 0 }
}

async function run(): Promise<void> {
  const org = requireOrg(ORG_ID)
  assert(seedHex, 'AGENT_COMMITMENT_SEED is not set')
  assert(payerSecret, 'DEMO_PAYER_SECRET is not set')
  assert(rpcUrl && horizonUrl, 'STELLAR_RPC_URL / STELLAR_HORIZON_URL are not set')
  assert(org.settlementRecipient, 'org is not wired; run npm run e2e:session -- prepare')

  const payer = Keypair.fromSecret(payerSecret)
  const treasury = Keypair.fromSecret(process.env.SESSION_TREASURY_SECRET ?? '')
  assert(treasury.publicKey() === org.settlementRecipient, 'SESSION_TREASURY_SECRET does not match the org recipient')

  if (horizon) {
    await usdcBalance(treasury.publicKey()).catch(async () => {
      await fundTestnet(treasury.publicKey())
      await waitAccount(treasury.publicKey())
    })
    await establishUsdcTrustline(treasury.publicKey(), treasury, await resolveUsdcIssuer())
  }
  const before = await usdcBalance(treasury.publicKey())

  await ensureSigner()

  const payerUsdc = toBaseUnits(await usdcBalance(payer.publicKey()))
  assert(
    payerUsdc >= BigInt(FUNDED_BASE),
    `payer holds ${payerUsdc} base units, below fundedBase=${FUNDED_BASE}`,
  )
  console.log(`[e2e] opening channel service=/${SLUG} funder=${payer.publicKey()} fundedBase=${FUNDED_BASE}`)
  const { sessionId, channelContract, txHash: openTx } = await openSessionAndChannel()
  await confirmSession(sessionId, channelContract, openTx)
  console.log(`[e2e] channel open! session=${sessionId} channel=${channelContract} openTx=${openTx}`)

  console.log(`[e2e] delivering ${REQUESTS} requests (each an off-chain signed commitment)...`)
  const receipts = await deliverRequests(sessionId, channelContract, REQUESTS)
  for (const line of receipts) process.stdout.write(`[e2e]   ${line}\n`)

  const row = db().select().from(schema.paymentSessions).where(eq(schema.paymentSessions.id, sessionId)).get()
  assert(row, 'session row vanished')
  assert(Number(row.requestCount) === REQUESTS, `expected ${REQUESTS} requests, DB has ${row.requestCount}`)
  assert(row.cumulativeBase === (BigInt(PRICE_BASE) * BigInt(REQUESTS)).toString(), `cumulative mismatch: ${row.cumulativeBase}`)
  process.stdout.write(`[e2e] DB: requestCount=${row.requestCount} cumulativeBase=${row.cumulativeBase} status=${row.status}\n`)

  console.log(`[e2e] settling through the org signer (submitting the recorded payer voucher)...`)
  const settlement = await settle(sessionId)
  process.stdout.write(
    `[e2e] settlement: cumulativeBase=${settlement.cumulativeBase} requestCount=${settlement.requestCount} tx=${settlement.txHash}\n`,
  )

  const after = await usdcBalance(treasury.publicKey())
  const afterRow = db().select().from(schema.paymentSessions).where(eq(schema.paymentSessions.id, sessionId)).get()
  assert(afterRow, 'session row vanished after settle')
  process.stdout.write(`[e2e] final session status=${afterRow.status} settlementId=${afterRow.settlementId ?? '?'}\n`)
  process.stdout.write(`[e2e] treasury USDC before=${before} after=${after} (payout of ${afterRow.cumulativeBase} base units)\n`)
  assert(afterRow.status === 'closed', `session did not close; status=${afterRow.status}`)

  console.log(
    `\n[e2e] PASSED: ${REQUESTS} requests served from one channel; on-chain txs = open(${openTx}) + close(${settlement.txHash}). ` +
      `Treasury received ${usdcDiff(before, after)} USDC.`,
  )
}

function usdcDiff(before: string, after: string): string {
  const diff = (parseFloat(after) - parseFloat(before)).toFixed(7)
  return diff
}

/** Horizon reports balances as decimal strings ("19.9000000"); convert to 7-decimal base units. */
function toBaseUnits(value: string): bigint {
  const [wholeRaw, frac = ''] = value.split('.')
  const whole = wholeRaw ?? '0'
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0').slice(0, 7))
}

async function main(): Promise<void> {
  const sub = process.argv[2] ?? 'run'
  if (sub === 'prepare') await prepare()
  else if (sub === 'run') await run()
  else fail(`unknown subcommand ${sub}; expected prepare or run`)
}

main()
  .catch((error) => {
    console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    if (signerProcess) signerProcess.kill()
  })
