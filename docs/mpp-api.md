# Installed MPP API surface (PageSure)

**This file is generated from what is actually installed, not from documentation or the `main` branch.**
Regenerate/verify with `npm run mpp:audit`.

The reason this file exists: the published npm tarball of `@stellar/mpp` and the unreleased
`main` branch of the same repository both declare version `0.7.1` with **different peer
dependency ranges and different behaviour**. Everything in PageSure is written against the
installed surface recorded here.

## Versions (installed, verified)

| Package | Installed | Notes |
|---|---|---|
| `@stellar/mpp` | 0.7.1 | npm `latest`. Peer range: `mppx ^0.6.29`, `@stellar/stellar-sdk ^15.1.0` |
| `mppx` | 0.6.31 | Highest satisfying `^0.6.29` |
| `@stellar/stellar-sdk` | 15.1.0 | Only published 15.x |
| `zod` | 4.6.5 | Required by mppx and `@stellar/mpp` |
| `axios` | 1.20.0 (overridden) | See [dependency-security.md](./dependency-security.md) |

## Peer-range trap

`README.md` on `main` instructs installing `mppx@^0.10.1` + `viem@^2.54.0`. That instruction
describes **unreleased `main`**, not the published package. Running

```
npm i @stellar/mpp mppx@^0.10.1
```

installs the published `@stellar/mpp@0.7.1` (which peers `mppx ^0.6.29`) against an mppx it was
never built for, producing an unmet peer dependency and a genuine incompatibility across the
`Mppx` / `Challenge` / `Credential` / `Receipt` / `Store` surface.

PageSure pins the **published** peer ranges instead. `viem` is still required as a transitive
peer of mppx, at floor `>=2.51.0` for mppx 0.6.x.

## Constants

```ts
STELLAR_TESTNET = 'stellar:testnet'   // CAIP-2. NOT the string 'testnet'.
STELLAR_PUBNET  = 'stellar:pubnet'
NETWORK_PASSPHRASE['stellar:testnet'] = Networks.TESTNET
SOROBAN_RPC_URLS['stellar:testnet']   = 'https://soroban-testnet.stellar.org'
HORIZON_URLS['stellar:testnet']       = 'https://horizon-testnet.stellar.org'

USDC_SAC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
DEFAULT_DECIMALS = 7
DEFAULT_CHALLENGE_EXPIRY = 300 (seconds)
```

Both official README server snippets use `network: 'testnet'`, which is **invalid**. Use
`'stellar:testnet'`.

## Unit helpers

Verified signatures (they return **strings**, not bigint):

```ts
toBaseUnits(amount: string, decimals: number): string      // '0.01', 7 -> '100000'
fromBaseUnits(baseUnits: string, decimals: number): string  // '100000', 7 -> '0.0100000'
```

`fromBaseUnits` takes a `string`, not a `bigint`, despite `close()` taking a `bigint` amount.

## Server: charge

`import { stellar, charge, resolveKeypair, Expires, Mppx, Store } from '@stellar/mpp/charge/server'`

```ts
stellar.charge({
  recipient: string            // required, G...
  currency: string             // required, SEP-41 contract C...
  store: Store.AtomicStore     // REQUIRED. Constructor throws without it.
  decimals?: number            // default 7
  network?: 'stellar:testnet' | 'stellar:pubnet'
  rpcUrl?: string
  feePayer?: { envelopeSigner: Keypair | string, feeBumpSigner?: Keypair | string }
  maxFeeBumpStroops?: number   // default 10_000_000
  pollMaxAttempts?: number     // 20
  pollMaxConcurrent?: number   // 10
  pollDelayMs?: number         // 1000
  pollTimeoutMs?: number       // 20_000
  simulationTimeoutMs?: number // 10_000
  allowUnsignedPush?: boolean  // default false
  maxPushPaymentAgeSeconds?: number // 900
  challengeLifetimeSeconds?: number // 300
  logger?: Logger
})
```

