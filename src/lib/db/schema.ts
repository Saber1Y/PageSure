import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * All monetary amounts are stored as base-unit STRINGS (e.g. '100000' = 0.01 USDC at
 * 7 decimals), matching what MPP puts on the wire. Never store money as a float.
 *
 * All timestamps are integer unix milliseconds (UTC).
 */

/**
 * A tenant. One company that runs services through PageSure.
 *
 * This is the root of every ownership question in the database. `requireUser()` returns an
 * organizationId and every provider-owned query filters on it, so an operator can only ever
 * reach rows their organization owns.
 *
 * `settlementRecipient` is the organization's treasury: the Stellar account that receives
 * payment for that organization's services. It is NOT an authentication credential and is
 * unrelated to any operator's login wallet — an organization may settle to an account no one
 * on the team can sign for. PageSure never stores a secret for it; the chain does the paying.
 */
export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /**
     * Treasury that receives this organization's settlements. Every service inherits it;
     * a per-service override is a deliberate future extension, not an implicit fallback.
     *
     * Nullable on purpose. A company can finish signup with nothing but a work email, and
     * connecting a wallet is a later, separate step. Forcing the wallet first is what makes
     * a payments product unusable for anyone who has not installed an extension yet. The
     * cost of null is that the organization cannot take money until a treasury is set, which
     * is exactly the constraint that should apply: an organization with no settlement
     * account has nowhere to be paid.
     */
    settlementRecipient: text('settlement_recipient'),
    /**
     * Channel commitment key for this organization, as the M... (med25519) encoding.
     *
     * Separate from settlementRecipient on purpose, because they answer different questions.
     * `settlementRecipient` is a Stellar *account*: it receives SAC payouts and authorises
     * `settle`/`close` through `require_auth`. This key is the *off-chain* half: it signs the
     * cumulative-amount commitments the contract verifies with `ed25519_verify`, and its
     * private half must never leave the operator's control.
     *
     * Nullable because an organization that only runs charge-mode services never opens a
     * channel and so needs no commitment key. A channel attempt against an organization
     * without one is refused rather than silently falling back to a shared provider key:
     * a fallback would let any organization settle into another's channel.
     */
    commitmentPublicKey: text('commitment_public_key'),
    /**
     * HTTPS endpoint of this organization's channel signer service.
     *
     * PageSure holds no channel private key. A withdrawal needs a signature from the
     * organization's commitment key, so the organization runs a signer and PageSure asks it to
     * sign commitment bytes the organization does not get to choose. Nullable because a
     * charge-mode organization never needs one.
     */
    commitmentSignerUrl: text('commitment_signer_url'),
    /**
     * Name of the environment variable holding the bearer token for that signer, NOT the
     * token itself.
     *
     * Storing the credential here would put it in the database, in every dump of it, and in
     * every backup, and a leaked token lets an attacker request signatures. Holding only the
     * variable name keeps the secret in the operator's environment, where it belongs, while
     * still letting each organization have its own token.
     */
    commitmentSignerTokenEnv: text('commitment_signer_token_env'),
    /**
     * True once an operator proved control of `settlementRecipient` by signing a challenge.
     *
     * Separate from the presence of the address because the two mean different things. A
     * pasted address is a claim; a verified one is a proven fact, and the difference decides
     * whether the organization may receive real settlements.
     */
    treasuryVerified: integer('treasury_verified', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('organizations_recipient_idx').on(t.settlementRecipient)],
)

/**
 * Who belongs to which organization, and what they may do there.
 *
 * Membership is what authorization is actually built on. The signing wallet proves who
 * someone is; it does not decide what they are allowed to touch. An organization with a CEO,
 * an operations lead and a developer should not hand all three the same authority over the
 * settlement wallet, so the role lives on the edge between a user and an organization
 * rather than on the user.
 */
export const organizationMembers = sqliteTable(
  'organization_members',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * owner    full control, including the settlement wallet and membership itself
     * operator services, policies and review, but not the treasury
     * analyst  read-only
     */
    role: text('role', { enum: ['owner', 'operator', 'analyst'] }).notNull().default('operator'),
    /** Null for the owner created at signup; set when an owner invites someone. */
    invitedBy: text('invited_by').references(() => users.id),
    /** Null while an invitation is outstanding, set once the invitee accepts. */
    acceptedAt: integer('accepted_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('organization_members_unique_idx').on(t.organizationId, t.userId),
    index('organization_members_user_idx').on(t.userId),
  ],
)

