/**
 * Organization signer service for PageSure session (channel) settlement.
 *
 * PageSure deliberately stores neither the organization's commitment secret nor its treasury
 * secret, so withdrawals from a one-way channel must be signed and submitted by the
 * organization's own signer service. This script is that service for the live channel demo.
 *
 * It speaks the protocol PageSure already implements:
 *
 *   POST /sign
 *     body: { commitment: hex, context: { channel, amountBase, network } }
 *     ->   { signature: hex }
 *
 *     Signs a commitment XDR blob the client asks for, but only after verifying it actually
 *     binds to the channel, amount and network the caller claims. A signer that signs blind
 *     would be a signature oracle; this one is not.
 *
 *   POST /settle
 *     body: { slug, sessionId }
 *     ->   { txHash, sender, ... }
 *
 *     Fetches PageSure's authoritative settlement intent for the session, simulates
 *     prepare_commitment(cumulative) on the live channel to get the exact XDR bytes the
 *     contract will validate, binds them, signs with the commitment key, and submits the
 *     close() that pays PageSure's recorded cumulative to the organization's treasury.
 *
 * Both Bearer-token the same way, so the signer cannot be coerced by anyone who does not
 * hold the organization's signer token.
 *
 * Environment:
 *   SIGNER_PORT              listening port (default 4457)
 *   SIGNER_TOKEN             bearer token the signer accepts and presents to PageSure
 *   AGENT_COMMITMENT_SEED    hex ed25519 seed of the organization commitment keypair
 *   SIGNER_TREASURY_SECRET   secret of the treasury account that receives the payout
 *   PAGESURE_ORIGIN          base URL of the PageSure instance (default http://localhost:3000)
 *   SIGNER_NETWORK           CAIP network id (default stellar:testnet)
 *   SIGNER_RPC_URL           Soroban RPC for the signer's chains reads/writes
 */

import { createServer } from 'node:http'
import {
  Keypair,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { close } from '@stellar/mpp/channel/server'
import { assertCommitmentBinds } from '@/lib/mpp/commitment'

interface SettlementIntent {
  sessionId: string
  channelContract: string
  funder: string
  recipient: string
  assetCode: string
  assetContract: string
  decimals: number
  cumulativeBase: string
  cumulativeFormatted: string
  requestCount: number
  commitmentPublicKey: string
  signerUrl: string
  network: string
}

const port = Number(process.env.SIGNER_PORT ?? 4457)
const token = process.env.SIGNER_TOKEN ?? ''
const origin = (process.env.PAGESURE_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '')
const network = process.env.SIGNER_NETWORK ?? 'stellar:testnet'
const rpcUrl = process.env.SIGNER_RPC_URL ?? ''
const passphrase: 'stellar:testnet' | 'stellar:pubnet' | 'stellar:futurenet' | 'stellar:standalone' =
  network === 'stellar:pubnet' ? 'stellar:pubnet' :
  network === 'stellar:futurenet' ? 'stellar:futurenet' :
  network === 'stellar:standalone' ? 'stellar:standalone' :
  'stellar:testnet'

const seedHex = process.env.AGENT_COMMITMENT_SEED ?? ''
const commitmentSecret = process.env.SIGNER_TREASURY_SECRET ?? ''

function fail(message: string): never {
  throw new Error(message)
}

if (!/^[0-9a-f]{64}$/.test(seedHex)) fail('AGENT_COMMITMENT_SEED must be a 64-char hex ed25519 seed')
if (!commitmentSecret) fail('SIGNER_TREASURY_SECRET is required')
if (!rpcUrl) fail('SIGNER_RPC_URL is required')
if (!passphrase) fail(`SIGNER_NETWORK must be a CAIP id with a known passphrase (got ${network})`)

const commitmentKey = Keypair.fromRawEd25519Seed(Buffer.from(seedHex, 'hex'))
const treasury = Keypair.fromSecret(commitmentSecret)

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : (bytes as Buffer)).toString('hex')
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(hex.trim()) || hex.length % 2 !== 0) {
    throw new Error('commitment must be even-length hex')
  }
  return Buffer.from(hex.trim(), 'hex')
}

