import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  policies,
  policyAllowlist,
  policyAssets,
  policyDenylist,
  policyGrants,
  policyNetworks,
  policyServiceLinks,
  rateLimitBuckets,
} from '@/lib/db/schema'
import { exceeds, toBig } from '@/lib/money'
import {
  CHECK_LABELS,
  CHECK_ORDER,
  type CheckKey,
  type Decision,
  type PolicyCheck,
  type PolicyContext,
  type PolicySnapshot,
  type PolicyTrace,
} from './types'

/**
 * Two-phase evaluation.
 *
 * `preflight` is the ENFORCEMENT POINT. It runs before any payment exists, so a
 * block or review here means: no challenge issued, no payment taken, no upstream
 * call. It operates on a claimed identity which is UNTRUSTED, so it is allowed to
 * deny freely and never allowed to grant anything the authoritative pass would deny.
 *
 * `authoritative` runs after mppx has cryptographically verified the credential and
 * therefore after settlement in charge mode. It runs against the verified payer and
 * may only return ALLOW or BLOCK. A BLOCK here is recorded as a
 * `charged_not_delivered` incident rather than silently ignored.
 */

class TraceBuilder {
  readonly phase: PolicyTrace['phase']
  readonly subject: string
  readonly startedAt = Date.now()
  private readonly checks: PolicyCheck[]
  private decision: Decision = 'none'
  private reason: string | undefined

  constructor(phase: PolicyTrace['phase'], subject: string) {
    this.phase = phase
    this.subject = subject
    this.checks = CHECK_ORDER.map((key) => ({
      key,
      label: CHECK_LABELS[key],
      status: 'skip',
      detail: '',
    }))
  }

  record(key: CheckKey, status: PolicyCheck['status'], detail = ''): void {
    const row = this.checks.find((c) => c.key === key)
    if (row) {
      row.status = status
      row.detail = detail
    }
  }

  /**
   * BLOCK is terminal and outranks anything already recorded. REVIEW only wins if
   * nothing more severe has been decided. ALLOW never overwrites a pending
   * review or block.
   */
  decide(decision: Decision, reason: string): void {
    const rank: Record<Decision, number> = { none: 0, allow: 1, review: 2, block: 3 }
    if (rank[decision] <= rank[this.decision]) return
    this.decision = decision
    this.reason = reason
  }

  block(key: CheckKey, reason: string): void {
    this.record(key, 'fail', reason)
    this.decision = 'block'
    this.reason = reason
  }

  review(key: CheckKey, reason: string): void {
    this.record(key, 'fail', reason)
    if (this.decision === 'none') {
      this.decision = 'review'
      this.reason = reason
    }
  }

  pass(key: CheckKey, detail = ''): void {
    this.record(key, 'pass', detail)
  }

  build(): PolicyTrace {
    return {
      phase: this.phase,
      decision: this.decision,
      checks: this.checks,
      reason: this.reason,
      subject: this.subject,
      evaluatedAt: Date.now(),
      durationMs: Date.now() - this.startedAt,
    }
  }
}

