# PageSure user guide

**Live app:** https://pagesure.vercel.app (Stellar Testnet)
**Source:** https://github.com/Saber1Y/PageSure

This guide walks you through PageSure end to end in about 10 minutes, in the browser, with no code and no real money.

## The problem

AI agents are starting to buy data and services on their own: search results, market prices, weather, model calls.
But every paid API is built for humans.
You create an account, add a credit card, copy an API key, and receive an invoice at the end of the month.
An agent can do none of that, so today it cannot pay for anything on its own.

API providers have the mirror problem.
They have no simple way to charge a machine per call, and no control over which machines may pay them.

## The solution

PageSure is a payment gateway for machines, built on Stellar.

- A **provider** puts an API behind PageSure, sets a price per call and an access policy, and gets a URL to hand to agents.
- An **agent** calls that URL like any HTTP endpoint.
  PageSure answers `402 Payment Required` with a machine-readable price.
  The agent pays in USDC on Stellar and retries, and PageSure verifies the payment on chain, calls the real API, and returns the data.
- The money goes **straight to the provider's wallet**.
  PageSure never holds it.

Two payment modes are supported:

| Mode | How it works | Best for |
|---|---|---|
| **Charge** | One Stellar USDC transfer per call | Occasional calls |
| **Session** | The agent funds a one-way payment channel once, each call is an off-chain signed voucher, and one transaction settles them all | Agents that call often |

The provider stays in control: the policy runs **before** any money moves, so a blocked or held request is never charged.

## Try it in 30 seconds (no account needed)

Open this link in your browser:

https://pagesure.vercel.app/v1/search?q=stellar&payer=GCZEDXGUAYNDLK46DIPZN6XILINKAAHK4M2XOGQYM2RC77X57QLTPEYC

You get `402 Payment Required` and a JSON body saying "Payment is required (PageSure Search)".
That is what an agent sees before it pays.
Nothing has been charged, and the response headers carry the price, the asset (USDC), and the destination wallet in the `WWW-Authenticate: Payment ... method="stellar"` challenge.

## Try the whole product (about 10 minutes)

You will play the **provider**: sign up, sell an API, decide who may pay, and get paid.
The **agent** is the built-in Playground, which pays from PageSure's own funded Testnet wallet, so you never spend anything.

### Step 1: Set up a Testnet wallet (3 minutes)

1. Install the **Freighter** browser extension from https://freighter.app and create a wallet.
2. Switch Freighter to **Testnet**: click the globe icon at the top left, then choose **Testnet**.
   PageSure runs on Testnet only, and stops with a clear message if the wallet is on Mainnet.
3. On Freighter's home screen, click **Fund with Friendbot**.
   This gives the wallet free Testnet XLM.
4. Let the wallet receive USDC (a trustline):
   1. Open Freighter's **...** menu, choose **Manage assets**, then **Add an asset**.
   2. Paste Circle's Testnet USDC issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.
      Searching "USDC" by name shows many look-alike assets, so paste the issuer instead.
   3. Click **Add**, then **Confirm**, and wait for **Success!**.

No USDC balance is needed.
The wallet only has to be able to receive it.

### Step 2: Sign up as a provider (1 minute)

1. Open https://pagesure.vercel.app and click **Sign in**.
2. Click **Continue with wallet**.
3. In Freighter, click **Connect**, then **Confirm** to sign.
4. PageSure shows **Create your organization**.
   Enter a name (for example `Lisbon Labs`) and click **Create organization**.
5. Freighter asks for one more signature.
   Click **Confirm**.

You land on **Overview**.
There is no email and no password: the wallet that signed is your identity and the account your earnings settle into.
**Settings** shows it as your connected settlement account.

### Step 3: Sell an API (2 minutes)

1. Click **Services**, then **New**.
2. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `Lisbon Weather` |
   | Address | a unique name, for example `lisbon-weather-yourname` |
   | Price per call (USDC) | `0.01` |
   | What it calls | **Your HTTPS API** |
   | API URL | `https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m` |
   | Payment mode | **Charge - one transaction per call** |
   | Publish as | **Live - accepts paid calls now** |
   | Policy | leave the default (one is created for you) |

