import { spawn, type ChildProcess } from 'node:child_process'
import {
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import { Mppx, channel as clientChannel } from '@stellar/mpp/channel/client'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { organizations, paymentSessions } from '@/lib/db/schema'
import { network, rpcUrl } from '@/lib/mpp/registry'
import { explorerUrl } from '@/lib/metering/record'

/**
 * The payer side of session (channel) mode, for the operator playground.
 *
 * This is the same real client an agent runs, driven from the server so an operator can
 * click through the whole lifecycle without holding a keypair in the browser: open a
 * one-way channel, send N off-chain signed commitments, then settle once on chain.
 *
 * Nothing here is simulated. The demo payer signs and submits the factory `open`; the
 * organization's signer service signs and submits `close`; PageSure verifies both against
 * chain. The only convenience is that the private keys live in the server environment,
 * exactly as they do for the charge-mode playground (see lib/agent/runner.ts).
 */

export interface SessionStep {
  step:
    | 'OPEN_REQUESTED'
    | 'CHANNEL_OPEN'
    | 'CHANNEL_CONFIRMED'
    | 'REQUEST'
    | 'VOUCHER_SIGNED'
    | 'SERVICE_EXECUTED'
    | 'SETTLE_REQUESTED'
    | 'CLOSE_SUBMITTED'
    | 'SESSION_CLOSED'
    | 'FAILED'
  detail: string
  at: number
}

function passphrase(): string {
  return network() === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET
}

export function internalOrigin(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
}

function demoPayer(): Keypair {
  const secret = process.env.DEMO_PAYER_SECRET
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Error('DEMO_PAYER_SECRET is not set or is not a valid Stellar secret seed')
  }
  return Keypair.fromSecret(secret)
}

function commitmentKeypair(): Keypair {
  const hex = process.env.AGENT_COMMITMENT_SEED
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('AGENT_COMMITMENT_SEED must be a 32-byte hex seed')
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(hex, 'hex'))
}

function rpcServer(): rpc.Server {
  const url = rpcUrl()
  if (!url) throw new Error('STELLAR_RPC_URL is not set')
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') })
}

async function waitForCompletion(hash: string, timeoutMs = 90_000): Promise<void> {
  const server = rpcServer()
  const at = Date.now()
  while (Date.now() - at < timeoutMs) {
    const result = await server.getTransaction(hash)
    if (result.status === 'SUCCESS') return
    if (result.status === 'FAILED') throw new Error(`transaction ${hash} failed`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`transaction ${hash} never completed`)
}

interface OpenInstructions {
  factory: string
  salt: string
  token: string
  from: string
  commitmentKey: string
  to: string
  amount: string
  refundWaitingPeriod: number
}

export interface OpenSessionResult {
  sessionId: string
  channelContract: string
  openTx: string
  openTxUrl: string
  fundedBase: string
  refundWaitingPeriodSeconds: number
  steps: SessionStep[]
}

/**
 * Reserve a session, then deploy + fund the channel as the demo payer and confirm it.
 *
 * The payer signs the factory `open` invoke itself. PageSure never holds the funds and
 * never deploys on the payer's behalf; `confirm` re-reads every field from chain before
 * the session is allowed to go active.
 */
export async function openChannelSession(input: {
  slug: string
  fundedBase?: string
  refundWaitingPeriodSeconds?: number
}): Promise<OpenSessionResult> {
  const steps: SessionStep[] = []
  const push = (step: SessionStep['step'], detail: string) => steps.push({ step, detail, at: Date.now() })
  const fundedBase = input.fundedBase ?? process.env.PLAYGROUND_SESSION_FUNDED_BASE ?? '500000'
  const refundWaitingPeriodSeconds = input.refundWaitingPeriodSeconds ?? 100
  const payer = demoPayer()
  const origin = internalOrigin()

  push('OPEN_REQUESTED', `Reserving a session funded with ${fundedBase} base units`)
  const sessionRes = await fetch(`${origin}/v1/${input.slug}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      funder: payer.publicKey(),
      fundedBase,
      refundWaitingPeriodSeconds,
    }),
  })
  const sessionText = await sessionRes.text()
  if (!sessionRes.ok) {
    return fail(steps, `the gateway refused to open a session (HTTP ${sessionRes.status}): ${sessionText}`)
  }
  const session = JSON.parse(sessionText) as { sessionId: string; open: OpenInstructions }
  const open = session.open

  const server = rpcServer()
  const source = await server.getAccount(payer.publicKey())
  const invoker = new Contract(open.factory)
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: passphrase() })
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

  const simulated = await server.simulateTransaction(tx)
  if (!rpc.Api.isSimulationSuccess(simulated)) {
    const detail = rpc.Api.isSimulationError(simulated) ? simulated.error : 'no simulation result'
    return fail(steps, `the channel open simulation failed: ${detail}`)
  }
  if (!simulated.result?.retval) return fail(steps, 'the channel open simulation returned no address')
  const channelContract = scValToNative(simulated.result.retval)
  if (typeof channelContract !== 'string' || !channelContract.startsWith('C')) {
    return fail(steps, `the factory returned an unexpected channel address ${channelContract}`)
  }
  push('CHANNEL_OPEN', `Deploying channel ${channelContract.slice(0, 12)}… and funding it`)

  const prepared = await server.prepareTransaction(tx)
  prepared.sign(payer)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') return fail(steps, `the open transaction was rejected: ${JSON.stringify(sent)}`)
  const openTx = sent.hash
  await waitForCompletion(openTx)
  steps[steps.length - 1] = {
    step: 'CHANNEL_OPEN',
    detail: `Channel ${channelContract.slice(0, 12)}… funded on chain`,
    at: Date.now(),
  }

  const confirmRes = await fetch(`${origin}/v1/${input.slug}/session/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId, channelContract, txHash: openTx }),
  })
  const confirmText = await confirmRes.text()
  if (!confirmRes.ok) {
    return fail(steps, `PageSure could not verify the channel (HTTP ${confirmRes.status}): ${confirmText}`)
  }
  push('CHANNEL_CONFIRMED', 'Channel verified against chain; the session is active')

  return {
    sessionId: session.sessionId,
    channelContract,
    openTx,
    openTxUrl: explorerUrl(network(), openTx),
    fundedBase: open.amount,
    refundWaitingPeriodSeconds,
    steps,
  }
}

