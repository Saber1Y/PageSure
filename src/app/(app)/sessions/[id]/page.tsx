import Link from 'next/link'
import { Badge, Card, Dot, KeyValue } from '@/components/ui/primitives'
import { getSession } from '@/lib/sessions/lookup'
import { requestDetail } from '@/lib/metering/aggregates'
import { requests, sessionEvents } from '@/lib/db/schema'
import { db } from '@/lib/db/client'
import { resolveServiceById } from '@/lib/services/registry'
import { formatAmount } from '@/lib/money'
import { PolicyTraceView } from '@/components/dashboard/policy-trace'
import { explorerUrl } from '@/lib/metering/record'
import { desc, eq } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

/**
 * Session detail. The value proposition is rendered literally: N requests, one
 * accumulated cumulative, one channel, one settlement hash, one explorer link.
 */

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getSession(id)
  if (!session) {
    return (
      <Card>
        <div className="px-5 py-10 text-[14px] text-ink-3">No such session.</div>
      </Card>
    )
  }
  const service = resolveServiceById(session.serviceId)

  const events = db()
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, id))
    .orderBy(sessionEvents.createdAt)
    .all()

  const sessionRequests = db()
    .select({ id: requests.id })
    .from(requests)
    .where(eq(requests.sessionId, id))
    .orderBy(desc(requests.createdAt))
    .limit(20)
    .all()

  const example = sessionRequests[0] ? requestDetail(sessionRequests[0].id) : null

  return (
    <div className="flex flex-col gap-8">
      <header>
        <Link href="/sessions" className="text-[13px] text-accent hover:underline">
          Sessions
        </Link>
        <h1 className="mono mt-2 text-[22px] font-medium tracking-tight">
          Session #{session.ref}
        </h1>
        <div className="mt-2 flex items-center gap-2">
          <Dot tone={session.status === 'active' ? 'allow' : session.status === 'settled' ? 'neutral' : 'review'} />
          <span className="text-[13px] text-ink-2">{session.status}</span>
          {service ? <span className="text-[13px] text-ink-3">on {service.name}</span> : null}
        </div>
      </header>

      {/* The contrast: many machine payments, one settlement. */}
      <Card>
        <div className="grid grid-cols-2 divide-x divide-line md:grid-cols-4 md:divide-y-0">
          <div className="px-5 py-4">
            <span className="label-xs">Requests</span>
            <div className="mono mt-2 text-[26px] leading-none font-medium">{session.requestCount}</div>
          </div>
          <div className="px-5 py-4">
            <span className="label-xs">Accumulated</span>
            <div className="mono mt-2 text-[26px] leading-none font-medium text-review">
              {formatAmount(session.cumulativeBase, session.decimals)}
            </div>
          </div>
          <div className="px-5 py-4">
            <span className="label-xs">Funded</span>
            <div className="mono mt-2 text-[26px] leading-none font-medium text-ink">
              {formatAmount(session.fundedBase, session.decimals)}
            </div>
          </div>
          <div className="px-5 py-4">
            <span className="label-xs">On-chain settlements</span>
            <div className="mono mt-2 text-[26px] leading-none font-medium text-allow">
              {session.status === 'settled' ? '1' : '0'}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <div className="px-5 py-4">
            <h2 className="text-[15px] font-medium tracking-tight">Details</h2>
          </div>
          <div className="px-5 pb-5">
            <KeyValue k="Funder" v={session.funder} mono />
            <KeyValue k="Recipient" v={session.recipient} mono />
            <KeyValue k="Commitment key" v={session.commitmentPublicKey} mono />
            <KeyValue k="Channel" v={session.channelContract} mono />
            <KeyValue k="Asset" v={`${session.assetContract}`} mono />
            <KeyValue k="Network" v="stellar:testnet" mono />
            <KeyValue k="Opened" v={new Date(session.openedAt).toISOString()} />
          </div>
          {session.settlementId ? (
            <div className="border-t border-line px-5 py-4">
              <Badge tone="allow">settled</Badge>
            </div>
          ) : null}
        </Card>

        <Card>
          <div className="px-5 py-4">
            <h2 className="text-[15px] font-medium tracking-tight">Timeline</h2>
          </div>
          {events.length === 0 ? (
            <div className="px-5 pb-6 text-[13px] text-ink-3">No events recorded.</div>
          ) : (
            <ol className="px-5 pb-5">
              {events.map((event) => (
                <li key={event.id} className="flex gap-4 border-l border-line py-2 pl-4">
                  <span className="mono w-12 shrink-0 text-[11px] text-ink-4">
                    {new Date(event.createdAt).toISOString().slice(11, 19)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px] text-ink">{event.detail}</span>
                    {event.amountBase ? (
                      <span className="mono ml-2 text-[12px] text-ink-3">
                        {formatAmount(event.amountBase, session.decimals)}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {example?.policyTrace ? (
        <Card>
          <div className="px-5 py-4">
            <h2 className="text-[15px] font-medium tracking-tight">
              Policy decision on a request in this session
            </h2>
          </div>
          <div className="px-5 pb-5">
            <PolicyTraceView
              trace={example.policyTrace}
              payment={example.status === 'paid' ? 'settled' : 'not_committed'}
              service={example.status === 'paid' ? 'delivered' : 'not_executed'}
            />
          </div>
        </Card>
      ) : null}
    </div>
  )
}

export { explorerUrl }