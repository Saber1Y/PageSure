import { Card, PageHeader } from '@/components/ui/primitives'
import NewPolicyForm from '@/components/dashboard/new-policy-form'
import { requireUserPage } from '@/lib/auth/session'
import { roleInOrganization } from '@/lib/auth/identity'

export const dynamic = 'force-dynamic'

/**
 * Create an access policy.
 *
 * The counterpart to /services/new. Creating a service already makes a default policy when the
 * organization has none, so this is for the second and subsequent ones - the case where an
 * operator wants a cheap open policy for one service and a tight one for another, which is the
 * whole point of having policies at all.
 */
export default async function NewPolicyPage() {
  const user = await requireUserPage()
  const role = roleInOrganization(user.id, user.organizationId)
  const canEdit = role === 'owner' || role === 'operator'

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Create policy"
        body="A provider-defined access policy. Evaluation is ordered and every check is recorded, so any decision can be explained after the fact."
      />

      {canEdit ? (
        <NewPolicyForm />
      ) : (
        <Card>
          <div className="flex flex-col gap-2 px-5 py-10 text-[13px] leading-relaxed text-ink-3">
            <p>You are an analyst here, so you can read everything and change nothing.</p>
            <p>Ask an owner or operator to create this policy.</p>
          </div>
        </Card>
      )}
    </div>
  )
}
