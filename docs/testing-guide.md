# Testing PageSure

A walkthrough of the whole product: the agent-facing gateway and its policy engine first, then the
provider console that configures it, then access control for that console.

It is written to be followed literally.
Every command in Parts 1 to 4 was run against this build, and the responses quoted are the
responses that came back.
Every "expect" is something the application asserts about itself.

Where something is unverified, this guide says so rather than describing it as though it works.
The short version: the gateway, the policy engine and the console are exercised here; anything
requiring a signature or on-chain settlement is not, because no funded Stellar account was
available.

## Contents

1. [Before you start](#before-you-start)
2. [What this product actually does](#what-this-product-actually-does)
3. [The two halves do not connect](#the-two-halves-do-not-connect)
4. [Mail: pick a mode before you start](#mail-pick-a-mode-before-you-start)
5. [Links point at localhost](#links-point-at-localhost)
6. [The throttle](#the-throttle)
7. [Part 1 - Seed the catalogue](#part-1---seed-the-catalogue)
8. [Part 2 - Call the gateway and watch the policy decide](#part-2---call-the-gateway-and-watch-the-policy-decide)
9. [Part 3 - Hold, approve, grant, retry](#part-3---hold-approve-grant-retry)
10. [Part 4 - Take the money](#part-4---take-the-money)
11. [Part 5 - Channel mode](#part-5---channel-mode)
12. [Part 6 - Read the console](#part-6---read-the-console)
13. [Part 7 - The playground](#part-7---the-playground)
14. [Part 8 - Console access](#part-8---console-access)
15. [Part 9 - Wallet, settlement account, signer](#part-9---wallet-settlement-account-signer)
16. [Part 10 - The automated suites](#part-10---the-automated-suites)
17. [Troubleshooting](#troubleshooting)
18. [What is not verified](#what-is-not-verified)

## Before you start

Requirements:

- Node 20 or newer.
- A Stellar **Testnet** account, only for Part 4 onwards.
  Parts 1 to 3, Part 6 and Part 8 work without one.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The console is then on <http://localhost:3000>.

`npm run db:migrate` is safe to run repeatedly.
It applies only the migrations the database has not seen, so run it after every `git pull`.

To start with an empty database, stop the server, delete `data/pagesure.db`, and re-run
`npm run db:migrate`.
A consistent backup can be taken while the server is running:

```bash
sqlite3 data/pagesure.db ".backup 'data/backups/pagesure-$(date +%Y%m%d-%H%M%S).db'"
```

## What this product actually does

PageSure is a **paywall for machine-to-machine API calls**.
An agent wants data from a third-party API.
Instead of an API key, it pays per call in Stellar USDC, and an access policy decides whether it
may.

The whole product is that loop:

```text
agent  ──▶  GET /v1/search?q=...
             │
             ├─▶ 402 Payment Required + MPP challenge   no money moved yet
             │      agent signs the challenge, retries with Authorization: Payment …
             │
             ├─▶ policy engine decides, in order, and records every check
             │      ALLOW   → charge settles, upstream is called, resource returned
             │      REVIEW  → held, no challenge, nothing settles, no upstream call
             │      BLOCK   → refused, no challenge, nothing settles
             │
             └─▶ the provider reads the decision, the trace and the money in the console
```

Two consequences shape everything else, and both are load-bearing rather than incidental:

- **The declared payer is untrusted.** The `X-Pagesure-Payer` header only selects a policy and can
  be refused early. It never authorises delivery. Only a cryptographically verified credential can.
- **REVIEW genuinely holds.** It is decided during preflight, before any payment object exists, so
  a held request is never billed and the upstream is never called.

Three payment shapes exist.
**Charge mode** settles one transaction per request.
**Session mode** funds a one-way channel once and settles once at the end.
Both are covered; only charge mode has been observed here.

## The two halves do not connect

Read this before Part 1, because it explains an empty console that otherwise looks broken.

There are two ways to get an organization in this product, and they produce **different
organizations that never meet**:

|                     | How you get it                            | Owns services? |
| ------------------- | ----------------------------------------- | -------------- |
| **Console sign-up** | Signing up through `/login`, as in Part 8 | **No**         |
| **Seed**            | `npm run db:seed`, as in Part 1           | **Yes**        |

There is **no user interface for creating a service or a policy.**
`insert(services)` and `insert(policies)` each appear exactly once in the codebase, both in
`src/lib/db/seed.ts`.
So the seeded `PageSure Demo` organization is the only one that can own a service.

The `Create service` link on `/services` is therefore a dead end: it points at `/services/new`, which
does not exist, and renders the console 404.

The practical effect: if you follow Part 8 first and create `Acme Research`, then open `/services`,
you will see `No services yet` - correctly, because that organization owns nothing. The services
belong to `org_demo`.

**To use the product, sign in as the seeded owner wallet.**
The seed stores no email for that user, so this means wallet sign-in, which needs Freighter
(Part 9).

Everything in Parts 1 to 5 below works from `curl` with no browser session at all, which is why
they come first.
Parts 6 and 8 need a console session, and reading the seeded services in the console needs the
seeded owner.

## Mail: pick a mode before you start

Email is the primary credential for the console, so Part 8 cannot be walked without a way to read
the link.
There are two modes, and choosing wrong is the single most common reason this guide appears to
describe a broken application.

|                        | **Mode A - console**              | **Mode B - real delivery**            |
| ---------------------- | --------------------------------- | ------------------------------------- |
| Set up                 | No `RESEND_API_KEY`               | `RESEND_API_KEY` set                  |
| Where the link appears | The server terminal               | A real inbox                          |
| Recipients             | **Any address**                   | **One address only** (see below)      |
| Needed for             | Multi-user and invitation testing | Confirming mail really leaves the app |

**Mode A is the default for testing**, and it is what Part 8 assumes.
With no key configured, and outside production, the link is printed instead of sent:

```text
[pagesure] email delivery is not configured; printing the signin message
[pagesure] to: owner@acme.test
[pagesure] link: http://localhost:3000/login/callback?token=...
```

Watch it with:

```bash
tail -f /tmp/ps-real.log
```

or wherever you redirected the server output.

That transport refuses to run when `NODE_ENV=production`, so a misconfigured deployment fails
loudly instead of printing live credentials into its logs.

**Mode B only works for one address, and that is not a limitation of this application.**
Resend's default sender, `onboarding@resend.dev`, is a sandbox: it delivers only to the address
registered on the Resend account.
Send to anything else and Resend answers `403` with

> You can only send testing emails to your own email address

For clarity, the messages that address names belong to the Resend account holder, not to
PageSure, and the application does not display it in the browser.

To send to arbitrary addresses, verify a domain you control in Resend - it issues SPF and DKIM
DNS records - and then set the sender:

```bash
MAIL_FROM="PageSure <login@your-domain.example>"
```

**This is why Mode A is the default for testing.**
An invitation is addressed to one specific person.
With Mode B you can only invite the single address that is already signed in as the owner, and
that person cannot accept their own invitation because they are already a member.
So the invitation flow in Part 8 is only walkable end to end in Mode A, or in Mode B with a
verified domain.

One more consequence of Mode B: the link is no longer printed anywhere.
The inbox becomes the only copy of the credential.

To switch modes, comment or uncomment `RESEND_API_KEY` in `.env` and restart the server.

### Links point at localhost

The emailed link is built from `PAGESURE_PUBLIC_ORIGIN`, falling back to `APP_URL`.
With the default `APP_URL=http://localhost:3000`, that link resolves only in a browser on the same
machine.
Opening it on a phone will fail to connect.
This is fine for local work and is the reason real-delivery testing needs this machine's browser.

`PAGESURE_PUBLIC_ORIGIN` wins when both are set, which is what a tunnel or proxy needs.
Either value must be `https`, or localhost: a sign-in link is a credential, and serving one over
plain HTTP puts it on the wire in the clear.

### The throttle

Sign-in requests and invitations are limited to **ten of each per fifteen-minute window, keyed on
IP**.
Everyone behind one office NAT shares that budget.

If you hit "Too many sign-in emails from this network", wait out the window, or clear the counters:

```bash
sqlite3 data/pagesure.db 'delete from auth_attempts;'
```

Separately, the **policy engine has its own rate limit**, per policy: `60/min` on `Standard
Access` and `20/min` on `Restricted`.
Exceeding it is a `BLOCK` at check 12, not a 429, and it takes no payment.
It is only reachable by a wallet that clears check 8, so it bites granted and allowlisted wallets
rather than unknown ones.

## Part 1 - Seed the catalogue

The seed is the only way to create services and policies, so nothing is testable through the
gateway until it has run.

It is gated on one variable, and **without it the seed is a silent no-op**:

```bash
npm run keys:generate     # optional: prints testnet keypairs you will need later
```

Set the owner wallet in `.env`:

```bash
DEMO_OWNER_WALLET=<a G... address you control>
```

Optionally:

| Variable                     | Effect if unset                          |
| ---------------------------- | ---------------------------------------- |
| `DEMO_SETTLEMENT_RECIPIENT`  | falls back to `DEMO_OWNER_WALLET`        |
| `DEMO_COMMITMENT_PUBLIC_KEY` | the channel-mode service is skipped      |
| `PROVIDER_LABEL`             | display name defaults to `PageSure Demo` |

Then:

```bash
npm run db:seed
```

Expect exactly:

```text
created demo organization
created demo owner for G...
created policy "Standard Access"
created policy "Restricted"
services created: 3
```

If you instead see `DEMO_OWNER_WALLET not set to a valid Stellar key: nothing to seed`, the
variable is missing or malformed, and you have just run a command that did nothing.

Confirm what exists:

```bash
sqlite3 data/pagesure.db "select name, slug, mode, status from services;"
sqlite3 data/pagesure.db "select name, unknown_action from policies;"
```

### What you should now have

Three services, all `live`:

| Name              | Slug          | Price      | Mode        | Policy            |
| ----------------- | ------------- | ---------- | ----------- | ----------------- |
| `PageSure Search` | `search`      | 0.01 USDC  | Charge      | `Standard Access` |
| `Market Data`     | `market-data` | 0.002 USDC | **Session** | `Standard Access` |
| `AI Summarizer`   | `summarize`   | 0.05 USDC  | Charge      | `Restricted`      |

And two policies, which differ only in how they treat a wallet they have never seen:

|                     | `Standard Access` | `Restricted` |
| ------------------- | ----------------- | ------------ |
| Unknown wallet      | **review**        | **block**    |
| Per-request cap     | 0.5 USDC          | 0.1 USDC     |
| Daily wallet cap    | 100 USDC          | 10 USDC      |
| Ungranted spend cap | 0.1 USDC          | 0.01 USDC    |
| Rate limit          | 60/min            | 20/min       |

Both policies are bound to **all three** services.
That is deliberate: it makes both policy outcomes reachable without editing anything, which is
what Part 2 uses.

The seed is idempotent by policy name and service slug, so re-running it changes nothing.
One caveat: `services.slug` is globally unique, so seeding a _second_ organization creates a new
organization with policies and **zero** services.

## Part 2 - Call the gateway and watch the policy decide

This needs no wallet, no session, no signature and no money.
An unknown payer address is enough, because policy is evaluated before payment exists.

Use an address that is on no allowlist and holds no grant.
This guide uses a throwaway one; substitute your own:

```bash
G=GDMDHFQFAZAGH2BYVSOXBO6D3KD2HPNNLTKGJTJZJ3IGKBNL4AV3P3RK
```

### Case A - a policy that reviews unknown wallets

```bash
curl -i "http://localhost:3000/v1/search?q=stellar+agentic+payments" -H "X-Pagesure-Payer: $G"
```

Expect **HTTP 202** and a JSON body containing `"decision": "review"`, `"payment": "not_started"`,
`"service": "not_executed"`, a `reviewId`, a `requestId`, and a `policyTrace`.

Read the trace.
It is the actual evaluation, not a summary, and every check before the terminal one is present:

```json
{
  "phase": "preflight",
  "decision": "review",
  "checks": [
    { "key": "service_active", "status": "pass", "detail": "live" },
    { "key": "policy_bound", "status": "pass", "detail": "Standard Access" },
    { "key": "network_allowed", "status": "pass", "detail": "stellar:testnet" },
    { "key": "asset_allowed", "status": "pass", "detail": "CBIELTK6…QXDAMA" },
    { "key": "denylist", "status": "pass", "detail": "not listed" },
    { "key": "grant", "status": "skip", "detail": "no active grant" },
    { "key": "allowlist", "status": "skip", "detail": "not on allowlist" },
    {
      "key": "unknown_wallet",
      "status": "fail",
      "detail": "wallet is not known…held for review"
    },
    { "key": "amount_cap", "status": "pass", "detail": "within 5000000" },
    {
      "key": "ungranted_cap",
      "status": "pass",
      "detail": "within ungranted cap"
    },
    { "key": "daily_cap", "status": "pass", "detail": "within 24h cap" },
    { "key": "rate_limit", "status": "pass", "detail": "within 60/min" }
  ]
}
```

Two things worth noticing:

- On a **block**, everything after the terminal check is `skip`, never `fail`: it was not
  evaluated.
- On a **review**, evaluation **continues** past the hold, so the caps and the rate limit are
  still reported. That is why the trace above shows `amount_cap`, `daily_cap` and `rate_limit` as
  `pass` even though the request is being held.
  It is also why a granted wallet, which passes check 8 outright, can be stopped by a cap later -
  see [Part 3](#the-grant-makes-the-later-checks-reachable).

The body ends with the instruction that drives Part 3:

> Held for provider review. No payment was taken and the service was not executed. Retry with
> `?review=<reviewId>` once approved.

### Case B - a policy that blocks unknown wallets

`AI Summarizer` is bound to `Restricted`, which blocks rather than reviews:

```bash
curl -i "http://localhost:3000/v1/summarize?text=hello" -H "X-Pagesure-Payer: $G"
```

Expect **HTTP 403**, `"decision": "block"`, `"payment": "not_started"`, and a trace whose terminal
check is `unknown_wallet` with `fail`.
Everything after it is `skip`.

Same wallet, same absence of money, opposite policy, opposite outcome.
That is the access policy doing its job, and it is the cheapest thing in the product to verify.

`"payment": "not_started"` with `"service": "not_executed"` is the point of a preflight decision:
no challenge was issued, so there was nothing to settle.

### What got written

Neither call moved money, and the database says so:

```bash
sqlite3 -header data/pagesure.db "
  select substr(id,1,14) id, status, policy_decision,
         claimed_payer is not null claimed, verified_payer is not null verified
  from requests;"
```

Expect `review_pending` and `blocked` rows, with `claimed` set and **`verified` empty on both**.
A verified payer is what a settled payment leaves behind, so its absence is the evidence that
nothing was charged.

## Part 3 - Hold, approve, grant, retry

Part 2 left a request sitting in the review queue.
This is the loop a provider actually operates, and it runs end to end without money.

### Retry while it is still pending

```bash
RID=<the reviewId from Case A>
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/v1/search?q=test&review=$RID" -H "X-Pagesure-Payer: $G"
```

Expect **202** again.
A pending review does not become permissive because you asked again.

### Approve it

In the console this is `/review`: **Approve and grant**, with an optional note for the audit trail.
The page states the guarantee it is relying on:

> Held requests. Nothing here has been charged. Approving a wallet creates a time-boxed grant
> scoped to that one service, not a permanent allowlist entry.

If you are not signed in as the seeded owner, drive the same state directly:

```bash
sqlite3 data/pagesure.db "
  select id, status, amount_base from review_decisions;"
```

Approving sets that row to `approved` and inserts into `policy_grants`, keyed by
`(policy, service, wallet)` with an expiry - default 24 hours.

### Retry after approval

```bash
curl -i "http://localhost:3000/v1/search?q=test&review=$RID" -H "X-Pagesure-Payer: $G"
```

Expect **HTTP 402 Payment Required** and a `WWW-Authenticate: Payment …` header:

```text
www-authenticate: Payment id="GGBZZs…", realm="localhost", method="stellar",
  intent="charge", expires="2026-10-04T15:49:09.435Z",
  request="eyJhb3V0IjoiMTAwMDAwIiwiY3VycmVuY3kiOiJDQklF…In0…"
```

Decoded, that challenge names:

| Field        | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| `amount`     | `100000` base units = 0.01 USDC                                                |
| `currency`   | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (USDC SAC, testnet) |
| `externalId` | the `reviewId` you passed                                                      |
| `recipient`  | the organization's settlement account                                          |

**The status code changed from 202 to 402 because the grant changed the policy outcome, not
because anything was paid.**
202 meant held; 402 means the policy now allows and payment negotiation has begun.
The `grant` check flipped from `skip` to `pass`.

This is as far as the product goes without a funded account, and it is the complete access-control
story: unknown wallet held, human approves, scoped grant issued, request now purchasable.

Verify the grant is scoped rather than a standing allowlist entry:

```bash
sqlite3 -header data/pagesure.db "
  select wallet, service_id is not null scoped_to_service, expires_at > 0 expiring
  from policy_grants;"
```

### The grant makes the later checks reachable

An unknown wallet never reaches checks 9 to 12: check 8 is terminal, so its outcome is decided
before the caps and the rate limit are even looked at.
A granted wallet is different, and that is worth seeing because it is where the caps live.

Firing 70 requests at once against `Standard Access` with the granted wallet above returns:

```text
60  402   challenge issued
10  403   blocked by the rate limit
```

Exactly 60, which is the configured limit.
The 403 carries `"reason": "exceeded 60 requests per minute"`, and its trace shows the mechanism:

```json
{ "key": "grant",          "status": "pass", "detail": "granted until 2026-10-05T15:44:09.350Z" },
{ "key": "unknown_wallet", "status": "skip", "detail": "authorised by grant or allowlist" },
{ "key": "amount_cap",     "status": "pass", "detail": "within 5000000" },
{ "key": "rate_limit",     "status": "fail", "detail": "exceeded 60 requests per minute" }
```

Both bodies still say `"payment": "not_started"` and `"service": "not_executed"`.
A rate-limited request is refused before a challenge exists, so it is never billed.

Note also that the grant detail shows a concrete expiry - 24 hours out, matching the default TTL -
rather than an open-ended permission.

## Part 4 - Take the money

Everything below needs a funded Stellar **Testnet** account, and none of it was run here.
See [What is not verified](#what-is-not-verified).

```bash
npm run keys:generate     # testnet keypairs, written to .env
```

Fund the demo payer:

1. XLM for fees, from <https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY>.
2. A USDC SAC trustline, via <https://lab.stellar.org/account/fund>.
3. USDC balance, from <https://faucet.circle.com> choosing **Stellar Testnet**.

Testnet USDC has no public faucet API, so this is manual and is the single biggest reason the
payment paths are unverified in this repository.

With `DEMO_PAYER_SECRET` set and the payer funded, the challenge from Part 3 becomes payable:
sign the credential, retry with `Authorization: Payment <credential>`, and the gateway verifies it,
settles it, calls the upstream and returns the resource with `Payment-Receipt` and
`X-Pagesure-Payment-Tx`.

The upstream also needs credentials.
`PAGESURE_UPSTREAM_MODE` defaults to `strict`, so an unconfigured search or summariser upstream
fails loudly rather than silently returning something fake.
That is deliberate: a paid response that was not really fetched is worse than an error.

## Part 5 - Channel mode

`Market Data` is the seeded channel-mode service, at 0.002 USDC per call.
The claim it exists to support is **147 requests settling in one transaction**.

```bash
npm run contracts:build      # one-way-channel WASM from source
npm run channels:deploy      # upload WASM, deploy the channel factory
```

Then, per `README.md`:

1. `POST /v1/market-data/session` with `{ "funder": "G…", "fundedBase": "…",
"commitmentPublicKey": "G…" }`.
2. The **payer** signs the factory `open` invoke itself, so funds never sit in an account PageSure
   controls.
3. `POST /v1/market-data/session/confirm` with the session id and deployed channel address.

Each subsequent request signs a cumulative commitment off-chain, and closing pays the recipient
once.

Also expect **HTTP 501** from a session close attempt, immediately, with no upstream call and no
change to state.
Close is not implemented; a deliberate refusal rather than a fake success.

This whole part is unobserved here.
The WASM builds and the factory deploys, but no funded channel was opened, so treat session mode
as unproven rather than working.

## Part 6 - Read the console

What each screen is for, what populates it, and what an empty one means.
All of these render for any organization, but the services belong to the seeded one - see
[The two halves do not connect](#the-two-halves-do-not-connect).

| Screen           | Shows                                                    | Populated by                               |
| ---------------- | -------------------------------------------------------- | ------------------------------------------ |
| `/overview`      | request and volume totals, decision split, activity feed | real gateway traffic                       |
| `/services`      | the catalogue, price, mode, usage                        | the seed                                   |
| `/policies`      | caps, allow/deny lists, grants, bound services           | the seed                                   |
| `/review`        | held requests awaiting a human                           | an unknown wallet under a reviewing policy |
| `/settlements`   | on-chain transactions, with explorer links               | a settled payment or session               |
| `/sessions`      | funded channels, accumulated against funded              | a payer opening a channel                  |
| `/incidents`     | money taken without delivery, upstream failures          | a post-settlement policy block             |
| `/requests/[id]` | the stored policy trace, verbatim                        | any gateway request                        |

Three of these are **read-only**, with no create or edit control anywhere:
`/services`, `/policies` and `/requests/[id]`.
`/review` is the only screen that writes through the interface.

### After Part 2

`/overview` shows `Requests 4`, a decision split of blocked and review, and an activity feed
containing `Blocked G… on AI Summarizer` and `Held G… on AI Summarizer` entries, each with an
`inspect` link.

Follow `inspect` to `/requests/[id]`, which is the **Policy evaluation** screen: the stored trace
rendered verbatim, plus `Claimed payer (untrusted)` and `Verified payer (authoritative)` as separate
rows.
The second is empty, which is the visible form of the same fact the database showed in Part 2.

The screen is deliberately not a reconstruction.
It replays what was recorded, so what you read is what was decided.

### The empty states are informative

After seeding and before any traffic, `/review` reads `Nothing is waiting`, `/settlements` reads
`No settlements yet`, `/incidents` reads `No incidents`, `/sessions` reads `No sessions yet`, and
the overview activity feed reads `No gateway traffic yet`.

None of those mean a failure.
Seeding creates no requests, reviews, settlements, incidents or activity rows by design - it
creates a catalogue, not traffic.

One empty state is misleading: `/incidents` says `Block a wallet to see the refusal path`.
A **preflight** block takes no payment and therefore records **no incident**.
Incidents only appear once money has actually moved.
To see one you need a post-settlement policy block on a charge-mode service, which needs a real
payment.

### The amounts are hardcoded to 7 decimals

Several screens render a literal ` USDC` suffix and assume 7 decimals regardless of the service's
own `decimals` and `assetCode`.
That is correct for every seeded service and wrong for anything you might add later.
Also note the overview's `Today's volume` is a rolling **24 hours**, not a calendar day.

## Part 7 - The playground

`/playground` is the one screen that runs a real paid request from the browser, and it is the
closest thing to "using the product" without writing a script.

It needs all of: a session, `DEMO_PAYER_SECRET` set to a valid `S…` and **funded**, and an
organization with a settlement account.
With no funded payer it fails at the gateway.

1. Sign in as the seeded owner wallet.
2. Open `/playground`.
3. Expect a **Service** dropdown offering the live **charge-mode** services only - `PageSure Search`
   and `AI Summarizer`. `Market Data` is absent, because a channel-mode service cannot be paid
   per-request.
4. Expect a **Query** box prefilled with `stellar agentic payments`, a price line, and
   **Run paid request**.
5. Click it.

Expect a **Request lifecycle** waterfall built from the SDK's own progress events, not an
animation:
`REQUEST → POLICY_CHECK → CHALLENGE → SIGNING → SIGNED → PAYING → CONFIRMING → PAID →
SERVICE_EXECUTED → RESULT`.

A 403 renders the terminal step as `blocked` and a 202 as `review_pending`, which is how you can
see the policy outcome without reading JSON.

Below it, a **Service response** card on 200 or **Gateway response** otherwise.
On success there is also a link, **Inspect the recorded policy decision**, straight to
`/requests/[id]`.

Unrun, it reads `Run a request to see the real payment lifecycle, driven by the SDK's progress
events.` With no eligible services it reads `No live charge-mode services`.

## Part 8 - Console access

This part is about who may see the console, and it is independent of the gateway above.
All of it works with no wallet and no funds.

### A two-minute smoke test

```bash
npm run dev
```

1. Open <http://localhost:3000/login>, request a link for `owner@acme.test`.
2. Copy the `[pagesure] link:` line from the terminal into the browser.
3. Expect onboarding. Create the organization `Acme Research`.
4. Expect `/overview` with `Acme Research` in the header and no wallet involved.
5. Reload. Expect the same dashboard.

### Sign in without a wallet

This is the path that matters most, because a wallet is optional and nothing in it should require
one.

1. Open <http://localhost:3000/login>.
2. Expect a single email field and a **Continue with email** button.
   There is no password field anywhere on the page.
3. Enter an email you control and submit.
4. Expect `Check <address> for your sign-in link.` The page does not navigate yet.
5. Open the link from wherever you are reading mail.
6. Expect **onboarding**: a single **Organization name** field and a create button.
7. Enter a name and submit.
8. Expect `/overview`, with the organization visible in the **header**, without opening any menu;
   your email in the account chip; and a **Settlement account** panel reading `Not connected`,
   explaining that until it is connected services can be published and everything works except
   actually taking money.
9. Reload.

Expect the same dashboard.
A session that survives a reload is a session, not a flash of state.

### Signing in again

1. Sign out from the account chip.
2. Request a link for the same email again.
3. Expect to land straight on `/overview`, not on onboarding.
4. Open the _same_ link a second time.

Expect a refusal, not a second sign-in.
Tokens are single-use: sign-in links expire after 15 minutes, invitations after 7 days.

### Guards and redirects

| Try                                                         | Expect                                              |
| ----------------------------------------------------------- | --------------------------------------------------- |
| any console page while signed out                           | redirected to `/login`                              |
| `/login?returnTo=https://evil.example.com` while signed out | stays on `/login`; no request to `evil.example.com` |
| signed in, `/login?returnTo=/settings`                      | lands on `/settings`                                |
| signed in, `/login?returnTo=https://evil.example.com`       | lands on `/overview`, same origin                   |
| signed in, `/login?returnTo=//evil.example.com`             | lands on `/overview`, same origin                   |
| signed in with no organization, `/login`                    | goes to `/onboarding`, never a redirect loop        |

That last row is worth doing by hand.
A signed-in user with no organization is a legitimate state, and it used to bounce between `/login`
and `/overview` forever.

### Invitations and roles

**Use a private window for the second person.**
Two tabs in one browser profile share one session and will test nothing.

As the owner:

1. Open `/settings`.
2. Expect two panels: **Settlement account** and **External channel signer**.
3. Fill **Email address to invite** with `guest@acme.test`.
4. Pick a role: `operator` or `analyst`.
5. Click **Invite**.
6. Expect `Invitation sent to guest@acme.test.`

There is deliberately **no `owner` option**.
Ownership is not transferable by invitation.

Getting the link depends on the mail mode - see
[Mail: pick a mode](#mail-pick-a-mode-before-you-start).
In both modes the page itself never shows the link, because printing it would mean putting a
credential into the DOM.

As the guest, in the private window:

7. Open the invitation link.

Expect `Sign in with the invited address first.` and a **Sign in** button.

There is deliberately **no email field to retype**.
Acceptance is recorded against a real account, and that account has to be proved first, so an
invitation is not transferable by guessing an address.

8. Click **Sign in**, enter the invited address, submit, and open the sign-in link.
9. Expect to be returned to the invitation, now reading:

   > You are in. You joined Acme Research as a member.

10. Click **Go to the dashboard**. Expect `/overview` with the organization in the header.

### If the guest never opened the link

Sign in as an address that has an unopened invitation and no organization of its own.

Expect, **above** the organization form:

> You have been invited
> Acme Research as operator
> Open the invitation email on this device and follow its link to join.

There is no **Join** button, and that is deliberate.
The token is stored hashed and cannot be rebuilt from the database, so a button that silently did
nothing would be worse than no button.
Re-send from `/settings` instead.

### What a non-owner sees

As the guest, open `/settings`.

Expect it read-only: **Settlement account** explains that connecting one is the owner's job, the
**External channel signer** panel has no form, and the invite form is **absent entirely**, not
merely disabled.

Open the invitation link again.
Expect a refusal - the token was consumed, and re-sending is the only way back.

### Tenant isolation

This is the check that matters most in a multi-tenant product.

1. In the private window, sign the guest out.
2. Create a second organization there, `Stranger Corp`.
3. Ask whether anything from `Acme Research` is reachable.

Expect nothing.
No page, panel, member list, aggregate or API response may mix the two tenants.

Three cases are worth doing by hand, because each one was a real bug at some point:

- **A signed-in stranger opens somebody else's invitation.**
  Expect a refusal, and expect the stranger to still be in `Stranger Corp` afterwards, with the
  invitation still redeemable by its rightful owner.
- **A sign-in link opened as an invitation.**
  Change the path of a `/login/callback?token=…` URL to `/invite/callback?token=…`.
  Expect a refusal; the two token purposes are not interchangeable.
- **The rightful recipient reopens their own used invitation.**
  Expect `That invitation is invalid, has expired, or has already been used.`, the membership
  unchanged, and no second membership created.

### Joining an organization you already belong to another one

1. Sign in as somebody who has their own organization.
2. Have another organization's owner invite that same address.
3. Open the invitation while signed in.

Expect to be accepted: the invitation was addressed to this address, and that is the only thing
that authorises acceptance.

Then look at the dashboard.

Expect **the console to still show the original organization.**
Acceptance records a membership; it does not move you.
Silently switching a signed-in person's workspace because somebody invited them would be a hijack,
not a feature.

But there is a consequence worth knowing before you go looking for the missing button:

> **There is no organization switcher.**
> A user can hold memberships in several organizations, and the console always shows the one they
> were using when they signed in. Joining a second organization therefore appears to do nothing
> visible: the membership exists in the database, and nothing in the interface mentions it.

Verify it really was recorded:

```bash
sqlite3 data/pagesure.db "
  select o.name, om.role from organization_members om
  join users u on u.id = om.user_id
  join organizations o on o.id = om.organization_id
  where u.email = 'guest@acme.test';"
```

Both rows should appear.

## Part 9 - Wallet, settlement account, signer

Skip this part unless you have Freighter.
It is also the part this repository has **not** verified end to end; see
[What is not verified](#what-is-not-verified).

### Wallet sign-in

1. Install the [Freighter](https://www.freighter.app) extension.
2. Switch it to **Testnet** in the extension's own network settings.
3. Fund the account with XLM from Friendbot.
4. On `/login`, click **Continue with wallet**.

Expect `Approve in wallet...`, then `Waiting for signature...`, then `Verifying signature...`,
then `/onboarding` or `/overview`.

The signature must be a `Sign in` challenge for **this** application and **this** session.
A signature over some other text is not a login, and one captured from another session is not
replayable.

### Settlement account

1. On `/settings`, click **Connect a wallet**.
2. Expect `Connected` and the **full** address in monospace, not abbreviated.

The status distinguishes three states, and the middle one is the one to distrust:

| Status           | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `Not connected`  | no address; nothing can receive money                       |
| `Awaiting proof` | an address is stated but never proven by a signature        |
| `Connected`      | proved by a signature for this organization and this wallet |

A settlement address nobody ever signed for must not be able to receive funds.

Then reload, sign out, sign back in with the wallet, and sign in by email to the same address.
Expect `/overview` both times.
A settlement account is a **proof of control over money**, not an identity of its own.

### External channel signer

Owner-only, and each action requires a fresh signature bound to the organization **and** the
wallet being changed.

1. Enter a signer URL such as `https://signer.your-company.com`.
2. Enter the **name of the environment variable** holding its token, such as `SIGNER_TOKEN`.

Expect a note that the token's value is never stored, only the variable name.
Inspecting the `signer_registrations` rows should confirm it: a name, never a credential.

3. Connect a second, different settlement wallet, and register the signer again with a different
   URL.

Expect a **fresh** signature prompt each time.
A signature from before the change must not be replayable, nor one captured for a different
organization.

4. As a non-owner, attempt both actions.

Expect refusal **from the server**, not merely a hidden form.
Hidden controls are not authorization.

5. Try each of these as the owner, expecting a named rejection each time:

| Attempt                                              | Expect                        |
| ---------------------------------------------------- | ----------------------------- |
| A `http://` signer URL outside localhost             | rejected: must use https      |
| A URL with credentials in it, `https://user:pw@host` | rejected                      |
| A host not in the deployment's allowlist             | rejected, naming the host     |
| A token variable that is not set in the process      | rejected, naming the variable |

## Part 10 - The automated suites

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # next build
```

The proof suites are self-contained.
Each creates its own scratch database, migrates it, exercises the subject, and closes it.
They need no configuration, no wallet, and no network.

| Command                    | Checks  | Covers                                             |
| -------------------------- | ------- | -------------------------------------------------- |
| `npm run prove:isolation`  | 59      | no cross-tenant reads or writes                    |
| `npm run prove:email`      | 58      | sign-in tokens, invitations, mail delivery failure |
| `npm run prove:settlement` | 49      | settlement refusals and 501 paths                  |
| `npm run prove:treasury`   | 31      | settlement account and signer authorization        |
| `npm run prove:auth`       | 20      | wallet challenge and signature verification        |
| `npm run prove:signer`     | 20      | signer policy and transport                        |
| `npm run prove:commitment` | 20      | commitment construction                            |
| `npm run prove:upgrade`    | 13      | migrating a populated older database               |
| **Total**                  | **270** |                                                    |

Expect `N passed, 0 failed` from each, where `N` matches the table.
If a count differs, the suite changed: read the diff rather than adjusting the expectation to
match.

Note what these suites do **not** cover: the gateway, the policy engine and the console screens.
Those are Parts 1 to 7 above, and they are manual.

```bash
npm run mpp:audit
```

Proves the installed MPP surface and that the EVM paths are unreachable.

### Browser tests

**There is no automated browser test in this repository.**
The Playwright harnesses used while building this were kept outside the tree, in `/tmp/ps-e2e/`,
and they depend on a locally installed browser.

Parts 2, 6 and 8 are the substitute for the console and gateway paths.

## Troubleshooting

**`/services` says `No services yet` after signing up.**
Expected, and the most confusing thing in this product.
Console sign-up creates an organization that owns nothing; only the seed creates services.
See [The two halves do not connect](#the-two-halves-do-not-connect).

**`npm run db:seed` logs `nothing to seed`.**
`DEMO_OWNER_WALLET` is unset or is not a valid `G…` address.
The seed is a silent no-op without it.

**The `Create service` link 404s.**
There is no `/services/new` route, and no other way to create a service.
This is a gap in the product, not a mistake in your setup.

**`/v1/summarize` returns 403 with `policy is blocked` in the reason.**
Expected for any wallet not on an allowlist.
`summarize` is bound to `Restricted`, which blocks unknown wallets.
Use `/v1/search`, which reviews instead, and walk Part 3.

**A request suddenly returns 403 after many rapid calls.**
The policy rate limit: `60/min` on `Standard Access`, `20/min` on `Restricted`.
It is a `BLOCK` at check 12, takes no payment, and reports
`"reason": "exceeded 60 requests per minute"`.

It only fires for a wallet that got **past** check 8, so an unknown wallet under `Standard Access`
sees `202` forever and never reaches the rate limit - it is held at check 8 first.
To reproduce it you need an allowlisted or granted wallet, as in
[the grant makes the later checks reachable](#the-grant-makes-the-later-checks-reachable).

**A retried request still returns 202.**
The review is still `pending`.
Approval is what changes it, and then the same URL returns 402 - see Part 3.

**A grant did not take effect.**
Grants are scoped to `(policy, service, wallet)` and expire, 24 hours by default.
Check the row rather than assuming.

**The page says "Check your email" and nothing arrives.**
You are in Mode B and the address is not the one your provider will deliver to.

**The page says "The sign-in email could not be sent. the mail provider rejected the message".**
The provider refused it, and the reason is in the server log.
The provider's full response is logged, never displayed, because it carries the account's own
address and internal identifiers.

**"Too many sign-in emails from this network."**
Ten per fifteen minutes, per IP.
Clear them with the `sqlite3` line in [The throttle](#the-throttle).

**A loop between `/login` and `/overview`.**
You are signed in with no organization.
Opening `/login` should forward you to `/onboarding`; creating an organization resolves it.

**`SqliteError: no such table: ...` on first run.**
Migrations have not been applied: `npm run db:migrate`.

**An invitation link does nothing.**
It was used, or it expired after 7 days.
Tokens are single-use and hashed at rest, so the raw value is unrecoverable.
Re-send from `/settings`.

**Settings panels are missing.**
You are not the owner, or you have no organization.
Both are legitimate states and both render read-only explanations.

**A leftover `-wal` or `-shm` file.**
Expected while the database is open.
If one survives a proof run, that run has a bug: every scratch database must be closed.

## What is not verified

Stated plainly, because a test guide that overstates itself is worse than none.

- **No funded Stellar account was available, so no money moved in this write-up.**
  Parts 1 to 3 stop at the 402 challenge because that is as far as the product goes without a
  funded payer and a working upstream.
  Settlement, the playground waterfall, `/settlements` and real upstream responses are all
  unobserved here.

- **Channel mode is unproven.**
  The WASM builds and the factory deploys, but no funded channel was opened and no voucher was
  settled.
  `147 requests -> 1 settlement` is the claim this project rests on, and it is not something this
  repository has watched happen.
  If it cannot be made to work, session mode is cut rather than faked.

- **The wallet flows in Part 9 have not been exercised end to end.**
  Freighter is unavailable in the headless environment these checks ran in, so they rest on
  `prove:auth`, `prove:treasury` and code review rather than on a signature watched happening.

- **There is no way to create a service or a policy through the interface.**
  Both come only from `npm run db:seed`, `Create service` 404s, `/policies` has no edit control,
  and no allowlist or denylist can be changed from the UI.
  Everything about configuring this product is currently a seed-and-database activity.

- **An organization created by signing up can never own a service.**
  The seeded organization is separate and keyed on a wallet, and nothing links them.
  This is the gap that makes the console look empty after sign-up.

- **The gateway, policy engine and console screens have no automated coverage.**
  The 270 proof checks cover auth, isolation, settlement refusals, signer policy and migrations.
  Parts 1 to 7 were walked by hand.

- **Charge mode can charge without delivering.**
  A policy block raised after settlement does not refund.
  It is bounded by `ungrantedSpendCapBase` and recorded as an incident.

- **Real email delivery has been confirmed for one address only.**
  Mode B was verified to a single recipient, which is the most Resend's sandbox sender allows.
  Delivery to arbitrary addresses needs a verified domain and has not been tested.

- **A user who joins a second organization gets no way to reach it.**
  Acceptance deliberately leaves an existing user's workspace alone, but with no organization
  switcher a second membership is recorded and then invisible.
  Verified in the database; not exposed anywhere in the interface.

- **This is not a compliance product.**
  The policy engine enforces what a provider configures.
  It performs no sanctions screening.

- **Single process only.**
  The in-memory policy windows and review queues do not survive a restart and do not span
  instances.