### Per-request flow

```ts
const result = await mppx.charge({ amount: '0.01', description: '...' })(request)
if (result.status === 402) return result.challenge  // a Response with headers already set
return result.withReceipt(Response.json({ ... }))  // sets Payment-Receipt
```

`result.challenge` is status 402 with `WWW-Authenticate: Payment <challenge>` and
`Cache-Control: no-store`. `result.withReceipt(res)` clones `res` and sets `Payment-Receipt`.

### Credential shape

`Authorization: Payment <base64url>` (or `Payment-Authorization`). Decoded JSON:

```ts
{
  challenge: { id, realm, method: 'stellar', intent: 'charge', request: '<base64url JCS>', expires },
  payload: { type: 'transaction', transaction: '<base64 XDR>' }
          | { type: 'signedHash', hash: string, sourceSignature: string }
          | { type: 'hash', hash: string },          // legacy, needs allowUnsignedPush
  source: 'did:pkh:stellar:testnet:GABC...'          // <-- payer identity, used by PageSure policy
}
```

`type: 'transaction'` is **pull** (server broadcasts the signed tx). `signedHash` is **push**
(client broadcasts, server verifies). `source` is present on all three and is what PageSure
decodes pre-flight to choose a policy. It is **advisory** until mppx verifies the credential.

### Request object inside the challenge (base64url, JCS)

```json
{
  "amount": "100000",
  "currency": "CBIELT…",
  "recipient": "G…",
  "description": "…",
  "externalId": "…",
  "methodDetails": { "network": "stellar:testnet", "feePayer": true, "credentialTypes": ["transaction"] }
}
```

`amount` is in **base units**. `methodDetails.feePayer` appears only when `feePayer` is configured.

## Server: channel (the "session" intent)

> The wire intent is `channel`. The docs page is titled "Session Guide"; the string is `channel`.

`import { channel, close, getChannelState, stellar, watchChannel } from '@stellar/mpp/channel/server'`

```ts
stellar.channel({
  channel: string               // required, an ALREADY-DEPLOYED C...
  commitmentKey: string | Keypair // required, G... ed25519 pubkey matching the channel's commitment_key
  store: Store.AtomicStore      // REQUIRED
  checkOnChainState?: boolean   // default true
  recipient?: string            // expected on-chain payout; startup warning if omitted
  currency?: string             // expected token; startup warning if omitted
  sourceAccount?: string
  feePayer?: { envelopeSigner, feeBumpSigner? }
  feeBudget?: { maxStroops: number, windowMs: number }
  onDisputeDetected?: (state: ChannelState) => void
  decimals?: number
  network?: NetworkId
  rpcUrl?: string
  maxFeeBumpStroops?: number    // default 10_000_000
  pollMaxAttempts?: number
  pollMaxConcurrent?: number
  pollDelayMs?: number
  pollTimeoutMs?: number
  simulationTimeoutMs?: number
  verifyMaxConcurrent?: number  // default 10
  logger?: Logger
})
```

`close()` rejects `action: 'close'` credentials when no `feePayer.envelopeSigner` is configured.
PageSure always configures one (the provider wallet).

### State and settlement

```ts
getChannelState({ channel, network?, rpcUrl?, simulationTimeoutMs? })
  -> Promise<ChannelState>
// ChannelState = {
//   balance: bigint, refundWaitingPeriod: number, token: string,
//   from: string, to: string,
//   closeEffectiveAtLedger: number | null, currentLedger: number
// }

close({
  channel: string,
  amount: bigint,          // note: bigint here, string in toBaseUnits
  signature: Uint8Array,   // 64-byte ed25519 signature over the commitment bytes
  feePayer: { envelopeSigner, feeBumpSigner? },
  network?, rpcUrl?, maxFeeBumpStroops?, poll*, logger?
}) -> Promise<string /* tx hash */>
```

