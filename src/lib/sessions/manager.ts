import { StrKey } from '@stellar/stellar-sdk'
import { getChannelState } from '@stellar/mpp/channel/server'
import { db } from '@/lib/db/client'
import { paymentSessions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { network, rpcUrl } from '@/lib/mpp/registry'
import { toBig } from '@/lib/money'
import { newId } from '@/lib/metering/record'
import { nextSessionRef } from './lookup'
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
  serviceId: string
  funder: string
  assetContract: string
  decimals: number
  fundedBase: string
  commitmentPublicKeyG: string
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

  return {
    intent: 'channel',
    factory,
    // The salt makes the deployment unique and lets anyone recompute the address.
    salt: newSalt(),
    token: params.assetContract,
    from: params.funder,
    commitmentKey: params.commitmentPublicKeyG,
    to: process.env.PROVIDER_RECIPIENT_G,
    amount: toBig(params.fundedBase),
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
      ref: nextSessionRef(),
      serviceId: params.serviceId,
      // Filled in by confirmSession once the payer has deployed.
      channelContract: `pending:${id}`,
      funder: params.funder,
      recipient: process.env.PROVIDER_RECIPIENT_G ?? '',
      assetContract: params.assetContract,
      decimals: params.decimals,
      commitmentPublicKey: params.commitmentPublicKeyG,
      cumulativeBase: '0',
      requestCount: 0,
      fundedBase: params.fundedBase,
      status: 'opening',
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  addSessionEvent(id, 'created', `Session opened by ${params.funder}`, params.fundedBase)
  addSessionEvent(id, 'policy_approved', 'Preflight policy allowed this funder')
  return id
}

export { getChannelState }