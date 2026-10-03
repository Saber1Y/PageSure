import Link from 'next/link'
import { Badge, Card, Dot, EmptyState } from '@/components/ui/primitives'
import { serviceRollups } from '@/lib/metering/aggregates'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

export default function ServicesPage() {
  const services = serviceRollups()

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-end justify-between gap-6">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Services</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            Each service is exposed at <span className="mono">/v1/:slug</span> and priced independently.
          </p>
        </div>
        <Link
          href="/services/new"
          className="shrink-0 rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover active:translate-y-px"
        >
          Create service
        </Link>
      </header>

      {services.length === 0 ? (
        <Card>
          <EmptyState
            title="No services yet"
            body="Register an endpoint, choose an asset and a price, then attach a policy. PageSure handles payment negotiation from there."
            action={
              <Link
                href="/services/new"
                className="inline-flex rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Create service
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {services.map((svc) => (
            <Card key={svc.id}>
              <div className="flex flex-col gap-4 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link
                      href={`/services/${svc.id}`}
                      className="text-[15px] font-medium tracking-tight text-ink hover:underline"
                    >
                      {svc.name}
                    </Link>
                    <p className="mono mt-1 text-[11px] text-ink-4">/v1/{svc.slug}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Dot tone={svc.status === 'live' ? 'allow' : 'neutral'} />
                    <span className="text-[12px] text-ink-2">
                      {svc.status === 'live' ? 'Live' : svc.status}
                    </span>
                  </div>
                </div>

                <p className="text-[13px] leading-relaxed text-ink-3">{svc.description}</p>

                <dl className="grid grid-cols-3 gap-4 border-t border-line pt-4">
                  <div>
                    <dt className="label-xs">Price</dt>
                    <dd className="mono mt-1.5 text-[14px] text-ink">
                      {formatAmount(svc.priceBase, svc.decimals)}{' '}
                      <span className="text-[11px] text-ink-3">{svc.assetCode}</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="label-xs">Requests</dt>
                    <dd className="mono mt-1.5 text-[14px] text-ink">{svc.requestCount}</dd>
                  </div>
                  <div>
                    <dt className="label-xs">Volume</dt>
                    <dd className="mono mt-1.5 text-[14px] text-ink">
                      {formatAmount(svc.volumeBase, svc.decimals)}
                    </dd>
                  </div>
                </dl>

                <div className="flex items-center justify-between gap-3">
                  <Badge tone={svc.mode === 'channel' ? 'pending' : 'neutral'}>
                    {svc.mode === 'channel' ? 'MPP Session' : 'MPP Charge'}
                  </Badge>
                  <Link
                    href={`/services/${svc.id}`}
                    className="text-[13px] text-accent hover:underline"
                  >
                    Configure
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}