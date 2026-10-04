import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { Mppx, Store, stellar as stellarCharge } from '@stellar/mpp/charge/server'
import { stellar as stellarChannel } from '@stellar/mpp/channel/server'
import { USDC_SAC_TESTNET, type Logger as MppLogger } from '@stellar/mpp'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { requests } from '@/lib/db/schema'
import type { PolicyTrace } from '@/lib/policy/types'

/**
 * One shared Store across every method instance.
 *
 * MPP store keys are namespaced `stellar:charge:*` and `stellar:channel:*`. Sharing a
 * single AtomicStore is what guarantees a given on-chain tx hash (charge) or channel
 * cumulative (channel) cannot settle twice, including across two different services.
 * Per-instance stores would silently weaken replay protection.
 *
 * Store.memory() is correct ONLY for a single process. The constructor verifies that
 * `update` exists; it cannot verify that update is a linearizable compare-and-set.
 * Running more than one instance with Store.memory() breaks charge dedup and channel
 * monotonicity. See README "Deployment constraints".
 */

let sharedStore: ReturnType<typeof Store.memory> | null = null

export function mppStore(): ReturnType<typeof Store.memory> {
  if (!sharedStore) sharedStore = Store.memory()
  return sharedStore
}

export function network(): 'stellar:testnet' | 'stellar:pubnet' {
  return process.env.STELLAR_NETWORK === 'stellar:pubnet' ? 'stellar:pubnet' : 'stellar:testnet'
}

export function rpcUrl(): string | undefined {
  return process.env.STELLAR_RPC_URL || undefined
}

/*
 * There is deliberately no `providerRecipient()` here any more.
 *
 * A process-wide recipient cannot be correct in a multi-tenant deployment: it silently sends
 * every organization's revenue to whichever treasury was configured last. Payment routing goes
 * through `lib/mpp/settlement.ts`, which resolves `service -> organization ->
 * settlementRecipient`. Removing the function rather than deprecating it is the point — a
 * helper still in scope is a helper someone will reach for, and it would compile.
 *
 * PROVIDER_RECIPIENT_G survives only as the channel *factory admin* in
 * scripts/deploy-contracts.ts, which is a deployment role and not a payment destination.
 */

/**
 * Fee payer. Sponsors transaction fees so a paying agent never needs XLM, only USDC.
 * mppx's own docs warn about fee-exhaustion DoS on this path, which is why the policy
 * engine rate-limits a wallet BEFORE any challenge is issued.
 */
export function feePayer(): { envelopeSigner: Keypair } {
  const secret = process.env.FEE_PAYER_SECRET
  if (!secret) {
    throw new Error(
      'FEE_PAYER_SECRET is not set. PageSure requires a fee payer so payers never pay network fees.',
    )
  }
  return { envelopeSigner: Keypair.fromSecret(secret) }
}

/** What a verified payment tells us. Written by the payment.success handler. */
export interface VerifiedPayment {
  /** MPP receipt reference. For stellar charge this is the settled tx hash. */
  reference: string
  /** did:pkh:... of the account whose funds actually moved. AUTHORITATIVE. */
  source: string | null
  externalId: string | null
}

const captured = new Map<string, VerifiedPayment>()

/**
 * The settlement each mppx instance observed, keyed by the instance itself.
 *
 * Keying by `externalId` does not work, and the reason is worth recording because it is not
 * obvious. A paid request spans TWO HTTP requests: the first is answered 402 and mints a challenge
 * carrying `externalId`, the second presents the credential for that challenge. The gateway mints a
 * NEW request row per HTTP request, so the id it is holding when the payment lands is not the id the
 * settlement reports - the receipt carries the externalId from the original challenge.
 *
 * Waiting on the id therefore always timed out, even though `payment.success` had fired and the
 * money had moved. Worse than a wasted wait: the gateway answered 400, served nothing, and left the
 * row reading `challenged`, so not even the charged_not_delivered incident path could record that a
 * payment had happened.
 *
 * An instance is the right scope. One mppx instance serves one incoming request and can settle at
 * most one payment, so its own promise is unambiguous - and unlike a module-level "current call" it
 * stays correct when requests overlap.
 */
const settledByInstance = new WeakMap<object, Promise<VerifiedPayment>>()

/**
 * Build a charge method whose verified payments are captured for the caller.
 *
 * `externalId` is set by the caller to the request row id, so the 402 attempt and the
 * paid retry correlate to ONE metering row instead of two. The payment.success handler
 * receives the cryptographically verified credential, which is the only trustworthy
 * source of payer identity.
 */