/**
 * Simulate prepare_commitment(amount) against the live channel so we sign exactly the bytes
 * the channel contract will validate at close. The simulation is read-only; nothing is
 * submitted for the request itself.
 */
async function prepareCommitmentBytes(channelContract: string, amount: bigint): Promise<Uint8Array> {
  const server = new rpc.Server(rpcUrl)
  const source = await server.getAccount(treasury.publicKey())
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: passphrase })
    .addOperation(new Contract(channelContract).call('prepare_commitment', nativeToScVal(amount, { type: 'i128' })))
    .setTimeout(60)
    .build()
  const result = await server.simulateTransaction(tx)
  if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
    const detail = rpc.Api.isSimulationError(result) ? result.error : 'no simulation result'
    throw new Error(`prepare_commitment simulation failed: ${detail}`)
  }
  const retval = result.result.retval
  if (retval === null || typeof retval !== 'object') {
    throw new Error('prepare_commitment returned no commitment value')
  }
  const value = (retval as xdr.ScVal).value()
  const raw = Buffer.from(value as Uint8Array)
  if (raw.length === 0) throw new Error('prepare_commitment returned empty commitment bytes')
  return raw
}

/** Fetch PageSure's authoritative settlement intent for a session. */
async function fetchIntent(slug: string, sessionId: string): Promise<SettlementIntent> {
  if (!token) throw new Error('SIGNER_TOKEN is not set; cannot present the organization token')
  const response = await fetch(`${origin}/v1/${slug}/session/settlement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) {
    throw new Error(`settlement intent for ${sessionId} returned HTTP ${response.status}`)
  }
  return response.json() as Promise<SettlementIntent>
}

/**
 * Report a submitted close back to PageSure so the session can complete.
 *
 * PageSure verifies the transaction from chain before accepting the report; this call only
 * tells it which transaction to verify. Retried briefly because a transient failure must not
 * leave a settled channel looking merely `settling`.
 */
async function reportSettlement(slug: string, sessionId: string, txHash: string): Promise<void> {
  if (!token) throw new Error('SIGNER_TOKEN is not set; cannot present the organization token')
  const url = `${origin}/v1/${slug}/session/settlement/complete`
  const body = JSON.stringify({ sessionId, txHash })
  let last = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      })
      const text = await response.text()
      if (response.ok) return
      last = `HTTP ${response.status}: ${text}`
      // A semantic refusal (wrong session state, unverifiable transaction) will not change on retry.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break
    } catch (error) {
      last = (error as Error).message
    }
  }
  throw new Error(`settlement report to ${url} failed (${last}); re-POST { sessionId, txHash } there to complete`)
}

/** The org token guards the sign endpoint. Refuse a caller that does not hold it. */
function authorized(request: Request): boolean {
  if (!token) return true
  const raw = request.headers.get('authorization') ?? ''
  return raw === `Bearer ${token}`
}

async function handleSign(body: Record<string, unknown>): Promise<{ signature: string } | { error: string; status: number }> {
  if (typeof body.commitment !== 'string') {
    return { error: 'expected { commitment, context }', status: 400 }
  }
  const context = body.context
  if (typeof context !== 'object' || context === null) {
    return { error: 'expected { commitment, context }', status: 400 }
  }
  const { channel, amountBase, network: claimNetwork } = context as Record<string, unknown>
  if (typeof channel !== 'string' || typeof amountBase !== 'string' || typeof claimNetwork !== 'string') {
    return { error: 'context must include channel, amountBase and network', status: 400 }
  }

  const commitmentBytes = hexToBytes(body.commitment)

  // Bind before signing. If the bytes do not encode a commitment for this channel, amount and
  // network, they get no signature.
  try {
    await assertCommitmentBinds(commitmentBytes, {
      channel,
      amountBase,
      network: claimNetwork,
    })
  } catch (error) {
    return {
      error: `refusing to sign unbound commitment: ${error instanceof Error ? error.message : String(error)}`,
      status: 409,
    }
  }

  const signature = commitmentKey.sign(Buffer.from(commitmentBytes))
  return { signature: bytesToHex(signature) }
}

async function handleSettle(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.slug !== 'string' || typeof body.sessionId !== 'string') {
    return { error: 'expected { slug, sessionId }', status: 400 }
  }
  const slug = body.slug.replace(/[^a-zA-Z0-9_-]/g, '')
  const sessionId = body.sessionId.replace(/[^a-zA-Z0-9_-]/g, '')
  if (slug !== body.slug || sessionId !== body.sessionId) {
    return { error: 'slug and sessionId must be URL-safe', status: 400 }
  }

  const intent = await fetchIntent(slug, sessionId)

  // A payout to any account other than our configured treasury would be a misdirection. The
  // signer refuses rather than submit it.
  if (intent.recipient !== treasury.publicKey()) {
    return {
      error: `intent pays ${intent.recipient}, not the configured treasury ${treasury.publicKey()}`,
      status: 409,
    }
  }

  const amount = BigInt(intent.cumulativeBase)
  const commitmentBytes = await prepareCommitmentBytes(intent.channelContract, amount)
  await assertCommitmentBinds(commitmentBytes, {
    channel: intent.channelContract,
    amountBase: intent.cumulativeBase,
    network: intent.network,
  })
  const signature = commitmentKey.sign(Buffer.from(commitmentBytes))

  const feePayer = { envelopeSigner: commitmentSecret }
  const txHash = await close({
    channel: intent.channelContract,
    amount,
    signature,
    feePayer,
    network: intent.network as 'stellar:testnet' | 'stellar:pubnet',
    rpcUrl,
  })

  // The close only becomes a PageSure settlement once the report lands: the session row stays
  // `settling` until PageSure has re-derived the payout from chain itself. A failure here is
  // returned loudly (with the hash) so the caller can re-POST it to the completion endpoint
  // rather than assume the settlement was recorded.
  try {
    await reportSettlement(slug, sessionId, txHash)
  } catch (error) {
    return {
      error: `${(error as Error).message} (close succeeded: tx ${txHash})`,
      status: 502,
      txHash,
    }
  }

  return {
    txHash,
    channel: intent.channelContract,
    recipient: intent.recipient,
    assetCode: intent.assetCode,
    cumulativeBase: intent.cumulativeBase,
    cumulativeFormatted: intent.cumulativeFormatted,
    requestCount: intent.requestCount,
    signer: commitmentKey.publicKey(),
  }
}

const server = createServer(async (req, res) => {
  const request = new Request(`http://localhost:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][],
    ),
  })

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const readJson = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  const send = (status: number, payload: Record<string, unknown>) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      send(200, {
        ok: true,
        service: 'pagesure-signer',
        network,
        channelSigner: commitmentKey.publicKey(),
        treasury: treasury.publicKey(),
      })
      return
    }

    const body = readJson()

    if (req.method === 'POST' && req.url === '/sign') {
      if (!authorized(request)) return send(401, { error: 'unauthorized' })
      if (!body) return send(400, { error: 'expected a JSON body' })
      const result = await handleSign(body)
      if ('status' in result && typeof result.status === 'number' && 'error' in result) {
        send(result.status, { error: result.error })
        return
      }
      send(200, result)
      return
    }

    if (req.method === 'POST' && req.url === '/settle') {
      if (!authorized(request)) return send(401, { error: 'unauthorized' })
      if (!body) return send(400, { error: 'expected a JSON body' })
      const result = await handleSettle(body)
      if ('status' in result && typeof result.status === 'number' && 'error' in result) {
        send(result.status, {
          error: result.error,
          ...('txHash' in result ? { txHash: result.txHash } : {}),
        })
        return
      }
      send(200, result)
      return
    }

    send(404, { error: `no route for ${req.method} ${req.url}` })
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, () => {
  console.log(
    `[signer] listening on :${port} network=${network} channelSigner=${commitmentKey.publicKey()} treasury=${treasury.publicKey()}`,
  )
})