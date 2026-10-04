# Testing PageSure

This guide walks the whole product: the provider console, invitations, tenant isolation, the
optional wallet, and the agent-facing gateway.

It is written to be followed literally.
Every "expect" line is something the build asserts about itself, and every command in it has been
run.
Where something is not verified, it says so rather than describing it as though it works.

## Contents

1. [Before you start](#before-you-start)
2. [Part 1 - Sign in without a wallet](#part-1---sign-in-without-a-wallet)
3. [Part 2 - Invitations and roles](#part-2---invitations-and-roles)
4. [Part 3 - Tenant isolation](#part-3---tenant-isolation)
5. [Part 4 - The wallet, optionally](#part-4---the-wallet-optionally)
6. [Part 5 - Settlement account and signer registration](#part-5---settlement-account-and-signer-registration)
7. [Part 6 - The gateway, from the agent's side](#part-6---the-gateway-from-the-agents-side)
8. [Part 7 - The automated suites](#part-7---the-automated-suites)
9. [Troubleshooting](#troubleshooting)
10. [What is not verified](#what-is-not-verified)

## Before you start

Requirements:

- Node 20 or newer.
- A Stellar **Testnet** account, if you intend to test money movement at all.
  Everything in Parts 1 to 3 and Part 7 works without one.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The console is then on <http://localhost:3000>.

`npm run db:migrate` is safe to run repeatedly.
It applies only the migrations the database has not seen, so run it after every `git pull`.

### Mail

Sign-in and invitation links are delivered by email, so you need to be able to read them.

Locally, unconfigured mail is **printed to the server console** rather than sent.
Watch for lines like this in the terminal running `npm run dev`:

```text
[pagesure] email delivery is not configured; printing the sign-in message
[pagesure] to: you@company.com
[pagesure] link: http://localhost:3000/login/callback?token=...
```

That transport refuses to run when `NODE_ENV=production`, so a misconfigured deployment fails
loudly instead of printing live credentials into its logs.

To send real mail, set `RESEND_API_KEY` and `PAGESURE_PUBLIC_ORIGIN`.
`PAGESURE_PUBLIC_ORIGIN` wins when both it and `APP_URL` are set; either way the value must be
`https` or localhost, because a sign-in link is a credential and this is not the place to relax
that.

`PAGESURE_DEV_MAIL=off` turns the console transport off entirely, which is how you test that
unconfigured mail fails instead of silently succeeding.

### A note on your IP

Sign-in requests and invitations are throttled per IP: **ten of each per fifteen-minute window**.
Everyone behind one office NAT shares that budget.
If you hit "Too many sign-in emails from this network", wait for the window to pass, or clear the
counters in a scratch database:

```bash
sqlite3 data/pagesure.db 'delete from auth_attempts;'
```

## Part 1 - Sign in without a wallet

This is the path that matters most, because a wallet is optional and nothing in it should require
one.

1. Open <http://localhost:3000/login>.
2. Expect a single email field and a **Sign in** button.
   There is no password field anywhere on the page.
3. Enter an email you control, for example `owner@acme.test`, and submit.
4. Expect `Check owner@acme.test for your sign-in link.`
   The form does not navigate anywhere yet.
5. Copy the `[pagesure] link:` URL out of the server console and open it.
6. Expect the **onboarding** page: a single **Organization name** field and a create button.
7. Enter `Acme Research` and submit.
8. Expect `/overview`, with:
   - the organization name `Acme Research` visible in the **header**, without opening any menu;
   - your email in the account chip in the top right;
   - a **Settlement account** panel reading `Not connected`, explaining that until it is connected
     services can be published and everything works except actually taking money.
9. Reload the page.

Expect the same dashboard.
A session that survives a reload is a session, not a flash of state.

### Signing in again

1. Sign out from the account chip.
2. Request a link for the same email again.
3. Expect to land straight on `/overview`, not on onboarding.
   The organization already exists and you are already a member of it.
4. Try using the *same* link a second time.

Expect a refusal, not a second sign-in.
Tokens are single-use.

### While you are here

Try to reach a console page while signed out: `/overview`, `/settings`, `/playground`.
Each redirects to `/login`.

Try `/login?returnTo=https://evil.example.com` while signed out.
You stay on `/login`, and no request reaches `evil.example.com`.

Sign in, then request `/login?returnTo=/settings`.
You land on `/settings`.
Sign in, then request `/login?returnTo=https://evil.example.com`.
You land on `/overview` on this origin, not on the other one.

## Part 2 - Invitations and roles

Use a **second browser profile** or a private window for the second person.
Two tabs in one profile share one session and will not test anything.

As the owner:

1. Open `/settings`.
2. Expect two panels: **Settlement account** and **External channel signer**.
3. Fill **Email address to invite** with `guest@acme.test`.
4. Select a role: `operator` or `analyst`.
5. Click **Invite**.
6. Expect `Invitation sent to guest@acme.test.`
   The invitation link is **not** shown on the page; it is the `[pagesure] link:` line in the
   server console, like a sign-in link.
   If you need to test the acceptance path repeatedly, copy it from there.

There is deliberately **no `owner` option** in the invite role list.
Ownership is not transferable by invitation; promoting somebody is an explicit, separate act.

As the guest, in the private window:

7. Open the invitation link.

Expect `Sign in with the invited address first.` and a **Sign in** button, with the explanation
that an invitation can only be accepted by the person it was sent to.

An invitation is a credential for one specific address, so it is not usable by anybody else and
there is deliberately no email field to retype: accepting is recorded against a real account, and
that account has to be proved first.

8. Click **Sign in**, enter `guest@acme.test`, and submit.
9. Copy the `[pagesure] link:` sign-in URL from the console and open it.
10. Expect to be returned to the invitation link, now showing:

    > You are in. You joined Acme Research as a member.

11. Click **Go to the dashboard**.

Expect `/overview`, with `Acme Research` visible in the header.

### If the guest never opened the link

Sign in as an address that has an unopened invitation, with no organization of its own.

Expect, **above** the organization form:

> You have been invited
> Acme Research as operator
> Open the invitation email on this device and follow its link to join.

There is no **Join** button, and that is deliberate: the token is stored hashed and cannot be
rebuilt, so a button that silently did nothing would be worse than no button at all.
Re-send from `/settings` instead.

As the owner, again:

12. Reload `/settings`.

Expect the member list to show **2** members and the count to have changed.

As the guest:

13. Open `/settings`.

Expect it read-only:

- **Settlement account**: an explanation that connecting one is the owner's job, no input.
- **External channel signer**: no form.
- The invite form is **absent entirely**, not merely disabled.

14. Open `/invite/callback` again with the same token.

Expect a refusal.
The token was consumed, and it is not recoverable from the database, so re-sending is the only
way back.

## Part 3 - Tenant isolation

This is the check that matters most in a multi-tenant product.

1. In the private window, sign the guest in to `Acme Research`.
2. Note the organization name in the header: `Acme Research`.
3. Sign the guest out. Create a second organization in the same private window, `Stranger Corp`.
4. Expect `/overview` showing `Stranger Corp` in the header.
5. Ask whether anything from `Acme Research` is reachable.

Expect nothing.
`Stranger Corp` is a different tenant, and no page, panel, member list, or aggregate may mix the
two.

Two cases are worth doing by hand because they are easy to get wrong:

- **A signed-in stranger opening somebody else's invitation.**
  Sign in as `stranger@acme.test`, who belongs to `Stranger Corp`, then open an invitation link
  addressed to somebody else.
  Expect a refusal, and expect the stranger to still be in `Stranger Corp` afterwards, with the
  invitation still redeemable by its rightful owner.
  A refusal must not consume a credential or change the wrong tenant.

- **A sign-in link opened as an invitation.**
  Take a `/login/callback?token=...` URL and change the path to `/invite/callback?token=...`.
  Expect a refusal.
  The two token purposes are not interchangeable.

## Part 4 - The wallet, optionally

Skip this part unless you have Freighter.

1. Install the [Freighter](https://www.freighter.app) browser extension.
2. Switch it to **Testnet** in the extension's own network settings.
3. Fund the account: XLM from Friendbot at
   `https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>`.
4. On `/login`, click **Continue with wallet**.

Expect a sequence of `Approve in wallet...`, `Waiting for signature...`,
`Verifying signature...`, then `/onboarding` or `/overview`.

The signature must be a `Sign in` challenge for **this** application and **this** session.
A signature over some other text is not a login.

Then:

5. On `/settings`, click **Connect a wallet** in the **Settlement account** panel.

Expect the status to read `Connected`, and the **full** address to be shown underneath in
monospace, not abbreviated.

The status is worth reading rather than skimming, because it distinguishes three states:

| Status | Meaning |
| --- | --- |
| `Not connected` | no address; nothing can receive money |
| `Awaiting proof` | an address is stated but was never proven by a signature |
| `Connected` | proved by a signature for this organization and this wallet |

`Awaiting proof` is labelled `stated but never proven. It cannot receive anything until you sign.`
and is the state to distrust: a settlement address nobody ever signed for should not be able to
receive funds.

6. Reload `/settings`.

Expect `Connected` and the same address, persisted.
7. Sign out. Sign back in with the wallet.

Expect `/overview`, with the same settlement account.
8. Sign out. Sign in by email to the same address.

Expect `/overview` again.
Both routes reach the same identity, because the settlement account is a **proof of control over
money**, not an identity of its own.

## Part 5 - Settlement account and signer registration

Owner-only, and each action requires a fresh signature bound to the organization **and** the
wallet being changed.

1. As the owner, in **Settlement account**, connect a settlement account.
2. In **External channel signer**, enter your signer service URL, for example
   `https://signer.your-company.com`.
3. Enter the **name of the environment variable** that holds its token, for example
   `SIGNER_TOKEN`.

Expect a note stating the token's value is never stored, only the variable name.
The database holds a name, not a credential, and an inspection of the `signer_registrations` rows
should confirm that.

4. Connect a second, different wallet as settlement account.

Expect a **fresh** signature prompt.
A signature from before the change must not be replayable, and neither must one from a different
organization.
5. Register the signer again with a different URL.

Expect a fresh signature again.
6. As the guest, attempt both actions.

Expect refusal, from the server, not merely a hidden form.
Hidden controls are not authorization.
7. Register a signer whose token variable is not set, or a URL that is not `https` outside
   localhost.

Expect rejection naming the problem.

## Part 6 - The gateway, from the agent's side

This half is for an agent or a script, not a browser.
`README.md` has the payment API itself; this is how to check the half the console configures.

```bash
npm run keys:generate        # testnet keypairs, written to .env
# fund the printed accounts:
#   1. XLM for fees:  https://friendbot.stellar.org/?addr=<PUBLIC_KEY>
#   2. USDC trustline: https://lab.stellar.org/account/fund
#   3. USDC balance:  https://faucet.circle.com  (Stellar Testnet)
npm run contracts:build      # one-way-channel WASM from source
npm run channels:deploy      # upload WASM, deploy the channel factory
npm run db:seed
```

Testnet USDC has no public faucet API, so funding is manual.

Then, following `README.md`'s "Using it":

1. **Charge mode.** Send one agent run through `/playground`.

Expect a real upstream call and a real settlement, with the policy trace visible.
`/playground` requires a session and is scoped to your organization.
An unauthenticated request is refused, and one authenticated as `Stranger Corp` cannot see
`Acme Research` usage.

2. **Close.** Send a session close.

Expect HTTP **501**, immediately, with no upstream call and no change to state or request counts.
Close is not implemented; it is a deliberate refusal rather than a fake success.

3. **Session mode.** Open a channel and run repeated requests through it.

Expect `147 requests -> 1 settlement`.
This is the claim that matters most in the whole project.

## Part 7 - The automated suites

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # next build
```

The proof suites are self-contained: each creates its own scratch database, migrates it, exercises
the subject, and closes it.
They need no configuration and no network.

| Command | Checks | Covers |
| --- | --- | --- |
| `npm run prove:isolation` | 59 | no cross-tenant reads or writes |
| `npm run prove:email` | 53 | sign-in tokens, invitations, expiry, single use |
| `npm run prove:treasury` | 31 | settlement account and signer authorization |
| `npm run prove:settlement` | 49 | settlement refusals and 501 paths |
| `npm run prove:auth` | 20 | wallet challenge and signature verification |
| `npm run prove:signer` | 20 | signer policy and transport |
| `npm run prove:commitment` | 20 | commitment construction |
| `npm run prove:upgrade` | 13 | migrating a populated older database |
| **Total** | **265** | |

Expected result for each: `N passed, 0 failed`, where `N` matches the table.
If a count differs, the suite changed; read the diff rather than adjusting the expectation.

```bash
npm run mpp:audit
```

Proves the installed MPP surface and that the EVM paths are unreachable.

## Troubleshooting

**"email delivery is not configured" on the login page.**
The console transport is not active.
Check `NODE_ENV` is not `production` and `PAGESURE_DEV_MAIL` is not `off`, and look at the server
terminal for the printed link.

**"Too many sign-in emails from this network."**
Ten per fifteen minutes, per IP.
See [Before you start](#before-you-start).

**A loop between `/login` and `/overview`.**
You are signed in but have no organization.
Open `/login` and you should be forwarded to `/onboarding`; creating an organization resolves it.
If you see the loop, that forwarding is broken and worth reporting as-is.

**`SqliteError: no such table: ...` on first run.**
Migrations have not been applied: `npm run db:migrate`.

**An invitation link does nothing.**
It was already used.
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

- **No automated end-to-end test drives a browser in this repository.**
  The `/tmp/ps-e2e/*.cjs` harnesses used during development are not checked in, and they depend
  on a local Playwright browser.
  Parts 1 to 3 of this guide are the substitute, and they have been walked by hand.

- **Live channel settlement has not been observed on testnet.**
  The WASM builds and the factory deploys, but end-to-end voucher to settle is unproven in this
  repository.
  If it cannot be made to work, session mode is cut rather than faked.

- **The wallet flows in Part 4 have not been exercised end to end here.**
  Freighter is not available in the headless environment these checks ran in, so Parts 4 to 5
  rest on the `prove:auth` and `prove:treasury` suites plus code review, not on a signed
  transaction.
  Treat them as untested until you have run them yourself.

- **Charge mode can charge without delivering.**
  A policy block raised after settlement does not refund.
  It is bounded by `ungrantedSpendCapBase` and recorded as an incident.

- **This is not a compliance product.**
  The policy engine enforces what a provider configures.
  It performs no sanctions screening.

- **Single process only.**
  The in-memory policy windows and review queues do not survive a restart and do not span
  instances.