`close()` is **not** routed through `verify()`, so a `feeBudget` configured on the channel
server does not apply to it.

`watchChannel({ channel, network, rpcUrl, intervalMs, startLedger, onEvent, onError, signal })`
polls `getEvents`. Events: `open`, `close`, `withdraw`, `refund`.

### Channel deployment is out-of-band

There is **no MPP `open` action**. It was removed in 0.7 because the contract has no on-chain
`open` entrypoint. Deployment pattern (see [channel-lifecycle.md](./channel-lifecycle.md)):

```
one-way-channel WASM  → upload once, keep the hash
channel-factory       → __constructor(admin, channelWasmHash)      # one-time
                     → open(params)                                # one instance per session
                     → resulting C... passed to stellar.channel({ channel })
```

The commitment is an XDR `ScVal::Map` with four sorted keys: `amount` (I128), `channel`
(Address), `domain` (`chancmmt`), `network` (`BytesN<32>` network id). Domain separation means a
signature cannot be replayed across networks, channels, or payload types.

## Client

```ts
// charge client — import from '@stellar/mpp/charge/client'
stellar.charge({
  keypair?: Keypair, secretKey?: string, mode?: 'push' | 'pull', decimals?, rpcUrl?,
  timeout?, poll*, onProgress?, ...
})

// channel client — import from '@stellar/mpp/channel/client'
stellar.channel({
  commitmentKey?: Keypair, commitmentSecret?: string,   // one required; 64-hex raw ed25519 seed
  allowedChannels?: string[],        // PINNING REQUIRED unless allowUnpinnedChannel
  allowUnpinnedChannel?: boolean,
  rpcUrl?, simulationTimeoutMs?, store?, network?, onProgress?,
})
```

Both `Mppx.create()` calls polyfill global `fetch`, so 402 responses are handled transparently.

`commitmentSecret` is a **raw 64-hex ed25519 seed**, not an `S…` Stellar secret.
`Keypair.fromRawEd25519Seed(Buffer.from(hex,'hex'))` on the client;
`StrKey.encodeEd25519PublicKey(Buffer.from(hex,'hex'))` for the server's `commitmentKey`.

### Progress events

Charge client: `challenge` · `signing` · `signed` · `paying` · `confirming` · `paid`.

Channel client: `challenge` · `signing` · `signed` (only three).

PageSure's Playground waterfall is driven by these real events, not a scripted animation.

## Store requirement

Both servers **throw at construction** if `store` is missing or lacks `update()`. `update()` must
be a linearizable compare-and-set. The constructor verifies `update` exists; it cannot verify
correctness. An emulated get-then-put passes the type check while silently dropping the
guarantee.

- Single process: `Store.memory()`.
- Multi-process: `Store.redis()` / `Store.upstash()` / `Store.cloudflare()`, or a Redis Lua
  script, or a Postgres conditional `UPDATE … WHERE`.

PageSure shares **one** `Store.memory()` across every method instance. Store keys are namespaced
`stellar:charge:*` and `stellar:channel:*`, so sharing is what guarantees a tx hash or a channel
cumulative cannot settle twice across two different services.

**Deployment constraint: single long-running Node process.** Serverless or multi-instance with
`Store.memory()` is unsupported for channel state. See README.

## Errors

`StellarMppError`, `PaymentVerificationError`, `ChannelVerificationError`, `SettlementError`
(all from `@stellar/mpp`). Rejected credentials return 402 again; `SettlementError` surfaces as a
generic 500 and RPC error text is never echoed to the client.

## What this file is NOT

`docs/mpp-api.md` records the *installed* surface. It does not describe upstream `main`, does not
promise behaviour of future releases, and does not replace reading
`node_modules/@stellar/mpp/dist/**/*.d.ts` when something here looks wrong. When the two
disagree, the installed `.d.ts` wins and this file is wrong and must be corrected.