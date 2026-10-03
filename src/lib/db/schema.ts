import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * All monetary amounts are stored as base-unit STRINGS (e.g. '100000' = 0.01 USDC at
 * 7 decimals), matching what MPP puts on the wire. Never store money as a float.
 *
 * All timestamps are integer unix milliseconds (UTC).
 */

/**
 * Provider operators.
 *
 * There is no password column and no seeded row. An account is created the first time
 * someone proves control of the settlement wallet, so the credential lives in the
 * operator's wallet rather than in a .env file that ships with the repo.
 *
 * `walletPublicKey` is the ROOT of trust: it must equal PROVIDER_RECIPIENT_G. A passkey
 * is a second, revocable way in, and is only ever created from an already-authenticated
 * session, so a passkey can never be the thing that bootstraps an account.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /**
     * Display/contact only. Nullable because wallet sign-in has no email to collect, and
     * nothing authenticates against it.
     */
    email: text('email'),
    /** Stellar ed25519 public key that signed the enrolment challenge. Unique. */
    walletPublicKey: text('wallet_public_key'),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['owner', 'operator'] })
      .notNull()
      .default('owner'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('users_email_idx').on(t.email),
    uniqueIndex('users_wallet_idx').on(t.walletPublicKey),
  ],
)

/**
 * Single-use challenges for wallet sign-in.
 *
 * SEP-0007 shape: the server issues random bytes, the wallet signs them, the server
 * verifies. The row exists so a challenge can be consumed exactly once — without it a
 * captured signature would be replayable forever.
 *
 * `purpose` keeps enrolment and login challenges in one table without letting a login
 * challenge enrol an account, or an enrolment challenge mint a session.
 */
export const loginChallenges = sqliteTable(
  'login_challenges',
  {
    id: text('id').primaryKey(),
    /** The exact bytes the wallet signs. Never store the signature. */
    challenge: text('challenge').notNull(),
    purpose: text('purpose', { enum: ['enrol', 'login'] }).notNull(),
    /** Wallet the challenge was issued to; null before the client states which one. */
    walletPublicKey: text('wallet_public_key'),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('login_challenges_expiry_idx').on(t.expiresAt)],
)

/**
 * WebAuthn credentials.
 *
 * `publicKey` is the COSE key in base64url, exactly as WebAuthn encodes it. The counter
 * is the authenticator's signature counter: a value that goes backwards means a cloned
 * authenticator and must be rejected.
 */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** base64url credential id, the value the browser sends back. */
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    /** JSON array of authenticator transport hints, e.g. ["internal","hybrid"]. */
    transports: text('transports'),
    /** Human label set at enrolment, so a lost phone is identifiable. */
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [
    uniqueIndex('passkeys_credential_idx').on(t.credentialId),
    index('passkeys_user_idx').on(t.userId),
  ],
)

/**
 * Login attempt counters, keyed by client IP.
 *
 * Separate from rate_limit_buckets, which is scoped to a policy and a wallet: this one
 * guards the console, where the wallet is often not yet known.
 */
export const authAttempts = sqliteTable(
  'auth_attempts',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: integer('window_start').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('auth_attempts_window_idx').on(t.windowStart)],
)