3. Click **Create service**.

The service page shows your endpoint under **Integration**, for example `https://pagesure.vercel.app/v1/lisbon-weather-yourname`.
That URL is what you would give to agents.
Open-Meteo is a free public weather API; any public HTTPS API works the same way.

Service addresses are global, so if yours is taken, add a suffix.
The other choices under **What it calls** are built-in upstreams: **Web search**, **Market data** and **Summariser**.

### Step 4: An unknown agent calls your API (1 minute)

1. Click **Playground** in the top menu.
2. Under **Service**, pick **Lisbon Weather**.
3. Under **Query parameters**, type `timezone=Europe/Lisbon`.
4. Click **Run paid request**.

The **Request lifecycle** shows **REQUEST**, **POLICY_CHECK**, then **REVIEW_PENDING: held for a human, nothing charged**.
Your default policy holds wallets it has never seen, and because the policy runs before any payment exists, the agent was not charged.

### Step 5: Decide who gets in (30 seconds)

1. Click **Review** in the top menu.
2. You see the held request: the agent's wallet, the service, the reason ("wallet is not known to this provider"), and the amount.
3. Click **Approve and grant**.

This creates a time-limited grant for this one service.
It does not add the wallet to a permanent allowlist.
In **Policies** you can also set per-request and daily spending caps, rate limits, an allowlist and a denylist, and what happens to unknown wallets (allow, hold for review, or block).

### Step 6: The agent pays and gets the data (1 minute)

1. Click **Playground** again.
   Make sure **Lisbon Weather** is selected and `timezone=Europe/Lisbon` is still in **Query parameters**.
2. Click **Run paid request**.

Watch the seven steps:

| Step | What happened |
|---|---|
| **REQUEST** | The agent called your URL |
| **POLICY_CHECK** | Your policy allowed it, thanks to the grant |
| **CHALLENGE** | PageSure answered 402: pay 0.01 USDC to your wallet |
| **SIGNING**, **SIGNED** | The agent signed a USDC transfer on Stellar |
| **SERVICE_EXECUTED** | PageSure verified the payment on chain, then called Open-Meteo |
| **RESULT** Delivered | The data went back to the agent |

Scroll to **Service response**: it is Open-Meteo's live answer, including `"timezone": "Europe/Lisbon"`, which shows the agent's query reached your API.

### Step 7: See the money on chain (1 minute)

1. Click **Settlements** in the top menu.
   The row reads `charge`, `0.0100000 USDC`, `confirmed`.
2. Click the transaction hash.
   It opens on stellar.expert, the public Stellar explorer.
3. Open Freighter: your wallet received the 0.01 USDC.

Every payment is a real Stellar Testnet transaction, paid straight to your wallet.
**Overview** now shows the request and the payment volume, and **Incidents** would list anything that was charged but not delivered.

## What each page does

| Page | Purpose |
|---|---|
| **Overview** | Requests, payment volume, policy decisions, live activity and settlement position |
| **Services** | Your paid endpoints: price, payment mode, upstream, status and the URL to share |
| **Playground** | An agent that calls your services and pays, so you can see the full lifecycle |
| **Sessions** | Payment channels: funded amount, vouchers and the closing settlement |
| **Policies** | Who may pay: unknown-wallet handling, caps, rate limits, allowlist and denylist |
| **Review** | Requests your policy held, with **Approve and grant** and **Reject** |
| **Settlements** | Every on-chain payout, with a link to the transaction |
| **Incidents** | Anything that was charged but not delivered, recorded and never hidden |
| **Settings** | Your settlement wallet, your team, and the session signer |

## Using it from a real agent

The Playground is a demonstration.
In production an agent calls the same URL and pays from its own wallet, using the Stellar MPP client:

