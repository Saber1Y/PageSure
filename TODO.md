# PageSure end-to-end rollout TODO

This list tracks the path from a local checkout to a verified paid API call, then to a
verified multi-request session. A code path or demo is not marked complete until its acceptance
check has evidence attached.

## P0 — Prove the charge flow on testnet

- [x] Exercise block and review paths in `prove:charge`; both take no payment and make no
  upstream call (68 offline gateway checks passed 2026-10-09).
- [x] Exercise upstream failure and verified-payer mismatch after charge in `prove:charge`;
  incidents are visible, accurately named, and never imply an automatic refund.
- [ ] Start from a clean database and configure a real organization, verified settlement
  treasury, funded payer, fee payer, and real upstream credential. The local seeded treasury is
  currently unverified, so live charge execution correctly refuses to proceed.
- [ ] Make a live unpaid request and confirm the `402` challenge amount, asset, destination,
  and request id; then pay and retry with the MPP client and verify the response, rows, activity,
  and confirmed chain transaction. Runner: `npm run e2e:charge`.
- [ ] Save sanitized live charge output and transaction references in the testing guide.

## P0 — Prove the session flow on testnet

- [ ] **Resolve commitment-key ownership before any independent-payer rollout.** The channel
  contract assigns the commitment private key to the funder. The session endpoint now accepts
  that payer-owned public key, stores each verified payer voucher, and the provider signer only
  supplies treasury authorization. The earlier proof runner shared its seed; that wiring has
  been removed. Keep this item open until an independent-party review passes. The local demo
  runner still reads `AGENT_COMMITMENT_SEED` from `.env`; it is a demo payer client secret and
  must not be treated as evidence that a deployed PageSure instance never holds payer keys.
- [x] Review the experimental one-way-channel close/refund behavior and record the launch
  policy: Testnet-only until an independent contract audit and key-separation review pass.
  Documented in `docs/channel-lifecycle.md`; upstream still labels the contract unaudited.
- [x] Add and run offline proofs that a different amount/channel fails payer-signature checks
  and the provider signer environment strips `AGENT_COMMITMENT_SEED` (20 commitment checks;
  59 settlement checks; 55 isolation checks passed on 2026-10-09).
- [ ] Independently review that production payer secrets are never sent to or stored by the
  provider service; the local demo runner intentionally holds a demo payer key in `.env`.
- [x] Build the channel and factory WASM from a recorded upstream commit; retain build hashes
  in `contracts/BUILD_PROVENANCE` (upstream commit `25dea1b303495a7a4184af7605bbb7671ff08da6`).
- [x] Deploy the factory and verify its administrator and channel WASM hash on-chain. The
  read-only Testnet checks matched; channel WASM hash `e990bef9ddb8fdac672431d1d95fc804188ef476b73a0f9a7dcd3f004387d815`.
- [x] Configure and verify the provider treasury and external signer service without putting
  private keys or bearer tokens in the database; the payer commitment key is supplied per
  channel open.
- [x] Open and fund a payer-owned channel; the successful run below confirms PageSure reads its
  on-chain funder, recipient, token, and commitment key.
- [x] Deliver repeated requests and verify verified vouchers advance the cumulative; the
  interrupted run below also recorded the upstream failure as charged-not-delivered.
- [x] Close through the organization signer; the two runs below verified one close transaction
  pays the cumulative amount and the session, request, and settlement records agree.
- [ ] Run the `147 requests → 1 close settlement` claim with enough channel funding, or revise
  the claim to the largest observed result. Keep open and close transaction hashes as evidence.
- [x] Offline proofs verify policy block before voucher acceptance and no cumulative advance.
  The Testnet recovery run recorded a paid-but-undelivered voucher. The session API says the
  amount may be collected at close; request and incident screens now distinguish a payer
  authorization from an on-chain settlement and tell the provider to resolve it before close.

### Testnet session evidence — 2026-10-09

