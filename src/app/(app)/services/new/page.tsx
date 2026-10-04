import { and, eq } from 'drizzle-orm'
import { Card, PageHeader } from '@/components/ui/primitives'
import ServiceForm from '@/components/dashboard/service-form'
import { requireUserPage } from '@/lib/auth/session'
import { roleInOrganization } from '@/lib/auth/identity'
import { db } from '@/lib/db/client'
import { policies } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

/**
 * Publish a service at /v1/:slug.
 *
 * This route is what the `Create service` links on /services and in the empty state have pointed
 * at since the console was written. They were 404s: services could only be created by
 * `npm run db:seed`, so the catalogue belonged to the seeded organization and an organization
 * created by signing up owned nothing and could not add anything.
 *
 * Analysts get the same read-only explanation the settings panels give rather than a 404. The
 * role model says an analyst "can read everything and change nothing", and a hidden page would
 * imply the capability might exist for them later.
 */
export default async function NewServicePage() {
  const user = await requireUserPage()
  // Read the role from the membership row rather than user.role, for the same reason settings does:
  // the denormalized column is a display cache and has already lied about a demotion once.
  const role = roleInOrganization(user.id, user.organizationId)
  const canCreate = role === 'owner' || role === 'operator'

  const rows = db()
    .select({
      id: policies.id,
      name: policies.name,
      unknownAction: policies.unknownAction,
    })
    .from(policies)
    .where(
      and(eq(policies.organizationId, user.organizationId), eq(policies.active, true)),
    )
    .all()

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Create service"
        body="Publish an endpoint at /v1/:slug. PageSure answers an unpaid request with a payment challenge, and your policy decides who is allowed to pay."
      />

      {canCreate ? (
        <ServiceForm policies={rows} />
      ) : (
        <Card>
          <div className="flex flex-col gap-2 px-5 py-10 text-[13px] leading-relaxed text-ink-3">
            <p>You are an analyst here, so you can read everything and change nothing.</p>
            <p>Ask an owner or operator to publish this service.</p>
          </div>
        </Card>
      )}
    </div>
  )
}
