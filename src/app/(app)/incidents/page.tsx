import Link from 'next/link'
import { Badge, Card, EmptyState, KeyValue, PageHeader } from '@/components/ui/primitives'
import { incidentRows } from '@/lib/metering/aggregates'
import { resolveServiceById } from '@/lib/services/registry'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * Incidents. These exist because charge mode settles inside mppx verify(), so a policy
 * block applied after verification means the money already moved. PageSure shows that
 * cost rather than hiding it. No auto-refund is claimed and no allowlist is touched.
 */
export default function IncidentsPage() {
  const rows = incidentRows(100)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Incidents"
        body="Money taken without delivery, upstream failures, and channel disputes. In charge mode the payment settles inside the SDK before a post-verification policy decision can be applied, so these outcomes are surfaced rather than hidden. Session mode has no equivalent, because a blocked request never advances the channel cumulative."
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No incidents"
            body="Nothing has been charged without being delivered. Block a wallet to see the refusal path, which takes no payment at all."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((incident) => {
            const service = resolveServiceById(incident.serviceId ?? '')
            const tone = incident.kind === 'charged_not_delivered' ? 'block' : 'review'
            return (
              <Card key={incident.id}>
                <div className="flex flex-col gap-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Badge tone={tone}>{incident.kind.replace(/_/g, ' ')}</Badge>
                      {service ? (
                        <span className="text-[13px] text-ink-3">on {service.name}</span>
                      ) : null}
                    </div>
                    <span className="mono text-[11px] text-ink-4">
                      {new Date(incident.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
                    </span>
                  </div>

                  <p className="text-[13px] leading-relaxed text-ink-2">{incident.reason}</p>

                  <div className="grid gap-x-8 sm:grid-cols-2">
                    <KeyValue k="Payer" v={incident.payer} mono />
                    <KeyValue
                      k="Amount taken"
                      v={`${formatAmount(incident.amountBase, incident.decimals)} ${incident.assetCode}`}
                      mono
                    />
                    {incident.paymentTxHash ? (
                      <KeyValue k="Transaction" v={incident.paymentTxHash} mono />
                    ) : null}
                    {incident.requestId ? (
                      <KeyValue
                        k="Request"
                        v={
                          <Link
                            href={`/requests/${incident.requestId}`}
                            className="text-accent hover:underline"
                          >
                            inspect trace
                          </Link>
                        }
                      />
                    ) : null}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}