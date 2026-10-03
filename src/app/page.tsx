import Image from 'next/image'
import Link from 'next/link'
import { db } from '@/lib/db/client'
import { requests, services } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { TracePreview } from '@/components/marketing/trace-preview'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * Landing page.
 *
 * Design read: developer/fintech infrastructure for engineers and provider operators.
 * Not a crypto trading terminal, not an AI marketing page.
 *
 * Dials: VARIANCE 7 (asymmetric, no centred default), MOTION 6 (motion is real and
 * meaningful: the trace reveals in sequence, lines draw on scroll), DENSITY 3 (this is
 * a marketing page, so it breathes).
 *
 * Five sections, five distinct layout families, so nothing repeats:
 *   1. split hero, left copy / right live component preview
 *   2. full-width editorial contrast, no cards
 *   3. asymmetric bento with real imagery in two cells
 *   4. full-bleed image band for the session payoff
 *   5. single closing CTA
 *
 * Eyebrow count: 2 across 5 sections. The habit of labelling every section is exactly
 * what makes an AI page look templated, so most sections have none.
 */

function liveTrace() {
  // Most recent request that actually reached the upstream, so the hero shows a real
  // lifecycle rather than a fabricated one.
  const row = db()
    .select()
    .from(requests)
    .where(eq(requests.status, 'paid'))
    .orderBy(desc(requests.createdAt))
    .get()
  if (!row) return []

  const service = db()
    .select({ name: services.name, slug: services.slug, decimals: services.decimals })
    .from(services)
    .where(eq(services.id, row.serviceId))
    .get()

  const trace = row.policyTrace as { checks?: Array<{ status: string }> } | null
  const passed = trace?.checks?.filter((c) => c.status === 'pass').length ?? 0

  return [
    { step: 'REQUEST', detail: `GET /v1/${service?.slug ?? 'service'}  ·  X-Pagesure-Payer: ${(row.claimedPayer ?? '').slice(0, 8)}…` },
    { step: 'POLICY_CHECK', detail: `${row.policyDecision}  ·  ${passed} checks passed` },
    { step: 'CHALLENGE', detail: '402  ·  WWW-Authenticate: Payment' },
    { step: 'SIGNING', detail: 'Soroban SAC transfer authorization' },
    { step: 'PAYING', detail: 'fee sponsored by the provider' },
    { step: 'CONFIRMING', detail: `request ${row.id.slice(4, 12)}` },
    { step: 'PAID', detail: `${formatAmount(row.amountBase, service?.decimals ?? 7)} USDC settled` },
    { step: 'SERVICE_EXECUTED', detail: `upstream: ${row.upstreamProvider ?? 'configured provider'}` },
  ]
}

