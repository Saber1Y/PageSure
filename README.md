# PageSure

**Machine-payment gateway for APIs and digital services.**

PageSure sits between an application and the service it consumes, and turns HTTP `402 Payment
Required` into a real, machine-readable payment negotiation over Stellar. An agent makes an
ordinary HTTP request, gets a payment challenge, authorizes a Stellar transfer, and receives the
resource. Or it opens a funded payment session and makes many requests against one later
settlement.

The provider keeps control of who may reach their service.

```
Agent  ──▶  PageSure  ──▶  API
             │
             ├── payment    → Stellar MPP charge / channel
             └── policy     → allow, block, or hold
```

## What this is, and what it is not

PageSure is **the payment and policy layer that makes existing HTTP services consumable by
machines.**

It is not a search engine. It is not an API marketplace. It is not a wallet. Search is only the
first real upstream used to prove the system.

## Quick start

```bash
npm install
cp .env.example .env

npm run keys:generate        # creates testnet keypairs, writes them to .env
# fund the printed accounts (see below), then:
npm run contracts:build      # build one-way-channel WASM from source
npm run channels:deploy      # upload WASM, deploy the channel factory

npm run db:migrate
npm run db:seed

npm run dev
```

Run `npm run readiness` before exercising payment flows. It reports setup status without printing
keys or credential values and exits nonzero when a required check is missing.

### Funding testnet accounts

Testnet USDC has no public faucet API, so funding is manual. `npm run keys:generate` prints
exactly what to do:

1. XLM for fees via Friendbot: `https://friendbot.stellar.org/?addr=<PUBLIC_KEY>`
2. USDC SAC trustline via `https://lab.stellar.org/account/fund`
3. USDC balance via `https://faucet.circle.com` (choose **Stellar Testnet**)

## Using it

### One-off payment (charge)

```bash
curl "http://localhost:3000/v1/search?q=stellar+agentic+payments" \
  -H "X-Pagesure-Payer: GXXXX…"
```

The payer address is **declared and untrusted**. It selects a policy and can be refused early,
but it never authorises delivery. The response is:

- `402` with `WWW-Authenticate: Payment <challenge>` — nothing has been charged yet
- `202` — held for provider review; no payment, no service
- `403` — refused by policy; no payment, no service

The client signs a Soroban SAC transfer and retries with `Authorization: Payment <credential>`.
PageSure verifies it, settles it, calls the upstream, and returns the resource with
`Payment-Receipt` and `X-Pagesure-Payment-Tx`.

See the [charge setup and operation guide](docs/charge-guide.md) for provider configuration,
Testnet acceptance, and paid-but-undelivered handling.

### Payment sessions (channel)

Repeated small requests should not settle a transaction each. A session funds a one-way payment
channel once, then each call signs a cumulative commitment off-chain. Closing the channel pays
the recipient in **one** transaction. The payer owns the commitment key; the provider settlement
signer submits the payer's voucher with treasury authorization. A verified voucher may still be
collected if the upstream fails, and PageSure records that as charged-not-delivered.

```bash
POST /v1/market-data/session
  { "funder": "G…", "fundedBase": "1000000", "commitmentPublicKey": "G…" }

POST /v1/market-data/session/confirm
  { "sessionId": "ses_…", "channelContract": "C…" }
```

The payer signs the factory `open` invoke itself, so funds never sit in an account PageSure
controls. PageSure then verifies the deployed channel against chain before it can be used.
See the [session lifecycle guide](docs/channel-lifecycle.md) for provider setup, payer flow,
settlement and recovery.

## Architecture

```
Browser ──▶ Next.js (single Node process)
                │
                ├── /v1/:slug/*            the gateway
                │     resolve service
                │     → preflight policy   ENFORCEMENT POINT, nothing charged yet
                │     → MPP charge         402, or verified AND settled
                │     → authoritative policy  verified payer, may only tighten
                │     → upstream           real third-party API
                │     → metering + settlement
                │
                ├── /(app)/*              provider console
                └── /playground            agent runs a real paid request
```

### The gateway pipeline

Two facts shape it:

1. **In charge mode the SDK settles inside `verify()`.** A policy block applied *after*
   verification therefore cannot mean "no payment, no service". PageSure records it as a
   `charged_not_delivered` incident and shows it. It is not hidden, and no refund is claimed.
2. **The declared payer is untrusted.** It can be refused; it can never authorise an upstream
   call. Only the cryptographically verified credential can do that.

In session mode, the funder is fixed on-chain when the channel opens, so policy runs
authoritatively on every request and a blocked call never advances the cumulative. After voucher
verification the payer has authorized that cumulative; an upstream failure is therefore
recorded as charged-not-delivered and may be collected at settlement.

### Policy engine

Ordered checks. The first terminal result wins and every check before it is recorded.

| # | Check | Terminal |
|---|---|---|
| 1 | Service exists and is live | 404 |
| 2 | Service bound to this policy | BLOCK |
| 3 | Network allowed | BLOCK |
| 4 | Asset allowed | BLOCK |
| 5 | Wallet on denylist | BLOCK |
| 6 | Active grant for (policy, service, wallet) | ALLOW |
| 7 | Wallet on allowlist | ALLOW |
| 8 | Unknown wallet | policy's `unknownAction` |
| 9 | Per-request amount cap | REVIEW |
| 10 | Ungranted spend cap | REVIEW |
| 11 | Rolling 24h wallet cap | REVIEW |
| 12 | Rate limit | BLOCK |

