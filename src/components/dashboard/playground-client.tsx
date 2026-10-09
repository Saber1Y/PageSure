'use client'

import { useState } from 'react'
import { Badge, Button, KeyValue } from '@/components/ui/primitives'

interface ChargeServiceOption {
  slug: string
  name: string
  description: string
  price: string
  assetCode: string
}

interface ChannelServiceOption extends ChargeServiceOption {
  decimals: number
}

type Mode = 'charge' | 'session'

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

interface OpenResult {
  ok: boolean
  sessionId: string
  channelContract: string
  openTx: string
  openTxUrl: string
  fundedBase: string
  refundWaitingPeriodSeconds: number
  steps: Step[]
}

interface RequestReceipt {
  index: number
  ok: boolean
  status: number
  cumulativeBase: string | null
  provider: string | null
  error: string | null
}

interface RequestResult {
  ok: boolean
  receipts: RequestReceipt[]
  steps: Step[]
}

interface SettleResult {
  ok: boolean
  txHash: string
  closeTxUrl: string
  cumulativeBase: string
  requestCount: number
  status: string
  settlementId: string | null
  steps: Step[]
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
  OPEN_REQUESTED: 'text-ink-3',
  CHANNEL_OPEN: 'text-accent',
  CHANNEL_CONFIRMED: 'text-accent',
  VOUCHER_SIGNED: 'text-accent',
  SETTLE_REQUESTED: 'text-ink-3',
  CLOSE_SUBMITTED: 'text-accent',
  SESSION_CLOSED: 'text-allow',
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || !data || data.ok === false) {
    const message =
      (data && typeof data.message === 'string' && data.message) ||
      (data && typeof data.error === 'string' && data.error) ||
      (data && typeof data.detail === 'string' && data.detail) ||
      `The API returned HTTP ${response.status}`
    const error = new Error(message) as Error & { steps?: Step[] }
    error.steps = Array.isArray(data?.steps) ? (data.steps as Step[]) : undefined
    throw error
  }
  return data as T
}

function Lifecycle({ steps, placeholder }: { steps: Step[]; placeholder: string }) {
  if (steps.length === 0) {
    return (
      <div className="px-5 py-10">
        <p className="max-w-[58ch] text-[13px] leading-relaxed text-ink-3">{placeholder}</p>
      </div>
    )
  }
  return (
    <ol className="divide-y divide-line">
      {steps.map((entry, index) => (
        <li key={`${entry.step}-${index}`} className="flex items-baseline gap-3 px-5 py-2.5">
          <span className="mono w-6 shrink-0 text-right text-[11px] text-ink-4">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className={`mono w-32 shrink-0 text-[11px] ${STEP_TONE[entry.step] ?? 'text-ink-3'}`}>
            {entry.step}
          </span>
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">{entry.detail}</span>
        </li>
      ))}
    </ol>
  )
}

