import Link from 'next/link'
import { Badge, Card, Dot, EmptyState, KeyValue, PageHeader } from '@/components/ui/primitives'
import { resolveServiceById } from '@/lib/services/registry'
import { formatAmount } from '@/lib/money'
import { openReviews, countPendingReviews } from '@/lib/policy/review'
import { ReviewActions } from '@/components/dashboard/review-actions'
import type { PolicyTrace } from '@/lib/policy/types'

export const dynamic = 'force-dynamic'

/**
 * Review queue. REVIEW genuinely held the request: no challenge was issued, no payment
 * was taken, the upstream was never called. Approving writes a service-scoped, expiring
 * grant. It never edits the allowlist.
 */
export default function ReviewPage() {
  const pending = openReviews(100)
  const pendingCount = countPendingReviews()

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Review queue"
        body="Held requests. Nothing here has been charged. Approving a wallet creates a time-boxed grant scoped to that one service, not a permanent allowlist entry."
      />

      {pending.length === 0 ? (
        <Card>
          <EmptyState
            title={pendingCount === 0 ? 'Nothing is waiting' : 'No pending reviews'}
            body="A request lands here when the policy holds it: an unknown wallet, an amount over a cap, or a wallet that would exceed its rolling 24h limit. Send a request from an unrecognised wallet to see it appear."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map((review) => {
            const service = resolveServiceById(review.serviceId ?? '')
            const trace = review.policyTrace as PolicyTrace | null
            return (
              <Card key={review.id}>
                <div className="flex flex-col gap-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Dot tone="review" />
                      <span className="mono text-[13px] text-ink">{review.wallet}</span>
                      {service ? (
                        <span className="text-[13px] text-ink-3">on {service.name}</span>
                      ) : null}
                    </div>
                    <Badge tone="review">held</Badge>
                  </div>

                  <div className="px-0">
                    <KeyValue k="Reason" v={review.reason} />
                    <KeyValue
                      k="Amount"
                      v={`${formatAmount(review.amountBase, 7)} USDC`}
                      mono
                    />
                    <KeyValue
                      k="Raised"
                      v={new Date(review.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
                      mono
                    />
                    <KeyValue k="Review id" v={review.id} mono />
                  </div>

                  <ReviewActions reviewId={review.id} />

                  {trace?.reason ? (
                    <p className="border-t border-line pt-4 text-[12px] text-ink-3">
                      Checks that ran before the hold are recorded on the request. Open the
                      request to see the full trace.
                    </p>
                  ) : null}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Card>
        <div className="px-5 py-4">
          {/* Matches CardHeader's title weight so the two kinds of card heading do not
              read as different components. */}
          <h2 className="text-[15px] leading-snug font-semibold tracking-tight">
            How a hold behaves
          </h2>
          {/* Capped: this sat uncapped inside a full-width card and ran to ~200
              characters per line. */}
          <div className="mt-3 flex max-w-[68ch] flex-col gap-2 text-[13px] leading-relaxed text-ink-3">
            <p>
              Preflight runs before any payment exists, so a hold here costs the payer
              nothing: no MPP challenge is issued, nothing settles on chain, and the
              upstream endpoint is never called.
            </p>
            <p>
              Approving writes a grant that expires. The payer retries with the review id
              and the request proceeds through the normal paid path.
            </p>
            <p>
              Rejecting writes nothing, so the same wallet is held again on retry.
            </p>
          </div>
          <div className="pt-4">
            <Link href="/policies" className="inline-flex items-center rounded-control px-2 py-1 text-[13px] text-accent hover:underline">
              Edit policies
            </Link>
          </div>
        </div>
      </Card>
    </div>
  )
}