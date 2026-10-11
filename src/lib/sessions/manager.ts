import { Address, StrKey, rpc, xdr } from '@stellar/stellar-sdk'
import { getChannelState } from '@stellar/mpp/channel/server'
import { SOROBAN_RPC_URLS } from '@stellar/mpp'
import { db } from '@/lib/db/client'
import { paymentSessions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { network, rpcUrl } from '@/lib/mpp/registry'
import { toBig } from '@/lib/money'
import { newId } from '@/lib/metering/record'
import { nextSessionRef } from './lookup'
import { settlementTargetForOrganization } from '@/lib/mpp/settlement'
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
  commitmentPublicKey: string
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
    // The funder owns this key and signs each voucher. The provider receives signatures,
    // not the private key; it can collect only an amount the funder authorized.
    // The factory takes raw BytesN<32>, not the G... StrKey encoding.
    commitmentKey: Buffer.from(StrKey.decodeEd25519PublicKey(params.commitmentPublicKey)).toString('hex'),
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
  let commitmentPublicKeyG: string
  try {
    commitmentPublicKeyG = await readCommitmentPublicKey(input.channelContract)
  } catch (error) {
    return { ok: false, reason: `could not read channel commitment key: ${(error as Error).message}` }
  }
  if (commitmentPublicKeyG !== input.expected.commitmentPublicKeyG) {
    return {
      ok: false,
      reason: `channel commitment key is ${commitmentPublicKeyG}, expected ${input.expected.commitmentPublicKeyG}`,
    }
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

/** Read the immutable CommitmentKey from the contract's instance storage. */
async function readCommitmentPublicKey(channelContract: string): Promise<string> {
  const url = rpcUrl() ?? SOROBAN_RPC_URLS[network()]
  const server = new rpc.Server(url)
  const contractId = Address.fromString(channelContract)
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractId.toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
  const response = await server.getLedgerEntries(instanceKey)
  const entry = response.entries?.[0]
  const storage = entry?.val.contractData()?.val()?.instance()?.storage()
  if (!storage) throw new Error('contract instance storage is missing')

  for (const item of storage) {
    const key = item.key()
    const keyVector = key.vec()
    if (
      key.switch().value === xdr.ScValType.scvVec().value &&
      keyVector?.length === 1 &&
      keyVector[0]?.switch().value === xdr.ScValType.scvSymbol().value &&
      keyVector[0]?.sym()?.toString() === 'CommitmentKey'
    ) {
      const rawKey = item.val().bytes()
      if (rawKey.length !== 32) throw new Error(`stored key is ${rawKey.length} bytes, expected 32`)
      return StrKey.encodeEd25519PublicKey(Buffer.from(rawKey))
    }
  }
  throw new Error('CommitmentKey is not present in contract instance storage')
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
      // Retain the funder's G... key used by the MPP server to verify vouchers.
      commitmentPublicKey: params.commitmentPublicKey,
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
