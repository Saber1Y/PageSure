# Charge mode setup and operation

Charge mode settles one Stellar transaction per successful request. This is the operational
guide for preparing a provider and validating the flow. The live one-off charge run is still
pending because the seeded local organization has not verified its treasury.

## Provider setup

1. Configure the database, Stellar network/RPC, and fee payer using `.env.example`. Use
   `stellar:testnet` for Testnet. Never store a signing secret or signer bearer token in the DB.
2. Run migrations and seed the local demo organization if needed:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

3. In the provider console, connect and verify the organization's settlement wallet. A pasted
   address is not enough: charge mode remains unavailable until the owner signs the treasury
   challenge.
4. Configure the service's upstream credentials and keep `PAGESURE_UPSTREAM_MODE=strict`.
   Missing credentials must fail visibly; local fallback responses are not delivery evidence.
5. Set the service to **Charge**, publish it, and attach an active policy that permits its
   network and asset. Choose whether unknown payers are allowed, held for review, or blocked.
6. Fund the payer with Testnet USDC and its account with Testnet XLM. The payer signs the MPP
   transaction authorization; PageSure's fee payer pays network fees.
7. Set `PAGESURE_UPSTREAM_TIMEOUT_MS` to a bounded request deadline (default 15 seconds, clamped
   between 100 ms and 60 seconds). The caller's disconnect signal also cancels the upstream call.

## Request lifecycle

The caller declares its payer with `X-Pagesure-Payer` and calls `/v1/:slug`. PageSure evaluates
policy before issuing a challenge. A block returns `403`; review returns `202`. Neither path calls
the upstream or takes payment.

An allowed unpaid request returns `402` and `WWW-Authenticate: Payment ...`. The encoded request
specifies amount in base units, asset contract, treasury recipient, and a request id. The payer's
MPP client signs and retries. PageSure verifies and settles the payment, rechecks policy against
the cryptographically verified payer, then calls the real upstream. A successful response
includes the payment receipt, transaction hash, request id, and settlement id.

Charge settlement happens during credential verification. A later payer mismatch, policy denial,
or upstream failure can therefore leave a paid-but-undelivered request. PageSure records the
incident and never claims an automatic refund. The provider must review the incident and resolve
it with the payer under this manual process:

1. Open the incident and its request. Reconcile the request's payer, amount, service, and payment
   transaction with the provider's upstream logs and the chain.
2. Contact the payer and decide whether to refund, provide replacement service, or explain why
   the request could not be delivered. A refund is a separate transfer from the provider treasury;
   PageSure does not initiate, verify, or automatically retry refunds.
3. Keep the decision and any refund transaction hash in the provider's incident/support record.
   Acknowledge the PageSure incident only after the resolution is complete; acknowledgment marks
   that the provider handled it, not that a refund happened.
4. Reconcile the separate refund transfer with treasury records. It does not erase or rewrite the
   original charge settlement.

## Retry and idempotency behavior

Each `402` challenge and its paid retry share one PageSure request id. Search may fall through to
another configured provider after a provider error, but PageSure does not retry the same provider
automatically; retries could incur another upstream charge or duplicate work. The gateway does
not yet deduplicate separate HTTP calls using a caller-supplied idempotency key. If a caller times
out after payment may have settled, it must reconcile the request id/transaction before starting
a new paid request. Provider credentials are read from the environment when each request runs;
coordinate rotation with a process restart and readiness check.

## Testnet acceptance

Run the non-secret readiness report, resolve any failed required checks, then start the app with
the configured environment:

```bash
npm run readiness
```

The report checks migrations and foreign keys, live service-policy bindings, verified treasuries,
upstream configuration, fee-payer account funding, demo payer-key consistency, the channel factory,
signer health, and the Testnet guard. A public-check result shows status only; it never prints a
key or credential value. Then run:

```bash
npm run e2e:charge
```

The runner refuses non-Testnet configuration. It checks the unpaid challenge, performs one real
MPP pull payment at the configured service price, and reconciles the response with the request,
settlement, activity, and successful chain transaction. It temporarily allowlists the demo payer
and removes that entry in cleanup. Preserve the sanitized output and transaction hash in
`docs/testing-guide.md` after the run succeeds.

## Recovery

- **Expired `402` challenge:** request a fresh challenge; do not reuse the expired credential. A
  challenge alone is not a payment. If the payer submitted a transaction before seeing a timeout,
  check the transaction hash on Testnet before starting a new paid attempt.
- **Submitted transaction not yet confirmed:** retain the transaction hash and poll/check it via
  the configured Stellar RPC. Do not interpret an HTTP timeout as a failed transaction or blindly
  pay again. Reconcile the chain result with the request and settlement rows before retrying.
- **Paid but undelivered:** follow the manual incident resolution above. The original settlement
  remains real even if a separate refund is later sent.

The offline gateway proof is separate:

```bash
npm run prove:charge
```

It exercises block/review no-charge behavior and paid mismatch/upstream-failure incident records,
but substitutes MPP settlement and upstream responses; it is not live transaction evidence.
`npm run prove:upstream` separately verifies deadline enforcement, no same-provider retry, and
credential lookup after rotation without making network calls.
