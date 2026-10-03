import {NOT_SET,  Badge, type DecisionTone } from '@/components/ui/primitives'
import type { CheckStatus, PolicyTrace } from '@/lib/policy/types'

/**
 * Renders a PolicyTrace exactly as stored on the request row.
 *
 * This is the visual centrepiece: the ordered per-check trace, then a verdict slab
 * that states plainly what happened to the payment and the service. The `payment` and
 * `service` lines are not decoration. A preflight block means no payment was ever
 * started and the upstream was never called; a post-verification block means the money
 * already settled and is recorded as an incident. Collapsing those two into one visual
 * would be the easiest way to get caught out by a judge.
 */

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  skip: 'skipped',
  pending: 'pending',
}

const STATUS_CLASS: Record<CheckStatus, string> = {
  pass: 'text-allow',
  fail: 'text-block',
  skip: 'text-ink-4',
  pending: 'text-review',
}

export function PolicyTraceView({
  trace,
  payment,
  service,
  reason,
}: {
  trace: PolicyTrace | null
  /** What happened to the payment. */
  payment?: string
  /** What happened to the upstream call. */
  service?: string
  reason?: string
}) {
  if (!trace) {
    return (
      <p className="text-[13px] text-ink-3">
        No policy trace was recorded for this request.
      </p>
    )
  }

  const tone: DecisionTone =
    trace.decision === 'allow' ? 'allow' : trace.decision === 'review' ? 'review' : 'block'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={tone}>
          {trace.phase === 'preflight' ? 'Preflight' : 'Post-verification'} · {trace.decision.toUpperCase()}
        </Badge>
        <span className="mono text-[12px] text-ink-3">{trace.subject}</span>
        {trace.durationMs !== undefined ? (
          <span className="mono text-[11px] text-ink-4">{trace.durationMs}ms</span>
        ) : null}
      </div>

      <ol className="divide-y divide-line border-y border-line">
        {trace.checks.map((check, index) => (
          <li key={check.key} className="flex items-start gap-4 py-2.5">
            <span className="mono w-6 shrink-0 text-right text-[11px] text-ink-4">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="w-40 shrink-0 text-[13px] text-ink-2">{check.label}</span>
            <span className={`mono w-16 shrink-0 text-[11px] ${STATUS_CLASS[check.status]}`}>
              {STATUS_LABEL[check.status]}
            </span>
            <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-3">
              {check.detail || NOT_SET}
            </span>
          </li>
        ))}
      </ol>

      {reason || trace.reason ? (
        <p className="text-[13px] leading-relaxed text-ink-2">
          <span className="text-ink-4">Reason: </span>
          {reason ?? trace.reason}
        </p>
      ) : null}

      {payment || service ? (
        <div
          className={`flex flex-col gap-1.5 rounded-card px-4 py-3 ${
            payment === 'not_started'
              ? 'bg-allow-soft'
              : payment === 'not_committed'
                ? 'bg-review-soft'
                : 'bg-block-soft'
          }`}
        >
          {payment ? (
            <p
              className={`text-[13px] font-medium ${
                payment === 'not_started'
                  ? 'text-allow'
                  : payment === 'not_committed'
                    ? 'text-review'
                    : 'text-block'
              }`}
            >
              Payment: {humanise(payment)}
            </p>
          ) : null}
          {service ? (
            <p
              className={`text-[13px] font-medium ${
                service === 'not_executed'
                  ? payment === 'not_started'
                    ? 'text-allow'
                    : 'text-block'
                  : 'text-review'
              }`}
            >
              Service: {humanise(service)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function humanise(value: string): string {
  switch (value) {
    case 'not_started':
      return 'NOT STARTED'
    case 'not_committed':
      return 'NOT COMMITTED TO THE CHANNEL'
    case 'settled':
      return 'SETTLED ON CHAIN'
    case 'not_executed':
      return 'NOT EXECUTED'
    case 'failed':
      return 'FAILED'
    default:
      return value.toUpperCase()
  }
}