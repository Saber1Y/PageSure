import { serviceRollups } from '@/lib/metering/aggregates'
import { PlaygroundClient } from '@/components/dashboard/playground-client'
import { formatAmount } from '@/lib/money'
import { USDC_SAC_TESTNET } from '@stellar/mpp'

export const dynamic = 'force-dynamic'

export default function PlaygroundPage() {
  const services = serviceRollups().filter((s) => s.status === 'live')
  const chargeServices = services.filter((s) => s.mode === 'charge')

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-accent" aria-hidden />
            <span className="text-[15px] font-semibold tracking-tight">PageSure</span>
            <span className="text-[13px] text-ink-3">Playground</span>
          </div>
          <a href="/overview" className="text-[13px] text-ink-2 transition-colors hover:text-ink hover:underline">
            Provider console
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <div className="max-w-[62ch]">
          <h1 className="text-[22px] font-medium tracking-tight">Agent playground</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            Run a real paid request. The client signs a Soroban transfer against a funded
            testnet account and the waterfall below is built from the SDK&apos;s own progress
            events, not an animation.
          </p>
          <p className="mono mt-2 text-[11px] text-ink-4">asset {USDC_SAC_TESTNET}</p>
        </div>

        <div className="mt-8">
          <PlaygroundClient
            services={chargeServices.map((s) => ({
              slug: s.slug,
              name: s.name,
              description: s.description,
              price: formatAmount(s.priceBase, s.decimals),
              assetCode: s.assetCode,
            }))}
          />
        </div>
      </main>
    </div>
  )
}