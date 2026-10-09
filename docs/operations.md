# PageSure operations runbook

This is an initial production-operations procedure. Keep deployments single-process as required
by the in-memory MPP store; see the deployment constraint in `README.md`.

## Backup and restore

- Back up the SQLite database with SQLite's online backup mechanism while the app is running,
  or stop the app and copy the database together with its WAL state. Do not copy only the main
  database file while writes are active.
- Encrypt backups at rest, restrict access to the operator group, and keep a second encrypted
  copy outside the host. Treat database backups as sensitive: they contain account identifiers,
  request history, signed payer vouchers, and incident data even though they do not contain
  payer private keys.
- Record backup time, database migration version, and checksum in the backup inventory. Test a
  restore into an isolated environment on a schedule and after schema migrations.
- For restore, stop the app, preserve the current database for investigation, restore the chosen
  backup, start the app in a restricted environment, run migrations and `foreign_key_check`, then
  reconcile recent chain transactions before reopening services. Never restore an older DB over
  newer on-chain settlements without reconciliation.

## Logging and secrets

- Log request ids, service slugs, policy decisions, statuses, and transaction hashes for
  correlation. Never log `.env` values, bearer tokens, `Authorization` headers, payer secrets,
  signed transaction envelopes, or full MPP credentials.
- Keep provider, fee-payer, demo-payer, and signer credentials in the deployment secret store.
  Rotate by provisioning a replacement, updating the secret reference, restarting the single
  app/signer process, confirming readiness, then revoking the old credential. For suspected
  exposure, disable the affected service or policy first and rotate immediately.
- Rotate signer bearer tokens on both the PageSure app and the organization's signer as one
  coordinated change; verify `/health` and run a low-value Testnet close before restoring traffic.

## Payment incident response

1. Pause the affected service or tighten its policy to stop new payment challenges.
2. Preserve request id, payer, amount, incident kind, upstream logs, and chain transaction hash.
3. Reconcile chain state with PageSure request/settlement records before retrying or changing
   status. A submitted transaction may still confirm after an HTTP timeout.
4. Resolve payer impact through the provider's documented manual refund/replacement process in
   `docs/charge-guide.md`; a database acknowledgment is not proof of a refund.
5. Record the cause and corrective action in the operator incident record, then re-enable the
   service only after readiness checks pass.
