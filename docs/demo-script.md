# PageSure demo video

How to plan, record, edit and submit the PageSure demo video for the Find Your Way hackathon.
The video must be **3 minutes or less**.
It is UI only: no terminal, no code on screen.

Every button name, field label and on-screen message below was checked against the code and against live rehearsals on https://pagesure.vercel.app on 2026-10-12.

## The story in one breath

**Problem.** AI agents are starting to buy data and services on their own, but every paid API is built for humans: an account, a card, an API key, a monthly invoice.
An agent cannot do any of that, so it cannot pay.

**Solution.** PageSure is a payment gateway for machines.
A provider puts their API behind PageSure, sets a price and a policy, and gets a URL to hand to agents.
An agent calls the URL, receives `HTTP 402 Payment Required`, pays in USDC on Stellar, and gets the data.

**Proof.** We show it live: a brand-new provider account, a real public API, a policy that holds an unknown agent, a real Stellar payment, and the transaction on stellar.expert.

Keep coming back to this arc while recording.
Every scene answers one of three questions: what is broken, what does PageSure do about it, and how do we know it is real.

## Run of show

| Time | Act | Scene | What the viewer learns |
|---|---|---|---|
| 0:00 | Problem | 1. The hook | Agents cannot pay for APIs today |
| 0:20 | Solution | 2. Sign up with a wallet | A provider onboards with a Stellar wallet, no email or password |
| 0:40 | Solution | 3. Turn an API into a paid endpoint | Any HTTPS API becomes a priced URL for agents |
| 1:15 | Solution | 4. An unknown agent arrives | Policy runs before money moves; unknown agents are held, not charged |
| 1:35 | Solution | 5. The provider decides | Review and approve with a time-boxed grant |
| 1:50 | Proof | 6. The agent pays and gets the data | 402, Stellar payment, verified, real API response |
| 2:25 | Proof | 7. The money is on chain | A real Stellar transaction, paid straight to the provider |
| 2:45 | Close | 8. The pitch | One line the judges remember |

The optional session-mode scene (about 25 seconds) is described after scene 8.
Include it only if you can spare the time and it rehearses cleanly.

## Part 1: Prepare (about 20 minutes, once)

### 1.1 Accounts and wallet

You need one brand-new provider account for the main flow.

1. Install the **Freighter** browser extension (freighter.app).
2. Create a **new** wallet in Freighter.
   Do not reuse a wallet that already signed in to PageSure: an existing wallet goes straight to the console and the sign-up scene will not happen.
3. Switch Freighter to **Testnet**: click the globe icon at the top left, then choose **Testnet**.
   If you skip this, PageSure stops and shows "Freighter is on Mainnet. PageSure runs on Stellar Testnet...".
4. Fund the wallet with free Testnet XLM: on Freighter's home screen, click **Fund with Friendbot**.
5. Add the USDC trustline so the wallet can receive payments:
   1. Open the **...** menu, choose **Manage assets**, then **Add an asset**.
   2. Paste Circle's Testnet USDC issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.
      Searching for "USDC" by name shows dozens of look-alike assets, so always paste the issuer.
   3. Click **Add**, then **Confirm**, and wait for **Success!**.

No real money is involved anywhere.
Everything runs on Stellar Testnet, and the agent in the Playground pays from PageSure's own funded demo wallet.

### 1.2 The API you will sell

Copy this URL somewhere you can paste it from during the take.
It is Open-Meteo's free, public weather API for Lisbon:

```
https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m
```

Decide the names you will type on camera:

| Field | Value |
|---|---|
| Organization | `Lisbon Labs` |
| Service name | `Lisbon Weather` |
| Service address | `lisbon-weather` |

Service addresses are global across every organization.
If you rehearse with an address, it stays taken, so use a different one on the real take (for example `lisbon-weather-live`).

### 1.3 Browser and screen

- Use a separate browser profile with only Freighter installed: no bookmarks bar, no other extensions, no personal tabs.
- Set the window to 1920 x 1080 (or record a 1920 x 1080 region) and zoom to 100%.
- Pin Freighter to the toolbar so its popups are easy to reach.
- Turn on Do Not Disturb so no notifications appear.
- Open https://pagesure.vercel.app in the first tab.
  The browser tab shows the PageSure icon: a white P with a blue dot.

### 1.4 Recording tools

