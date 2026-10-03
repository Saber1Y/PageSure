import Link from 'next/link'

export const dynamic = 'force-dynamic'

const CAPABILITIES = [
  {
    title: 'Machine payments',
    body: 'A plain HTTP request gets a 402 challenge, a signed Stellar transfer, and the resource. No API key, no account, no pre-funded billing.',
  },
  {
    title: 'Payment sessions',
    body: 'Many requests accumulate as off-chain cumulative commitments and settle on-chain once, when the channel closes.',
  },
  {
    title: 'Provider policies',
    body: 'Allow, block or hold each request before money moves. Allow is a standing relationship, a grant is scoped and expires.',
  },
  {
    title: 'Stellar settlement',
    body: 'Soroban SAC transfers on Stellar, with fee sponsorship so the paying agent never needs XLM. Every settlement links to a transaction.',
  },
]

const FLOW = [
  'Agent',
  'API request',
  '402 Payment Required',
  'Policy check',
  'Stellar USDC',
  'Service response',
]

export default function LandingPage() {
  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-accent" aria-hidden />
            <span className="text-[15px] font-semibold tracking-tight">PageSure</span>
          </div>
          <nav>
            <ul className="flex items-center gap-1">
              <li>
                <Link href="/playground" className="rounded-control px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
                  Playground
                </Link>
              </li>
              <li>
                <Link
                  href="/overview"
                  className="rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
                >
                  Provider console
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      {/* Hero. Left-aligned, no centred default. Headline is two lines at most. */}
      <section className="mx-auto max-w-[1400px] px-6 pt-24 pb-16">
        <div className="grid items-start gap-12 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="label-xs">Machine payments on Stellar</p>
            <h1 className="mt-5 max-w-[16ch] text-[44px] leading-[1.05] font-medium tracking-tighter md:text-[56px]">
              Let machines pay for APIs.
            </h1>
            <p className="mt-6 max-w-[52ch] text-[17px] leading-relaxed text-ink-2">
              PageSure connects AI agents and applications to paid services through
              HTTP-native Stellar payments, with provider-controlled access policy.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/playground"
                className="rounded-control bg-accent px-5 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover active:translate-y-px"
              >
                Run a request
              </Link>
              <Link
                href="/overview"
                className="rounded-control border border-line-strong px-5 py-2.5 text-[14px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Provider console
              </Link>
            </div>
          </div>

          {/* The flow, as a real ordered sequence rather than a decorative diagram. */}
          <div className="lg:pt-10">
            <div className="rounded-card border border-line bg-surface p-5">
              <p className="label-xs">Request lifecycle</p>
              <ol className="mt-4">
                {FLOW.map((step, index) => (
                  <li key={step} className="flex items-center gap-3">
                    <span className="mono w-6 shrink-0 text-[11px] text-ink-4">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={`text-[14px] ${
                        step === '402 Payment Required'
                          ? 'text-review'
                          : step === 'Stellar USDC'
                            ? 'text-accent'
                            : 'text-ink'
                      }`}
                    >
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-5 border-t border-line pt-4 text-[12px] leading-relaxed text-ink-3">
                A refused request never reaches payment. The policy engine runs first, so
                a blocked wallet is turned away before a challenge is issued.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-16">
          <h2 className="max-w-[24ch] text-[26px] leading-tight font-medium tracking-tight">
            The payment and policy layer for services that agents consume
          </h2>
          <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-ink-3">
            PageSure is not a search engine, an API marketplace, or a wallet. It is the
            layer that lets existing HTTP services be paid for by machines and controlled
            by the provider who owns them.
          </p>

          {/* Asymmetric grid rather than three identical cards. */}
          <div className="mt-12 grid gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-2">
            {CAPABILITIES.map((item, index) => (
              <div
                key={item.title}
                className={`flex flex-col gap-3 p-7 ${
                  index === 0 ? 'bg-surface md:row-span-2' : 'bg-surface'
                } ${index === 0 ? 'md:p-10' : ''}`}
              >
                <h3 className="text-[16px] font-medium tracking-tight">{item.title}</h3>
                <p className="max-w-[46ch] text-[14px] leading-relaxed text-ink-3">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 py-16">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr]">
            <div>
              <h2 className="max-w-[20ch] text-[26px] leading-tight font-medium tracking-tight">
                One settlement, however many calls
              </h2>
              <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-ink-3">
                An agent that makes many small requests should not settle a transaction per
                request. A session funds a one-way payment channel once, then each call
                signs a cumulative commitment off-chain. Closing the channel pays the
                recipient in a single transaction.
              </p>
              <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-ink-3">
                Because the funder is fixed on chain when the channel opens, access policy
                runs authoritatively on every request. A blocked call simply does not
                advance the cumulative, so it is never billed.
              </p>
            </div>

            <div className="rounded-card border border-line bg-surface p-5">
              <p className="label-xs">Session model</p>
              <dl className="mt-4 divide-y divide-line">
                <div className="flex items-baseline justify-between py-3">
                  <dt className="text-[13px] text-ink-3">Requests</dt>
                  <dd className="mono text-[15px] text-ink">147</dd>
                </div>
                <div className="flex items-baseline justify-between py-3">
                  <dt className="text-[13px] text-ink-3">Accumulated off-chain</dt>
                  <dd className="mono text-[15px] text-review">1.47 USDC</dd>
                </div>
                <div className="flex items-baseline justify-between py-3">
                  <dt className="text-[13px] text-ink-3">On-chain transactions</dt>
                  <dd className="mono text-[15px] text-allow">1</dd>
                </div>
                <div className="flex items-baseline justify-between py-3">
                  <dt className="text-[13px] text-ink-3">Channel contracts</dt>
                  <dd className="mono text-[15px] text-ink">1</dd>
                </div>
              </dl>
              <p className="mt-4 border-t border-line pt-4 text-[12px] leading-relaxed text-ink-3">
                Every figure above is read from the gateway write tables and every
                settlement links to its Stellar transaction.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-ink-3">
            PageSure. Built on Stellar Machine Payments Protocol (MPP).
          </p>
          <div className="flex items-center gap-4">
            <Link href="/playground" className="text-[13px] text-ink-2 hover:underline">
              Playground
            </Link>
            <Link href="/overview" className="text-[13px] text-ink-2 hover:underline">
              Console
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}