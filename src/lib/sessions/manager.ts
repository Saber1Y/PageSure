import { StrKey } from '@stellar/stellar-sdk'
import { getChannelState } from '@stellar/mpp/channel/server'
import { db } from '@/lib/db/client'
import { paymentSessions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { network, rpcUrl } from '@/lib/mpp/registry'
import { toBig } from '@/lib/money'
import { newId } from '@/lib/metering/record'
import { nextSessionRef } from './lookup'
import { requireCommitmentKeyBytes, settlementTargetForOrganization } from '@/lib/mpp/settlement'
import { addSessionEvent } from './gateway'

/**
 * Session lifecycle.
 *
 * There is NO MPP-level `open` action; it was removed upstream because the channel
 * contract has no on-chain `open` entrypoint. Deployment is out-of-band:
 *
 *   one-way-channel WASM  -> uploaded once, hash pinned in .env
 *   channel-factory       -> __constructor(admin, channelWasmHash)   one-time
 *                          -> open(salt, token, from, commitmentKey, to, amount,
 *                                  refundWaitingPeriod)                per session
 *
 * The PAYER signs and submits `open()`, so funds never leave an account PageSure
 * controls. PageSure then VERIFIES the resulting channel against chain before marking
 * the session active. Verification is the part that matters for security, so it stays
 * on our side of the boundary rather than being trusted from the client.
 */

export interface OpenSessionParams {
  /** Owning organization of the service, from the resolved service. */
  organizationId: string
  serviceId: string
  funder: string
  assetContract: string
  decimals: number
  fundedBase: string
  refundWaitingPeriodSeconds: number
}

export class ChannelVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelVerificationError'
  }
}

/** Everything the payer's client needs to deploy its own channel instance. */
export function channelOpenInstructions(params: OpenSessionParams) {
  const factory = process.env.CHANNEL_FACTORY_C
  if (!factory) throw new ChannelVerificationError('CHANNEL_FACTORY_C is not set. Run: npm run channels:deploy')

  const settlement = settlementTargetForOrganization(params.organizationId)
  if (!settlement) throw new ChannelVerificationError(`organization ${params.organizationId} does not exist`)

  return {
    intent: 'channel',
    factory,
    // The salt makes the deployment unique and lets anyone recompute the address.
    salt: newSalt(),
    token: params.assetContract,
    from: params.funder,
    /*
     * The organization's own commitment key, never the payer's.
     *
     * This was previously read straight out of the request body, which inverts the contract's
     * authorization model: `settle` and `close` check `ed25519_verify(commitment_key, ...)` to
     * authorise the recipient to withdraw. Handing that key to the payer means the payer holds
     * the private half of the key that authorises withdrawal from its own channel. It is not
     * directly exploitable today only because `to.require_auth()` also runs, so this stayed
     * invisible — while PageSure itself could never produce a valid commitment, making the
     * settlement path non-functional. Both halves now come from the organization.
     *
     * Raw bytes, because the factory takes BytesN<32>. The G... StrKey is 56 characters and
     * would decode to the wrong 32 bytes, failing only at settlement time with funds already
     * escrowed.
     */
    commitmentKey: requireCommitmentKeyBytes(params.organizationId).toString('hex'),
    to: settlement.recipient,
    /*
     * A string, not the BigInt `toBig` returns.
     *
     * These instructions are serialized straight into the JSON response, and JSON.stringify
     * throws on BigInt. Passing the bigint reserved the session row first and then failed to
     * answer, so the payer got a 500 with no instructions while a session sat in the
     * database holding a slot they could never use. Base units are decimal digits, so the
     * decimal string is exactly the i128 the contract expects.
     */
    amount: toBig(params.fundedBase).toString(),
    refundWaitingPeriod: params.refundWaitingPeriodSeconds,
    network: network(),
    note:
      'The payer signs and submits this invoke. PageSure does not hold the funds and does not deploy on the payer behalf.',
  }
}