The trace is stored on the request row and rendered verbatim by the Policy Evaluation screen, so
the UI never reconstructs a decision.

**REVIEW genuinely holds.** It is decided during preflight, where no payment exists: no challenge
is issued, nothing settles, the upstream is never called. Approving creates a **service-scoped,
expiring grant** — it never mutates the allowlist. Allowlist is a standing relationship; a grant
is temporary authorisation.

**This is a provider-defined access policy engine, not a regulatory compliance platform.**

### Money handling

All amounts are base-unit **strings** on the wire and **bigint** in code, matching what MPP puts
in the challenge. Floating point is never used for money.

## Deployment constraints

**PageSure requires a single long-running Node process with `Store.memory()`.**

The MPP `Store` needs a linearizable compare-and-set for charge dedup and channel cumulative
monotonicity. `Store.memory()` satisfies that within one process. The SDK's constructor verifies
that `store.update` exists — it cannot verify that `update` is a linearizable CAS, so an emulated
get-then-put passes the type check while silently dropping the guarantee.

**Serverless and multi-instance deployments are unsupported for channel state.** Each instance
would hold its own store and replay protection would fail open. Do not deploy this to Vercel.

For a multi-instance deployment, swap the store for one with real CAS (`Store.redis()`,
`Store.upstash()`, or a Postgres conditional `UPDATE … WHERE`). Out of scope here, documented so
the constraint is not lost.

`better-sqlite3` is a native module, so deployment also needs a Node server or a Docker image
with build tooling.

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # next build
npm run mpp:audit    # installed MPP surface + EVM-unreachability proof
```

`npm run mpp:audit` exists because the published npm tarball of `@stellar/mpp` and the unreleased
`main` branch both declare version `0.7.1` with **different peer ranges and different APIs**.
Everything here is written against the installed surface, recorded in [`docs/mpp-api.md`](docs/mpp-api.md).

## Dependencies, and why they are pinned

```jsonc
"@stellar/mpp"         "0.7.1"    // exact. Peer: mppx ^0.6.29, stellar-sdk ^15.1.0
"mppx"                 "0.6.31"
"@stellar/stellar-sdk" "15.1.0"
"viem"                 "^2.51.0"  // transitive peer of mppx
"overrides": { "axios": "1.20.0" }
```

- The upstream README says `mppx@^0.10.1`, which describes **unreleased `main`**. Installing that
  against the published SDK produces an unmet peer dependency and a genuine incompatibility.
- `axios` is overridden to `1.20.0` because `@stellar/stellar-sdk@15.1.0` pins `1.15.0` exactly,
  which carries ~30 advisories including several SSRF and MITM gadgets. Upgrading the Stellar SDK
  does **not** fix this; both 15.1.0 and 16.3.0 ship a vulnerable axios.
- `mppx@0.6.31` carries two gas-draining advisories that live in `mppx/dist/tempo/**`, the **EVM**
  method. PageSure uses `method: 'stellar'`. The audit script proves unreachability mechanically.

Full analysis with CVSS scores and reachability reasoning: [`docs/dependency-security.md`](docs/dependency-security.md).

## Honest limits

Stated plainly, because a demo that overstates itself is worse than one that does less:

- **Charge mode can charge without delivering.** A post-verification policy block happens after
  settlement. Bounded by `ungrantedSpendCapBase`, recorded as an incident, never hidden. No
  auto-refund is implemented.
- **Session mode has limited testnet evidence.** A funded channel delivered four requests and
  settled in one close; a separate run observed and recorded a charged-not-delivered upstream
  failure. The target of `147 delivered requests between channel open and one close settlement`
  remains unverified. Opening is a separate on-chain transaction.
- **Independent-payer key separation still needs review.** The payer supplies its commitment
  public key and signs vouchers; the provider signer submits those vouchers using treasury
  authority only. Offline proofs and a funded Testnet flow pass, but keep sessions on Testnet
  until an independent review passes. The local demo runner stores its demo payer seed in `.env`.
- **One-off charge settlement still needs Testnet evidence.** The charge gateway's offline proof
  passes, but the seeded treasury must be verified before the live MPP runner can proceed.
- **Upstream providers must be real.** Strict mode is the default; an unconfigured provider
  returns `503` naming the missing environment variable. Local fallbacks exist for development
  only, behind `PAGESURE_ALLOW_LOCAL_UPSTREAM=1`.
- **This is not a compliance product.** The policy engine enforces what a provider configures. It
  performs no sanctions screening.
- **Single process only**, as described above.

## Layout

```
src/app/v1/[slug]/        the gateway: charge, session open, session confirm
src/app/(app)/            provider console
src/app/playground/       agent runs a real paid request
src/lib/policy/           engine, types, review lifecycle, read model
src/lib/mpp/              shared Store, per-service method registry
src/lib/sessions/         channel lifecycle and on-chain verification
src/lib/upstream/         strict-mode provider adapters
src/lib/metering/         single writer plus every dashboard aggregate
scripts/                  audit, key generation, contract build and deploy
docs/                     installed API surface, channel lifecycle, dependency security
```

See [`TODO.md`](./TODO.md) for the staged end-to-end rollout and the evidence still needed.
