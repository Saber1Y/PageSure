import Link from 'next/link'
import {
  Badge,
  Card,
  CardHeader,
  Dot,
  EmptyState,
  Metric,
  short,
  type DecisionTone,
} from '@/components/ui/primitives'
import { overviewStats, recentActivity, serviceRollups } from '@/lib/metering/aggregates'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

const DECIMALS = 7

const ACTIVITY_TONE: Record<string, { tone: DecisionTone; prefix: string }> = {
  request_paid: { tone: 'allow', prefix: 'Paid' },
  session_opened: { tone: 'neutral', prefix: 'Session' },
  session_settled: { tone: 'allow', prefix: 'Settled' },
  payment_blocked: { tone: 'block', prefix: 'Blocked' },
  review_pending: { tone: 'review', prefix: 'Held' },
  review_resolved: { tone: 'neutral', prefix: 'Review' },
  service_created: { tone: 'neutral', prefix: 'Service' },
  incident: { tone: 'block', prefix: 'Incident' },
}

export default function OverviewPage() {
  const stats = overviewStats()
  const services = serviceRollups()
  const activity = recentActivity(14)

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight">Overview</h1>
        <p className="mt-1 text-[14px] text-ink-3">
          Every figure below is a query over the gateway write tables.
        </p>
      </header>

      {/* Volume and traffic */}
      <Card>
        <div className="grid grid-cols-2 divide-x divide-y divide-line md:grid-cols-4 md:divide-y-0">
          <Metric label="Requests" value={stats.totalRequests.toLocaleString()} />
          <Metric
            label="Payment volume"
            value={`${formatAmount(stats.paymentVolumeBase, DECIMALS)} USDC`}
          />
          <Metric label="Active sessions" value={String(stats.activeSessions)} />
          <Metric
            label="Open incidents"
            value={String(stats.openIncidents)}
            tone={stats.openIncidents > 0 ? 'block' : 'neutral'}
            sub={stats.openIncidents > 0 ? 'money taken, not delivered' : 'none'}
          />
        </div>
      </Card>

      {/* Policy decisions */}
      <Card>
        <CardHeader
          title="Policy decisions"
          hint="Preflight blocks take no payment. Reviews are held, not allowed."
        />
        <div className="grid grid-cols-3 divide-x divide-line">
          <Metric label="Allowed" value={stats.policyAllowed.toLocaleString()} tone="allow" />
          <Metric label="Blocked" value={stats.policyBlocked.toLocaleString()} tone="block" />
          <Metric
            label="Review"
            value={stats.policyReview.toLocaleString()}
            tone={stats.policyReview > 0 ? 'review' : 'neutral'}
          />
        </div>
      </Card>

      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        {/* Live activity */}
        <Card>
          <CardHeader title="Live activity" hint="Newest first" />
          {activity.length === 0 ? (
            <EmptyState
              title="No gateway traffic yet"
              body="Send a request through the Playground and every step will appear here, with real transaction hashes."
              action={
                <Link
                  href="/playground"
                  className="inline-flex rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
                >
                  Open Playground
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {activity.map((row) => {
                const meta = ACTIVITY_TONE[row.type] ?? { tone: 'neutral' as DecisionTone, prefix: 'Event' }
                return (
                  <li key={row.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Dot tone={meta.tone} />
                      <span className="truncate text-[13px] text-ink">{row.message}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {row.amountBase && row.assetCode ? (
                        <span className="mono text-[12px] text-ink-2">
                          {formatAmount(row.amountBase, row.decimals ?? DECIMALS)} {row.assetCode}
                        </span>
                      ) : null}
                      {row.requestId ? (
                        <Link
                          href={`/requests/${row.requestId}`}
                          className="mono text-[11px] text-accent hover:underline"
                        >
                          inspect
                        </Link>
                      ) : null}
                      <span className="mono w-16 text-right text-[11px] text-ink-4">
                        {timeAgo(row.createdAt)}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {/* Revenue split */}
        <Card>
          <CardHeader title="Settlement position" hint="Base units at 7 decimals" />
          <div className="divide-y divide-line">
            <div className="flex items-baseline justify-between px-5 py-3">
              <span className="text-[13px] text-ink-3">Today&apos;s volume</span>
              <span className="mono text-[15px] text-ink">
                {formatAmount(stats.todayVolumeBase, DECIMALS)} USDC
              </span>
            </div>
            <div className="flex items-baseline justify-between px-5 py-3">
              <span className="text-[13px] text-ink-3">Pending in sessions</span>
              <span className="mono text-[15px] text-review">
                {formatAmount(stats.pendingSessionsBase, DECIMALS)} USDC
              </span>
            </div>
            <div className="flex items-baseline justify-between px-5 py-3">
              <span className="text-[13px] text-ink-3">Settled on chain</span>
              <span className="mono text-[15px] text-allow">
                {formatAmount(stats.settledBase, DECIMALS)} USDC
              </span>
            </div>
          </div>
          <div className="border-t border-line px-5 py-3">
            <Link href="/settlements" className="text-[13px] text-accent hover:underline">
              View settlements
            </Link>
          </div>
        </Card>
      </div>

      {/* Services */}
      <Card>
        <CardHeader
          title="Services"
          hint="Registered endpoints exposed at /v1/:slug"
          action={
            <Link href="/services" className="text-[13px] text-accent hover:underline">
              Manage
            </Link>
          }
        />
        {services.length === 0 ? (
          <EmptyState title="No services registered" body="Create a service to expose it for machine payment." />
        ) : (
          <ul className="divide-y divide-line">
            {services.map((svc) => (
              <li key={svc.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/services/${svc.id}`}
                      className="truncate text-[14px] font-medium text-ink hover:underline"
                    >
                      {svc.name}
                    </Link>
                    <span className="mono text-[11px] text-ink-4">/v1/{svc.slug}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-ink-3">{svc.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <Badge tone={svc.mode === 'channel' ? 'pending' : 'neutral'}>
                    {svc.mode === 'channel' ? 'MPP Session' : 'MPP Charge'}
                  </Badge>
                  <span className="mono w-20 text-right text-[13px] text-ink">
                    {formatAmount(svc.priceBase, svc.decimals)} {svc.assetCode}
                  </span>
                  <span className="mono w-16 text-right text-[12px] text-ink-3">
                    {svc.requestCount} req
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

    </div>
  )
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export { short }