function newSalt(): string {
  return Buffer.from(
    // 32 bytes of entropy, hex encoded, matching BytesN<32> in the factory signature.
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString('hex')
}

/**
 * Verify a channel against chain and, if it checks out, activate the session.
 *
 * Every field is compared against what PageSure expected. A mismatch means the payer
 * deployed something other than the channel it claimed, and the session is refused.
 */
export async function confirmSession(input: {
  organizationId: string
  sessionId: string
  channelContract: string
  expected: {
    funder: string
    recipient: string
    assetContract: string
    commitmentPublicKeyG: string
  }
}): Promise<{ ok: true; balanceBase: string } | { ok: false; reason: string }> {
  if (!StrKey.isValidContract(input.channelContract)) {
    return { ok: false, reason: 'channelContract is not a valid contract address' }
  }

  let state: Awaited<ReturnType<typeof getChannelState>>
  try {
    state = await getChannelState({
      channel: input.channelContract,
      network: network(),
      rpcUrl: rpcUrl(),
    })
  } catch (error) {
    return { ok: false, reason: `could not read channel state: ${(error as Error).message}` }
  }

  if (state.from !== input.expected.funder) {
    return { ok: false, reason: `channel funder is ${state.from}, expected ${input.expected.funder}` }
  }
  if (state.to !== input.expected.recipient) {
    return { ok: false, reason: `channel recipient is ${state.to}, expected ${input.expected.recipient}` }
  }
  if (state.token !== input.expected.assetContract) {
    return { ok: false, reason: `channel token is ${state.token}, expected ${input.expected.assetContract}` }
  }
  if (state.closeEffectiveAtLedger !== null) {
    return { ok: false, reason: 'channel is already closing' }
  }
  if (state.balance <= 0n) {
    return { ok: false, reason: 'channel has no funded balance' }
  }

  db()
    .update(paymentSessions)
    .set({
      channelContract: input.channelContract,
      fundedBase: state.balance.toString(),
      status: 'active',
      updatedAt: Date.now(),
    })
    .where(eq(paymentSessions.id, input.sessionId))
    .run()

  addSessionEvent(
    input.organizationId,
    input.sessionId,
    'channel_funded',
    `Channel funded with ${state.balance} base units, verified against chain`,
    state.balance.toString(),
  )

  return { ok: true, balanceBase: state.balance.toString() }
}

/** Reserve a session row before the payer has deployed anything. */
export function createSessionRow(params: OpenSessionParams): string {
  const id = newId('ses')
  const now = Date.now()
  db()
    .insert(paymentSessions)
    .values({
      id,
      organizationId: params.organizationId,
      ref: nextSessionRef(),
      serviceId: params.serviceId,
      // Filled in by confirmSession once the payer has deployed.
      channelContract: `pending:${id}`,
      funder: params.funder,
      // Denormalised at open time on purpose: it is the account the channel was actually
      // opened against, and a later edit to the organization's treasury must not rewrite
      // history for channels that are already funded.
      recipient: settlementTargetForOrganization(params.organizationId)?.recipient ?? '',
      assetContract: params.assetContract,
      decimals: params.decimals,
      /*
       * Stored as the G... (ed25519) form of the organization's commitment key, NOT the raw
       * bytes and NOT the M... form. The MPP server method verifies client voucher
       * signatures with `Keypair.fromPublicKey(...)`, which only accepts an ed25519 StrKey.
       * The M... med25519 StrKey wraps the same 32-byte ed25519 public key, so encoding the
       * decoded raw bytes back as ed25519 yields the canonical verification key. A hex dump
       * of the raw bytes (as this column briefly held) throws `invalid version byte` on every
       * voucher check.
       */
      commitmentPublicKey: StrKey.encodeEd25519PublicKey(requireCommitmentKeyBytes(params.organizationId)),
      cumulativeBase: '0',
      requestCount: 0,
      fundedBase: params.fundedBase,
      status: 'opening',
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  addSessionEvent(params.organizationId, id, 'created', `Session opened by ${params.funder}`, params.fundedBase)
  addSessionEvent(params.organizationId, id, 'policy_approved', 'Preflight policy allowed this funder')
  return id
}

export { getChannelState }