export interface RequestReceipt {
  index: number
  ok: boolean
  status: number
  cumulativeBase: string | null
  provider: string | null
  body: unknown
  error: string | null
}

/**
 * Send `count` billable requests through the channel. Each one is an off-chain signed
 * commitment; no transaction touches the chain. The gateway is authoritative for the
 * cumulative, so a fresh client per call signs exactly what the server asks for.
 */
export async function sendChannelRequests(input: {
  slug: string
  channelContract: string
  count: number
}): Promise<{ receipts: RequestReceipt[]; steps: SessionStep[] }> {
  const steps: SessionStep[] = []
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      clientChannel({
        commitmentKey: commitmentKeypair(),
        rpcUrl: rpcUrl(),
        network: network(),
        allowedChannels: [input.channelContract],
      }),
    ],
  })

  const origin = internalOrigin()
  const receipts: RequestReceipt[] = []
  for (let i = 0; i < input.count; i++) {
    const index = i + 1
    try {
      const res = await mppx.fetch(`${origin}/v1/${input.slug}`, {
        method: 'POST',
        // The gateway needs the channel to find the session on the first request, before
        // any signed credential exists; later requests carry the credential itself.
        headers: { 'content-type': 'application/json', 'x-pagesure-channel': input.channelContract },
        body: JSON.stringify({ message: `playground request ${index}`, externalId: `${input.channelContract}-${Date.now()}-${index}` }),
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // leave raw text
      }
      const cumulativeBase = res.headers.get('X-Pagesure-Cumulative-Base')
      const provider = (body as { provider?: string }).provider ?? null
      const ok = res.ok
      if (ok) {
        steps.push({ step: 'VOUCHER_SIGNED', detail: `Request ${index}: signed commitment accepted`, at: Date.now() })
        steps.push({ step: 'SERVICE_EXECUTED', detail: `Request ${index}: upstream delivered (${provider ?? 'upstream'})`, at: Date.now() })
      } else {
        const detail = (body as { detail?: string }).detail ?? `HTTP ${res.status}`
        steps.push({ step: 'FAILED', detail: `Request ${index}: ${detail}`, at: Date.now() })
      }
      receipts.push({ index, ok, status: res.status, cumulativeBase, provider, body, error: null })
    } catch (error) {
      const message = (error as Error).message
      steps.push({ step: 'FAILED', detail: `Request ${index}: ${message}`, at: Date.now() })
      receipts.push({ index, ok: false, status: 0, cumulativeBase: null, provider: null, body: null, error: message })
    }
  }
  return { receipts, steps }
}

export interface SettleResult {
  txHash: string
  closeTxUrl: string
  cumulativeBase: string
  requestCount: number
  status: string
  settlementId: string | null
  steps: SessionStep[]
}