export default function LandingPage() {
  const trace = liveTrace()

  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-accent" aria-hidden />
            <span className="text-[15px] font-semibold tracking-tight">PageSure</span>
          </div>
          <nav>
            <ul className="flex items-center gap-1">
              <li>
                <Link
                  href="/playground"
                  className="rounded-control px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  Playground
                </Link>
              </li>
              <li>
                <Link
                  href="/overview"
                  className="rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent-hover active:scale-[0.97]"
                >
                  Console
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      {/* 1. HERO - split. Left copy, right a real component preview. */}
      <section className="mx-auto max-w-[1400px] px-6 pt-20 pb-20 lg:pt-24 lg:pb-28">
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20">
          <div>
            <p className="label-xs">Machine payments on Stellar</p>
            <h1 className="mt-6 max-w-[15ch] text-[46px] leading-[1.03] font-medium tracking-tighter md:text-[60px]">
              Let machines pay for APIs.
            </h1>
            <p className="mt-7 max-w-[46ch] text-[17px] leading-relaxed text-ink-2">
              An agent requests a service. PageSure answers with a payment challenge,
              settles a Stellar transfer, and hands over the response.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/playground"
                className="inline-flex items-center rounded-control bg-accent px-5 py-2.5 text-[14px] font-medium whitespace-nowrap text-white transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent-hover active:scale-[0.97]"
              >
                Run a paid request
              </Link>
              <Link
                href="/overview"
                className="inline-flex items-center rounded-control border border-line-strong px-5 py-2.5 text-[14px] font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
              >
                Provider console
              </Link>
            </div>

            <p className="mono mt-7 text-[11px] text-ink-4">
              Built on Stellar Machine Payments Protocol
            </p>
          </div>

          <div className="lg:pl-4">
            <TracePreview live={trace} />
            <p className="mt-3 text-[12px] text-ink-3">
              {trace.length > 0
                ? 'This is a real request read from the gateway write tables.'
                : 'No requests recorded yet. The canonical sequence is shown; run one in the Playground to replace it with a live trace.'}
            </p>
          </div>
        </div>
      </section>

      {/* 2. EDITORIAL CONTRAST - full width, no cards, no eyebrow. */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="grid gap-16 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:gap-24">
            <h2 className="max-w-[18ch] text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
              Software can act on its own. Paying for what it needs still is not native.
            </h2>

            <div className="flex flex-col gap-8">
              <div>
                <p className="text-[13px] text-ink-3">A paid API today expects</p>
                <p className="mono mt-3 text-[15px] leading-relaxed text-ink-2">
                  API key · account · subscription · pre-funded billing · manual payment
                </p>
              </div>
              <div className="border-t border-line pt-8">
                <p className="text-[13px] text-ink-3">With PageSure it expects</p>
                <p className="mono mt-3 text-[15px] leading-relaxed text-accent">
                  GET /v1/search · X-Pagesure-Payer: G… · Authorization: Payment …
                </p>
                <p className="mt-4 max-w-[52ch] text-[14px] leading-relaxed text-ink-3">
                  The agent signs a transfer and retries. PageSure verifies it, settles it,
                  calls the upstream, and returns the resource. Nobody creates an account.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. BENTO - asymmetric, real imagery in two cells, no three-in-a-row. */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <h2 className="max-w-[22ch] text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
            The payment and policy layer for services agents consume
          </h2>
          <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-ink-3">
            Not a search engine, an API marketplace, or a wallet. Search is simply the
            first real upstream we used to prove the system.
          </p>

          {/*
            Bento: exactly four cells, no filler. Grid is 3 columns x 2 rows at lg.
            The convergence image takes the full left two columns of row 1 (the visual
            anchor), the policy image takes the right column of row 2, and the two text
            cells fill the remainder. Every cell is accounted for, so nothing strands.
          */}
          <div className="mt-14 grid gap-4 lg:grid-cols-3">
            {/* Convergence image: the product thesis, so it gets the most space. */}
            <div className="overflow-hidden rounded-card border border-line bg-plate lg:col-span-2">
              <div className="relative aspect-[16/10] w-full">
                <Image
                  src="/media/channel-convergence.webp"
                  alt="Many thin request paths converging through a single node into one line: many machine payments, one settlement"
                  fill
                  sizes="(max-width: 1024px) 100vw, 66vw"
                  priority
                  className="object-cover"
                />
              </div>
            </div>

            {/* Payment sessions */}
            <div className="flex flex-col rounded-card border border-line bg-surface p-7">
              <h3 className="text-[16px] font-medium tracking-tight">Payment sessions</h3>
              <p className="mt-3 max-w-[34ch] text-[14px] leading-relaxed text-ink-3">
                Fund a channel once, then each call signs a cumulative commitment
                off-chain. One transaction settles the lot.
              </p>
              <dl className="mt-7 flex items-baseline gap-7 border-t border-line pt-5">
                <div>
                  <dt className="label-xs">Requests</dt>
                  <dd className="mono mt-1.5 text-[24px] leading-none text-ink">147</dd>
                </div>
                <div>
                  <dt className="label-xs">On-chain</dt>
                  <dd className="mono mt-1.5 text-[24px] leading-none text-allow">1</dd>
                </div>
              </dl>
            </div>

            {/* Machine payments. The full challenge header is shown rather than an
                abbreviated one: it is the most informative thing we can put here, and
                it fills the cell without padding. */}
            <div className="flex flex-col rounded-card border border-line bg-surface p-7">
              <h3 className="text-[16px] font-medium tracking-tight">Machine payments</h3>
              <p className="mt-3 max-w-[36ch] text-[14px] leading-relaxed text-ink-3">
                HTTP 402 becomes a machine-readable challenge. Fee sponsorship means the
                paying agent needs USDC, never XLM.
              </p>
              <pre className="mono mt-6 overflow-x-auto rounded-control border border-line bg-plate p-4 text-[11px] leading-[1.7] text-ink-2">
{`HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="…"
  method="stellar"
  intent="charge"
  request="eyJhbW91bnQiOiIxMDAw
  MDAiLCJjdXJyZW5jeSI6IkNC…

X-Pagesure-Decision: allow
X-Pagesure-Price-Base: 100000`}
              </pre>
            </div>

            {/* Provider policies. The illustration carries a single horizontal row
                with empty margins above and below, so cropping the height keeps the
                row exactly where it belongs. */}
            <div className="flex flex-col overflow-hidden rounded-card border border-line bg-surface lg:col-span-2">
              <div className="relative aspect-[3/1] w-full bg-plate">
                <Image
                  src="/media/policy-lattice-wide.webp"
                  alt="A row of wallet identifiers: most empty, a cluster of six allowed in blue, and one blocked in red, above a policy boundary line"
                  fill
                  sizes="(max-width: 1024px) 100vw, 66vw"
                  className="object-cover"
                />
              </div>
              {/* The refusal outcomes are deliberately not repeated here. They get
                  their own section below, because saying the same thing twice in two
                  different visual treatments is the templated rhythm this page is
                  meant to avoid. */}
              <div className="p-7">
                <h3 className="text-[16px] font-medium tracking-tight">Provider policies</h3>
                <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-3">
                  Allow, block, or hold every request before money moves. Allow is a
                  standing relationship; a grant is scoped to one service and expires, so
                  approving a single wallet never rewrites the allowlist.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. FULL-BLEED BAND - the session payoff, stated once and hard. */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
            <div>
              <h2 className="max-w-[16ch] text-[30px] leading-[1.15] font-medium tracking-tight md:text-[38px]">
                A blocked request costs the payer nothing.
              </h2>
              <p className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-ink-3">
                In a session the funder is fixed on chain when the channel opens, so access
                policy runs authoritatively on every single request. When policy refuses, the
                cumulative simply does not advance. There is nothing to refund because
                nothing was ever committed.
              </p>
              <Link
                href="/playground"
                className="mt-8 inline-flex items-center text-[14px] font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
              >
                See the refusal path
              </Link>
            </div>

            <dl className="divide-y divide-line self-start">
              <div className="flex items-baseline justify-between gap-6 py-5">
                <dt className="text-[14px] text-ink-3">Preflight refusal</dt>
                <dd className="mono text-[14px] text-allow">payment not started</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 py-5">
                <dt className="text-[14px] text-ink-3">Held for review</dt>
                <dd className="mono text-[14px] text-review">payment not started</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 py-5">
                <dt className="text-[14px] text-ink-3">Session mid-flight refusal</dt>
                <dd className="mono text-[14px] text-allow">cumulative not advanced</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 py-5">
                <dt className="text-[14px] text-ink-3">Every settlement</dt>
                <dd className="mono text-[14px] text-accent">links to its transaction</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* 5. CLOSING CTA - one intent, one label. */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="max-w-[40ch]">
            <h2 className="text-[30px] leading-[1.15] font-medium tracking-tight md:text-[36px]">
              Give your service a price and a policy.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-3">
              Register an endpoint, choose an asset, and PageSure handles negotiation,
              verification, and settlement from there.
            </p>
            <Link
              href="/overview"
              className="mt-8 inline-flex items-center rounded-control bg-accent px-5 py-2.5 text-[14px] font-medium whitespace-nowrap text-white transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent-hover active:scale-[0.97]"
            >
              Open the console
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-ink-3">
            PageSure. Machine payments on Stellar.
          </p>
          <div className="flex items-center gap-5">
            <Link href="/playground" className="text-[13px] text-ink-2 transition-colors hover:text-ink">
              Playground
            </Link>
            <Link href="/overview" className="text-[13px] text-ink-2 transition-colors hover:text-ink">
              Console
            </Link>
            <Link href="/login" className="text-[13px] text-ink-2 transition-colors hover:text-ink">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}