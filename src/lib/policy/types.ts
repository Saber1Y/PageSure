/**
 * Policy engine types.
 *
 * A `PolicyTrace` is an ordered list of per-check rows. It is stored on the request
 * row and rendered verbatim by the Policy Evaluation screen, so the UI never
 * reconstructs a decision. Anything that changes the engine must change this shape.
 */

export type Decision = 'allow' | 'review' | 'block' | 'none'

export type CheckStatus = 'pass' | 'fail' | 'skip' | 'pending'

export interface PolicyCheck {
  /** Stable machine key, e.g. 'denylist'. */
  key: string
  /** Human label shown in the dashboard. */
  label: string
  status: CheckStatus
  /** One-line explanation, e.g. the denial reason. */
  detail: string
}

export interface PolicyTrace {
  /** 'preflight' runs before any payment exists and is the enforcement point. */
  phase: 'preflight' | 'authoritative'
  decision: Decision
  checks: PolicyCheck[]
  /** Set when decision is block or review. */
  reason?: string
  /** Wallet the decision was made about. */
  subject: string
  evaluatedAt: number
  /** Milliseconds the engine took. */
  durationMs: number
}

export type CheckKey =
  | 'service_active'
  | 'policy_bound'
  | 'network_allowed'
  | 'asset_allowed'
  | 'denylist'
  | 'grant'
  | 'allowlist'
  | 'unknown_wallet'
  | 'amount_cap'
  | 'ungranted_cap'
  | 'daily_cap'
  | 'rate_limit'

/** Canonical order. A BLOCK short-circuits; ALLOW at grant/allowlist skips unknown_wallet. */
export const CHECK_ORDER: CheckKey[] = [
  'service_active',
  'policy_bound',
  'network_allowed',
  'asset_allowed',
  'denylist',
  'grant',
  'allowlist',
  'unknown_wallet',
  'amount_cap',
  'ungranted_cap',
  'daily_cap',
  'rate_limit',
]

export const CHECK_LABELS: Record<CheckKey, string> = {
  service_active: 'Service is live',
  policy_bound: 'Service bound to this policy',
  network_allowed: 'Network allowed',
  asset_allowed: 'Asset allowed',
  denylist: 'Wallet denylist',
  grant: 'Active grant',
  allowlist: 'Wallet allowlist',
  unknown_wallet: 'Unknown wallet handling',
  amount_cap: 'Per-request amount cap',
  ungranted_cap: 'Ungranted spend cap',
  daily_cap: 'Daily wallet cap',
  rate_limit: 'Rate limit',
}

/** Inputs the engine needs. Assembled by lib/policy/service.ts from the DB. */
export interface PolicyContext {
  /** Owning organization of the service being called. Taken from the resolved service. */
  organizationId: string
  serviceId: string
  serviceName: string
  serviceStatus: 'live' | 'paused' | 'draft'
  servicePolicyId: string | null
  network: string
  assetContract: string
  amountBase: string
  mode: 'charge' | 'channel'
  payer: string
  /** Rolling 24h spend already settled for this payer, base units. */
  payerSpend24hBase: string
}

export interface PolicySnapshot {
  id: string
  name: string
  unknownAction: 'allow' | 'review' | 'block'
  maxAmountPerRequestBase: string | null
  dailyCapPerWalletBase: string | null
  ungrantedSpendCapBase: string | null
  rateLimitPerMin: number | null
  active: boolean
  allowedNetworks: Set<string>
  allowedAssets: Set<string>
  allowlist: Set<string>
  denylist: Map<string, string>
  /** Wallet -> earliest expiry across grants matching (policy, service). */
  grants: Map<string, number>
  linkedServiceIds: Set<string>
}

export class PolicyDeniedError extends Error {
  readonly decision: Decision
  readonly trace: PolicyTrace
  readonly status: number

  constructor(decision: Decision, trace: PolicyTrace, status: number) {
    super(trace.reason ?? `policy ${decision}`)
    this.name = 'PolicyDeniedError'
    this.decision = decision
    this.trace = trace
    this.status = status
  }
}