- Successful four-request run: session `ses_57545c77962f474bb232e099`, 4 × 100,000 base units,
  cumulative `400000`, 4 paid request rows, session closed, treasury balance increased by
  `0.0400000` USDC. Open [transaction](https://stellar.expert/explorer/testnet/tx/cbee1d3dc1673a5a90e0e1ea26e7d64720091e33e8a160ee34e6628c48ec0445); close
  [transaction](https://stellar.expert/explorer/testnet/tx/088013e09e35ba4bf70660a156e655964a8a14b251ac68ac899d5467a25a4c45).
- Recovery run after a transient upstream fetch failure: session `ses_8e4662a7ab204843afcaec48`,
  two delivered requests and one `charged_not_delivered` request. The payer-authorized cumulative
  `300000` (including the failed delivery) was settled; the incident and failed request remain
  visible in the database. Open [transaction](https://stellar.expert/explorer/testnet/tx/04428a287e31d31c2b6a8a47e321fa986e34678f01c406bb7d86700c01b33da9); close
  [transaction](https://stellar.expert/explorer/testnet/tx/c0d6d934e70a436d6620fddcd2d4fbf5c1d25c810b2347e4a3dc9715bb088b1e).
- The `147 requests → 1 close settlement` target remains unverified. Both runs emitted the SDK
  warning that cumulative anti-reset protection uses no persistent store; keep deployment
  single-process until persistent compare-and-set storage is implemented.

## P1 — Make setup and operations repeatable

- [x] Add one operational guide for each payment mode and remove conflicting charge-flow claims
  from the testing guide. `docs/charge-guide.md` owns charge setup; `docs/channel-lifecycle.md`
  owns session setup and recovery. The testing guide links to both and records evidence.
- [x] Add `npm run readiness` for migrations, foreign keys, service/policy binding, treasury
  verification, upstream configuration, fee-payer funds, channel factory, payer key consistency,
  signer health, and a Testnet guard. It emits statuses only. On 2026-10-09 it passed 15/21:
  migrations, bindings, upstream config, fee payer, payer key, factory, and Testnet; expected
  local blockers were unverified treasury and stopped signer.
- [x] Document recovery for abandoned `opening` sessions, expired challenges, signer outages,
  and submitted-but-unconfirmed transactions in `docs/charge-guide.md` and
  `docs/channel-lifecycle.md`.
- [x] Record the deployment decision in `README.md`: one long-running Node process only; no
  serverless or multiple instances until the store supplies linearizable compare-and-set.
- [x] Define backup/restore, sensitive logging, credential rotation, and payment incident
  response procedures in `docs/operations.md`.

## P2 — Close product and production gaps

- [x] Prevent publishing a live session service until its verified treasury, signer HTTPS URL,
  configured signer token, and channel factory are present; operators can save drafts and get
  an explicit missing-setup message. `prove:services` passes 72 checks.
- [ ] Add automated coverage for the HTTP gateway and browser-facing console, especially
  payment retry, review approval, and incident recording.
- [x] Document charge-mode paid-but-undelivered resolution: reconcile the payment, contact the
  payer, handle any refund as a separate treasury transfer, retain the refund reference, and
  acknowledge only after resolution (`docs/charge-guide.md`).
- [ ] Evaluate persistent atomic payment state before supporting multiple app instances.
- [x] Set a bounded upstream timeout with caller cancellation; document that configured search
  providers may be fallback targets but the same provider is not retried automatically. Credentials
  are resolved per request and rotate with a coordinated restart. Separate HTTP-call idempotency
  is not implemented and remains a product gap. `prove:upstream` covers timeout and rotation.

## Already present in this checkout

- [x] Provider service creation, including charge/session selection.
- [x] Preflight policy block/review and recorded policy traces.
- [x] Charge and channel gateway handlers, provider console, and session playground lifecycle.
- [x] `scripts/e2e-session.ts` for a live testnet session run (`prepare` and `run`).
- [x] Soroban contract build/deploy scripts and a separate organization signer service.

These items are implementation inventory, not evidence that a live chain flow has passed.
