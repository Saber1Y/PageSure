import Link from 'next/link'
import {NOT_SET,  Card, KeyValue } from '@/components/ui/primitives'
import { PolicyTraceView } from '@/components/dashboard/policy-trace'
import { requestDetail } from '@/lib/metering/aggregates'
import { requireUserPage } from '@/lib/auth/session'
import { formatAmount } from '@/lib/money'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * The Policy Evaluation screen. It renders the stored trace verbatim and states
 * explicitly what happened to the payment and to the service, because those two
 * outcomes differ and conflating them would be dishonest.
 */
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserPage()
  const { id } = await params
  // Scoped: a request id belonging to another organization resolves to null and 404s here,
  // exactly like an id that does not exist.
  const request = requestDetail(user.organizationId, id)
  if (!request) notFound()

  // Map the recorded status onto the honest payment/service pair.
  const outcome = (() => {
    switch (request.status) {
      case 'paid':
        return { payment: 'settled', service: 'delivered' }
      case 'challenged':
        return { payment: 'not_started', service: 'not_executed' }
      case 'blocked':
        return { payment: 'not_started', service: 'not_executed' }
      case 'review_pending':
        return { payment: 'not_started', service: 'not_executed' }
      case 'rejected_mismatch':
      case 'charged_not_delivered':
        return { payment: 'settled', service: 'not_executed' }
      case 'failed':
        return { payment: 'settled', service: 'failed' }
      default:
        return { payment: 'not_started', service: 'not_executed' }
    }
  })()

  return (
    <div className="flex flex-col gap-8">
      <header>
        <Link href="/overview" className="inline-flex items-center rounded-control px-2 py-1 text-[13px] text-accent hover:underline">
          Overview
        </Link>
        <h1 className="mono mt-2 text-[19px] leading-tight font-semibold tracking-tight break-all">
          {request.id}
        </h1>
        <p className="mt-1 text-[13px] text-ink-3">
          {request.serviceName} · {request.mode === 'channel' ? 'MPP Session' : 'MPP Charge'} ·{' '}
          {new Date(request.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
        </p>
      </header>

      <Card>
        <div className="px-5 py-4">
          <h2 className="text-[15px] leading-snug font-semibold tracking-tight">Policy evaluation</h2>
        </div>
        <div className="px-5 pb-5">
          <PolicyTraceView
            trace={request.policyTrace}
            payment={outcome.payment}
            service={outcome.service}
          />
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4">
          <h2 className="text-[15px] leading-snug font-semibold tracking-tight">Request record</h2>
        </div>
        <div className="grid gap-x-8 px-5 pb-5 sm:grid-cols-2">
          <KeyValue k="Status" v={request.status} mono />
          <KeyValue k="Amount" v={`${formatAmount(request.amountBase, request.decimals)} ${request.assetCode}`} mono />
          <KeyValue k="Claimed payer (untrusted)" v={request.claimedPayer ?? NOT_SET} mono />
          <KeyValue k="Verified payer (authoritative)" v={request.verifiedPayer ?? NOT_SET} mono />
          <KeyValue k="Upstream provider" v={request.upstreamProvider ?? NOT_SET} />
          <KeyValue k="Upstream status" v={request.upstreamStatus ?? NOT_SET} mono />
          <KeyValue k="Receipt reference" v={request.receiptReference ?? NOT_SET} mono />
          <KeyValue k="Payment tx" v={request.paymentTxHash ?? NOT_SET} mono />
          <KeyValue k="Latency" v={request.latencyMs ? `${request.latencyMs}ms` : NOT_SET} mono />
        </div>
      </Card>

      <Card>
        <div className="px-5 py-4">
          <h2 className="text-[15px] leading-snug font-semibold tracking-tight">How to read this</h2>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-5 text-[13px] leading-relaxed text-ink-3">
          <p>
            <span className="text-ink-2">Claimed payer</span> comes from an unverified
            credential payload or a declared header. It selects a policy and can be
            refused early, but it never authorises an upstream call.
          </p>
          <p>
            <span className="text-ink-2">Verified payer</span> is read from the credential
            only after the SDK has verified it cryptographically. This is the identity
            the authoritative policy pass runs against.
          </p>
          <p>
            A trace recorded in the <span className="mono">preflight</span> phase happened
            before any payment existed. One recorded as{' '}
            <span className="mono">authoritative</span> happened after settlement, which
            is why a post-verification block can mean money already moved.
          </p>
        </div>
      </Card>
    </div>
  )
}