- **Screen:** QuickTime (File, New Screen Recording), OBS, or Loom.
  Record at 1080p, 30 frames per second.
- **Voice:** a headset or USB microphone in a quiet room.
  Recording the voice separately and laying it over the screen recording is the easiest way to hit 3:00 cleanly.
- **Editing:** iMovie, CapCut, DaVinci Resolve, or Loom's trimmer are all fine.

### 1.5 Rehearse once, end to end

Do the full flow once with a throwaway wallet and throwaway names.
It takes about 4 minutes and tells you where you hesitate.
Then create a fresh Freighter wallet (repeat 1.1) for the real take.

## Part 2: Record, scene by scene

Each scene lists the goal, what is on screen, what to do, what to say, and what the judges should notice.
Read the **Say** lines in your own words; they are written to be spoken, not recited.

### Scene 1 (0:00-0:20) - Problem: agents cannot pay

**Goal:** make the problem obvious in 20 seconds.

**Screen:** the PageSure home page.

**Do:** nothing yet.
Let the page sit while you talk, or scroll slowly.

**Say:**

> AI agents are starting to do real work on their own: researching, comparing prices, calling APIs.
> But every paid API is built for humans.
> You sign up, add a credit card, copy an API key, and get an invoice at the end of the month.
> An agent can't do any of that, so today it can't pay for anything.

**Judges should notice:** the problem is concrete and universal.

### Scene 2 (0:20-0:40) - Solution: a provider signs up with a wallet

**Goal:** show onboarding is one wallet signature, not a form.

**Screen:** Sign in, then Freighter, then the Overview.

**Do:**

1. Click **Sign in**, then **Continue with wallet**.
2. In Freighter, click **Connect**, then **Confirm** to sign.
3. PageSure shows **Create your organization**.
   Type `Lisbon Labs` and click **Create organization**.
4. Freighter asks for one more signature: click **Confirm**.
5. You land on **Overview**.

**Say:**

> PageSure is a payment gateway for machines, built on Stellar.
> I'm an API provider, and I sign up with my Stellar wallet: no email, no password.
> The wallet that just signed is where my earnings will land.

**Judges should notice:** Stellar is the identity, not only the payment rail.

### Scene 3 (0:40-1:15) - Solution: turn any API into a paid endpoint

**Goal:** show the core value: bring your own API, get a URL agents can pay.

**Screen:** Services, then the Create service form, then the service page.

**Do:**

1. Click **Services**, then **New**.
2. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `Lisbon Weather` |
   | Address | `lisbon-weather` |
   | Price per call (USDC) | `0.01` |
   | What it calls | **Your HTTPS API** |
   | API URL | paste the Open-Meteo URL |
   | Payment mode | **Charge - one transaction per call** |
   | Publish as | **Live - accepts paid calls now** |
   | Policy | leave the default |

3. Click **Create service**.
4. On the service page, point at the endpoint under **Integration**: `https://pagesure.vercel.app/v1/lisbon-weather`.

**Say:**

> Here's the solution.
> I bring my own API, here a weather API, and set a price of one cent per call.
> PageSure gives me this URL, and that URL is what I hand to agents.
> Call it without paying, and it answers HTTP 402 Payment Required, with a price an agent can read and pay automatically.

**Optional line** (point at the API URL help text):

> It only forwards to public HTTPS addresses, so nobody can point PageSure at internal systems.

**Judges should notice:** HTTP 402 finally does what it was designed for, and the provider did not write any payment code.

### Scene 4 (1:15-1:35) - Solution: policy runs before money moves

**Goal:** show the provider stays in control, and nobody is charged for a request that is refused.

**Screen:** the Playground.

**Do:**

1. Click **Playground** in the top menu.
2. Under **Service**, pick **Lisbon Weather**.
3. Under **Query parameters**, type `timezone=Europe/Lisbon`.
4. Click **Run paid request**.
5. Point at the lifecycle as it appears: **REQUEST**, **POLICY_CHECK**, then **REVIEW_PENDING: held for a human, nothing charged**.

**Say:**

> This playground is an AI agent with its own Stellar wallet, calling my URL the way any agent would.
> It has never called my API before, so my policy holds it for review.
> The policy runs before any payment exists, so a held request costs the agent nothing.

**Judges should notice:** payments and permissions are one system, and the safe default is "hold", not "charge".

### Scene 5 (1:35-1:50) - Solution: the provider decides who gets in