export function loadPolicySnapshot(policyId: string, serviceId: string): PolicySnapshot | null {
  const target = db()
  const policy = target.select().from(policies).where(eq(policies.id, policyId)).get()
  if (!policy) return null

  const allowedNetworks = new Set(
    target.select({ n: policyNetworks.network }).from(policyNetworks).where(eq(policyNetworks.policyId, policyId)).all().map((r) => r.n),
  )
  const allowedAssets = new Set(
    target.select({ a: policyAssets.assetContract }).from(policyAssets).where(eq(policyAssets.assetContract, policyAssets.assetContract)).all().map((r) => r.a),
  )
  const allowlist = new Set(
    target.select({ w: policyAllowlist.wallet }).from(policyAllowlist).where(eq(policyAllowlist.policyId, policyId)).all().map((r) => r.w),
  )
  const denylist = new Map(
    target.select({ w: policyDenylist.wallet, r: policyDenylist.reason }).from(policyDenylist).where(eq(policyDenylist.policyId, policyId)).all().map((r) => [r.w, r.r] as const),
  )
  const linkedServiceIds = new Set(
    target.select({ s: policyServiceLinks.serviceId }).from(policyServiceLinks).where(eq(policyServiceLinks.policyId, policyId)).all().map((r) => r.s),
  )

  // Grants are scoped to a service, or to the whole policy when serviceId is null.
  // Expired and revoked grants are excluded.
  const nowMs = Date.now()
  const grantRows = target
    .select({ wallet: policyGrants.wallet, expiresAt: policyGrants.expiresAt })
    .from(policyGrants)
    .where(
      and(
        eq(policyGrants.policyId, policyId),
        isNull(policyGrants.revokedAt),
        sql`${policyGrants.expiresAt} > ${nowMs}`,
        or(isNull(policyGrants.serviceId), eq(policyGrants.serviceId, serviceId)),
      ),
    )
    .all()
  const grants = new Map<string, number>()
  for (const row of grantRows) {
    const current = grants.get(row.wallet)
    if (current === undefined || row.expiresAt > current) grants.set(row.wallet, row.expiresAt)
  }

  return {
    id: policy.id,
    name: policy.name,
    unknownAction: policy.unknownAction,
    maxAmountPerRequestBase: policy.maxAmountPerRequestBase,
    dailyCapPerWalletBase: policy.dailyCapPerWalletBase,
    ungrantedSpendCapBase: policy.ungrantedSpendCapBase,
    rateLimitPerMin: policy.rateLimitPerMin,
    active: policy.active,
    allowedNetworks,
    allowedAssets,
    allowlist,
    denylist,
    grants,
    linkedServiceIds,
  }
}

interface EvaluateOptions {
  /**
   * Preflight counts against the rate limiter. The authoritative pass must NOT count,
   * or a single request would consume the budget twice.
   */
  countRateLimit: boolean
}