export const sessions = sqliteTable(
  'auth_sessions',
  {
    // sha256 of the cookie value; the raw token is never stored
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
)

// ---------------------------------------------------------------------------
// Provider side: services and access policies
// ---------------------------------------------------------------------------

export const services = sqliteTable(
  'services',
  {
    id: text('id').primaryKey(),
    /** URL segment: /v1/:slug */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** SEP-41 contract id of the asset charged, e.g. USDC SAC on testnet */
    assetCode: text('asset_code').notNull(),
    assetContract: text('asset_contract').notNull(),
    decimals: integer('decimals').notNull().default(7),
    /** Price per request in base units, as a string */
    priceBase: text('price_base').notNull(),
    /** 'charge' = one on-chain payment per request. 'channel' = MPP session. */
    mode: text('mode', { enum: ['charge', 'channel'] })
      .notNull()
      .default('charge'),
    /** Which upstream adapter serves this service: 'search' | 'market' | 'summarize' */
    upstreamKind: text('upstream_kind').notNull(),
    /** Adapter-specific config (endpoint overrides, model, symbols) */
    upstreamConfig: text('upstream_config', { mode: 'json' }).notNull().default('{}'),
    policyId: text('policy_id'),
    status: text('status', { enum: ['live', 'paused', 'draft'] })
      .notNull()
      .default('draft'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('services_slug_idx').on(t.slug),
    index('services_status_idx').on(t.status),
  ],
)

export const policies = sqliteTable(
  'policies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Decision for a wallet on neither list. */
    unknownAction: text('unknown_action', { enum: ['allow', 'review', 'block'] })
      .notNull()
      .default('review'),
    /** Per-request ceiling; exceeding it yields REVIEW. */
    maxAmountPerRequestBase: text('max_amount_per_request_base'),
    /** Rolling 24h ceiling per wallet; exceeding it yields REVIEW. */
    dailyCapPerWalletBase: text('daily_cap_per_wallet_base'),
    /**
     * Ceiling for a wallet with no active grant. Keeps the blast radius of a
     * post-verification deny small, because in charge mode settlement happens
     * inside mppx verify() before we hold an authoritative payer.
     */
    ungrantedSpendCapBase: text('ungranted_spend_cap_base'),
    rateLimitPerMin: integer('rate_limit_per_min'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
)

export const policyAllowlist = sqliteTable(
  'policy_allowlist',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    wallet: text('wallet').notNull(),
    label: text('label').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('policy_allowlist_unique').on(t.policyId, t.wallet)],
)

export const policyDenylist = sqliteTable(
  'policy_denylist',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    wallet: text('wallet').notNull(),
    label: text('label').notNull().default(''),
    reason: text('reason').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('policy_denylist_unique').on(t.policyId, t.wallet)],
)

/**
 * A grant is scoped to ONE service and expires. Approving a review creates a
 * grant; it never mutates the allowlist. Allowlist = standing relationship,
 * grant = temporary authorisation.
 */
export const policyGrants = sqliteTable(
  'policy_grants',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    serviceId: text('service_id').references(() => services.id, { onDelete: 'cascade' }),
    wallet: text('wallet').notNull(),
    grantedFromReviewId: text('granted_from_review_id'),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('policy_grants_lookup_idx').on(t.policyId, t.wallet, t.serviceId),
    index('policy_grants_expiry_idx').on(t.expiresAt),
  ],
)

export const policyAssets = sqliteTable(
  'policy_assets',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    assetContract: text('asset_contract').notNull(),
  },
  (t) => [uniqueIndex('policy_assets_unique').on(t.policyId, t.assetContract)],
)

export const policyNetworks = sqliteTable(
  'policy_networks',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    network: text('network').notNull(),
  },
  (t) => [uniqueIndex('policy_networks_unique').on(t.policyId, t.network)],
)

export const policyServiceLinks = sqliteTable(
  'policy_service_links',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('policy_service_links_unique').on(t.policyId, t.serviceId)],
)

/**
 * REVIEW means the request is HELD: no challenge issued, no payment taken, no
 * service executed. Resolving it creates a time-boxed policy_grants row.
 */
export const reviewDecisions = sqliteTable(
  'review_decisions',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    serviceId: text('service_id').references(() => services.id, { onDelete: 'set null' }),
    wallet: text('wallet').notNull(),
    /** Which check asked for review, e.g. 'unknown_wallet' | 'daily_cap' */
    reason: text('reason').notNull(),
    /** Stored so the decision trace can be re-rendered after resolution. */
    policyTrace: text('policy_trace', { mode: 'json' }).notNull(),
    amountBase: text('amount_base').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    /** Pending reviews stop being actionable after this. */
    expiresAt: integer('expires_at').notNull(),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: integer('resolved_at'),
    note: text('note').notNull().default(''),
    /** How many times a held request was retried against this decision. */
    replays: integer('replays').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('review_decisions_status_idx').on(t.status),
    index('review_decisions_wallet_idx').on(t.policyId, t.wallet, t.serviceId),
  ],
)

// ---------------------------------------------------------------------------
// Payer side: MPP sessions (one-way payment channels)
// ---------------------------------------------------------------------------

