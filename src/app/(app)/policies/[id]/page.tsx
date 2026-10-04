import { and, eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { Card, PageHeader } from '@/components/ui/primitives'
import PolicyEditor from '@/components/dashboard/policy-editor'
import { requireUserPage } from '@/lib/auth/session'
import { roleInOrganization } from '@/lib/auth/identity'
import { capToHuman } from '@/lib/policy/manage'
import { db } from '@/lib/db/client'
import { policies, policyAllowlist, policyDenylist, services } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

/**
 * Edit one access policy.
 *
 * Ownership is enforced in the query rather than by a global lookup followed by a comparison.
 * `loadPolicySnapshot` filters by organization for the engine's reasons; the console needs the same
 * discipline, because "fetch then compare" is one refactor away from disclosing that another
 * tenant's policy exists.
 */
export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserPage()
  const { id } = await params

  // Read the role from the membership row, not the session copy, for the same reason settings does:
  // the denormalized column is a display cache and has already lied about a demotion once.
  const role = roleInOrganization(user.id, user.organizationId)
  const canEdit = role === 'owner' || role === 'operator'

  const policy = db()
    .select()
    .from(policies)
    .where(and(eq(policies.id, id), eq(policies.organizationId, user.organizationId)))
    .get()
  if (!policy) notFound()

  const allowlist = db()
    .select({ wallet: policyAllowlist.wallet, label: policyAllowlist.label })
    .from(policyAllowlist)
    .where(
      and(
        eq(policyAllowlist.policyId, policy.id),
        eq(policyAllowlist.organizationId, user.organizationId),
      ),
    )
    .all()
    .sort((a, b) => a.wallet.localeCompare(b.wallet))

  const denylist = db()
    .select({
      wallet: policyDenylist.wallet,
      label: policyDenylist.label,
      reason: policyDenylist.reason,
    })
    .from(policyDenylist)
    .where(
      and(
        eq(policyDenylist.policyId, policy.id),
        eq(policyDenylist.organizationId, user.organizationId),
      ),
    )
    .all()
    .sort((a, b) => a.wallet.localeCompare(b.wallet))

  const owned = db()
    .select({ id: services.id, name: services.name, slug: services.slug, policyId: services.policyId })
    .from(services)
    .where(eq(services.organizationId, user.organizationId))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={policy.name}
        body="Checks run in order and the first terminal result wins, so a denylisted wallet is refused before any cap or limit is considered."
      />

      {canEdit ? (
        <PolicyEditor
          policy={{
            id: policy.id,
            name: policy.name,
            description: policy.description,
            unknownAction: policy.unknownAction,
            // Caps are stored as base-unit strings and edited as decimals, so they are converted
            // on the way out rather than showing 5000000 to a human.
            maxAmountPerRequest: capToHuman(policy.maxAmountPerRequestBase),
            dailyCapPerWallet: capToHuman(policy.dailyCapPerWalletBase),
            ungrantedSpendCap: capToHuman(policy.ungrantedSpendCapBase),
            rateLimitPerMin: policy.rateLimitPerMin === null ? '' : String(policy.rateLimitPerMin),
            active: policy.active,
          }}
          allowlist={allowlist}
          denylist={denylist}
          services={owned.map((s) => ({
            id: s.id,
            name: s.name,
            slug: s.slug,
            boundHere: s.policyId === policy.id,
          }))}
        />
      ) : (
        <Card>
          <div className="flex flex-col gap-2 px-5 py-10 text-[13px] leading-relaxed text-ink-3">
            <p>You are an analyst here, so you can read everything and change nothing.</p>
            <p>Ask an owner or operator to change this policy.</p>
          </div>
        </Card>
      )}
    </div>
  )
}
