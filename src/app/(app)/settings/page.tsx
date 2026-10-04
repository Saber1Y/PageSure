import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { organizations } from '@/lib/db/schema'
import { requireUser } from '@/lib/auth/session'
import { signerRegistrationAvailable } from '@/lib/mpp/signer-registration'
import { roleInOrganization } from '@/lib/auth/identity'
import { Card } from '@/components/ui/primitives'
import { SignerPanel, TreasuryPanel } from '@/components/dashboard/settings-panels'
import { InvitePanel } from '@/components/dashboard/invite-panel'
import { listMembers } from '@/lib/auth/identity'

export const dynamic = 'force-dynamic'

/**
 * Organization settings.
 *
 * Everything that makes an organization able to take money, kept together and kept optional.
 * The page deliberately does not gate on "has a wallet": someone arriving here from an email
 * link with nothing connected should see two clearly labelled next steps, not a wall.
 *
 * The role is read from the membership table rather than from the session copy, so an operator
 * who navigates here is told they cannot change these settings instead of being shown controls
 * that silently fail.
 */
export default async function SettingsPage() {
  const user = await requireUser()

  const organization = db()
    .select()
    .from(organizations)
    .where(eq(organizations.id, user.organizationId))
    .get()

  // Membership is the authority. `user.role` is a display convenience and is not trusted here,
  // because this page authorizes a change to where money lands.
  const role = roleInOrganization(user.id, user.organizationId)
  const isOwner = role === 'owner'
  const members = listMembers(user.organizationId)

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-10">
      <header>
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight">Settings</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-3">
          {organization?.name ?? user.organizationName} · you are{' '}
          {role ? <span className="text-ink-2">{role}</span> : 'a member'} here
        </p>
      </header>

      {!isOwner ? (
        <p className="rounded-control border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-ink-3">
          Only an owner can change these. You can read the result, which is usually all an
          operator needs.
        </p>
      ) : null}

      <Card className="p-5">
        {isOwner ? (
          <TreasuryPanel
            recipient={organization?.settlementRecipient ?? null}
            verified={organization?.treasuryVerified ?? false}
          />
        ) : (
          <ReadOnlyRow
            label="Settlement account"
            value={
              organization?.treasuryVerified
                ? (organization.settlementRecipient ?? 'connected')
                : organization?.settlementRecipient
                  ? 'not verified'
                  : 'not connected'
            }
          />
        )}
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] font-medium text-ink">People</p>
            <span className="text-[12px] text-ink-4">
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </span>
          </div>

          <ul className="flex flex-col divide-y divide-line">
            {members.map((member) => (
              <li key={member.userId} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="flex flex-col">
                  <span className="text-[13px] text-ink">{member.displayName}</span>
                  {member.email ? (
                    <span className="text-[12px] text-ink-4">{member.email}</span>
                  ) : null}
                </span>
                <span className="text-[12px] text-ink-3">
                  {member.userId === user.id ? `${member.role} (you)` : member.role}
                </span>
              </li>
            ))}
          </ul>

          <InvitePanel isOwner={isOwner} />
        </div>
      </Card>

      <Card className="p-5">
        {isOwner ? (
          <SignerPanel
            signerUrl={organization?.commitmentSignerUrl ?? null}
            signerTokenEnv={organization?.commitmentSignerTokenEnv ?? null}
            registrationAllowed={signerRegistrationAvailable()}
            registered={Boolean(organization?.commitmentSignerUrl)}
          />
        ) : (
          <ReadOnlyRow
            label="External channel signer"
            value={organization?.commitmentSignerUrl ? 'registered' : 'not registered'}
          />
        )}
      </Card>
    </div>
  )
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-[13px] font-medium text-ink">{label}</p>
      <p className="mono text-[12px] text-ink-3">{value}</p>
    </div>
  )
}