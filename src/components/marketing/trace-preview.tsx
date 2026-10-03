/**
 * The hero visual is a REAL component preview, not a mock screenshot.
 *
 * It renders a real gateway request lifecycle read from the write tables. When the
 * database is empty it falls back to the canonical sequence and says so in the header,
 * so a visitor always knows which of the two they are looking at. There is no live
 * status dot implying a stream that is not there.
 *
 * The reveal is pure CSS: each row carries its own `animation-delay`. No useEffect, no
 * setState, no main-thread work while the page is still loading fonts and images. Only
 * `opacity` and `transform` animate, both compositor-friendly.
 */

interface Step {
  step: string
  detail: string
}

const CANONICAL: Step[] = [
  { step: 'REQUEST', detail: 'GET /v1/search' },
  { step: 'POLICY_CHECK', detail: 'allowlist hit, asset and network allowed' },
  { step: 'CHALLENGE', detail: '402, WWW-Authenticate: Payment' },
  { step: 'SIGNING', detail: 'Soroban SAC transfer authorization' },
  { step: 'PAYING', detail: 'fee sponsored, payer spends no XLM' },
  { step: 'CONFIRMING', detail: 'confirmed on ledger' },
  { step: 'PAID', detail: '0.01 USDC settled' },
  { step: 'DELIVERED', detail: 'upstream: Brave Search API' },
]

/**
 * Colour is reserved for the decision the step represents, never for decoration.
 * The steps that move money or deliver a resource are the ones that earn colour.
 */
function tone(step: string): string {
  if (step === 'PAID' || step === 'DELIVERED' || step === 'SERVICE_EXECUTED') return 'text-allow'
  if (step === 'POLICY_CHECK') return 'text-review'
  return 'text-ink-3'
}

export function TracePreview({ live }: { live: Step[] }) {
  const isLive = live.length > 0
  const steps = isLive ? live : CANONICAL

  return (
    <figure className="overflow-hidden rounded-card border border-line bg-surface">
      <figcaption className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3.5">
        <span className="text-[13px] font-medium text-ink">
          {isLive ? 'A real request from this gateway' : 'The canonical request lifecycle'}
        </span>
        <span className="mono shrink-0 text-[11px] text-ink-4">
          {isLive ? 'read from the database' : 'no traffic recorded yet'}
        </span>
      </figcaption>

      <ol className="divide-y divide-line">
        {steps.map((entry, index) => (
          <li
            key={`${entry.step}-${index}`}
            className="trace-row flex items-baseline gap-4 px-5 py-2.5"
            style={{ animationDelay: `${220 + index * 90}ms` }}
          >
            <span className="mono w-5 shrink-0 text-right text-[11px] text-ink-4">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className={`mono w-[112px] shrink-0 text-[11px] ${tone(entry.step)}`}>
              {entry.step}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{entry.detail}</span>
          </li>
        ))}
      </ol>
    </figure>
  )
}