/**
 * Ask the organization's signer service to sign and submit the on-chain close, then read
 * back the session PageSure recorded. The signer reports the close to PageSure, which
 * verifies it against chain before flipping the session to `closed`.
 */
export async function settleChannelSession(input: { slug: string; sessionId: string }): Promise<SettleResult> {
  const steps: SessionStep[] = []
  const push = (step: SessionStep['step'], detail: string) => steps.push({ step, detail, at: Date.now() })
  push('SETTLE_REQUESTED', 'Asking the organization signer to sign the recorded cumulative')

  await ensureSigner()
  const token = signerToken()
  const res = await fetch(`${signerHttpUrl()}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug: input.slug, sessionId: input.sessionId }),
  })
  const text = await res.text()
  let parsed: { txHash?: string; cumulativeBase?: string; requestCount?: number; error?: string } = {}
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    // leave empty; handled below
  }
  if (!res.ok || parsed.error) {
    const detail = parsed.error ?? `HTTP ${res.status}: ${text}`
    return fail(steps, `the signer could not settle the session: ${detail}`)
  }
  if (!parsed.txHash || !parsed.cumulativeBase) {
    return fail(steps, 'the signer did not report a close transaction')
  }
  push('CLOSE_SUBMITTED', `Close submitted: ${parsed.txHash.slice(0, 16)}…`)

  const row = db().select().from(paymentSessions).where(eq(paymentSessions.id, input.sessionId)).get()
  if (!row) return fail(steps, 'the session disappeared after settlement')
  if (row.status !== 'closed') {
    return fail(steps, `the signer submitted ${parsed.txHash} but PageSure has not closed the session (status ${row.status})`)
  }
  push('SESSION_CLOSED', `Settled on chain; treasury received ${row.cumulativeBase} base units`)

  return {
    txHash: parsed.txHash,
    closeTxUrl: explorerUrl(network(), parsed.txHash),
    cumulativeBase: parsed.cumulativeBase,
    requestCount: parsed.requestCount ?? Number(row.requestCount),
    status: row.status,
    settlementId: row.settlementId ?? null,
    steps,
  }
}

// ------------------------------------------------------------ signer lifecycle

let spawnedSigner: ChildProcess | null = null

function signerHttpUrl(): string {
  return process.env.SIGNER_HTTP_URL ?? `http://127.0.0.1:${process.env.SIGNER_PORT ?? '4457'}`
}

function signerToken(): string {
  const org = db().select().from(organizations).get()
  const envName = org?.commitmentSignerTokenEnv ?? 'PAGESURE_SIGNER_PROOF'
  const token = process.env[envName] ?? process.env.SIGNER_TOKEN ?? ''
  if (!token) throw new Error(`${envName} is not set; the signer cannot be authenticated`)
  return token
}

async function signerReady(): Promise<boolean> {
  try {
    const res = await fetch(`${signerHttpUrl()}/health`)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Make sure the organization's signer service is up.
 *
 * The signer is a separate process by design: it is the party that holds the treasury key
 * and signs the close, and keeping it out of the app is the whole point. In production an
 * operator runs it themselves; in development the playground starts one on demand so a
 * reviewer can click through settlement without a second terminal.
 */
async function ensureSigner(): Promise<void> {
  if (await signerReady()) return
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `the organization signer service is not running at ${signerHttpUrl()}; start scripts/signer-service.ts`,
    )
  }
  const token = signerToken()
  const env = {
    ...process.env,
    SIGNER_PORT: process.env.SIGNER_PORT ?? '4457',
    SIGNER_TOKEN: token,
    AGENT_COMMITMENT_SEED: process.env.AGENT_COMMITMENT_SEED ?? '',
    SIGNER_TREASURY_SECRET: process.env.SESSION_TREASURY_SECRET ?? '',
    SIGNER_RPC_URL: rpcUrl() ?? '',
    SIGNER_NETWORK: network(),
    PAGESURE_ORIGIN: internalOrigin(),
  }
  spawnedSigner = spawn('npx', ['tsx', 'scripts/signer-service.ts'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawnedSigner.stdout?.on('data', (chunk) => process.stdout.write(`[signer] ${chunk}`))
  spawnedSigner.stderr?.on('data', (chunk) => process.stderr.write(`[signer] ${chunk}`))

  const at = Date.now()
  while (Date.now() - at < 20_000) {
    if (await signerReady()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('the signer service did not become ready')
}

function fail(steps: SessionStep[], detail: string): never {
  steps.push({ step: 'FAILED', detail, at: Date.now() })
  const error = new Error(detail) as Error & { steps: SessionStep[] }
  error.steps = steps
  throw error
}