export function evaluate(
  snapshot: PolicySnapshot | null,
  ctx: PolicyContext,
  phase: PolicyTrace['phase'],
  options: EvaluateOptions,
): PolicyTrace {
  const t = new TraceBuilder(phase, ctx.payer)

  // 1. service_active
  if (ctx.serviceStatus !== 'live') {
    t.record('service_active', 'fail', `service is ${ctx.serviceStatus}`)
    t.decide('block', `service is ${ctx.serviceStatus}`)
    return t.build()
  }
  t.pass('service_active', 'live')
  if (!snapshot) {
    t.record('policy_bound', 'fail', 'no policy attached to this service')
    t.decide('block', 'no policy attached to this service')
    return t.build()
  }

  // 2. policy_bound
  if (ctx.servicePolicyId !== snapshot.id) {
    t.block('policy_bound', 'service is not bound to this policy')
    return t.build()
  }
  if (!snapshot.active) {
    t.block('policy_bound', 'policy is disabled')
    return t.build()
  }
  t.pass('policy_bound', snapshot.name)

  // 3. network_allowed
  if (!snapshot.allowedNetworks.has(ctx.network)) {
    t.block('network_allowed', `${ctx.network} is not in the policy's allowed networks`)
    return t.build()
  }
  t.pass('network_allowed', ctx.network)

  // 4. asset_allowed
  if (!snapshot.allowedAssets.has(ctx.assetContract)) {
    t.block('asset_allowed', `${ctx.assetContract} is not an allowed asset`)
    return t.build()
  }
  t.pass('asset_allowed', ctx.assetContract)

  // 5. denylist — terminal, checked before any permissive branch
  const denial = snapshot.denylist.get(ctx.payer)
  if (denial !== undefined) {
    t.block('denylist', denial ? `denylist match: ${denial}` : 'wallet is on the provider denylist')
    return t.build()
  }
  t.pass('denylist', 'not listed')

  // 6. grant — a live, unexpired, service-scoped grant authorises this wallet
  const grantExpiry = snapshot.grants.get(ctx.payer)
  const hasGrant = grantExpiry !== undefined
  if (hasGrant) {
    t.pass('grant', `granted until ${new Date(grantExpiry).toISOString()}`)
  } else {
    t.record('grant', 'skip', 'no active grant')
  }

  // 7. allowlist — standing relationship
  const allowlisted = snapshot.allowlist.has(ctx.payer)
  if (allowlisted) t.pass('allowlist', 'on allowlist')
  else t.record('allowlist', 'skip', 'not on allowlist')

  // 8. unknown_wallet — skipped when a grant or allowlist entry already authorised it
  if (hasGrant || allowlisted) {
    t.record('unknown_wallet', 'skip', 'authorised by grant or allowlist')
  } else if (snapshot.unknownAction === 'block') {
    t.block('unknown_wallet', 'wallet is unknown and the policy blocks unknown wallets')
    return t.build()
  } else if (snapshot.unknownAction === 'review') {
    t.review('unknown_wallet', 'wallet is not known to this provider; held for review')
  } else {
    t.pass('unknown_wallet', 'unknown wallets are allowed')
  }

  // Caps still apply even to allowlisted and granted wallets.
  // 9. amount_cap
  if (exceeds(ctx.amountBase, snapshot.maxAmountPerRequestBase)) {
    t.review('amount_cap', `request amount exceeds the per-request cap of ${snapshot.maxAmountPerRequestBase ?? ''}`)
  } else {
    t.pass('amount_cap', `within ${snapshot.maxAmountPerRequestBase ?? 'no cap'}`)
  }

  // 10. ungranted_cap
  // Keeps a post-verification deny cheap: a wallet with no grant cannot authorise
  // an amount large enough to matter before we hold an authoritative identity.
  if (!hasGrant && !allowlisted && snapshot.ungrantedSpendCapBase) {
    if (toBig(ctx.amountBase) > toBig(snapshot.ungrantedSpendCapBase)) {
      t.review(
        'ungranted_cap',
        `ungranted wallets may spend at most ${snapshot.ungrantedSpendCapBase} base units per request`,
      )
    } else {
      t.pass('ungranted_cap', 'within ungranted cap')
    }
  } else {
    t.record('ungranted_cap', 'skip', hasGrant || allowlisted ? 'granted or allowlisted' : 'no cap configured')
  }

  // 11. daily_cap
  if (snapshot.dailyCapPerWalletBase) {
    const projected = toBig(ctx.payerSpend24hBase) + toBig(ctx.amountBase)
    if (projected > toBig(snapshot.dailyCapPerWalletBase)) {
      t.review('daily_cap', 'wallet would exceed its rolling 24h cap')
    } else {
      t.pass('daily_cap', 'within 24h cap')
    }
  } else {
    t.record('daily_cap', 'skip', 'no cap configured')
  }

  // 12. rate_limit
  if (snapshot.rateLimitPerMin && options.countRateLimit) {
    const ok = consumeRateLimit(snapshot.id, ctx.payer, snapshot.rateLimitPerMin)
    if (ok) t.pass('rate_limit', `within ${snapshot.rateLimitPerMin}/min`)
    else {
      t.block('rate_limit', `exceeded ${snapshot.rateLimitPerMin} requests per minute`)
      return t.build()
    }
  } else if (snapshot.rateLimitPerMin) {
    t.record('rate_limit', 'skip', 'already counted during preflight')
  } else {
    t.record('rate_limit', 'skip', 'no limit configured')
  }

  if (t.build().decision === 'none') t.decide('allow', 'all checks passed')
  return t.build()
}

/**
 * Fixed-window counter with a conditional UPDATE, so concurrent requests cannot
 * both read the same count and both write count+1.
 */
export function consumeRateLimit(policyId: string, wallet: string, limitPerMin: number): boolean {
  const target = db()
  const windowMs = 60_000
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  const key = `${policyId}:${wallet}:${windowStart}`

  // Try to claim a slot in the current window.
  const inserted = target
    .insert(rateLimitBuckets)
    .values({ key, policyId, wallet, windowStart, count: 1, updatedAt: Date.now() })
    .onConflictDoNothing()
    .run()

  if (inserted.changes > 0) return true

  // Window exists: increment only while still under the limit.
  const bumped = target
    .update(rateLimitBuckets)
    .set({ count: sql`${rateLimitBuckets.count} + 1`, updatedAt: Date.now() })
    .where(and(eq(rateLimitBuckets.key, key), lt(rateLimitBuckets.count, limitPerMin)))
    .run()

  if (bumped.changes > 0) return true

  // At or over the limit. Report over-limit, but do not keep growing the counter.
  target
    .update(rateLimitBuckets)
    .set({ count: sql`${rateLimitBuckets.count} + 1`, updatedAt: Date.now() })
    .where(eq(rateLimitBuckets.key, key))
    .run()
  return false
}

export type { PolicyContext, PolicySnapshot, PolicyTrace, Decision }