**Goal:** show human-in-the-loop control in one click.

**Screen:** Review.

**Do:**

1. Click **Review** in the top menu.
2. Point at the held request: the agent's wallet, **on Lisbon Weather**, the reason "wallet is not known to this provider", and the amount `0.0100000 USDC`.
3. Click **Approve and grant**.

**Say:**

> I approve this agent.
> That creates a time-limited grant for this one service, not a permanent allowlist entry.
> In Policies I can also cap spending per request and per day, rate-limit, or block a wallet outright.

**Judges should notice:** this is provider-side access control that crypto payment rails usually lack.

### Scene 6 (1:50-2:25) - Proof: the agent pays and gets the data

**Goal:** the money moment.
Show the full lifecycle and a real response.

**Screen:** the Playground.

**Do:**

1. Click **Playground**.
   **Lisbon Weather** and `timezone=Europe/Lisbon` should still be selected; if not, set them again.
2. Click **Run paid request**.
3. Narrate the seven steps as they appear (it takes about 5 to 10 seconds):

   | Step on screen | Say |
   |---|---|
   | **REQUEST**, **POLICY_CHECK** | "The agent calls the URL, and the policy now allows it." |
   | **CHALLENGE** | "PageSure answers 402: pay 0.01 USDC to this provider." |
   | **SIGNING**, **SIGNED** | "The agent signs a USDC transfer on Stellar." |
   | **SERVICE_EXECUTED** | "The payment is verified on chain, so PageSure calls my real API." |
   | **RESULT** Delivered | "And the agent gets the data." |

4. Scroll to **Service response** and point at `"timezone": "Europe/Lisbon"` and the current temperature.

**Say:**

> No account, no API key, no invoice.
> One HTTP request, one Stellar payment, and live data back in a few seconds.

**Judges should notice:** this is a real API answering, not a mock, and the query the agent sent (`timezone=Europe/Lisbon`) reached it.

### Scene 7 (2:25-2:45) - Proof: the money is real and on chain

**Goal:** remove any doubt that the payment is simulated.

**Screen:** Settlements, then stellar.expert.

**Do:**

1. Click **Settlements** in the top menu.
2. Point at the row: `charge`, `0.0100000 USDC`, `1` call, `confirmed`.
3. Click the transaction hash.
   stellar.expert opens on Testnet with the transaction.
4. Optional: open Freighter and show the `0.01` USDC that arrived.

**Say:**

> Every payment is a real Stellar transaction, paid straight into the provider's wallet.
> PageSure never holds the money.
> And for agents that call thousands of times, PageSure also has session mode: open a payment channel once, send signed vouchers off chain, and settle everything in a single transaction.
> We've settled 150 requests with one closing transaction on Testnet.

**Judges should notice:** meaningful use of Stellar, with on-chain evidence.

### Scene 8 (2:45-3:00) - The pitch

**Goal:** one line that sticks.

**Screen:** click **Overview**, which now shows the request and the payment volume.

**Say:**

> PageSure turns any API into a URL that AI agents can pay, per call, in USDC on Stellar, with the provider in control.
> It's live on Testnet at pagesure.vercel.app, and it's open source.

Stop recording a second after you finish speaking.

### Optional scene (about 25 seconds) - Scale: session mode

Session mode only works for an organization whose treasury key is held by the PageSure signer.
On the hosted instance that is the existing **Saber reasearch** organization, not the new account you just created.
Record this as a separate clip and cut it in after scene 7.

**Before recording this clip:**

1. In the console, open the account menu at the top right and click **Sign out**.
2. On the sign-in page, enter the owner email of **Saber reasearch** and click **Continue with email**.
3. Open the sign-in link from your inbox.
   Do this off camera: the email can take a minute.
   If the email never arrives, cut this scene; the main flow does not depend on it.

**Do:**

1. Click **Playground**, and under **Service** pick **Market Data** (marked "session", 0.002 USDC per call).
2. Click **Open session**.
   The Session card appears with a session id, the channel contract and the funded amount.
3. Under **Requests to send**, leave `4`, and click **Send 4 requests**.
   Watch **Spent so far** rise, with no on-chain transaction per call.
4. Click **Send 4 requests** once more, to show a second batch on the same channel.
5. Click **Settle & close**.
6. Point at the session now reading closed, at **Paid provider** (8 requests), and at **Close transaction**.

**Say:**

