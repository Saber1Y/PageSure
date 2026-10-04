# Testing PageSure

A walkthrough of the whole product: the provider console, invitations, tenant isolation, the
optional wallet, and the agent-facing gateway.

It is written to be followed literally.
Every command has been run against this build.
Every "expect" is something the application asserts about itself.

Where something is unverified, this guide says so rather than describing it as though it works.
The short version: the console is thoroughly exercised, the wallet flows are not, and session-mode
settlement on testnet remains unproven.

## Contents

1. [Before you start](#before-you-start)
2. [A two-minute smoke test](#a-two-minute-smoke-test)
3. [Part 1 - Sign in without a wallet](#part-1---sign-in-without-a-wallet)
4. [Part 2 - Invitations and roles](#part-2---invitations-and-roles)
5. [Part 3 - Tenant isolation](#part-3---tenant-isolation)
6. [Part 4 - The wallet, optionally](#part-4---the-wallet-optionally)
7. [Part 5 - Settlement account and signer registration](#part-5---settlement-account-and-signer-registration)
8. [Part 6 - The gateway, from the agent's side](#part-6---the-gateway-from-the-agents-side)
9. [Part 7 - The automated suites](#part-7---the-automated-suites)
10. [Troubleshooting](#troubleshooting)
11. [What is not verified](#what-is-not-verified)

## Before you start

Requirements:

- Node 20 or newer.
- A Stellar **Testnet** account, only if you intend to test money movement.
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

To start with an empty database, stop the server, delete `data/pagesure.db`, and re-run
`npm run db:migrate`.
A backup of the previous file is worth keeping, and a consistent copy can be taken while the
server is running:

```bash
sqlite3 data/pagesure.db ".backup 'data/backups/pagesure-$(date +%Y%m%d-%H%M%S).db'"
```

### Mail: pick a mode before you start

Email is the primary credential, so the flow cannot be walked without a way to read the link.
There are two modes, and choosing wrong is the single most common reason this guide appears to
describe a broken application.

| | **Mode A - console** | **Mode B - real delivery** |
| --- | --- | --- |
| Set up | No `RESEND_API_KEY` | `RESEND_API_KEY` set |
| Where the link appears | The server terminal | A real inbox |
| Recipients | **Any address** | **One address only** (see below) |
| Needed for | Multi-user and invitation testing | Confirming mail really leaves the app |

**Mode A is the default for testing**, and it is what Parts 1 to 3 assume.
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
So the invitation flow in Part 2 is only walkable end to end in Mode A, or in Mode B with a
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

If you hit "Too many sign-in emails from this network", wait out the window, or clear the counters
in a scratch database:

```bash
sqlite3 data/pagesure.db 'delete from auth_attempts;'
```

## A two-minute smoke test

The whole console, end to end, in Mode A:

```bash
npm run dev
```

1. Open <http://localhost:3000/login>, request a link for `owner@acme.test`.
2. Copy the `[pagesure] link:` line from the terminal into the browser.
3. Expect onboarding. Create the organization `Acme Research`.
4. Expect `/overview` with `Acme Research` in the header and no wallet involved.
5. Reload. Expect the same dashboard.

That is the core flow, and it needs no configuration, no wallet, and no network.

## Part 1 - Sign in without a wallet

This is the path that matters most, because a wallet is optional and nothing in it should require
one.

1. Open <http://localhost:3000/login>.
2. Expect a single email field and a **Continue with email** button.
   There is no password field anywhere on the page.
3. Enter an email you control, for example `owner@acme.test`, and submit.
4. Expect `Check owner@acme.test for your sign-in link.`
   The page does not navigate yet.
5. Open the link from wherever you are reading mail.
6. Expect **onboarding**: a single **Organization name** field and a create button.
7. Enter `Acme Research` and submit.
8. Expect `/overview`, with:
   - `Acme Research` visible in the **header**, without opening any menu;
   - your email in the account chip at the top right;
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
4. Open the *same* link a second time.

Expect a refusal, not a second sign-in.
Tokens are single-use, and they expire: sign-in links after 15 minutes, invitations after 7 days.

### Guards and redirects

| Try | Expect |
| --- | --- |
| `/overview`, `/settings`, `/services`, `/policies`, `/review`, `/playground` while signed out | redirected to `/login` |
| `/login?returnTo=https://evil.example.com` while signed out | stays on `/login`; no request to `evil.example.com` |
| signed in, `/login?returnTo=/settings` | lands on `/settings` |
| signed in, `/login?returnTo=https://evil.example.com` | lands on `/overview`, same origin |
| signed in, `/login?returnTo=//evil.example.com` | lands on `/overview`, same origin |
| signed in with no organization, `/login` | goes to `/onboarding`, never a redirect loop |

That last row is worth doing by hand.
A signed-in user with no organization is a legitimate state, and it used to bounce between
`/login` and `/overview` forever.

## Part 2 - Invitations and roles

**Use a private window for the second person.**
Two tabs in one browser profile share one session and will test nothing.

As the owner:

1. Open `/settings`.
2. Expect two panels: **Settlement account** and **External channel signer**.
3. Fill **Email address to invite** with `guest@acme.test`.
4. Pick a role: `operator` or `analyst`.
5. Click **Invite**.
6. Expect `Invitation sent to guest@acme.test.`

There is deliberately **no `owner` option** in the role list.
Ownership is not transferable by invitation.

**Getting the invitation link depends on the mail mode:**

- **Mode A** - copy the `[pagesure] link:` URL from the terminal.
- **Mode B with a verified domain** - open the inbox.
- **Mode B without a verified domain** - you cannot complete this part. See
  [Mail: pick a mode](#mail-pick-a-mode-before-you-start).

Note that in both modes the page itself never shows the link.
Printing it would mean putting a credential into the DOM.

As the guest, in the private window:

7. Open the invitation link.

Expect `Sign in with the invited address first.` and a **Sign in** button, with the explanation
that an invitation can only be accepted by the person it was sent to.

There is deliberately **no email field to retype**.
Acceptance is recorded against a real account, and that account has to be proved first, so an
invitation is not transferable to somebody else by guessing an address.

8. Click **Sign in**, enter `guest@acme.test`, and submit.
9. Open the sign-in link.
10. Expect to be returned to the invitation, now reading:

    > You are in. You joined Acme Research as a member.

11. Click **Go to the dashboard**.

Expect `/overview` with `Acme Research` in the header.

### If the guest never opened the link

Sign in as an address that has an unopened invitation and no organization of its own.

Expect, **above** the organization form:

> You have been invited
> Acme Research as operator
> Open the invitation email on this device and follow its link to join.

There is no **Join** button, and that is deliberate.
The token is stored hashed and cannot be rebuilt from the database, so a button that silently did
nothing would be worse than no button at all.
Re-send from `/settings` instead.

### What a non-owner sees

As the guest, open `/settings`.

Expect it read-only:

- **Settlement account**: an explanation that connecting one is the owner's job, and no input.
- **External channel signer**: no form.
- The invite form **absent entirely**, not merely disabled.

Open the invitation link again.

Expect a refusal.
The token was consumed, and re-sending is the only way back.

## Part 3 - Tenant isolation

This is the check that matters most in a multi-tenant product.

1. In the private window, sign the guest out.
2. Create a second organization there, `Stranger Corp`.
3. Expect `/overview` showing `Stranger Corp` in the header.
4. Ask whether anything from `Acme Research` is reachable.

Expect nothing.
No page, panel, member list, aggregate or API response may mix the two tenants.

Three cases are worth doing by hand, because each one was a real bug at some point:

- **A signed-in stranger opens somebody else's invitation.**
  Sign in as a third address belonging to `Stranger Corp`, then open the guest's invitation link.
  Expect a refusal, and expect the stranger to still be in `Stranger Corp` afterwards, with the
  invitation still redeemable by its rightful owner.
  A refusal must not consume a credential or change the wrong tenant.

- **A sign-in link opened as an invitation.**
  Take a `/login/callback?token=...` URL and change the path to `/invite/callback?token=...`.
  Expect a refusal.
  The two token purposes are not interchangeable.

- **The rightful recipient reopens their own used invitation.**
  Accept the invitation, then open the same link again from the same session.
  Expect `That invitation is invalid, has expired, or has already been used.`
  Expect the membership not to change and no second membership to be created.

### Joining an organization you already belong to another one

This one is subtle enough to look like a bug, so it is worth doing deliberately.

1. Sign in as somebody who has their own organization, `Stranger Corp`.
2. Have another organization's owner invite that same address.
3. Open the invitation while signed in.

Expect to be accepted: the invitation was addressed to this address, and that is the only thing
that authorises acceptance.

Then look at the dashboard.

Expect **the console to still show `Stranger Corp`.**
Acceptance records a membership; it does not move you.

That is deliberate - silently switching a signed-in person's workspace because somebody invited
them would be a hijack, not a feature - but it has a consequence worth knowing before you go
looking for the missing button:

> **There is no organization switcher.**
> A user can hold memberships in several organizations, and the console always shows the one they
> were using when they signed in. Joining a second organization therefore appears to do nothing
> visible: the membership exists in the database, and nothing in the interface mentions it.

Verify the membership really was recorded:

```bash
sqlite3 data/pagesure.db "
  select o.name, om.role from organization_members om
  join users u on u.id = om.user_id
  join organizations o on o.id = om.organization_id
  where u.email = 'guest@acme.test';"
```

Both rows should appear.
This is a known gap in the product rather than a test failure, and it is listed again under
[What is not verified](#what-is-not-verified).

## Part 4 - The wallet, optionally

Skip this part unless you have Freighter.
It is also the part this repository has **not** verified end to end; see
[What is not verified](#what-is-not-verified).

1. Install the [Freighter](https://www.freighter.app) extension.
2. Switch it to **Testnet** in the extension's own network settings.
3. Fund the account: XLM from Friendbot at
   `https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>`.
4. On `/login`, click **Continue with wallet**.

Expect `Approve in wallet...`, then `Waiting for signature...`, then
`Verifying signature...`, then `/onboarding` or `/overview`.

The signature must be a `Sign in` challenge for **this** application and **this** session.
A signature over some other text is not a login, and a signature captured from another session is
not replayable.

Then:

5. On `/settings`, click **Connect a wallet** in the **Settlement account** panel.

Expect the status to read `Connected` and the **full** address shown underneath in monospace,
not abbreviated.

The status is worth reading rather than skimming, because it distinguishes three states:

| Status | Meaning |
| --- | --- |
| `Not connected` | no address; nothing can receive money |
| `Awaiting proof` | an address is stated but was never proven by a signature |
| `Connected` | proved by a signature for this organization and this wallet |

`Awaiting proof` is labelled `stated but never proven. It cannot receive anything until you sign.`
That is the state to distrust: a settlement address nobody ever signed for must not be able to
receive funds.

6. Reload `/settings`.

Expect `Connected` and the same address.
7. Sign out, then sign back in with the wallet.

Expect `/overview` with the same settlement account.
8. Sign out, then sign in by email to the same address.

Expect `/overview` again.
Both routes reach the same identity, because a settlement account is a **proof of control over
money**, not an identity of its own.

## Part 5 - Settlement account and signer registration

Owner-only, and each action requires a fresh signature bound to the organization **and** the
wallet being changed.

1. As the owner, connect a settlement account as in Part 4.
2. In **External channel signer**, enter a signer URL such as
   `https://signer.your-company.com`.
3. Enter the **name of the environment variable** holding its token, such as `SIGNER_TOKEN`.

Expect a note that the token's value is never stored, only the variable name.
Inspecting the `signer_registrations` rows should confirm it: a name, never a credential.

4. Connect a second, different wallet as the settlement account.

Expect a **fresh** signature prompt.
A signature from before the change must not be replayable, and neither must one captured for a
different organization.
5. Register the signer again with a different URL.

Expect a fresh signature again.
6. As a non-owner, attempt both actions.

Expect refusal **from the server**, not merely a hidden form.
Hidden controls are not authorization.
7. Try each of these, as the owner, expecting a named rejection each time:

| Attempt | Expect |
| --- | --- |
| A `http://` signer URL outside localhost | rejected: must use https |
| A URL with credentials in it, `https://user:pw@host` | rejected |
| A host not in the deployment's allowlist | rejected, naming the host |
| A token variable that is not set in the process | rejected, naming the variable |

## Part 6 - The gateway, from the agent's side

This half is for an agent or a script rather than a browser.
`README.md` documents the payment API itself; this is how to check the half the console configures.

```bash
npm run keys:generate        # testnet keypairs, written to .env
npm run contracts:build      # one-way-channel WASM from source
npm run channels:deploy      # upload WASM, deploy the channel factory
npm run db:seed
```

Testnet USDC has no public faucet API, so funding is manual.
`npm run keys:generate` prints the three steps: XLM for fees from Friendbot, a USDC SAC trustline
via <https://lab.stellar.org/account/fund>, and USDC balance from
<https://faucet.circle.com> choosing **Stellar Testnet**.

Then follow `README.md`'s "Using it":

1. **Charge mode.** Send one agent run through `/playground`.

Expect a real upstream call and a real settlement, with the policy trace visible.
`/playground` requires a session and is scoped to your organization: an unauthenticated request is
refused, and one authenticated as `Stranger Corp` cannot see `Acme Research` usage.

2. **Close.** Send a session close.

Expect HTTP **501**, immediately, with no upstream call and no change to state or to request
counts.
Close is not implemented; it is a deliberate refusal rather than a fake success.

3. **Session mode.** Open a channel and run repeated requests through it.

Expect `147 requests -> 1 settlement`.
This is the claim that matters most in the project, and it is the one this repository has not yet
observed happening on testnet.

## Part 7 - The automated suites

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # next build
```

The proof suites are self-contained.
Each creates its own scratch database, migrates it, exercises the subject, and closes it.
They need no configuration, no wallet, and no network.

| Command | Checks | Covers |
| --- | --- | --- |
| `npm run prove:isolation` | 59 | no cross-tenant reads or writes |
| `npm run prove:email` | 58 | sign-in tokens, invitations, mail delivery failure |
| `npm run prove:settlement` | 49 | settlement refusals and 501 paths |
| `npm run prove:treasury` | 31 | settlement account and signer authorization |
| `npm run prove:auth` | 20 | wallet challenge and signature verification |
| `npm run prove:signer` | 20 | signer policy and transport |
| `npm run prove:commitment` | 20 | commitment construction |
| `npm run prove:upgrade` | 13 | migrating a populated older database |
| **Total** | **270** | |

Expect `N passed, 0 failed` from each, where `N` matches the table.
If a count differs, the suite changed: read the diff rather than adjusting the expectation to
match.

```bash
npm run mpp:audit
```

Proves the installed MPP surface and that the EVM paths are unreachable.

### Browser tests

**There is no automated browser test in this repository.**
The Playwright harnesses used while building this were kept outside the tree, in `/tmp/ps-e2e/`,
and they depend on a locally installed browser.

Parts 1 to 3 of this guide are the substitute.
They have been walked by hand, and they cover the things worth checking by eye: the redirect
behaviour, token lifetimes, single use, and the cross-tenant refusals.

## Troubleshooting

**The page says "Check your email" and nothing arrives.**
You are in Mode B and the address is not the one your provider will deliver to.
Check which mode you are in, and see
[Mail: pick a mode](#mail-pick-a-mode-before-you-start).

**The page says "The sign-in email could not be sent. the mail provider rejected the message".**
The provider refused it, and the reason is in the server log.
A send-only restriction like Resend's sandbox produces this for any address other than the
account's own.
The provider's full response is logged, never displayed, because it carries the account's own
address and internal identifiers.

**"Too many sign-in emails from this network."**
Ten per fifteen minutes, per IP.
Clear them with the `sqlite3` line in [The throttle](#the-throttle).

**A loop between `/login` and `/overview`.**
You are signed in with no organization.
Opening `/login` should forward you to `/onboarding`; creating an organization resolves it.
A loop means that forwarding is broken and is worth reporting as-is.

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

- **The wallet flows in Parts 4 and 5 have not been exercised end to end here.**
  Freighter is unavailable in the headless environment these checks ran in, so they rest on
  `prove:auth`, `prove:treasury` and code review rather than on a signature this repository has
  watched happen.
  Treat Parts 4 and 5 as untested until you have run them yourself.

- **Live channel settlement has not been observed on testnet.**
  The WASM builds and the factory deploys, but end-to-end voucher to settle is unproven here.
  If it cannot be made to work, session mode is cut rather than faked.

- **Charge mode can charge without delivering.**
  A policy block raised after settlement does not refund.
  It is bounded by `ungrantedSpendCapBase` and recorded as an incident.

- **Real email delivery has been confirmed for one address only.**
  Mode B was verified to a single recipient, which is the most Resend's sandbox sender allows.
  Delivery to arbitrary addresses needs a verified domain and has not been tested.

- **A user who joins a second organization gets no way to reach it.**
  Acceptance deliberately leaves an existing user's workspace alone, but there is no organization
  switcher, so a second membership is recorded and then invisible.
  Verified in the database; not exposed anywhere in the interface.

- **This is not a compliance product.**
  The policy engine enforces what a provider configures.
  It performs no sanctions screening.

- **Single process only.**
  The in-memory policy windows and review queues do not survive a restart and do not span
  instances.