import Link from 'next/link'
import { Badge, Card, Dot, EmptyState } from '@/components/ui/primitives'
import { listAllSessions } from '@/lib/sessions/lookup'
import { resolveServiceById } from '@/lib/services/registry'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

export default function SessionsPage() {
  const sessions = listAllSessions(100)

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight">Sessions</h1>
        <p className="mt-1 max-w-[65ch] text-[14px] leading-relaxed text-ink-3">
          Each session is one funded one-way payment channel. Requests accumulate off-chain
          as cumulative commitments and settle on-chain once, when the channel closes.
        </p>
      </header>

      {sessions.length === 0 ? (
        <Card>
          <EmptyState
            title="No sessions yet"
            body="A payer opens a session by deploying a channel instance through the factory. PageSure verifies the channel against chain before it can be used."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className="label-xs px-5 py-3">Session</th>
                  <th className="label-xs px-3 py-3">Funder</th>
                  <th className="label-xs px-3 py-3">Service</th>
                  <th className="label-xs px-3 py-3 text-right">Requests</th>
                  <th className="label-xs px-3 py-3 text-right">Accumulated</th>
                  <th className="label-xs px-3 py-3 text-right">Funded</th>
                  <th className="label-xs px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sessions.map((session) => {
                  const service = resolveServiceById(session.serviceId)
                  return (
                    <tr key={session.id} className="transition-colors hover:bg-surface-2">
                      <td className="px-5 py-3">
                        <Link
                          href={`/sessions/${session.id}`}
                          className="mono text-[13px] text-accent hover:underline"
                        >
                          #{session.ref}
                        </Link>
                      </td>
                      <td className="mono px-3 py-3 text-[12px] text-ink-2">
                        {session.funder.slice(0, 10)}…
                      </td>
                      <td className="px-3 py-3 text-[13px] text-ink-2">
                        {service?.name ?? '—'}
                      </td>
                      <td className="mono px-3 py-3 text-right text-[13px] text-ink">
                        {session.requestCount}
                      </td>
                      <td className="mono px-3 py-3 text-right text-[13px] text-review">
                        {formatAmount(session.cumulativeBase, session.decimals)}
                      </td>
                      <td className="mono px-3 py-3 text-right text-[13px] text-ink-3">
                        {formatAmount(session.fundedBase, session.decimals)}
                      </td>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <Dot
                            tone={
                              session.status === 'active'
                                ? 'allow'
                                : session.status === 'settled'
                                  ? 'neutral'
                                  : session.status === 'failed'
                                    ? 'block'
                                    : 'review'
                            }
                          />
                          <span className="text-[12px] text-ink-2">{session.status}</span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

export { Badge }