/**
 * Single-use email sign-in and verification tokens.
 *
 * The stored value is a SHA-256 hash, not the token. A magic link is a bearer credential
 * delivered over email, so anyone who can read the database must not be able to log in with
 * it; hashing means a dump yields nothing usable. The row is deleted or marked consumed on
 * first use so a link that lands in a shared inbox cannot be replayed.
 */
export const emailTokens = sqliteTable(
  'email_tokens',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** signin proves an address; invite binds the address to an organization and role. */
    purpose: text('purpose', { enum: ['signin', 'invite'] }).notNull(),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    role: text('role', { enum: ['operator', 'analyst'] }),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('email_tokens_email_idx').on(t.email),
    uniqueIndex('email_tokens_token_idx').on(t.tokenHash),
    index('email_tokens_expiry_idx').on(t.expiresAt),
  ],
)

/**
 * Provider operators.
 *
 * There is no password column and no seeded row. An account is created the first time
 * someone proves control of a wallet they own, so the credential lives in that wallet
 * rather than in a .env file that ships with the repo.
 *
 * `walletPublicKey` is the ROOT of trust, but it is SELF-CERTIFYING: the signature proves
 * control of whatever key the client names. That is authentication only. Authorization is
 * `user -> organization -> role`, enforced by requireUser(); possession of a valid signature
 * never implies access to an organization's data.
 *
 * A passkey is a second, revocable way in, and is only ever created from an
 * already-authenticated session, so a passkey can never bootstrap an account.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Display/contact only. Nullable because wallet sign-in has no email to collect, and
     * nothing authenticates against it.
     */
    email: text('email'),
    /** Stellar ed25519 public key that signed the enrolment challenge. Unique. */
    walletPublicKey: text('wallet_public_key'),
    displayName: text('display_name').notNull(),
    /**
     * Denormalized copy of the active membership role, kept only so legacy queries and the
     * account chip have something to read.
     *
     * `organization_members.role` is the authority. This column is written alongside it and
     * never consulted for an authorization decision, so the two cannot drift into a state
     * where the copy grants something the membership does not.
     */
    role: text('role', { enum: ['owner', 'operator', 'analyst'] })
      .notNull()
      .default('owner'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('users_email_idx').on(t.email),
    uniqueIndex('users_wallet_idx').on(t.walletPublicKey),
    index('users_organization_idx').on(t.organizationId),
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
    /**
     * `enrol` proves a wallet at signup, `login` proves it again at sign-in, and `treasury`
     * proves an account may receive an organization's money.
     *
     * Treasury is separate rather than a flavour of `enrol` because it authorizes money, not
     * access. A challenge for one must never be redeemable as the other, and the distinction
     * has to be visible in the row rather than inferred from its contents.
     */
    purpose: text('purpose', { enum: ['enrol', 'login', 'treasury'] }).notNull(),
    /** Wallet the challenge was issued to; null before the client states which one. */
    walletPublicKey: text('wallet_public_key'),
    /** Organization the challenge authorizes a change to; null for enrol and login. */
    organizationId: text('organization_id'),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * URL segment: /v1/:slug
     *
     * Globally unique, deliberately. The public gateway path carries no organization
     * context, so the slug is what resolves a request to an owner; the organization is then
     * read off this row. Two organizations therefore cannot claim the same slug.
     */
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
    index('services_organization_idx').on(t.organizationId),
  ],
)

export const policies = sqliteTable(
  'policies',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
  (t) => [index('policies_organization_idx').on(t.organizationId)],
)

export const policyAllowlist = sqliteTable(
  'policy_allowlist',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    index('review_decisions_organization_idx').on(t.organizationId, t.status),
  ],
)

// ---------------------------------------------------------------------------
// Payer side: MPP sessions (one-way payment channels)
// ---------------------------------------------------------------------------

export const paymentSessions = sqliteTable(
  'payment_sessions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    index('payment_sessions_organization_idx').on(t.organizationId, t.createdAt),
  ],
)

export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    index('requests_organization_idx').on(t.organizationId, t.createdAt),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    index('settlements_organization_idx').on(t.organizationId, t.createdAt),
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
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
  (t) => [
    index('incidents_open_idx').on(t.acknowledgedAt, t.createdAt),
    index('incidents_organization_idx').on(t.organizationId, t.createdAt),
  ],
)

/** Append-only feed powering the Live Activity panel. */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
  (t) => [
    index('activity_events_created_idx').on(t.createdAt),
    index('activity_events_organization_idx').on(t.organizationId, t.createdAt),
  ],
)

/** Fixed-window counters used by the policy engine's rate limiter. */
export const rateLimitBuckets = sqliteTable(
  'rate_limit_buckets',
  {
    /** policyId:wallet:windowStart — the compare-and-set key. */
    key: text('key').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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