import Link from 'next/link'
import { notFound } from 'next/navigation'
import {NOT_SET,  Badge, Card, CardHeader, KeyValue } from '@/components/ui/primitives'
import { resolveServiceById } from '@/lib/services/registry'
import { serviceRollups } from '@/lib/metering/aggregates'
import { db } from '@/lib/db/client'
import { policies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

export default async function ServiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const service = resolveServiceById(id)
  if (!service) notFound()

  const rollup = serviceRollups().find((s) => s.id === id)
  const policy = service.policyId
    ? db().select().from(policies).where(eq(policies.id, service.policyId)).get()
    : null

  const origin = process.env.APP_URL ?? 'http://localhost:3000'
  const endpoint = `${origin}/v1/${service.slug}`

  return (
    <div className="flex flex-col gap-8">
      <header>
        <Link href="/services" className="inline-flex items-center rounded-control px-2 py-1 text-[13px] text-accent hover:underline">
          Services
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-medium tracking-tight">{service.name}</h1>
          <Badge tone={service.mode === 'channel' ? 'pending' : 'neutral'}>
            {service.mode === 'channel' ? 'MPP Session' : 'MPP Charge'}
          </Badge>
        </div>
        <p className="mt-1 max-w-[65ch] text-[14px] leading-relaxed text-ink-3">
          {service.description}
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-2">
        <Card>
          <CardHeader title="Pricing" />
          <div className="px-5 pb-5">
            <KeyValue
              k="Price per request"
              v={`${formatAmount(service.priceBase, service.decimals)} ${service.assetCode}`}
              mono
            />
            <KeyValue k="Asset contract" v={service.assetContract} mono />
            <KeyValue k="Decimals" v={service.decimals} mono />
            <KeyValue k="Payment mode" v={service.mode === 'channel' ? 'MPP Session (channel)' : 'MPP Charge'} />
            <KeyValue k="Policy" v={policy?.name ?? 'none attached'} />
            <KeyValue k="Status" v={service.status} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Usage" />
          <div className="px-5 pb-5">
            <KeyValue k="Total requests" v={rollup?.requestCount ?? 0} mono />
            <KeyValue k="Paid requests" v={rollup?.paidCount ?? 0} mono />
            <KeyValue
              k="Volume"
              v={`${formatAmount(rollup?.volumeBase ?? '0', service.decimals)} ${service.assetCode}`}
              mono
            />
            <KeyValue
              k="Last request"
              v={rollup?.lastRequestAt ? new Date(rollup.lastRequestAt).toISOString().slice(0, 19) : NOT_SET}
              mono
            />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Integration"
          hint="What an agent needs to call this service"
        />
        <div className="flex flex-col gap-5 px-5 pb-5">
          <div>
            <span className="label-xs">Endpoint</span>
            <pre className="mono mt-2 overflow-x-auto rounded-control border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink">
              {endpoint}
            </pre>
          </div>

          <div>
            <span className="label-xs">Declare the payer</span>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
              The first request has no credential yet, so the paying account must be
              declared. It is untrusted: it selects a policy and can be refused, but it
              never authorises delivery.
            </p>
            <pre className="mono mt-2 overflow-x-auto rounded-control border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink">
{`curl "${endpoint}?q=stellar+agentic+payments" \\
  -H "X-Pagesure-Payer: GXXXXXXX..."`}
            </pre>
          </div>

          <div>
            <span className="label-xs">Payment negotiation</span>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
              PageSure answers an unpaid request with{' '}
              <span className="mono">402 Payment Required</span> and a{' '}
              <span className="mono">WWW-Authenticate: Payment</span> challenge. The client
              signs a Soroban SAC transfer and retries with an{' '}
              <span className="mono">Authorization: Payment</span> credential. PageSure
              verifies it, settles it, then calls the upstream and returns the resource
              with a <span className="mono">Payment-Receipt</span>.
            </p>
          </div>

          {service.mode === 'channel' ? (
            <div>
              <span className="label-xs">Session mode</span>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
                For repeated calls, open a session instead. The payer deploys a channel
                instance through the factory and signs the invoke, so funds never sit in an
                account PageSure controls. PageSure verifies the channel against chain,
                then each request signs a cumulative commitment off-chain. Closing the
                channel settles everything in one transaction.
              </p>
              <pre className="mono mt-2 overflow-x-auto rounded-control border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink">
{`POST "${endpoint}/session"
  { "funder": "G…", "fundedBase": "1000000",
    "commitmentPublicKey": "G…" }

POST "${endpoint}/session/confirm"
  { "sessionId": "ses_…", "channelContract": "C…" }`}
            </pre>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  )
}