export const paymentSessions = sqliteTable(
  'payment_sessions',
  {
    id: text('id').primaryKey(),
    /** Human-facing sequence number, e.g. '1842'. */
    ref: text('ref').notNull(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    /** Deployed channel contract address (C...). */
    channelContract: text('channel_contract').notNull(),
    /** Funder = the machine paying. Read back from chain, never from a header. */
    funder: text('funder').notNull(),
    /** Provider wallet that receives the settlement. */
    recipient: text('recipient').notNull(),
    assetContract: text('asset_contract').notNull(),
    decimals: integer('decimals').notNull().default(7),
    /** G... encoding of the commitment public key baked into the channel. */
    commitmentPublicKey: text('commitment_public_key').notNull(),
    /** Latest authorised cumulative commitment, base units. */
    cumulativeBase: text('cumulative_base').notNull().default('0'),
    /** Highest cumulative ever committed, used for monotonicity display. */
    requestCount: integer('request_count').notNull().default(0),
    /** Escrowed in the channel at open time. */
    fundedBase: text('funded_base').notNull(),
    status: text('status', {
      enum: ['opening', 'active', 'settling', 'settled', 'closed', 'failed'],
    })
      .notNull()
      .default('opening'),
    /** Set when the channel emits close/close_start, for dispute display. */
    closeEffectiveAtLedger: integer('close_effective_at_ledger'),
    settlementId: text('settlement_id'),
    openedAt: integer('opened_at').notNull(),
    closedAt: integer('closed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('payment_sessions_channel_idx').on(t.channelContract),
    uniqueIndex('payment_sessions_ref_idx').on(t.ref),
    index('payment_sessions_status_idx').on(t.status),
    index('payment_sessions_service_idx').on(t.serviceId),
  ],
)

export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => paymentSessions.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'created',
        'policy_approved',
        'channel_funded',
        'request',
        'blocked',
        'close_requested',
        'settled',
        'failed',
      ],
    }).notNull(),
    detail: text('detail').notNull().default(''),
    amountBase: text('amount_base'),
    /** Set for 'request' rows so the timeline can link to the metering record. */
    requestId: text('request_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('session_events_session_idx').on(t.sessionId, t.createdAt)],
)

// ---------------------------------------------------------------------------
// Gateway records
// ---------------------------------------------------------------------------

/**
 * One row per gateway call. This is the source of truth for every dashboard number.
 *
 * `status` records where the request died:
 *   challenged          -> 402 issued, no payment, awaiting credential
 *   paid                -> payment verified AND service delivered
 *   blocked             -> refused in preflight: no payment, no service
 *   review_pending      -> held for a human: no payment, no service
 *   rejected_mismatch   -> declared payer != verified payer; no upstream call
 *   charged_not_delivered -> post-verification policy deny; payment already settled
 *   failed              -> upstream or settlement error
 */
export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    policyId: text('policy_id').references(() => policies.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => paymentSessions.id, { onDelete: 'set null' }),
    reviewId: text('review_id').references(() => reviewDecisions.id, { onDelete: 'set null' }),
    /** Untrusted pre-verification identity. Null if the caller declared nothing. */
    claimedPayer: text('claimed_payer'),
    /** Cryptographically verified payer. Null until (and unless) payment verifies. */
    verifiedPayer: text('verified_payer'),
    mode: text('mode', { enum: ['charge', 'channel'] }).notNull(),
    amountBase: text('amount_base').notNull(),
    status: text('status', {
      enum: [
        'challenged',
        'paid',
        'blocked',
        'review_pending',
        'rejected_mismatch',
        'charged_not_delivered',
        'failed',
      ],
    }).notNull(),
    policyDecision: text('policy_decision', { enum: ['allow', 'review', 'block', 'none'] }).notNull(),
    /** Ordered per-check trace, rendered verbatim by the Policy Evaluation screen. */
    policyTrace: text('policy_trace', { mode: 'json' }).notNull(),
    /** MPP receipt reference. For charge mode this is the settled tx hash. */
    receiptReference: text('receipt_reference'),
    /** Set only when a payment actually settled on chain. */
    paymentTxHash: text('payment_tx_hash'),
    settlementId: text('settlement_id'),
    /** Which real upstream provider served this call. */
    upstreamProvider: text('upstream_provider'),
    upstreamStatus: integer('upstream_status'),
    latencyMs: integer('latency_ms'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('requests_service_idx').on(t.serviceId, t.createdAt),
    index('requests_status_idx').on(t.status, t.createdAt),
    index('requests_session_idx').on(t.sessionId),
    index('requests_payment_tx_idx').on(t.paymentTxHash),
  ],
)

