'use client'

import { useState } from 'react'

interface ServiceOption {
  slug: string
  name: string
  description: string
  price: string
  assetCode: string
}

interface Step {
  step: string
  detail: string
  at: number
}

interface RunResult {
  ok: boolean
  status: number
  steps: Step[]
  body: unknown
  headers: Record<string, string>
  payer: string
  error: string | null
}

const STEP_TONE: Record<string, string> = {
  REQUEST: 'text-ink-3',
  POLICY_CHECK: 'text-review',
  CHALLENGE: 'text-review',
  SIGNING: 'text-accent',
  SIGNED: 'text-accent',
  PAYING: 'text-accent',
  CONFIRMING: 'text-accent',
  PAID: 'text-allow',
  SERVICE_EXECUTED: 'text-allow',
  RESULT: 'text-allow',
  BLOCKED: 'text-block',
  REVIEW_PENDING: 'text-review',
  FAILED: 'text-block',
}

export function PlaygroundClient({ services }: { services: ServiceOption[] }) {
  const [slug, setSlug] = useState(services[0]?.slug ?? '')
  const [query, setQuery] = useState('stellar agentic payments')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)

  const selected = services.find((s) => s.slug === slug)

  async function run() {
    setBusy(true)
    setResult(null)
    const response = await fetch('/api/playground', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        search: slug === 'summarize' ? { text: query } : { q: query },
      }),
    })
    const body = (await response.json()) as RunResult
    setResult(body)
    setBusy(false)
  }

  if (services.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface px-5 py-10">
        <p className="text-[14px] font-medium text-ink">No live charge-mode services</p>
        <p className="mt-1 text-[13px] text-ink-3">
          Register a service and mark it live to use the playground.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
      {/* Controls */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label htmlFor="service" className="text-[13px] font-medium text-ink">
            Service
          </label>
          <select
            id="service"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors focus:border-accent"
          >
            {services.map((service) => (
              <option key={service.slug} value={service.slug}>
                {service.name}
              </option>
            ))}
          </select>
          {selected ? (
            <p className="text-[12px] text-ink-3">{selected.description}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="query" className="text-[13px] font-medium text-ink">
            {slug === 'summarize' ? 'Text to summarise' : 'Query'}
          </label>
          <textarea
            id="query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={3}
            className="resize-y rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors focus:border-accent"
          />
        </div>

        {selected ? (
          <p className="mono text-[12px] text-ink-3">
            {selected.price} {selected.assetCode} per request
          </p>
        ) : null}

        <button
          type="button"
          onClick={run}
          disabled={busy || !slug}
          className="rounded-control bg-accent px-5 py-2.5 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Run paid request'}
        </button>
      </div>

      {/* Waterfall and result */}
      <div className="flex flex-col gap-4">
        <div className="rounded-card border border-line bg-surface">
          <div className="border-b border-line px-5 py-3.5">
            <h2 className="text-[15px] font-medium tracking-tight">Request lifecycle</h2>
          </div>

          {!result ? (
            <div className="px-5 py-10">
              {busy ? (
                // Skeletons match the shape of the rows that will replace them.
                <ul className="flex flex-col gap-3">
                  {[0, 1, 2, 3].map((i) => (
                    <li key={i} className="flex items-center gap-3">
                      <span className="skeleton h-3 w-8 rounded" />
                      <span className="skeleton h-3 flex-1 rounded" />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-3">
                  Run a request to see the real payment lifecycle, driven by the SDK&apos;s
                  progress events.
                </p>
              )}
            </div>
          ) : (
            <ol className="divide-y divide-line">
              {result.steps.map((entry, index) => (
                <li key={`${entry.step}-${index}`} className="flex items-baseline gap-3 px-5 py-2.5">
                  <span className="mono w-6 shrink-0 text-right text-[11px] text-ink-4">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span
                    className={`mono w-32 shrink-0 text-[11px] ${
                      STEP_TONE[entry.step] ?? 'text-ink-3'
                    }`}
                  >
                    {entry.step}
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">
                    {entry.detail}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {result ? (
          <>
            {result.headers['x-pagesure-request-id'] ? (
              <a
                href={`/requests/${result.headers['x-pagesure-request-id']}`}
                className="text-[13px] text-accent hover:underline"
              >
                Inspect the recorded policy decision
              </a>
            ) : null}

            <div className="rounded-card border border-line bg-surface">
              <div className="border-b border-line px-5 py-3.5">
                <h2 className="text-[15px] font-medium tracking-tight">
                  {result.ok ? 'Service response' : 'Gateway response'}
                </h2>
              </div>
              <pre className="mono max-h-[420px] overflow-auto px-5 py-4 text-[12px] leading-relaxed text-ink-2">
                {JSON.stringify(result.body, null, 2)}
              </pre>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}