> Same gateway, a different payment mode.
> An agent that calls often opens a channel once.
> Each call is just a signed voucher, off chain and free.
> When it's done, one transaction pays for everything.

## Part 3: Edit and export

1. **Trim** dead time: page loads, typing, waiting for Freighter.
   Speed up typing in the service form 2x if needed.
2. **Keep** the seven Playground steps and the stellar.expert page at normal speed; they are the proof.
3. **Add captions** for the key moments if your editor supports it: "402 Payment Required", "held for review: nothing charged", "paid on Stellar", "real transaction".
4. **Zoom** (crop in) on small text when it matters: the lifecycle steps, the Settlements row, the transaction hash.
5. **Check the length:** the final cut must be 3:00 or less.
6. **Export** at 1080p, MP4 (H.264).

## Part 4: Publish and submit

1. **Upload** the video to YouTube as **Unlisted** (or Loom), and copy the link.
   Open the link in a private window to make sure it plays without signing in.
2. **Submit** on the hackathon page (Find Your Way, Stellar Passport) with:

   | Field | What to enter |
   |---|---|
   | Project name | PageSure |
   | Describe your project | Problem, solution, how it uses Stellar, and what is live (see below) |
   | Submission Track | **General Track** |
   | Email | your email |
   | Link to your repo | https://github.com/Saber1Y/PageSure (it must be public) |
   | Link to your video pitch | the YouTube or Loom link (3 minutes max) |
   | Any other relevant links | https://pagesure.vercel.app and one stellar.expert transaction link |
   | Terms and Conditions | tick the box |

3. **Description outline** for the "Describe your project" field:
   - Problem: AI agents cannot pay for APIs that are built for humans.
   - Solution: PageSure puts any HTTPS API behind a URL agents can pay with HTTP 402 and Stellar.
   - How it uses Stellar: Stellar MPP charge (one USDC transfer per call) and session mode (one-way payment channels on Soroban, many calls, one close), Freighter sign-in, payouts straight to the provider's wallet.
   - Provider control: policy before payment, review queue, time-boxed grants, caps, rate limits, incidents.
   - What is live: the hosted Testnet deployment, plus the on-chain evidence links.
4. **Deadline:** 12 October 2026, 23:59 UTC.

## If something goes wrong on camera

| You see | What happened | What to do |
|---|---|---|
| "Freighter is on Mainnet. PageSure runs on Stellar Testnet..." | Freighter is on its default network | Globe icon, **Testnet**, then **Continue with wallet** again |
| PageSure goes straight to Overview, no **Create your organization** step | This wallet already has an account | Create a new Freighter wallet and start the take again |
| "Payments cannot land yet..." (Settings or Playground) | The wallet is not funded, or has no USDC trustline | Do step 1.1.4 and 1.1.5, wait about 30 seconds, and run again |
| "That address is already taken" | Another organization used that service address | Add a suffix, for example `lisbon-weather-live` |
| "The API URL must be reachable on the public internet." | The URL is not public https on port 443 | Paste the Open-Meteo URL exactly as given |
| The request is held again after approving | A different service is selected in the Playground | Select **Lisbon Weather** and run again |
| "Request failed" in session mode | Testnet's RPC occasionally returns data the SDK cannot read; the playground retries once | Send again; nothing was charged for the failed call |

Retake the scene rather than explaining an error on camera.
None of these cost real money.

## Accuracy notes for the narration

Stay inside what is verified, so nothing in the video can be challenged.

- **Real:** the Open-Meteo response, the USDC payment, the Settlements row and the stellar.expert transaction are all live.
- **The Playground agent** runs on PageSure's server and pays from PageSure's own funded Testnet wallet.
  Say "an agent with its own Stellar wallet", not "my agent" or "a third-party agent".
  Any real agent can call the same URL and pay from its own wallet.
- **The 150-request session run** settled 150 requests with one closing transaction on Testnet, but every request in it was answered by the local development quote, not a live API.
  Say "settled 150 requests with one closing transaction"; do not say they were served by a real API.
- **"PageSure never holds the money"** is accurate: charge payments go straight to the provider's wallet, and in session mode the agent funds its own channel.
- **Your own API** must be public today.
  There is no way yet to attach a secret API key to the forwarded call.
  Do not claim private or authenticated APIs are supported.
- **Everything is Testnet.**
  Do not imply mainnet or real funds.