/**
 * A real on-chain movement. One row per confirmed Stellar transaction that paid
 * PageSure: either a single charge or a session settlement.
 */
export const settlements = sqliteTable(
  'settlements',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['charge', 'session'] }).notNull(),
    requestId: text('request_id').references(() => requests.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => paymentSessions.id, { onDelete: 'set null' }),
    /** How many service calls this settlement covered. The whole point of sessions. */
    requestCount: integer('request_count').notNull().default(1),
    amountBase: text('amount_base').notNull(),
    assetContract: text('asset_contract').notNull(),
    assetCode: text('asset_code').notNull(),
    decimals: integer('decimals').notNull().default(7),
    payer: text('payer').notNull(),
    recipient: text('recipient').notNull(),
    network: text('network').notNull(),
    txHash: text('tx_hash').notNull(),
    status: text('status', { enum: ['pending', 'confirmed', 'failed'] })
      .notNull()
      .default('pending'),
    ledger: integer('ledger'),
    /** Stellar Explorer deep link, derived not stored. */
    explorerUrl: text('explorer_url'),
    createdAt: integer('created_at').notNull(),
    confirmedAt: integer('confirmed_at'),
  },
  (t) => [
    uniqueIndex('settlements_tx_idx').on(t.txHash),
    index('settlements_status_idx').on(t.status, t.createdAt),
  ],
)

/**
 * Money taken, service not delivered. The honest cost of charge mode: mppx settles
 * inside verify(), so a post-verification policy deny happens after the transfer.
 * Surfaced rather than hidden. Never auto-refunded, never auto-granted.
 */
export const incidents = sqliteTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['charged_not_delivered', 'settlement_failed', 'upstream_failed', 'channel_dispute'],
    }).notNull(),
    requestId: text('request_id').references(() => requests.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => paymentSessions.id, { onDelete: 'set null' }),
    serviceId: text('service_id').references(() => services.id, { onDelete: 'set null' }),
    payer: text('payer').notNull(),
    amountBase: text('amount_base').notNull(),
    assetCode: text('asset_code').notNull().default(''),
    decimals: integer('decimals').notNull().default(7),
    reason: text('reason').notNull(),
    policyTrace: text('policy_trace', { mode: 'json' }),
    paymentTxHash: text('payment_tx_hash'),
    acknowledgedAt: integer('acknowledged_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('incidents_open_idx').on(t.acknowledgedAt, t.createdAt)],
)

/** Append-only feed powering the Live Activity panel. */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    type: text('type', {
      enum: [
        'request_paid',
        'session_opened',
        'session_settled',
        'payment_blocked',
        'review_pending',
        'review_resolved',
        'service_created',
        'incident',
      ],
    }).notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    message: text('message').notNull(),
    serviceId: text('service_id').references(() => services.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => paymentSessions.id, { onDelete: 'set null' }),
    requestId: text('request_id').references(() => requests.id, { onDelete: 'set null' }),
    /** Amounts are stored base-unit strings so the UI can format with asset decimals. */
    amountBase: text('amount_base'),
    assetCode: text('asset_code'),
    decimals: integer('decimals'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('activity_events_created_idx').on(t.createdAt)],
)

/** Fixed-window counters used by the policy engine's rate limiter. */
export const rateLimitBuckets = sqliteTable(
  'rate_limit_buckets',
  {
    /** policyId:wallet:windowStart — the compare-and-set key. */
    key: text('key').primaryKey(),
    policyId: text('policy_id').notNull(),
    wallet: text('wallet').notNull(),
    windowStart: integer('window_start').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('rate_limit_buckets_window_idx').on(t.windowStart)],
)

export const schemaVersion = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const now = sql`(unixepoch() * 1000)`