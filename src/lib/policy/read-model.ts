import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  policies,
  policyAllowlist,
  policyAssets,
  policyDenylist,
  policyGrants,
  policyNetworks,
  policyServiceLinks,
  services,
} from '@/lib/db/schema'

/**
 * Policy read model for the dashboard.
 *
 * `Date.now()` lives here rather than in a page component: React forbids impure calls
 * during render, and "now" belongs to the query, not the view.
 */

export interface PolicyUsage {
  allowlist: Array<{ id: string; wallet: string; label: string }>
  denylist: Array<{ id: string; wallet: string; label: string; reason: string }>
  assets: Array<{ id: string; assetContract: string }>
  networks: Array<{ id: string; network: string }>
  services: Array<{ id: string; name: string; slug: string }>
  activeGrants: number
}

export interface PolicyWithUsage {
  policy: typeof policies.$inferSelect
  usage: PolicyUsage
}

export function policiesWithUsage(): PolicyWithUsage[] {
  const target = db()
  const now = Date.now()

  return target
    .select()
    .from(policies)
    .orderBy(desc(policies.createdAt))
    .all()
    .map((policy) => ({
      policy,
      usage: {
        allowlist: target
          .select()
          .from(policyAllowlist)
          .where(eq(policyAllowlist.policyId, policy.id))
          .all(),
        denylist: target
          .select()
          .from(policyDenylist)
          .where(eq(policyDenylist.policyId, policy.id))
          .all(),
        assets: target
          .select()
          .from(policyAssets)
          .where(eq(policyAssets.policyId, policy.id))
          .all(),
        networks: target
          .select()
          .from(policyNetworks)
          .where(eq(policyNetworks.policyId, policy.id))
          .all(),
        services: target
          .select({ id: services.id, name: services.name, slug: services.slug })
          .from(policyServiceLinks)
          .innerJoin(services, eq(policyServiceLinks.serviceId, services.id))
          .where(eq(policyServiceLinks.policyId, policy.id))
          .all(),
        activeGrants:
          target
            .select({ n: sql<number>`count(*)` })
            .from(policyGrants)
            .where(
              and(
                eq(policyGrants.policyId, policy.id),
                isNull(policyGrants.revokedAt),
                gt(policyGrants.expiresAt, now),
              ),
            )
            .get()?.n ?? 0,
      },
    }))
}