```ts
import { Keypair } from '@stellar/stellar-sdk'
import { Mppx, stellar } from '@stellar/mpp/charge/client'

const payer = Keypair.fromSecret(process.env.AGENT_SECRET!) // a Testnet wallet with XLM and USDC
const mppx = Mppx.create({
  polyfill: false,
  methods: [stellar.charge({ keypair: payer, mode: 'pull', rpcUrl: 'https://soroban-testnet.stellar.org' })],
})

const res = await mppx.fetch('https://pagesure.vercel.app/v1/lisbon-weather-yourname?timezone=Europe/Lisbon', {
  headers: { 'X-Pagesure-Payer': payer.publicKey() },
})
console.log(res.status, await res.json()) // the client handles the 402, pays, and retries
```

The agent declares its wallet with the `X-Pagesure-Payer` header (or `?payer=`).
That declaration only selects a policy; only the verified payment authorizes the call.
A paid response carries `Payment-Receipt` and `X-Pagesure-Payment-Tx` headers with the Stellar transaction hash.

## On-chain evidence

Transactions from live runs on Stellar Testnet, all viewable on stellar.expert:

| What | Transaction |
|---|---|
| Charge: paid call through the public URL | [8d575c77...](https://stellar.expert/explorer/testnet/tx/8d575c778599d8fdd83af50e0c6d0c0a8a15a2e20d6b19e891b2e7f45a3db453) |
| Charge: a brand-new provider account's first payment | [7e2106b3...](https://stellar.expert/explorer/testnet/tx/7e2106b3196cda8e55cc61936c6da13356a3b64c529d427cfa175bc4adc0ceac) |
| Session: channel open, 5 paid calls served by CoinGecko | [5ce058a7...](https://stellar.expert/explorer/testnet/tx/5ce058a7d6b553b9be7bfd95907ea6a85823bac113cc722801c7472152cf6283) |
| Session: one close settling those 5 calls | [d8ef61b2...](https://stellar.expert/explorer/testnet/tx/d8ef61b235ee0f67543ec9028063ef34b93b24139d62263ce1fa8619f40174b6) |
| Session: one close settling 4 calls sent in two batches | [e42d9189...](https://stellar.expert/explorer/testnet/tx/e42d9189de23a75221d9b990ad2376e76c097d4b2b4652484e6c96d5bdaeb4e3) |
| Session: one close settling 150 calls | [0ceed63b...](https://stellar.expert/explorer/testnet/tx/0ceed63bb08b394d3eb6446437e8ae9d1cf14e5e3a82a26f4f41140bdc3e2806) |

The 150-call channel was answered by a local development quote rather than a live API; it demonstrates the channel and settlement mechanics.
The 5-call and 4-call channels were served by CoinGecko's live market data.

## If something goes wrong

| You see | Why | What to do |
|---|---|---|
| "Freighter is on Mainnet. PageSure runs on Stellar Testnet..." | Freighter's default network is Mainnet | Globe icon, **Testnet**, then **Continue with wallet** again |
| No **Create your organization** step; you go straight to Overview | This wallet already has a PageSure account | That is fine: carry on from Step 3, or use a new wallet to see sign-up |
| "Payments cannot land yet..." in Settings or the Playground | The wallet is not funded, or has no USDC trustline | Do Step 1.3 and 1.4, wait about 30 seconds, then run again |
| "That address is already taken" | Another provider uses that service address | Add a suffix to the address |
| "The API URL must be reachable on the public internet." | The URL is not public https on port 443 | Use a public https URL, such as the Open-Meteo one above |
| The request is held again after approving | A different service is selected in the Playground | Select the service you approved and run again |

## Current limits

Stated plainly, so nothing here overclaims.

- **Testnet only.**
  No real funds are involved anywhere.
- **Your own API must be public.**
  A secret API key or header cannot be attached to forwarded calls yet, because PageSure does not store provider secrets in its database.
- **Session mode needs a provider signer** that holds the provider's treasury key.
  On the hosted instance this is set up for one demonstration organization, so a brand-new account can use charge mode, but not session mode.
- **Sign-in by email** currently reaches only the operator's own inbox, because no sending domain is verified.
  Use **Continue with wallet**.
- **Single server process**, by design: payment replay protection lives in one process's memory.
  See the README for the scaling plan.
