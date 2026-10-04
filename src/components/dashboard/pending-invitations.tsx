import { Card } from '@/components/ui/primitives'

/**
 * Invitations waiting for somebody who has proven their address but has not opened the link.
 *
 * Shown above the organization form so that somebody who was invited somewhere reads "you have
 * a place waiting" before "you may create an organization".
 *
 * There is deliberately no button here. The token is stored hashed and is not recoverable, so
 * the only honest thing this page can do is name the organization and point back at the email.
 * A "Join" button that silently did nothing would be worse than no button, and rebuilding a
 * working link from a stored hash would mean storing the credential in the clear to fix a
 * cosmetic problem.
 */
export function PendingInvitations({
  invitations,
}: {
  invitations: Array<{
    organizationId: string
    organizationName: string
    role: string
    expiresAt: number
  }>
}) {
  return (
    <Card className="mb-4 border-accent/40 p-5">
      <p className="text-[13px] font-medium text-ink">You have been invited</p>
      <ul className="mt-3 flex flex-col gap-3">
        {invitations.map((invitation) => (
          <li key={invitation.organizationId} className="flex flex-col gap-1">
            <span className="text-[13px] text-ink">
              <span className="font-medium">{invitation.organizationName}</span>{' '}
              <span className="text-ink-4">as {invitation.role}</span>
            </span>
            <span className="text-[12px] leading-relaxed text-ink-3">
              Open the invitation email on this device and follow its link to join.
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}