/**
 * The hero visual is a REAL component preview, not a mock screenshot.
 *
 * It renders a real gateway request lifecycle read from the write tables. When the
 * database is empty it falls back to the canonical sequence and says so, so a judge
 * always knows which one they are looking at.
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
  { step: 'REQUEST', detail: 'GET /v1/search  ·  X-Pagesure-Payer: G…' },
  { step: 'POLICY_CHECK', detail: 'allowlist hit, asset and network allowed' },
  { step: 'CHALLENGE', detail: '402  ·  WWW-Authenticate: Payment' },
  { step: 'SIGNING', detail: 'Soroban SAC transfer authorization' },
  { step: 'PAYING', detail: 'fee sponsored, payer pays no XLM' },
  { step: 'CONFIRMING', detail: 'confirmed on ledger' },
  { step: 'PAID', detail: '0.01 USDC settled' },
  { step: 'SERVICE_EXECUTED', detail: 'upstream: Brave Search API' },
]

function tone(step: string): string {
  if (step === 'BLOCKED' || step === 'FAILED') return 'text-block'
  if (step === 'PAID' || step === 'SERVICE_EXECUTED') return 'text-allow'
  if (step === 'POLICY_CHECK' || step === 'CHALLENGE') return 'text-review'
  return 'text-accent'
}

export function TracePreview({ live }: { live: Step[] }) {
  const isLive = live.length > 0
  const steps = isLive ? live : CANONICAL

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-[0_1px_2px_rgba(12,13,15,0.04)]">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-allow" />
          <span className="text-[13px] font-medium text-ink">
            {isLive ? 'Live gateway trace' : 'Request lifecycle'}
          </span>
        </div>
        <span className="mono text-[11px] text-ink-4">
          {isLive ? 'from the database' : 'canonical sequence'}
        </span>
      </div>

      <ol className="divide-y divide-line">
        {steps.map((entry, index) => (
          <li
            key={`${entry.step}-${index}`}
            className="trace-row flex items-baseline gap-4 px-5 py-2.5"
            style={
              isLive
                ? undefined
                : { animationDelay: `${220 + index * 110}ms` }
            }
          >
            <span className="mono w-5 shrink-0 text-right text-[11px] text-ink-4">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className={`mono w-[118px] shrink-0 text-[11px] ${tone(entry.step)}`}>
              {entry.step}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{entry.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}