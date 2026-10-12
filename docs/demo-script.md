# PageSure demo video script

A 3:00 screen recording for the Stellar hackathon submission.
The story: a provider brings their own API, puts a price on it, controls who can pay, and gets paid in USDC on Stellar by an AI agent.

Everything below is UI only.
It starts from a brand-new account with **Connect wallet**, and every button name and on-screen message matches what the live site (https://pagesure.vercel.app) actually showed in rehearsal.

## Prep, off camera (about 5 minutes)

1. **Freighter**: install it, create a new wallet, and switch it to Testnet (globe icon, then **Testnet**).
2. **Fund the wallet now** to save time on camera:
   - Click **Fund with Friendbot**.
   - Open the `...` menu, choose **Manage assets**, then **Add an asset**.
   - Paste `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, click **Add**, then **Confirm**, and wait for **Success!**.
3. **Copy the API URL to your clipboard**:
   `https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m`
4. **Browser**: a clean window at 100% zoom, with https://pagesure.vercel.app open.
   Close other tabs; one `stellar.expert` tab opens on its own during step 7.
5. **Practice once.**
   Test runs leave the PageSure account and service address behind, so on the take itself use a different organization name and address than you rehearsed with.

## The script

### 0:00-0:15 - The hook

**Screen:** the PageSure home page, with the new icon in the browser tab.

> AI agents are starting to buy things on their own: data, search, compute.
> But every paid API is built for humans: sign up, add a card, copy an API key.
> Agents can't do that.
> PageSure fixes it with a payment gateway for machines, on Stellar.

### 0:15-0:40 - Sign up with a wallet

**Do:**

1. Click **Sign in**, then **Continue with wallet**.
2. In Freighter: **Connect**, then **Confirm**.
3. PageSure shows **Create your organization**. Type `Lisbon Labs`, click **Create organization**, then **Confirm** in Freighter.
4. You land on **Overview**.

> I'm an API provider.
> I sign in with my Stellar wallet: no email, no password.
> That wallet is now where my earnings land.

### 0:40-1:15 - Turn my API into a paid endpoint

**Do:** go to **Services**, then **New**, and fill in:

| Field | Value |
|---|---|
| Name | Lisbon Weather |
| Address | lisbon-weather |
| Price per call | 0.01 |
| What it calls | Your HTTPS API |
| API URL | paste the Open-Meteo URL |
| Payment mode | Charge - one transaction per call |
| Publish as | Live - accepts paid calls now |

Click **Create service**.
Point at the endpoint `https://pagesure.vercel.app/v1/lisbon-weather`.

> I bring my own API, set a price of one cent per call, and PageSure gives me a URL.
> That URL is what I hand to agents.
> Without payment it answers HTTP 402 Payment Required, with a price an agent can read and pay.

**Optional, if you have time:** point at the **API URL**.

> It only forwards to public HTTPS, so nobody can point PageSure at internal systems.

### 1:15-1:35 - An unknown agent shows up

**Do:** go to `/playground` (or click **Open Playground** on Overview).

1. Pick **Lisbon Weather**.
2. Under **Query parameters**, type `timezone=Europe/Lisbon`.
3. Click **Run paid request**.

Point at `REQUEST`, then `POLICY_CHECK`, then `REVIEW_PENDING`: "held for a human, nothing charged".

> This playground is an agent with its own Stellar wallet.
> It's never called my API before, so my policy holds it for review.
> The policy runs before any money moves, so nothing is charged.

### 1:35-1:50 - I decide who gets in

**Do:** go to **Review**.
Point at the agent's wallet, the reason, and the amount.
Click **Approve and grant**.

> I approve it.
> That's a time-limited grant for this one service, not a permanent allowlist entry.
> I can also cap spending per request and per day, rate-limit, or block wallets outright.

### 1:50-2:25 - The agent pays and gets the data

**Do:** go back to the **Playground** and click **Run paid request**.
Let the 7 steps fill in, and say each one as it appears:

| Step | Say |
|---|---|
| CHALLENGE | PageSure answers 402: pay 0.01 USDC. |
| SIGNING, SIGNED | The agent signs a USDC transfer on Stellar. |
| SERVICE_EXECUTED | Payment verified, so now PageSure calls my real API. |
| RESULT: Delivered | And the agent gets the live data. |

Scroll to **Service response** and point at the Lisbon temperature.

> No account, no API key, no invoice.
> An HTTP request, a Stellar payment, and the data, in a few seconds.

### 2:25-2:45 - The money is real, on chain

**Do:** go to **Settlements**.
Point at the row: `charge` · `0.0100000 USDC` · `confirmed`.
Click the transaction hash, and `stellar.expert` opens on Testnet.

> Every payment is a real Stellar transaction, paid straight into my wallet.
> PageSure never holds the money.
> And for agents that call thousands of times, session mode opens a payment channel once and settles everything in one transaction.
> We've settled 150 requests with a single close on Testnet.

### Optional insert (adds about 20s) - session mode

**Precondition:** the hosted instance must be provisioned for sessions before this beat is recorded.
That means a funded demo payer, the channel factory deployed, and the organization's channel signer running and registered.
If `POST /v1/:slug/session` returns `503 session_signer_unavailable`, or the close step fails, stop and provision it first - see `docs/channel-lifecycle.md`.
Do not record this beat until a session opens and settles cleanly.

**Do:** in the **Agent playground**, pick **Market Data** (the seeded channel-mode service, 0.002 USDC per call).

1. Click **Open session**.
   The Session card appears with a `ses_...` id and a channel contract; the caption already says nothing is spent on chain until you settle.
2. Under **Requests to send**, leave `4`, then click **Send 4 requests**.
   Watch `VOUCHER_SIGNED` steps stack up and **Spent so far** rise, with no on-chain transaction per call.
3. Click **Settle & close**.

Point at the Session card now reading **closed**, then at **Paid provider** (`0.0080 USDC · 4 requests`) and **Close transaction**.

> Same gateway, a different payment mode.
> An agent that calls thousands of times opens a channel once, sends signed vouchers off chain, and settles everything in a single on-chain transaction.
> Four calls here, one close; the 150-request run settled the same way.

### 2:45-3:00 - Close

**Screen:** back on **Overview**, now showing the request and payment volume.

> PageSure: put any API behind a URL agents can pay, per call, in USDC on Stellar, with the provider in control.
> Live on Testnet at pagesure.vercel.app, and open source.

## If something goes wrong on camera

| You see | What happened | Do |
|---|---|---|
| "Freighter is on Mainnet..." | The wallet isn't on Testnet | Globe icon, then **Testnet**, then **Continue with wallet** again |
| "Payments cannot land yet..." | The wallet isn't funded or has no USDC trustline | Do prep step 2, wait about 30 seconds, then retry |
| "That address is already taken" | Someone already used that service address | Use `lisbon-weather-2` |
| A request stays held after approving | The grant is for the exact service you approved | Make sure the Playground has **Lisbon Weather** selected |

## Timing tips

- Running long? Cut the optional API URL line in step 3, and shorten step 7's sessions sentence to: "Session mode settles thousands of calls in one transaction."
- The payment step takes about 5 to 10 seconds.
  Keep talking through the steps rather than waiting in silence.
- Record the voice-over separately if you can, then lay it over the screen recording.
  It's much easier to hit 3:00 that way.

## Accuracy notes for the narration

- The 150-request claim now matches `README.md` (Honest limits), which records it as verified on 2026-10-12.
  Keep the spoken claim inside what that section says.
- Do not claim the upstream provider was Open-Meteo for that channel run.
  The settled 150-request channel run used the local development provider (`PAGESURE_ALLOW_LOCAL_UPSTREAM=1`); the Open-Meteo call is the live charge-mode flow in this script.
- "PageSure never holds the money" is accurate for charge mode and for channel settlement design; the payer deploys and funds its own channel.
- The optional session beat only works once the hosted signer is provisioned.
  Cut it from the recording if it is not provisioned in time; the main flow does not depend on it.
