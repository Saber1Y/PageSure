/**
 * Settlement completion: PageSure accepting an on-chain channel close after the fact.
 *
 * The organization's signer service signs the cumulative and submits `close()` itself - PageSure
 * stores neither the treasury secret nor the commitment key. Once the transaction lands the
 * signer reports the tx hash back here, and this module decides whether the session may move to
 * `closed`.
 *
 * The report is never taken on its own word. Everything is re-derived from chain:
 *
 *   - the transaction exists and succeeded
 *   - it invokes `close()` on THIS session's channel, not some other contract
 *   - the SAC transfer events inside it pay THIS session's recorded recipient exactly the
 *     cumulative PageSure recorded - the number the signer was told to sign, never a number
 *     the caller supplied
 *   - the channel is drained and still points at the recorded funder, recipient and token
 *
 * Only then are the settlement row written, the session closed, and the timeline updated.
 * A session that is already closed completes idempotently when the same transaction is
 * reported again, and refuses a different one.
 */

import { Address, Networks, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { getChannelState } from '@stellar/mpp/channel/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { paymentSessions, settlements, services } from '@/lib/db/schema'
import { rpcUrl } from '@/lib/mpp/registry'
import { recordSettlement, recordActivity } from '@/lib/metering/record'
import { addSessionEvent } from '@/lib/sessions/gateway'
import { formatAmount } from '@/lib/money'

export type SettlementCompleteFailure = 'session_not_found' | 'not_settleable' | 'settlement_unverified'

export class SettlementCompleteError extends Error {
  readonly failure: SettlementCompleteFailure

  constructor(failure: SettlementCompleteFailure, message: string) {
    super(message)
    this.name = 'SettlementCompleteError'
    this.failure = failure
  }
}

export interface CompleteSettlementInput {
  organizationId: string
  sessionId: string
  /** 64-hex transaction hash of the on-chain close, reported by the signer. */
  txHash: string
  network: 'stellar:testnet' | 'stellar:pubnet'
}

export interface CompleteSettlementResult {
  sessionId: string
  status: 'closed'
  settlementId: string
  txHash: string
  cumulativeBase: string
}

const PASSPHRASE: Record<CompleteSettlementInput['network'], string> = {
  'stellar:testnet': Networks.TESTNET,
  'stellar:pubnet': Networks.PUBLIC,
}

interface SessionRow {
  id: string
  organizationId: string
  serviceId: string
  channelContract: string
  funder: string
  recipient: string
  assetContract: string
  assetCode: string
  decimals: number
  cumulativeBase: string
  requestCount: number
  status: string
  settlementId: string | null
}

function loadSession(organizationId: string, sessionId: string): SessionRow {
  const session = db()
    .select({
      id: paymentSessions.id,
      organizationId: paymentSessions.organizationId,
      serviceId: paymentSessions.serviceId,
      channelContract: paymentSessions.channelContract,
      funder: paymentSessions.funder,
      recipient: paymentSessions.recipient,
      assetContract: paymentSessions.assetContract,
      assetCode: services.assetCode,
      decimals: paymentSessions.decimals,
      cumulativeBase: paymentSessions.cumulativeBase,
      requestCount: paymentSessions.requestCount,
      status: paymentSessions.status,
      settlementId: paymentSessions.settlementId,
    })
    .from(paymentSessions)
    .innerJoin(services, eq(paymentSessions.serviceId, services.id))
    .where(eq(paymentSessions.id, sessionId))
    .get() as SessionRow | undefined

  // Tenant boundary, same wording as the intent endpoint: a valid token for one organization
  // cannot probe another organization's session ids.
  if (!session || session.organizationId !== organizationId) {
    throw new SettlementCompleteError('session_not_found', 'no session exists with that id')
  }
  return session
}

/** The settlement row for a given session and transaction, if this completion already ran. */
function priorCompletion(sessionId: string, txHash: string): CompleteSettlementResult | null {
  const prior = db()
    .select({ id: settlements.id, cumulativeBase: settlements.amountBase })
    .from(settlements)
    .where(and(eq(settlements.sessionId, sessionId), eq(settlements.txHash, txHash)))
    .get()
  if (!prior) return null
  return {
    sessionId,
    status: 'closed',
    settlementId: prior.id,
    txHash,
    cumulativeBase: prior.cumulativeBase,
  }
}

function unverified(detail: string): never {
  throw new SettlementCompleteError('settlement_unverified', detail)
}

/** One SAC transfer topic, normalised to a plain string ('transfer', G... or C...). */
function topicAt(event: { topic: xdr.ScVal[] }, index: number): string {
  try {
    const topic = event.topic[index]
    if (!topic) return ''
    const value = scValToNative(topic)
    if (value === undefined || value === null) return ''
    return value instanceof Address ? value.toString() : String(value)
  } catch {
    return ''
  }
}

function eventAmount(event: { value: xdr.ScVal }): bigint | null {
  try {
    const value = scValToNative(event.value)
    return typeof value === 'bigint' ? value : null
  } catch {
    return null
  }
}

/** Does this transaction invoke `close()` on the expected channel? */
function invokesCloseOn(
  envelope: unknown,
  network: CompleteSettlementInput['network'],
  channelContract: string,
): boolean {
  let transaction
  try {
    // The RPC layer hands back a decoded envelope object; a raw base64 string is also accepted.
    transaction = TransactionBuilder.fromXDR(
      envelope as string | xdr.TransactionEnvelope,
      PASSPHRASE[network],
    )
  } catch {
    unverified('the settlement transaction envelope could not be decoded')
  }
  return transaction.operations.some((operation) => {
    if (operation.type !== 'invokeHostFunction') return false
    const func = (operation as unknown as { func?: xdr.ScVal | { switch(): { name: string }; invokeContract(): xdr.InvokeContractArgs } }).func
    if (!func || typeof (func as { switch?: unknown }).switch !== 'function') return false
    const hostFunction = func as { switch(): { name: string }; invokeContract(): xdr.InvokeContractArgs }
    if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract') return false
    const args = hostFunction.invokeContract()
    const functionName = Buffer.from(args.functionName() as unknown as Uint8Array).toString('utf8')
    if (functionName !== 'close') return false
    return Address.fromScAddress(args.contractAddress()).toString() === channelContract
  })
}

async function verifyOnChain(input: CompleteSettlementInput, session: SessionRow): Promise<number> {
  const url = rpcUrl()
  if (!url) unverified('no RPC endpoint is configured, so the settlement cannot be verified')
  const server = new rpc.Server(url, { allowHttp: url.startsWith('http://') })

  let transaction
  try {
    transaction = await server.getTransaction(input.txHash)
  } catch (error) {
    unverified(`settlement transaction ${input.txHash} could not be read: ${(error as Error).message}`)
  }
  if (transaction.status !== 'SUCCESS') {
    unverified(`settlement transaction ${input.txHash} is ${transaction.status}, not SUCCESS`)
  }
  if (!('envelopeXdr' in transaction)) {
    unverified(`settlement transaction ${input.txHash} has no decodable envelope`)
  }
  if (!invokesCloseOn(transaction.envelopeXdr, input.network, session.channelContract)) {
    unverified(
      `transaction ${input.txHash} does not invoke close() on channel ${session.channelContract}`,
    )
  }

  // The payout itself: the recorded cumulative moving from the channel to the recorded
  // recipient inside THIS transaction. This is what ties PageSure's number to the chain -
  // the signature over it never passes through PageSure.
  const expected = BigInt(session.cumulativeBase)
  let events
  try {
    events = await server.getEvents({
      filters: [{ type: 'contract', contractIds: [session.assetContract] }],
      startLedger: transaction.ledger,
      endLedger: transaction.ledger + 1,
    })
  } catch (error) {
    unverified(`could not read events for ledger ${transaction.ledger}: ${(error as Error).message}`)
  }
  const payout = events.events.some(
    (event) =>
      event.txHash === input.txHash &&
      topicAt(event, 0) === 'transfer' &&
      topicAt(event, 1) === session.channelContract &&
      topicAt(event, 2) === session.recipient &&
      eventAmount(event) === expected,
  )
  if (!payout) {
    unverified(
      `transaction ${input.txHash} has no transfer of the recorded ${session.cumulativeBase} base units ` +
        `from channel ${session.channelContract} to ${session.recipient}`,
    )
  }

  // The channel must be drained and still wired to the parties the session recorded; a close
  // that redirected the token or the recipient would not match the session either.
  let state
  try {
    state = await getChannelState({ channel: session.channelContract, network: input.network, rpcUrl: url })
  } catch (error) {
    unverified(`could not read channel state: ${(error as Error).message}`)
  }
  if (state.closeEffectiveAtLedger === null) {
    unverified('the channel has no effective close on chain')
  }
  if (state.balance !== 0n) {
    unverified(`the channel still holds ${state.balance} base units; it has not been fully settled`)
  }
  if (state.from !== session.funder) {
    unverified(`the channel funder is ${state.from}, the session recorded ${session.funder}`)
  }
  if (state.to !== session.recipient) {
    unverified(`the channel recipient is ${state.to}, the session recorded ${session.recipient}`)
  }
  if (state.token !== session.assetContract) {
    unverified(`the channel token is ${state.token}, the session recorded ${session.assetContract}`)
  }

  return transaction.ledger
}

export async function completeSettlement(
  input: CompleteSettlementInput,
): Promise<CompleteSettlementResult> {
  const session = loadSession(input.organizationId, input.sessionId)

  if (session.status === 'closed') {
    const prior = priorCompletion(session.id, input.txHash)
    if (prior) return prior
    throw new SettlementCompleteError(
      'not_settleable',
      `session is closed by ${session.settlementId ?? 'another settlement'}, not by transaction ${input.txHash}`,
    )
  }
  if (session.status !== 'settling') {
    throw new SettlementCompleteError(
      'not_settleable',
      `session is ${session.status}; only a settling session can be completed. Fetch the settlement intent first.`,
    )
  }

  const ledger = await verifyOnChain(input, session)

  // Verification above awaited; re-read the session synchronously before writing so a
  // concurrent completion of the same session cannot slip between the check and the write.
  const current = loadSession(input.organizationId, input.sessionId)
  if (current.status === 'closed') {
    const prior = priorCompletion(current.id, input.txHash)
    if (prior) return prior
    throw new SettlementCompleteError('not_settleable', 'the session was completed by another settlement')
  }
  if (current.status !== 'settling') {
    throw new SettlementCompleteError('not_settleable', `session is ${current.status}; it is no longer settling`)
  }

  const now = Date.now()
  const settlementId = recordSettlement({
    organizationId: input.organizationId,
    kind: 'session',
    requestId: null,
    sessionId: session.id,
    requestCount: session.requestCount,
    amountBase: session.cumulativeBase,
    assetContract: session.assetContract,
    assetCode: session.assetCode,
    decimals: session.decimals,
    payer: session.funder,
    recipient: session.recipient,
    network: input.network,
    txHash: input.txHash,
    status: 'confirmed',
    ledger,
  })

  db()
    .update(paymentSessions)
    .set({ status: 'closed', settlementId, closedAt: now, updatedAt: now })
    .where(eq(paymentSessions.id, session.id))
    .run()

  addSessionEvent(
    input.organizationId,
    session.id,
    'settled',
    `Channel closed on chain; ${formatAmount(session.cumulativeBase, session.decimals)} ${session.assetCode} ` +
      `paid to ${session.recipient} (tx ${input.txHash})`,
    session.cumulativeBase,
  )

  recordActivity({
    organizationId: input.organizationId,
    type: 'session_settled',
    ok: true,
    message: `Session settled: ${formatAmount(session.cumulativeBase, session.decimals)} ${session.assetCode} to treasury via tx ${input.txHash}`,
    serviceId: session.serviceId,
    sessionId: session.id,
    amountBase: session.cumulativeBase,
    assetCode: session.assetCode,
    decimals: session.decimals,
  })

  return {
    sessionId: session.id,
    status: 'closed',
    settlementId,
    txHash: input.txHash,
    cumulativeBase: session.cumulativeBase,
  }
}
