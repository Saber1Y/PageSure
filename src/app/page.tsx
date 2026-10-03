import Image from 'next/image'
import Link from 'next/link'
import { count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { requests, services, settlements } from '@/lib/db/schema'
import { formatAmount } from '@/lib/money'
import { Brand } from '@/components/ui/brand'
import { TracePreview } from '@/components/marketing/trace-preview'

export const dynamic = 'force-dynamic'

/**
 * Landing page.
 *
 * Design read: developer infrastructure for engineers and provider operators. Evidence
 * first, not a crypto trading terminal and not an AI marketing page.
 *
 * Dials: VARIANCE 7 (asymmetric, nothing centred by default), MOTION 5 (the trace
 * reveals in sequence, sections reveal as they enter), DENSITY 3 (marketing page, so it
 * breathes).
 *
 * Five sections, five different layout families, because a page where every band is a
 * two column split reads as a template no matter how well the type is set:
 *   1. asymmetric split hero, copy against a real component preview
 *   2. single measure editorial with one full width protocol artifact
 *   3. asymmetric bento, real imagery in two cells and a tinted panel in a third
 *   4. four column ledger row, no cards
 *   5. centred closing statement on a tinted full bleed band
 *
 * Eyebrows: one, in the hero. Labelling every section is what makes a page look
 * generated, and the section's position already categorises it.
 *
 * One label per intent: "Run a paid request" is the only try-it CTA on the page, and
 * "Console" appears once in the nav. Two names for the same action is worse than one.
 */

const DECIMALS = 7

interface TraceStep {
  step: string
  detail: string
}

/**
 * The most recent request that actually reached the upstream, so the hero shows a real
 * lifecycle rather than an invented one. Returns nothing when the tables are empty,
 * which is a state the preview handles explicitly.
 */
function liveTrace(): TraceStep[] {
  const row = db()
    .select()
    .from(requests)
    .where(eq(requests.status, 'paid'))
    .orderBy(desc(requests.createdAt))
    .get()
  if (!row) return []

  const service = db()
    .select({ slug: services.slug, decimals: services.decimals })
    .from(services)
    .where(eq(services.id, row.serviceId))
    .get()

  const trace = row.policyTrace as { checks?: Array<{ status: string }> } | null
  const passed = trace?.checks?.filter((c) => c.status === 'pass').length ?? 0

  return [
    { step: 'REQUEST', detail: `GET /v1/${service?.slug ?? 'service'}` },
    { step: 'POLICY_CHECK', detail: `${row.policyDecision}, ${passed} checks passed` },
    { step: 'CHALLENGE', detail: '402, WWW-Authenticate: Payment' },
    { step: 'SIGNING', detail: 'Soroban SAC transfer authorization' },
    { step: 'PAYING', detail: 'fee sponsored by the provider' },
    { step: 'CONFIRMING', detail: `request ${row.id.slice(4, 12)}` },
    { step: 'PAID', detail: `${formatAmount(row.amountBase, service?.decimals ?? DECIMALS)} USDC` },
    { step: 'DELIVERED', detail: row.upstreamProvider ?? 'upstream provider' },
  ]
}

/**
 * Real numbers for the session cell, or null when there is nothing to report.
 *
 * The previous version of this page printed a hardcoded "147 requests, 1 settlement".
 * It looked like telemetry and it was fiction. When there is real traffic these figures
 * are queried; when there is not, the cell describes the mechanism in words instead of
 * inventing a figure to fill the space.
 */
function sessionProof(): { requests: number; settlements: number } | null {
  const target = db()

  const channelServiceIds = target
    .select({ id: services.id })
    .from(services)
    .where(eq(services.mode, 'channel'))
    .all()
    .map((row) => row.id)

  // A deployment with no channel mode services cannot demonstrate the sessions story,
  // so there is nothing to count.
  if (channelServiceIds.length === 0) return null

  const callTotal = target
    .select({ n: count() })
    .from(requests)
    .where(inArray(requests.serviceId, channelServiceIds))
    .get()

  const settlementTotal = target
    .select({ n: count() })
    .from(settlements)
    .where(eq(settlements.status, 'confirmed'))
    .get()

  const calls = callTotal?.n ?? 0
  const settled = settlementTotal?.n ?? 0

  // Zero traffic is an empty state, not a row of zeroes to print as if it were a result.
  if (calls === 0 && settled === 0) return null

  return { requests: calls, settlements: settled }
}

const OUTCOMES = [
  {
    when: 'Preflight refusal',
    result: 'no payment starts',
    tone: 'text-allow',
    note: 'The policy check runs before a challenge is ever written.',
  },
  {
    when: 'Held for review',
    result: 'no payment starts',
    tone: 'text-review',
    note: 'An operator approves or denies the wallet, then the request retries.',
  },
  {
    when: 'Refused mid session',
    result: 'cumulative holds',
    tone: 'text-allow',
    note: 'The signature is refused on chain, so the channel total does not move.',
  },
  {
    when: 'Settled',
    result: 'links to its transaction',
    tone: 'text-accent',
    note: 'Every confirmed settlement keeps its hash and links back to the requests.',
  },
]

export default function LandingPage() {
  const trace = liveTrace()
  const proof = sessionProof()

  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
          <Brand href="/" />
          <nav aria-label="Primary">
            <ul className="flex items-center gap-1">
              <li>
                <Link
                  href="/playground"
                  className="inline-flex rounded-control px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  Playground
                </Link>
              </li>
              <li>
                <Link
                  href="/overview"
                  className="inline-flex rounded-control bg-accent px-3.5 py-2 text-[13px] font-medium text-on-accent transition-colors duration-150 hover:bg-accent-hover active:scale-[0.97]"
                >
                  Console
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      {/*
        1. HERO, asymmetric split. Copy left, a real component preview right.

        Four text elements and no more: eyebrow, headline, subtext, one CTA. The
        "built on Stellar MPP" line that used to sit under the buttons was a fifth, and
        it said nothing the eyebrow had not already said.
      */}
      <section className="mx-auto max-w-[1400px] px-6 pt-16 pb-20 lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:pt-20 lg:pb-28">
        <div>
          <p className="label-xs">Machine payments on Stellar</p>
          <h1 className="mt-6 max-w-[14ch] text-[44px] leading-[1.04] font-medium tracking-tighter md:text-[58px]">
            Let machines pay for APIs.
          </h1>
          <p className="mt-6 max-w-[44ch] text-[17px] leading-relaxed text-ink-2">
            An agent calls your API. PageSure answers with a payment challenge, settles
            on Stellar, then returns the response.
          </p>
          <div className="mt-8">
            <Link
              href="/playground"
              className="inline-flex items-center rounded-control bg-accent px-5 py-2.5 text-[14px] font-medium whitespace-nowrap text-on-accent transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent-hover active:scale-[0.97]"
            >
              Run a paid request
            </Link>
          </div>
        </div>

        <div className="mt-12 lg:mt-0">
          <TracePreview live={trace} />
        </div>
      </section>

      {/*
        2. Single measure editorial plus one full width artifact.

        Not another two column split. The statement sits in one readable measure and the
        comparison runs the full width beneath it, so the section reads as one argument
        rather than two columns of equal weight.
      */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="reveal max-w-[62ch]">
            <h2 className="text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
              Software already acts on its own. Paying for what it needs is still a manual
              step.
            </h2>
            <p className="mt-6 text-[15px] leading-relaxed text-ink-3">
              An agent that can call an API still cannot pay for one without an account, a
              key, and a human approving the charge. PageSure removes all three.
            </p>
          </div>

          <div className="reveal mt-12 overflow-hidden rounded-card border border-line bg-surface">
            <div className="grid gap-2 px-6 py-6 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] md:gap-8">
              <p className="text-[13px] text-ink-3">A paid API today asks for</p>
              <p className="max-w-[60ch] text-[15px] leading-relaxed text-ink-2">
                An API key, a customer account, a subscription, a pre-funded balance, and
                a person to press pay.
              </p>
            </div>
            <div className="grid gap-4 border-t border-line px-6 py-6 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] md:gap-8">
              <p className="text-[13px] text-ink-3">With PageSure it asks for</p>
              <div className="min-w-0">
                <pre className="mono min-w-0 overflow-x-auto text-[12px] leading-[1.9] whitespace-nowrap text-ink">{`GET /v1/search HTTP/1.1
X-Pagesure-Payer: GASU4QKY…
Authorization: Payment id="01J…", intent="charge"`}</pre>
                <p className="mt-5 max-w-[58ch] text-[14px] leading-relaxed text-ink-3">
                  The agent signs a transfer and retries the same request. No signup, no
                  invoice, no account to create.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/*
        3. Bento. Four pieces of content, four cells, so nothing strands.

        Three of the four carry real visual variation: two illustrations and a tinted
        panel. A bento of four white cards with type in them is the generic default this
        layout is supposed to replace.

        Row one is taller than row two, and the wide cells alternate sides, so the grid
        has a rhythm instead of a repeating left image right text stripe.
      */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="reveal max-w-[58ch]">
            <h2 className="text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
              What PageSure adds to an endpoint
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-3">
              Not a search engine, an API marketplace, or a wallet. Search is the first
              upstream we wired up to prove it works.
            </p>
          </div>

          <div className="mt-14 grid gap-4 lg:grid-cols-3 lg:grid-rows-[1.1fr_1fr]">
            <figure className="overflow-hidden rounded-card border border-line bg-plate lg:col-span-2">
              <div className="relative aspect-[16/10] w-full">
                <Image
                  src="/media/channel-convergence.webp"
                  alt="Many thin request paths converging through one node into a single line, many machine payments resolving to one settlement"
                  fill
                  sizes="(max-width: 1024px) 100vw, 66vw"
                  priority
                  className="object-cover"
                />
              </div>
            </figure>

            <div className="flex flex-col rounded-card border border-line bg-surface p-7">
              <h3 className="text-[16px] font-medium tracking-tight">Payment sessions</h3>
              <p className="mt-3 max-w-[34ch] text-[14px] leading-relaxed text-ink-3">
                Fund a channel once. Each call then signs a cumulative commitment
                off-chain, and one settlement closes the whole lot.
              </p>
              {proof ? (
                <dl className="mt-auto flex items-baseline gap-8 pt-7">
                  <div>
                    <dt className="text-[12px] text-ink-4">Session requests</dt>
                    <dd className="mono mt-1.5 text-[24px] leading-none text-ink">
                      {proof.requests.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-ink-4">Settlements</dt>
                    <dd className="mono mt-1.5 text-[24px] leading-none text-allow">
                      {proof.settlements.toLocaleString()}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mono mt-auto pt-7 text-[11px] text-ink-4">
                  no session traffic recorded
                </p>
              )}
            </div>

            <div className="flex flex-col rounded-card border border-line bg-plate p-7">
              <h3 className="text-[16px] font-medium tracking-tight">Machine payments</h3>
              <p className="mt-3 max-w-[38ch] text-[14px] leading-relaxed text-ink-3">
                HTTP 402 carries the amount, the asset, and the recipient. Fee sponsorship
                means the paying agent needs USDC and never XLM.
              </p>
              <pre className="mono mt-6 min-w-0 overflow-x-auto rounded-control border border-line-strong bg-surface p-4 text-[11px] leading-[1.75] text-ink-2">
                {`HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="01J…"
  method="stellar"
  intent="charge"
  amount="1000000"
  asset="USDC:G…"

X-Pagesure-Decision: allow`}
              </pre>
            </div>

            <figure className="flex flex-col overflow-hidden rounded-card border border-line bg-surface lg:col-span-2">
              <div className="relative aspect-[3/1] w-full bg-plate">
                <Image
                  src="/media/policy-lattice-wide.webp"
                  alt="A row of wallet identifiers, most empty, with a cluster of six allowed in blue and one blocked in red above a policy boundary line"
                  fill
                  sizes="(max-width: 1024px) 100vw, 66vw"
                  className="object-cover"
                />
              </div>
              <figcaption className="p-7">
                <h3 className="text-[16px] font-medium tracking-tight">Provider policies</h3>
                <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-3">
                  Allow, block, or hold each request before money moves. A grant is scoped
                  to one service and expires on its own.
                </p>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/*
        4. Ledger row. Four outcomes across, divided by hairlines, with no cards.

        A vertical list with a divider under every row is the laziest way to show four
        facts. Laying them across as columns makes the comparison legible at a glance,
        and it is a layout family used nowhere else on the page.
      */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="reveal max-w-[58ch]">
            <h2 className="text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
              A refused request costs the payer nothing.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-3">
              The funder is fixed on chain when a channel opens, so policy runs
              authoritatively on every call. A refusal holds the cumulative where it
              stands.
            </p>
          </div>

          <dl className="reveal mt-14 grid divide-y divide-line border-y border-line sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
            {OUTCOMES.map((outcome) => (
              <div
                key={outcome.when}
                className="border-b border-line py-7 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:border-b-0 lg:border-b-0 lg:border-r lg:px-7 lg:first:pl-0 lg:last:border-r-0 lg:last:pr-0"
              >
                <dt className="text-[14px] text-ink">{outcome.when}</dt>
                <dd className="mono mt-2 text-[13px] text-ink-2">
                  <span className={outcome.tone}>{outcome.result}</span>
                </dd>
                <dd className="mt-3 max-w-[28ch] text-[13px] leading-relaxed text-ink-4">
                  {outcome.note}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/*
        5. Closing statement, centred, on a tinted band.

        The only centred block on the page, which is what makes it read as an ending. It
        carries one CTA and repeats the hero's exact label, so the try-it action has a
        single name across the whole page.
      */}
      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="reveal mx-auto max-w-[46ch] text-center">
            <h2 className="text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
              Give your service a price and a policy.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-3">
              Register an endpoint, choose an asset, and PageSure takes over negotiation,
              verification, and settlement.
            </p>
            <div className="mt-9">
              <Link
                href="/playground"
                className="inline-flex items-center rounded-control bg-accent px-6 py-3 text-[15px] font-medium whitespace-nowrap text-on-accent transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent-hover active:scale-[0.97]"
              >
                Run a paid request
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-6 py-9 sm:flex-row sm:items-center sm:justify-between">
          <Brand />
          <nav aria-label="Footer">
            <ul className="flex items-center gap-5">
              <li>
                <Link
                  href="/playground"
                  className="inline-block py-2 text-[13px] text-ink-2 transition-colors hover:text-ink"
                >
                  Playground
                </Link>
              </li>
              <li>
                <Link
                  href="/overview"
                  className="inline-block py-2 text-[13px] text-ink-2 transition-colors hover:text-ink"
                >
                  Console
                </Link>
              </li>
              <li>
                <Link
                  href="/login"
                  className="inline-block py-2 text-[13px] text-ink-2 transition-colors hover:text-ink"
                >
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  )
}