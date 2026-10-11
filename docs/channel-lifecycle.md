# Channel session lifecycle

This guide describes the channel-mode path implemented by PageSure. A four-request Testnet flow
and a paid-undelivered recovery have been observed; see the evidence in `docs/testing-guide.md`.

The [upstream channel repository](https://github.com/stellar-experimental/one-way-channel) labels
its contracts experimental and unaudited. Its documented lifecycle allows the recipient to
settle or close with a valid payer commitment, while the funder can start a delayed close and
refund the remaining balance after the waiting period. The recipient must monitor the close event
and collect before the funder refunds. A channel close attempts to return unused funds to the
funder, but that transfer is best effort; if it fails, the funder must call `refund` separately.

**Launch policy:** PageSure channel mode is Testnet-only. Do not handle mainnet or otherwise
meaningful funds until an independent contract audit and an independent review of payer/provider
key separation both pass, and recovery behavior has been exercised. This policy applies even
though the current Testnet lifecycle has passed; the contract's unaudited status remains a
material risk.

## Actors and key ownership

- **Payer/funder:** funds the channel and owns its Stellar account key and the private key
  corresponding to the channel's commitment public key. The payer's commitment signature is what
  authorizes the recipient to collect a cumulative amount.
- **Provider/recipient:** owns the receiving treasury account and its Stellar account key, which
  authorizes payout to that treasury. It receives the payer-signed commitments.
- **PageSure:** applies policy, verifies vouchers, calls the upstream, and records delivered
  cumulative usage. It must not receive the payer's account or commitment private key.

The current implementation now takes the payer's commitment public key when opening a session,
stores the latest accepted voucher signature, and has the provider signer verify and submit that
signature using treasury authority only. The earlier proof runner shared its seed between the
two processes; that wiring has been removed. This new boundary still needs a security proof and a
funded testnet run before independent payers should rely on it.

## One-time provider setup

1. Configure the Stellar network and Soroban RPC in `.env`.
2. Build the channel and factory WASM from the upstream source and retain the commit and hashes
   recorded in `contracts/BUILD_PROVENANCE`:

   ```bash
   npm run contracts:build
   ```

3. Configure a funded deployment/fee-payer account and the factory administrator, then deploy:

   ```bash
   npm run channels:deploy
   ```

   The deploy script writes `CHANNEL_WASM_HASH` and `CHANNEL_FACTORY_C` into `.env`, then reads
   the factory administrator and WASM hash back from chain. Keep those values alongside the
   recorded build provenance.

4. Configure the organization treasury and verify control of it in Settings. Register the
   organization's external signer URL and token environment variable. The signer needs the
   treasury account key; it must not receive the payer's commitment seed.
5. Configure a real upstream. Strict upstream mode returns an error when the provider credential
   is absent; do not treat the development fallback as delivery proof.
6. Create a service with **Session** payment mode and attach an active policy allowing the
   selected Stellar network and USDC asset. The service form supports this mode; the organization
   must still have the channel and signer configuration above.

## Payer and request lifecycle

1. The payer asks `POST /v1/:slug/session` for open instructions, with a funder address, its
   commitment public key, and a positive `fundedBase` amount. PageSure applies policy before returning instructions. A block
   or review response opens no channel and moves no funds.
2. The payer signs and submits the factory `open` contract invocation using its own account.
   This deploys and funds the one-way channel; funds do not pass through a PageSure-controlled
   wallet.
3. The payer calls `POST /v1/:slug/session/confirm` with the reserved session id, resulting
   channel contract id, and open transaction hash. PageSure reads the channel from Stellar and
   verifies the funder, recipient, token, and commitment-key configuration before activating it.
4. For the first service request, declare the channel with `X-Pagesure-Channel`. The MPP client
   receives a `402` challenge, signs the requested cumulative commitment, and retries with its
   credential. Later requests present their voucher credentials.
5. PageSure applies policy using the funder read from the confirmed channel. A policy block
   happens before voucher verification and advances nothing. After voucher verification,
   PageSure stores the payer's exact signature and cumulative before calling the upstream. If
   the upstream fails, PageSure records a charged-not-delivered incident; that signed amount
   may still be collected at close. Investigate the incident before settlement.
6. At settlement, the recipient submits the latest payer-authorized commitment with the
   treasury's required on-chain authorization. The signer fetches the payer signature from the
   authenticated settlement intent and verifies it against the session public key before closing.
   PageSure verifies the on-chain result before marking the session settled.

The signed voucher is an off-chain cumulative authorization. The payer can fund the channel once
and the provider can collect its authorized cumulative amount in a later close transaction.
An upstream failure after voucher verification can make some of that amount payable without
delivery.
Do not describe the result as “N requests → 1 transaction” without separately accounting for the
channel-open transaction; the intended claim is N paid requests between channel open and one
settlement close.

## Local end-to-end runner

The repository provides a testnet runner; it now keeps the payer commitment seed out of the
provider signer process:

```bash
npm run e2e:session -- prepare
# Restart the app so it loads the newly written environment values.
npm run e2e:session -- run
```

`prepare` writes generated demo secrets to `.env` and provisions local demo data. Review the
script before using it with any non-testnet account. The `run` step funds and opens a channel,
sends requests through the gateway, and closes through the signer. Set `E2E_REQUESTS` and
`E2E_FUNDED_BASE` together: funding must cover `requests × service price` plus any desired unused
balance. A successful run must be checked against chain and database records; merely completing
the script is not sufficient evidence if any of its assertions or verification steps are skipped.

## Failure and recovery checks

- **Abandoned `opening` session:** keep the session row for investigation. Compare its reserved
  funder, recipient, asset, and commitment key with the payer's open-transaction hash and on-chain
  contract state. Do not submit another open or change the row to active until the first attempt
  is accounted for. If no transaction was submitted, start a new reservation after confirming the
  payer was not charged. There is no automatic expiry/reaper yet.
- If opening fails before submission, check testnet funds, USDC trustline, factory id, and
  `CHANNEL_WASM_HASH`.
- If a transaction was submitted but confirmation timed out, check its hash on Stellar before
  retrying. Do not blindly submit another open transaction.
- If confirmation fails, compare on-chain channel fields to the reserved session. Do not mark a
  mismatched channel active.
- If the signer is unavailable, the channel remains funded and unsettled. Restore signer access
  and reconcile the current channel state before requesting another close.
- If the signer submitted a close but PageSure timed out before confirmation, use the transaction
  hash with the configured Soroban RPC and inspect the channel and settlement before retrying.
  A timeout is not evidence that the transaction failed.
- Reconcile session cumulative, paid request rows, settlement amount, and the on-chain withdrawal
  before calling the run successful.

## Protocol references

- [Stellar MPP SDK](https://github.com/stellar/stellar-mpp-sdk) documents the charge and channel
  method surfaces and describes one-way channels as cumulative off-chain commitments followed by
  on-chain settlement. PageSure pins an older published SDK surface; consult `docs/mpp-api.md`
  before copying examples from the moving upstream branch.
- [One-way-channel contract](https://github.com/stellar-experimental/one-way-channel) is the
  contract source built by the repository script.
- [Stellar transaction simulation guide](https://developers.stellar.org/docs/build/guides/transactions/simulateTransaction-Deep-Dive)
  explains how Soroban invocation simulation detects errors and returns transaction resources
  before submission.
