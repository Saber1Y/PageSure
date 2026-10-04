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

/**
 * Scoped to one organization. Policy names are NOT globally unique (two organizations may
 * both own a "Standard Access" policy), so every lookup filters on organizationId first and
 * the policy id second — the pair, never the id alone, identifies a policy.
 */
export function policiesWithUsage(organizationId: string): PolicyWithUsage[] {
  const target = db()
  const now = Date.now()

  return target
    .select()
    .from(policies)
    .where(eq(policies.organizationId, organizationId))
    .orderBy(desc(policies.createdAt))
    .all()
    .map((policy) => ({
      policy,
      usage: {
        allowlist: target
          .select()
          .from(policyAllowlist)
          .where(and(eq(policyAllowlist.organizationId, organizationId), eq(policyAllowlist.policyId, policy.id)))
          .all(),
        denylist: target
          .select()
          .from(policyDenylist)
          .where(and(eq(policyDenylist.organizationId, organizationId), eq(policyDenylist.policyId, policy.id)))
          .all(),
        assets: target
          .select()
          .from(policyAssets)
          .where(and(eq(policyAssets.organizationId, organizationId), eq(policyAssets.policyId, policy.id)))
          .all(),
        networks: target
          .select()
          .from(policyNetworks)
          .where(and(eq(policyNetworks.organizationId, organizationId), eq(policyNetworks.policyId, policy.id)))
          .all(),
        services: target
          .select({ id: services.id, name: services.name, slug: services.slug })
          .from(policyServiceLinks)
          .innerJoin(services, eq(policyServiceLinks.serviceId, services.id))
          .where(
            and(
              eq(policyServiceLinks.organizationId, organizationId),
              eq(policyServiceLinks.policyId, policy.id),
            ),
          )
          .all(),
        activeGrants:
          target
            .select({ n: sql<number>`count(*)` })
            .from(policyGrants)
            .where(
              and(
                eq(policyGrants.organizationId, organizationId),
                eq(policyGrants.policyId, policy.id),
                isNull(policyGrants.revokedAt),
                gt(policyGrants.expiresAt, now),
              ),
            )
            .get()?.n ?? 0,
      },
    }))
}