export function buildChargeMppx(config: { recipient: string; currency: string }) {
  const mppx = Mppx.create({
    secretKey: process.env.MPP_SECRET_KEY ?? 'pagesure-dev-mpp-secret',
    methods: [
      stellarCharge.charge({
        recipient: config.recipient,
        currency: config.currency,
        network: network(),
        rpcUrl: rpcUrl(),
        store: mppStore(),
        feePayer: feePayer(),
        maxFeeBumpStroops: 1_000_000,
        // Push mode is disabled: a `hash`-only credential carries no proof that the
        // payer controls the funding account, so it is rejected by default.
        allowUnsignedPush: false,
        logger: consoleLogger('charge'),
      }),
    ],
  })

  let resolveSettled: ((value: VerifiedPayment) => void) | undefined
  const settled = new Promise<VerifiedPayment>((resolve) => {
    resolveSettled = resolve
  })
  settledByInstance.set(mppx, settled)

  mppx.on('payment.success', (event) => {
    const externalId = event.receipt.externalId ?? null
    const reference = event.receipt.reference
    const source = readCredentialSource(event.credential)
    const value = { reference, source, externalId }
    if (externalId) captured.set(externalId, value)
    resolveSettled?.(value)
  })

  return mppx
}

/**
 * Wait for the payment this mppx instance settled, if any.
 *
 * Resolves null on timeout rather than hanging a request forever. Never rejects: a caller that
 * gets null treats the request as unpaid, which is the safe direction.
 */
export async function settledPayment(
  instance: object,
  timeoutMs = 20000,
): Promise<VerifiedPayment | null> {
  const settled = settledByInstance.get(instance)
  if (!settled) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Read and consume the captured payment for a request row. */
export function takeVerifiedPayment(externalId: string): VerifiedPayment | null {
  const value = captured.get(externalId)
  if (value) captured.delete(externalId)
  return value ?? null
}

/** The base64url `Payment` envelope decoded, but only for its claimed `source`. */
function readCredentialSource(credential: unknown): string | null {
  const c = credential as { source?: unknown } | undefined
  return typeof c?.source === 'string' ? c.source : null
}

export interface ChannelConfig {
  channel: string
  commitmentPublicKey: string
  recipient: string
  currency: string
}

export function buildChannelMppx(config: ChannelConfig) {
  return Mppx.create({
    secretKey: process.env.MPP_SECRET_KEY ?? 'pagesure-dev-mpp-secret',
    methods: [
      stellarChannel.channel({
        channel: config.channel,
        commitmentKey: config.commitmentPublicKey,
        // recipient and currency pin the on-chain payout. Without them the SDK only
        // logs a startup warning, and a channel could settle to a third party or in a
        // worthless token, which defeats the point of verifying anything.
        recipient: config.recipient,
        currency: config.currency,
        network: network(),
        rpcUrl: rpcUrl(),
        store: mppStore(),
        checkOnChainState: true,
        feePayer: feePayer(),
        feeBudget: { maxStroops: 50_000_000, windowMs: 60 * 60 * 1000 },
        maxFeeBumpStroops: 1_000_000,
        logger: consoleLogger('channel'),
      }),
    ],
  })
}

/**
 * Stamp the verified payer and tx hash onto the request row. Called once mppx has
 * settled, so the row moves from 'challenged' to 'paid' rather than creating a second
 * row for the retry.
 */
export function markVerified(
  requestId: string,
  payment: VerifiedPayment,
  trace: PolicyTrace,
): void {
  db()
    .update(requests)
    .set({
      status: 'paid',
      policyDecision: trace.decision === 'none' ? 'allow' : trace.decision,
      policyTrace: trace,
      verifiedPayer: payerFromDid(payment.source),
      receiptReference: payment.reference,
      paymentTxHash: payment.reference,
    })
    .where(eq(requests.id, requestId))
    .run()
}

export function payerFromDid(did: string | null | undefined): string | null {
  if (!did) return null
  const parts = did.split(':')
  const candidate = parts[parts.length - 1] ?? ''
  return StrKey.isValidEd25519PublicKey(candidate) ? candidate : null
}

/**
 * MPP expects a pino-compatible Logger. Silent unless MPP_DEBUG=1 so a demo run is not
 * buried in SDK logs, but payment errors are always surfaced.
 */
function consoleLogger(scope: string): MppLogger {
  const enabled = process.env.MPP_DEBUG === '1'
  const sink = (level: 'debug' | 'info' | 'warn' | 'error') => {
    if (enabled) return (...args: unknown[]) => console[level](`[mpp:${scope}]`, ...args)
    if (level === 'error') return (...args: unknown[]) => console.error(`[mpp:${scope}]`, ...args)
    return () => {}
  }
  return {
    level: enabled ? 'debug' : 'error',
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
  } as unknown as MppLogger
}

export { USDC_SAC_TESTNET }
export const ALL_ZEROS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'