import { Account, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk'
import { network, rpcUrl } from '@/lib/mpp/registry'

/**
 * Can this settlement account receive this asset at all?
 *
 * A Stellar account receives a classic asset such as USDC only after it holds a trustline for
 * it. Without one the payer's transfer fails inside the token contract, and what reaches the
 * agent is `Error(Contract, #13) trustline entry is missing` - after the policy allowed the call
 * and the payer signed. That is the first thing a new provider hits: a fresh wallet funded with
 * XLM and nothing else.
 *
 * The check simulates the token contract's `balance(recipient)`, which fails the same way for
 * a missing trustline, so it works for any Stellar Asset Contract without knowing the classic
 * asset behind it. Simulation touches no state and costs no fee.
 *
 * Answers are cached: a receivable account stays receivable, so a positive answer is kept for
 * ten minutes; a negative one only for thirty seconds, so adding the trustline takes effect on
 * the next attempt. An RPC failure is not an answer and is never cached as one: the caller
 * proceeds, and the payment itself remains the authority.
 */

export type Receivability =
  | { ok: true }
  | { ok: false; reason: 'no_account' | 'no_trustline'; detail: string }
  | { ok: null; detail: string }

const POSITIVE_TTL_MS = 10 * 60_000
const NEGATIVE_TTL_MS = 30_000
const cache = new Map<string, { at: number; value: Receivability }>()

// Any well-formed account works as a simulation source; it is never charged or submitted.
const SIMULATION_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'

export async function recipientCanReceive(recipient: string, assetContract: string): Promise<Receivability> {
  const key = `${network()}:${assetContract}:${recipient}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < (hit.value.ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit.value

  const url = rpcUrl()
  if (!url) return { ok: null, detail: 'STELLAR_RPC_URL is not set' }

  let value: Receivability
  try {
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: network() === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET,
    })
      .addOperation(new Contract(assetContract).call('balance', nativeToScVal(recipient, { type: 'address' })))
      .setTimeout(30)
      .build()
    const result = await new rpc.Server(url).simulateTransaction(tx)
    if (rpc.Api.isSimulationSuccess(result)) {
      value = { ok: true }
    } else {
      const error = rpc.Api.isSimulationError(result) ? result.error : ''
      if (/trustline entry is missing/i.test(error)) {
        // The token contract reports a missing trustline for an account that does not exist at
        // all, too. The two need different first steps, so tell them apart.
        const exists = await new rpc.Server(url).getAccount(recipient).then(() => true, () => false)
        value = { ok: false, reason: exists ? 'no_trustline' : 'no_account', detail: error.slice(0, 300) }
      } else {
        return { ok: null, detail: error.slice(0, 300) || 'simulation did not succeed' }
      }
    }
  } catch (error) {
    return { ok: null, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) }
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Plain instructions for the provider, shared by the gateway response and the Settings page. */
export function receivabilityAdvice(reason: 'no_account' | 'no_trustline', assetCode: string): string {
  return reason === 'no_account'
    ? `The settlement account does not exist on Stellar yet. Fund it with XLM first (on Testnet, Freighter's "Fund with Friendbot"), then add ${assetCode} under Manage assets.`
    : `The settlement account cannot receive ${assetCode} yet. In the wallet, open Manage assets, add ${assetCode}, and approve the trustline.`
}