function SessionPanel({ service }: { service: ChannelServiceOption }) {
  const [session, setSession] = useState<OpenResult | null>(null)
  const [settled, setSettled] = useState<SettleResult | null>(null)
  const [requestLog, setRequestLog] = useState<RequestReceipt[]>([])
  const [steps, setSteps] = useState<Step[]>([])
  const [count, setCount] = useState(4)
  const [busy, setBusy] = useState<'open' | 'request' | 'settle' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const append = (next: Step[]) => {
    if (next.length > 0) setSteps((prev) => [...prev, ...next])
  }
  const cost = (base?: string | null) =>
    base === null || base === undefined ? null : (Number(base) / 10 ** service.decimals).toFixed(Math.min(service.decimals, 6))

  function resetSession() {
    setSession(null)
    setSettled(null)
    setRequestLog([])
    setSteps([])
    setError(null)
  }

  async function open() {
    setBusy('open')
    setError(null)
    try {
      const result = await postJson<OpenResult>('/api/playground/session', { slug: service.slug })
      setSession(result)
      append(result.steps ?? [])
    } catch (caught) {
      append((caught as Error & { steps?: Step[] }).steps ?? [])
      setError((caught as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function sendRequests() {
    if (!session) return
    setBusy('request')
    setError(null)
    try {
      const result = await postJson<RequestResult>('/api/playground/session/request', {
        slug: service.slug,
        channelContract: session.channelContract,
        count,
      })
      if (result.receipts.length > 0) setRequestLog((prev) => [...prev, ...result.receipts])
      append(result.steps ?? [])
    } catch (caught) {
      append((caught as Error & { steps?: Step[] }).steps ?? [])
      setError((caught as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function settle() {
    if (!session) return
    setBusy('settle')
    setError(null)
    try {
      const result = await postJson<SettleResult>('/api/playground/session/settle', {
        slug: service.slug,
        sessionId: session.sessionId,
      })
      setSettled(result)
      append(result.steps ?? [])
    } catch (caught) {
      append((caught as Error & { steps?: Step[] }).steps ?? [])
      setError((caught as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const spent = requestLog[requestLog.length - 1]?.cumulativeBase ?? null

  return (
    <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
      {/* Controls */}
      <div className="flex flex-col gap-5">
        <p className="mono text-[12px] text-ink-3">
          {service.price} {service.assetCode} per request · one on-chain settle
        </p>

        {!session ? (
          <div className="rounded-card border border-line bg-surface px-4 py-3">
            <p className="text-[12px] leading-relaxed text-ink-3">
              Opening a session deploys an MPP transfer channel funded from the demo payer
              and creates a <span className="mono text-ink-2">ses_…</span> record. Nothing is
              spent on chain until you settle.
            </p>
          </div>
        ) : null}

        {session && !settled ? (
          <>
            <label htmlFor="count" className="text-[13px] font-medium text-ink">
              Requests to send
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Fewer requests"
                onClick={() => setCount(Math.max(1, count - 1))}
                disabled={busy !== null}
                className="h-9 w-9 rounded-control border border-line-strong text-[15px] text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                −
              </button>
              <input
                id="count"
                type="number"
                min={1}
                max={20}
                value={count}
                onChange={(event) => setCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
                className="h-9 w-16 rounded-control border border-line-strong bg-surface px-3 text-center text-[14px] text-ink outline-none focus:border-accent"
              />
              <button
                type="button"
                aria-label="More requests"
                onClick={() => setCount(Math.min(20, count + 1))}
                disabled={busy !== null}
                className="h-9 w-9 rounded-control border border-line-strong text-[15px] text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                +
              </button>
            </div>
          </>
        ) : null}

        {!session ? (
          <Button onClick={open} disabled={busy !== null}>
            {busy === 'open' ? 'Opening…' : 'Open session'}
          </Button>
        ) : settled ? (
          <Button variant="ghost" onClick={resetSession}>
            Start another session
          </Button>
        ) : (
          <div className="flex flex-col gap-2.5">
            <Button onClick={sendRequests} disabled={busy !== null}>
              {busy === 'request' ? `Sending ${count}…` : `Send ${count} ${count === 1 ? 'request' : 'requests'}`}
            </Button>
            <Button variant="ghost" onClick={settle} disabled={busy !== null}>
              {busy === 'settle' ? 'Settling…' : 'Settle & close'}
            </Button>
          </div>
        )}
      </div>

      {/* Log and session state */}
      <div className="flex flex-col gap-4">
        <p role="status" aria-live="polite" className="sr-only">
          {busy
            ? busy === 'open'
              ? 'Opening session'
              : busy === 'request'
                ? 'Sending requests'
                : 'Settling session'
            : settled
              ? `Session closed with ${steps.length} lifecycle steps and settlement ${settled.settlementId ?? 'recorded'}`
              : session
                ? `Session ${session.sessionId} active with ${requestLog.length} requests sent`
                : ''}
        </p>

        {error ? (
          <div role="alert" className="rounded-card border border-line bg-surface px-5 py-4">
            <p className="text-[13px] font-medium text-block">Session step failed</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{error}</p>
          </div>
        ) : null}

        {session ? (
          <div className="rounded-card border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <h2 className="text-[15px] leading-snug font-semibold tracking-tight">Session</h2>
              <Badge tone={settled ? 'allow' : 'pending'}>{settled ? 'closed' : 'active'}</Badge>
            </div>
            <div className="px-5 py-1">
              <KeyValue k="Session" v={<span className="mono">{session.sessionId}</span>} mono />
              <KeyValue k="Channel" v={<span className="mono">{session.channelContract}</span>} mono />
              <KeyValue k="Funded" v={`${cost(session.fundedBase)} ${service.assetCode}`} />
              {!settled ? (
                <KeyValue k="Spent so far" v={spent !== null ? `${cost(spent)} ${service.assetCode}` : '0'} />
              ) : null}
              <KeyValue
                k="Open channel"
                v={
                  <a
                    href={session.openTxUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    {session.openTx.slice(0, 16)}…
                  </a>
                }
              />
              {settled ? (
                <>
                  <KeyValue
                    k="Settlement"
                    v={settled.settlementId ? <span className="mono">{settled.settlementId}</span> : 'recorded'}
                  />
                  <KeyValue k="Paid provider" v={`${cost(settled.cumulativeBase)} ${service.assetCode} · ${settled.requestCount} requests`} />
                  <KeyValue
                    k="Close transaction"
                    v={
                      <a
                        href={settled.closeTxUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        {settled.txHash.slice(0, 16)}…
                      </a>
                    }
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {requestLog.length > 0 ? (
          <div className="rounded-card border border-line bg-surface">
            <div className="border-b border-line px-5 py-3.5">
              <h2 className="text-[15px] leading-snug font-semibold tracking-tight">Request receipts</h2>
            </div>
            <ol className="divide-y divide-line">
              {requestLog.map((receipt) => (
                <li key={`${receipt.index}-${receipt.status}`} className="flex items-center gap-3 px-5 py-2.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${receipt.ok ? 'bg-allow' : 'bg-block'}`}
                    aria-hidden
                  />
                  <span className="mono w-10 shrink-0 text-[11px] text-ink-4">#{receipt.index}</span>
                  <span className="mono w-10 shrink-0 text-[11px] text-ink-3">HTTP {receipt.status}</span>
                  {receipt.provider ? (
                    <span className="w-28 shrink-0 truncate text-[12px] text-ink-3">{receipt.provider}</span>
                  ) : null}
                  <span className="mono min-w-0 flex-1 text-right text-[12px] text-ink-2">
                    {receipt.ok && receipt.cumulativeBase !== null
                      ? `cumulative ${cost(receipt.cumulativeBase)} ${service.assetCode}`
                      : (receipt.error ?? 'blocked')}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="rounded-card border border-line bg-surface">
          <div className="border-b border-line px-5 py-3.5">
            <h2 className="text-[15px] leading-snug font-semibold tracking-tight">Session lifecycle</h2>
          </div>
          <Lifecycle
            steps={steps}
            placeholder="Open a session to see the real channel lifecycle: deploy, fund, signed commitments on every request, and one on-chain settle."
          />
        </div>
      </div>
    </div>
  )
}

export function PlaygroundClient({
  services,
  channelServices,
}: {
  services: ChargeServiceOption[]
  channelServices: ChannelServiceOption[]
}) {
  const all: (ChargeServiceOption & { mode: Mode; decimals?: number })[] = [
    ...services.map((service) => ({ ...service, mode: 'charge' as const })),
    ...channelServices.map((service) => ({ ...service, mode: 'session' as const })),
  ]

  const [slug, setSlug] = useState(all[0]?.slug ?? '')
  const [query, setQuery] = useState('stellar agentic payments')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [transportError, setTransportError] = useState<string | null>(null)

  const selected = all.find((service) => service.slug === slug)

  async function run() {
    setBusy(true)
    setResult(null)
    setTransportError(null)
    try {
      const response = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          search: slug === 'summarize' ? { text: query } : { q: query },
        }),
      })
      // A gateway fault can answer with HTML or an empty body, so parsing is guarded:
      // an unparseable response must not be reported as a successful run.
      const body = (await response.json().catch(() => null)) as RunResult | null
      if (!body) {
        setTransportError(`The gateway returned a response that was not valid JSON (HTTP ${response.status}).`)
        return
      }
      setResult(body)
    } catch {
      setTransportError('Could not reach the playground API. Check your connection and try again.')
    } finally {
      // Always release the button, or a dropped connection leaves it stuck on "Running".
      setBusy(false)
    }
  }

  // Server-reported failure (blocked, unfunded, trustline) and client-side transport
  // failure are shown together but never conflated.
  const failure = transportError ?? result?.error ?? null

  if (all.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface px-5 py-10">
        <p className="text-[14px] font-medium text-ink">No live services</p>
        <p className="mt-1 text-[13px] text-ink-3">Register a service and mark it live to use the playground.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 sm:max-w-[320px]">
        <label htmlFor="service" className="text-[13px] font-medium text-ink">
          Service
        </label>
        <select
          id="service"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          className="rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors focus:border-accent"
        >
          {all.map((service) => (
            <option key={service.slug} value={service.slug}>
              {service.name}
              {service.mode === 'session' ? ' · session' : ''}
            </option>
          ))}
        </select>
        {selected ? <p className="text-[12px] text-ink-3">{selected.description}</p> : null}
      </div>

      {selected?.mode === 'session' && selected.decimals !== undefined ? (
        <SessionPanel
          service={{
            slug: selected.slug,
            name: selected.name,
            description: selected.description,
            price: selected.price,
            assetCode: selected.assetCode,
            decimals: selected.decimals,
          }}
        />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
          {/* Controls */}
          <div className="flex flex-col gap-5">
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
              className="inline-flex items-center justify-center rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
            >
              {busy ? 'Running…' : 'Run paid request'}
            </button>
          </div>

          {/* Waterfall and result */}
          <div className="flex flex-col gap-4">
            {/* Concise status for assistive tech. The lifecycle list and JSON body stay out
                of the live region so a result is announced, not read out line by line. */}
            <p role="status" aria-live="polite" className="sr-only">
              {busy
                ? 'Running paid request'
                : transportError
                  ? 'Request failed before reaching the gateway'
                  : result
                    ? `Request finished with ${result.steps.length} lifecycle steps${result.ok ? '' : ', the gateway reported an error'}`
                    : ''}
            </p>

            {failure ? (
              <div role="alert" className="rounded-card border border-line bg-surface px-5 py-4">
                <p className="text-[13px] font-medium text-block">
                  {transportError ? 'Request did not reach the gateway' : 'Request failed'}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{failure}</p>
              </div>
            ) : null}

            <div className="rounded-card border border-line bg-surface">
              <div className="border-b border-line px-5 py-3.5">
                <h2 className="text-[15px] leading-snug font-semibold tracking-tight">Request lifecycle</h2>
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
                    <p className="max-w-[58ch] text-[13px] leading-relaxed text-ink-3">
                      Run a request to see the real payment lifecycle, driven by the SDK&apos;s progress events.
                    </p>
                  )}
                </div>
              ) : result.steps.length === 0 ? (
                <div className="px-5 py-10">
                  <p className="text-[13px] text-ink-3">
                    The request was rejected before any payment step ran. The gateway response below carries the reason.
                  </p>
                </div>
              ) : (
                <Lifecycle steps={result.steps} placeholder="" />
              )}
            </div>

            {result ? (
              <>
                {result.headers['x-pagesure-request-id'] ? (
                  <a
                    href={`/requests/${result.headers['x-pagesure-request-id']}`}
                    className="inline-flex items-center rounded-control px-2 py-1 text-[13px] text-accent hover:underline"
                  >
                    Inspect the recorded policy decision
                  </a>
                ) : null}

                <div className="rounded-card border border-line bg-surface">
                  <div className="border-b border-line px-5 py-3.5">
                    <h2 className="text-[15px] leading-snug font-semibold tracking-tight">
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
      )}
    </div>
  )
}